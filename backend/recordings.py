"""Lesson recordings: a member uploads (or records in the browser) the audio of a lesson, the server transcribes it
(transcribe.py) and the transcript becomes notes for that lesson.

Privacy: a recording can pick up other people, so its transcript is seen only by the person who added it and the
committee, either of whom can delete it. The audio is deleted once transcribed unless its owner ticks "keep audio".

Notes, cheapest first: rough notes picked out of the transcript here (free), a ready-made prompt to paste into your own
Claude (free to the site), or the admin's "Draft notes with Claude" through ai.py (logged and costed like other calls).
"""
import re
import unicodedata
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import ai
import auth
import db
import syllabus
import transcribe
from common import rid
from config import settings

router = APIRouter()
Member, Admin = Depends(auth.member), Depends(auth.admin)
AUDIO_EXT = {".m4a", ".mp3", ".wav", ".webm", ".ogg", ".oga", ".opus", ".aac", ".mp4", ".flac", ".3gp", ".amr"}


def _row(r) -> dict:
    d = dict(r)
    d["has_audio"] = bool(d.pop("file"))
    d["keep_audio"] = bool(d["keep_audio"])
    return d


def _load(con, rec_id: str, u: dict) -> dict:
    r = con.execute("SELECT * FROM lesson_recordings WHERE id = ?", (rec_id,)).fetchone()
    if not r or (r["user_id"] != u["id"] and not auth.is_committee(u)):
        raise HTTPException(404, "That recording has been deleted")
    return dict(r)


def _lesson(con, lid: str) -> dict:
    l = con.execute("SELECT * FROM lessons WHERE id = ?", (lid,)).fetchone()
    if not l:
        raise HTTPException(404, "That lesson has been deleted")
    return dict(l)


@router.get("/api/lessons/{lid}/recordings")
def lesson_recordings(lid: str, u: dict = Member):
    """Your recordings of this lesson; the committee sees everyone's."""
    with db.tx() as con:
        dance = (con.execute("SELECT dance FROM lessons WHERE id = ?", (lid,)).fetchone() or {"dance": ""})["dance"]
        rows = con.execute("SELECT * FROM lesson_recordings WHERE lesson_id = ? AND (user_id = ? OR ?) ORDER BY created_at",
                           (lid, u["id"], auth.is_committee(u))).fetchall()
        waiting = [r[0] for r in con.execute("SELECT id FROM lesson_recordings WHERE status IN ('queued', 'running')"
                                             " ORDER BY created_at")]
    out = []
    for r in rows:
        d = _row(r)
        if d["status"] == "queued":
            d["ahead"] = waiting.index(d["id"])
        if d["status"] == "done":     # figures named in the notes (or, before there are notes, the transcript)
            d["figures"] = [f["id"] for f in mentioned_figures(d["notes"] or d["transcript"], dance)]
        out.append(d)
    return out


@router.post("/api/lessons/{lid}/recordings")
def add_recording(lid: str, file: UploadFile = File(...), keep_audio: bool = Form(False), u: dict = Member):
    with db.tx() as con:
        _lesson(con, lid)
    ext = Path(file.filename or "").suffix.lower()
    mime = (file.content_type or "").split(";")[0]
    if ext not in AUDIO_EXT and not mime.startswith("audio/"):
        raise HTTPException(415, "That isn't an audio file. Try m4a, mp3, wav, webm or ogg")
    rec_id = rid()
    name = rec_id + (ext if ext in AUDIO_EXT else ".audio")
    if not mime.startswith(("audio/", "video/")):        # the stored (and later served) type is always audio
        mime = "audio/mp4" if ext in (".m4a", ".mp4", ".aac") else "audio/mpeg" if ext == ".mp3" else "application/octet-stream"
    transcribe.audio_dir().mkdir(parents=True, exist_ok=True)
    dest = transcribe.audio_dir() / name
    limit, size = settings.max_audio_mb * 1024 * 1024, 0
    with dest.open("wb") as out:
        while chunk := file.file.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                out.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"Recordings can be up to {settings.max_audio_mb} MB")
            out.write(chunk)
    if not size:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, "That recording is empty")
    with db.tx() as con:
        con.execute("INSERT INTO lesson_recordings (id, lesson_id, user_id, file, mime, size, keep_audio, created_at)"
                    " VALUES (?,?,?,?,?,?,?,?)", (rec_id, lid, u["id"], name, mime, size, int(keep_audio), db.now()))
        ahead = con.execute("SELECT count(*) FROM lesson_recordings WHERE status IN ('queued', 'running') AND id <> ?",
                            (rec_id,)).fetchone()[0]
    transcribe.kick()
    return {"id": rec_id, "ahead": ahead}


