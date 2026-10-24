"""Rise & Fall API. All routes under /api; everything else serves the single-page frontend."""
import json
import logging
import secrets
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import ai
import auth
import db
import syllabus
from config import ROOT, settings

logging.basicConfig(level=logging.INFO)
FRONTEND = ROOT / "frontend"
app = FastAPI(title="Rise & Fall", docs_url=None, redoc_url=None)
db.init()
settings.upload_dir.mkdir(parents=True, exist_ok=True)

User = Depends(auth.current_user)
Viewer = Depends(auth.viewer)
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


@app.middleware("http")
async def revalidate_frontend(request: Request, call_next):
    """Make browsers check for a newer app on every load (cheap: unchanged files come back 304)."""
    path = request.url.path[len(request.scope.get("root_path", "")):] if request.scope.get("root_path") else request.url.path
    if settings.read_only and request.method in WRITE_METHODS and path.startswith("/api/"):
        return JSONResponse({"detail": "This is a read-only preview, so changes can't be saved"}, status_code=403)
    resp = await call_next(request)
    if not path.startswith(("/api/", "/media/")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


def rid() -> str:
    return secrets.token_urlsafe(8).replace("-", "x").replace("_", "y")


# --- accounts ----------------------------------------------------------------

class Creds(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=6, max_length=200)
    invite: str = ""


def _login_response(uid: int) -> Response:
    resp = JSONResponse({"ok": True})
    resp.set_cookie(auth.COOKIE, auth.make_token(uid), max_age=auth.MAX_AGE, httponly=True,
                    samesite="lax", secure=settings.secure_cookies, path=settings.base_path or "/")
    return resp


@app.post("/api/signup")
def signup(c: Creds):
    if settings.read_only:
        raise HTTPException(403, "Accounts are switched off in the preview")
    if not secrets.compare_digest(c.invite.strip(), settings.invite_code):
        raise HTTPException(403, "That invite code isn't right")
    with db.tx() as con:
        if con.execute("SELECT 1 FROM users WHERE name = ?", (c.name.strip(),)).fetchone():
            raise HTTPException(409, "That name is taken. Sign in instead")
        cur = con.execute("INSERT INTO users (name, pw_hash, created_at) VALUES (?,?,?)",
                          (c.name.strip(), auth.hash_password(c.password), db.now()))
        return _login_response(cur.lastrowid)


@app.post("/api/login")
def login(c: Creds):
    if settings.read_only:
        raise HTTPException(403, "Accounts are switched off in the preview")
    with db.tx() as con:
        row = con.execute("SELECT id, pw_hash FROM users WHERE name = ?", (c.name.strip(),)).fetchone()
    if not row or not auth.check_password(c.password, row["pw_hash"]):
        raise HTTPException(401, "Name or password doesn't match")
    return _login_response(row["id"])


@app.post("/api/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE, path=settings.base_path or "/")
    return resp


@app.get("/api/me")
def me(uid: int | None = Viewer):
    if settings.read_only:
        return {"id": None, "name": None, "ai": False, "readonly": True}
    with db.tx() as con:
        row = con.execute("SELECT id, name FROM users WHERE id = ?", (uid,)).fetchone()
    if not row:
        raise HTTPException(401, "Sign in first")
    return dict(row) | {"ai": bool(settings.anthropic_api_key)}


# --- syllabus + shared state ---------------------------------------------------

@app.get("/api/syllabus")
def get_syllabus():
    return {"levels": syllabus.LEVELS, "dances": syllabus.DANCES, "charts": syllabus.STARTER}


def _routine(row) -> dict:
    r = dict(row)
    r["items"] = json.loads(r["items"])
    r["example"] = bool(r["example"])
    return r


def _charts(con) -> dict:
    return {r["fig_id"]: json.loads(r["data"]) | {"src": r["src"], "updated_by": r["updated_by"],
                                                  "updated_at": r["updated_at"]}
            for r in con.execute("SELECT * FROM charts")}


@app.get("/api/state")
def state(uid: int | None = Viewer):
    """Everything the app shows, in one go. The frontend polls this to pick up a partner's changes."""
    with db.tx() as con:
        routines = [_routine(r) for r in con.execute("SELECT * FROM routines ORDER BY updated_at DESC")]
        approvals = {}
        for a in con.execute("SELECT * FROM approvals"):
            approvals.setdefault(a["routine_id"], {})[a["user_id"]] = a["rev"]
        for r in routines:
            r["approvals"] = approvals.get(r["id"], {})
        return {
            "users": [dict(u) for u in con.execute("SELECT id, name FROM users ORDER BY id")],
            "routines": routines,
            "charts": _charts(con),
            "notes": {n["fig_id"]: dict(n) for n in con.execute("SELECT * FROM notes")},
            "videos": [dict(v) for v in con.execute("SELECT * FROM videos ORDER BY created_at")],
        }


# --- routines ------------------------------------------------------------------

class RoutineIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    dance: str
    level: str = "Bronze"
    items: list[dict] = []


class RoutinePatch(BaseModel):
    base_rev: int
    name: str | None = Field(None, max_length=120)
    level: str | None = None
    brief: str | None = Field(None, max_length=2000)
    items: list[dict] | None = None


def _clean_items(items: list[dict]) -> list[dict]:
    out = []
    for it in items[:200]:
        if it.get("type") == "mark":
            out.append({"k": str(it.get("k") or rid())[:20], "type": "mark", "label": str(it.get("label", ""))[:40]})
        else:
            f = syllabus.figure(it.get("fig"))
            bars = it.get("bars")
            out.append({"k": str(it.get("k") or rid())[:20], "type": "fig", "fig": f["id"] if f else None,
                        "name": f["name"] if f else str(it.get("name", ""))[:80],
                        "notes": str(it.get("notes") or "")[:300],
                        "bars": float(bars) if isinstance(bars, (int, float)) and bars > 0 else None})
    return out


def _load_routine(con, routine_id: str) -> dict:
    row = con.execute("SELECT * FROM routines WHERE id = ?", (routine_id,)).fetchone()
    if not row:
        raise HTTPException(404, "That routine has been deleted")
    return _routine(row)


@app.post("/api/routines")
def create_routine(body: RoutineIn, uid: int = User):
    if not syllabus.dance(body.dance) or body.level not in syllabus.LEVELS:
        raise HTTPException(400, "Unknown dance or level")
    items, t, new_id = _clean_items(body.items), db.now(), rid()
    with db.tx() as con:
        con.execute("INSERT INTO routines (id,name,dance,level,items,rev,created_by,updated_by,created_at,updated_at)"
                    " VALUES (?,?,?,?,?,1,?,?,?,?)",
                    (new_id, body.name.strip(), body.dance, body.level, json.dumps(items), uid, uid, t, t))
        con.execute("INSERT INTO routine_versions VALUES (?,?,?,?,?,?)",
                    (new_id, 1, json.dumps(items), body.level, uid, t))
    return {"id": new_id}


@app.patch("/api/routines/{routine_id}")
def patch_routine(routine_id: str, body: RoutinePatch, uid: int = User):
    with db.tx() as con:
        r = _load_routine(con, routine_id)
        content_change = body.items is not None or (body.level is not None and body.level != r["level"])
        if content_change and body.base_rev != r["rev"]:
            raise HTTPException(409, "Your partner changed this routine a moment ago. It's been reloaded, so make your change again")
        if body.level is not None and body.level not in syllabus.LEVELS:
            raise HTTPException(400, "Unknown level")
        new = {"name": (body.name or r["name"]).strip() or "Untitled routine", "level": body.level or r["level"],
               "brief": r["brief"] if body.brief is None else body.brief,
               "items": _clean_items(body.items) if body.items is not None else r["items"]}
        rev = r["rev"] + 1 if content_change else r["rev"]
        t = db.now()
        con.execute("UPDATE routines SET name=?, level=?, brief=?, items=?, rev=?, updated_by=?, updated_at=? WHERE id=?",
                    (new["name"], new["level"], new["brief"], json.dumps(new["items"]), rev, uid, t, routine_id))
        if content_change:
            con.execute("INSERT OR REPLACE INTO routine_versions VALUES (?,?,?,?,?,?)",
                        (routine_id, rev, json.dumps(new["items"]), new["level"], uid, t))
    return {"rev": rev}


@app.delete("/api/routines/{routine_id}")
def delete_routine(routine_id: str, uid: int = User):
    with db.tx() as con:
        con.execute("DELETE FROM routines WHERE id = ?", (routine_id,))
    return {"ok": True}


@app.get("/api/routines/{routine_id}/versions/{rev}")
def routine_version(routine_id: str, rev: int, uid: int | None = Viewer):
    with db.tx() as con:
        row = con.execute("SELECT * FROM routine_versions WHERE routine_id=? AND rev=?", (routine_id, rev)).fetchone()
    if not row:
        raise HTTPException(404, "No such version")
    return dict(row) | {"items": json.loads(row["items"])}


class Approve(BaseModel):
    rev: int


@app.post("/api/routines/{routine_id}/approve")
def approve(routine_id: str, body: Approve, uid: int = User):
    with db.tx() as con:
        r = _load_routine(con, routine_id)
        if body.rev != r["rev"]:
            raise HTTPException(409, "The routine changed while you were looking. Check the new version first")
        con.execute("INSERT OR REPLACE INTO approvals VALUES (?,?,?,?)", (routine_id, uid, r["rev"], db.now()))
    return {"ok": True}


@app.delete("/api/routines/{routine_id}/approve")
def unapprove(routine_id: str, uid: int = User):
    with db.tx() as con:
        con.execute("DELETE FROM approvals WHERE routine_id=? AND user_id=?", (routine_id, uid))
    return {"ok": True}


# --- routine assistant ---------------------------------------------------------

@app.get("/api/routines/{routine_id}/chat")
def get_chat(routine_id: str, uid: int | None = Viewer):
    with db.tx() as con:
        rows = con.execute("SELECT * FROM chat WHERE routine_id=? ORDER BY id", (routine_id,)).fetchall()
    return [dict(r) | {"proposal": json.loads(r["proposal"]) if r["proposal"] else None} for r in rows]


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


@app.post("/api/routines/{routine_id}/chat")
def post_chat(routine_id: str, body: ChatIn, uid: int = User):
    with db.tx() as con:
        r = _load_routine(con, routine_id)
        con.execute("INSERT INTO chat (routine_id, role, content, user_id, at) VALUES (?,?,?,?,?)",
                    (routine_id, "user", body.message.strip(), uid, db.now()))
        names = {u["id"]: u["name"] for u in con.execute("SELECT id, name FROM users")}
        history = [{"role": h["role"], "content": h["content"], "author": names.get(h["user_id"], "Partner")}
                   for h in con.execute("SELECT * FROM chat WHERE routine_id=? ORDER BY id", (routine_id,))]
        charts = _charts(con)
    try:
        out = ai.routine_chat(r, charts, history)
    except ai.Unavailable as e:
        raise HTTPException(503, str(e))
    proposal = out.get("proposal")
    if proposal:
        for it in proposal["items"]:
            if it["kind"] == "figure":
                f = syllabus.by_name(r["dance"], it["figure"])
                it["fig"] = f["id"] if f else None
    with db.tx() as con:
        con.execute("INSERT INTO chat (routine_id, role, content, proposal, at) VALUES (?,?,?,?,?)",
                    (routine_id, "assistant", out["reply"], json.dumps(proposal) if proposal else None, db.now()))
    return get_chat(routine_id, uid)


@app.delete("/api/routines/{routine_id}/chat")
def clear_chat(routine_id: str, uid: int = User):
    with db.tx() as con:
        con.execute("DELETE FROM chat WHERE routine_id=?", (routine_id,))
    return {"ok": True}


# --- charts + notes -------------------------------------------------------------

def _fig_or_404(fig_id: str) -> dict:
    f = syllabus.figure(fig_id)
    if not f:
        raise HTTPException(404, "Unknown figure")
    return f


class ChartIn(BaseModel):
    timing: str = ""
    start: dict
    man: list[dict]
    lady: list[dict]
    pre: list[str] = []
    fol: list[str] = []
    tip: str = ""


@app.put("/api/charts/{fig_id}")
def put_chart(fig_id: str, body: ChartIn, uid: int = User):
    _fig_or_404(fig_id)
    data = body.model_dump()
    if len(json.dumps(data)) > 200_000:
        raise HTTPException(413, "That chart is too big")
    with db.tx() as con:
        con.execute("INSERT OR REPLACE INTO charts VALUES (?,?,?,?,?)", (fig_id, json.dumps(data), "edited", uid, db.now()))
    return {"ok": True}


@app.delete("/api/charts/{fig_id}")
def reset_chart(fig_id: str, uid: int = User):
    with db.tx() as con:
        con.execute("DELETE FROM charts WHERE fig_id = ?", (fig_id,))
    return {"ok": True}


@app.post("/api/charts/{fig_id}/draft")
def draft_chart(fig_id: str, uid: int = User):
    f = _fig_or_404(fig_id)
    with db.tx() as con:
        existing = _charts(con).get(fig_id) or syllabus.STARTER.get(fig_id)
    try:
        chart = ai.draft_chart(syllabus.dance(f["dance"]), f, existing)
    except ai.Unavailable as e:
        raise HTTPException(503, str(e))
    with db.tx() as con:
        con.execute("INSERT OR REPLACE INTO charts VALUES (?,?,?,?,?)", (fig_id, json.dumps(chart), "ai", uid, db.now()))
    return {"ok": True}


class NoteIn(BaseModel):
    text: str = Field(max_length=8000)


@app.put("/api/notes/{fig_id}")
def put_note(fig_id: str, body: NoteIn, uid: int = User):
    _fig_or_404(fig_id)
    with db.tx() as con:
        con.execute("INSERT OR REPLACE INTO notes VALUES (?,?,?,?)", (fig_id, body.text, uid, db.now()))
    return {"ok": True}


# --- videos --------------------------------------------------------------------

def _check_ref(ref: str):
    kind, _, key = ref.partition(":")
    if kind == "fig" and syllabus.figure(key):
        return
    if kind == "routine":
        with db.tx() as con:
            if con.execute("SELECT 1 FROM routines WHERE id=?", (key,)).fetchone():
                return
    raise HTTPException(400, "Unknown figure or routine")


@app.post("/api/videos")
def add_video(ref: str = Form(...), title: str = Form(""), url: str = Form(""),
              file: UploadFile | None = File(None), uid: int = User):
    _check_ref(ref)
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
        row = (vid, ref, None, name, file.content_type, size, title.strip()[:120] or Path(file.filename).stem[:120], uid, t)
    else:
        if not url.lower().startswith(("https://", "http://")):
            raise HTTPException(400, "Paste a full link starting with https://")
        row = (vid, ref, url.strip()[:1000], None, None, None, title.strip()[:120], uid, t)
    with db.tx() as con:
        con.execute("INSERT INTO videos VALUES (?,?,?,?,?,?,?,?,?)", row)
    return {"id": vid}


@app.delete("/api/videos/{video_id}")
def delete_video(video_id: str, uid: int = User):
    with db.tx() as con:
        row = con.execute("SELECT file FROM videos WHERE id=?", (video_id,)).fetchone()
        con.execute("DELETE FROM videos WHERE id=?", (video_id,))
    if row and row["file"]:
        (settings.upload_dir / row["file"]).unlink(missing_ok=True)
    return {"ok": True}


@app.get("/media/{name}")
def media(name: str, uid: int | None = Viewer):
    path = (settings.upload_dir / name).resolve()
    if path.parent != settings.upload_dir.resolve() or not path.is_file():
        raise HTTPException(404, "Not found")
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
    html = (FRONTEND / "index.html").read_text().replace("__BASE__", settings.base_path.rstrip("/"))
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})
