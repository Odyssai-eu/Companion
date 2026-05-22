#!/usr/bin/env bash
set -euo pipefail

# Deploy current branch to a production host running the Companion container.
# Unlike deploy-dev, this rsyncs the working tree (no `git pull` on the
# host) — useful when the prod box has no GitHub access.
#
# Usage:
#   ./scripts/deploy-prod.sh [patch|minor|major|skip]
#   default: skip (no version bump on prod — bump happens on dev first)
#
# Configure via env vars:
#
#   COMPANION_PROD_HOST   SSH target, e.g. user@prod.example.com  (required)
#   COMPANION_PROD_DIR    Path on the host where the repo is checked out
#                         (required)
#   COMPANION_PROD_URL    URL printed at the end for verification
#                         (default: http://${COMPANION_PROD_HOST_NAME}:3000)

BUMP=${1:-skip}
HOST=${COMPANION_PROD_HOST:?Set COMPANION_PROD_HOST=user@your-prod-host}
APP_DIR=${COMPANION_PROD_DIR:?Set COMPANION_PROD_DIR=/path/on/host/to/companion}
VERIFY_URL=${COMPANION_PROD_URL:-"http://${HOST#*@}:3000"}

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

ssh "$HOST" "cd $APP_DIR && docker compose up -d --build && docker ps --filter name=thecompai --format 'table {{.Names}}\t{{.Status}}'"

echo ""
echo "→ deployed to $VERIFY_URL (prod)"
echo "  verify: curl -s $VERIFY_URL/api/health"
