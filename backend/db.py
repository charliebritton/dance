import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from config import settings

SCHEMA = Path(__file__).with_name("schema.sql")

# Columns added after a table first shipped. schema.sql only creates missing tables, so existing databases
# get these with ALTER TABLE on start-up. Never remove an entry; add new ones at the end.
ADDED_COLUMNS = [
    ("users", "role", "TEXT NOT NULL DEFAULT 'member'"),        # member | committee | admin
    ("users", "dance_role", "TEXT NOT NULL DEFAULT 'both'"),    # lead | follow | both
    ("users", "handle", "TEXT"),                                 # WebAuthn user handle, base64url
    ("routines", "owner_id", "INTEGER"),
    ("routines", "lead_id", "INTEGER"),
    ("routines", "follow_id", "INTEGER"),
    ("routines", "syllabus", "TEXT NOT NULL DEFAULT 'istd'"),  # istd | bdc
    ("invites", "user_id", "INTEGER"),                          # a personal link for this (not yet joined) person
]

DEFAULT_GROUPS = ["Beginner", "Novice", "Intermediate", "Advanced", "Team"]


def now() -> int:
    return int(time.time() * 1000)


def connect() -> sqlite3.Connection:
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(settings.db_path, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA journal_mode = WAL")
    return con


@contextmanager
def tx():
    con = connect()
    try:
        yield con
        con.commit()
    finally:
        con.close()


def init():
    with tx() as con:
        con.executescript(SCHEMA.read_text())
        for table, col, decl in ADDED_COLUMNS:
            have = {r["name"] for r in con.execute(f"PRAGMA table_info({table})")}
            if col not in have:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
        if not con.execute("SELECT 1 FROM groups LIMIT 1").fetchone():
            con.executemany("INSERT INTO groups (name, sort) VALUES (?,?)", [(g, i) for i, g in enumerate(DEFAULT_GROUPS)])
        # the old single shared note per figure becomes the first comment on it
        if con.execute("SELECT 1 FROM notes LIMIT 1").fetchone() and not con.execute("SELECT 1 FROM figure_comments LIMIT 1").fetchone():
            con.execute("INSERT INTO figure_comments (fig_id, user_id, text, created_at)"
                        " SELECT fig_id, updated_by, text, updated_at FROM notes WHERE trim(text) <> ''")
        # routines made before accounts belonged to whoever created them
        con.execute("UPDATE routines SET owner_id = created_by WHERE owner_id IS NULL AND created_by IS NOT NULL")
        if not con.execute("SELECT 1 FROM routines LIMIT 1").fetchone():
            seed_example(con)


def seed_example(con):
    """One clearly-labelled example routine so the Routines page isn't empty on first run."""
    items = [
        {"type": "mark", "label": "Long side"},
        {"type": "fig", "fig": "waltz.natural-turn", "name": "Natural Turn", "notes": "Start facing DW"},
        {"type": "fig", "fig": "waltz.rf-closed-change", "name": "RF Closed Change"},
        {"type": "fig", "fig": "waltz.reverse-turn", "name": "Reverse Turn", "notes": "Ends facing DW"},
        {"type": "fig", "fig": "waltz.whisk", "name": "Whisk"},
        {"type": "fig", "fig": "waltz.chasse-from-pp", "name": "Chassé from PP"},
        {"type": "mark", "label": "Corner"},
        {"type": "fig", "fig": "waltz.natural-spin-turn", "name": "Natural Spin Turn",
         "notes": "Turns the corner, ends backing DC of the new LOD"},
        {"type": "mark", "label": "Short side"},
        {"type": "fig", "fig": "waltz.reverse-turn", "name": "Reverse Turn", "notes": "Steps 4–6 only", "bars": 1},
        {"type": "fig", "fig": "waltz.lf-closed-change", "name": "LF Closed Change"},
    ]
    for i, it in enumerate(items):
        it.setdefault("notes", "")
        it.setdefault("bars", None)
        it["k"] = f"e{i}"
    t = now()
    con.execute(
        "INSERT INTO routines (id,name,dance,level,brief,items,rev,example,created_at,updated_at)"
        " VALUES (?,?,?,?,?,?,1,1,?,?)",
        ("example-bronze-waltz", "Example: Bronze Waltz", "waltz", "Bronze",
         "Example routine. Long side, corner, then the start of the short side.",
         json.dumps(items), t, t))
    con.execute("INSERT INTO routine_versions VALUES (?,?,?,?,?,?)",
                ("example-bronze-waltz", 1, json.dumps(items), "Bronze", None, t))
