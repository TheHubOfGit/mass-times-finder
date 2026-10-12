import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  churchDetails, CONFIRM_NOTE, type Env, nextService, type OccurrencePayload, searchByText, churchSummary,
  SOURCE_NAME, upcoming,
} from "./core";
import { resolveLocation } from "./geocode";
import { holyDayList, zonedParts, zonedTimeToUtc, ymd } from "./schedule";

const DEFAULT_TZ = "America/New_York"; // used to interpret "today"/"tomorrow" before we know which church
const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const kindSchema = z.enum(["mass", "confession", "adoration", "devotion"]);
const locationSchema = z.string().min(2).describe(
  'Where to search from: an address, ZIP, town, landmark, or "lat,lng". Agents have no GPS, so ask the user or use a place they mentioned (e.g. their home) if you don\'t know.',
);
const filterShape = {
  language: z.string().optional().describe('Service language, e.g. "Spanish", "Polish", "English"'),
  rite: z.string().optional().describe('e.g. "Roman-Latin", "Byzantine", "Ukrainian", "Maronite"'),
  wheelchair: z.boolean().optional().describe("Only wheelchair-accessible churches"),
  radius_mi: z.number().min(0.5).max(50).optional().describe("Search radius in miles (default widens 5 → 10 → 25 until something is found)"),
};

// ---------- formatting ----------

function fmtTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function fmtDay(localDate: string, tz: string, now = new Date()): string {
  const p = zonedParts(now, tz);
  const today = ymd(p.year, p.month, p.day);
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  if (localDate === today) return "today";
  if (localDate === tomorrow) return "tomorrow";
  return new Date(`${localDate}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}

function fmtOccurrence(o: OccurrencePayload): string {
  const c = o.church;
  const where = [c.address.street, c.address.city].filter(Boolean).join(", ");
  const when = o.in_progress
    ? `happening now (until ${o.local_end ? fmtTime(o.local_end) : "?"})`
    : `${fmtDay(o.local_date, c.timezone)} at ${fmtTime(o.local_start)}${o.local_end ? `–${fmtTime(o.local_end)}` : ""}`;
  const bits = [
    `${o.kind === "mass" ? "Mass" : o.kind[0].toUpperCase() + o.kind.slice(1)} at ${c.name} (${where})`,
    when,
    c.distance_mi !== undefined ? `${c.distance_mi.toFixed(1)} mi away` : null,
    o.language ? o.language : null,
    o.holy_day ? `for ${o.holy_day}` : null,
    o.comment ? `note: "${o.comment}"` : null,
  ];
  return bits.filter(Boolean).join(" · ");
}

function footer(lastUpdated?: string | null): string {
  return `Source: ${SOURCE_NAME}${lastUpdated ? ` (parish data last updated ${lastUpdated.slice(0, 10)})` : ""}. ${CONFIRM_NOTE}`;
}

function result(text: string, data: unknown) {
  return { content: [{ type: "text" as const, text }], structuredContent: data as Record<string, unknown> };
}

function error(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** Resolve "today" | "tomorrow" | weekday name | YYYY-MM-DD to a local date in `tz`. */
export function resolveDate(input: string, tz = DEFAULT_TZ, now = new Date()): string | null {
  const s = input.trim().toLowerCase();
  const p = zonedParts(now, tz);
  const today = ymd(p.year, p.month, p.day);
  const plus = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
  if (s === "today" || s === "tonight") return today;
  if (s === "tomorrow") return plus(1);
  const wd = WEEKDAY_NAMES.indexOf(s.replace(/^(this|next)\s+/, ""));
  if (wd >= 0) return plus((wd - p.weekday + 7) % 7 || (s.startsWith("next") ? 7 : 0));
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// ---------- server ----------

export function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "mass-times-finder", version: "0.1.0" });

  server.registerTool("next_mass", {
    title: "Next Mass nearby",
    description:
      "Answer \"what's the nearest and next Mass?\" from a location. Returns the next Mass that hasn't started yet, " +
      "the next Mass at the closest church, and a few alternatives, with straight-line distances. " +
      "Also works for confession, adoration or devotions via `kind`.",
    inputSchema: z.object({
      location: locationSchema,
      kind: kindSchema.optional().describe("Default: mass"),
      after: z.string().optional().describe('ISO datetime to search from (default: now), e.g. "2026-10-18T08:00:00-04:00"'),
      ...filterShape,
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => {
    const place = await resolveLocation(env, args.location);
    if (!place) return error(`Couldn't find "${args.location}". Try a street address, town, or ZIP.`);
    const from = args.after ? new Date(args.after) : new Date();
    if (Number.isNaN(from.getTime())) return error(`"after" must be an ISO datetime.`);
    const answer = await nextService(env, {
      lat: place.lat, lng: place.lng, from, kinds: [args.kind ?? "mass"], language: args.language,
      rite: args.rite, wheelchair: args.wheelchair, radiusMi: args.radius_mi,
    });
    const label = args.kind && args.kind !== "mass" ? args.kind : "Mass";
    if (!answer.soonest) {
      return result(`No upcoming ${label} found within ${answer.searched.radius_mi} mi of ${place.label} in the next 2 days. ${footer()}`,
        { location: place, ...answer });
    }
    const lines = [`Near ${place.label}:`, `• Next: ${fmtOccurrence(answer.soonest)}`];
    if (answer.nearest && answer.nearest !== answer.soonest &&
        (answer.nearest.church.id !== answer.soonest.church.id || answer.nearest.start !== answer.soonest.start)) {
      lines.push(`• Closest church: ${fmtOccurrence(answer.nearest)}`);
    } else {
      lines.push("• That's also the closest church with an upcoming time.");
    }
    if (answer.alternatives.length) {
      lines.push("Other options:", ...answer.alternatives.map((o) => `  – ${fmtOccurrence(o)}`));
    }
    lines.push(footer(answer.soonest.church.source.last_updated));
    return result(lines.join("\n"), { location: place, ...answer });
  });

  server.registerTool("find_services", {
    title: "Find Mass, confession or adoration times",
    description:
      "List upcoming services near a location, sorted by start time. Use for questions like " +
      "\"Spanish Mass Sunday near Hempstead\" or \"confession Saturday afternoon in Garden City\".",
    inputSchema: z.object({
      location: locationSchema,
      kind: kindSchema.optional().describe("Default: mass"),
      date: z.string().optional().describe('"today", "tomorrow", a weekday like "sunday", or YYYY-MM-DD. Default: next 2 days'),
      after: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('Earliest local start time, "HH:MM" (24h)'),
      before: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('Latest local start time, "HH:MM" (24h)'),
      limit: z.number().int().min(1).max(50).optional().describe("Default 10"),
      ...filterShape,
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => {
    const place = await resolveLocation(env, args.location);
    if (!place) return error(`Couldn't find "${args.location}". Try a street address, town, or ZIP.`);
    let from = new Date();
    let days = 2;
    let date: string | undefined;
    if (args.date) {
      const d = resolveDate(args.date);
      if (!d) return error(`Couldn't understand date "${args.date}".`);
      date = d;
      const [y, m, dd] = d.split("-").map(Number);
      const startOfDay = zonedTimeToUtc(y, m, dd, 0, 0, DEFAULT_TZ);
      if (startOfDay > from) from = startOfDay;
      days = 0; // `from` is that day's midnight (or now, if it's today): just that one local day
    }
    const limit = args.limit ?? 10;
    let occ: OccurrencePayload[] = [];
    // Dense areas (NYC) have plenty within 2 mi; widen only when there aren't enough results.
    for (const radiusMi of args.radius_mi ? [args.radius_mi] : [2, 5, 10, 25]) {
      occ = await upcoming(env, {
        lat: place.lat, lng: place.lng, from, days, date, after: args.after, before: args.before,
        kinds: [args.kind ?? "mass"], language: args.language, rite: args.rite, wheelchair: args.wheelchair,
        radiusMi, limit,
      });
      if (occ.length >= Math.min(limit, 5)) break;
    }
    const label = args.kind && args.kind !== "mass" ? args.kind : "Mass";
    const text = occ.length
      ? [`${label} near ${place.label}:`, ...occ.map((o) => `• ${fmtOccurrence(o)}`), footer()].join("\n")
      : `No ${label} found near ${place.label} for that time. Try a wider radius or another day. ${footer()}`;
    return result(text, { location: place, results: occ });
  });

  server.registerTool("holy_day_masses", {
    title: "Holy day of obligation Masses",
    description:
      "Find Masses for the next holy day of obligation (or a given date) near a location: the vigil Masses the evening " +
      "before and the Masses on the day. Also says whether the day is obligatory this year under US rules.",
    inputSchema: z.object({
      location: locationSchema,
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("A specific holy day (YYYY-MM-DD). Default: the next one that isn't a Sunday"),
      limit: z.number().int().min(1).max(40).optional().describe("Default 15"),
      ...filterShape,
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => {
    const place = await resolveLocation(env, args.location);
    if (!place) return error(`Couldn't find "${args.location}". Try a street address, town, or ZIP.`);
    const p = zonedParts(new Date(), DEFAULT_TZ);
    const today = ymd(p.year, p.month, p.day);
    const nextYear = `${p.year + 1}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    const days = holyDayList(today, nextYear);
    const hd = args.date ? days.find((h) => h.date === args.date) : days.find((h) => !h.onSunday);
    if (!hd) return error(args.date ? `${args.date} isn't a US holy day of obligation.` : "No upcoming holy day found.");
    const eve = new Date(Date.parse(`${hd.date}T12:00:00Z`) - 86400_000).toISOString().slice(0, 10);
    const [y, m, d] = eve.split("-").map(Number);
    const eveStart = zonedTimeToUtc(y, m, d, 0, 0, DEFAULT_TZ);
    const from = eveStart > new Date() ? eveStart : new Date();
    const horizon = Math.max(1, Math.ceil((Date.parse(`${hd.date}T23:59:00Z`) - from.getTime()) / 86400_000));
    const occ = (await upcoming(env, {
      lat: place.lat, lng: place.lng, from, days: horizon, kinds: ["mass"], language: args.language, rite: args.rite,
      wheelchair: args.wheelchair, radiusMi: args.radius_mi ?? 5, limit: 500,
    })).filter((o) => o.local_date === hd.date || (o.local_date === eve && o.holy_day !== null))
      .slice(0, args.limit ?? 15);
    const when = new Date(`${hd.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
    const status = hd.onSunday ? "Falls on a Sunday: regular Sunday Masses apply."
      : hd.obligatory ? "Holy day of obligation." : "Not a day of obligation this year (US rules), but Masses are still celebrated.";
    const lines = [`${hd.name}: ${when}. ${status}`, `Near ${place.label}:`];
    lines.push(...(occ.length ? occ.map((o) => `• ${o.local_date === eve ? "Vigil, " : ""}${fmtOccurrence(o)}`) : ["No holy-day Masses listed nearby yet. Parishes often post them close to the date."]));
    lines.push(footer());
    return result(lines.join("\n"), { holy_day: hd, location: place, results: occ });
  });

  server.registerTool("search_churches", {
    title: "Search churches",
    description: "Find churches by name or town (e.g. \"St. Agnes Rockville Centre\"). Returns ids for church_details.",
    inputSchema: z.object({
      query: z.string().min(2),
      near: z.string().optional().describe("Optional location to sort results by distance"),
      limit: z.number().int().min(1).max(25).optional(),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => {
    const near = args.near ? await resolveLocation(env, args.near) : null;
    const rows = await searchByText(env, args.query, {}, near ?? undefined, args.limit ?? 10);
    const churches = rows.map(({ row, distance }) => churchSummary(row, distance));
    const text = churches.length
      ? churches.map((c) => `• ${c.name} — ${[c.address.street, c.address.city].filter(Boolean).join(", ")}` +
          `${c.distance_mi !== undefined ? ` (${c.distance_mi.toFixed(1)} mi)` : ""} [id: ${c.id}]`).join("\n")
      : `No churches matched "${args.query}".`;
    return result(text, { results: churches });
  });

  server.registerTool("church_details", {
    title: "Church details and schedule",
    description: "Full weekly schedule, contact info, and the next week's times for one church (id from another tool).",
    inputSchema: z.object({ church_id: z.string() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => {
    const c = await churchDetails(env, args.church_id);
    if (!c) return error(`No church with id ${args.church_id}.`);
    const lines = [
      `${c.name}`,
      [c.address.street, c.address.city, c.address.state, c.address.postal_code].filter(Boolean).join(", "),
      [c.phone, c.website].filter(Boolean).join(" · "),
      `${c.rite ?? ""} ${c.church_type ?? ""} · ${c.diocese ?? ""}`.trim(),
      "",
      "Next 7 days:",
      ...c.next.map((o) => `• ${o.kind} ${fmtDay(o.local_date, c.timezone)} ${fmtTime(o.local_start)}` +
        `${o.language ? ` (${o.language})` : ""}${o.comment ? ` — ${o.comment}` : ""}`),
      c.perpetual_adoration ? "• Perpetual adoration chapel" : "",
      "",
      `Directions: ${c.directions_url}`,
      footer(c.source.last_updated),
    ];
    return result(lines.filter((l, i) => l !== "" || i > 0).join("\n"), c);
  });

  return server;
}
