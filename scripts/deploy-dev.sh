#!/usr/bin/env bash
set -euo pipefail

# Deploy current branch to a dev host running the Companion container.
#
# Usage:
#   ./scripts/deploy-dev.sh [patch|minor|major|skip]
#
#   patch (default) / minor / major: bump package.json then push then deploy
#   skip: don't bump, just push + deploy whatever is committed
#
# Configure your deploy target via env vars (put them in your shell rc
# or a local `.env.deploy` you source before running):
#
#   COMPANION_DEPLOY_HOST   SSH target, e.g. user@dev.example.com  (required)
#   COMPANION_DEPLOY_DIR    Path on the host where this repo is checked out
#                           (default: ~/companion)
#   COMPANION_DEPLOY_URL    URL the script prints at the end for verification
#                           (default: https://${COMPANION_DEPLOY_HOST_NAME})

BUMP=${1:-patch}

# Deploy chain for this install (override any of these via env):
#   1. push the branch to the `internal` bare repo that lives ON the host
#      (github `origin` is the public, depersonalised mirror — the internal
#      code ships to the bare repo, NOT github);
#   2. the host checkout pulls from its `localmirror` of that bare repo;
#   3. rebuild ONLY the `app` service. The compose file also declares a
#      `nemo-memory` service that collides on :8765 with the host-process
#      nemo (the live LightRAG), so a full `compose up` fails — we target
#      `app` alone. See doc: nemo runs as a host process, not a container.
HOST=${COMPANION_DEPLOY_HOST:-admin@192.168.86.39}
APP_DIR=${COMPANION_DEPLOY_DIR:-/Users/admin/companion}
PUSH_REMOTE=${COMPANION_PUSH_REMOTE:-internal}
PULL_REMOTE=${COMPANION_HOST_PULL_REMOTE:-localmirror}
SERVICE=${COMPANION_DEPLOY_SERVICE:-app}
DOCKER=${COMPANION_DEPLOY_DOCKER:-/usr/local/bin/docker}  # not on the non-interactive ssh PATH
# The LIVE containers on .39 run in the `desktop-linux` docker context, NOT the
# default (colima). Without --context the build/up hit colima and build a
# phantom that never serves — a silent stale-deploy (learned 2026-07-02, cost
# a full chase). Always target the live context explicitly.
CONTEXT=${COMPANION_DEPLOY_CONTEXT:-desktop-linux}
VERIFY_URL=${COMPANION_DEPLOY_URL:-http://192.168.86.39:3100}

cd "$(dirname "$0")/.."

# ── Pre-flight: refuse to deploy when there are uncommitted code changes ──
#
# The script only auto-commits `package.json` (the version bump). Anything
# else in the working tree won't get pushed and won't reach the server,
# producing a "deployed bundle is missing your code" silent failure.
#
# We learned this the hard way 2026-05-20/21: five back-to-back deploys
# shipped nothing but version bumps because the feature code (router add-on,
# saved-prompts library) was sitting uncommitted in the working tree. Now
# we abort with a clear list of what to commit first.
#
# Escape hatch: `git stash` before running, then `git stash pop` after.
# Or commit the changes (recommended).
DIRTY=$(git status --porcelain | grep -v -E '^.M package\.json$' || true)
if [ -n "$DIRTY" ]; then
  echo "✗ Refusing to deploy — uncommitted changes detected:"
  echo
  echo "$DIRTY" | sed 's/^/  /'
  echo
  echo "  The script only auto-commits package.json (the version bump);"
  echo "  these other changes won't reach the server."
  echo
  echo "  Fix: commit them, or 'git stash' to set them aside."
  exit 1
fi

if [ "$BUMP" != "skip" ]; then
  NEW_VERSION=$(node scripts/bump-version.js "$BUMP")
  git add package.json
  git commit -m "chore: bump to v$NEW_VERSION"
  echo "→ bumped to v$NEW_VERSION"
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
git push "$PUSH_REMOTE" "$BRANCH"

# Pull from the host's local mirror of the bare repo, then rebuild ONLY the
# app service (never the whole compose — see the header note on nemo-memory).
#
# Two non-interactive-ssh traps, both learned in prod:
#   - Docker Desktop's credential helper (docker-credential-desktop) lives
#     under the app bundle, NOT on the bare ssh PATH. ~/.docker/config.json
#     declares it as credsStore, so any cold base-image resolve (e.g. first
#     build after a reboot) dies with "error getting credentials".
#   - `| tail` swallows the build's exit code, so a failed build still
#     printed "deployed" while the container kept running the OLD image.
#     pipefail on the remote shell + set -e here make the failure loud.
REMOTE_PATH='/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin'
ssh "$HOST" "set -o pipefail; export PATH=\"$REMOTE_PATH:\$PATH\"; cd $APP_DIR && git pull $PULL_REMOTE $BRANCH && $DOCKER --context $CONTEXT compose up -d --build $SERVICE 2>&1 | tail -12 && $DOCKER --context $CONTEXT ps --filter name=companion --format 'table {{.Names}}\t{{.Status}}'"

echo ""
# ── Blocking post-deploy verify ──────────────────────────────────────────
# The deployed /health MUST report the version we just shipped. A mismatch
# means the build never reached the live container (wrong docker context,
# build cache, or a missed rebuild) — exactly the silent failure of
# 2026-07-02. Fail loud instead of printing a false "deployed".
if [ "$BUMP" != "skip" ] && [ -n "${NEW_VERSION:-}" ]; then
  sleep 5
  LIVE=$(curl -s "$VERIFY_URL/api/health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
  if [ "$LIVE" != "$NEW_VERSION" ]; then
    echo "✗ DEPLOY VERIFY FAILED — /health reports v${LIVE:-?}, expected v$NEW_VERSION."
    echo "  The build did not reach the live container. Check docker context"
    echo "  (should be '$CONTEXT') and that the app image was actually rebuilt."
    exit 1
  fi
  echo "✓ verified live: v$LIVE"
fi
echo "→ deployed to $VERIFY_URL"
