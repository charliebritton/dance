"""Helpers shared by the route modules."""
import json
import secrets

from fastapi import HTTPException

import syllabus


def rid() -> str:
    return secrets.token_urlsafe(8).replace("-", "x").replace("_", "y")


def routine_row(row) -> dict:
    r = dict(row)
    r["items"] = json.loads(r["items"])
    r["example"] = bool(r["example"])
    return r


def charts(con) -> dict:
    return {r["fig_id"]: json.loads(r["data"]) | {"src": r["src"], "updated_by": r["updated_by"],
                                                  "updated_at": r["updated_at"]}
            for r in con.execute("SELECT * FROM charts")}


def dancers(r: dict) -> set:
    return {x for x in (r.get("owner_id"), r.get("lead_id"), r.get("follow_id")) if x}


def can_see_routine(r: dict, u: dict | None) -> bool:
    """The routine's owner and its two dancers; the admin (to handle draft requests); everyone for the example."""
    if not u:
        return False
    return r["example"] or u["role"] == "admin" or u["id"] in dancers(r)


def can_edit_routine(r: dict, u: dict) -> bool:
    return u["role"] == "admin" if r["example"] else u["id"] in dancers(r) or u["role"] == "admin"


def load_routine(con, routine_id: str, u: dict, edit: bool = False) -> dict:
    row = con.execute("SELECT * FROM routines WHERE id = ?", (routine_id,)).fetchone()
    r = routine_row(row) if row else None
    if not r or not can_see_routine(r, u):
        raise HTTPException(404, "That routine has been deleted or isn't shared with you")
    if edit and not can_edit_routine(r, u):
        raise HTTPException(403, "Only the routine's dancers can change it")
    return r


def clean_items(items: list[dict]) -> list[dict]:
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


def match_proposal(r: dict, proposal: dict | None) -> dict | None:
    """Attach figure ids to Claude's proposed figures by name (None where it named something not in the lists)."""
    for it in (proposal or {}).get("items", []):
        if it["kind"] == "figure":
            f = syllabus.by_name(r["dance"], it["figure"])
            it["fig"] = f["id"] if f else None
    return proposal


def fig_or_404(fig_id: str) -> dict:
    f = syllabus.figure(fig_id)
    if not f:
        raise HTTPException(404, "Unknown figure")
    return f
