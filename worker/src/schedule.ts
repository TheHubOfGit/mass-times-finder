// Expands a church's weekly schedule into concrete occurrences.
// All schedule times are local wall-clock times in the church's own time zone.

export type ServiceKind = "mass" | "confession" | "adoration" | "devotion" | "other";

export interface Service {
  kind: ServiceKind;
  source_type: string | null;
  days: number[]; // 0 = Sunday … 6 = Saturday; [] = unspecified
  start: string | null; // "HH:MM"
  end: string | null;
  language: string | null;
  comment: string | null;
  perpetual: boolean;
  holy_day: boolean;
  vigil: boolean;
}

export interface Occurrence {
  service: Service;
  start: Date; // UTC instant
  end: Date | null;
  localDate: string; // YYYY-MM-DD in the church's zone
  localStart: string; // HH:MM
  localEnd: string | null;
  holyDay: string | null; // name of the holy day this occurrence is for
  seasonal: boolean; // has a free-text note that may limit when it applies
  inProgress: boolean; // started before `from` but hasn't ended (confession, adoration)
}

// ---------- time zone helpers (no libraries; Intl only) ----------

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }

export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const p: Record<string, string> = {};
  for (const { type, value } of dtf(timeZone).formatToParts(instant)) p[type] = value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second, weekday: WEEKDAYS[p.weekday],
  };
}

/** UTC instant for a local wall-clock time in `timeZone`. Nonexistent (spring-forward) times shift forward. */
const offsetCache = new Map<string, number>();

export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  // A zone's offset is constant within an hour on a given day, so cache per zone/date/hour (Intl is slow).
  const key = `${timeZone}|${year}-${month}-${day}|${hour}`;
  const cached = offsetCache.get(key);
  if (cached !== undefined) return new Date(asUtc - cached);
  const result = zonedTimeToUtcUncached(asUtc, timeZone);
  if (offsetCache.size > 5000) offsetCache.clear();
  offsetCache.set(key, asUtc - result.getTime());
  return result;
}

function zonedTimeToUtcUncached(asUtc: number, timeZone: string): Date {
  let guess = asUtc;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = shown - asUtc;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}

// ---------- calendar helpers ----------

export function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** Gregorian Easter Sunday (anonymous computus). */
export function easter(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(year, month, day);
}

/**
 * US holy days of obligation celebrated on a weekday, by date.
 * `ascensionThursday` is false for the Province of New York (and most US provinces), which move it to Sunday.
 * Immaculate Conception falling on a Sunday is transferred to Monday.
 */
export function holyDays(year: number, ascensionThursday = false): Map<string, string> {
  const days = new Map<string, string>([
    [ymd(year, 1, 1), "Mary, Mother of God"],
    [ymd(year, 8, 15), "Assumption of Mary"],
    [ymd(year, 11, 1), "All Saints"],
    [ymd(year, 12, 25), "Christmas"],
  ]);
  const ic = ymd(year, 12, 8);
  days.set(weekdayOf(ic) === 0 ? addDays(ic, 1) : ic, "Immaculate Conception");
  if (ascensionThursday) days.set(addDays(easter(year), 39), "Ascension");
  return days;
}

export interface HolyDay {
  date: string;
  name: string;
  weekday: number;
  /** Whether attending Mass is required that day under US rules (USCCB). */
  obligatory: boolean;
  /** Falls on a Sunday, so the regular Sunday Masses apply. */
  onSunday: boolean;
}

/**
 * Holy days with their US obligation status:
 * - Mary, Mother of God (Jan 1), Assumption (Aug 15), All Saints (Nov 1): not obligatory on a Saturday or Monday.
 * - Immaculate Conception moved off a Sunday to Monday: celebrated, but not obligatory.
 * - Christmas (and Ascension where kept on Thursday): always obligatory.
 */
