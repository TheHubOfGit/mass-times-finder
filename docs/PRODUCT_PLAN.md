# Mass Times Finder — Product Plan

2026-10-12 · Region: **NYC (5 boroughs) + Long Island** (`nyc-li`, ZIP prefixes 100–104, 110–119). App: `masstimes` on workers.dev. · Supersedes the stack and milestones in the original handoff (Postgres/FastAPI/Next.js). Data-use commitments in `CLAUDE.md` are unchanged and apply to both products.

## Two products, one backend

| Product | Who it's for | Answers |
| --- | --- | --- |
| **Agent tools**: a remote MCP server plus a `masstimes` CLI | The owner's AI agents (Claude Code, Claude.ai, other MCP clients) | "What's the nearest and next Mass?", "Confession near Garden City on Saturday?", "Spanish Mass tonight near me?" |
| **Web app**: an installable PWA | People on their phones, the owner on Android first | Nearby, Map and Search modes with every filter the data supports |

Both read from the same API. Neither one ever calls MassTimes. Only the scheduled sync does.

```text
MassTimes.org ──(weekly, throttled, GitHub Actions)──> Python sync ──> Cloudflare D1
                                                                          │
                                  Cloudflare Worker (one deploy, free tier)│
                                  ├── /v1/*   JSON API  <─────────────────┘
                                  ├── /mcp    remote MCP server (same functions as the API)
                                  └── /*      PWA static assets
                                         ▲                ▲
                              masstimes CLI          Browser / installed PWA
```

## Why this stack (Cloudflare free tier)

| Part | Choice | Why |
| --- | --- | --- |
| Hosting | **One Cloudflare Worker with static assets** | API, MCP and web on one origin and one deploy; free plan; no CORS |
| Database | **D1** (SQLite) | Free; enough for national scale if we write carefully (see below). Replaces PostGIS: a bounding box on indexed `lat`/`lng`, then exact distance in the Worker, is plenty at this size |
| API router | **Hono** (TypeScript) | Small, fast, built for Workers |
| MCP | **Cloudflare Agents SDK, stateless `createMcpHandler`** at `/mcp` | Remote MCP over Streamable HTTP. Usable from Claude Code, Claude.ai and the Claude Android app with no local install |
| Sync | **Python** (the existing `sync/client.py`), run by a **GitHub Actions cron** | A Worker can't do it: the free plan caps subrequests and CPU per invocation, and a polite 1–2 s throttle over thousands of requests takes hours |
| Web | **Vite + React + TypeScript + Tailwind**, `vite-plugin-pwa` | Static build that fits Workers assets; good PWA tooling |
| Map | **MapLibre GL + OpenFreeMap vector tiles** | Free, no API key, sharp and themeable (light/dark). Avoids the OSM tile-server usage policy and Google costs |
| Geocoding | **Photon** (komoot) for search-as-you-type, **Nominatim** for fallback, both proxied through `/v1/geocode` and cached in D1 | Free; caching keeps us within their usage policies; the browser never calls them directly |
| CLI | **TypeScript, published to npm** (`npx masstimes …`) | Calls the public API, so any agent with a shell can use it |

Free-tier limits to check at build time (they change): Workers requests per day, CPU ms per request, D1 rows read and written per day, D1 storage, Cron triggers.

### The D1 write budget shapes the schema

A national sync is about 17k US churches and about 350k service rows. Rewriting every service row each week would blow the free daily write limit. So:

- **Services are stored as a JSON column on the church row**, plus a few summary columns for SQL pre-filtering. That's one row per church.
- **Each row carries a `content_hash`.** The sync only rewrites churches whose hash changed, which is typically a few hundred a week.
- `last_seen_at` is bumped in batched `UPDATE … WHERE id IN (…)` statements. If that alone gets near the limit, we track "seen" per sync run instead.

## Data model (D1)

