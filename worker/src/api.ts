import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import {
  churchDetails, churchesInBox, churchesNear, churchSummary, CONFIRM_NOTE, type Env, facets, type Filters,
  KINDS, meta, nextService, searchByText, upcoming, type UpcomingOptions,
} from "./core";
import { geocode, resolveLocation, reverseGeocode } from "./geocode";
import type { ServiceKind } from "./schedule";

export class BadRequest extends Error {}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function num(c: Context, name: string, opts: { min?: number; max?: number } = {}): number | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || (opts.min !== undefined && n < opts.min) || (opts.max !== undefined && n > opts.max)) {
    throw new BadRequest(`invalid ${name}`);
  }
  return n;
}

function str(c: Context, name: string, pattern?: RegExp): string | undefined {
  const v = c.req.query(name)?.trim();
  if (!v) return undefined;
  if (pattern && !pattern.test(v)) throw new BadRequest(`invalid ${name}`);
  return v;
}

function bool(c: Context, name: string): boolean | undefined {
  const v = c.req.query(name);
  return v === undefined ? undefined : ["1", "true", "yes"].includes(v.toLowerCase());
}

export function parseKinds(raw: string | undefined): ServiceKind[] | undefined {
  if (!raw) return undefined;
  const kinds = raw.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
  for (const k of kinds) if (!(KINDS as string[]).includes(k)) throw new BadRequest(`invalid kind: ${k}`);
  return kinds as ServiceKind[];
}

function filters(c: Context): Filters {
  return {
    kinds: parseKinds(c.req.query("kind")),
    language: str(c, "lang"),
    rite: str(c, "rite"),
    churchType: str(c, "church_type"),
    diocese: str(c, "diocese"),
    wheelchair: bool(c, "wheelchair"),
    perpetualAdoration: bool(c, "perpetual"),
  };
}

/** lat/lng from the query, or geocoded from `near`. */
async function point(c: Context<{ Bindings: Env }>): Promise<{ lat: number; lng: number; label?: string }> {
  const lat = num(c, "lat", { min: -90, max: 90 });
  const lng = num(c, "lng", { min: -180, max: 180 });
  if (lat !== undefined && lng !== undefined) return { lat, lng };
  const near = str(c, "near");
  if (near) {
    const place = await resolveLocation(c.env, near);
    if (!place) throw new BadRequest(`could not find location: ${near}`);
    return place;
  }
  throw new BadRequest("lat and lng (or near) are required");
}

function upcomingOptions(c: Context, p: { lat: number; lng: number }): UpcomingOptions {
  const from = str(c, "from");
  const fromDate = from ? new Date(from) : undefined;
  if (fromDate && Number.isNaN(fromDate.getTime())) throw new BadRequest("invalid from");
  return {
    ...filters(c),
    lat: p.lat,
    lng: p.lng,
    radiusMi: num(c, "radius_mi", { min: 0.1, max: 50 }),
    from: fromDate,
    days: num(c, "days", { min: 0, max: 14 }),
    limit: num(c, "limit", { min: 1, max: 500 }),
    date: str(c, "date", DATE),
    after: str(c, "after", HHMM),
    before: str(c, "before", HHMM),
  };
}

export const api = new Hono<{ Bindings: Env }>();

api.use("*", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }));

api.use("*", async (c, next) => {
  if (c.env.API_LIMITER) {
    const ip = c.req.header("cf-connecting-ip") ?? "local";
    const { success } = await c.env.API_LIMITER.limit({ key: ip });
    if (!success) return c.json({ error: "rate limited; try again in a minute" }, 429);
  }
  await next();
});

api.onError((err, c) => {
  if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

api.get("/upcoming", async (c) => {
  const p = await point(c);
  const results = await upcoming(c.env, upcomingOptions(c, p));
  return c.json({ location: p, results, confirm_note: CONFIRM_NOTE });
});

api.get("/next", async (c) => {
  const p = await point(c);
  const answer = await nextService(c.env, { ...upcomingOptions(c, p), bufferMin: num(c, "buffer_min", { min: 0, max: 120 }) });
  return c.json({ location: p, ...answer, confirm_note: CONFIRM_NOTE });
});

api.get("/churches/search", async (c) => {
  const f = filters(c);
  const q = str(c, "q");
  const limit = num(c, "limit", { min: 1, max: 500 });
  const bboxRaw = str(c, "bbox"); // west,south,east,north
  if (bboxRaw) {
    const [west, south, east, north] = bboxRaw.split(",").map(Number);
    if ([west, south, east, north].some((n) => !Number.isFinite(n))) throw new BadRequest("invalid bbox");
    const rows = await churchesInBox(c.env, { west, south, east, north }, f, limit ?? 500);
    return c.json({ results: rows.map((r) => churchSummary(r)) });
  }
  const lat = num(c, "lat", { min: -90, max: 90 }), lng = num(c, "lng", { min: -180, max: 180 });
  const near = lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
  if (q) {
    const rows = await searchByText(c.env, q, f, near, limit ?? 25);
    return c.json({ results: rows.map(({ row, distance }) => churchSummary(row, distance)) });
  }
  if (!near) throw new BadRequest("q, bbox, or lat and lng are required");
  const rows = await churchesNear(c.env, near.lat, near.lng, num(c, "radius_mi", { min: 0.1, max: 50 }) ?? 10, f, limit ?? 100);
  return c.json({ results: rows.map(({ row, distance }) => churchSummary(row, distance)) });
});

api.get("/churches/:id", async (c) => {
  const church = await churchDetails(c.env, c.req.param("id"));
  return church ? c.json(church) : c.json({ error: "not found" }, 404);
});

api.get("/geocode", async (c) => {
  const q = str(c, "q");
  if (!q) throw new BadRequest("q is required");
  const lat = num(c, "lat"), lng = num(c, "lng");
  const bias = lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
  return c.json({ results: await geocode(c.env, q, { limit: num(c, "limit", { min: 1, max: 10 }), bias }) });
});

api.get("/reverse", async (c) => {
  const lat = num(c, "lat", { min: -90, max: 90 }), lng = num(c, "lng", { min: -180, max: 180 });
  if (lat === undefined || lng === undefined) throw new BadRequest("lat and lng are required");
  return c.json({ result: await reverseGeocode(c.env, lat, lng) });
});

api.get("/facets", async (c) => {
  const p = await point(c);
  return c.json(await facets(c.env, p.lat, p.lng, num(c, "radius_mi", { min: 0.1, max: 50 }) ?? 10));
});

api.get("/meta", async (c) => c.json(await meta(c.env)));
