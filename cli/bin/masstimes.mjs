#!/usr/bin/env node
// masstimes — find the nearest and next Mass from the command line (or from an AI agent).
// Talks only to the Mass Times Finder API; never to MassTimes.org directly.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "masstimes");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const DEFAULT_API = "https://masstimes.pages.dev";

const HELP = `masstimes — nearest and next Mass, confession or adoration (NYC + Long Island)

Usage:
  masstimes next   [where] [--kind mass|confession|adoration|devotion] [--lang Spanish] [--after ISO]
  masstimes find   [where] [--date today|tomorrow|sunday|YYYY-MM-DD] [--from HH:MM] [--to HH:MM] [--kind …] [--lang …]
  masstimes church <id | name>
  masstimes search <name or town> [where]
  masstimes places [list | add <name> <address> | remove <name> | default <name>]
  masstimes config [api <url>]

Where (pick one; default is your default saved place):
  --near "Garden City, NY"   --at 40.72,-73.63   --place home

Options:
  --radius <mi>   --wheelchair   --rite <rite>   --limit <n>   --json   -h, --help

Data from MassTimes.org. Times can change; please confirm with the parish.`;

// ---------- config ----------

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return { places: {}, default_place: null };
  }
}

function saveConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

const config = loadConfig();
const API = (process.env.MASSTIMES_API ?? config.api ?? DEFAULT_API).replace(/\/$/, "");

// ---------- http ----------

async function get(path, params = {}) {
  const url = new URL(`${API}/v1${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== false) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": "masstimes-cli/0.1" } });
  } catch (e) {
    fail(`Can't reach ${API} (${e.cause?.code ?? e.message}). Set the API with: masstimes config api <url>`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(body.error ?? `HTTP ${res.status}`);
  return body;
}

function fail(msg, code = 1) {
  if (flags.json) console.log(JSON.stringify({ error: msg }));
  else console.error(`masstimes: ${msg}`);
  process.exit(code);
}

// ---------- args ----------

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    near: { type: "string" }, at: { type: "string" }, place: { type: "string" },
    kind: { type: "string" }, lang: { type: "string" }, rite: { type: "string" },
    after: { type: "string" }, date: { type: "string" }, from: { type: "string" }, to: { type: "string" },
    radius: { type: "string" }, limit: { type: "string" }, wheelchair: { type: "boolean" },
    json: { type: "boolean" }, help: { type: "boolean", short: "h" },
  },
});
const [command, ...rest] = positionals;

/** Location params for the API: lat/lng, or `near` for the server to geocode. */
function where(fallbackText) {
  if (flags.at) {
    const [lat, lng] = flags.at.split(",").map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) fail(`--at must be "lat,lng"`);
    return { lat, lng };
  }
  if (flags.near) return { near: flags.near };
  if (fallbackText) return config.places[fallbackText] ? placeParams(fallbackText) : { near: fallbackText };
  const name = flags.place ?? config.default_place;
  if (name) return placeParams(name);
  fail('No location. Use --near "town or address", --at lat,lng, or save one: masstimes places add home "<address>"');
}

function placeParams(name) {
  const p = config.places[name];
  if (!p) fail(`No saved place "${name}". Saved: ${Object.keys(config.places).join(", ") || "none"}`);
  return { lat: p.lat, lng: p.lng, label: p.label };
}

function filterParams() {
  return { kind: flags.kind, lang: flags.lang, rite: flags.rite, wheelchair: flags.wheelchair ? 1 : undefined, radius_mi: flags.radius };
}

// ---------- formatting ----------

const fmtTime = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

