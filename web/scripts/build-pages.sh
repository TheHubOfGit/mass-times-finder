#!/usr/bin/env bash
# Build the Cloudflare Pages output: PWA in web/dist + the API/MCP Worker bundled as dist/_worker.js.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/web"
npm run build
cd "$ROOT/worker"
rm -rf .pages-bundle
npx wrangler deploy --dry-run --outdir .pages-bundle >/dev/null
cp .pages-bundle/index.js "$ROOT/web/dist/_worker.js"
# Only API and MCP requests invoke the Worker; everything else is served as static assets (free, cached).
cat > "$ROOT/web/dist/_routes.json" <<'JSON'
{ "version": 1, "include": ["/v1/*", "/mcp", "/mcp/*"], "exclude": [] }
JSON
echo "Built web/dist ($(du -sh "$ROOT/web/dist" | cut -f1)), _worker.js $(du -h "$ROOT/web/dist/_worker.js" | cut -f1)"
