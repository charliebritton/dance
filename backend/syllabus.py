"""Figure lists (syllabus.json: ISTD medal levels plus the BDC restricted syllabus) and the starter step charts (charts.json).

A figure is one id per dance and name, so a figure in both syllabi shares its chart, comments and videos. Its `level` is
the ISTD medal level (None for BDC-only figures) and `bdc` says whether the BDC restricted syllabus lists it.
"""
import json
import re
import unicodedata
from pathlib import Path

HERE = Path(__file__).parent
_SYL = json.loads((HERE / "syllabus.json").read_text())
LEVELS: list[str] = _SYL["levels"]
SYLLABI: list[dict] = _SYL["syllabi"]
DANCES: list[dict] = _SYL["dances"]
STARTER: dict = json.loads((HERE / "charts.json").read_text())


def slug(s: str) -> str:
    s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


FIGURES: dict[str, dict] = {}
for _d in DANCES:
    for _L in LEVELS:
        for _n in _d["levels"][_L]:
            FIGURES[f"{_d['id']}.{slug(_n)}"] = {"id": f"{_d['id']}.{slug(_n)}", "dance": _d["id"], "name": _n, "level": _L,
                                                 "bdc": False}
    for _n in _d["bdc"]:
        FIGURES.setdefault(f"{_d['id']}.{slug(_n)}", {"id": f"{_d['id']}.{slug(_n)}", "dance": _d["id"], "name": _n,
                                                      "level": None})["bdc"] = True


def dance(did: str) -> dict | None:
    return next((d for d in DANCES if d["id"] == did), None)


def syllabus(sid: str) -> dict | None:
    return next((s for s in SYLLABI if s["id"] == sid), None)


def lists(d: dict, sid: str) -> dict[str, list[str]]:
    """{level: figure names} for a dance in one syllabus."""
    return d["levels"] if sid == "istd" else {"Restricted": d["bdc"]}


def allowed(d: dict, sid: str, level: str) -> dict[str, list[str]]:
    """The levels a routine at `level` may draw on, each with its figure names."""
    ls = lists(d, sid)
    names = list(ls)
    return {L: ls[L] for L in names[: names.index(level) + 1]} if level in ls else ls


def figure(fid: str | None) -> dict | None:
    return FIGURES.get(fid) if fid else None


def by_name(did: str, name: str) -> dict | None:
    want = slug(name or "")
    return next((f for f in FIGURES.values() if f["dance"] == did and slug(f["name"]) == want), None)
