#!/usr/bin/env bash
set -euo pipefail

# Deploy current branch to rpi-dev.
# Usage: ./scripts/deploy-dev.sh [patch|minor|major|skip]
#   patch (default) / minor / major: bump package.json then push then deploy
#   skip: don't bump, just push + deploy whatever is committed

BUMP=${1:-patch}
HOST=admin@192.168.86.18
APP_DIR='~/thecompai/app'

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

# Pull + rebuild on rpi-dev
ssh "$HOST" "cd $APP_DIR && git pull && docker compose up -d --build 2>&1 | tail -10 && docker ps --filter name=thecompai --format 'table {{.Names}}\t{{.Status}}'"

echo ""
echo "→ deployed to https://dev.thecomp.ai"
echo "  verify: curl -s https://dev.thecomp.ai/api/health"
