import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Kind, Place } from "./api";
import { addDays, localToday, nextWeekday } from "./format";

export type When = "soon" | "today" | "tomorrow" | "sunday" | "date" | "holyday";

export interface Filters {
  kind: Kind;
  when: When;
  date?: string; // when = "date" or "holyday"
  after?: string; // HH:MM
  before?: string;
  lang?: string;
  rite?: string;
  churchType?: string;
  wheelchair?: boolean;
  radius: number; // miles
  sort: "soonest" | "nearest";
}

export type Style = "parchment" | "rosary" | "cathedral";

export interface Settings {
  theme: "system" | "light" | "dark";
  style: Style;
  clock: "12" | "24";
  units: "mi" | "km";
}

export interface CurrentLocation extends Place {
  source: "gps" | "search" | "saved" | "link";
}

export interface SavedPlace extends Place {
  name: string;
}

export interface Favorite {
  id: string;
  name: string;
  city: string | null;
}

interface State {
  location: CurrentLocation | null;
  filters: Filters;
  settings: Settings;
  places: SavedPlace[];
  favorites: Favorite[];
  recents: Place[];
}

export const DEFAULT_FILTERS: Filters = { kind: "mass", when: "soon", radius: 5, sort: "soonest" };
const DEFAULT_SETTINGS: Settings = { theme: "system", style: "parchment", clock: "12", units: "mi" };
const STORAGE_KEY = "mtf:v1";

// ---------- persistence (localStorage can throw or be empty; the app must work without it) ----------

function load(): Partial<State> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function save(state: State) {
  try {
    const { location, filters, settings, places, favorites, recents } = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ location, filters, settings, places, favorites, recents }));
  } catch {
    /* private mode or storage blocked */
  }
}

// ---------- URL state: ?at=lat,lng&l=label&kind=…&when=…&date=…&lang=… ----------

function fromUrl(): { location?: CurrentLocation; filters?: Partial<Filters> } {
  const q = new URLSearchParams(location.search);
  const out: { location?: CurrentLocation; filters?: Partial<Filters> } = {};
  const at = q.get("at")?.split(",").map(Number);
  if (at && at.length === 2 && at.every(Number.isFinite)) {
    out.location = { lat: at[0], lng: at[1], label: q.get("l") ?? "Shared location", source: "link" };
  }
  const f: Partial<Filters> = {};
  const kind = q.get("kind");
  if (kind && ["mass", "confession", "adoration", "devotion"].includes(kind)) f.kind = kind as Kind;
  const when = q.get("when");
  if (when && ["soon", "today", "tomorrow", "sunday", "date", "holyday"].includes(when)) f.when = when as When;
  for (const k of ["date", "after", "before", "lang", "rite"] as const) if (q.get(k)) f[k] = q.get(k)!;
  if (q.get("type")) f.churchType = q.get("type")!;
  if (q.get("access") === "1") f.wheelchair = true;
  if (q.get("sort") === "nearest") f.sort = "nearest";
  if (q.get("r")) f.radius = Math.min(50, Math.max(1, Number(q.get("r")) || DEFAULT_FILTERS.radius));
  if (Object.keys(f).length) out.filters = f;
  return out;
}

export function stateToSearch(loc: CurrentLocation | null, f: Filters): string {
  const q = new URLSearchParams();
  if (loc) {
    q.set("at", `${loc.lat.toFixed(5)},${loc.lng.toFixed(5)}`);
    q.set("l", loc.label);
  }
  if (f.kind !== "mass") q.set("kind", f.kind);
  if (f.when !== "soon") q.set("when", f.when);
  if ((f.when === "date" || f.when === "holyday") && f.date) q.set("date", f.date);
  if (f.after) q.set("after", f.after);
  if (f.before) q.set("before", f.before);
  if (f.lang) q.set("lang", f.lang);
  if (f.rite) q.set("rite", f.rite);
  if (f.churchType) q.set("type", f.churchType);
  if (f.wheelchair) q.set("access", "1");
  if (f.radius !== DEFAULT_FILTERS.radius) q.set("r", String(f.radius));
  if (f.sort === "nearest") q.set("sort", "nearest");
  return q.toString();
}

// ---------- API params for a filter set ----------

