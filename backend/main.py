"""Rise & Fall API. All routes under /api; everything else serves the single-page frontend.

Anyone can read the syllabus and step charts. People's names, videos, routines, lessons and competitions are for
signed-in members (see auth.py for the roles and accounts.py / society.py for those routes).
"""
import json
import logging
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, Field

import accounts
import ai
import auth
import db
import recordings
import renders
import society
import syllabus
import transcribe
from common import (can_edit_routine, can_see_routine, charts, clean_items, fig_or_404, load_routine, match_proposal, rid,
                    routine_row)
from config import ROOT, settings

logging.basicConfig(level=logging.INFO)
FRONTEND = ROOT / "frontend"
app = FastAPI(title="Rise & Fall", docs_url=None, redoc_url=None)
app.add_middleware(GZipMiddleware, minimum_size=2048)   # the syllabus with every chart is ~300 KB of JSON
db.init()
settings.upload_dir.mkdir(parents=True, exist_ok=True)
transcribe.start()

Viewer, Member, Committee = Depends(auth.viewer), Depends(auth.member), Depends(auth.committee)


@app.middleware("http")
async def revalidate_frontend(request: Request, call_next):
    """Make browsers check for a newer app on every load (cheap: unchanged files come back 304)."""
    root = request.scope.get("root_path", "")
    path = request.url.path[len(root):] if root else request.url.path
    resp = await call_next(request)
    if not path.startswith(("/api/", "/media/")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


app.include_router(accounts.router)
app.include_router(society.router)
app.include_router(renders.router)
app.include_router(recordings.router)


# --- syllabus + shared state ---------------------------------------------------

@app.get("/api/syllabus")
def get_syllabus():
    return {"levels": syllabus.LEVELS, "syllabi": syllabus.SYLLABI, "dances": syllabus.DANCES, "charts": syllabus.STARTER}


@app.get("/api/state")
def state(u: dict | None = Viewer):
    """Everything the app shows, in one go; visitors get only the public part. Polled to pick up others' changes."""
    with db.tx() as con:
        verified = {r["fig_id"]: {"at": r["verified_at"], **({"by": r["verified_by"]} if u else {})}
                    for r in con.execute("SELECT * FROM figure_status")}
        out = {"charts": charts(con), "verified": verified, "renders": renders.public(con)}
        if not u:
            return out
        routines = [r for r in (routine_row(x) for x in con.execute("SELECT * FROM routines ORDER BY updated_at DESC"))
                    if r["example"] or u["id"] in {r["owner_id"], r["lead_id"], r["follow_id"]}]
        seen = {r["id"] for r in routines}
        approvals = {}
        for a in con.execute("SELECT * FROM approvals"):
            approvals.setdefault(a["routine_id"], {})[a["user_id"]] = a["rev"]
        for r in routines:
            r["approvals"] = approvals.get(r["id"], {})
        members = []
        for m in con.execute("SELECT id, name, role, dance_role, pw_hash <> '' OR EXISTS (SELECT 1 FROM passkeys"
                             " WHERE user_id = users.id) AS joined FROM users ORDER BY name"):
            members.append(dict(m) | {"joined": bool(m["joined"]), "groups": [g[0] for g in con.execute(
                "SELECT group_id FROM user_groups WHERE user_id = ?", (m["id"],))]})
        videos = [dict(v) for v in con.execute("SELECT * FROM videos ORDER BY created_at")
                  if not v["ref"].startswith("routine:") or v["ref"][8:] in seen]
        out |= {
            "users": members,
            "groups": [dict(g) for g in con.execute("SELECT * FROM groups ORDER BY sort, name")],
            "routines": routines,
            "notes": {n["fig_id"]: n["text"] for n in con.execute("SELECT * FROM user_notes WHERE user_id = ?", (u["id"],))},
            "comment_counts": {r[0]: r[1] for r in con.execute("SELECT fig_id, count(*) FROM figure_comments GROUP BY fig_id")},
            "videos": videos,
            "lessons": [society.lesson_row(r) for r in con.execute("SELECT * FROM lessons ORDER BY date DESC, created_at DESC")],
            "competitions": [dict(r) for r in con.execute("SELECT * FROM competitions ORDER BY start_date IS NULL, start_date")],
            "requests": [dict(r) for r in con.execute(
                "SELECT id, kind, target, status, created_at FROM ai_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
                (u["id"],))],
        }
        return out


# --- routines ------------------------------------------------------------------

class RoutineIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    dance: str
    syllabus: str = "istd"         # "istd" (Bronze/Silver/Gold) or "bdc" (one "Restricted" list)
    level: str = "Bronze"
    items: list[dict] = []
    partner_id: int | None = None
    my_role: str = "lead"          # which part the creator dances


class RoutinePatch(BaseModel):
    base_rev: int
    name: str | None = Field(None, max_length=120)
    syllabus: str | None = None
    level: str | None = None
    brief: str | None = Field(None, max_length=2000)
    items: list[dict] | None = None
    partner_id: int | None = None
    my_role: str | None = None     # set together with partner_id to change who dances which part


def _parts(con, me: int, partner_id: int | None, my_role: str) -> tuple:
    if my_role not in ("lead", "follow"):
        raise HTTPException(400, "Choose whether you lead or follow in this routine")
    if partner_id is not None:
        if partner_id == me or not con.execute("SELECT 1 FROM users WHERE id = ?", (partner_id,)).fetchone():
            raise HTTPException(400, "Pick your partner from the members list")
    return (me, partner_id) if my_role == "lead" else (partner_id, me)


def _check_level(sid: str, level: str | None) -> str:
    """The level to store for a routine in syllabus `sid`: BDC has the one "Restricted" list."""
    syl = syllabus.syllabus(sid)
    if not syl:
        raise HTTPException(400, "Unknown syllabus")
    if level not in syl["levels"]:
        if len(syl["levels"]) == 1 or level is None:
            return syl["levels"][0]
        raise HTTPException(400, "Unknown level")
    return level


@app.post("/api/routines")
def create_routine(body: RoutineIn, u: dict = Member):
    if not syllabus.dance(body.dance):
        raise HTTPException(400, "Unknown dance")
    level = _check_level(body.syllabus, body.level)
    items, t, new_id = clean_items(body.items), db.now(), rid()
    with db.tx() as con:
        lead, follow = _parts(con, u["id"], body.partner_id, body.my_role)
        con.execute("INSERT INTO routines (id,name,dance,syllabus,level,items,rev,created_by,updated_by,created_at,updated_at,"
                    "owner_id,lead_id,follow_id) VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,?)",
                    (new_id, body.name.strip(), body.dance, body.syllabus, level, json.dumps(items), u["id"], u["id"], t, t,
                     u["id"], lead, follow))
        con.execute("INSERT INTO routine_versions VALUES (?,?,?,?,?,?)", (new_id, 1, json.dumps(items), level, u["id"], t))
    return {"id": new_id}


@app.patch("/api/routines/{routine_id}")
def patch_routine(routine_id: str, body: RoutinePatch, u: dict = Member):
    with db.tx() as con:
        r = load_routine(con, routine_id, u, edit=True)
        sid = body.syllabus or r["syllabus"]
        level = _check_level(sid, body.level or (r["level"] if sid == r["syllabus"] else None))
        content_change = body.items is not None or level != r["level"] or sid != r["syllabus"]
        if content_change and body.base_rev != r["rev"]:
            raise HTTPException(409, "Your partner changed this routine a moment ago. It's been reloaded, so make your change again")
        lead, follow = r["lead_id"], r["follow_id"]
        if body.my_role is not None:
            lead, follow = _parts(con, u["id"], body.partner_id, body.my_role)
        new = {"name": (body.name or r["name"]).strip() or "Untitled routine", "level": level,
               "brief": r["brief"] if body.brief is None else body.brief,
               "items": clean_items(body.items) if body.items is not None else r["items"]}
        rev = r["rev"] + 1 if content_change else r["rev"]
        t = db.now()
        con.execute("UPDATE routines SET name=?, syllabus=?, level=?, brief=?, items=?, rev=?, updated_by=?, updated_at=?,"
                    " lead_id=?, follow_id=? WHERE id=?",
                    (new["name"], sid, new["level"], new["brief"], json.dumps(new["items"]), rev, u["id"], t, lead, follow, routine_id))
        if content_change:
            con.execute("INSERT OR REPLACE INTO routine_versions VALUES (?,?,?,?,?,?)",
                        (routine_id, rev, json.dumps(new["items"]), new["level"], u["id"], t))
    return {"rev": rev}


@app.get("/api/routines/{routine_id}")
def get_routine(routine_id: str, u: dict = Member):
    with db.tx() as con:
        return load_routine(con, routine_id, u)


@app.delete("/api/routines/{routine_id}")
def delete_routine(routine_id: str, u: dict = Member):
    with db.tx() as con:
        r = load_routine(con, routine_id, u, edit=True)
        if r["owner_id"] not in (u["id"], None) and u["role"] != "admin":
            raise HTTPException(403, "Only the person who made this routine can delete it")
        con.execute("DELETE FROM routines WHERE id = ?", (routine_id,))
    return {"ok": True}


@app.get("/api/routines/{routine_id}/versions/{rev}")
def routine_version(routine_id: str, rev: int, u: dict = Member):
    with db.tx() as con:
        load_routine(con, routine_id, u)
        row = con.execute("SELECT * FROM routine_versions WHERE routine_id=? AND rev=?", (routine_id, rev)).fetchone()
    if not row:
        raise HTTPException(404, "No such version")
    return dict(row) | {"items": json.loads(row["items"])}


class Approve(BaseModel):
    rev: int


@app.post("/api/routines/{routine_id}/approve")
def approve(routine_id: str, body: Approve, u: dict = Member):
    with db.tx() as con:
        r = load_routine(con, routine_id, u, edit=True)
        if body.rev != r["rev"]:
            raise HTTPException(409, "The routine changed while you were looking. Check the new version first")
        con.execute("INSERT OR REPLACE INTO approvals VALUES (?,?,?,?)", (routine_id, u["id"], r["rev"], db.now()))
    return {"ok": True}


@app.delete("/api/routines/{routine_id}/approve")
def unapprove(routine_id: str, u: dict = Member):
    with db.tx() as con:
        con.execute("DELETE FROM approvals WHERE routine_id=? AND user_id=?", (routine_id, u["id"]))
    return {"ok": True}


# --- routine assistant (Claude: admin only for now; others use "Request a draft") ---------

@app.get("/api/routines/{routine_id}/chat")
def get_chat(routine_id: str, u: dict = Member):
    with db.tx() as con:
        load_routine(con, routine_id, u)
        rows = con.execute("SELECT * FROM chat WHERE routine_id=? ORDER BY id", (routine_id,)).fetchall()
    return [dict(r) | {"proposal": json.loads(r["proposal"]) if r["proposal"] else None} for r in rows]


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    brief: str | None = Field(None, max_length=2000)   # saved first, so a brief typed just now is used
    draft: bool | None = None                          # True: always answer with a whole routine


@app.post("/api/routines/{routine_id}/chat")
def post_chat(routine_id: str, body: ChatIn, u: dict = Member):
    auth.check_ai(u)
    with db.tx() as con:
        r = load_routine(con, routine_id, u)
        if body.brief is not None and body.brief != r["brief"] and can_edit_routine(r, u):
            con.execute("UPDATE routines SET brief = ? WHERE id = ?", (body.brief, routine_id))
            r["brief"] = body.brief
        con.execute("INSERT INTO chat (routine_id, role, content, user_id, at) VALUES (?,?,?,?,?)",
                    (routine_id, "user", body.message.strip(), u["id"], db.now()))
        names = {x["id"]: x["name"] for x in con.execute("SELECT id, name FROM users")}
        history = [{"role": h["role"], "content": h["content"], "author": names.get(h["user_id"], "Dancer")}
                   for h in con.execute("SELECT * FROM chat WHERE routine_id=? ORDER BY id", (routine_id,))]
        ch = charts(con)
    try:
        out = ai.routine_chat(r, ch, history, who=u["id"], draft=body.draft)
    except ai.Unavailable as e:
        raise HTTPException(503, str(e))
    proposal = match_proposal(r, out.get("proposal"))
    with db.tx() as con:
        con.execute("INSERT INTO chat (routine_id, role, content, proposal, at) VALUES (?,?,?,?,?)",
                    (routine_id, "assistant", out["reply"], json.dumps(proposal) if proposal else None, db.now()))
    return get_chat(routine_id, u)


@app.delete("/api/routines/{routine_id}/chat")
def clear_chat(routine_id: str, u: dict = Member):
    with db.tx() as con:
        load_routine(con, routine_id, u, edit=True)
        con.execute("DELETE FROM chat WHERE routine_id=?", (routine_id,))
    return {"ok": True}


# --- charts (committee edits; Claude drafts are admin only) ---------------------

class ChartIn(BaseModel):
    timing: str = ""
    start: dict
    man: list[dict]
    lady: list[dict]
    pre: list[str] = []
    fol: list[str] = []
    tip: str = ""


@app.put("/api/charts/{fig_id}")
def put_chart(fig_id: str, body: ChartIn, u: dict = Committee):
    fig_or_404(fig_id)
    data = body.model_dump()
    if len(json.dumps(data)) > 200_000:
        raise HTTPException(413, "That chart is too big")
    with db.tx() as con:
        con.execute("INSERT OR REPLACE INTO charts VALUES (?,?,?,?,?)", (fig_id, json.dumps(data), "edited", u["id"], db.now()))
        con.execute("DELETE FROM figure_status WHERE fig_id = ?", (fig_id,))   # an edited chart needs checking again
    return {"ok": True}


@app.delete("/api/charts/{fig_id}")
def reset_chart(fig_id: str, u: dict = Committee):
    with db.tx() as con:
        con.execute("DELETE FROM charts WHERE fig_id = ?", (fig_id,))
        con.execute("DELETE FROM figure_status WHERE fig_id = ?", (fig_id,))
    return {"ok": True}


@app.post("/api/charts/{fig_id}/draft")
def draft_chart(fig_id: str, u: dict = Member):
    auth.check_ai(u)
    f = fig_or_404(fig_id)
    with db.tx() as con:
        existing = charts(con).get(fig_id) or syllabus.STARTER.get(fig_id)
    try:
        chart = ai.draft_chart(syllabus.dance(f["dance"]), f, existing, who=u["id"])
    except ai.Unavailable as e:
        raise HTTPException(503, str(e))
    with db.tx() as con:
        con.execute("INSERT OR REPLACE INTO charts VALUES (?,?,?,?,?)", (fig_id, json.dumps(chart), "ai", u["id"], db.now()))
        con.execute("DELETE FROM figure_status WHERE fig_id = ?", (fig_id,))
    return {"ok": True}


# --- videos --------------------------------------------------------------------

def _check_video_ref(con, ref: str, u: dict):
    """Figure demos and lesson videos are added by the committee; routine videos by that routine's dancers."""
    kind, _, key = ref.partition(":")
    if kind == "fig" and syllabus.figure(key):
        if not auth.is_committee(u):
            raise HTTPException(403, "Demo videos on figures are added by the committee")
        return
    if kind == "lesson" and con.execute("SELECT 1 FROM lessons WHERE id=?", (key,)).fetchone():
        if not auth.is_committee(u):
            raise HTTPException(403, "Lesson videos are added by the committee")
        return
    if kind == "routine":
        load_routine(con, key, u, edit=True)
        return
    raise HTTPException(400, "Unknown figure, lesson or routine")


@app.post("/api/videos")
def add_video(ref: str = Form(...), title: str = Form(""), url: str = Form(""),
              file: UploadFile | None = File(None), u: dict = Member):
    with db.tx() as con:
        _check_video_ref(con, ref, u)
    vid, t = rid(), db.now()
    if file is not None and file.filename:
        if not (file.content_type or "").startswith("video/"):
            raise HTTPException(415, "That isn't a video file. Try an MP4 or MOV")
        ext = Path(file.filename).suffix.lower()[:6] or ".mp4"
        name = f"{vid}{ext}"
        dest = settings.upload_dir / name
        limit, size = settings.max_upload_mb * 1024 * 1024, 0
        with dest.open("wb") as out:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    out.close()
                    dest.unlink(missing_ok=True)
                    raise HTTPException(413, f"Videos can be up to {settings.max_upload_mb} MB")
                out.write(chunk)
        row = (vid, ref, None, name, file.content_type, size, title.strip()[:120] or Path(file.filename).stem[:120], u["id"], t)
    else:
        if not url.lower().startswith(("https://", "http://")):
            raise HTTPException(400, "Paste a full link starting with https://")
        row = (vid, ref, url.strip()[:1000], None, None, None, title.strip()[:120], u["id"], t)
    with db.tx() as con:
        con.execute("INSERT INTO videos VALUES (?,?,?,?,?,?,?,?,?)", row)
    return {"id": vid}


@app.delete("/api/videos/{video_id}")
def delete_video(video_id: str, u: dict = Member):
    with db.tx() as con:
        row = con.execute("SELECT file, created_by FROM videos WHERE id=?", (video_id,)).fetchone()
        if not row:
            return {"ok": True}
        if row["created_by"] != u["id"] and not auth.is_committee(u):
            raise HTTPException(403, "You can only remove videos you added")
        con.execute("DELETE FROM videos WHERE id=?", (video_id,))
    if row["file"]:
        (settings.upload_dir / row["file"]).unlink(missing_ok=True)
    return {"ok": True}


@app.get("/media/{name}")
def media(name: str, u: dict = Member):
    path = (settings.upload_dir / name).resolve()
    if path.parent != settings.upload_dir.resolve() or not path.is_file():
        raise HTTPException(404, "Not found")
    with db.tx() as con:
        v = con.execute("SELECT ref FROM videos WHERE file = ?", (name,)).fetchone()
        if v and v["ref"].startswith("routine:"):
            load_routine(con, v["ref"][8:], u)
    return FileResponse(path)


# --- frontend ------------------------------------------------------------------

app.mount("/static", StaticFiles(directory=FRONTEND), name="static")


@app.get("/{path:path}")
def spa(path: str):
    if path.startswith("api/"):
        raise HTTPException(404, "Not found")
    f = (FRONTEND / path).resolve()
    if path and f.is_file() and f.parent == FRONTEND.resolve() and f.name != "index.html":
        return FileResponse(f)
    html = (FRONTEND / "index.html").read_text().replace("__BASE__", settings.base_path.rstrip("/")) \
        .replace("__ENV__", settings.env_label)
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})
