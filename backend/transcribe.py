"""Lesson recordings → text on this server, with faster-whisper. No paid API.

Requests never transcribe. An upload queues a row in lesson_recordings; one worker thread in the app takes the oldest
queued recording and runs this file as its own process (`python transcribe.py <id>`) at the lowest priority (nice 19,
idle IO, one thread), so a long lesson can't time out a request, the live sites sharing the one-CPU server stay
responsive, and the model's memory is handed back after each job. The child writes its progress and the transcript so far into the row as it goes. When it finishes the audio is
deleted unless its owner ticked "keep audio"; a failed job keeps the audio so it can be tried again.

Model: see settings.whisper_model (CLAUDE.md has the timings that chose it).
"""
import logging
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import db
import syllabus
from config import settings

log = logging.getLogger(__name__)
_wake = threading.Event()
_thread: threading.Thread | None = None

# Whisper hears dance words better when told to expect them (faster-whisper "hotwords", given to every 30 s window).
GENERAL_WORDS = ("Ballroom and Latin dance lesson. Waltz, Foxtrot, Quickstep, Tango, Viennese Waltz, Cha Cha, Samba, "
                 "Rumba, Paso Doble, Jive. Natural Turn, Reverse Turn, Chassé, Promenade, CBM, sway, rise and fall, "
                 "heel lead, toe, hold, frame.")


def audio_dir() -> Path:
    return settings.upload_dir / "recordings"


def vocabulary(dance_id: str) -> str:
    d = syllabus.dance(dance_id) if dance_id else None
    if not d:
        return GENERAL_WORDS
    names = list(dict.fromkeys([n for L in syllabus.LEVELS for n in d["levels"][L]] + d["bdc"]))
    return f"{d['name']} lesson. " + ", ".join(names[:40]) + "."


# ── in the app: one worker thread ────────────────────────────────────────────

def start():
    """At start-up: requeue jobs a restart cut short, clear audio no recording points at, start the worker."""
    global _thread
    audio_dir().mkdir(parents=True, exist_ok=True)
    with db.tx() as con:
        con.execute("UPDATE lesson_recordings SET status = 'queued', progress = 0, transcript = '' WHERE status = 'running'")
        keep = {r[0] for r in con.execute("SELECT file FROM lesson_recordings WHERE file IS NOT NULL")}
    for f in audio_dir().iterdir():
        if f.name not in keep:
            f.unlink(missing_ok=True)
    if settings.transcribe_worker and _thread is None:
        _thread = threading.Thread(target=_loop, name="transcribe", daemon=True)
        _thread.start()
    kick()


def kick():
    """Tell the worker there's something new in the queue."""
    _wake.set()


def _loop():
    while True:
        _wake.wait(300)
        _wake.clear()
        try:
            while run_next():
                pass
        except Exception:
            log.exception("transcription worker")


def run_next(runner=None) -> bool:
    """Transcribe the oldest queued recording; False if there was none. runner(rec_id) -> error text or '' (tests)."""
    with db.tx() as con:
        row = con.execute("SELECT id FROM lesson_recordings WHERE status = 'queued' ORDER BY created_at LIMIT 1").fetchone()
        if not row:
            return False
        con.execute("UPDATE lesson_recordings SET status = 'running', progress = 0, error = '', transcript = '',"
                    " started_at = ?, finished_at = NULL WHERE id = ?", (db.now(), row["id"]))
    err = (runner or _run_child)(row["id"])
    _finish(row["id"], err)
    return True


def _gone(rec_id: str) -> bool:
    with db.tx() as con:
        return not con.execute("SELECT 1 FROM lesson_recordings WHERE id = ?", (rec_id,)).fetchone()


