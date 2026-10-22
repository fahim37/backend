#!/usr/bin/env bash
# Updates the running API from GitHub. Run on the server from the repo folder:
#   ./deploy.sh
# Keeps .env (not in git), rebuilds dist/ and restarts the pm2 app.
set -euo pipefail
cd "$(dirname "$0")"

APP="${PM2_APP:-srsit-api}"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)"

git pull --ff-only
npm ci --no-audit --no-fund          # dev dependencies are needed to compile TypeScript
npm run build
npm prune --omit=dev --no-audit --no-fund

pm2 restart "$APP" --update-env
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT:-4100}/api/health"; then echo; exit 0; fi
  sleep 1
done
echo "API did not become healthy — check: pm2 logs $APP" >&2
exit 1
