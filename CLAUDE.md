# Mass Times Finder — Claude Code Handoff

Oct 12, 2026 · @Someone

## Project goal

Build a web app where people find Catholic Mass times by church, starting with one region and growing to national coverage. Data comes from MassTimes.org, synced into our own database, served by our own API, and shown on a map-and-list frontend.

How to use this doc (Claude Code):

- Save it in the repo root as `CLAUDE.md` (or `HANDOFF.md` referenced from `CLAUDE.md`) so every session starts with this context.
- Work through the milestones in order. Do not start Milestone 2 until Milestone 1's endpoint is confirmed.
- Record decisions and progress in the log at the bottom. Keep this file current; it is the source of truth between sessions.
- Ask the owner before changing anything in "Permission and data-use commitments".

## Permission and data-use commitments

We have written permission from MassTimes to build on their website's data. Their site states that church and service data are copyright Mass Times Trust and need written permission to use, so this permission matters ([MassTimes about page](https://masstimes.org/components/about/about.html)).

| Date | From | What they said |
| --- | --- | --- |
| 2026-10-12, 10:42 AM | MassTimes (contact on file with the owner) | Granted "full access" |
| 2026-10-12, 10:45 AM | MassTimes (contact on file with the owner) | No API key or API service exists; free to build whatever we want based on the website |

The owner keeps these emails. Courtesy rules we committed to, which the code must follow:

- Throttle: at most 1 request every 1–2 seconds, one request at a time, no parallel bursts.
- ~~Sync on a schedule (nightly or weekly), never per end-user request.~~ **Changed 2026-10-12 by the owner:** MassTimes' "full access / build whatever you want" permission covers live requests. The Worker may fetch MassTimes on demand for areas not fetched in the last 24 h (cached in D1, sequential pages, global outbound cap, falls back to cached data). The frontend still never calls MassTimes directly; only the Worker and the sync job do.
- Identify the app in the User-Agent, e.g. `MassTimesFinder/0.1 (contact: <owner email>)`.
- Credit and link to MassTimes.org on every results view and church page.
- Show each church's last-updated date and a note to confirm times with the parish.
- Plan a way to send corrections back to MassTimes rather than silently diverging.

## Data source: MassTimes