```sql
CREATE TABLE churches (
  id                TEXT PRIMARY KEY,          -- our stable UUID
  match_key         TEXT UNIQUE NOT NULL,      -- normalized name + coords rounded to 3 dp
  source_id         TEXT,                      -- MassTimes id: a hint only, never a key
  name TEXT NOT NULL, street TEXT, city TEXT, state TEXT, postal_code TEXT,
  county TEXT, country TEXT,
  lat REAL NOT NULL, lng REAL NOT NULL,
  timezone          TEXT NOT NULL,             -- from coordinates, computed during sync (timezonefinder)
  diocese TEXT, diocese_type TEXT,             -- Diocese / Archdiocese / Eparchy
  rite TEXT, church_type TEXT, primary_language TEXT,
  phone TEXT, email TEXT, website TEXT,        -- website normalized to include https://
  wheelchair INTEGER,                          -- 1/0/NULL
  comments TEXT, directions TEXT, pastor TEXT,
  services_json     TEXT NOT NULL,             -- normalized services (below)
  languages         TEXT,                      -- '|English|Spanish|' for LIKE pre-filter
  service_types     INTEGER,                   -- bitmask: mass, confession, adoration, devotions, holyday
  has_perpetual_adoration INTEGER,
  source_updated_at TEXT, first_seen_at TEXT, last_seen_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  content_hash      TEXT NOT NULL,
  coord_suspect     INTEGER DEFAULT 0          -- coords far from the city or postal code
);
CREATE INDEX churches_lat_lng ON churches(lat, lng);
CREATE VIRTUAL TABLE churches_fts USING fts5(name, city, diocese, content='churches');
CREATE TABLE geocode_cache (q TEXT PRIMARY KEY, result_json TEXT, fetched_at TEXT);
CREATE TABLE sync_runs (id INTEGER PRIMARY KEY, started_at TEXT, finished_at TEXT,
  region TEXT, requests INTEGER, churches_seen INTEGER, churches_changed INTEGER, errors TEXT);
```

A normalized service (one entry in `services_json`):

```json
{"kind": "mass", "source_type": "Weekend", "days": [0], "start": "09:00", "end": null,
 "language": "Polish", "comment": "First Fri.", "perpetual": false, "holy_day": false, "vigil": false}
```

Normalization rules, from the live data:

- **`kind`** comes from `service_typename`. `Weekend`, `Week Days`, `Holy Days` and `Vigil for Holy Days` all become `mass`. `Confessions` becomes `confession`, `Adorations` becomes `adoration` and `Devotions` becomes `devotion`.
- **`days`** uses 0 = Sunday … 6 = Saturday. `"Weekdays"` becomes `[1,2,3,4,5]` and `null` becomes `[]`. Holy Days rows keep `days` but are only scheduled on holy-day dates.
- **Times** are `"HH:MM"`; `""` becomes `null`. Strings are trimmed, and `comment` is kept verbatim.

## API (`/v1`)

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/upcoming?lat&lng[&radius_mi][&from][&kind][&lang][&rite][&church_type][&wheelchair][&limit]` | **The core query.** Expands each nearby church's schedule into concrete occurrences in the church's own time zone, starting at `from` (default now) and running 7 days, then sorts them by start time. Each result includes distance and a rough travel estimate |
| `GET /v1/next?lat&lng[…filters]` | **The agent answer.** `{soonest, nearest, alternatives[]}`. *Soonest* is the earliest occurrence you can still reach, given the travel estimate plus a buffer. *Nearest* is the next occurrence at the closest church. *Alternatives* are 3 more options |
| `GET /v1/churches/search?lat&lng&radius_mi \| bbox \| q` + filters | Churches near a point, in the map's visible box, or by name/city full-text search |
| `GET /v1/churches/:id` | One church with its full weekly schedule |
| `GET /v1/geocode?q` / `GET /v1/reverse?lat&lng` | Address, ZIP or place name to coordinates, and back (proxied and cached) |
| `GET /v1/facets?lat&lng&radius_mi` | Languages, rites and church types present near a point, so filter chips only show options that exist |
| `GET /v1/meta` | Last sync time, church count, coverage regions, US holy days for the next 12 months |

Every church payload includes `source: {name: "MassTimes.org", url, last_updated}` and a `confirm_note`.

**Holy days:** the Worker carries a small US holy-days-of-obligation calendar, with Easter computed (computus) and Ascension transferred to Sunday as in most US provinces. On those dates `upcoming` uses the Holy Days and Vigil rows. Every other day it skips them.

**Seasonal comments** (like "mid-September to mid-June only") can't be parsed reliably. Those occurrences carry `note` and `seasonal: true`, and both the UI and the agents show a "check with the parish" flag.

## Product 1: agent tools

### Remote MCP server (`https://<app>/mcp`)

