"""Members-only society features: chart verification, comments and notes, lessons, competitions, draft requests."""
import json
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import ai
import auth
import db
import recordings
import syllabus
from common import charts, clean_items, fig_or_404, load_routine, match_proposal, rid

router = APIRouter()
Member, Committee, Admin = Depends(auth.member), Depends(auth.committee), Depends(auth.admin)
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _date(v: str | None, label: str, required: bool = False) -> str | None:
    if not v:
        if required:
            raise HTTPException(400, f"Add the {label}")
        return None
    if not DATE.match(v):
        raise HTTPException(400, f"Write the {label} as YYYY-MM-DD")
    return v


# ── chart verification ───────────────────────────────────────────────────────

@router.post("/api/figures/{fig_id}/verified")
def verify_figure(fig_id: str, u: dict = Committee):
    fig_or_404(fig_id)
    with db.tx() as con:
        con.execute("INSERT OR REPLACE INTO figure_status VALUES (?,?,?)", (fig_id, u["id"], db.now()))
    return {"ok": True}


@router.delete("/api/figures/{fig_id}/verified")
def unverify_figure(fig_id: str, u: dict = Committee):
    with db.tx() as con:
        con.execute("DELETE FROM figure_status WHERE fig_id = ?", (fig_id,))
    return {"ok": True}


# ── comments and private notes on figures ────────────────────────────────────

class TextIn(BaseModel):
    text: str = Field(max_length=8000)


@router.get("/api/figures/{fig_id}/comments")
def figure_comments(fig_id: str, u: dict = Member):
    with db.tx() as con:
        return [dict(r) for r in con.execute("SELECT * FROM figure_comments WHERE fig_id = ? ORDER BY id", (fig_id,))]


@router.post("/api/figures/{fig_id}/comments")
def add_figure_comment(fig_id: str, body: TextIn, u: dict = Member):
    fig_or_404(fig_id)
    if not body.text.strip():
        raise HTTPException(400, "Write something first")
    with db.tx() as con:
        con.execute("INSERT INTO figure_comments (fig_id, user_id, text, created_at) VALUES (?,?,?,?)",
                    (fig_id, u["id"], body.text.strip(), db.now()))
    return figure_comments(fig_id, u)


def _delete_comment(table: str, cid: int, u: dict):
    with db.tx() as con:
        row = con.execute(f"SELECT user_id FROM {table} WHERE id = ?", (cid,)).fetchone()
        if not row:
            return
        if row["user_id"] != u["id"] and not auth.is_committee(u):
            raise HTTPException(403, "You can only remove your own comments")
        con.execute(f"DELETE FROM {table} WHERE id = ?", (cid,))


@router.delete("/api/figure-comments/{cid}")
def delete_figure_comment(cid: int, u: dict = Member):
    _delete_comment("figure_comments", cid, u)
    return {"ok": True}


@router.put("/api/notes/{fig_id}")
def put_my_note(fig_id: str, body: TextIn, u: dict = Member):
    fig_or_404(fig_id)
    with db.tx() as con:
        if body.text.strip():
            con.execute("INSERT OR REPLACE INTO user_notes VALUES (?,?,?,?)", (u["id"], fig_id, body.text, db.now()))
        else:
            con.execute("DELETE FROM user_notes WHERE user_id = ? AND fig_id = ?", (u["id"], fig_id))
    return {"ok": True}


# ── lessons ──────────────────────────────────────────────────────────────────

class LessonIn(BaseModel):
    date: str
    group_id: int | None = None
    dance: str = ""
    title: str = Field("", max_length=120)
    summary: str = Field("", max_length=8000)
    figures: list[str] = []
    items: list[dict] = []


def lesson_row(row) -> dict:
    d = dict(row)
    d["figures"], d["items"] = json.loads(d["figures"]), json.loads(d["items"])
    return d


def _lesson_values(body: LessonIn) -> tuple:
    if body.dance and not syllabus.dance(body.dance):
        raise HTTPException(400, "Unknown dance")
    figs = list(dict.fromkeys(f for f in body.figures if syllabus.figure(f)))
    return (_date(body.date, "lesson date", True), body.group_id, body.dance, body.title.strip(), body.summary,
            json.dumps(figs), json.dumps(clean_items(body.items)))


