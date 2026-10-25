"""Sessions, passwords and who may do what.

Sign-in is by passkey (accounts.py) or password; both end with the same signed session cookie.
Roles: member (everyone who joins), committee (runs lessons, competitions and chart checks), admin (Charlie).
"""
import base64
import hashlib
import hmac
import os
import time

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

import db
from config import settings

COOKIE = "rf_session"
MAX_AGE = 60 * 60 * 24 * 180   # stay signed in for six months
ROLES = ("member", "committee", "admin")


def hash_password(pw: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def check_password(pw: str, stored: str) -> bool:
    try:
        _, salt, dk = stored.split("$")
        got = hashlib.scrypt(pw.encode(), salt=base64.b64decode(salt), n=2**14, r=8, p=1, dklen=32)
        return hmac.compare_digest(got, base64.b64decode(dk))
    except ValueError:
        return False


def _sign(payload: str) -> str:
    return hmac.new(settings.session_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


def make_token(user_id: int) -> str:
    payload = f"{user_id}.{int(time.time())}"
    return payload + "." + _sign(payload)


def read_token(token: str | None) -> int | None:
    if not token or token.count(".") != 2:
        return None
    uid, ts, sig = token.split(".")
    if not hmac.compare_digest(sig, _sign(f"{uid}.{ts}")):
        return None
    if time.time() - int(ts) > MAX_AGE:
        return None
    return int(uid)


def signed_in(uid: int, body: dict | None = None) -> JSONResponse:
    resp = JSONResponse(body or {"ok": True})
    resp.set_cookie(COOKIE, make_token(uid), max_age=MAX_AGE, httponly=True, samesite="lax",
                    secure=settings.secure_cookies, path=settings.base_path or "/")
    return resp


def signed_out() -> JSONResponse:
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE, path=settings.base_path or "/")
    return resp


# ── dependencies ────────────────────────────────────────────────────────────

def viewer(request: Request) -> dict | None:
    """The signed-in person, or None for a visitor (who can still read the syllabus)."""
    uid = read_token(request.cookies.get(COOKIE))
    if uid is None:
        return None
    with db.tx() as con:
        row = con.execute("SELECT id, name, role, dance_role FROM users WHERE id = ?", (uid,)).fetchone()
    return dict(row) if row else None


def member(request: Request) -> dict:
    u = viewer(request)
    if not u:
        raise HTTPException(401, "Sign in to see this")
    return u


def committee(request: Request) -> dict:
    u = member(request)
    if u["role"] not in ("committee", "admin"):
        raise HTTPException(403, "Only the committee or admin can change this")
    return u


def admin(request: Request) -> dict:
    u = member(request)
    if u["role"] != "admin":
        raise HTTPException(403, "Only the site admin can do this")
    return u


def is_committee(u: dict | None) -> bool:
    return bool(u) and u["role"] in ("committee", "admin")


def ai_allowed(u: dict | None) -> bool:
    if not u or not settings.anthropic_api_key:
        return False
    return u["role"] == "admin" or settings.ai_access == "all"


def check_ai(u: dict):
    """Raise unless this person may call Claude now (role, then the per-person daily limit)."""
    if not settings.anthropic_api_key:
        raise HTTPException(503, "Claude isn't set up on this server")
    if not ai_allowed(u):
        raise HTTPException(403, "Claude is switched on for the site admin only for now. Use “Request a draft” instead")
    if u["role"] != "admin":
        since = db.now() - 24 * 3600 * 1000
        with db.tx() as con:
            n = con.execute("SELECT count(*) FROM ai_usage WHERE user_id = ? AND at > ?", (u["id"], since)).fetchone()[0]
        if n >= settings.ai_daily_limit:
            raise HTTPException(429, f"You've used Claude {n} times today, the daily limit. Try again tomorrow")
