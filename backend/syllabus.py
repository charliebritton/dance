"""ISTD figure lists (syllabus.json) and the starter step charts (charts.json)."""
import json
import re
import unicodedata
from pathlib import Path

HERE = Path(__file__).parent
_SYL = json.loads((HERE / "syllabus.json").read_text())
LEVELS: list[str] = _SYL["levels"]
DANCES: list[dict] = _SYL["dances"]
STARTER: dict = json.loads((HERE / "charts.json").read_text())


def slug(s: str) -> str:
    s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


FIGURES: dict[str, dict] = {}
for _d in DANCES:
    for _L in LEVELS:
        for _n in _d["levels"][_L]:
            FIGURES[f"{_d['id']}.{slug(_n)}"] = {"id": f"{_d['id']}.{slug(_n)}", "dance": _d["id"], "name": _n, "level": _L}


def dance(did: str) -> dict | None:
    return next((d for d in DANCES if d["id"] == did), None)


def figure(fid: str | None) -> dict | None:
    return FIGURES.get(fid) if fid else None


def by_name(did: str, name: str) -> dict | None:
    want = slug(name or "")
    return next((f for f in FIGURES.values() if f["dance"] == did and slug(f["name"]) == want), None)