/** Turn UI filters into /v1/upcoming params plus a client-side post-filter (for "this Sunday" incl. Saturday vigil). */
export function upcomingQuery(f: Filters, loc: { lat: number; lng: number }) {
  const today = localToday();
  const base = {
    lat: loc.lat, lng: loc.lng, kind: f.kind, lang: f.lang, rite: f.rite, church_type: f.churchType,
    wheelchair: f.wheelchair, radius_mi: f.radius, after: f.after, before: f.before,
  };
  const daysUntil = (d: string) => Math.max(0, Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000));
  switch (f.when) {
    case "soon":
      return { params: { ...base, days: 1, limit: 120 }, keep: () => true };
    case "today":
      return { params: { ...base, date: today, days: 0, limit: 300 }, keep: () => true };
    case "tomorrow":
      return { params: { ...base, date: addDays(today, 1), days: 1, limit: 300 }, keep: () => true };
    case "sunday": {
      const sunday = nextWeekday(0, today);
      const saturday = addDays(sunday, -1);
      return {
        params: { ...base, days: daysUntil(sunday), limit: 500 },
        // Sunday itself, plus the Saturday-evening vigil (MassTimes lists it as a "Weekend" service).
        keep: (o: { local_date: string; source_type: string | null; kind: Kind }) =>
          o.local_date === sunday || (o.local_date === saturday && (o.kind !== "mass" || o.source_type === "Weekend")),
      };
    }
    case "holyday": {
      // The holy day itself, plus vigil Masses the evening before.
      const date = f.date ?? today;
      const eve = addDays(date, -1);
      // Start at midnight of the vigil day (or now, if that's passed) and cover just two days, so holy days
      // weeks away work within the API's 14-day window.
      const eveStart = new Date(`${eve}T00:00:00`);
      const from = eveStart.getTime() > Date.now() ? eveStart : new Date();
      return {
        params: { ...base, from: from.toISOString(), days: from === eveStart ? 1 : daysUntil(date), limit: 500 },
        keep: (o: { local_date: string; source_type: string | null; kind: Kind; holy_day?: string | null }) =>
          o.local_date === date || (o.local_date === eve && o.kind === "mass" && !!o.holy_day),
      };
    }
    case "date": {
      // Search just the picked day (from its local midnight), so any future date works within the API's window.
      const date = f.date ?? today;
      const dayStart = new Date(`${date}T00:00:00`);
      const from = dayStart.getTime() > Date.now() ? dayStart : new Date();
      return { params: { ...base, date, from: from.toISOString(), days: 0, limit: 300 }, keep: () => true };
    }
  }
}

/** The local dates a filter set shows (for special-day banners). */
export function datesInView(f: Filters): string[] {
  const today = localToday();
  switch (f.when) {
    case "soon": return [today, addDays(today, 1)];
    case "today": return [today];
    case "tomorrow": return [addDays(today, 1)];
    case "sunday": { const sun = nextWeekday(0, today); return [addDays(sun, -1), sun]; }
    case "date": return [f.date ?? today];
    case "holyday": { const d = f.date ?? today; return [addDays(d, -1), d]; }
  }
}

// ---------- context ----------

interface Store extends State {
  setLocation: (loc: CurrentLocation | null) => void;
  setFilters: (patch: Partial<Filters>) => void;
  resetFilters: () => void;
  setSettings: (patch: Partial<Settings>) => void;
  savePlace: (p: SavedPlace) => void;
  removePlace: (name: string) => void;
  toggleFavorite: (f: Favorite) => void;
  isFavorite: (id: string) => boolean;
  addRecent: (p: Place) => void;
  activeFilterCount: number;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(() => {
    const saved = load();
    const url = fromUrl();
    return {
      location: url.location ?? saved.location ?? null,
      filters: { ...DEFAULT_FILTERS, ...saved.filters, ...url.filters },
      settings: { ...DEFAULT_SETTINGS, ...saved.settings },
      places: saved.places ?? [],
      favorites: saved.favorites ?? [],
      recents: saved.recents ?? [],
    };
  });

  useEffect(() => save(state), [state]);

  // Theme
  useEffect(() => {
    const apply = () => {
      const dark = state.settings.theme === "dark" ||
        (state.settings.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      document.documentElement.dataset.style = state.settings.style;
      // Keep the browser/OS chrome (Android status bar, PWA title bar) in step with the page.
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
      document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", bg));
    };
    apply();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [state.settings.theme, state.settings.style]);

  const setLocation = useCallback((location: CurrentLocation | null) => setState((s) => ({ ...s, location })), []);
  const setFilters = useCallback((patch: Partial<Filters>) => setState((s) => ({ ...s, filters: { ...s.filters, ...patch } })), []);
  const resetFilters = useCallback(() => setState((s) => ({ ...s, filters: { ...DEFAULT_FILTERS, kind: s.filters.kind, when: s.filters.when, date: s.filters.date, sort: s.filters.sort } })), []);
  const setSettings = useCallback((patch: Partial<Settings>) => setState((s) => ({ ...s, settings: { ...s.settings, ...patch } })), []);
  const savePlace = useCallback((p: SavedPlace) => setState((s) => ({ ...s, places: [...s.places.filter((x) => x.name !== p.name), p] })), []);
  const removePlace = useCallback((name: string) => setState((s) => ({ ...s, places: s.places.filter((x) => x.name !== name) })), []);
  const toggleFavorite = useCallback((f: Favorite) => setState((s) => ({
    ...s,
    favorites: s.favorites.some((x) => x.id === f.id) ? s.favorites.filter((x) => x.id !== f.id) : [...s.favorites, f],
  })), []);
  const addRecent = useCallback((p: Place) => setState((s) => ({
    ...s,
    recents: [p, ...s.recents.filter((r) => r.label !== p.label)].slice(0, 6),
  })), []);

  const store = useMemo<Store>(() => {
    const f = state.filters;
    const activeFilterCount = [f.lang, f.rite, f.churchType, f.wheelchair, f.after || f.before, f.radius !== DEFAULT_FILTERS.radius]
      .filter(Boolean).length;
    return {
      ...state, setLocation, setFilters, resetFilters, setSettings, savePlace, removePlace, toggleFavorite, addRecent,
      isFavorite: (id) => state.favorites.some((x) => x.id === id), activeFilterCount,
    };
  }, [state, setLocation, setFilters, resetFilters, setSettings, savePlace, removePlace, toggleFavorite, addRecent]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}
