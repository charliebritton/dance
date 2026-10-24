"""Joining by invite link, passkey and password sign-in, your account, and the admin page."""
import json
import secrets
import shutil

import webauthn
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.exceptions import InvalidAuthenticationResponse, InvalidRegistrationResponse
from webauthn.helpers.structs import (AuthenticatorSelectionCriteria, PublicKeyCredentialDescriptor,
                                      ResidentKeyRequirement, UserVerificationRequirement)

import auth
import db
from config import settings

router = APIRouter()
Member, Admin, Viewer = Depends(auth.member), Depends(auth.admin), Depends(auth.viewer)
CHALLENGE_MS = 5 * 60 * 1000
DANCE_ROLES = ("lead", "follow", "both")


# ── helpers ─────────────────────────────────────────────────────────────────

def _groups_of(con, uid: int) -> list[int]:
    return [r[0] for r in con.execute("SELECT group_id FROM user_groups WHERE user_id = ? ORDER BY group_id", (uid,))]


def _set_groups(con, uid: int, group_ids: list[int]):
    valid = {r[0] for r in con.execute("SELECT id FROM groups")}
    con.execute("DELETE FROM user_groups WHERE user_id = ?", (uid,))
    con.executemany("INSERT INTO user_groups VALUES (?,?)", [(uid, g) for g in set(group_ids) if g in valid])


def _invite(con, token: str) -> dict:
    row = con.execute("SELECT * FROM invites WHERE token = ?", (token or "",)).fetchone()
    if not row or row["revoked"]:
        raise HTTPException(403, "That join link isn't valid. Ask whoever sent it for a new one")
    if row["expires_at"] and row["expires_at"] < db.now():
        raise HTTPException(403, "That join link has expired. Ask for a new one")
    if row["max_uses"] is not None and row["uses"] >= row["max_uses"]:
        raise HTTPException(403, "That join link has already been used. Ask for a new one")
    return dict(row)


def _clean_name(name: str) -> str:
    name = " ".join((name or "").split())[:40]
    if not name:
        raise HTTPException(400, "Enter your name")
    return name


def _name_free(con, name: str, except_uid: int | None = None):
    row = con.execute("SELECT id FROM users WHERE name = ?", (name,)).fetchone()
    if row and row["id"] != except_uid:
        raise HTTPException(409, "Someone has that name already. Add a surname or initial")


def _create_user(con, inv: dict, d: dict, pw_hash: str = "", handle: str | None = None) -> int:
    cur = con.execute("INSERT INTO users (name, pw_hash, created_at, role, dance_role, handle) VALUES (?,?,?,?,?,?)",
                      (d["name"], pw_hash, db.now(), inv["role"], d["dance_role"], handle))
    uid = cur.lastrowid
    _set_groups(con, uid, d.get("groups") or [])
    con.execute("UPDATE invites SET uses = uses + 1 WHERE token = ?", (inv["token"],))
    return uid


def me_payload(con, u: dict | None) -> dict | None:
    if not u:
        return None
    has_pw = bool(con.execute("SELECT pw_hash FROM users WHERE id = ?", (u["id"],)).fetchone()["pw_hash"])
    n_keys = con.execute("SELECT count(*) FROM passkeys WHERE user_id = ?", (u["id"],)).fetchone()[0]
    return {**u, "groups": _groups_of(con, u["id"]), "ai": auth.ai_allowed(u), "has_password": has_pw,
            "passkeys": n_keys}


# ── who am I ────────────────────────────────────────────────────────────────

@router.get("/api/me")
def me(u: dict | None = Viewer):
    with db.tx() as con:
        return {"me": me_payload(con, u), "groups": [dict(g) for g in con.execute("SELECT * FROM groups ORDER BY sort, name")]}


@router.post("/api/logout")
def logout():
    return auth.signed_out()


@router.get("/api/invites/{token}")
def check_invite(token: str):
    with db.tx() as con:
        inv = _invite(con, token)
        groups = [dict(g) for g in con.execute("SELECT * FROM groups ORDER BY sort, name")]
    return {"label": inv["label"], "role": inv["role"], "groups": groups}


