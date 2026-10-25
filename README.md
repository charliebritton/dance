# Rise & Fall

A ballroom and Latin step book for university dancers: the ISTD medal and BDC syllabi with step charts and animated
footprints (public), and a members area with routines, partners, lessons, competitions and Claude to help draft.
FastAPI + SQLite backend, plain JavaScript frontend with no build step. An independent project, not affiliated with
any society. See `ROADMAP.md` for what's live and what's next, and `CLAUDE.md` for how the code is laid out.

Branches: `main` is what runs at https://chza.me/dance/. `3d-dancers` is unfinished work (3D dancers, lesson
recordings, render pipeline), running at https://chza.me/dance-dev/. Don't deploy it until it's merged into `main`.

## Deploying (Charlie)

Production lives on the VPS in `/opt/dance` (a checkout of `main`), run by `docker compose` on 127.0.0.1:8031 behind
the chza.me Apache vhost (`deploy/apache-dance.conf`). Its settings are in `/opt/dance/.env` on the server, never in
git.

**From GitHub** (the usual way): merge into `main` on GitHub, then

```bash
ssh -p 984 root@chza.me /opt/dance/deploy/pull.sh
```

`pull.sh` refuses to run unless `/opt/dance` is on `main` with no local changes, fast-forwards to `origin/main`,
backs up the database to `data/backups/`, and rebuilds the container. The VPS talks to GitHub with its own key
(`/root/.ssh/id_ed25519`). Until this branch is merged, `main` doesn't have `pull.sh` yet; the same by hand:

```bash
ssh -p 984 root@chza.me 'cd /opt/dance && git pull --ff-only origin main && docker compose up -d --build'
```

**From your laptop** (the old way, still works): `./deploy/deploy.sh` pushes `HEAD` straight to the VPS checkout and
rebuilds. Push the same commit to GitHub too, so the two don't drift apart; if they do, `pull.sh` stops at the
fast-forward and you merge first.

**Checks after a deploy**: https://chza.me/dance/ loads, `docker compose ps` shows the app healthy, and
`docker compose logs --tail 50 app` is clean. New tables and columns are added on start (`schema.sql`,
`db.ADDED_COLUMNS`); the database is never reseeded.

**Roll back**: `git -C /opt/dance reset --hard <previous commit>` then `docker compose up -d --build`; restore a
database from `data/backups/` only if a migration went wrong (stop the app first).

**Dev copy**: `/opt/dance-dev` is a git worktree on `3d-dancers`; `/opt/dance-dev/deploy/dev.sh` (re)starts it
capped at half a CPU, with its own copy of the database (`--fresh` recopies live) and an amber DEV header.

The VPS has one CPU shared with other sites: run anything heavy through `deploy/limited.sh <command>`, and never render
videos there (`render/worker.mjs` is for a machine with a GPU).

## Developing locally

```bash
cd backend
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
cp .env.example .env            # then fill in what you need (below)
./venv/bin/python -m uvicorn main:app --reload --port 8021
```

Open http://localhost:8021. Make yourself an admin with `./venv/bin/python manage.py invite --admin` and follow the
link. Tests: `./venv/bin/python -m pytest -q tests`. With Docker instead: `docker compose up --build` (reads `.env`
in the repo root).

For the 3D dancers, put a rigged humanoid model at `frontend/models/dancer.glb` (or `frontend/models/dev-mannequin.glb`,
which git ignores); without one you get the simple built-in figures.

### Keys you'll need for your own development

- **Claude Platform API key** (`ANTHROPIC_API_KEY`), only if you work on the Claude features (routine planner, chart
  and lesson-note drafting). Create one in your own account on the Claude Platform
  (https://platform.claude.com → API keys). Use a separate key with a spend limit; never use or copy the production
  key. Without a key the app runs normally and the Claude buttons are hidden. `CLAUDE_MODEL` picks the model
  (default `claude-opus-5-5`); every call's tokens and estimated cost are logged per person in `ai_usage`.
- **`SESSION_SECRET`**: any long random string for local use
  (`python3 -c "import secrets; print(secrets.token_urlsafe(32))"`). Production refuses to start without a real one.
- **`RENDER_TOKEN`**: only if you run `render/worker.mjs` against your own server.

Nothing else is paid: lesson transcription runs locally (faster-whisper), and the 3D dancers draw in the browser.

### Terms and privacy

`/terms` and `/privacy` (`frontend/views/legal.js`) say what the site stores, who sees it and what goes to Anthropic.
When a feature starts storing or sending something new, update them (and the date) in the same change.

### Security notes

- Secrets live only in `.env` files, which git ignores. Don't commit databases (`data/` is ignored) or real members'
  data.
- Uploads are restricted to real video and audio types and served with `nosniff` and a sandboxing CSP. Password
  sign-in is throttled per address and per name. Pages send `X-Frame-Options`, `Referrer-Policy` and
  `Permissions-Policy`.
- The app shares the chza.me origin with the other apps on that domain, so a script injection bug in any of them could
  act on this one. Keep that in mind, or give it its own subdomain.
