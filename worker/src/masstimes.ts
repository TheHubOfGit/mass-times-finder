// Live MassTimes fetching (owner decision 2026-10-12; see CLAUDE.md commitments).
// When a search lands somewhere we haven't fetched in the last day, fetch MassTimes for that spot,
// normalize it the same way sync/normalize.py does, upsert into D1, and remember the area as covered.
// Everything else reads from D1, so the frontend never touches MassTimes.

import tzlookup from "@photostructure/tz-lookup";
import type { Env } from "./core";
import type { Service, ServiceKind } from "./schedule";

const BASE = "https://masstimes.org";
const PAGE_SIZE = 30;
const FRESH_MS = 24 * 3600_000;
const MAX_PAGES = 4; // ≤120 churches per live fetch
const PAGE_GAP_MS = 250; // sequential pages, small pause between them
const FETCH_TIMEOUT_MS = 8000;
const SOURCE_RADIUS_MI = 100; // MassTimes searches at most 100 mi out
const FUZZY_MI = 200 / 1609.34;
const COVER_TOLERANCE_MI = 0.25;

// ---------- normalization (mirror of sync/normalize.py) ----------

const SERVICE_TYPES: Record<string, [ServiceKind, boolean, boolean]> = {
  weekend: ["mass", false, false],
  "week days": ["mass", false, false],
  "holy days": ["mass", true, false],
  "vigil for holy days": ["mass", true, true],
  confessions: ["confession", false, false],
  adorations: ["adoration", false, false],
  devotions: ["devotion", false, false],
};
const DAYS: Record<string, number[]> = {
  sunday: [0], monday: [1], tuesday: [2], wednesday: [3], thursday: [4], friday: [5], saturday: [6],
  weekdays: [1, 2, 3, 4, 5],
};
const KIND_BITS: Record<ServiceKind, number> = { mass: 1, confession: 2, adoration: 4, devotion: 8, other: 0 };
const HOLY_DAY_BIT = 16;
const NAME_STOPWORDS = new Set(["church", "parish", "the", "of", "catholic", "roman"]);

type Raw = Record<string, unknown>;

function clean(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
}

