"""Who can see and change what, invite links, password fallback, and real passkey ceremonies."""
import base64
import hashlib
import importlib
import json
import os
import struct

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

ORIGIN, RP_ID = "http://testserver", "testserver"


@pytest.fixture()
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "up"))
    monkeypatch.setenv("ORIGIN", ORIGIN)
    monkeypatch.setenv("RP_ID", RP_ID)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("AI_ACCESS", "admin")
    monkeypatch.setenv("TRANSCRIBE_WORKER", "0")
    monkeypatch.setenv("RENDER_TOKEN", "render-secret")
    import config, db, auth, common, ai, transcribe, recordings, accounts, society, renders, main
    for m in (config, db, auth, common, ai, transcribe, recordings, accounts, society, renders, main):
        importlib.reload(m)
    return main


def person(app, name, role="member"):
    """A signed-in client for a new user with a password."""
    import auth, db
    with db.tx() as con:
        con.execute("INSERT INTO users (name, pw_hash, created_at, role) VALUES (?,?,?,?)",
                    (name, auth.hash_password("correct horse"), db.now(), role))
    c = TestClient(app.app)
    assert c.post("/api/login", json={"name": name, "password": "correct horse"}).status_code == 200
    return c


def invite(app, **kw):
    import db
    with db.tx() as con:
        con.execute("INSERT INTO invites (token, role, max_uses, expires_at, revoked, created_at) VALUES (?,?,?,?,?,?)",
                    (kw.get("token", "tok"), kw.get("role", "member"), kw.get("max_uses"), kw.get("expires_at"),
                     kw.get("revoked", 0), db.now()))
    return kw.get("token", "tok")


# ── public vs members ─────────────────────────────────────────────────────────

def test_visitors_see_the_syllabus_but_no_people(app):
    v = TestClient(app.app)
    assert v.get("/api/syllabus").status_code == 200
    st = v.get("/api/state").json()
    assert set(st) == {"charts", "verified", "renders"}
    assert v.get("/api/me").json()["me"] is None
    for path in ("/api/figures/waltz.whisk/comments", "/api/routines/example-bronze-waltz", "/media/x.mp4",
                 "/api/lessons/x/comments", "/api/admin/overview"):
        assert v.get(path).status_code == 401, path


def test_members_get_names_lessons_and_competitions(app):
    m = person(app, "Ann")
    st = m.get("/api/state").json()
    assert {"users", "lessons", "competitions", "videos", "routines"} <= set(st)
    assert [u["name"] for u in st["users"]] == ["Ann"]


def test_members_manage_their_own_things_but_not_the_society_record(app):
    m = person(app, "Ann")
    assert m.post("/api/figures/waltz.whisk/comments", json={"text": "Keep the head left"}).status_code == 200
    assert m.put("/api/notes/waltz.whisk", json={"text": "my note"}).status_code == 200
    assert m.post("/api/routines", json={"name": "R", "dance": "waltz"}).status_code == 200
    assert m.post("/api/lessons", json={"date": "2026-11-02"}).status_code == 403
    assert m.post("/api/competitions", json={"name": "X"}).status_code == 403
    assert m.post("/api/figures/waltz.whisk/verified").status_code == 403
    assert m.put("/api/charts/waltz.whisk", json={"start": {}, "man": [], "lady": []}).status_code == 403


def test_committee_runs_lessons_competitions_and_checks(app):
    c = person(app, "Cat", "committee")
    assert c.post("/api/lessons", json={"date": "2026-11-02", "figures": ["waltz.whisk", "nope"]}).status_code == 200
    assert c.post("/api/competitions", json={"name": "Bath Friendly", "start_date": "2027-02-06"}).status_code == 200
    assert c.post("/api/figures/waltz.whisk/verified").status_code == 200
    st = c.get("/api/state").json()
    assert st["lessons"][0]["figures"] == ["waltz.whisk"]
    assert "waltz.whisk" in st["verified"]
    assert TestClient(app.app).get("/api/state").json()["verified"]["waltz.whisk"].get("by") is None  # no names for visitors
    assert c.get("/api/admin/overview").status_code == 403


