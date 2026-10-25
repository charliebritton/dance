"""Pre-rendered figure videos: the render worker's job list, uploads, and videos going stale when a chart changes."""
from fastapi.testclient import TestClient

from test_access import app, person  # noqa: F401  (the app fixture)

AUTH = {"Authorization": "Bearer render-secret"}
FIG = "waltz.natural-turn"


def upload(c, h, fig=FIG):
    return c.put(f"/api/render/{fig}", headers=AUTH, files={"file": ("x.mp4", b"\x00\x00\x00\x18ftypmp42", "video/mp4")},
                 data={"hash": h, "fps": 50, "bpm": 87, "lead": 1, "tail": 1})


def test_only_the_worker_or_the_admin_gets_jobs(app):
    v = TestClient(app.app)
    assert v.get("/api/render/jobs").status_code == 401
    assert v.get("/api/render/jobs", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert person(app, "Mem").get("/api/render/jobs").status_code == 401
    jobs = v.get("/api/render/jobs", headers=AUTH).json()["jobs"]
    assert any(j["fig"] == FIG for j in jobs)
    assert person(app, "Boss", "admin").get("/api/render/jobs").status_code == 200


def test_an_upload_shows_until_the_chart_changes(app):
    c = TestClient(app.app)
    h = next(j["hash"] for j in c.get("/api/render/jobs", headers=AUTH).json()["jobs"] if j["fig"] == FIG)
    assert upload(c, "not-the-chart").status_code == 409
    r = upload(c, h)
    assert r.status_code == 200
    assert c.get(r.json()["url"]).status_code == 200
    assert FIG in c.get("/api/state").json()["renders"]
    assert FIG not in [j["fig"] for j in c.get("/api/render/jobs", headers=AUTH).json()["jobs"]]
    # the committee edits the chart: the video is out of date, so it's hidden and back on the job list
    com = person(app, "Com", "committee")
    chart = c.get("/api/syllabus").json()["charts"][FIG]
    chart["man"][0]["p"] = "RF forward (edited)"
    assert com.put(f"/api/charts/{FIG}", json=chart).status_code == 200
    assert FIG not in c.get("/api/state").json()["renders"]
    assert FIG in [j["fig"] for j in c.get("/api/render/jobs", headers=AUTH).json()["jobs"]]


def test_uploads_must_be_mp4_for_a_real_figure(app):
    c = TestClient(app.app)
    assert c.put("/api/render/waltz.no-such", headers=AUTH, files={"file": ("x.mp4", b"x", "video/mp4")},
                 data={"hash": "x", "fps": 50, "bpm": 87}).status_code == 404
    h = next(j["hash"] for j in c.get("/api/render/jobs", headers=AUTH).json()["jobs"] if j["fig"] == FIG)
    assert c.put(f"/api/render/{FIG}", headers=AUTH, files={"file": ("x.gif", b"GIF89a", "image/gif")},
                 data={"hash": h, "fps": 50, "bpm": 87}).status_code == 415
