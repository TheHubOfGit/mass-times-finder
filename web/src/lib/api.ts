// Typed client for our own API (never MassTimes directly).

export type Kind = "mass" | "confession" | "adoration" | "devotion";

export interface Source {
  name: string;
  url: string;
  report_error_url: string;
  last_updated: string | null;
}

export interface Church {
  id: string;
  name: string;
  address: { street: string | null; city: string | null; state: string | null; postal_code: string | null };
  lat: number;
  lng: number;
  distance_mi?: number;
  timezone: string;
  diocese: string | null;
  rite: string | null;
  church_type: string | null;
  primary_language: string | null;
  wheelchair: boolean | null;
  perpetual_adoration: boolean;
  phone: string | null;
  website: string | null;
  directions_url: string;
  source: Source;
}

export interface Occurrence {
  church: Church;
  kind: Kind;
  source_type: string | null;
  start: string;
  end: string | null;
  local_date: string;
  local_start: string;
  local_end: string | null;
  language: string | null;
  comment: string | null;
  holy_day: string | null;
  seasonal: boolean;
  in_progress: boolean;
}

export interface Service {
  kind: Kind | "other";
  source_type: string | null;
  days: number[];
  start: string | null;
  end: string | null;
  language: string | null;
  comment: string | null;
  perpetual: boolean;
  holy_day: boolean;
  vigil: boolean;
}

export interface ChurchDetails extends Church {
  county: string | null;
  diocese_type: string | null;
  email: string | null;
  pastor: string | null;
  comments: string | null;
  directions: string | null;
  services: Service[];
  next: { kind: Kind; start: string; local_date: string; local_start: string; local_end: string | null; language: string | null; comment: string | null; holy_day: string | null; in_progress: boolean }[];
  confirm_note: string;
}

export interface Place {
  label: string;
  lat: number;
  lng: number;
  kind?: string;
}

export interface Facet { value: string; churches: number }
export interface Facets {
  churches: number;
  languages: Facet[];
  rites: Facet[];
  church_types: Facet[];
  dioceses: Facet[];
  kinds: Facet[];
  wheelchair: number;
  perpetual_adoration: number;
}

export interface NextAnswer {
  soonest: Occurrence | null;
  nearest: Occurrence | null;
  alternatives: Occurrence[];
  searched: { radius_mi: number; from: string };
}

export interface HolyDay {
  date: string;
  name: string;
  weekday: number;
  obligatory: boolean;
  onSunday: boolean;
}

export interface Meta {
  churches: number;
  last_sync: string | null;
  regions: string[];
  holy_days: HolyDay[];
  source: { name: string; url: string; donate_url: string };
  confirm_note: string;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | undefined | null>;

export async function get<T>(path: string, params: Params = {}, signal?: AbortSignal): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === false || v === "") continue;
    qs.set(k, v === true ? "1" : String(v));
  }
  const res = await fetch(`/v1${path}${qs.size ? `?${qs}` : ""}`, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status);
  return body as T;
}