def test_routines_are_private_to_their_dancers(app):
    a, b, c = person(app, "Ann"), person(app, "Ben"), person(app, "Cal")
    ben_id = [u for u in a.get("/api/state").json()["users"] if u["name"] == "Ben"][0]["id"]
    rid = a.post("/api/routines", json={"name": "Our waltz", "dance": "waltz", "partner_id": ben_id, "my_role": "follow"}).json()["id"]
    assert b.get(f"/api/routines/{rid}").json()["lead_id"] == ben_id
    assert c.get(f"/api/routines/{rid}").status_code == 404
    assert rid not in [r["id"] for r in c.get("/api/state").json()["routines"]]
    assert b.patch(f"/api/routines/{rid}", json={"base_rev": 1, "items": [{"type": "fig", "fig": "waltz.whisk"}]}).status_code == 200
    assert c.patch(f"/api/routines/{rid}", json={"base_rev": 2, "name": "mine now"}).status_code == 404


def test_claude_is_admin_only_and_others_queue_requests(app):
    m, boss = person(app, "Ann"), person(app, "Charlie", "admin")
    assert m.post("/api/charts/waltz.whisk/draft").status_code == 403
    rid = m.post("/api/routines", json={"name": "R", "dance": "waltz"}).json()["id"]
    assert m.post(f"/api/routines/{rid}/chat", json={"message": "hi"}).status_code == 403
    assert m.post("/api/requests", json={"kind": "chart", "target": "waltz.whisk"}).status_code == 200
    assert m.post("/api/requests", json={"kind": "routine", "target": rid, "note": "Bronze, small hall"}).status_code == 200
    reqs = boss.get("/api/admin/overview").json()["requests"]
    assert {r["kind"] for r in reqs if r["status"] == "open"} == {"chart", "routine"}
    assert m.post("/api/admin/requests/1/run").status_code == 403


def test_video_permissions(app):
    m, c = person(app, "Ann"), person(app, "Cat", "committee")
    rid = m.post("/api/routines", json={"name": "R", "dance": "waltz"}).json()["id"]
    assert m.post("/api/videos", data={"ref": f"routine:{rid}", "url": "https://youtu.be/x"}).status_code == 200
    assert m.post("/api/videos", data={"ref": "fig:waltz.whisk", "url": "https://youtu.be/x"}).status_code == 403
    assert c.post("/api/videos", data={"ref": "fig:waltz.whisk", "url": "https://youtu.be/y"}).status_code == 200
    vids = c.get("/api/state").json()["videos"]
    assert all(not v["ref"].startswith("routine:") for v in vids)  # Cat can't see Ann's routine video


# ── invites and the password fallback ────────────────────────────────────────

def join(c, token, name="Dee", **kw):
    return c.post("/api/join/password", json={"token": token, "name": name, "password": "longenough", "dance_role": "follow",
                                              "groups": kw.get("groups", [])})


def test_join_with_password_then_sign_in(app):
    tok = invite(app, role="committee")
    c = TestClient(app.app)
    assert c.get(f"/api/invites/{tok}").status_code == 200
    assert join(c, tok, groups=[2]).status_code == 200
    me = c.get("/api/me").json()["me"]
    assert (me["name"], me["role"], me["dance_role"], me["groups"]) == ("Dee", "committee", "follow", [2])
    c2 = TestClient(app.app)
    assert c2.post("/api/login", json={"name": "Dee", "password": "wrong"}).status_code == 401
    assert c2.post("/api/login", json={"name": "Dee", "password": "longenough"}).status_code == 200


@pytest.mark.parametrize("kw", [dict(revoked=1), dict(expires_at=1), dict(max_uses=1)])
def test_bad_invites_are_refused(app, kw):
    tok = invite(app, **kw)
    if kw.get("max_uses"):
        assert join(TestClient(app.app), tok, "First").status_code == 200
    assert join(TestClient(app.app), tok, "Second").status_code == 403


def test_names_must_be_unique(app):
    tok = invite(app)
    assert join(TestClient(app.app), tok, "Dee").status_code == 200
    assert join(TestClient(app.app), tok, "dee").status_code == 409


# ── passkeys, with a software authenticator ───────────────────────────────────