function fmtDay(localDate, tz) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  if (localDate === today) return "Today";
  if (localDate === tomorrow) return "Tomorrow";
  return new Date(`${localDate}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function fmtOcc(o) {
  const c = o.church;
  const when = o.in_progress ? `Now (until ${fmtTime(o.local_end)})` : `${fmtDay(o.local_date, c.timezone)} ${fmtTime(o.local_start)}`;
  const kind = o.kind === "mass" ? "" : ` [${o.kind}]`;
  const extra = [o.language, o.holy_day && `for ${o.holy_day}`, o.comment && `“${o.comment}”`].filter(Boolean).join(" · ");
  const addr = [c.address.street, c.address.city].filter(Boolean).join(", ");
  return `${when.padEnd(16)} ${c.name}${kind}\n${" ".repeat(17)}${addr} · ${c.distance_mi?.toFixed(1)} mi${extra ? ` · ${extra}` : ""}`;
}

const out = (data, text) => console.log(flags.json ? JSON.stringify(data, null, 2) : text);
const NOTE = "\nData from MassTimes.org. Times can change; please confirm with the parish.";

// ---------- commands ----------

async function cmdNext() {
  const loc = where(rest.join(" ") || undefined);
  const { label, ...params } = loc;
  const r = await get("/next", { ...params, ...filterParams(), from: flags.after });
  r.location.label ??= label;
  if (!r.soonest) return out(r, `Nothing found within ${r.searched.radius_mi} mi in the next 2 days.${NOTE}`);
  const lines = [`Near ${r.location.label ?? `${r.location.lat}, ${r.location.lng}`}`, "", "Next:", "  " + fmtOcc(r.soonest).replace(/\n/g, "\n  ")];
  if (r.nearest && (r.nearest.church.id !== r.soonest.church.id || r.nearest.start !== r.soonest.start)) {
    lines.push("", "Closest church:", "  " + fmtOcc(r.nearest).replace(/\n/g, "\n  "));
  }
  if (r.alternatives.length) lines.push("", "Also:", ...r.alternatives.map((o) => "  " + fmtOcc(o).replace(/\n/g, "\n  ")));
  out(r, lines.join("\n") + "\n" + NOTE);
}

async function cmdFind() {
  const { label: _label, ...loc } = where(rest.join(" ") || undefined);
  const params = { ...loc, ...filterParams(), after: flags.from, before: flags.to, limit: flags.limit ?? 15 };
  if (flags.date) {
    const date = resolveDate(flags.date);
    if (!date) fail(`Couldn't understand --date ${flags.date}`);
    const daysAhead = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${todayNY()}T12:00:00Z`)) / 86400000);
    if (daysAhead < 0) fail("--date is in the past");
    // Search just that day from its midnight (any future date works; the API window is 14 days).
    const dayStart = new Date(`${date}T00:00:00`);
    Object.assign(params, { date, days: 0, from: daysAhead > 0 ? dayStart.toISOString() : undefined });
  }
  const r = await get("/upcoming", params);
  out(r, r.results.length ? r.results.map(fmtOcc).join("\n") + "\n" + NOTE : `Nothing found.${NOTE}`);
}

function todayNY() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

function resolveDate(s) {
  s = s.toLowerCase().trim();
  const today = todayNY();
  const plus = (n) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  if (s === "today" || s === "tonight") return today;
  if (s === "tomorrow") return plus(1);
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const i = days.findIndex((d) => d.startsWith(s.slice(0, 3)));
  if (i >= 0) return plus((i - new Date(`${today}T12:00:00Z`).getUTCDay() + 7) % 7);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

async function cmdSearch() {
  const [q, ...w] = rest;
  if (!q) fail("usage: masstimes search <name or town> [where]");
  const { label: _l, ...near } = flags.near || flags.at || flags.place || w.length ? where(w.join(" ") || undefined) : {};
  const nearLatLng = near.near ? (await get("/geocode", { q: near.near, limit: 1 })).results[0] : near;
  const r = await get("/churches/search", { q, lat: nearLatLng?.lat, lng: nearLatLng?.lng, limit: flags.limit ?? 10 });
  out(r, r.results.map((c) => `${c.name} — ${[c.address.street, c.address.city].filter(Boolean).join(", ")}` +
    `${c.distance_mi !== undefined ? ` (${c.distance_mi.toFixed(1)} mi)` : ""}\n  id: ${c.id}`).join("\n") || "No matches.");
}

async function cmdChurch() {
  const q = rest.join(" ");
  if (!q) fail("usage: masstimes church <id | name>");
  let id = q;
  if (!/^[0-9a-f-]{36}$/i.test(q)) {
    const hits = (await get("/churches/search", { q, limit: 5 })).results;
    if (!hits.length) fail(`No church matched "${q}"`);
    if (hits.length > 1 && !flags.json) console.error(`(${hits.length} matches; showing ${hits[0].name}, ${hits[0].address.city}. Use an id for others.)`);
    id = hits[0].id;
  }
  const c = await get(`/churches/${id}`);
  const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const ORDER = ["mass", "confession", "adoration", "devotion", "other"];
  const services = [...c.services].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const sched = services.filter((s) => s.start || s.perpetual).map((s) => {
    const days = s.perpetual ? "24/7" : s.days.length === 5 && s.days[0] === 1 ? "Mon–Fri" : s.days.map((d) => DAY[d]).join(",") || "—";
    const time = s.start ? fmtTime(s.start) + (s.end ? `–${fmtTime(s.end)}` : "") : "";
    return `  ${s.kind.padEnd(10)} ${(s.holy_day ? (s.vigil ? "holy-day vigil" : "holy days") : days).padEnd(14)} ${time.padEnd(18)} ${[s.language, s.comment].filter(Boolean).join(" · ")}`;
  });
  out(c, [
    c.name,
    [c.address.street, c.address.city, c.address.state, c.address.postal_code].filter(Boolean).join(", "),
    [c.phone, c.website].filter(Boolean).join(" · "),
    [c.rite, c.church_type, c.diocese].filter(Boolean).join(" · "),
    "", "Weekly schedule:", ...sched, "",
    `Directions: ${c.directions_url}`,
    `Last updated: ${c.source.last_updated?.slice(0, 10) ?? "unknown"} · Report a correction: ${c.source.report_error_url}`,
    NOTE,
  ].join("\n"));
}

async function cmdPlaces() {
  const [action = "list", name, ...addr] = rest;
  if (action === "list") {
    const names = Object.keys(config.places);
    return out(config, names.length
      ? names.map((n) => `${n === config.default_place ? "*" : " "} ${n.padEnd(12)} ${config.places[n].label}`).join("\n")
      : 'No saved places. Add one: masstimes places add home "123 Main St, Hempstead NY"');
  }
  if (action === "add") {
    if (!name || !addr.length) fail('usage: masstimes places add <name> "<address or lat,lng>"');
    const hit = (await get("/geocode", { q: addr.join(" "), limit: 1 })).results[0];
    if (!hit) fail(`Couldn't find "${addr.join(" ")}"`);
    config.places[name] = { label: hit.label, lat: hit.lat, lng: hit.lng };
    config.default_place ??= name;
    saveConfig(config);
    return out(config.places[name], `Saved "${name}": ${hit.label}${config.default_place === name ? " (default)" : ""}`);
  }
  if (action === "remove") {
    delete config.places[name];
    if (config.default_place === name) config.default_place = Object.keys(config.places)[0] ?? null;
    saveConfig(config);
    return out({ removed: name }, `Removed "${name}".`);
  }
  if (action === "default") {
    if (!config.places[name]) fail(`No saved place "${name}"`);
    config.default_place = name;
    saveConfig(config);
    return out({ default_place: name }, `Default place: ${name}`);
  }
  fail(`unknown places action: ${action}`);
}

function cmdConfig() {
  const [key, value] = rest;
  if (key === "api" && value) {
    config.api = value.replace(/\/$/, "");
    saveConfig(config);
    return out({ api: config.api }, `API: ${config.api}`);
  }
  out({ api: API, config_file: CONFIG_FILE }, `API: ${API}\nConfig: ${CONFIG_FILE}`);
}

const commands = { next: cmdNext, find: cmdFind, search: cmdSearch, church: cmdChurch, places: cmdPlaces, config: cmdConfig };
if (flags.help || !command) {
  console.log(HELP);
} else if (!commands[command]) {
  fail(`unknown command "${command}". Run masstimes --help`);
} else {
  await commands[command]();
}
