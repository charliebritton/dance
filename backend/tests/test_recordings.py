"""Lesson recordings: upload, the transcription queue, who can see them, and turning the transcript into notes."""
from test_access import app, person  # noqa: F401  (app is a fixture)

TRANSCRIPT = """[0:02] Right everyone, tonight we are doing waltz, starting with the natural turn and the reverse turn.
[0:09] Leaders, keep your head to the left and don't pull down on your partner's arm.
[0:15] Five, six, seven, and one.
[0:21] After the reverse turn we go into a whisk and then chase from promenade position.
[0:30] The count is one two three, one two three, and the pivot happens on four in the natural spin turn.
[0:41] For homework, practise the natural spin turn at home ten times on each side of the room."""


def _lesson(app, dance="waltz"):
    boss = person(app, "Charlie", "admin")
    lid = boss.post("/api/lessons", json={"date": "2026-10-20", "dance": dance}).json()["id"]
    return boss, lid


def _upload(c, lid, name="lesson.m4a", data=b"fake audio", mime="audio/mp4", keep=False):
    return c.post(f"/api/lessons/{lid}/recordings", files={"file": (name, data, mime)},
                  data={"keep_audio": "true" if keep else "false"})


def _fake_whisper(text=TRANSCRIPT):
    """Stands in for the child process: writes the transcript the way transcribe.transcribe() does."""
    import db

    def run(rec_id):
        with db.tx() as con:
            con.execute("UPDATE lesson_recordings SET progress = 1, duration = 45, transcript = ?, finished_at = 1"
                        " WHERE id = ?", (text, rec_id))
        return ""
    return run


def test_upload_transcribe_and_only_owner_and_committee_see_it(app):
    import transcribe
    boss, lid = _lesson(app)
    ann, bob, com = person(app, "Ann"), person(app, "Bob"), person(app, "Cat", "committee")
    r = _upload(ann, lid)
    assert r.status_code == 200, r.text
    rec = r.json()["id"]
    assert ann.get(f"/api/recordings/{rec}").json()["status"] == "queued"
    assert [x["id"] for x in com.get(f"/api/lessons/{lid}/recordings").json()] == [rec]
    assert bob.get(f"/api/lessons/{lid}/recordings").json() == []
    assert bob.get(f"/api/recordings/{rec}").status_code == 404
    assert bob.delete(f"/api/recordings/{rec}").status_code == 404
    assert len(list(transcribe.audio_dir().iterdir())) == 1

    assert transcribe.run_next(_fake_whisper()) is True
    assert transcribe.run_next(_fake_whisper()) is False
    got = ann.get(f"/api/recordings/{rec}").json()
    assert (got["status"], got["has_audio"]) == ("done", False)
    assert "natural turn" in got["transcript"]
    assert list(transcribe.audio_dir().iterdir()) == []            # audio deleted once transcribed
    assert ann.get(f"/api/recordings/{rec}/audio").status_code == 404

    assert ann.put(f"/api/recordings/{rec}/notes", json={"text": "Whisk then Chassé from PP"}).json()["figures"] == [
        "waltz.whisk", "waltz.chasse-from-pp"]
    assert com.put(f"/api/recordings/{rec}/notes", json={"text": "mine now"}).status_code == 403
    assert ann.get(f"/api/recordings/{rec}").json()["notes"] == "Whisk then Chassé from PP"
    assert ann.delete(f"/api/recordings/{rec}").status_code == 200
    assert com.get(f"/api/lessons/{lid}/recordings").json() == []


def test_keep_audio_and_delete(app):
    import transcribe
    boss, lid = _lesson(app)
    ann = person(app, "Ann")
    rec = _upload(ann, lid, "memo.webm", b"webm bytes", "audio/webm;codecs=opus", keep=True).json()["id"]
    transcribe.run_next(_fake_whisper())
    assert ann.get(f"/api/recordings/{rec}").json()["has_audio"] is True
    a = ann.get(f"/api/recordings/{rec}/audio")
    assert a.status_code == 200 and a.content == b"webm bytes"
    assert ann.patch(f"/api/recordings/{rec}", json={"keep_audio": False}).status_code == 200
    assert ann.get(f"/api/recordings/{rec}").json()["has_audio"] is False
    assert list(transcribe.audio_dir().iterdir()) == []

    rec2 = _upload(ann, lid, keep=True).json()["id"]
    assert boss.delete(f"/api/recordings/{rec2}").status_code == 200     # the committee can remove one too
    assert list(transcribe.audio_dir().iterdir()) == []


def test_uploads_must_be_audio(app):
    boss, lid = _lesson(app)
    ann = person(app, "Ann")
    assert _upload(ann, lid, "notes.txt", b"hello", "text/plain").status_code == 415
    assert _upload(ann, lid, "empty.m4a", b"").status_code == 400
    assert _upload(ann, "nope").status_code == 404
    for name, mime in (("a.mp3", "audio/mpeg"), ("b.wav", "audio/wav"), ("c.ogg", "audio/ogg"),
                       ("Voice memo.m4a", "application/octet-stream")):
        assert _upload(ann, lid, name, b"x", mime).status_code == 200


