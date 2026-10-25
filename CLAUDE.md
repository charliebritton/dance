# Rise & Fall

Charlie's ISTD/BDC ballroom and Latin step book for university dancers: syllabus with Moore/Laird-style step charts and
animated footprints (public), plus a members area (invite link + passkeys) with personal routines and partners,
lessons per group (figures covered, routine, videos, comments, members' recordings turned into notes), competitions,
and Claude for drafting charts and routines. FastAPI + SQLite backend, vanilla-JS frontend with no build step. Not affiliated with SUBLDS: say so,
never use the society's name or branding.

## Layout
- `backend/main.py` state, routines, charts, videos; `accounts.py` invites, passkeys (py_webauthn), password
  fallback, account, admin; `society.py` lessons, competitions, chart checks, comments, notes, draft requests;
  `auth.py` session cookie + role dependencies (`viewer`/`member`/`committee`/`admin`, `check_ai`); `common.py`
  routine access helpers; `ai.py` Claude calls (structured JSON, usage + cost logged per person);
  `manage.py` CLI (`invite --admin`, `seed-competitions`). `syllabus.json` ISTD lists per level plus each dance's
  `bdc` list (BDC Rules appendices 1–2, the restricted syllabus for beginner/novice comps); a figure is one id per
  dance+name, so a figure in both shares its chart. `charts.json` starter charts (written from memory, to be checked
  against the books; every chart shows "Not checked yet" until the committee or admin marks it checked; teachers don't use the app);
  `competitions_seed.json` 2026/27 circuit. `recordings.py` lesson recordings (upload, privacy, free rough notes, the
  copy-for-Claude prompt, admin "Draft with Claude"); `transcribe.py` the local Whisper queue (see Recordings).
- `frontend/engine.js` footprint engine (simulate, draw, animate); `dancers3d.js` low-poly 3D dancers driven by the
  same simulation (three.js r169 vendored in `frontend/vendor/`, loaded only when someone picks "3D dancers"; legs and
  arms by two-bone IK, hold from where the partners stand; wooden floor with the room and LOD painted on it; plain,
  empty ballroom or crowd; camera views); `render.html`/`render.js` films one figure frame by frame for
  `render/worker.mjs`; `floor.js` floor plan; `core.js` state, API,
  glossary tooltips; `views/*.js` one per page; `recorder.js` in-browser lesson recorder (MediaRecorder, wake lock,
  chunks kept in IndexedDB until sent).

## Conventions
- Diagrams: LOD points right, wall at the bottom. Left foot drawn in outline, right foot solid (Moore).
- A step's `t` is the turn made before it lands (+ right). `d` is direction relative to the body; `mv` overrides
  it for steps travelling in PP. "Steps a–b only" in a routine item's notes cuts the figure everywhere.
- All frontend URLs go through `BASE` (the server fills `<html data-base>` from `BASE_PATH`).
- Access: visitors see the syllabus and charts only; names, videos, routines, lessons and competitions need sign-in.
  Members own their routines (owner + lead/follow dancers), comments and private notes; committee or admin runs
  lessons, competitions, chart edits and the "checked" mark (both roles can, neither has to; teachers aren't users,
  so copy never asks a teacher to check anything); admin manages invites/roles/groups and is the only Claude user
  (`AI_ACCESS=admin`; `all` + `AI_DAILY_LIMIT` later). Everyone else uses "Request a draft" (admin queue).
- Routines have a `syllabus` (`istd` with level Bronze/Silver/Gold, or `bdc` with the single level `Restricted`).
- People the admin adds ahead of time are users with no passkey or password ("not joined yet"); a personal invite
  (`invites.user_id`, one use) lets only them take that account over, keeping their routines and groups.
- 3D: drawn live on the viewer's GPU (figure page "3D dancers"). Pre-rendered MP4s are for later, on a GPU box (NAS,
  laptop, farm): `render/worker.mjs` pulls `/api/render/jobs` (figures whose video is missing or whose chart, tempo or
  `RIG` changed), films them and uploads to `PUT /api/render/{fig}` with `RENDER_TOKEN` (`backend/renders.py`). Bump
  `RIG` in `dancers3d.js` when the rig changes. Never render on the VPS.
- Practice: "Room's way round" turns the diagrams with the phone's compass (set facing the centre, back to the wall;
  each Corner marker turns later figures a quarter left); spoken calls of the next figure; music from the device at
  the practice speed (Spotify can't change a track's speed).