# ── joining and signing in with a password (fallback when passkeys aren't available) ───────

class JoinIn(BaseModel):
    token: str
    name: str = Field(max_length=60)
    dance_role: str = "both"
    groups: list[int] = []
    password: str = Field("", max_length=200)


def _join_details(body: JoinIn) -> dict:
    if body.dance_role not in DANCE_ROLES:
        raise HTTPException(400, "Choose lead, follow or both")
    return {"name": _clean_name(body.name), "dance_role": body.dance_role, "groups": body.groups}


@router.post("/api/join/password")
def join_with_password(body: JoinIn):
    if len(body.password) < 8:
        raise HTTPException(400, "Use a password of at least 8 characters")
    d = _join_details(body)
    with db.tx() as con:
        inv = _invite(con, body.token)
        _name_free(con, d["name"])
        uid = _create_user(con, inv, d, pw_hash=auth.hash_password(body.password))
    return auth.signed_in(uid)


class LoginIn(BaseModel):
    name: str = Field(max_length=60)
    password: str = Field(max_length=200)


@router.post("/api/login")
def login(body: LoginIn):
    with db.tx() as con:
        row = con.execute("SELECT id, pw_hash FROM users WHERE name = ?", (" ".join(body.name.split()),)).fetchone()
    if not row or not row["pw_hash"] or not auth.check_password(body.password, row["pw_hash"]):
        raise HTTPException(401, "That name and password don't match")
    return auth.signed_in(row["id"])


# ── passkeys ────────────────────────────────────────────────────────────────

def _save_challenge(con, challenge: bytes, purpose: str, user_id: int | None = None, data: dict | None = None) -> str:
    con.execute("DELETE FROM webauthn_challenges WHERE expires_at < ?", (db.now(),))
    cid = secrets.token_urlsafe(16)
    con.execute("INSERT INTO webauthn_challenges VALUES (?,?,?,?,?,?)",
                (cid, challenge, purpose, user_id, json.dumps(data or {}), db.now() + CHALLENGE_MS))
    return cid


def _take_challenge(con, cid: str, purpose: str) -> dict:
    row = con.execute("SELECT * FROM webauthn_challenges WHERE id = ? AND purpose = ?", (cid, purpose)).fetchone()
    con.execute("DELETE FROM webauthn_challenges WHERE id = ?", (cid,))
    if not row or row["expires_at"] < db.now():
        raise HTTPException(400, "That took too long. Try again")
    return dict(row) | {"data": json.loads(row["data"])}


class RegisterBegin(BaseModel):
    token: str | None = None          # joining: the invite token, plus the sign-up details below
    name: str = Field("", max_length=60)
    dance_role: str = "both"
    groups: list[int] = []


@router.post("/api/passkey/register/begin")
def passkey_register_begin(body: RegisterBegin, u: dict | None = Viewer):
    with db.tx() as con:
        if u:   # adding a passkey to your own account
            row = con.execute("SELECT handle FROM users WHERE id = ?", (u["id"],)).fetchone()
            handle = row["handle"] or bytes_to_base64url(secrets.token_bytes(16))
            if not row["handle"]:
                con.execute("UPDATE users SET handle = ? WHERE id = ?", (handle, u["id"]))
            name, exclude = u["name"], [PublicKeyCredentialDescriptor(id=base64url_to_bytes(r["id"]))
                                        for r in con.execute("SELECT id FROM passkeys WHERE user_id = ?", (u["id"],))]
            data = {}
        else:   # joining with an invite link
            d = _join_details(JoinIn(token=body.token or "", name=body.name, dance_role=body.dance_role, groups=body.groups))
            _invite(con, body.token or "")
            _name_free(con, d["name"])
            handle, name, exclude = bytes_to_base64url(secrets.token_bytes(16)), d["name"], []
            data = d | {"token": body.token, "handle": handle}
        opts = webauthn.generate_registration_options(
            rp_id=settings.rp_id, rp_name=settings.rp_name, user_name=name, user_display_name=name,
            user_id=base64url_to_bytes(handle), exclude_credentials=exclude,
            authenticator_selection=AuthenticatorSelectionCriteria(
                resident_key=ResidentKeyRequirement.REQUIRED, user_verification=UserVerificationRequirement.PREFERRED))
        cid = _save_challenge(con, opts.challenge, "register", u["id"] if u else None, data)
    return {"cid": cid, "options": json.loads(webauthn.options_to_json(opts))}


