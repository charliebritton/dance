# Rise & Fall

Charlie's ISTD/BDC ballroom and Latin step book for university dancers: syllabus with Moore/Laird-style step charts and
animated footprints (public), plus a members area (invite link + passkeys) with personal routines and partners,
lessons per group (figures covered, routine, videos, comments), competitions, and Claude for drafting charts and
routines. FastAPI + SQLite backend, vanilla-JS frontend with no build step. Not affiliated with SUBLDS: say so,
never use the society's name or branding.

## Layout
- `backend/main.py` state, routines, charts, videos; `accounts.py` invites, passkeys (py_webauthn), password
  fallback, account, admin; `society.py` lessons, competitions, chart checks, comments, notes, draft requests;
  `auth.py` session cookie + role dependencies (`viewer`/`member`/`committee`/`admin`, `check_ai`); `common.py`
  routine access helpers; `ai.py` Claude calls (structured JSON, usage + cost logged per person);
  `manage.py` CLI (`invite --admin`, `seed-competitions`). `syllabus.json` ISTD lists per level plus each dance's
  `bdc` list (BDC Rules appendices 1–2, the restricted syllabus for beginner/novice comps); a figure is one id per
  dance+name, so a figure in both shares its chart. `charts.json` starter charts (written from memory, to be checked
  against the books; every chart shows "Not checked yet" until the committee marks it checked);
  `competitions_seed.json` 2026/27 circuit.
- `frontend/engine.js` footprint engine (simulate, draw, animate); `floor.js` floor plan; `core.js` state, API,
  glossary tooltips; `views/*.js` one per page.

## Conventions
- Diagrams: LOD points right, wall at the bottom. Left foot drawn in outline, right foot solid (Moore).
- A step's `t` is the turn made before it lands (+ right). `d` is direction relative to the body; `mv` overrides
  it for steps travelling in PP. "Steps a–b only" in a routine item's notes cuts the figure everywhere.
- All frontend URLs go through `BASE` (the server fills `<html data-base>` from `BASE_PATH`).
- Access: visitors see the syllabus and charts only; names, videos, routines, lessons and competitions need sign-in.
  Members own their routines (owner + lead/follow dancers), comments and private notes; committee runs lessons,
  competitions, chart edits and the "checked" mark; admin manages invites/roles/groups and is the only Claude user
  (`AI_ACCESS=admin`; `all` + `AI_DAILY_LIMIT` later). Everyone else uses "Request a draft" (admin queue).
- Routines have a `syllabus` (`istd` with level Bronze/Silver/Gold, or `bdc` with the single level `Restricted`).
- People the admin adds ahead of time are users with no passkey or password ("not joined yet"); a personal invite
  (`invites.user_id`, one use) lets only them take that account over, keeping their routines and groups.
- Schema changes: new tables in `schema.sql`, new columns appended to `db.ADDED_COLUMNS`. Never reseed the live DB.

## Commands
- Dev server: launch config `rise-dev` (port 8021). Tests: `cd backend && ./venv/bin/python -m pytest -q tests`.
- Deploy: commit, then `./deploy/deploy.sh`. Live at https://chza.me/dance/ (container on 127.0.0.1:8031 behind
  the chza.me Apache vhost; see `deploy/apache-dance.conf`). Server env sets RP_ID=chza.me, ORIGIN=https://chza.me.
  Admin commands on the server: `docker compose exec app python manage.py …`.
