#!/bin/sh
# Production update from GitHub, run on the VPS: fast-forward /opt/dance to origin/main and rebuild.
#   ssh -p 984 root@chza.me /opt/dance/deploy/pull.sh
# Refuses if the checkout isn't on main or has local changes, so nothing unfinished goes live by accident.
set -e
cd "$(dirname "$0")/.."
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "Not on main: refusing to deploy"; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo "Local changes in $(pwd): refusing to deploy"; exit 1; }
git fetch origin main
git merge --ff-only origin/main
mkdir -p data/backups && chown 1000:1000 data/backups && chmod 700 data/backups   # the app runs as uid 1000
docker exec dance-app-1 python -c "import sqlite3; sqlite3.connect('/app/data/dance.db').backup(sqlite3.connect('/app/data/backups/dance-$(date +%Y%m%d-%H%M%S).db'))" 2>/dev/null \
  && echo "Database backed up to data/backups" || echo "No running app to back up (first deploy?)"
ls -1t data/backups/dance-*.db 2>/dev/null | tail -n +11 | xargs -r rm -f     # keep the ten newest (privacy notice)
nice -n 10 docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null
docker compose ps
