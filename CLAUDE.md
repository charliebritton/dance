# Rise & Fall

Charlie's ISTD ballroom and Latin step book: syllabus with Moore/Laird-style step charts and animated footprints,
shared routines with partner sign-off, a floor plan, practice to the beat, and Claude for drafting charts and
planning routines. FastAPI + SQLite backend, vanilla-JS frontend with no build step.

## Layout
- `backend/main.py` all routes; `ai.py` Claude calls (structured JSON); `syllabus.json` ISTD figure lists;
  `charts.json` starter charts (written from memory, to be checked against the books).
- `frontend/engine.js` footprint engine (simulate, draw, animate); `floor.js` floor plan; `core.js` state, API,
  glossary tooltips; `views/*.js` one per page.

## Conventions
- Diagrams: LOD points right, wall at the bottom. Left foot drawn in outline, right foot solid (Moore).
- A step's `t` is the turn made before it lands (+ right). `d` is direction relative to the body; `mv` overrides
  it for steps travelling in PP. "Steps a–b only" in a routine item's notes cuts the figure everywhere.
- All frontend URLs go through `BASE` (the server fills `<html data-base>` from `BASE_PATH`).
- `READ_ONLY=true` is the public preview: no accounts, every write refused (tests in `backend/tests`).

## Commands
- Dev server: launch config `rise-dev` (port 8021). Tests: `cd backend && ./venv/bin/python -m pytest -q tests`.
- Deploy: commit, then `./deploy/deploy.sh`. Live at https://chza.me/dance/ (read-only preview, container on
  127.0.0.1:8031 behind the chza.me Apache vhost; see `deploy/apache-dance.conf`).