def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class SoftKey:
    def __init__(self):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.cred_id = os.urandom(16)
        self.count = 0

    def _cose(self) -> bytes:
        from webauthn.helpers import encode_cbor
        n = self.key.public_key().public_numbers()
        return encode_cbor({1: 2, 3: -7, -1: 1, -2: n.x.to_bytes(32, "big"), -3: n.y.to_bytes(32, "big")})

    def create(self, options: dict) -> dict:
        from webauthn.helpers import encode_cbor
        cdj = json.dumps({"type": "webauthn.create", "challenge": options["challenge"], "origin": ORIGIN}).encode()
        auth_data = (hashlib.sha256(RP_ID.encode()).digest() + bytes([0x45]) + struct.pack(">I", 0)
                     + bytes(16) + struct.pack(">H", len(self.cred_id)) + self.cred_id + self._cose())
        att = encode_cbor({"fmt": "none", "attStmt": {}, "authData": auth_data})
        return {"id": b64u(self.cred_id), "rawId": b64u(self.cred_id), "type": "public-key",
                "response": {"clientDataJSON": b64u(cdj), "attestationObject": b64u(att), "transports": ["internal"]},
                "clientExtensionResults": {}}

    def get(self, options: dict) -> dict:
        self.count += 1
        cdj = json.dumps({"type": "webauthn.get", "challenge": options["challenge"], "origin": ORIGIN}).encode()
        auth_data = hashlib.sha256(RP_ID.encode()).digest() + bytes([0x05]) + struct.pack(">I", self.count)
        sig = self.key.sign(auth_data + hashlib.sha256(cdj).digest(), ec.ECDSA(hashes.SHA256()))
        return {"id": b64u(self.cred_id), "rawId": b64u(self.cred_id), "type": "public-key",
                "response": {"clientDataJSON": b64u(cdj), "authenticatorData": b64u(auth_data), "signature": b64u(sig)},
                "clientExtensionResults": {}}


def test_join_and_sign_in_with_a_passkey(app):
    tok, key = invite(app), SoftKey()
    c = TestClient(app.app)
    begin = c.post("/api/passkey/register/begin", json={"token": tok, "name": "Eve", "dance_role": "lead"}).json()
    assert begin["options"]["authenticatorSelection"]["residentKey"] == "required"
    r = c.post("/api/passkey/register/finish", json={"cid": begin["cid"], "credential": key.create(begin["options"]), "label": "Phone"})
    assert r.status_code == 200, r.text
    assert c.get("/api/me").json()["me"]["name"] == "Eve"

    fresh = TestClient(app.app)
    begin = fresh.post("/api/passkey/login/begin").json()
    r = fresh.post("/api/passkey/login/finish", json={"cid": begin["cid"], "credential": key.get(begin["options"])})
    assert r.status_code == 200, r.text
    assert fresh.get("/api/me").json()["me"]["name"] == "Eve"

    # a replayed challenge is refused
    assert fresh.post("/api/passkey/login/finish", json={"cid": begin["cid"], "credential": key.get(begin["options"])}).status_code == 400


def test_last_sign_in_method_cannot_be_removed(app):
    tok, key = invite(app), SoftKey()
    c = TestClient(app.app)
    begin = c.post("/api/passkey/register/begin", json={"token": tok, "name": "Eve"}).json()
    c.post("/api/passkey/register/finish", json={"cid": begin["cid"], "credential": key.create(begin["options"])})
    only = c.get("/api/account/passkeys").json()[0]["id"]
    assert c.delete(f"/api/account/passkeys/{only}").status_code == 400
    assert c.put("/api/account/password", json={"password": "longenough"}).status_code == 200
    assert c.delete(f"/api/account/passkeys/{only}").status_code == 200
    assert c.delete("/api/account/password").status_code == 400


def test_admin_can_remove_a_member_who_made_things(app):
    m, boss = person(app, "Ann"), person(app, "Charlie", "admin")
    rid = m.post("/api/routines", json={"name": "R", "dance": "waltz"}).json()["id"]
    m.post(f"/api/routines/{rid}/approve", json={"rev": 1})
    m.post("/api/videos", data={"ref": f"routine:{rid}", "url": "https://youtu.be/x"})
    ann = [u for u in boss.get("/api/admin/overview").json()["users"] if u["name"] == "Ann"][0]["id"]
    assert boss.delete(f"/api/admin/users/{ann}").status_code == 200
    assert m.get("/api/me").json()["me"] is None