class CeremonyFinish(BaseModel):
    cid: str
    credential: dict
    label: str = Field("", max_length=60)


@router.post("/api/passkey/register/finish")
def passkey_register_finish(body: CeremonyFinish, u: dict | None = Viewer):
    with db.tx() as con:
        ch = _take_challenge(con, body.cid, "register")
        try:
            v = webauthn.verify_registration_response(credential=body.credential, expected_challenge=ch["challenge"],
                                                      expected_rp_id=settings.rp_id, expected_origin=settings.origin)
        except InvalidRegistrationResponse as e:
            raise HTTPException(400, f"That passkey couldn't be saved ({e})")
        if ch["user_id"]:
            if not u or u["id"] != ch["user_id"]:
                raise HTTPException(403, "Sign in again and retry")
            uid = ch["user_id"]
        else:
            d = ch["data"]
            inv = _invite(con, d["token"])
            _name_free(con, d["name"])
            uid = _create_user(con, inv, d, handle=d["handle"])
        transports = body.credential.get("response", {}).get("transports") or []
        con.execute("INSERT INTO passkeys (id, user_id, public_key, sign_count, transports, label, created_at)"
                    " VALUES (?,?,?,?,?,?,?)",
                    (bytes_to_base64url(v.credential_id), uid, v.credential_public_key, v.sign_count,
                     json.dumps(transports), body.label.strip() or "Passkey", db.now()))
    return auth.signed_in(uid)


@router.post("/api/passkey/login/begin")
def passkey_login_begin():
    opts = webauthn.generate_authentication_options(rp_id=settings.rp_id,
                                                    user_verification=UserVerificationRequirement.PREFERRED)
    with db.tx() as con:
        cid = _save_challenge(con, opts.challenge, "login")
    return {"cid": cid, "options": json.loads(webauthn.options_to_json(opts))}


@router.post("/api/passkey/login/finish")
def passkey_login_finish(body: CeremonyFinish):
    with db.tx() as con:
        ch = _take_challenge(con, body.cid, "login")
        key = con.execute("SELECT * FROM passkeys WHERE id = ?", (str(body.credential.get("id", "")),)).fetchone()
        if not key:
            raise HTTPException(401, "That passkey isn't registered here. Join with your invite link first")
        try:
            v = webauthn.verify_authentication_response(
                credential=body.credential, expected_challenge=ch["challenge"], expected_rp_id=settings.rp_id,
                expected_origin=settings.origin, credential_public_key=key["public_key"],
                credential_current_sign_count=key["sign_count"])
        except InvalidAuthenticationResponse as e:
            raise HTTPException(401, f"That passkey didn't check out ({e})")
        con.execute("UPDATE passkeys SET sign_count = ?, last_used = ? WHERE id = ?", (v.new_sign_count, db.now(), key["id"]))
    return auth.signed_in(key["user_id"])


# ── your account ────────────────────────────────────────────────────────────

class AccountPatch(BaseModel):
    name: str | None = Field(None, max_length=60)
    dance_role: str | None = None
    groups: list[int] | None = None