| Tool | Inputs | Returns |
| --- | --- | --- |
| `next_mass` | `location` (address, place or "lat,lng"), optional `kind` (default mass), `language`, `rite`, `after` (ISO datetime or "tonight", "tomorrow morning"), `radius_mi` | Soonest and nearest, as one human-readable paragraph plus structured data |
| `find_services` | `location`, `kind`, `day`/`date`, time range, filters, `limit` | Ranked list of occurrences |
| `search_churches` | `query` (name or city) or `location` + filters | Church list |
| `church_details` | `church_id` | Full schedule, contact details, directions link |

Every tool response ends with "Source: MassTimes.org · last updated {date} · confirm times with the parish." It's read-only with no auth. A per-IP rate limit (Workers rate-limiting binding) protects the free quota.

**Location for agents.** Agents don't have GPS, so `location` is required unless a default is configured:

- The CLI reads `~/.config/masstimes/config.json`, which holds `home`, `work`, etc.
- The MCP tool descriptions tell the model to ask the user or use known context.

So "nearest Mass" answers from the owner's saved home unless told otherwise.

### CLI (`masstimes`)

```text
masstimes next   [--near "Hempstead, NY" | --at 40.7,-73.6 | --place home] [--lang Spanish] [--kind confession] [--json]
masstimes find   --near … --day sat --after 15:00 --kind confession [--json]
masstimes church <id | "St. Agnes Rockville Centre">
masstimes places add home "123 Main St, Hempstead NY"
```

The CLI prints readable output by default and stable JSON with `--json`, which is what agents should use.

## Product 2: web app (PWA)

**Look and feel:** warm and calm, not churchy-kitsch. Large tap targets, a bottom tab bar on mobile, a side panel on desktop, light and dark themes, and fast first paint. We'll use the `impeccable` design skill during the build.

