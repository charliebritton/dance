"""The BDC syllabus, people added ahead of time with personal join links, and drafting a routine with Claude."""
from fastapi.testclient import TestClient

from test_access import SoftKey, app, invite, join, person  # noqa: F401  (app is a fixture)


# ── BDC restricted syllabus ──────────────────────────────────────────────────

def test_bdc_figures_join_the_istd_ones(app):
    import syllabus
    syl = TestClient(app.app).get("/api/syllabus").json()
    assert [s["id"] for s in syl["syllabi"]] == ["istd", "bdc"]
    assert syllabus.FIGURES["waltz.natural-turn"] | {} == {"id": "waltz.natural-turn", "dance": "waltz", "name": "Natural Turn",
                                                          "level": "Bronze", "bdc": True}
    assert syllabus.FIGURES["waltz.contra-check"]["bdc"] is False          # excluded by the BDC rules
    assert syllabus.FIGURES["waltz.fallaway-whisk"]["level"] is None       # BDC only
    for d in syllabus.DANCES:                                               # every BDC name is a figure
        assert all(syllabus.by_name(d["id"], n) for n in d["bdc"])


def test_routines_can_use_the_bdc_syllabus(app):
    m = person(app, "Ann")
    rid = m.post("/api/routines", json={"name": "Novice", "dance": "waltz", "syllabus": "bdc", "level": "Gold"}).json()["id"]
    r = m.get(f"/api/routines/{rid}").json()
    assert (r["syllabus"], r["level"]) == ("bdc", "Restricted")
    assert m.patch(f"/api/routines/{rid}", json={"base_rev": 1, "items": [{"type": "fig", "fig": "waltz.fallaway-whisk"}]}).status_code == 200
    assert m.get(f"/api/routines/{rid}").json()["items"][0]["name"] == "Fallaway Whisk"
    assert m.patch(f"/api/routines/{rid}", json={"base_rev": 2, "syllabus": "istd", "level": "Silver"}).json()["rev"] == 3
    r = m.get(f"/api/routines/{rid}").json()
    assert (r["syllabus"], r["level"]) == ("istd", "Silver")
    assert m.post("/api/routines", json={"name": "X", "dance": "waltz", "syllabus": "nope"}).status_code == 400
    assert m.post("/api/routines", json={"name": "X", "dance": "waltz", "level": "Platinum"}).status_code == 400


# ── people added ahead of time, personal join links ──────────────────────────

def test_admin_adds_a_person_who_takes_over_their_place(app):
    boss, ann = person(app, "Charlie", "admin"), person(app, "Ann")
    pid = boss.post("/api/admin/people", json={"name": "Finn", "dance_role": "lead", "role": "committee", "groups": [1]}).json()["id"]
    users = {u["name"]: u for u in ann.get("/api/state").json()["users"]}
    assert users["Finn"]["joined"] is False
    rid = ann.post("/api/routines", json={"name": "Ours", "dance": "jive", "partner_id": pid, "my_role": "follow"}).json()["id"]

    assert ann.post("/api/admin/invites", json={"user_id": pid}).status_code == 403
    old = boss.post("/api/admin/invites", json={"user_id": pid}).json()["token"]
    tok = boss.post("/api/admin/invites", json={"user_id": pid}).json()["token"]
    assert TestClient(app.app).get(f"/api/invites/{old}").status_code == 403   # a new link replaces the old one
    info = TestClient(app.app).get(f"/api/invites/{tok}").json()
    assert info["person"] == {"name": "Finn", "dance_role": "lead", "groups": [1]}

    # the general link can't take the saved name; the personal one can
    general = invite(app, token="open")
    assert "personal join link" in join(TestClient(app.app), general, "finn").json()["detail"]
    f = TestClient(app.app)
    assert join(f, tok, "Finn").status_code == 200
    me = f.get("/api/me").json()["me"]
    assert (me["id"], me["role"], me["dance_role"]) == (pid, "committee", "follow")
    assert f.get(f"/api/routines/{rid}").json()["lead_id"] == pid
    assert join(TestClient(app.app), tok, "Finn again").status_code == 403    # used up
    assert boss.post("/api/admin/invites", json={"user_id": pid}).status_code == 400
    assert boss.patch(f"/api/admin/users/{pid}", json={"name": "Not Finn"}).status_code == 400


def test_personal_link_works_with_a_passkey(app):
    boss, key = person(app, "Charlie", "admin"), SoftKey()
    pid = boss.post("/api/admin/people", json={"name": "Gus"}).json()["id"]
    assert boss.patch(f"/api/admin/users/{pid}", json={"name": "Gus B", "dance_role": "follow"}).status_code == 200
    tok = boss.post("/api/admin/invites", json={"user_id": pid}).json()["token"]
    c = TestClient(app.app)
    begin = c.post("/api/passkey/register/begin", json={"token": tok, "name": "Gus B", "dance_role": "follow"}).json()
    r = c.post("/api/passkey/register/finish", json={"cid": begin["cid"], "credential": key.create(begin["options"])})
    assert r.status_code == 200, r.text
    assert c.get("/api/me").json()["me"]["id"] == pid
    o = boss.get("/api/admin/overview").json()
    assert [u["joined"] for u in o["users"] if u["id"] == pid] == [True]
    assert not [i for i in o["invites"] if i["user_id"] == pid]


def test_removing_a_waiting_person_kills_their_link(app):
    boss = person(app, "Charlie", "admin")
    pid = boss.post("/api/admin/people", json={"name": "Hal"}).json()["id"]
    tok = boss.post("/api/admin/invites", json={"user_id": pid}).json()["token"]
    assert boss.delete(f"/api/admin/users/{pid}").status_code == 200
    assert TestClient(app.app).get(f"/api/invites/{tok}").status_code == 403


# ── drafting a routine ───────────────────────────────────────────────────────

def test_asking_for_a_routine_always_gets_one(app, monkeypatch):
    import ai
    seen = {}

    def fake_call(system, messages, schema, **kw):
        seen.update(schema=schema, last=messages[-1]["content"])
        return {"reply": "Assumed a standard floor.", "proposal": {"mode": "replace", "items": [
            {"kind": "marker", "figure": "Long side", "notes": ""},
            {"kind": "figure", "figure": "Natural Turn", "notes": "F DW"},
            {"kind": "figure", "figure": "Made Up Turn", "notes": ""}]}}
    monkeypatch.setattr(ai, "_call", fake_call)
    boss = person(app, "Charlie", "admin")
    rid = boss.post("/api/routines", json={"name": "R", "dance": "waltz", "syllabus": "bdc"}).json()["id"]

    log = boss.post(f"/api/routines/{rid}/chat", json={"message": "make me a routine", "brief": "Novice comp"}).json()
    assert seen["schema"] is ai.DRAFT_SCHEMA
    assert "Couple's brief: Novice comp" in seen["last"] and "BDC restricted syllabus" in seen["last"]
    assert [i.get("fig") for i in log[-1]["proposal"]["items"]] == [None, "waltz.natural-turn", None]
    assert boss.get(f"/api/routines/{rid}").json()["brief"] == "Novice comp"

    boss.post(f"/api/routines/{rid}/chat", json={"message": "What can follow the last figure?"})
    assert seen["schema"] is ai.CHAT_SCHEMA
    boss.post(f"/api/routines/{rid}/chat", json={"message": "Go on then", "draft": True})
    assert seen["schema"] is ai.DRAFT_SCHEMA