@router.get("/api/recordings/{rec_id}")
def get_recording(rec_id: str, u: dict = Member):
    with db.tx() as con:
        r = _load(con, rec_id, u)
        if r["status"] == "queued":
            r["ahead"] = con.execute("SELECT count(*) FROM lesson_recordings WHERE status IN ('queued', 'running')"
                                     " AND created_at < ?", (r["created_at"],)).fetchone()[0]
    return _row(r)


@router.post("/api/recordings/{rec_id}/retry")
def retry_recording(rec_id: str, u: dict = Member):
    with db.tx() as con:
        r = _load(con, rec_id, u)
        if r["status"] != "failed" or not r["file"]:
            raise HTTPException(400, "Only a failed recording that still has its audio can be tried again")
        con.execute("UPDATE lesson_recordings SET status = 'queued', error = '', progress = 0 WHERE id = ?", (rec_id,))
    transcribe.kick()
    return {"ok": True}


@router.get("/api/recordings/{rec_id}/audio")
def recording_audio(rec_id: str, u: dict = Member):
    with db.tx() as con:
        r = _load(con, rec_id, u)
    if not r["file"]:
        raise HTTPException(404, "The audio was deleted after it was transcribed")
    mime = r["mime"] if (r["mime"] or "").startswith(("audio/", "video/")) else "application/octet-stream"
    return FileResponse(transcribe.audio_dir() / r["file"], media_type=mime)


class KeepIn(BaseModel):
    keep_audio: bool


@router.patch("/api/recordings/{rec_id}")
def keep_or_drop_audio(rec_id: str, body: KeepIn, u: dict = Member):
    """Untick "keep audio" on a transcribed recording to delete its audio now."""
    with db.tx() as con:
        r = _load(con, rec_id, u)
        drop = not body.keep_audio and r["file"] and r["status"] == "done"
        con.execute("UPDATE lesson_recordings SET keep_audio = ?" + (", file = NULL" if drop else "") + " WHERE id = ?",
                    (int(body.keep_audio), rec_id))
    if drop:
        (transcribe.audio_dir() / r["file"]).unlink(missing_ok=True)
    return {"ok": True}


def delete_files(rows):
    for r in rows:
        if r["file"]:
            (transcribe.audio_dir() / r["file"]).unlink(missing_ok=True)


@router.delete("/api/recordings/{rec_id}")
def delete_recording(rec_id: str, u: dict = Member):
    """Its owner or the committee can delete a recording: the audio, the transcript and its notes."""
    with db.tx() as con:
        r = _load(con, rec_id, u)
        con.execute("DELETE FROM lesson_recordings WHERE id = ?", (rec_id,))
    delete_files([r])
    return {"ok": True}


class NotesIn(BaseModel):
    text: str = Field(max_length=20000)


@router.put("/api/recordings/{rec_id}/notes")
def save_notes(rec_id: str, body: NotesIn, u: dict = Member):
    with db.tx() as con:
        r = _load(con, rec_id, u)
        if r["user_id"] != u["id"]:
            raise HTTPException(403, "Only the person who recorded it can change these notes")
        con.execute("UPDATE lesson_recordings SET notes = ? WHERE id = ?", (body.text, rec_id))
    return {"ok": True, "figures": [f["id"] for f in mentioned_figures(body.text, _dance_of(rec_id))]}


