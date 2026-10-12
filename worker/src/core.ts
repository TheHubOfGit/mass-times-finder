// Business logic shared by the JSON API and the MCP server. Reads only from D1.

import { ensureCoverage } from "./masstimes";
import { expandSchedule, holyDayList, holyDaysBetween, type Occurrence, type Service, type ServiceKind } from "./schedule";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  MCP_LIMITER?: RateLimit;
  API_LIMITER?: RateLimit;
  MASSTIMES_LIMITER?: RateLimit;
  CONTACT_EMAIL?: string;
}

export const SOURCE_NAME = "MassTimes.org";
export const CONFIRM_NOTE = "Times can change. Please confirm with the parish.";
const MAX_RADIUS_MI = 50;
const MAX_CANDIDATES = 150;

// ---------- geography ----------

export function haversineMi(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(a));
}

function bbox(lat: number, lng: number, radiusMi: number) {
  const dLat = radiusMi / 69;
  const dLng = radiusMi / (69 * Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, north: lat + dLat, west: lng - dLng, east: lng + dLng };
}

// ---------- rows and payloads ----------

interface ChurchRow {
  id: string; source_id: string | null; name: string; street: string | null; city: string | null;
  state: string | null; postal_code: string | null; county: string | null; country: string | null;
  lat: number; lng: number; timezone: string; diocese: string | null; diocese_type: string | null;
  rite: string | null; church_type: string | null; primary_language: string | null; phone: string | null;
  email: string | null; website: string | null; wheelchair: number | null; comments: string | null;
  directions: string | null; pastor: string | null; services_json: string; languages: string | null;
  service_types: number; has_perpetual_adoration: number; source_updated_at: string | null;
  coord_suspect: number;
}

const KIND_BITS: Record<ServiceKind, number> = { mass: 1, confession: 2, adoration: 4, devotion: 8, other: 0 };
export const KINDS: ServiceKind[] = ["mass", "confession", "adoration", "devotion"];

export function sourceInfo(row: Pick<ChurchRow, "source_id" | "lat" | "lng" | "source_updated_at">) {
  return {
    name: SOURCE_NAME,
    url: `https://masstimes.org/map?lat=${row.lat.toFixed(4)}&lng=${row.lng.toFixed(4)}`,
    report_error_url: row.source_id
      ? `https://updateparishdata.org/UpdateChurchInfo.aspx?churchid=${encodeURIComponent(row.source_id)}`
      : "https://masstimes.org/",
    last_updated: row.source_updated_at,
  };
}

export function churchSummary(row: ChurchRow, distanceMi?: number) {
  return {
    id: row.id,
    name: row.name,
    address: { street: row.street, city: row.city, state: row.state, postal_code: row.postal_code },
    lat: row.lat,
    lng: row.lng,
    distance_mi: distanceMi === undefined ? undefined : Math.round(distanceMi * 100) / 100,
    timezone: row.timezone,
    diocese: row.diocese,
    rite: row.rite,
    church_type: row.church_type,
    primary_language: row.primary_language,
    wheelchair: row.wheelchair === null ? null : row.wheelchair === 1,
    perpetual_adoration: row.has_perpetual_adoration === 1,
    phone: row.phone,
    website: row.website,
    directions_url: `https://www.google.com/maps/dir/?api=1&destination=${row.lat},${row.lng}`,
    source: sourceInfo(row),
  };
}

export type ChurchSummary = ReturnType<typeof churchSummary>;

function occurrencePayload(o: Occurrence, church: ChurchSummary) {
  return {
    church,
    kind: o.service.kind,
    source_type: o.service.source_type,
    start: o.start.toISOString(),
    end: o.end?.toISOString() ?? null,
    local_date: o.localDate,
    local_start: o.localStart,
    local_end: o.localEnd,
    language: o.service.language ?? church.primary_language,
    comment: o.service.comment,
    holy_day: o.holyDay,
    seasonal: o.seasonal,
    in_progress: o.inProgress,
  };
}

export type OccurrencePayload = ReturnType<typeof occurrencePayload>;

// ---------- filters ----------

export interface Filters {
  kinds?: ServiceKind[];
  language?: string;
  rite?: string;
  churchType?: string;
  diocese?: string;
  wheelchair?: boolean;
  perpetualAdoration?: boolean;
}

function filterSql(f: Filters): { where: string[]; params: unknown[] } {
  const where: string[] = ["is_active = 1"];
  const params: unknown[] = [];
  if (f.kinds?.length) {
    where.push("(service_types & ?) != 0");
    params.push(f.kinds.reduce((m, k) => m | KIND_BITS[k], 0));
  }
  if (f.language) { where.push("languages LIKE ? COLLATE NOCASE"); params.push(`%|${f.language}|%`); }
  if (f.rite) { where.push("rite = ? COLLATE NOCASE"); params.push(f.rite); }
  if (f.churchType) { where.push("church_type = ? COLLATE NOCASE"); params.push(f.churchType); }
  if (f.diocese) { where.push("diocese = ? COLLATE NOCASE"); params.push(f.diocese); }
  if (f.wheelchair) where.push("wheelchair = 1");
  if (f.perpetualAdoration) where.push("has_perpetual_adoration = 1");
  return { where, params };
}

