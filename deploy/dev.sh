#!/bin/sh
# Dev copy at https://chza.me/dance-dev/ (container dance-dev on 127.0.0.1:8033): runs this checkout's working tree
# with auto-reload, on its own copy of the database in data/dev. `deploy/dev.sh --fresh` recopies the live database.
# No Claude API key here, so nothing in dev costs money. Capped (CPU, memory, processes) so it can't starve the
# live sites on this one-CPU VPS. Apache: see deploy/apache-dance.conf.
set -e
cd "$(dirname "$0")/.."
mkdir -p data/dev && chmod a+rwX data/dev
if [ "$1" = "--fresh" ] || [ ! -f data/dev/dance.db ]; then
  rm -f data/dev/dance.db data/dev/dance.db-wal data/dev/dance.db-shm
  docker exec dance-app-1 python -c "import sqlite3; sqlite3.connect('/app/data/dance.db').backup(sqlite3.connect('/app/data/dev/dance.db'))"
  echo "Copied the live database into data/dev"
fi
[ -f data/dev/secret ] || head -c 24 /dev/urandom | base64 > data/dev/secret
[ -f data/dev/render-token ] || head -c 18 /dev/urandom | base64 | tr '+/' '-_' > data/dev/render-token
docker rm -f dance-dev >/dev/null 2>&1 || true
docker run -d --name dance-dev --restart unless-stopped -p 127.0.0.1:8033:8033 \
  --cpus 0.5 --cpu-shares 256 --memory 600m --memory-swap 800m --pids-limit 200 \
  -v "$PWD/backend:/app/backend:ro" -v "$PWD/frontend:/app/frontend:ro" -v "$PWD/data/dev:/app/data" \
  -e DB_PATH=/app/data/dance.db -e UPLOAD_DIR=/app/data/uploads -e BASE_PATH=/dance-dev \
  -e ORIGIN=https://chza.me -e RP_ID=chza.me -e SECURE_COOKIES=true -e AI_ACCESS=admin -e ENV_LABEL=dev \
  -e SESSION_SECRET="$(cat data/dev/secret)" -e RENDER_TOKEN="$(cat data/dev/render-token)" \
  rise-and-fall:latest python -m uvicorn main:app --host 0.0.0.0 --port 8033 --reload --proxy-headers --forwarded-allow-ips "*" >/dev/null
echo "dance-dev running on 127.0.0.1:8033 → https://chza.me/dance-dev/ (render token in data/dev/render-token)"
