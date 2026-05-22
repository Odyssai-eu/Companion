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
HOST=${COMPANION_DEPLOY_HOST:?Set COMPANION_DEPLOY_HOST=user@your-dev-host}
APP_DIR=${COMPANION_DEPLOY_DIR:-'~/companion'}
VERIFY_URL=${COMPANION_DEPLOY_URL:-"https://${HOST#*@}"}

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

git push

# Pull + rebuild on the dev host
ssh "$HOST" "cd $APP_DIR && git pull && docker compose up -d --build 2>&1 | tail -10 && docker ps --filter name=companion --format 'table {{.Names}}\t{{.Status}}'"

echo ""
echo "→ deployed to $VERIFY_URL"
echo "  verify: curl -s $VERIFY_URL/api/health"