**Confirmed 2026-10-12** (captured from the site's own traffic in a browser):

```text
GET https://masstimes.org/Churchs/?lat={lat}&long={lng}&pg={page}
```

- No API key, no special headers. Returns a JSON array of up to 30 churches ordered by distance.
- **Paging works**: `pg=2` returns results 31–60 (no overlap; `resultID` continues at 31). So the 30-result cap is per page, not per point.
- **Blocked for non-browser clients**: the same URL from Python (`httpx`, honest `MassTimesFinder/0.1` User-Agent) returns `403 Forbidden` from Netlify's edge (`server: Netlify`, body `403 Forbidden`). We will not spoof a browser to get around it — that would break the User-Agent commitment and evade their bot protection. **Blocked on MassTimes allowlisting our User-Agent (or telling us the intended access path).**
- **Trigger found (2026-10-12):** the check is on `Referer`. Our honest `MassTimesFinder` User-Agent + `Referer: https://masstimes.org/` → 200; a Chrome User-Agent without it → 403 (repeated with the same results). `sync/client.py` can send it via `MASSTIMES_SEND_REFERER=1`, **off by default until MassTimes confirms in writing** that sending it is OK, since the rule looks deliberate.
- Sample: `docs/sample-response.json` (curated subset, captured in-browser).

Differences from the V4 docs (the live data wins):

- `day_of_week` is a **space-padded name**: `"Sunday    "` … `"Saturday  "`, `"Weekdays  "` (Mon–Fri), or `null`. No numeric days, no `99` seen.
- `time_start` / `time_end` are `"HH:MM:SS"` (24h) or `""`. No `1/1/1900` prefix. Perpetual adoration has `day_of_week: null`, `time_start: ""`, `is_perpetual: true`.
- `last_update` is `"M/D/YYYY h:mm:ss AM/PM"` (US Eastern assumed — verify).
- Extra fields: `church_address_county`, `diocese_type_name` (Diocese/Eparchy), `lat_long_source` (`null` or `"Google Map Manual"`), `resultID`.
- `service_typename` values seen: `Weekend`, `Week Days`, `Confessions`, `Holy Days`, `Vigil for Holy Days`, `Adorations`, `Devotions`. Note a weekday Mass on Saturday morning is `Week Days`; Saturday vigil is `Weekend`.
- `"Weekdays"` + `Holy Days` appears to mean "on any holy day that falls on a weekday."
- `url` may lack a scheme (`www.stannesgc.org/`). `street_address` sometimes includes city/state (`"384 Clinton St, Hempstead, NY "`).

Original lead, kept for reference:  The best lead is the old public [MassTimes API V4 docs](https://apiv4.updateparishdata.org/Default.htm), which may describe a retired version (MassTimes says there is no API service today).

To confirm: open masstimes.org in a desktop browser, open DevTools → Network → Fetch/XHR, search a city, and copy the request URL, parameters, headers and one JSON response into `docs/sample-response.json`. Or ask MassTimes directly.

Endpoints described in the V4 docs:

| Endpoint | Returns | Limits and notes |
| --- | --- | --- |
| `GET /Churchs/?lat={lat}&long={long}&apikey={key}` | Array of churches near the point | Ordered by distance; 100-mile radius; max 30 results; no paging; no guaranteed result |
| `GET /Churchs/{id}?apikey={key}` | One church with full details | Only id, name and country are guaranteed |

Fields per church: `id`, `name`, `church_address_street_address`, `church_address_city_name`, `church_address_providence_name` (state/province, misspelled in source), `church_address_postal_code`, `church_address_country_territory_name`, `latitude`, `longitude`, `distance`, `diocese_name`, `phone_number`, `email`, `url`, `pastors_name`, `rite_type_name`, `language_name`, `church_type_name`, `wheel_chair_access`, `comments`, `directions`, `last_update`, `military_time`, and `church_worship_times[]`.

Fields per worship time: `id`, `day_of_week`, `time_start`, `time_end`, `language`, `service_typename`, `comment`, `is_perpetual`.

Quirks to handle:

- Church IDs will change in the future, per the docs. Never use them as our primary key.
- Times are strings like `1/1/1900 5:00:00 PM`; only the time part is meaningful. `12:00:00 AM` with day `99` appears to mean "no specific time."
- `day_of_week`: the samples suggest 0 = Sunday through 6 = Saturday, and 99 = unspecified. Verify against real data.
- Numbers arrive as strings (`latitude`, `distance`, `id`). Strings have trailing spaces (`"English "`). Many fields can be null or empty.
- `comment` holds seasonal limits like `Nov - Dec`. Keep it and show it; do not try to parse it in v1.
- Coordinates can be wrong. Flag churches whose coordinates fall far from their city or postal code.

> **2026-10-12 — Superseded:** the owner chose two products (agent MCP/CLI + Cloudflare-hosted PWA). The current architecture, stack, schema, API and milestones M2–M6 live in **`docs/PRODUCT_PLAN.md`**. The sections below from "Architecture and stack" through "Milestones" are kept for history; where they conflict, the plan wins. The data-use commitments above still apply in full.

## Architecture and stack

Four parts, with MassTimes touched only by the sync job:

```text
MassTimes.org  --(scheduled, throttled)-->  Sync job  -->  Database  <--  Our API  <--  Frontend
```

1. **Sync job**: walks a grid of search points over the target region, fetches churches and times, normalizes them, and upserts into our database.
2. **Database**: our own copy, with our own stable IDs and spatial search.
3. **Our API**: read-only search by location, day, time, language and rite.
4. **Frontend**: map plus list, church detail pages, MassTimes credit.

Recommended stack (the owner has not chosen yet; confirm before scaffolding):

| Part | Recommendation | Why |
| --- | --- | --- |
| Sync job | Python 3.12, `httpx`, scheduled by cron or GitHub Actions | Simple, easy to throttle and retry |
| Database | PostgreSQL + PostGIS (SQLite + SpatiaLite fine for a local prototype) | Fast radius search, real spatial types |
| API | FastAPI | Typed, auto-generated OpenAPI docs |
| Frontend | Next.js + Leaflet with OpenStreetMap tiles | No Google Maps costs; MassTimes moved off Google Maps for cost reasons |
| Hosting | One small VPS or Fly.io/Render + managed Postgres | Low cost at regional scale |

Repo layout: `sync/`, `api/`, `web/`, `db/migrations/`, `docs/` (sample responses, this handoff), `tests/`.

## Database schema

Two core tables (churches, services) plus two for sync logging and raw responses. Our `churches.id` is stable; the MassTimes ID is stored only as a hint that may change.

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE churches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_key        text UNIQUE NOT NULL,   -- normalized name + rounded coords; see Sync strategy
  source_id        text,                   -- MassTimes id; unstable, never used as a key
  name             text NOT NULL,
  street           text,
  city             text,
  state            text,
  postal_code      text,
  country          text,
  location         geography(Point, 4326) NOT NULL,
  diocese          text,
  rite             text,
  church_type      text,
  primary_language text,
  phone            text,
  email            text,
  website          text,
  wheelchair       boolean,
  comments         text,
  source_updated_at timestamptz,           -- MassTimes last_update
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  is_active        boolean NOT NULL DEFAULT true
);
CREATE INDEX churches_location_idx ON churches USING gist (location);

CREATE TABLE services (
  id            bigserial PRIMARY KEY,
  church_id     uuid NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
  service_type  text NOT NULL,   -- Weekend, Weekday, Confession, Adoration, Devotions, Holy Day...
  day_of_week   smallint,        -- 0=Sun..6=Sat, NULL = unspecified (source 99)
  start_time    time,            -- NULL when source has no real time
  end_time      time,
  language      text,
  comment       text,            -- seasonal notes, shown as-is
  is_perpetual  boolean DEFAULT false
);
CREATE INDEX services_lookup_idx ON services (day_of_week, start_time);

CREATE TABLE sync_runs (
  id            bigserial PRIMARY KEY,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  region        text,
  points_queried int,
  churches_upserted int,
  errors        jsonb
);

CREATE TABLE raw_responses (    -- keep raw JSON for debugging and re-parsing
  id         bigserial PRIMARY KEY,
  run_id     bigint REFERENCES sync_runs(id),
  lat        double precision,
  lng        double precision,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  body       jsonb
);
```

Services for a church are replaced wholesale on each sync (delete then insert in one transaction), which avoids diffing schedules.

## Sync strategy

The 30-result cap per search is the main design constraint: a point only "covers" churches out to the distance of its 30th result.

Coverage algorithm (adaptive grid):

1. Start with a coarse grid over the region's bounding box (e.g. points every 20 miles).
2. Query each point. If it returns fewer than 30 results, the area out to the farthest result is fully covered.
3. If it returns exactly 30, the area is dense: split that cell into 4 and query each sub-point. Repeat down to a minimum cell size (e.g. 1 mile).
4. De-duplicate churches seen from several points using `match_key`.
5. Store the grid plan per region so later syncs skip the discovery step and reuse known dense cells.

Matching and stable IDs:

- `match_key` = lowercase name with punctuation and words like "church", "parish", "st."/"saint" normalized, plus lat/long rounded to 3 decimals (about 100 m).
- If no exact key match, fall back to: same normalized name within 200 m, or same street address and postal code. Log fuzzy matches for review.
- Churches not seen for 3 consecutive full syncs → `is_active = false`, never hard-deleted.

Normalization: trim all strings; parse numeric strings; convert `1/1/1900 h:mm:ss AM/PM` to `time`; map day `99` and `12:00:00 AM` placeholders to NULL; keep `comment` verbatim.

Operations:

- Throttle 1–2 s between requests; exponential backoff on errors; stop the run after 10 consecutive failures.
- Save every raw response to `raw_responses` so parsing can be fixed and re-run without re-fetching.
- A `--dry-run` flag that queries a single point and prints the parsed result, for testing.
- Weekly full sync to start; adjust once we see how often data changes.

## Our API

Read-only JSON, versioned under `/v1`. It serves only our database and never calls MassTimes.

| Endpoint | Purpose | Key parameters |
| --- | --- | --- |
| `GET /v1/churches/search` | Churches near a point, with matching services | `lat`, `lng`, `radius_mi` (default 10, max 50), `day` (0–6), `after`/`before` (HH:MM), `service_type`, `language`, `rite`, `limit`, `cursor` |
| `GET /v1/masses/upcoming` | Next Masses near a point, sorted by start time | `lat`, `lng`, `radius_mi`, `from` (ISO datetime, default now in local time zone), `limit` |
| `GET /v1/churches/{id}` | One church with its full schedule | our stable UUID |
| `GET /v1/geocode` | Address or ZIP to lat/lng for the search box | `q`; proxy a free geocoder such as Nominatim and cache results |
| `GET /v1/meta` | Last sync time, church count, coverage regions | none |

Every church response includes `source: {name: "MassTimes.org", url, last_updated}` so the frontend always has what it needs for credit and freshness.

Time zones: store times as local wall-clock times and derive each church's time zone from its coordinates (e.g. the `timezonefinder` package) so "upcoming" works across zones. Add a \`timezone text\` column to \`churches\` and fill it during sync.

## Frontend (v1 scope)

Mobile-first, since most people search on their phone on the way to Mass.

- **Home/search**: "Use my location" button plus address/ZIP box. Default view is "Masses starting in the next few hours near you."
- **Results**: list and map side by side on desktop, toggle on mobile. Each row shows church name, distance, next Mass time, language.
- **Filters**: day, time of day, service type (Mass, Confession, Adoration), language, rite.
- **Church page**: address with directions link, full weekly schedule grouped by day, phone and website, seasonal comments, last-updated date, "Confirm with the parish" note, link to the church's MassTimes listing.
- **Footer on every page**: "Data from MassTimes.org" with link, plus a donate link to MassTimes as a thank-you.
- **Report an error** link that, for v1, sends users to MassTimes' own "Update This Parish's Data" form.

Out of scope for v1: accounts, favorites, notifications, parish self-editing.

## Milestones

Each milestone ends with something the owner can see and check. Tick items as they land.

**M1 — Confirm the data source**

- [x] Owner captures the live request URL and a sample response from DevTools (or asks MassTimes) into `docs/sample-response.json`
- [x] Write `sync/client.py` that fetches one point with throttling and the custom User-Agent
- [x] (2026-10-12, owner ran it with `MASSTIMES_SEND_REFERER=1`: 60 churches over 2 pages, 0.64–8.19 mi, no errors) Run a single-point `--dry-run` and confirm the fields match this doc; update the Data source section with anything different

**M2 — Database and parser**

- [ ] Scaffold repo layout and Postgres + PostGIS (Docker Compose for local)
- [ ] Migrations for the schema above
- [ ] Parser and normalizer with unit tests built from the sample responses (times, day 99, trailing spaces, nulls)
- [ ] Upsert with `match_key` matching and fuzzy fallback

**M3 — Regional sync**

- [ ] Adaptive grid crawler for the owner's chosen region
- [ ] Full sync run; report church count, points queried, run time, errors
- [ ] Spot-check 10 churches against masstimes.org by hand
- [ ] Schedule weekly runs

**M4 — API**

- [ ] FastAPI endpoints listed above, with OpenAPI docs
- [ ] Tests for radius search, day/time filters, "upcoming" across midnight and time zones

**M5 — Frontend**

- [ ] Next.js app with search, map/list, filters, church page, attribution footer
- [ ] Mobile testing on a real phone

**M6 — Launch**

- [ ] Deploy API, database and frontend
- [ ] Show MassTimes the live site before announcing it
- [ ] Basic monitoring: sync failures and API errors alert the owner

## Open decisions

- [ ] Which region launches first (a diocese, metro area, or state)?
- [x] Stack: Cloudflare Worker + D1 + Hono + Agents SDK MCP, Vite/React PWA, Python sync on GitHub Actions — see `docs/PRODUCT_PLAN.md`.
- [x] Live endpoint: `GET /Churchs/?lat&long&pg`, no key. **Open:** MassTimes to allowlist our User-Agent (currently 403 for scripts).
- [ ] With paging available, simplify the adaptive grid to "page outward from sparse points until distance > cell radius"? Decide in M3.
- [x] Midnight placeholder: live data uses `""` for no time, so `00:00:00` would be a real midnight. (Saw a real `00:40:00` start.)
- [ ] App name and domain.
- [ ] Should corrections from our users go to MassTimes' form only, or also to our MassTimes contact directly?

## Progress log

Newest first. Claude Code adds a row at the end of each session.

| Date | What happened | Next step |
| --- | --- | --- |
| 2026-10-12 | **Special days + note parsing:** `worker/src/seasonal.ts` parses parish notes conservatively (ordinal weekdays, holiday exceptions, date ranges, seasons, semesters, indefinite suspensions; 269/1168 real notes acted on, audited). Special days (Christmas Eve/Day, Ash Wed, Triduum, Easter, Thanksgiving, holy days) flag regular-schedule fallbacks (`regular_schedule`), banner in app, notes in MCP/CLI; no regular weekday Masses Holy Thu/Good Fri/Holy Sat. Date picker allows a year ahead | — |
| 2026-10-12 | Removed travel-time estimates (distance only; "next" = next not-yet-started, 5 min grace). **Holy days:** US obligation rules (`holyDayList`), holy-day rows replace weekday Masses on holy days, vigils, Nearby banner + chip (14-day window), Saved list, MCP `holy_day_masses`. Repo scrubbed of personal contact names; email draft kept locally in ignored `private/` | — |
| 2026-10-12 | **Styles:** Settings → Style offers Parchment (default), Marian rosary, Gothic cathedral (from the design canvas https://claude.ai/artifact/TA3segEknHQrKfrzjkjLor). Implemented as `data-style` CSS token sets (light + dark each) in `web/src/index.css`, per-style fonts, rosary bead timeline, cathedral arch + flame hero, theme-coloured inline logo | Deploy with `cd web && npm run deploy` |
| 2026-10-12 | **Deployed (M6):** https://masstimes.pages.dev (classic Cloudflare Pages project `masstimes`, created with `--force` once; PWA static + `_worker.js` for `/v1/*` and `/mcp`). Production D1 `masstimes` (c457fbd7…), migrations 0001–0003, NYC+LI preloaded. Verified live MassTimes fetch from Cloudflare (Denver), MCP, geocoding, SPA routes. Pages has no rate-limit bindings: MassTimes cap uses D1 `outbound_budget`; no per-IP API limits yet. CLI default API → pages.dev | Owner installs PWA on Android; add per-IP limiting if traffic grows; transit-aware travel times (river crossings) |
| 2026-10-12 | **Live fetching:** owner authorized on-demand MassTimes requests. `worker/src/masstimes.ts` (TS port of the normalizer, parity-tested against Python) fetches areas not fetched in 24 h, upserts to D1, records `fetch_cells` (migration 0002); global cap via `MASSTIMES_LIMITER`. Geocoding no longer limited to NYC/LI. Fixed source quirks in both normalizers: `00:00` = no set time; Mass/confession at 00:01–04:59 = noon typo. Church page shows untimed notes. Verified Chicago, Paris, Boston (first search ~1.5–2.5 s, cached ~10 ms) | Deploy (M6) and check MassTimes doesn't block Cloudflare's egress IPs; consider retiring the weekly Python sync (live cache now refreshes daily) |
| 2026-10-12 | **M5 first pass:** `web/` (Vite + React + Tailwind + MapLibre/OpenFreeMap + PWA): Nearby, Map, Search, Church, Saved/settings, all filters, light/dark. Runs locally via `.claude/launch.json` (api :8790, web :5173 proxying `/v1`). API now merges same-time duplicate services | Owner tries it; then serve `web/dist` from the Worker (static assets) and deploy (M6) to test the PWA on Android |
| 2026-10-12 | Region set to NYC + LI. **M2 done:** normalizer (49 tests), D1 schema, crawler, diff loader; full crawl → 535 churches in local D1. **M3 done locally:** Worker API (`/v1/*`) + MCP (`/mcp`, 4 tools) with schedule engine (14 tests, holy days, DST, midnight). **M4 done locally:** `cli/bin/masstimes.mjs`. See README for how to run | M5 web app; M6 deploy (needs owner's Cloudflare login, `wrangler d1 create`) and MassTimes' OK on Referer before scheduled sync |
| 2026-10-12 | Owner defined two products (agent MCP/CLI, Cloudflare PWA); wrote `docs/PRODUCT_PLAN.md` with the new stack, D1 schema, API, MCP tools, UI and milestones | Owner answers plan's open decisions (coverage, framework, name); start M2 |
| 2026-10-12 | Owner ran the dry run from Python with Referer on: 200 OK, 60 churches / 2 pages. M1 done; Referer use still awaits MassTimes' written OK before any scheduled sync | Send MassTimes email; pick region + stack; start M2 |
| 2026-10-12 | Confirmed live endpoint `/Churchs/?lat&long&pg` (paged, no key); documented format differences; wrote `sync/client.py`; saved `docs/sample-response.json`. Script requests get 403 from Netlify | Owner emails MassTimes to allowlist UA; meanwhile owner picks region + stack, then M2 parser can proceed against the sample |
| 2026-10-12 | Project planned; written permission received from MassTimes; V4 API docs found; this handoff written | M1: confirm live endpoint |

## Sources

- [MassTimes API V4 docs](https://apiv4.updateparishdata.org/Default.htm) (may be retired)
- [MassTimes about page and data notice](https://masstimes.org/components/about/about.html)
