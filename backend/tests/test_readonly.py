"""The public preview must never let anyone sign up, sign in or save."""
import importlib
import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("READ_ONLY", "true")
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "up"))
    import config, auth, db, main
    for m in (config, auth, db, main):
        importlib.reload(m)
    return TestClient(main.app)


def test_reads_are_public(client):
    assert client.get("/api/me").json()["readonly"] is True
    assert client.get("/api/state").status_code == 200
    assert client.get("/api/syllabus").status_code == 200


@pytest.mark.parametrize("method,path,body", [
    ("post", "/api/signup", {"name": "x", "password": "xxxxxx", "invite": "changeme"}),
    ("post", "/api/login", {"name": "x", "password": "xxxxxx"}),
    ("post", "/api/routines", {"name": "x", "dance": "waltz"}),
    ("put", "/api/notes/waltz.natural-turn", {"text": "x"}),
    ("delete", "/api/routines/example-bronze-waltz", None),
    ("post", "/api/charts/waltz.whisk/draft", None),
])
def test_writes_are_refused(client, method, path, body):
    r = getattr(client, method)(path, json=body) if body is not None else getattr(client, method)(path)
    assert r.status_code == 403