| Mode | What it does |
| --- | --- |
| **Nearby** (default tab) | Asks for location once. Shows a "Next up" hero card: the soonest reachable Mass, its distance and a Directions button. Below it, a timeline of upcoming services grouped *Now / Next hour / Later today / Tomorrow*. Sort by soonest or nearest |
| **Map** | Full-bleed MapLibre map with clustered pins, colored by the soonest upcoming service. A "Search this area" button appears after panning. On mobile a bottom sheet holds a draggable list; on desktop a side list syncs with the map |
| **Search** | Location box with autocomplete (address, ZIP, city, landmark); church name search; **saved places** (Home, Work, Grandma's, kept on the device); recent searches. Picking a result sets the location for Nearby and Map |
| **Church page** | Schedule by day, with tabs for Mass, Confession, Adoration and Devotions. Highlights today and the next occurrence. Seasonal notes, call/website/directions (opens Google Maps on Android), share link, last-updated date, the confirm note, a link to the MassTimes listing and a "Report an error" link to the MassTimes update form |

### Filters (everything the data supports)

| Filter | Values come from |
| --- | --- |
| Service | Mass · Confession · Adoration (incl. perpetual) · Devotions · Holy Day Masses |
| When | Now/next few hours · Today · Tomorrow · this Sunday (incl. Saturday vigil) · pick a date · time-of-day range |
| Language | Service language, falling back to church language. Chips come from `/v1/facets` |
| Rite | Roman-Latin, Byzantine, Ukrainian, Maronite, Syro-Malabar, … (from facets) |
| Church type | Parish, chapel, shrine, hospital, campus ministry, … (from facets) |
| Accessibility | Wheelchair accessible |
| Distance | Radius slider (1–50 mi) and mi/km units |
| Diocese | From facets |
| Text | Church name or city |

**Also included:**
- **Shareable URL state:** every view and filter set is a link.
- **Settings:** 12/24-hour time, mi/km, default radius, theme.
- **Favorites, kept on the device:** star a church and see its next Mass on the Nearby screen. No accounts, consistent with v1 scope.
- **Footer on every view:** "Data from MassTimes.org" with a link, plus a donate link.

**PWA behavior:**
- Installable, with manifest, icons and a maskable icon.
- Works offline: app shell cached, last results and viewed or favorited churches cached for offline viewing, with a "last updated" banner.
- Geolocation uses a permission prompt with a clear explanation. If the user declines, it falls back to Search.

## Milestones (replaces M2–M6 in the handoff)

| # | Deliverable | Done when |
| --- | --- | --- |
| **M2 Data** ✅ | Python normalizer and tests (from `docs/sample-response.json`); D1 migrations; sync writes the first region to a **local** D1 via `wrangler` | `wrangler d1 execute --local` shows the region's churches with correct schedules; 10 spot-checks against masstimes.org pass |
| **M3 API + MCP** ✅ (local) | Worker with `/v1/*` and `/mcp`; schedule expansion with time zones and holy days; tests (midnight rollover, Weekdays expansion, holy-day dates, cross-time-zone) | `next_mass` answers correctly from Claude Code against `wrangler dev` |
| **M4 CLI** ✅ (local) | `masstimes` CLI (no deps) with saved places and `--json` | Agent can answer "nearest and next Mass" via the CLI |
| **M5 Web app** | Nearby, Map, Search and Church page; all filters; PWA install and offline | Installed on the owner's Android; Lighthouse PWA and accessibility checks pass |
| **M6 Launch** | Deploy Worker and D1; GitHub Actions weekly sync to remote D1 (after MassTimes OKs the Referer header); expand region; failure alerts (Actions email + `/v1/meta` freshness check) | Live URL shown to MassTimes before announcing |

## Decisions (2026-10-12)

- [x] **Coverage:** NYC + Long Island first. Full crawl: 260 grid points, 282 requests, ~7 min, 535 churches.
- [x] **Web:** React (Vite + Tailwind + MapLibre).
- [x] **Name:** Worker `masstimes`. The URL will be `masstimes.<account-subdomain>.workers.dev`; workers.dev always includes the account's subdomain.
- [x] **MCP:** public and read-only, rate-limited per IP (30 req/min MCP, 120 req/min API).
- [x] **Dropped `masstimes mcp` stdio bridge.** Claude Code, Claude.ai and the Claude apps connect to the remote `/mcp` directly.
- [x] **No `raw_responses` table.** Raw pages are cached as gzipped files under `data/raw/<run>/` (keeps D1 writes down; re-parse with `--offline`).

## Implementation notes

- **Crawl:** square grid (5 mi cells). Each cell center pages outward until the last result is past the half-diagonal (3.8 mi), which guarantees coverage. Densest point (LIC): 4 pages.
- **Load:** the first load is 535 inserts. An unchanged re-load is 4 statements total.
- **Schedule expansion CPU** (150 churches): 1.5 ms for 2 days, 2 ms for 7 days, after precomputing the calendar and caching zone offsets. The free plan allows 10 ms.
- **Report-an-error link:** `https://updateparishdata.org/UpdateChurchInfo.aspx?churchid={source_id}` (found on masstimes.org).
