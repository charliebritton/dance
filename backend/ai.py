"""Claude calls. Every call uses structured JSON output so the app never parses prose."""
import json
import logging

import anthropic

import syllabus
from config import settings

log = logging.getLogger(__name__)


class Unavailable(Exception):
    pass


_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if not settings.anthropic_api_key:
        raise Unavailable("Claude isn't set up yet: add ANTHROPIC_API_KEY to backend/.env")
    if _client is None:
        _client = anthropic.Anthropic(api_key=settings.anthropic_api_key, timeout=180)
    return _client


def _call(system: str, messages: list, schema: dict, max_tokens: int = 16000, effort: str = "medium") -> dict:
    client = _get_client()
    try:
        msg = client.beta.messages.create(
            model=settings.claude_model,
            max_tokens=max_tokens,
            system=system,
            messages=messages,
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.RateLimitError as e:
        raise Unavailable("Claude is busy, try again in a minute") from e
    except anthropic.APIStatusError as e:
        raise Unavailable(f"Claude API error {e.status_code}") from e
    except anthropic.APIConnectionError as e:
        raise Unavailable("Couldn't reach Claude") from e
    if msg.stop_reason == "refusal":
        raise Unavailable("Claude declined this request")
    if msg.stop_reason == "max_tokens":
        raise Unavailable("Claude's answer was cut off")
    text = next((b.text for b in msg.content if b.type == "text"), "")
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise Unavailable("Claude returned malformed JSON") from e


# --- Step charts -------------------------------------------------------------

DIRS = ["fwd", "back", "fwdsmall", "backsmall", "side", "sidefwd", "sideback", "diagfwd", "diagback",
        "close", "tap", "xfront", "xbehind", "fwdcbmp", "backcbmp", "place"]

STEP = {
    "type": "object", "additionalProperties": False,
    "required": ["f", "p", "d", "t", "tt", "fw", "rf", "cbm", "sw", "c", "b", "mv", "al"],
    "properties": {
        "f": {"type": "string", "enum": ["L", "R"]},
        "p": {"type": "string", "description": "Foot position in the book's wording, e.g. 'RF fwd', 'LF to side'"},
        "d": {"type": "string", "enum": DIRS, "description": "Direction relative to the way the body faces"},
        "t": {"type": "integer", "description": "Degrees turned between the previous step and this one; + right, - left"},
        "tt": {"type": "string", "description": "Amount of turn as written, e.g. '¼ between 1–2'"},
        "fw": {"type": "string", "description": "Footwork, e.g. HT, T, TH, BF"},
        "rf": {"type": "string", "description": "Rise and fall as written; empty for Latin"},
        "cbm": {"type": "boolean"},
        "sw": {"type": "string", "enum": ["", "S", "L", "R"]},
        "c": {"type": "string", "description": "Count, e.g. 1, 2, S, Q, &, a"},
        "b": {"type": "number", "description": "Beat value"},
        "mv": {"type": "string", "enum": ["", "LOD", "DW", "DC", "W", "C", "against LOD"],
               "description": "Only for steps travelling in PP: the direction of travel"},
        "al": {"type": "string", "description": "Only for 'Pointing …' alignments, else empty"},
    },
}
CHART_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["timing", "start", "man", "lady", "pre", "fol", "tip"],
    "properties": {
        "timing": {"type": "string"},
        "start": {"type": "object", "additionalProperties": False, "required": ["man", "lady"],
                  "properties": {"man": {"type": "string"}, "lady": {"type": "string"}}},
        "man": {"type": "array", "items": STEP},
        "lady": {"type": "array", "items": STEP},
        "pre": {"type": "array", "items": {"type": "string"}},
        "fol": {"type": "array", "items": {"type": "string"}},
        "tip": {"type": "string"},
    },
}

CHART_SYSTEM = """You are an ISTD examiner writing technique charts for a couple's practice app.
Standard figures follow Alex Moore's "Ballroom Dancing" / "The Ballroom Technique"; Latin figures follow Walter Laird's "Technique of Latin Dancing". Use the book's standard version of the figure with its usual commencing alignment, ISTD terminology and abbreviations (DW, DC, LOD, PP, CBMP, NFR, e/o).

The app draws footprints from each step's foot (f), direction (d) and turn (t), starting from the alignment in start. Room convention: LOD is the direction of travel, wall on the man's right when facing LOD. Write start as e.g. 'F DW', 'B DC', 'F LOD' for Standard, or 'Facing partner' for Latin.
t is the amount turned between the previous step and this one (⅛ = 45, ¼ = 90, ⅜ = 135, ½ = 180), positive to the right. For a pivot on step n, put the turn on step n+1. Use d = "tap" for a step taken without weight. Write fw with the book's abbreviations (HT, TH, T, H, BF, "IE of B, H", WF), not words. Leave rf, sw and mv empty for Latin."""


