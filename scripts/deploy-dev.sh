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
