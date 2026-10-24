"""Name + password accounts with a signed session cookie. Sign-up needs the shared invite code."""
import base64
import hashlib
import hmac
import os
import time

from fastapi import HTTPException, Request

from config import settings

COOKIE = "rf_session"
MAX_AGE = 60 * 60 * 24 * 180   # stay signed in for six months


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


def viewer(request: Request) -> int | None:
    """For read routes: the signed-in user, or None when the public read-only preview lets anyone look."""
    uid = read_token(request.cookies.get(COOKIE))
    if uid is None and not settings.read_only:
        raise HTTPException(401, "Sign in first")
    return uid


def current_user(request: Request) -> int:
    uid = read_token(request.cookies.get(COOKIE))
    if uid is None:
        raise HTTPException(401, "Sign in first")
    return uid
