"""Security review fixes: login throttling, upload types, headers, and the production secret guard."""
import importlib

import pytest
from fastapi.testclient import TestClient

from test_access import app, person  # noqa: F401  (the app fixture)


def test_password_guessing_is_throttled(app):
    person(app, "Pat")
    v = TestClient(app.app)
    for _ in range(8):
        assert v.post("/api/login", json={"name": "Pat", "password": "wrong"}).status_code == 401
    r = v.post("/api/login", json={"name": "Pat", "password": "correct horse"})
    assert r.status_code == 429                                  # even the right password waits now
    # a different name from the same address is also held back (the address is over its limit)
    assert v.post("/api/login", json={"name": "Someone", "password": "x"}).status_code == 429


def test_a_good_sign_in_clears_the_count(app):
    person(app, "Sam")
    v = TestClient(app.app)
    for _ in range(5):
        v.post("/api/login", json={"name": "Sam", "password": "wrong"})
    assert v.post("/api/login", json={"name": "Sam", "password": "correct horse"}).status_code == 200
    for _ in range(5):
        assert v.post("/api/login", json={"name": "Sam", "password": "wrong"}).status_code == 401


def test_only_real_videos_upload_and_they_are_served_as_video(app):
    boss = person(app, "Boss", "admin")
    bad = boss.post("/api/videos", data={"ref": "fig:waltz.whisk", "title": "x"},
                    files={"file": ("evil.html", b"<script>alert(1)</script>", "video/mp4")})
    assert bad.status_code == 415
    ok = boss.post("/api/videos", data={"ref": "fig:waltz.whisk", "title": "demo"},
                   files={"file": ("demo.mp4", b"\x00\x00\x00\x18ftypmp42", "video/mp4")})
    assert ok.status_code == 200
    vid = next(x for x in boss.get("/api/state").json()["videos"] if x["id"] == ok.json()["id"])
    r = boss.get(f"/media/{vid['file']}")
    assert r.headers["content-type"].startswith("video/mp4")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in r.headers["content-security-policy"]


def test_pages_get_security_headers(app):
    r = TestClient(app.app).get("/")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "SAMEORIGIN"
    assert "microphone=(self)" in r.headers["permissions-policy"]


def test_production_refuses_the_placeholder_secret(app, monkeypatch):
    import config, main
    monkeypatch.setenv("SECURE_COOKIES", "true")
    monkeypatch.setenv("SESSION_SECRET", "changeme-too")
    importlib.reload(config)
    with pytest.raises(SystemExit):
        importlib.reload(main)
    monkeypatch.setenv("SESSION_SECRET", "x" * 40)
    importlib.reload(config)
    importlib.reload(main)