@router.post("/api/lessons")
def create_lesson(body: LessonIn, u: dict = Committee):
    lid, t = rid(), db.now()
    with db.tx() as con:
        con.execute("INSERT INTO lessons (id, date, group_id, dance, title, summary, figures, items, created_by, updated_by,"
                    " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (lid, *_lesson_values(body), u["id"], u["id"], t, t))
    return {"id": lid}


@router.put("/api/lessons/{lid}")
def update_lesson(lid: str, body: LessonIn, u: dict = Committee):
    with db.tx() as con:
        cur = con.execute("UPDATE lessons SET date=?, group_id=?, dance=?, title=?, summary=?, figures=?, items=?,"
                          " updated_by=?, updated_at=? WHERE id=?", (*_lesson_values(body), u["id"], db.now(), lid))
        if not cur.rowcount:
            raise HTTPException(404, "That lesson has been deleted")
    return {"ok": True}


@router.delete("/api/lessons/{lid}")
def delete_lesson(lid: str, u: dict = Committee):
    with db.tx() as con:
        recordings.delete_files(con.execute("SELECT file FROM lesson_recordings WHERE lesson_id = ?", (lid,)).fetchall())
        con.execute("DELETE FROM lessons WHERE id = ?", (lid,))
        con.execute("DELETE FROM videos WHERE ref = ?", ("lesson:" + lid,))
    return {"ok": True}


@router.get("/api/lessons/{lid}/comments")
def lesson_comments(lid: str, u: dict = Member):
    with db.tx() as con:
        return [dict(r) for r in con.execute("SELECT * FROM lesson_comments WHERE lesson_id = ? ORDER BY id", (lid,))]


@router.post("/api/lessons/{lid}/comments")
def add_lesson_comment(lid: str, body: TextIn, u: dict = Member):
    if not body.text.strip():
        raise HTTPException(400, "Write something first")
    with db.tx() as con:
        if not con.execute("SELECT 1 FROM lessons WHERE id = ?", (lid,)).fetchone():
            raise HTTPException(404, "That lesson has been deleted")
        con.execute("INSERT INTO lesson_comments (lesson_id, user_id, text, created_at) VALUES (?,?,?,?)",
                    (lid, u["id"], body.text.strip(), db.now()))
    return lesson_comments(lid, u)


@router.delete("/api/lesson-comments/{cid}")
def delete_lesson_comment(cid: int, u: dict = Member):
    _delete_comment("lesson_comments", cid, u)
    return {"ok": True}


# ── competitions ─────────────────────────────────────────────────────────────

class CompetitionIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    host: str = Field("", max_length=120)
    start_date: str | None = None
    end_date: str | None = None
    venue: str = Field("", max_length=200)
    travel: str = "tbc"
    team_entry: bool = False
    entry_url: str = Field("", max_length=1000)
    entry_deadline: str | None = None
    notes: str = Field("", max_length=4000)
    confirmed: bool = True


def _competition_values(body: CompetitionIn) -> tuple:
    if body.travel not in ("society", "own", "tbc"):
        raise HTTPException(400, "Travel must be society, own or tbc")
    if body.entry_url and not body.entry_url.lower().startswith(("https://", "http://")):
        raise HTTPException(400, "The entry form link must start with https://")
    return (body.name.strip(), body.host.strip(), _date(body.start_date, "start date"), _date(body.end_date, "end date"),
            body.venue.strip(), body.travel, int(body.team_entry), body.entry_url.strip(),
            _date(body.entry_deadline, "entry deadline"), body.notes, int(body.confirmed))


@router.post("/api/competitions")
def create_competition(body: CompetitionIn, u: dict = Committee):
    cid = rid()
    with db.tx() as con:
        con.execute("INSERT INTO competitions (id, name, host, start_date, end_date, venue, travel, team_entry, entry_url,"
                    " entry_deadline, notes, confirmed, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (cid, *_competition_values(body), u["id"], db.now()))
    return {"id": cid}


@router.put("/api/competitions/{cid}")
def update_competition(cid: str, body: CompetitionIn, u: dict = Committee):
    with db.tx() as con:
        cur = con.execute("UPDATE competitions SET name=?, host=?, start_date=?, end_date=?, venue=?, travel=?, team_entry=?,"
                          " entry_url=?, entry_deadline=?, notes=?, confirmed=?, updated_by=?, updated_at=? WHERE id=?",
                          (*_competition_values(body), u["id"], db.now(), cid))
        if not cur.rowcount:
            raise HTTPException(404, "That competition has been deleted")
    return {"ok": True}


@router.delete("/api/competitions/{cid}")
def delete_competition(cid: str, u: dict = Committee):
    with db.tx() as con:
        con.execute("DELETE FROM competitions WHERE id = ?", (cid,))
    return {"ok": True}


# ── "Request a draft": members queue Claude work for the admin ───────────────

class RequestIn(BaseModel):
    kind: str
    target: str
    note: str = Field("", max_length=2000)


@router.post("/api/requests")
def request_draft(body: RequestIn, u: dict = Member):
    with db.tx() as con:
        if body.kind == "chart":
            fig_or_404(body.target)
        elif body.kind == "routine":
            load_routine(con, body.target, u, edit=True)
        else:
            raise HTTPException(400, "Unknown request")
        if con.execute("SELECT 1 FROM ai_requests WHERE kind = ? AND target = ? AND status = 'open'",
                       (body.kind, body.target)).fetchone():
            return {"ok": True, "already": True}
        con.execute("INSERT INTO ai_requests (user_id, kind, target, note, created_at) VALUES (?,?,?,?,?)",
                    (u["id"], body.kind, body.target, body.note.strip(), db.now()))
    return {"ok": True}


def _finish_request(rq_id: int, status: str, u: dict):
    with db.tx() as con:
        con.execute("UPDATE ai_requests SET status = ?, handled_at = ?, handled_by = ? WHERE id = ?",
                    (status, db.now(), u["id"], rq_id))


@router.post("/api/admin/requests/{rq_id}/run")
def run_request(rq_id: int, u: dict = Admin):
    auth.check_ai(u)
    with db.tx() as con:
        rq = con.execute("SELECT * FROM ai_requests WHERE id = ?", (rq_id,)).fetchone()
        if not rq or rq["status"] != "open":
            raise HTTPException(404, "That request has already been handled")
        requester = con.execute("SELECT name FROM users WHERE id = ?", (rq["user_id"],)).fetchone()
    try:
        if rq["kind"] == "chart":
            f = fig_or_404(rq["target"])
            with db.tx() as con:
                existing = charts(con).get(f["id"]) or syllabus.STARTER.get(f["id"])
            chart = ai.draft_chart(syllabus.dance(f["dance"]), f, existing, who=u["id"])
            with db.tx() as con:
                con.execute("INSERT OR REPLACE INTO charts VALUES (?,?,?,?,?)", (f["id"], json.dumps(chart), "ai", u["id"], db.now()))
        else:
            with db.tx() as con:
                r = load_routine(con, rq["target"], u)
                msg = "Please draft a full routine" + (f": {rq['note']}" if rq["note"] else " from our brief.")
                con.execute("INSERT INTO chat (routine_id, role, content, user_id, at) VALUES (?,?,?,?,?)",
                            (r["id"], "user", msg, rq["user_id"], db.now()))
                history = [{"role": h["role"], "content": h["content"], "author": requester["name"] if requester else "Dancer"}
                           for h in con.execute("SELECT * FROM chat WHERE routine_id = ? ORDER BY id", (r["id"],))]
                ch = charts(con)
            out = ai.routine_chat(r, ch, history, who=u["id"], draft=True)
            proposal = match_proposal(r, out.get("proposal"))
            with db.tx() as con:
                con.execute("INSERT INTO chat (routine_id, role, content, proposal, at) VALUES (?,?,?,?,?)",
                            (r["id"], "assistant", out["reply"], json.dumps(proposal) if proposal else None, db.now()))
    except ai.Unavailable as e:
        raise HTTPException(503, str(e))
    _finish_request(rq_id, "done", u)
    return {"ok": True}


@router.post("/api/admin/requests/{rq_id}/dismiss")
def dismiss_request(rq_id: int, u: dict = Admin):
    _finish_request(rq_id, "dismissed", u)
    return {"ok": True}
