#!/usr/bin/env bash
set -euo pipefail

# Deploy Companion to the dev host via an internal bare-repo mirror.
#
# Why this exists
# ───────────────
# The dev host's checkout (~/companion on .39) has `origin` pointing at
# GitHub over HTTPS, but no credential — so `git pull` from origin fails
# there. The old workaround was `git format-patch | scp | git am`, which
# re-creates commits with fresh SHAs and silently diverges the host's
# history from main. Painful and error-prone (2026-05-29).
#
# This flow keeps SHAs identical end to end:
#   1. local  → push main to a BARE repo on the dev host (over SSH, which
#               works — the maintainer's mac has key auth to the host).
#   2. host   → fetch from that bare repo via a LOCAL filesystem path
#               (no network, no GitHub credential) and hard-reset to it.
#   3. host   → docker compose up -d --build, health-check.
#
# Bare repo lives at $REMOTE_BARE on the host; the working checkout at
# $APP_DIR has it wired as the `localmirror` remote. Both are created on
# first run.
#
# Config (env vars, defaults reflect the maintainer's layout):
#   COMPANION_DEPLOY_HOST   SSH target of the dev host (default admin@192.168.86.39)
#   COMPANION_APP_DIR       working checkout path on the host (default ~/companion)
#   COMPANION_BARE          bare repo path on the host (default ~/git-repos/companion.git)
#
# Usage:
#   ./scripts/deploy-internal.sh           # push current main + build on host
#   git push origin main && ./scripts/deploy-internal.sh   # also publish to GitHub

HOST=${COMPANION_DEPLOY_HOST:-admin@192.168.86.39}
APP_DIR=${COMPANION_APP_DIR:-'~/companion'}
REMOTE_BARE=${COMPANION_BARE:-'/Users/admin/git-repos/companion.git'}

cd "$(dirname "$0")/.."

# Refuse to deploy a dirty tree — only committed work should reach the host.
DIRTY=$(git status --porcelain || true)
if [ -n "$DIRTY" ]; then
  echo "✗ Refusing to deploy — uncommitted changes:"
  echo "$DIRTY" | sed 's/^/  /'
  echo "  Commit (or stash) them first."
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
SHA=$(git rev-parse --short HEAD)

# Ensure the bare repo exists on the host.
ssh "$HOST" "[ -d $REMOTE_BARE ] || (mkdir -p \$(dirname $REMOTE_BARE) && git init --bare $REMOTE_BARE >/dev/null && echo 'created bare repo')"

# Ensure the `internal` remote points at the host bare repo.
if ! git remote get-url internal >/dev/null 2>&1; then
  git remote add internal "${HOST}:${REMOTE_BARE}"
fi

echo "→ pushing $BRANCH ($SHA) to internal bare repo on $HOST"
git push internal "$BRANCH"

echo "→ host: fetch from local mirror + reset + build"
ssh "$HOST" "cd $APP_DIR && \
  (git remote get-url localmirror >/dev/null 2>&1 || git remote add localmirror $REMOTE_BARE) && \
  git fetch localmirror && \
  git reset --hard localmirror/$BRANCH && \
  /usr/local/bin/docker compose up -d --build 2>&1 | tail -8 && \
  /usr/local/bin/docker ps --filter name=companion --format 'table {{.Names}}\t{{.Status}}'"

echo
echo "→ verifying health"
sleep 6
LIVE=$(ssh "$HOST" "curl -s --max-time 5 http://localhost:3100/api/health" 2>/dev/null || echo "")
echo "  $LIVE"
echo
echo "✓ deployed $SHA to $HOST"
