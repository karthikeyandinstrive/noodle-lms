#!/bin/sh
# Fresh embedded database + seed, then API and web on the E2E ports.
set -e
export PGLITE_DIR="$(pwd)/.data/pglite-e2e"
export SEED_PASSWORD="${SEED_PASSWORD:-E2ePassword123}"
rm -rf "$PGLITE_DIR"
npm run db:migrate --silent
npm run db:seed --silent

export PORT="${E2E_API_PORT:-4200}"
export APP_URL="http://localhost:${E2E_WEB_PORT:-3200}"
export API_URL="http://localhost:${E2E_API_PORT:-4200}"
exec npx concurrently -k -n api,web \
  "npm run dev -w @lms/api" \
  "npx -w @lms/web next dev --port ${E2E_WEB_PORT:-3200}"