@router.patch("/api/account")
def update_account(body: AccountPatch, u: dict = Member):
    with db.tx() as con:
        if body.name is not None:
            name = _clean_name(body.name)
            _name_free(con, name, u["id"])
            con.execute("UPDATE users SET name = ? WHERE id = ?", (name, u["id"]))
        if body.dance_role is not None:
            if body.dance_role not in DANCE_ROLES:
                raise HTTPException(400, "Choose lead, follow or both")
            con.execute("UPDATE users SET dance_role = ? WHERE id = ?", (body.dance_role, u["id"]))
        if body.groups is not None:
            _set_groups(con, u["id"], body.groups)
    return {"ok": True}


@router.get("/api/account/passkeys")
def my_passkeys(u: dict = Member):
    with db.tx() as con:
        return [dict(r) for r in con.execute(
            "SELECT id, label, created_at, last_used FROM passkeys WHERE user_id = ? ORDER BY created_at", (u["id"],))]


def _sign_in_methods(con, uid: int) -> tuple[int, bool]:
    keys = con.execute("SELECT count(*) FROM passkeys WHERE user_id = ?", (uid,)).fetchone()[0]
    has_pw = bool(con.execute("SELECT pw_hash FROM users WHERE id = ?", (uid,)).fetchone()["pw_hash"])
    return keys, has_pw


@router.delete("/api/account/passkeys/{key_id}")
def remove_passkey(key_id: str, u: dict = Member):
    with db.tx() as con:
        keys, has_pw = _sign_in_methods(con, u["id"])
        if keys <= 1 and not has_pw:
            raise HTTPException(400, "That's your only way to sign in. Add another passkey or a password first")
        con.execute("DELETE FROM passkeys WHERE id = ? AND user_id = ?", (key_id, u["id"]))
    return {"ok": True}


class PasswordIn(BaseModel):
    password: str = Field(max_length=200)


@router.put("/api/account/password")
def set_password(body: PasswordIn, u: dict = Member):
    if len(body.password) < 8:
        raise HTTPException(400, "Use a password of at least 8 characters")
    with db.tx() as con:
        con.execute("UPDATE users SET pw_hash = ? WHERE id = ?", (auth.hash_password(body.password), u["id"]))
    return {"ok": True}


@router.delete("/api/account/password")
def remove_password(u: dict = Member):
    with db.tx() as con:
        keys, _ = _sign_in_methods(con, u["id"])
        if not keys:
            raise HTTPException(400, "Add a passkey before removing your password")
        con.execute("UPDATE users SET pw_hash = '' WHERE id = ?", (u["id"],))
    return {"ok": True}


# ── admin ───────────────────────────────────────────────────────────────────

@router.get("/api/admin/overview")
def admin_overview(u: dict = Admin):
    with db.tx() as con:
        users = []
        for r in con.execute("SELECT id, name, role, dance_role, created_at, pw_hash <> '' AS has_password FROM users ORDER BY name"):
            d = dict(r)
            d["groups"] = _groups_of(con, r["id"])
            d["passkeys"] = con.execute("SELECT count(*) FROM passkeys WHERE user_id = ?", (r["id"],)).fetchone()[0]
            users.append(d)
        invites = [dict(r) for r in con.execute("SELECT * FROM invites WHERE revoked = 0 ORDER BY created_at DESC")]
        requests = [dict(r) for r in con.execute(
            "SELECT ai_requests.*, users.name AS by_name FROM ai_requests LEFT JOIN users ON users.id = ai_requests.user_id"
            " ORDER BY status = 'open' DESC, created_at DESC LIMIT 100")]
        usage = [dict(r) for r in con.execute(
            "SELECT users.name, strftime('%Y-%m', ai_usage.at / 1000, 'unixepoch') AS month, count(*) AS calls,"
            " sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens, round(sum(cost_usd), 2) AS cost_usd"
            " FROM ai_usage LEFT JOIN users ON users.id = ai_usage.user_id GROUP BY users.name, month ORDER BY month DESC")]
        video_bytes = con.execute("SELECT coalesce(sum(size), 0) FROM videos WHERE file IS NOT NULL").fetchone()[0]
        groups = [dict(g) for g in con.execute("SELECT * FROM groups ORDER BY sort, name")]
    disk = shutil.disk_usage(settings.upload_dir)
    return {"users": users, "invites": invites, "requests": requests, "usage": usage, "groups": groups,
            "storage": {"videos": video_bytes, "free": disk.free, "total": disk.total},
            "ai": {"access": settings.ai_access, "daily_limit": settings.ai_daily_limit}}