function num(v: unknown): number | null {
  const s = clean(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseTime(v: unknown): string | null {
  const s = clean(v);
  if (!s) return null;
  let m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (m) return +m[1] < 24 ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
  m = /^\d{1,2}\/\d{1,2}\/\d{4} (\d{1,2}):(\d{2}):\d{2} (AM|PM)$/i.exec(s); // V4 "1/1/1900 5:00:00 PM"
  if (m) {
    let h = +m[1] % 12;
    if (m[3].toUpperCase() === "PM") h += 12;
    return `${String(h).padStart(2, "0")}:${m[2]}`;
  }
  return null;
}

export function parseDays(v: unknown): number[] {
  const s = clean(v);
  if (!s) return [];
  if (/^\d+$/.test(s)) {
    const n = +s;
    return n >= 0 && n <= 6 ? [n] : [];
  }
  return [...(DAYS[s.toLowerCase()] ?? [])];
}

export function parseLastUpdate(v: unknown): string | null {
  const s = clean(v);
  const m = s && /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/i.exec(s);
  if (!m) return null;
  let h = +m[4] % 12;
  if (m[7].toUpperCase() === "PM") h += 12;
  const p = (n: number | string) => String(n).padStart(2, "0");
  return `${m[3]}-${p(m[1])}-${p(m[2])}T${p(h)}:${m[5]}:${m[6]}`;
}

function normalizeUrl(v: unknown): string | null {
  const s = clean(v);
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, "")}`;
}

export function normalizedName(name: string): string {
  let s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\x00-\x7f]/g, "").toLowerCase();
  s = s.replace(/\[.*?\]/g, " ");
  s = s.replace(/\bsts?\b\.?|\bsaints?\b|\bss\b\.?/g, " st ");
  s = s.replace(/[^a-z0-9 ]/g, " ");
  return s.split(/\s+/).filter((w) => w && !NAME_STOPWORDS.has(w)).join(" ");
}

export function matchKey(name: string, lat: number, lng: number): string {
  return `${normalizedName(name)}|${lat.toFixed(3)}|${lng.toFixed(3)}`;
}

/** Same quirks as sync/normalize.py fix_start_time: "00:00" = no set time; early-morning Mass = noon typo. */
export function fixStartTime(start: string | null, kind: ServiceKind): string | null {
  if (!start || start === "00:00") return null;
  if ((kind === "mass" || kind === "confession" || kind === "devotion") && start < "05:00") {
    const [h, m] = start.split(":");
    return `${String(+h + 12).padStart(2, "0")}:${m}`;
  }
  return start;
}

function normalizeService(raw: Raw): Service {
  const type = (clean(raw.service_typename) ?? "").toLowerCase();
  const [kind, holy_day, vigil] = SERVICE_TYPES[type] ?? ["other", false, false];
  const start = fixStartTime(parseTime(raw.time_start), kind);
  return {
    kind, source_type: clean(raw.service_typename), days: parseDays(raw.day_of_week),
    start, end: start ? parseTime(raw.time_end) : null, language: clean(raw.language),
    comment: clean(raw.comment), perpetual: Boolean(raw.is_perpetual), holy_day, vigil,
  };
}

export interface NormalizedChurch {
  match_key: string; source_id: string | null; name: string; street: string | null; city: string | null;
  state: string | null; postal_code: string | null; county: string | null; country: string | null;
  lat: number; lng: number; timezone: string; diocese: string | null; diocese_type: string | null;
  rite: string | null; church_type: string | null; primary_language: string | null; phone: string | null;
  email: string | null; website: string | null; wheelchair: number | null; comments: string | null;
  directions: string | null; pastor: string | null; services: Service[]; languages: string | null;
  service_types: number; has_perpetual_adoration: number; source_updated_at: string | null;
}

export function normalizeChurch(raw: Raw): NormalizedChurch | null {
  const name = clean(raw.name);
  const lat = num(raw.latitude), lng = num(raw.longitude);
  if (!name || lat === null || lng === null || (lat === 0 && lng === 0)) return null;

  const services = ((raw.church_worship_times as Raw[] | null) ?? []).map(normalizeService);
  services.sort((a, b) =>
    a.kind.localeCompare(b.kind) || Number(a.holy_day) - Number(b.holy_day) ||
    (a.days[0] ?? 9) - (b.days[0] ?? 9) || (a.start ?? "").localeCompare(b.start ?? "") ||
    (a.language ?? "").localeCompare(b.language ?? ""));

  const langs = new Set(services.map((s) => s.language).filter((l): l is string => Boolean(l)));
  const primary = clean(raw.language_name);
  if (primary) langs.add(primary);
  const languages = [...langs].sort();
  let serviceTypes = 0;
  for (const s of services) serviceTypes |= KIND_BITS[s.kind] | (s.holy_day ? HOLY_DAY_BIT : 0);

  let timezone = "UTC";
  try {
    timezone = tzlookup(lat, lng);
  } catch {
    /* invalid coordinates; keep UTC */
  }
  const wheelchair = raw.wheel_chair_access;
  return {
    match_key: matchKey(name, lat, lng),
    source_id: clean(raw.id),
    name,
    street: clean(raw.church_address_street_address),
    city: clean(raw.church_address_city_name),
    state: clean(raw.church_address_providence_name),
    postal_code: clean(raw.church_address_postal_code),
    county: clean(raw.church_address_county),
    country: clean(raw.church_address_country_territory_name),
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    timezone,
    diocese: clean(raw.diocese_name),
    diocese_type: clean(raw.diocese_type_name),
    rite: clean(raw.rite_type_name),
    church_type: clean(raw.church_type_name),
    primary_language: primary,
    phone: clean(raw.phone_number),
    email: clean(raw.email),
    website: normalizeUrl(raw.url),
    wheelchair: wheelchair === null || wheelchair === undefined ? null : wheelchair ? 1 : 0,
    comments: clean(raw.comments),
    directions: clean(raw.directions),
    pastor: clean(raw.pastors_name),
    services,
    languages: languages.length ? `|${languages.join("|")}|` : null,
    service_types: serviceTypes,
    has_perpetual_adoration: services.some((s) => s.perpetual && s.kind === "adoration") ? 1 : 0,
    source_updated_at: parseLastUpdate(raw.last_update),
  };
}

async function contentHash(c: NormalizedChurch): Promise<string> {
  const { source_id: _ignored, ...rest } = c; // a MassTimes id change alone isn't a content change
  const bytes = new TextEncoder().encode(JSON.stringify(rest));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- fetching ----------

function haversineMi(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(a));
}

function userAgent(env: Env) {
  return `MassTimesFinder/0.1 (contact: ${env.CONTACT_EMAIL ?? "contact@example.com"})`;
}

async function fetchPage(env: Env, lat: number, lng: number, page: number): Promise<Raw[]> {
  const url = `${BASE}/Churchs/?lat=${lat.toFixed(3)}&long=${lng.toFixed(3)}&pg=${page}`;
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent(env), Accept: "application/json", Referer: `${BASE}/` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`MassTimes ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? (data as Raw[]) : [];
}