// ---------- queries ----------

export async function churchesNear(env: Env, lat: number, lng: number, radiusMi: number, f: Filters = {}, limit = MAX_CANDIDATES) {
  const r = Math.min(Math.max(radiusMi, 0.1), MAX_RADIUS_MI);
  await ensureCoverage(env, lat, lng, r); // live-fetch from MassTimes if this area isn't fresh in D1
  const b = bbox(lat, lng, r);
  const { where, params } = filterSql(f);
  where.push("lat BETWEEN ? AND ?", "lng BETWEEN ? AND ?");
  params.push(b.south, b.north, b.west, b.east);
  const { results } = await env.DB.prepare(`SELECT * FROM churches WHERE ${where.join(" AND ")}`).bind(...params).all<ChurchRow>();
  return results
    .map((row) => ({ row, distance: haversineMi(lat, lng, row.lat, row.lng) }))
    .filter((c) => c.distance <= r)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

export async function churchesInBox(env: Env, box: { south: number; north: number; west: number; east: number }, f: Filters = {}, limit = 500) {
  const cLat = (box.south + box.north) / 2, cLng = (box.west + box.east) / 2;
  await ensureCoverage(env, cLat, cLng, Math.min(15, haversineMi(cLat, cLng, box.north, box.east)));
  const { where, params } = filterSql(f);
  where.push("lat BETWEEN ? AND ?", "lng BETWEEN ? AND ?");
  params.push(box.south, box.north, box.west, box.east);
  const { results } = await env.DB.prepare(`SELECT * FROM churches WHERE ${where.join(" AND ")} LIMIT ?`)
    .bind(...params, limit).all<ChurchRow>();
  return results;
}

export async function searchByText(env: Env, q: string, f: Filters = {}, near?: { lat: number; lng: number }, limit = 25) {
  const terms = q.normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const match = terms.map((t) => `"${t}"*`).join(" ");
  const { where, params } = filterSql(f);
  const { results } = await env.DB.prepare(
    `SELECT c.* FROM churches_fts JOIN churches c ON c.rowid = churches_fts.rowid
     WHERE churches_fts MATCH ? AND ${where.map((w) => `c.${w}`).join(" AND ")} ORDER BY rank LIMIT ?`,
  ).bind(match, ...params, near ? 200 : limit).all<ChurchRow>();
  const rows = results.map((row) => ({ row, distance: near ? haversineMi(near.lat, near.lng, row.lat, row.lng) : undefined }));
  if (near) rows.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
  return rows.slice(0, limit);
}

export async function churchById(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM churches WHERE id = ?").bind(id).first<ChurchRow>();
}

export interface UpcomingOptions extends Filters {
  lat: number;
  lng: number;
  radiusMi?: number;
  from?: Date;
  days?: number;
  limit?: number;
  /** Only times on this local date (YYYY-MM-DD, church zone). */
  date?: string;
  /** Local time window, "HH:MM". */
  after?: string;
  before?: string;
}

export async function upcoming(env: Env, o: UpcomingOptions): Promise<OccurrencePayload[]> {
  const kinds = o.kinds?.length ? o.kinds : (["mass"] as ServiceKind[]);
  const from = o.from ?? new Date();
  const candidates = await churchesNear(env, o.lat, o.lng, o.radiusMi ?? 10, { ...o, kinds });
  const days = Math.min(Math.max(o.days ?? 2, 0), 14);
  const out: OccurrencePayload[] = [];
  for (const { row, distance } of candidates) {
    const services = JSON.parse(row.services_json) as Service[];
    const summary = churchSummary(row, distance);
    for (const occ of expandSchedule(services, row.timezone, {
      from, days, kinds, language: o.language, churchLanguage: row.primary_language,
    })) {
      if (o.date && occ.localDate !== o.date) continue;
      if (o.after && occ.localStart < o.after) continue;
      if (o.before && occ.localStart > o.before) continue;
      out.push(occurrencePayload(occ, summary));
    }
  }
  out.sort((a, b) => a.start.localeCompare(b.start) || (a.church.distance_mi ?? 0) - (b.church.distance_mi ?? 0));
  return mergeSameTime(out).slice(0, Math.min(o.limit ?? 50, 500));
}

/**
 * MassTimes sometimes lists the same service twice at one time (e.g. a Mass, and the same Mass with
 * "Miraculous Medal Novena" in the comment). Merge those into one entry and keep every distinct note.
 */
function mergeSameTime(list: OccurrencePayload[]): OccurrencePayload[] {
  const byKey = new Map<string, OccurrencePayload>();
  const out: OccurrencePayload[] = [];
  for (const o of list) {
    const key = `${o.church.id}|${o.start}|${o.kind}|${o.language ?? ""}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, o);
      out.push(o);
      continue;
    }
    const notes = [prev.comment, o.comment].filter((c): c is string => Boolean(c));
    prev.comment = [...new Set(notes)].join(" · ") || null;
    prev.seasonal = prev.seasonal || o.seasonal;
    prev.holy_day = prev.holy_day ?? o.holy_day;
    if (!prev.end && o.end) { prev.end = o.end; prev.local_end = o.local_end; }
  }
  return out;
}

export interface NextAnswer {
  soonest: OccurrencePayload | null;
  nearest: OccurrencePayload | null;
  alternatives: OccurrencePayload[];
  searched: { radius_mi: number; from: string };
}

/**
 * "What's the nearest and next Mass?"
 * soonest = earliest occurrence that hasn't started yet (allowing a few minutes' grace);
 * nearest = the next such occurrence at the closest church that has one.
 * Distance is straight-line; we deliberately don't estimate travel time.
 */
export async function nextService(env: Env, o: UpcomingOptions & { bufferMin?: number }): Promise<NextAnswer> {
  const from = o.from ?? new Date();
  const buffer = o.bufferMin ?? 5;
  let radius = o.radiusMi ?? 5;
  let occ: OccurrencePayload[] = [];
  // Widen the search until something turns up (5 → 10 → 25 mi), unless the caller fixed a radius.
  for (const r of o.radiusMi ? [o.radiusMi] : [5, 10, 25]) {
    radius = r;
    occ = await upcoming(env, { ...o, from, radiusMi: r, days: o.days ?? 2, limit: 500 });
    if (occ.length) break;
  }
  const reachable = occ.filter((x) => {
    if (x.in_progress) return x.kind !== "mass"; // a Mass already underway doesn't count; confession/adoration does
    return new Date(x.start).getTime() >= from.getTime() + buffer * 60_000;
  });
  const soonest = reachable[0] ?? null;
  const nearestDistance = Math.min(...reachable.map((x) => x.church.distance_mi ?? Infinity));
  const nearest = reachable.find((x) => x.church.distance_mi === nearestDistance) ?? null;
  const seen = new Set([soonest, nearest].filter(Boolean).map((x) => `${x!.church.id}|${x!.start}`));
  const alternatives = reachable.filter((x) => !seen.has(`${x.church.id}|${x.start}`)).slice(0, 3);
  return { soonest, nearest, alternatives, searched: { radius_mi: radius, from: from.toISOString() } };
}

export async function churchDetails(env: Env, id: string, from = new Date()) {
  const row = await churchById(env, id);
  if (!row) return null;
  const services = JSON.parse(row.services_json) as Service[];
  const next = expandSchedule(services, row.timezone, { from, days: 7, kinds: KINDS, churchLanguage: row.primary_language })
    .slice(0, 10).map((o) => ({
      kind: o.service.kind, start: o.start.toISOString(), local_date: o.localDate, local_start: o.localStart,
      local_end: o.localEnd, language: o.service.language ?? row.primary_language, comment: o.service.comment,
      holy_day: o.holyDay, in_progress: o.inProgress,
    }));
  return {
    ...churchSummary(row),
    county: row.county,
    country: row.country,
    diocese_type: row.diocese_type,
    email: row.email,
    pastor: row.pastor,
    comments: row.comments,
    directions: row.directions,
    coord_suspect: row.coord_suspect === 1,
    services,
    next,
    confirm_note: CONFIRM_NOTE,
  };
}

export async function facets(env: Env, lat: number, lng: number, radiusMi: number) {
  const rows = (await churchesNear(env, lat, lng, radiusMi, {}, 2000)).map((c) => c.row);
  const count = (values: (string | null)[]) => {
    const m = new Map<string, number>();
    for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, churches]) => ({ value, churches }));
  };
  return {
    churches: rows.length,
    languages: count(rows.flatMap((r) => (r.languages ?? "").split("|").filter(Boolean))),
    rites: count(rows.map((r) => r.rite)),
    church_types: count(rows.map((r) => r.church_type)),
    dioceses: count(rows.map((r) => r.diocese)),
    kinds: KINDS.map((k) => ({ value: k, churches: rows.filter((r) => r.service_types & KIND_BITS[k]).length })),
    wheelchair: rows.filter((r) => r.wheelchair === 1).length,
    perpetual_adoration: rows.filter((r) => r.has_perpetual_adoration === 1).length,
  };
}

export async function meta(env: Env) {
  const stats = await env.DB.prepare(
    `SELECT (SELECT count(*) FROM churches WHERE is_active = 1) AS churches,
            (SELECT max(finished_at) FROM sync_runs) AS last_sync,
            (SELECT group_concat(DISTINCT region) FROM churches) AS regions`,
  ).first<{ churches: number; last_sync: string | null; regions: string | null }>();
  const today = new Date().toISOString().slice(0, 10);
  const nextYear = new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10);
  return {
    churches: stats?.churches ?? 0,
    last_sync: stats?.last_sync ?? null,
    regions: stats?.regions?.split(",") ?? [],
    holy_days: holyDayList(today, nextYear),
    source: { name: SOURCE_NAME, url: "https://masstimes.org/", donate_url: "https://secure.masstimes.org/forms/donate" },
    confirm_note: CONFIRM_NOTE,
  };
}
