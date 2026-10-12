import type { Kind } from "./api";

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const KIND_LABEL: Record<Kind, string> = {
  mass: "Mass",
  confession: "Confession",
  adoration: "Adoration",
  devotion: "Devotions",
};

export function fmtTime(hhmm: string, clock: "12" | "24" = "12"): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (clock === "24") return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const suffix = h < 12 ? "AM" : "PM";
  const hour = ((h + 11) % 12) + 1;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** Split "5:30 PM" into ["5:30", "PM"] for typographic treatment. */
export function timeParts(hhmm: string, clock: "12" | "24" = "12"): [string, string] {
  const s = fmtTime(hhmm, clock);
  const i = s.lastIndexOf(" ");
  return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ""];
}

export function localToday(): string {
  return new Intl.DateTimeFormat("en-CA").format(new Date());
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekday(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function nextWeekday(dow: number, from = localToday()): string {
  return addDays(from, (dow - weekday(from) + 7) % 7);
}

export function fmtDate(date: string, opts: { relative?: boolean } = { relative: true }): string {
  const today = localToday();
  if (opts.relative) {
    if (date === today) return "Today";
    if (date === addDays(today, 1)) return "Tomorrow";
  }
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}

export function fmtDistance(mi: number | undefined, units: "mi" | "km" = "mi"): string {
  if (mi === undefined) return "";
  if (units === "km") {
    const km = mi * 1.609344;
    return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
  }
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

/** "in 25 min", "in 2 hr", "started 10 min ago" relative to now. */
export function fmtRelative(iso: string, now = Date.now()): string {
  const diff = Math.round((Date.parse(iso) - now) / 60000);
  if (diff < 0) return `started ${-diff} min ago`;
  if (diff < 1) return "starting now";
  if (diff < 60) return `in ${diff} min`;
  const h = Math.floor(diff / 60), m = diff % 60;
  if (h < 6 && m >= 10) return `in ${h} hr ${m} min`;
  return `in ${h} hr`;
}

export function fmtUpdated(iso: string | null): string {
  if (!iso) return "unknown";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function addressLine(a: { street: string | null; city: string | null }): string {
  // Some street fields already include the city ("384 Clinton St, Hempstead, NY"); avoid repeating it.
  const street = a.street ?? "";
  if (a.city && street.toLowerCase().includes(a.city.toLowerCase())) return street;
  return [street, a.city].filter(Boolean).join(", ");
}

/** Strip bracketed rite notes from names for display: "St. Vladimir [Ukrainian]" → ["St. Vladimir", "Ukrainian"]. */
export function splitName(name: string): [string, string | null] {
  const m = /^(.*?)\s*\[(.+)\]\s*$/.exec(name);
  return m ? [m[1], m[2]] : [name, null];
}