def _run_child(rec_id: str) -> str:
    """Run the transcription in its own lowest-priority process; stop it if the recording is deleted meanwhile."""
    with tempfile.TemporaryFile() as errf:
        p = subprocess.Popen(["ionice", "-c", "3", "nice", "-n", "19", sys.executable, str(Path(__file__).resolve()),
                              rec_id],
                             cwd=Path(__file__).parent, stdout=subprocess.DEVNULL, stderr=errf)
        while p.poll() is None:
            time.sleep(2)
            if _gone(rec_id):
                p.kill()
                p.wait()
                return ""
        errf.seek(0)
        tail = errf.read().decode(errors="replace").strip().splitlines()[-3:]
    if p.returncode:
        log.error("transcription of %s failed (exit %s): %s", rec_id, p.returncode, " | ".join(tail))
        return "Transcription stopped unexpectedly (the server may have run out of memory). Try again"
    return ""


def _finish(rec_id: str, err: str):
    with db.tx() as con:
        r = con.execute("SELECT status, file, keep_audio, finished_at FROM lesson_recordings WHERE id = ?", (rec_id,)).fetchone()
        if not r:
            return
        if r["status"] != "running":    # the child already marked it failed
            return
        if err or not r["finished_at"]:
            con.execute("UPDATE lesson_recordings SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
                        (err or "Transcription stopped unexpectedly. Try again", db.now(), rec_id))
            return
        # done and the audio gone in one step, so nobody sees a finished transcript whose audio is about to vanish
        drop = r["file"] and not r["keep_audio"]
        con.execute("UPDATE lesson_recordings SET status = 'done'" + (", file = NULL" if drop else "") + " WHERE id = ?",
                    (rec_id,))
    if drop:
        (audio_dir() / r["file"]).unlink(missing_ok=True)


# ── in the child process: the transcription itself ──────────────────────────

def _stamp(t: float) -> str:
    t = int(t)
    return f"[{t // 3600}:{t // 60 % 60:02d}:{t % 60:02d}]" if t >= 3600 else f"[{t // 60}:{t % 60:02d}]"


def _set(rec_id: str, **cols):
    with db.tx() as con:
        con.execute(f"UPDATE lesson_recordings SET {', '.join(k + ' = ?' for k in cols)} WHERE id = ?", (*cols.values(), rec_id))


def transcribe(rec_id: str):
    with db.tx() as con:
        rec = con.execute("SELECT r.file, l.dance FROM lesson_recordings r JOIN lessons l ON l.id = r.lesson_id"
                          " WHERE r.id = ?", (rec_id,)).fetchone()
    if not rec or not rec["file"]:
        return _set(rec_id, status="failed", error="The audio has gone. Upload it again", finished_at=db.now())
    path = str(audio_dir() / rec["file"])
    try:
        import av
        with av.open(path) as f:
            secs = (f.duration or 0) / av.time_base
    except Exception:
        log.exception("couldn't open %s", rec["file"])
        return _set(rec_id, status="failed", error="Couldn't read that audio file. Try an m4a, mp3 or wav",
                    finished_at=db.now())
    if secs > settings.max_audio_minutes * 60:
        return _set(rec_id, status="failed", finished_at=db.now(),
                    error=f"Recordings can be up to {settings.max_audio_minutes} minutes. Trim it and upload again")
    from faster_whisper import WhisperModel   # only this child process loads the model

    model = WhisperModel(settings.whisper_model, device="cpu", compute_type="int8", cpu_threads=settings.whisper_threads,
                         download_root=str(settings.model_dir))
    segments, info = model.transcribe(path, language="en", beam_size=1, vad_filter=True,
                                      condition_on_previous_text=False, hotwords=vocabulary(rec["dance"]))
    _set(rec_id, duration=info.duration)
    lines, last = [], 0.0
    for s in segments:
        text = s.text.strip()
        if text and any(c.isalnum() for c in text):
            lines.append(f"{_stamp(s.start)} {text}")
        if time.time() - last > 5:
            last = time.time()
            _set(rec_id, progress=min(s.end / max(info.duration, 1), 0.99), transcript="\n".join(lines))
    _set(rec_id, progress=1, transcript="\n".join(lines), finished_at=db.now())     # the worker then marks it done


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    transcribe(sys.argv[1])
