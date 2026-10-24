#!/usr/bin/env bash
# Deploy from the laptop: push to the VPS checkout (receive.denyCurrentBranch=updateInstead) and rebuild there.
#   ./deploy/deploy.sh
# Reuses one SSH connection: the VPS firewall rate-limits new ones.
set -euo pipefail
cd "$(dirname "$0")/.."
CP=~/.ssh/cm-chza
SSH="ssh -o ControlMaster=auto -o ControlPath=$CP -o ControlPersist=10m -p 984"
GIT_SSH_COMMAND="$SSH" git push vps HEAD:main
$SSH root@chza.me "cd /opt/dance && docker compose up -d --build --remove-orphans && docker image prune -f >/dev/null && docker compose ps"