def draft_chart(dance: dict, fig: dict, existing: dict | None) -> dict:
    prompt = f"Write the chart for the {dance['name']} figure \"{fig['name']}\" ({fig['level']}), for both Man and Lady."
    if existing:
        clean = {k: existing.get(k) for k in ("start", "timing", "man", "lady")}
        prompt += ("\n\nThis is the chart we have now. Check it against the book and correct anything wrong:\n"
                   + json.dumps(clean, ensure_ascii=False))
    out = _call(CHART_SYSTEM, [{"role": "user", "content": prompt}], CHART_SCHEMA, effort="high")
    for side in ("man", "lady"):
        for s in out[side]:
            if not s.get("mv"):
                s.pop("mv", None)
            if not s.get("al"):
                s.pop("al", None)
    if not out["man"] or not out["lady"]:
        raise Unavailable("Claude's chart came back empty, try again")
    return out


# --- Routine assistant -------------------------------------------------------

CHAT_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["reply", "proposal"],
    "properties": {
        "reply": {"type": "string", "description": "Plain text, short paragraphs or numbered lines, no markdown"},
        "proposal": {"anyOf": [{"type": "null"}, {
            "type": "object", "additionalProperties": False, "required": ["mode", "items"],
            "properties": {
                "mode": {"type": "string", "enum": ["replace", "append"]},
                "items": {"type": "array", "items": {
                    "type": "object", "additionalProperties": False, "required": ["kind", "figure", "notes"],
                    "properties": {
                        "kind": {"type": "string", "enum": ["figure", "marker"]},
                        "figure": {"type": "string", "description": "Exact ISTD name, or the marker label (Long side, Short side, Corner)"},
                        "notes": {"type": "string", "description": "Alignment or a short tip; empty for markers"},
                    }}},
            }}]},
    },
}

CHAT_SYSTEM = """You are an experienced ISTD ballroom and Latin teacher helping a couple plan a competition or medal routine. Use ISTD figure names and technique as in Alex Moore's Ballroom Dancing (Standard) or Walter Laird's Technique of Latin Dancing (Latin): precedes and follows, alignments, amount of turn, the line of dance and floor craft.

Both partners share this conversation; messages are labelled with who wrote them. Answer plainly and briefly. Only include a proposal when you are suggesting concrete figures to add or a whole routine, and use figure names exactly as listed so the app can match them. Otherwise set proposal to null."""


def routine_context(r: dict, charts: dict) -> str:
    d = syllabus.dance(r["dance"])
    allowed = syllabus.LEVELS[: syllabus.LEVELS.index(r["level"]) + 1]
    syl = "\n".join(f"{L}: " + "; ".join(d["levels"][L]) for L in allowed)
    lines, n = [], 0
    for it in r["items"]:
        if it.get("type") == "mark":
            lines.append(f"  [{it.get('label')}]")
            continue
        n += 1
        name = syllabus.figure(it.get("fig"))["name"] if syllabus.figure(it.get("fig")) else it.get("name")
        extra = (f" (notes: {it['notes']})" if it.get("notes") else "") + (f" [{it['bars']} bars]" if it.get("bars") else "")
        lines.append(f"  {n}. {name}{extra}")
    chart_lines = []
    for fid in dict.fromkeys(i.get("fig") for i in r["items"] if i.get("fig")):
        c = charts.get(fid) or syllabus.STARTER.get(fid)
        if c:
            chart_lines.append(f"  {syllabus.figure(fid)['name']}: man starts {c['start'].get('man')}, "
                               f"{len(c['man'])} steps, timing {c.get('timing')}")
    return (f"Dance: {d['name']} ({d['style']}, {d['sig']}, {d['tempo'][0]}–{d['tempo'][1]} bars per minute). "
            f"Stay at {r['level']} or below unless asked.\n\nISTD {d['name']} figures allowed:\n{syl}\n\n"
            f"Couple's brief: {r.get('brief') or '(none)'}\n\nCurrent routine (bracketed lines are floor markers):\n"
            + ("\n".join(lines) or "  (empty)")
            + ("\n\nCharts on file:\n" + "\n".join(chart_lines) if chart_lines else ""))


def routine_chat(r: dict, charts: dict, history: list[dict]) -> dict:
    """history: [{role, content, author}] oldest first, ending with the new user message."""
    msgs = []
    for h in history[-16:]:
        content = f"{h['author']}: {h['content']}" if h["role"] == "user" else h["content"]
        if msgs and msgs[-1]["role"] == h["role"]:
            msgs[-1]["content"] += "\n\n" + content
        else:
            msgs.append({"role": h["role"], "content": content})
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    msgs[-1]["content"] = "<routine>\n" + routine_context(r, charts) + "\n</routine>\n\n" + msgs[-1]["content"]
    return _call(CHAT_SYSTEM, msgs, CHAT_SCHEMA, effort="medium")