- `/terms` and `/privacy` (`views/legal.js`) must stay true to what the code stores and sends: update them with any
  feature that collects, shares or keeps data differently.
- Schema changes: new tables in `schema.sql`, new columns appended to `db.ADDED_COLUMNS`. Never reseed the live DB.

## Recordings
- A member uploads a lesson recording (watch/phone voice memo: m4a, mp3, wav, webm, ogg…) or records on the lesson page.
  Only they and the committee or admin see it; any of them can delete it. Audio is deleted after transcription unless "keep audio";
  failed jobs keep it for "Try again". Removing a lesson or a person removes their recordings.
- Transcription is local and free: faster-whisper, model `WHISPER_MODEL` (default `base`, int8, greedy, VAD, the
  lesson's figure names as hotwords), downloaded into `data/models` on first use. One job at a time: a worker thread
  in the app runs `python transcribe.py <id>` as a child at nice 19, idle IO and 1 thread; it writes progress and the
  partial transcript into `lesson_recordings`. A restart requeues a running job. Limits: `MAX_AUDIO_MB` 300, `MAX_AUDIO_MINUTES` 120.
- Why `base` (Oct 2026, this VPS, 5-min mock lesson: espeak teacher + beat + noise, 32 kbps m4a, 1 thread, int8):
  tiny 44–84 s, 350 MB, garbled ("Chass", "Lead us"); **base 66 s greedy, 490 MB**, figure names exact ("Chassé
  from PP"); base without hotwords 95 s and worse; base beam 5 121 s; small 200 s, 830 MB, near perfect. So a
  1-hour lesson takes base ~15–20 min; small would hold the shared CPU ~40 min and need 0.8 GB. `WHISPER_MODEL=small`
  if that ever seems worth it.
- Notes, free first: "Rough notes" (word lists + syllabus figure matching in `recordings.py`), "Copy transcript for
  Claude" (the same brief as `ai.NOTES_SYSTEM`, pasted into the person's own Claude), and admin-only "Draft with Claude"
  (`check_ai`, logged as `lesson-notes:<id>`). Notes save on the recording; the owner can post them as a comment, the
  committee or admin can add them to the summary and tick off the figures heard.
- Screen off: iPhone Safari stops the microphone when the screen locks or the app changes, so the page holds a wake
  lock; Android Chrome usually carries on. The voice-memo app on a watch or phone is the reliable pocket option.

## Roadmap
- `ROADMAP.md`: what is live, what is on the `3d-dancers` branch, and what is next. Keep it current.

## Commands
- The VPS has 1 CPU and 3.8 GB, shared with other sites. Run anything heavy (test browsers, benchmarks, builds) via
  `deploy/limited.sh <cmd>` (own cgroup: 40% CPU, 900 MB, nice 19, idle IO); docker test runs get
  `--cpus 0.5 --memory 900m`. Dev copy: `/opt/dance-dev` (git worktree on `3d-dancers`; `/opt/dance` stays on main because `deploy.sh`
  rebuilds production from it), started with its `deploy/dev.sh` → https://chza.me/dance-dev/ (amber DEV bar via `ENV_LABEL`) (container `dance-dev`, capped,
  runs the working tree with reload, own DB in `data/dev`, `--fresh` recopies live, no Claude key).
- Dev server: launch config `rise-dev` (port 8021). Tests: `cd backend && ./venv/bin/python -m pytest -q tests`.
- Deploy: commit, then `./deploy/deploy.sh`. Live at https://chza.me/dance/ (container on 127.0.0.1:8031 behind
  the chza.me Apache vhost; see `deploy/apache-dance.conf`). Server env sets RP_ID=chza.me, ORIGIN=https://chza.me.
  Admin commands on the server: `docker compose exec app python manage.py …`.
