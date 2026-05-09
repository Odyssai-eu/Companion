#!/usr/bin/env bash
set -euo pipefail

# Deploy current branch to thecompai.lan (.39) prod.
# Usage: ./scripts/deploy-prod.sh [patch|minor|major|skip]
#   default: skip (no version bump on prod — bump happens on dev first)

BUMP=${1:-skip}
HOST=admin@192.168.86.39
APP_DIR=/Users/admin/thecompai/app

cd "$(dirname "$0")/.."

if [ "$BUMP" != "skip" ]; then
  NEW_VERSION=$(node scripts/bump-version.js "$BUMP")
  git add package.json
  git commit -m "chore: bump to v$NEW_VERSION"
  echo "→ bumped to v$NEW_VERSION"
fi

# rsync (since the prod host has no GitHub access)
rsync -a --delete \
  --exclude=node_modules --exclude=dist --exclude=".DS_Store" \
  --exclude="docker-compose.override.yml" --exclude=".env" \
  ./ \
  "${HOST}:${APP_DIR}/"

ssh "$HOST" "cd $APP_DIR && /opt/homebrew/bin/docker compose up -d --build && /opt/homebrew/bin/docker ps --filter name=thecompai --format 'table {{.Names}}\t{{.Status}}'"

echo ""
echo "→ deployed to http://192.168.86.39:3100 (prod)"
echo "  verify: curl -s http://192.168.86.39:3100/api/health"