def test_failed_jobs_keep_their_audio_and_can_be_retried(app):
    import transcribe
    boss, lid = _lesson(app)
    ann = person(app, "Ann")
    rec = _upload(ann, lid).json()["id"]
    transcribe.run_next(lambda rec_id: "Transcription stopped unexpectedly")
    got = ann.get(f"/api/recordings/{rec}").json()
    assert (got["status"], got["has_audio"], got["error"]) == ("failed", True, "Transcription stopped unexpectedly")
    assert ann.post(f"/api/recordings/{rec}/retry").status_code == 200
    assert ann.get(f"/api/recordings/{rec}").json()["status"] == "queued"


def test_a_restart_requeues_the_running_job_and_clears_stray_audio(app):
    import db
    import transcribe
    boss, lid = _lesson(app)
    rec = _upload(person(app, "Ann"), lid).json()["id"]
    with db.tx() as con:
        con.execute("UPDATE lesson_recordings SET status = 'running', progress = 0.4 WHERE id = ?", (rec,))
    (transcribe.audio_dir() / "stray.m4a").write_bytes(b"x")
    transcribe.start()
    assert boss.get(f"/api/recordings/{rec}").json()["status"] == "queued"
    assert [f.name for f in transcribe.audio_dir().iterdir()] == [rec + ".m4a"]


def test_deleting_the_lesson_or_the_person_removes_recordings(app):
    import transcribe
    boss, lid = _lesson(app)
    ann = person(app, "Ann")
    _upload(ann, lid)
    boss.delete(f"/api/lessons/{lid}")
    assert list(transcribe.audio_dir().iterdir()) == []

    lid = boss.post("/api/lessons", json={"date": "2026-10-27"}).json()["id"]
    _upload(ann, lid)
    ann_id = ann.get("/api/me").json()["me"]["id"]
    assert boss.delete(f"/api/admin/users/{ann_id}").status_code == 200
    assert boss.get(f"/api/lessons/{lid}/recordings").json() == []
    assert list(transcribe.audio_dir().iterdir()) == []


def test_free_notes_pick_out_figures_corrections_counts_and_homework(app):
    import transcribe
    boss, lid = _lesson(app)
    ann = person(app, "Ann")
    rec = _upload(ann, lid).json()["id"]
    assert ann.get(f"/api/recordings/{rec}/draft").status_code == 400      # no transcript yet
    transcribe.run_next(_fake_whisper())
    d = ann.get(f"/api/recordings/{rec}/draft").json()
    # "natural spin turn" isn't also counted as a natural turn; "chase from promenade position" is Chassé from PP
    assert d["figures"] == ["waltz.natural-turn", "waltz.reverse-turn", "waltz.whisk", "waltz.chasse-from-pp",
                            "waltz.natural-spin-turn"]
    notes = d["notes"]
    assert notes.startswith("Figures: Natural Turn, Reverse Turn, Whisk, Chassé from PP, Natural Spin Turn")
    assert "Technique and corrections:\n- Leaders, keep your head to the left" in notes
    assert "Counts and timing:\n- The count is one two three" in notes
    assert "Homework:\n- For homework, practise the natural spin turn" in notes
    assert "Five, six, seven" not in notes
    assert "<transcript>\n" + TRANSCRIPT in d["prompt"] and "Waltz figures (use these exact names)" in d["prompt"]
    assert "Homework:" in d["prompt"]


def test_figures_without_a_dance_need_more_than_one_word():
    import recordings
    figs = [f["id"] for f in recordings.mentioned_figures("Walk then a Fan, then the Natural Top and a Feather Step")]
    assert figs == ["chacha.natural-top", "foxtrot.feather-step"]
    assert [f["id"] for f in recordings.mentioned_figures("Walk, walk, then the progressive link", "tango")] == [
        "tango.walk", "tango.progressive-link"]


def test_drafting_with_claude_is_admin_only_and_matches_figures(app, monkeypatch):
    import ai
    import transcribe
    boss, lid = _lesson(app)
    ann = person(app, "Ann")
    rec = _upload(ann, lid).json()["id"]
    transcribe.run_next(_fake_whisper())
    seen = {}

    def fake_call(system, messages, schema, **kw):
        seen.update(system=system, schema=schema, prompt=messages[0]["content"], **kw)
        return {"summary": "Waltz basics into the corner.", "figures": ["Natural Spin Turn", "Whisk", "Made Up Spin"],
                "technique": ["Head to the left"], "timing": ["123 123, pivot on 4"], "homework": ["Spin turns at home"]}
    monkeypatch.setattr(ai, "_call", fake_call)
    assert ann.post(f"/api/recordings/{rec}/draft").status_code == 403
    out = boss.post(f"/api/recordings/{rec}/draft").json()
    assert seen["schema"] is ai.NOTES_SCHEMA and seen["purpose"] == "lesson-notes:" + rec
    assert "<transcript>" in seen["prompt"] and "Natural Spin Turn" in seen["prompt"]
    assert out["figures"][:2] == ["waltz.natural-spin-turn", "waltz.whisk"]          # Claude's first, then the rest heard
    assert set(out["figures"]) >= {"waltz.natural-turn", "waltz.reverse-turn", "waltz.chasse-from-pp"}
    assert out["notes"].startswith("Waltz basics into the corner.\n\nFigures: Natural Spin Turn, Whisk, ")
    assert "Homework:\n- Spin turns at home" in out["notes"]
