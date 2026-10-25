"""Claude calls. Every call uses structured JSON output so the app never parses prose."""
import json
import logging
import re

import anthropic

import db
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


def _log_usage(who: int | None, purpose: str, msg):
    """Record tokens and estimated cost per call, so opening Claude to everyone can be priced and capped."""
    try:
        i, o = msg.usage.input_tokens or 0, msg.usage.output_tokens or 0
        cost = i * settings.ai_price_in / 1e6 + o * settings.ai_price_out / 1e6
        with db.tx() as con:
            con.execute("INSERT INTO ai_usage (user_id, purpose, model, input_tokens, output_tokens, cost_usd, at)"
                        " VALUES (?,?,?,?,?,?,?)", (who, purpose, msg.model, i, o, cost, db.now()))
    except Exception:  # usage logging must never break the feature
        log.exception("couldn't log Claude usage")


def _call(system: str, messages: list, schema: dict, max_tokens: int = 16000, effort: str = "medium",
          who: int | None = None, purpose: str = "") -> dict:
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
    _log_usage(who, purpose, msg)
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


def draft_chart(dance: dict, fig: dict, existing: dict | None, who: int | None = None) -> dict:
    where = f"ISTD {fig['level']}" if fig["level"] else "BDC restricted syllabus"
    prompt = f"Write the chart for the {dance['name']} figure \"{fig['name']}\" ({where}), for both Man and Lady."
    if existing:
        clean = {k: existing.get(k) for k in ("start", "timing", "man", "lady")}
        prompt += ("\n\nThis is the chart we have now. Check it against the book and correct anything wrong:\n"
                   + json.dumps(clean, ensure_ascii=False))
    out = _call(CHART_SYSTEM, [{"role": "user", "content": prompt}], CHART_SCHEMA, effort="high",
                who=who, purpose="chart:" + fig["id"])
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

ITEM = {
    "type": "object", "additionalProperties": False, "required": ["kind", "figure", "notes"],
    "properties": {
        "kind": {"type": "string", "enum": ["figure", "marker"]},
        "figure": {"type": "string", "description": "Exact figure name from the list, or the marker label (Long side, Short side, Corner)"},
        "notes": {"type": "string", "description": "Alignment or a short tip; empty for markers"},
    }}
PROPOSAL = {
    "type": "object", "additionalProperties": False, "required": ["mode", "items"],
    "properties": {"mode": {"type": "string", "enum": ["replace", "append"]}, "items": {"type": "array", "items": ITEM}},
}
CHAT_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["reply", "proposal"],
    "properties": {
        "reply": {"type": "string", "description": "Plain text, short paragraphs or numbered lines, no markdown"},
        "proposal": {"anyOf": [{"type": "null"}, PROPOSAL]},
    },
}
# Asked for a routine: the proposal can't be left out.
DRAFT_SCHEMA = {**CHAT_SCHEMA, "properties": {**CHAT_SCHEMA["properties"], "proposal": PROPOSAL}}

CHAT_SYSTEM = """You are an experienced ballroom and Latin teacher helping a couple plan a competition or medal routine. Use the figure names and technique of Alex Moore's Ballroom Dancing / the ISTD Ballroom Technique (Standard) and Walter Laird's Technique of Latin Dancing (Latin): precedes and follows, alignments, amount of turn, the line of dance and floor craft. The routine is either for the ISTD medal syllabus (Bronze, Silver, Gold) or for the BDC restricted syllabus used in beginner and novice competitions under British Dance Council rules; keep to the figures listed for it.

The routine's dancers share this conversation; messages are labelled with who wrote them. Answer plainly and briefly.

When they ask you to draft, write, make, plan or suggest a routine (or "a routine" in any words), write the whole routine straight away as a proposal with mode "replace": don't ask for a brief or more details first. Use their brief if there is one; otherwise assume a typical competition floor, starting on a long side (Standard: facing DW; Latin: in closed hold facing partner), and give one long side, a Corner marker and the short side (Standard), or about 32 to 48 bars of figures that flow into each other (Latin). Mark the floor with Long side, Short side and Corner markers for Standard. Every figure must precede and follow its neighbours correctly at the alignments given. Say in one or two sentences what you assumed, then you may ask one question to refine it.

Include a proposal whenever you suggest concrete figures to add; use the figure names exactly as listed so the app can match them. Otherwise set proposal to null."""

