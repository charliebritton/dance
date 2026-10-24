"""Server admin commands.

  python manage.py invite [--admin | --committee] [--uses N] [--days N] [--label TEXT]
      Make a join link and print it. Charlie's first link is --admin.
  python manage.py seed-competitions [FILE]
      Add competitions from a JSON list (default competitions_seed.json), skipping ones already there by name.
"""
import argparse
import json
import secrets
from pathlib import Path

import db
from common import rid
from config import settings


def invite(args):
    role = "admin" if args.admin else "committee" if args.committee else "member"
    token = secrets.token_urlsafe(18)
    expires = db.now() + args.days * 86400 * 1000 if args.days else None
    with db.tx() as con:
        con.execute("INSERT INTO invites (token, label, role, max_uses, expires_at, created_at) VALUES (?,?,?,?,?,?)",
                    (token, args.label or f"{role} link", role, args.uses, expires, db.now()))
    print(f"{settings.origin}{settings.base_path.rstrip('/')}/join/{token}")


def seed_competitions(args):
    rows = json.loads(Path(args.file).read_text())
    added = 0
    with db.tx() as con:
        have = {r[0].lower() for r in con.execute("SELECT name FROM competitions")}
        for c in rows:
            if c["name"].lower() in have:
                continue
            con.execute("INSERT INTO competitions (id, name, host, start_date, end_date, venue, travel, team_entry, entry_url,"
                        " entry_deadline, notes, confirmed, source, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)",
                        (rid(), c["name"], c.get("host", ""), c.get("start_date"), c.get("end_date"), c.get("venue", ""),
                         c.get("travel", "tbc"), int(c.get("team_entry", False)), c.get("entry_url", ""),
                         c.get("entry_deadline"), c.get("notes", ""), c.get("source", ""), db.now()))
            added += 1
    print(f"added {added} competitions")


if __name__ == "__main__":
    db.init()
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("invite")
    g = i.add_mutually_exclusive_group()
    g.add_argument("--admin", action="store_true")
    g.add_argument("--committee", action="store_true")
    i.add_argument("--uses", type=int)
    i.add_argument("--days", type=int)
    i.add_argument("--label")
    i.set_defaults(fn=invite)
    s = sub.add_parser("seed-competitions")
    s.add_argument("file", nargs="?", default=str(Path(__file__).with_name("competitions_seed.json")))
    s.set_defaults(fn=seed_competitions)
    a = p.parse_args()
    a.fn(a)