export function holyDayList(from: string, to: string, ascensionThursday = false): HolyDay[] {
  const out: HolyDay[] = [];
  for (const [date, name] of holyDaysBetween(from, to, ascensionThursday)) {
    const weekday = weekdayOf(date);
    let obligatory = true;
    if (/^\d{4}-(01-01|08-15|11-01)$/.test(date) && (weekday === 6 || weekday === 1)) obligatory = false;
    if (name === "Immaculate Conception" && date.endsWith("-12-09")) obligatory = false;
    out.push({ date, name, weekday, obligatory, onSunday: weekday === 0 });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function holyDaysBetween(from: string, to: string, ascensionThursday = false): Map<string, string> {
  const out = new Map<string, string>();
  for (let y = +from.slice(0, 4); y <= +to.slice(0, 4); y++) {
    for (const [d, name] of holyDays(y, ascensionThursday)) if (d >= from && d <= to) out.set(d, name);
  }
  return out;
}

// ---------- expansion ----------

export interface ExpandOptions {
  from: Date;
  days?: number; // horizon in days (default 7)
  kinds?: ServiceKind[];
  language?: string; // case-insensitive; matches service language, or church language when the service has none
  churchLanguage?: string | null;
  ascensionThursday?: boolean;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

interface CalendarDay {
  date: string;
  y: number;
  m: number;
  d: number;
  dow: number;
  holy: string | null; // holy day on this date
  holyTomorrow: string | null; // holy day on the next date (for vigils)
  next: string; // following date, for services that end after midnight
}

const calendarCache = new Map<string, CalendarDay[]>();

/** The local dates [today-1, today+horizon] with weekday and holy-day info, cached per zone/day/horizon. */
function calendar(today: string, horizon: number, ascensionThursday: boolean): CalendarDay[] {
  const key = `${today}|${horizon}|${ascensionThursday}`;
  const hit = calendarCache.get(key);
  if (hit) return hit;
  const first = addDays(today, -1);
  const last = addDays(today, horizon);
  const holy = holyDaysBetween(first, addDays(last, 1), ascensionThursday);
  const days: CalendarDay[] = [];
  for (let date = first; date <= last; date = addDays(date, 1)) {
    const [y, m, d] = date.split("-").map(Number);
    const next = addDays(date, 1);
    days.push({ date, y, m, d, dow: weekdayOf(date), holy: holy.get(date) ?? null, holyTomorrow: holy.get(next) ?? null, next });
  }
  if (calendarCache.size > 100) calendarCache.clear();
  calendarCache.set(key, days);
  return days;
}

export function expandSchedule(services: Service[], timeZone: string, opts: ExpandOptions): Occurrence[] {
  const now = zonedParts(opts.from, timeZone);
  const days = calendar(ymd(now.year, now.month, now.day), opts.days ?? 7, opts.ascensionThursday ?? false);
  const lang = opts.language?.trim().toLowerCase();
  const fromMs = opts.from.getTime();

  // Weekdays on which this church lists dedicated (non-vigil) holy-day Masses.
  const holyRowsByDow = new Set<number>();
  for (const s of services) if (s.holy_day && !s.vigil && s.start) for (const d of s.days.length ? s.days : [1, 2, 3, 4, 5, 6]) holyRowsByDow.add(d);

  const out: Occurrence[] = [];
  for (const s of services) {
    if (!s.start) continue; // perpetual adoration and untimed entries have no occurrences
    if (opts.kinds && !opts.kinds.includes(s.kind)) continue;
    if (lang) {
      const effective = (s.language ?? opts.churchLanguage ?? "").toLowerCase();
      if (effective !== lang) continue;
    }
    if (!s.days.length && !s.holy_day) continue; // a regular service with no day can't be placed on a calendar
    // On a holy day, a church that lists its own holy-day Masses for that weekday follows that schedule
    // instead of its regular weekday one (parishes publish "Holy Days: 7, 12:10, 7:30" as a replacement).
    const replacedOnHolyDays = s.kind === "mass" && !s.holy_day && !s.vigil;
    const [sh, sm] = s.start.split(":").map(Number);
    const endParts = s.end ? s.end.split(":").map(Number) : null;
    const crossesMidnight = s.end !== null && toMinutes(s.end) <= toMinutes(s.start);

    for (const day of days) {
      if (s.days.length && !s.days.includes(day.dow)) continue;
      let holyDay: string | null = null;
      if (replacedOnHolyDays && day.holy && day.dow !== 0 && holyRowsByDow.has(day.dow)) continue;
      if (s.vigil) {
        holyDay = day.holyTomorrow; // the evening before a holy day
        if (!holyDay) continue;
      } else if (s.holy_day) {
        holyDay = day.holy;
        if (!holyDay) continue;
      }

      const start = zonedTimeToUtc(day.y, day.m, day.d, sh, sm, timeZone);
      let end: Date | null = null;
      if (endParts) {
        if (crossesMidnight) {
          const [ey, emo, ed] = day.next.split("-").map(Number);
          end = zonedTimeToUtc(ey, emo, ed, endParts[0], endParts[1], timeZone);
        } else {
          end = zonedTimeToUtc(day.y, day.m, day.d, endParts[0], endParts[1], timeZone);
        }
      }

      const startMs = start.getTime();
      const inProgress = startMs < fromMs && end !== null && end.getTime() > fromMs;
      if (startMs < fromMs && !inProgress) continue;
      out.push({
        service: s, start, end, localDate: day.date, localStart: s.start, localEnd: s.end,
        holyDay, seasonal: Boolean(s.comment), inProgress,
      });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}