def _dance_of(rec_id: str) -> str:
    with db.tx() as con:
        r = con.execute("SELECT l.dance FROM lesson_recordings r JOIN lessons l ON l.id = r.lesson_id WHERE r.id = ?",
                        (rec_id,)).fetchone()
    return r["dance"] if r else ""


def _done(con, rec_id: str, u: dict) -> tuple[dict, dict]:
    r = _load(con, rec_id, u)
    if r["status"] != "done" or not r["transcript"].strip():
        raise HTTPException(400, "Wait for the transcript first" if r["status"] != "done" else "The transcript is empty")
    return r, _lesson(con, r["lesson_id"])


@router.get("/api/recordings/{rec_id}/draft")
def draft_free(rec_id: str, u: dict = Member):
    """Free notes: rough notes picked out of the transcript here, and the prompt to paste into your own Claude."""
    with db.tx() as con:
        r, l = _done(con, rec_id, u)
    figs = mentioned_figures(r["transcript"], l["dance"])
    return {"notes": rough_notes(r["transcript"], figs), "figures": [f["id"] for f in figs],
            "prompt": claude_prompt(r["transcript"], l)}


@router.post("/api/recordings/{rec_id}/draft")
def draft_with_claude(rec_id: str, u: dict = Admin):
    auth.check_ai(u)
    with db.tx() as con:
        r, l = _done(con, rec_id, u)
    try:
        out = ai.lesson_notes(r["transcript"], lesson_context(l), who=u["id"], purpose="lesson-notes:" + rec_id)
    except ai.Unavailable as e:
        raise HTTPException(503, str(e))
    figs = []
    for name in out["figures"]:
        f = (syllabus.by_name(l["dance"], name) if l["dance"] else None) or next(
            (f for d in syllabus.DANCES if (f := syllabus.by_name(d["id"], name))), None)
        if f and f not in figs:
            figs.append(f)
    for f in mentioned_figures(r["transcript"], l["dance"]):
        if f not in figs:
            figs.append(f)
    return {"notes": format_notes(out, figs), "figures": [f["id"] for f in figs]}


# ── turning a transcript into notes ──────────────────────────────────────────

def _norm(s: str) -> str:
    s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode().lower()
    return " " + re.sub(r"[^a-z0-9]+", " ", s).strip() + " "


WORD_FORMS = [(" pp ", [" promenade position ", " promenade "]), (" lf ", [" left foot "]), (" rf ", [" right foot "]),
              (" cbm ", [" contra body movement ", " contrary body movement "]), (" chasse ", [" chase "]),
              (" chasses ", [" chases "])]


def _forms(name: str) -> set[str]:
    """Ways a figure's name may come out in a transcript: the name, its abbreviations spelt out, no brackets."""
    out = {_norm(name), _norm(re.sub(r"\(.*?\)", "", name))}
    for short, longs in WORD_FORMS:
        out |= {f.replace(short, lng) for f in list(out) if short in f for lng in longs}
    return {f for f in out if f.strip()}


def mentioned_figures(text: str, dance_id: str = "") -> list[dict]:
    """Syllabus figures named in the text, in order of first mention. Longer names win ("Natural Spin Turn" isn't
    also a "Natural Turn"). Without a dance, one-word names (Walk, Link, Fan…) are too common to count."""
    hay = _norm(text)
    dances = [syllabus.dance(dance_id)] if syllabus.dance(dance_id) else syllabus.DANCES
    cands = []
    for d in dances:
        for name in dict.fromkeys([n for L in syllabus.LEVELS for n in d["levels"][L]] + d["bdc"]):
            if len(dances) > 1 and " " not in name.strip():
                continue
            f = syllabus.by_name(d["id"], name)
            cands += [(form, f) for form in _forms(name)]
    found = {}
    for form, f in sorted(cands, key=lambda c: -len(c[0])):
        i = hay.find(form)
        while i >= 0:
            if f["id"] not in found or i < found[f["id"]][0]:
                found[f["id"]] = (i, f)
            hay = hay[:i] + " " + "#" * (len(form) - 2) + " " + hay[i + len(form):]
            i = hay.find(form)
    return [f for _, f in sorted(found.values(), key=lambda x: x[0])]