function cellKey(lat: number, lng: number) {
  return `${Math.round(lat * 20)}:${Math.round(lng * 20)}`;
}

interface CellRow { cell: string; lat: number; lng: number; covered_mi: number; pages: number; fetched_at: string }

/** Is (lat, lng, radius) inside an area fetched within the last day? */
async function isCovered(env: Env, lat: number, lng: number, radiusMi: number): Promise<boolean> {
  const since = new Date(Date.now() - FRESH_MS).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT cell, lat, lng, covered_mi, pages, fetched_at FROM fetch_cells WHERE fetched_at > ? AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?",
  ).bind(since, lat - 1.5, lat + 1.5, lng - 2, lng + 2).all<CellRow>();
  // Small tolerance: query points are rounded to 3 dp, so a repeat search can land a few metres off-centre.
  return results.some((c) => {
    const d = haversineMi(lat, lng, c.lat, c.lng);
    if (d + radiusMi <= c.covered_mi + COVER_TOLERANCE_MI) return true;
    // A capped fetch means a dense area (120+ churches within covered_mi). Searches centred well inside it
    // already have plenty of nearby churches, so don't refetch just because the radius pokes past the edge.
    return c.pages >= MAX_PAGES && d <= c.covered_mi / 2;
  });
}

const OUTBOUND_PER_MINUTE = 60;

/** Global cap on MassTimes requests across all users: rate-limit binding if present, else a D1 counter. */
async function takeOutboundSlot(env: Env): Promise<boolean> {
  if (env.MASSTIMES_LIMITER) return (await env.MASSTIMES_LIMITER.limit({ key: "global" })).success;
  const minute = new Date().toISOString().slice(0, 16);
  const row = await env.DB.prepare(
    "INSERT INTO outbound_budget (minute, n) VALUES (?, 1) ON CONFLICT(minute) DO UPDATE SET n = n + 1 RETURNING n",
  ).bind(minute).first<{ n: number }>();
  if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM outbound_budget WHERE minute < ?").bind(minute).run();
  return (row?.n ?? 0) <= OUTBOUND_PER_MINUTE;
}

export interface LiveResult { fetched: boolean; pages?: number; churches?: number; error?: string }

const inFlight = new Map<string, Promise<LiveResult>>();

/**
 * Make sure D1 has fresh MassTimes data for this circle, fetching live if needed.
 * Never throws: on any failure we serve whatever D1 already has.
 */