class InviteIn(BaseModel):
    label: str = Field("", max_length=80)
    role: str = "member"
    max_uses: int | None = Field(None, ge=1)
    days: int | None = Field(None, ge=1, le=365)


@router.post("/api/admin/invites")
def create_invite(body: InviteIn, u: dict = Admin):
    if body.role not in auth.ROLES:
        raise HTTPException(400, "Unknown role")
    token = secrets.token_urlsafe(18)
    expires = db.now() + body.days * 86400 * 1000 if body.days else None
    with db.tx() as con:
        con.execute("INSERT INTO invites (token, label, role, max_uses, expires_at, created_by, created_at) VALUES (?,?,?,?,?,?,?)",
                    (token, body.label.strip(), body.role, body.max_uses, expires, u["id"], db.now()))
    return {"token": token}


@router.delete("/api/admin/invites/{token}")
def revoke_invite(token: str, u: dict = Admin):
    with db.tx() as con:
        con.execute("UPDATE invites SET revoked = 1 WHERE token = ?", (token,))
    return {"ok": True}


class RoleIn(BaseModel):
    role: str


@router.patch("/api/admin/users/{uid}")
def set_role(uid: int, body: RoleIn, u: dict = Admin):
    if body.role not in auth.ROLES:
        raise HTTPException(400, "Unknown role")
    if uid == u["id"] and body.role != "admin":
        raise HTTPException(400, "You can't remove your own admin role")
    with db.tx() as con:
        con.execute("UPDATE users SET role = ? WHERE id = ?", (body.role, uid))
    return {"ok": True}


@router.delete("/api/admin/users/{uid}")
def remove_user(uid: int, u: dict = Admin):
    if uid == u["id"]:
        raise HTTPException(400, "You can't remove yourself")
    with db.tx() as con:
        delete_user(con, uid)
    return {"ok": True}


def delete_user(con, uid: int):
    """Remove someone, keeping what they made (routines, charts, videos) but no longer attributed to them."""
    for table, col in (("routines", "created_by"), ("routines", "updated_by"), ("routine_versions", "by_user"),
                       ("chat", "user_id"), ("notes", "updated_by"), ("charts", "updated_by"), ("videos", "created_by")):
        con.execute(f"UPDATE {table} SET {col} = NULL WHERE {col} = ?", (uid,))
    for col in ("owner_id", "lead_id", "follow_id"):
        con.execute(f"UPDATE routines SET {col} = NULL WHERE {col} = ?", (uid,))
    con.execute("DELETE FROM approvals WHERE user_id = ?", (uid,))
    con.execute("DELETE FROM users WHERE id = ?", (uid,))


class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    sort: int = 0


@router.post("/api/admin/groups")
def add_group(body: GroupIn, u: dict = Admin):
    with db.tx() as con:
        if con.execute("SELECT 1 FROM groups WHERE name = ?", (body.name.strip(),)).fetchone():
            raise HTTPException(409, "There's already a group with that name")
        con.execute("INSERT INTO groups (name, sort) VALUES (?,?)", (body.name.strip(), body.sort))
    return {"ok": True}


@router.patch("/api/admin/groups/{gid}")
def rename_group(gid: int, body: GroupIn, u: dict = Admin):
    with db.tx() as con:
        con.execute("UPDATE groups SET name = ?, sort = ? WHERE id = ?", (body.name.strip(), body.sort, gid))
    return {"ok": True}


@router.delete("/api/admin/groups/{gid}")
def delete_group(gid: int, u: dict = Admin):
    with db.tx() as con:
        con.execute("DELETE FROM groups WHERE id = ?", (gid,))
    return {"ok": True}