DRAFT_ASK = re.compile(r"\b(draft|write|make|plan|build|create|design|choreograph|put together|come up with|give me|suggest|new)\b.{0,40}\broutine\b"
                       r"|\broutine\b.{0,20}\b(please|for (me|us))\b", re.I | re.S)


def wants_routine(text: str) -> bool:
    return bool(DRAFT_ASK.search(text or ""))


def routine_context(r: dict, charts: dict) -> str:
    d = syllabus.dance(r["dance"])
    sid = r.get("syllabus") or "istd"
    syl = syllabus.syllabus(sid)
    lists = syllabus.allowed(d, sid, r["level"])
    figs = "\n".join((f"{L}: " if sid == "istd" else "") + "; ".join(names) for L, names in lists.items())
    scope = (f"ISTD medal syllabus. Stay at {r['level']} or below unless asked." if sid == "istd" else
             f"{syl['full']} ({syl['source']}): only these figures, danced as charted (alignments, amounts of turn, "
             "commencing and ending positions); no parts of figures unless the technique books allow it.")
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
    return (f"Dance: {d['name']} ({d['style']}, {d['sig']}, {d['tempo'][0]}–{d['tempo'][1]} bars per minute). {scope}\n\n"
            f"{syl['name']} {d['name']} figures allowed:\n{figs}\n\n"
            f"Couple's brief: {r.get('brief') or '(none)'}\n\nCurrent routine (bracketed lines are floor markers):\n"
            + ("\n".join(lines) or "  (empty)")
            + ("\n\nCharts on file:\n" + "\n".join(chart_lines) if chart_lines else ""))


def routine_chat(r: dict, charts: dict, history: list[dict], who: int | None = None, draft: bool | None = None) -> dict:
    """history: [{role, content, author}] oldest first, ending with the new user message.
    draft: the new message asks for a whole routine (None = decide from its wording), so a proposal is required."""
    if draft is None:
        draft = wants_routine(history[-1]["content"])
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
    if draft:
        msgs[-1]["content"] += "\n\n(Write the complete routine now as a proposal with mode \"replace\".)"
    out = _call(CHAT_SYSTEM, msgs, DRAFT_SCHEMA if draft else CHAT_SCHEMA, effort="high" if draft else "medium",
                who=who, purpose="routine:" + r["id"])
    if draft and not (out.get("proposal") or {}).get("items"):
        raise Unavailable("Claude didn't come back with a routine, try again")
    return out


# --- Lesson notes from a recording's transcript -------------------------------

NOTES_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["summary", "figures", "technique", "timing", "homework"],
    "properties": {
        "summary": {"type": "string", "description": "One or two sentences on what the lesson covered"},
        "figures": {"type": "array", "items": {"type": "string"}, "description": "Figures taught or practised, exact names from the list"},
        "technique": {"type": "array", "items": {"type": "string"}, "description": "Corrections and technique points, one per item"},
        "timing": {"type": "array", "items": {"type": "string"}, "description": "Counts, timing and musicality points"},
        "homework": {"type": "array", "items": {"type": "string"}, "description": "What to practise before next time"},
    },
}

NOTES_SYSTEM = """You turn the transcript of a ballroom or Latin dance lesson into short notes for the dancers who were there.
The transcript was made automatically from a phone or watch in a hall with music playing, so expect misheard words (for example "chase" for Chassé, "contra body" for CBM), counting along with the music, and other people's chatter.

Pull out:
- the figures taught or practised, using the exact names from the figure list given;
- corrections and technique points (footwork, rise and fall, CBM, sway, frame, hold, Leader's and Follower's parts), each as one short instruction;
- counts and timing;
- homework: what to practise before the next lesson.

Write in plain British English, briefly. Keep only what is about the dancing: leave out names other than the teacher's, and anything personal or private someone said. Don't invent points that aren't in the transcript."""


def lesson_notes(transcript: str, context: str, who: int | None = None, purpose: str = "lesson-notes") -> dict:
    prompt = "<lesson>\n" + context + "\n</lesson>\n\n<transcript>\n" + transcript[-200000:] + "\n</transcript>"
    return _call(NOTES_SYSTEM, [{"role": "user", "content": prompt}], NOTES_SCHEMA, max_tokens=8000, effort="low",
                 who=who, purpose=purpose)
