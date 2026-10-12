// Turns MassTimes' free-text service notes into date rules, conservatively.
// Only clear wording is acted on; anything ambiguous is left alone (the note is still shown).
//
// Handled (examples from real listings):
//   "First Fri." / "1st Fridays" / "2nd, 3rd & 4th Saturdays of the month" / "Third Sunday of the month."
//   "Except on Easter, Christmas & New Year days" / "No 7:00am Mass on Legal Holidays or the Day after Christmas, Easter or Thanksgiving."
//   "Suppressed December 24 to January 1" / "not from July 4 to Labor Day" / "Paused from the 2nd week of July to the 2nd week of Sept."
//   "mid-September to mid-June only" / "October to June ONLY" / "July and August" / "Except in July & August" / "Suspended for the Summer"
//   "Semester Only" / "SUSPENDED until further notice"

export interface DayInfo {
  date: string; // YYYY-MM-DD
  y: number;
  m: number; // 1-12
  d: number;
  dow: number; // 0 = Sunday
  tags: Set<string>; // holiday tags for this date (see holidayTags)
}

// ---------- calendar helpers ----------

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const dowOf = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function addDaysStr(date: string, n: number): string {
  const t = new Date(`${date}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** nth (1-based) weekday of a month; n = -1 for the last. */
function nthWeekday(y: number, m: number, dow: number, n: number): string {
  if (n > 0) {
    const first = dowOf(y, m, 1);
    return ymd(y, m, 1 + ((dow - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = daysIn(y, m);
  const last = dowOf(y, m, lastDay);
  return ymd(y, m, lastDay - ((last - dow + 7) % 7));
}

export function easterDate(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mm = Math.floor((a + 11 * h + 22 * l) / 451);
  return ymd(year, Math.floor((h + l - 7 * mm + 114) / 31), ((h + l - 7 * mm + 114) % 31) + 1);
}

/** Named days used by notes and by the special-day banner, for one year: tag -> date. */
export function namedDays(year: number): Map<string, string> {
  const easter = easterDate(year);
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  const m = new Map<string, string>([
    ["new year", ymd(year, 1, 1)],
    ["mlk day", nthWeekday(year, 1, 1, 3)],
    ["presidents day", nthWeekday(year, 2, 1, 3)],
    ["ash wednesday", addDaysStr(easter, -46)],
    ["holy thursday", addDaysStr(easter, -3)],
    ["good friday", addDaysStr(easter, -2)],
    ["holy saturday", addDaysStr(easter, -1)],
    ["easter", easter],
    ["day after easter", addDaysStr(easter, 1)],
    ["memorial day", nthWeekday(year, 5, 1, -1)],
    ["juneteenth", ymd(year, 6, 19)],
    ["july 4", ymd(year, 7, 4)],
    ["labor day", nthWeekday(year, 9, 1, 1)],
    ["columbus day", nthWeekday(year, 10, 1, 2)],
    ["veterans day", ymd(year, 11, 11)],
    ["thanksgiving", thanksgiving],
    ["day after thanksgiving", addDaysStr(thanksgiving, 1)],
    ["christmas eve", ymd(year, 12, 24)],
    ["christmas", ymd(year, 12, 25)],
    ["day after christmas", ymd(year, 12, 26)],
  ]);
  return m;
}

const LEGAL_HOLIDAYS = ["new year", "mlk day", "presidents day", "memorial day", "juneteenth", "july 4", "labor day",
  "columbus day", "veterans day", "thanksgiving", "christmas"];

const tagCache = new Map<number, Map<string, Set<string>>>();

/** Holiday tags for a date: e.g. {"christmas", "legal holiday"}. */
export function holidayTags(date: string): Set<string> {
  const year = +date.slice(0, 4);
  let byDate = tagCache.get(year);
  if (!byDate) {
    byDate = new Map();
    for (const [tag, d] of namedDays(year)) {
      if (!byDate.has(d)) byDate.set(d, new Set());
      byDate.get(d)!.add(tag);
      if (LEGAL_HOLIDAYS.includes(tag)) byDate.get(d)!.add("legal holiday");
    }
    tagCache.set(year, byDate);
  }
  return byDate.get(date) ?? new Set();
}

// ---------- parsing ----------

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const WEEKDAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const ORD: Record<string, number> = {
  first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, last: -1,
};
const ORD_RE = "(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\\.?";
const NEGATION = /\b(no|not|except|excluding|suppressed|paused|suspended|cancel(?:l)?ed|closed|none)\b/i;
const HOLIDAY_WORDS: [RegExp, string][] = [
  [/christmas eve/i, "christmas eve"], [/christmas/i, "christmas"], [/easter/i, "easter"],
  [/new year/i, "new year"], [/thanksgiving/i, "thanksgiving"],
  [/\b(legal|civic|civil|federal|national|public) holidays?\b/i, "legal holiday"],
  [/memorial day/i, "memorial day"], [/labor day/i, "labor day"],
  [/(july 4(th)?|fourth of july|independence day)/i, "july 4"],
  [/good friday/i, "good friday"], [/holy thursday/i, "holy thursday"], [/ash wednesday/i, "ash wednesday"],
  [/holy days?( of obligation)?/i, "holy day"],
];

const POINT_RE = `(?:the\\s+)?(?:(?:mid-?\\s*)?${MONTH_RE}(?:\\s+\\d{1,2}(?:st|nd|rd|th)?)?|\\d(?:st|nd|rd|th) week of ${MONTH_RE}|labor day|memorial day|thanksgiving|christmas eve|christmas|easter|july 4(?:th)?|new year'?s?(?: day)?)`;
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A point in the year, resolved per year to a month-day (with day-precision). */
type Point = (year: number) => { m: number; d: number };

function parsePoint(text: string, isEnd: boolean): Point | null {
  const t = text.trim().toLowerCase().replace(/^the\s+/, "");
  let mm = new RegExp(`^(mid-?\\s*)?${MONTH_RE}(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?)?$`).exec(t);
  if (mm) {
    const month = MONTHS[mm[2].replace(".", "")];
    const day = mm[3] ? +mm[3] : null;
    const mid = Boolean(mm[1]);
    return (y) => ({ m: month, d: day ?? (mid ? 15 : isEnd ? daysIn(y, month) : 1) });
  }
  mm = new RegExp(`^(\\d)(?:st|nd|rd|th) week of ${MONTH_RE}$`).exec(t);
  if (mm) {
    const n = +mm[1], month = MONTHS[mm[2].replace(".", "")];
    return () => ({ m: month, d: isEnd ? Math.min(n * 7, 28) : (n - 1) * 7 + 1 });
  }
  const named = t.replace(/^new year'?s?( day)?$/, "new year").replace(/^july 4th$/, "july 4");
  for (const [re, tag] of HOLIDAY_WORDS) {
    if (re.test(named) && named.replace(re, "").trim() === "" && tag !== "legal holiday" && tag !== "holy day") {
      return (y) => {
        const d = namedDays(y).get(tag)!;
        return { m: +d.slice(5, 7), d: +d.slice(8, 10) };
      };
    }
  }
  return null;
}

/** Is date within [from, to] (inclusive; wraps the year end when from > to)? */
function inRange(day: DayInfo, from: Point, to: Point): boolean {
  const a = from(day.y), b = to(day.y);
  const v = day.m * 100 + day.d, lo = a.m * 100 + a.d, hi = b.m * 100 + b.d;
  return lo <= hi ? v >= lo && v <= hi : v >= lo || v <= hi;
}

interface Rule {
  always?: boolean; // suspended indefinitely
  exclude: ((day: DayInfo) => boolean)[];
  only: ((day: DayInfo) => boolean)[]; // any-of
  nth?: { dow: number; ns: Set<number> };
}

const SUMMER = (day: DayInfo) => day.m === 7 || day.m === 8;
// Academic semesters, approximately: off from late May through late August, and over the Christmas break.
const OFF_SEMESTER = (day: DayInfo) => {
  const v = day.m * 100 + day.d;
  return (v >= 520 && v <= 825) || v >= 1220 || v <= 115;
};

const ruleCache = new Map<string, Rule | null>();

export function parseNote(note: string): Rule | null {
  if (ruleCache.has(note)) return ruleCache.get(note)!;
  const rule: Rule = { exclude: [], only: [] };
  let nthAmbiguous = false;
  const text = note.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();

  if (/(suspended|cancel(?:l)?ed|discontinued) until further notice|temporarily suspended/.test(lower)) rule.always = true;

  // Segments: sentences, "|"-separated translations, and ";" clauses.
  const segments = text.split(/[|;]|\.\s+|\.$/).map((s) => s.trim()).filter(Boolean);

  for (const seg of segments) {
    let s = seg.toLowerCase();
    // "Note: …" describes something extra; "If …" sentences are conditional. Neither restricts the service.
    if (/^note\b|^\*?note:|\bif\b/.test(s)) continue;

    // Ordinal weekday at the START of a segment: "First Fri", "2nd, 3rd & 4th Saturdays of the month".
    const nth = new RegExp(`^${ORD_RE}((?:\\s*(?:,|and|&)\\s*${ORD_RE})*)\\.?\\s+(sun|mon|tue|wed|thu|fri|sat)[a-z]*\\.?`).exec(s);
    if (nth && !/^eve of/.test(s)) {
      const ords = [...s.slice(0, nth[0].length).matchAll(new RegExp(ORD_RE, "g"))].map((x) => ORD[x[1]]);
      const next = { dow: WEEKDAYS[nth[nth.length - 1]], ns: new Set(ords) };
      // Two different ordinal rules in one note ("1st & 3rd in English; 2nd & 4th in Malayalam") are ambiguous.
      if (rule.nth && (rule.nth.dow !== next.dow || [...next.ns].some((n) => !rule.nth!.ns.has(n)))) nthAmbiguous = true;
      rule.nth = next;
      // Keep reading the rest of the segment for a season: "First Tuesdays -October to June ONLY".
      s = s.slice(nth[0].length).replace(/^[\s,:;-]*(of (the )?month)?[\s,:;-]*/, "");
      if (!s) continue;
    }
    const negated = NEGATION.test(s);

    // Date ranges anywhere in the segment: "December 24 to January 1", "(Sept to June)", "July-Labor Day".
    let rm: RegExpExecArray | null = null;
    {
      const flat = s.replace(/\s+/g, " ");
      rm = new RegExp(`(?<from>${POINT_RE})\\s*(?:to|through|thru|until|till|-|–)\\s*(?<to>${POINT_RE})(?![a-z])`).exec(flat);
      if (rm) {
        const a = parsePoint(rm.groups!.from, false), b = parsePoint(rm.groups!.to, true);
        if (a && b) {
          const parenthetical = new RegExp(`\\(\\s*${escapeRe(rm[0])}\\s*\\)`).test(flat);
          const bare = flat.replace(/[()]/g, "").replace(/\bonly\b/, "").replace(/[\s.,:;-]+/g, " ").trim() === rm[0].replace(/[\s.,:;-]+/g, " ").trim();
          if (negated) rule.exclude.push((day) => inRange(day, a, b));
          else if (/\bonly\b/.test(flat) || parenthetical || bare) rule.only.push((day) => inRange(day, a, b));
        } else {
          rm = null;
        }
      }
    }

    // Holiday exceptions (need negation): "Except on Easter, Christmas & New Year days".
    if (negated) {
      let rest = s;
      const after = /day after ((?:christmas|easter|thanksgiving)(?:\s*(?:,|or|and|&)\s*(?:christmas|easter|thanksgiving))*)/.exec(rest);
      if (after) {
        for (const h of after[1].match(/christmas|easter|thanksgiving/g) ?? []) {
          const tag = `day after ${h}`;
          rule.exclude.push((day) => day.tags.has(tag));
        }
        rest = rest.replace(after[0], " ");
      }
      rest = rest.replace(/from [^,]*? to [^,]*$/, " "); // range endpoints aren't holiday exceptions
      for (const [re, tag] of HOLIDAY_WORDS) {
        if (re.test(rest)) {
          rest = rest.replace(re, " ");
          rule.exclude.push((day) => (tag === "holy day" ? day.tags.has("holy day") : day.tags.has(tag)));
        }
      }
    }

    // Month lists without a range: "July and August" (only), "Except in July & August" (excluded).
    if (!rm) {
      const ml = new RegExp(`^(?:.*?\\b(?:in|during|for)\\s+)?(${MONTH_RE}(?:\\s*(?:,|and|&|/)\\s*${MONTH_RE})*)(?:\\s+only)?\\s*\\.?$`).exec(s);
      if (ml) {
        const months = new Set([...ml[1].matchAll(new RegExp(MONTH_RE, "g"))].map((x) => MONTHS[x[1].replace(".", "")]));
        const onlyMay = months.size === 1 && months.has(5) && !/\bmay\b\s*(only)?\.?$/.test(s);
        if (!onlyMay) {
          if (negated) rule.exclude.push((day) => months.has(day.m));
          else if (ml[0] === s) rule.only.push((day) => months.has(day.m));
        }
      }
    }

    // Seasons.
    if (/\bsummer\b/.test(s)) {
      if (negated) rule.exclude.push(SUMMER);
      else if (/^summer( schedule| only| months)?$/.test(s)) rule.only.push(SUMMER);
    }
    if (/\bsemesters?\b.*\bonly\b|\bonly during (the )?(fall|spring|academic)/.test(s)) rule.exclude.push(OFF_SEMESTER);
  }

  if (nthAmbiguous) rule.nth = undefined;
  const result = rule.always || rule.exclude.length || rule.only.length || rule.nth ? rule : null;
  ruleCache.set(note, result);
  return result;
}

/** Does this note allow the service on this day? (No note, or nothing parseable: yes.) */
export function noteAllows(note: string | null, day: DayInfo): boolean {
  if (!note) return true;
  const rule = parseNote(note);
  if (!rule) return true;
  if (rule.always) return false;
  if (rule.exclude.some((f) => f(day))) return false;
  if (rule.only.length && !rule.only.some((f) => f(day))) return false;
  if (rule.nth && rule.nth.dow === day.dow) {
    const n = Math.ceil(day.d / 7);
    const isLast = day.d + 7 > daysIn(day.y, day.m);
    if (!rule.nth.ns.has(n) && !(rule.nth.ns.has(-1) && isLast)) return false;
  }
  return true;
}

export function dayInfo(date: string, extraTags: string[] = []): DayInfo {
  const [y, m, d] = date.split("-").map(Number);
  const tags = new Set([...holidayTags(date), ...extraTags]);
  return { date, y, m, d, dow: dowOf(y, m, d), tags };
}
