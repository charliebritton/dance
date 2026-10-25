"""Pre-rendered 3D videos of each figure. A render worker (render/worker.mjs, run on a machine with a GPU) asks
which figures need a video, films them and uploads the MP4s. A video belongs to one version of a chart and of the
rig: when the chart is edited, or the rig in frontend/dancers3d.js changes, the figure goes back on the job list and
its page shows the live 3D view until a fresh video arrives."""
import hashlib
import json
import re
import secrets

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

import auth
import db
import syllabus
from common import charts
from config import ROOT, settings

router = APIRouter()
_rig = ROOT / "frontend" / "dancers3d.js"
RIG = (re.search(r'export const RIG = "(\w+)"', _rig.read_text()) or [None, "0"])[1] if _rig.exists() else "0"
TEMPO = {d["id"]: d["tempo"] for d in syllabus.DANCES}
FIG_ID = re.compile(r"^[a-z0-9-]+\.[a-z0-9-]+$")


def folder():
    d = settings.upload_dir / "renders"
    d.mkdir(parents=True, exist_ok=True)
    return d


def current(con) -> dict:
    """The chart each figure is danced from: the committee's edit if there is one, else the starter chart."""
    return syllabus.STARTER | charts(con)


def chart_hash(fid: str, c: dict | None) -> str:
    """Everything a video depends on: the steps, the dance's tempo and the rig that films them."""
    keys = {k: (c or {}).get(k) for k in ("start", "timing", "man", "lady")}
    raw = json.dumps([keys, TEMPO.get(fid.split(".")[0]), RIG], sort_keys=True)
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def public(con) -> dict:
    """Videos that still match their chart, for the figure pages."""
    rows = list(con.execute("SELECT * FROM renders"))
    if not rows:
        return {}
    cs = current(con)
    return {r["fig_id"]: {"url": f"/media/renders/{r['file']}", "fps": r["fps"], "bpm": r["bpm"], "lead": r["lead"],
                          "tail": r["tail"]}
            for r in rows if r["hash"] == chart_hash(r["fig_id"], cs.get(r["fig_id"]))}


def worker(request: Request) -> dict:
    """The render worker's token (RENDER_TOKEN), or the admin signed in."""
    given = request.headers.get("authorization", "")
    if settings.render_token and secrets.compare_digest(given.encode(), f"Bearer {settings.render_token}".encode()):
        return {"worker": True}
    u = auth.viewer(request)
    if u and u["role"] == "admin":
        return u
    raise HTTPException(401, "Rendering needs the worker token (RENDER_TOKEN) or the admin signed in")


Worker = Depends(worker)


@router.get("/api/render/jobs")
def jobs(all: bool = False, _: dict = Worker):
    """Figures whose video is missing or out of date (all=1: every charted figure)."""
    with db.tx() as con:
        have = {r["fig_id"]: r["hash"] for r in con.execute("SELECT fig_id, hash FROM renders")}
        cs = current(con)
    out = []
    for fid, c in cs.items():
        f = syllabus.figure(fid)
        if not f or not c.get("man"):
            continue
        h = chart_hash(fid, c)
        if all or have.get(fid) != h:
            out.append({"fig": fid, "hash": h, "name": f["name"], "dance": f["dance"]})
    return {"jobs": out, "rig": RIG}


@router.put("/api/render/{fid}")
def upload(fid: str, file: UploadFile = File(...), hash: str = Form(...), fps: float = Form(...), bpm: float = Form(...),
           lead: float = Form(1), tail: float = Form(1), size: int = Form(0), _: dict = Worker):
    if not FIG_ID.match(fid) or not syllabus.figure(fid):
        raise HTTPException(404, "No such figure")
    with db.tx() as con:
        want = chart_hash(fid, current(con).get(fid))
    if hash != want:
        raise HTTPException(409, "The chart (or the rig) changed while this was rendering. Render it again")
    if (file.content_type or "") != "video/mp4":
        raise HTTPException(415, "Upload an MP4")
    name = f"{fid}.{hash}.mp4"
    dest, limit, n = folder() / name, settings.max_upload_mb * 1024 * 1024, 0
    with dest.open("wb") as out:
        while chunk := file.file.read(1024 * 1024):
            n += len(chunk)
            if n > limit:
                out.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"Videos can be up to {settings.max_upload_mb} MB")
            out.write(chunk)
    with db.tx() as con:
        old = con.execute("SELECT file FROM renders WHERE fig_id=?", (fid,)).fetchone()
        con.execute("INSERT OR REPLACE INTO renders VALUES (?,?,?,?,?,?,?,?,?)",
                    (fid, hash, name, fps, bpm, lead, tail, size or None, db.now()))
    if old and old["file"] != name:
        (folder() / old["file"]).unlink(missing_ok=True)
    return {"ok": True, "url": f"/media/renders/{name}"}


@router.get("/media/renders/{name}")
def video(name: str):
    path = (folder() / name).resolve()
    if path.parent != folder().resolve() or not path.is_file():
        raise HTTPException(404, "Not found")
    # each file name carries its chart version, so browsers can keep it for good
    return FileResponse(path, media_type="video/mp4", headers={"Cache-Control": "public, max-age=31536000, immutable"})