HOMEWORK = re.compile(r"\b(homework|for next (week|time|lesson)|before next|next week|on your own|at home|practi[cs]e (this|that|it|these|those))\b", re.I)
TIMING = re.compile(r"\b(counts?|counted|timing|beats?|bars?|slow|quick|rhythm|tempo|on the (one|two|three|four|and|a)|"
                    r"one,? two,? three|quick,? quick|and a)\b|\b\d(?:[-, ]+\d)+\b|\b(123|1234|5678)\b", re.I)
TECHNIQUE = re.compile(r"\b(don'?t|do not|keep|remember|make sure|watch|careful|try to|should|too (much|fast|early|late|far|small|big)|"
                       r"rushing|instead|heel|toe|rise|rising|lower|lowering|frame|posture|weight|knees?|hips?|head|arms?|"
                       r"shoulders?|cbm|contra|sway|pivot|hold|connection|lead|leading|balance|straight|bend|stretch)\b", re.I)
COUNTING = re.compile(r"\b(one|two|three|four|five|six|seven|eight|and|a|slow|quick|go|ready|okay|ok|right)\b", re.I)


def _sentences(transcript: str) -> list[str]:
    text = " ".join(re.sub(r"^\[[\d:]+\]\s*", "", ln) for ln in transcript.splitlines())
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]


def rough_notes(transcript: str, figs: list[dict]) -> str:
    """Notes picked out of the transcript with simple word lists: no AI, so check and tidy them."""
    buckets = {"homework": [], "timing": [], "technique": []}
    for s in _sentences(transcript):
        words = re.findall(r"[a-z']+", s.lower())
        if len(words) < 4 or len([w for w in words if not COUNTING.fullmatch(w)]) < 3:
            continue                      # "Five, six, seven, and one."
        for k, rx in (("homework", HOMEWORK), ("timing", TIMING), ("technique", TECHNIQUE)):
            if rx.search(s):
                if s not in buckets[k]:
                    buckets[k].append(s)
                break
    return format_notes({"summary": "", "technique": buckets["technique"][:15], "timing": buckets["timing"][:10],
                         "homework": buckets["homework"][:8]}, figs)


def format_notes(n: dict, figs: list[dict]) -> str:
    parts = [n["summary"].strip()] if n.get("summary", "").strip() else []
    if figs:
        parts.append("Figures: " + ", ".join(f["name"] for f in figs))
    for key, title in (("technique", "Technique and corrections"), ("timing", "Counts and timing"), ("homework", "Homework")):
        if n.get(key):
            parts.append(title + ":\n" + "\n".join("- " + x.strip() for x in n[key]))
    return "\n\n".join(parts)


def lesson_context(l: dict) -> str:
    d = syllabus.dance(l["dance"])
    if d:
        names = list(dict.fromkeys([n for L in syllabus.LEVELS for n in d["levels"][L]] + d["bdc"]))
        figs = f"{d['name']} figures (use these exact names):\n" + "; ".join(names)
    else:
        figs = "Figures (use these exact names):\n" + "\n".join(
            f"{x['name']}: " + "; ".join(dict.fromkeys([n for L in syllabus.LEVELS for n in x["levels"][L]] + x["bdc"]))
            for x in syllabus.DANCES)
    return f"Lesson on {l['date']}" + (f": {l['title']}" if l["title"] else "") + (f" ({d['name']})" if d else "") + "\n\n" + figs


def claude_prompt(transcript: str, l: dict) -> str:
    """The prompt for 'Copy transcript for Claude': the same brief as ai.lesson_notes, asking for plain text back."""
    return (ai.NOTES_SYSTEM + "\n\nWrite the notes as plain text in this layout, leaving out any section with nothing in it:\n\n"
            "One or two sentences on what the lesson covered.\n\nFigures: Natural Turn, Whisk, …\n\n"
            "Technique and corrections:\n- …\n\nCounts and timing:\n- …\n\nHomework:\n- …\n\n"
            "<lesson>\n" + lesson_context(l) + "\n</lesson>\n\n<transcript>\n" + transcript + "\n</transcript>")