export async function ensureCoverage(env: Env, lat: number, lng: number, radiusMi: number): Promise<LiveResult> {
  const radius = Math.min(Math.max(radiusMi, 1), 25);
  try {
    if (await isCovered(env, lat, lng, radius)) return { fetched: false };
  } catch (e) {
    return { fetched: false, error: String(e) }; // e.g. migration not applied
  }
  const key = `${cellKey(lat, lng)}|${radius}`;
  const pending = inFlight.get(key);
  if (pending) return pending; // de-duplicate concurrent identical fetches in this isolate
  const p = fetchAndStore(env, lat, lng, radius).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function fetchAndStore(env: Env, lat: number, lng: number, radius: number): Promise<LiveResult> {
  const qLat = Math.round(lat * 1000) / 1000, qLng = Math.round(lng * 1000) / 1000;
  const raws: Raw[] = [];
  let pages = 0;
  let covered = 0;
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (!(await takeOutboundSlot(env))) break; // global outbound cap reached; serve cached data
      if (page > 1) await new Promise((r) => setTimeout(r, PAGE_GAP_MS));
      const rows = await fetchPage(env, qLat, qLng, page);
      pages++;
      raws.push(...rows);
      const last = Number(rows.at(-1)?.distance ?? 0);
      if (rows.length < PAGE_SIZE) { covered = SOURCE_RADIUS_MI; break; }
      covered = last;
      if (last > radius) break;
      // Dense city: 120 churches already within `last` miles is plenty. Count the requested radius as
      // covered so the next search here doesn't refetch every time.
      if (page === MAX_PAGES) covered = Math.max(last, radius);
    }
  } catch (e) {
    if (!raws.length) return { fetched: false, error: String(e) };
  }
  if (!pages) return { fetched: false, error: "rate limited" };

  const churches = new Map<string, NormalizedChurch>();
  for (const r of raws) {
    const c = normalizeChurch(r);
    if (c) churches.set(c.match_key, c);
  }
  await upsert(env, [...churches.values()]);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO fetch_cells (cell, lat, lng, covered_mi, pages, churches, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(cellKey(qLat, qLng), qLat, qLng, covered, pages, churches.size, new Date().toISOString()).run();
  return { fetched: true, pages, churches: churches.size };
}

// ---------- storage ----------

const COLUMNS = [
  "match_key", "source_id", "name", "street", "city", "state", "postal_code", "county", "country",
  "lat", "lng", "timezone", "diocese", "diocese_type", "rite", "church_type", "primary_language",
  "phone", "email", "website", "wheelchair", "comments", "directions", "pastor", "services_json",
  "languages", "service_types", "has_perpetual_adoration", "source_updated_at", "content_hash",
] as const;

interface ExistingRow { id: string; match_key: string; source_id: string | null; name: string; lat: number; lng: number; content_hash: string }

async function upsert(env: Env, incoming: NormalizedChurch[]) {
  if (!incoming.length) return;
  const lats = incoming.map((c) => c.lat), lngs = incoming.map((c) => c.lng);
  const { results: existing } = await env.DB.prepare(
    "SELECT id, match_key, source_id, name, lat, lng, content_hash FROM churches WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?",
  ).bind(Math.min(...lats) - 0.01, Math.max(...lats) + 0.01, Math.min(...lngs) - 0.01, Math.max(...lngs) + 0.01).all<ExistingRow>();

  const byKey = new Map(existing.map((e) => [e.match_key, e]));
  const bySource = new Map(existing.filter((e) => e.source_id).map((e) => [e.source_id!, e]));
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  const seen: string[] = [];

  for (const c of incoming) {
    const hash = await contentHash(c);
    const values: Record<(typeof COLUMNS)[number], unknown> = {
      ...c, services_json: JSON.stringify(c.services), content_hash: hash,
    } as never;
    const e = byKey.get(c.match_key)
      ?? existing.find((x) => normalizedName(x.name) === normalizedName(c.name) && haversineMi(x.lat, x.lng, c.lat, c.lng) <= FUZZY_MI)
      ?? (c.source_id ? bySource.get(c.source_id) : undefined);
    if (!e) {
      const cols = ["id", ...COLUMNS, "first_seen_at", "last_seen_at", "region"];
      stmts.push(env.DB.prepare(`INSERT INTO churches (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
        .bind(crypto.randomUUID(), ...COLUMNS.map((k) => values[k] ?? null), now, now, "live"));
    } else if (e.content_hash !== hash || e.match_key !== c.match_key) {
      stmts.push(env.DB.prepare(`UPDATE churches SET ${COLUMNS.map((k) => `${k} = ?`).join(", ")}, last_seen_at = ?, is_active = 1, missed_syncs = 0 WHERE id = ?`)
        .bind(...COLUMNS.map((k) => values[k] ?? null), now, e.id));
    } else {
      seen.push(e.id);
    }
  }
  for (let i = 0; i < seen.length; i += 90) {
    const ids = seen.slice(i, i + 90);
    stmts.push(env.DB.prepare(`UPDATE churches SET last_seen_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`).bind(now, ...ids));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}
