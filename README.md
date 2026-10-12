# Mass Times Finder

**Live:** https://masstimes.pages.dev · MCP: `https://masstimes.pages.dev/mcp`

Find the nearest and next Catholic Mass, confession or adoration, anywhere MassTimes lists churches (NYC + Long Island preloaded; other areas fetched live and cached for 24 h). Data is from [MassTimes.org](https://masstimes.org), used with written permission. See `CLAUDE.md` for the commitments and `docs/PRODUCT_PLAN.md` for the design.

| Folder | What |
| --- | --- |
| `sync/` | Python: throttled MassTimes client, normalizer, region crawler, D1 diff loader |
| `db/migrations/` | D1 (SQLite) schema |
| `worker/` | Cloudflare Worker: JSON API at `/v1`, remote MCP server at `/mcp`, and later the PWA |
| `cli/` | `masstimes` command-line tool (no dependencies, Node ≥ 20) |
| `tests/` | Python tests (`worker/test/` holds the TypeScript tests) |

## Setup

```bash
python3 -m venv .venv && .venv/bin/pip install -r sync/requirements.txt
cd worker && npm install && npm run db:migrate:local
```

## Sync data (local)

```bash
# Crawl NYC + Long Island (~7 min, ~280 polite requests). The Referer flag is pending MassTimes' written OK; see CLAUDE.md.
MASSTIMES_SEND_REFERER=1 .venv/bin/python -m sync.crawl --region nyc-li
# Re-parse cached pages without fetching:
.venv/bin/python -m sync.crawl --region nyc-li --run-dir data/raw/<run> --offline
# Load into the local D1, writing only what changed:
.venv/bin/python -m sync.load data/churches-nyc-li.json --local
```

## Run the API and MCP server locally

```bash
cd worker && npx wrangler dev --port 8790
curl "localhost:8790/v1/next?near=Hempstead,%20NY"
```

Connect Claude Code to the local MCP server:

```bash
claude mcp add --transport http masstimes http://localhost:8790/mcp
```

Then ask "what's the nearest and next Mass to Hofstra?". After deploy, use `https://masstimes.<subdomain>.workers.dev/mcp`.

## CLI

```bash
export MASSTIMES_API=http://localhost:8790      # or: cli/bin/masstimes.mjs config api <url>
cli/bin/masstimes.mjs places add home "123 Main St, Hempstead NY"
cli/bin/masstimes.mjs next                      # nearest + next Mass from home
cli/bin/masstimes.mjs find --near "Park Slope" --kind confession --date saturday
cli/bin/masstimes.mjs church "St. Agnes Rockville Centre"
cli/bin/masstimes.mjs next --json               # for agents
```

## Deploy (Cloudflare Pages)

```bash
cd web && npm run deploy          # builds the PWA + bundles the Worker as dist/_worker.js, then wrangler pages deploy
```

Production D1 settings live in `web/wrangler.jsonc`. Apply new migrations with
`cd web && npx --prefix ../worker wrangler d1 migrations apply masstimes --remote`, and load data with
`.venv/bin/python -m sync.load data/churches-nyc-li.json --remote`.

## Tests

```bash
.venv/bin/python -m pytest tests
cd worker && npm test && npm run typecheck
```

## API (`/v1`)

| Endpoint | Purpose |
| --- | --- |
| `GET /next` | Next service that hasn't started, and the next one at the closest church |
| `GET /upcoming` | Upcoming services sorted by start time |
| `GET /churches/search` | By `q` (name/town), `bbox`, or `lat`/`lng` + `radius_mi` |
| `GET /churches/:id` | Full schedule and details |
| `GET /facets` | Languages, rites, church types and dioceses near a point |
| `GET /geocode`, `GET /reverse` | Place search (Photon/Nominatim, cached) |
| `GET /meta` | Church count, last sync, upcoming holy days |

Location: `lat`+`lng`, or `near=<address>`. Filters: `kind` (mass, confession, adoration, devotion, comma-separated), `lang`, `rite`, `church_type`, `diocese`, `wheelchair=1`, `perpetual=1`, `radius_mi`, `date` (YYYY-MM-DD), `after`/`before` (HH:MM), `from` (ISO), `days`, `limit`.
