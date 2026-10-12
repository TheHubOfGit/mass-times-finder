// Address / place → coordinates, via Photon (komoot) with Nominatim as fallback.
// Results are cached in D1 so we stay well inside both services' usage policies.

import type { Env } from "./core";

export interface Place {
  label: string;
  lat: number;
  lng: number;
  kind?: string;
}

const REGION_BIAS = { lat: 40.75, lng: -73.4 }; // default bias (NYC + Long Island) when the caller gives no location
const CACHE_DAYS = 30;
const LATLNG = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

function userAgent(env: Env) {
  return `MassTimesFinder/0.1 (contact: ${env.CONTACT_EMAIL ?? "contact@example.com"})`;
}

export function parseLatLng(q: string): Place | null {
  const m = LATLNG.exec(q);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng, kind: "coordinates" };
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined>;
}

const STATE_ABBR: Record<string, string> = { "New York": "NY", "New Jersey": "NJ", Connecticut: "CT" };

function photonLabel(p: PhotonFeature["properties"]): string {
  const street = p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street;
  // In NYC Photon's city is always "New York"; the borough (district) is what people recognise.
  const place = p.city === "New York" && p.district ? p.district : p.city ?? p.district ?? p.county;
  const state = p.state ? STATE_ABBR[p.state] ?? p.state : undefined;
  const tail = [state, p.postcode].filter(Boolean).join(" ");
  const parts = [p.name, street, place, tail];
  return [...new Set(parts.filter(Boolean))].join(", ");
}

/** "12-34 Main Ave, Queens" → { house: "12-34", postcode: undefined } */
function parseAddressQuery(q: string): { house?: string; street?: string; postcode?: string } {
  const m = /^\s*(\d+(?:-\d+)?[a-z]?)\s+([^,\s]+)/i.exec(q);
  const house = m?.[1]?.toLowerCase();
  // First word of the street name ("Front" in "123 Front St", "Main" in "12-34 Main Ave"), skipping directionals.
  const words = q.slice(m?.[1].length ?? 0).split(",")[0].trim().toLowerCase().split(/\s+/);
  const street = house ? words.find((w) => !["n", "s", "e", "w", "north", "south", "east", "west"].includes(w.replace(".", ""))) : undefined;
  const postcode = /\b(\d{5})(?:-\d{4})?\s*$/.exec(q)?.[1];
  return { house, street, postcode };
}

/** Does a result label look like the exact address asked for (house number and street)? */
function isExactAddress(label: string, house?: string, street?: string): boolean {
  const l = label.toLowerCase();
  return Boolean(house && l.startsWith(`${house} `) && (!street || l.split(",")[0].includes(street)));
}

/**
 * Photon ranks nearby shops on the same street above the exact building. When the query starts
 * with a house number, put exact house-number matches first and push named POIs down.
 */
function rankForAddress(q: string, features: PhotonFeature[]): PhotonFeature[] {
  const { house, street, postcode } = parseAddressQuery(q);
  if (!house && !postcode) return features;
  const score = (f: PhotonFeature) => {
    const p = f.properties;
    let s = 0;
    if (house && p.housenumber?.toLowerCase() === house) s += 10;
    if (street && p.street?.toLowerCase().includes(street)) s += 5;
    if (house && p.name && p.housenumber?.toLowerCase() !== house) s -= 3; // a business elsewhere on the street
    if (postcode && p.postcode === postcode) s += 2;
    return s;
  };
  return features.map((f, i) => ({ f, i, s: score(f) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.f);
}

async function photon(env: Env, q: string, limit: number, bias: { lat: number; lng: number }): Promise<Place[]> {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(Math.min(limit + 5, 15)));
  url.searchParams.set("lat", String(bias.lat));
  url.searchParams.set("lon", String(bias.lng));
  url.searchParams.set("lang", "en");
  const res = await fetch(url, { headers: { "User-Agent": userAgent(env) } });
  if (!res.ok) throw new Error(`photon ${res.status}`);
  const data = (await res.json()) as { features: PhotonFeature[] };
  return rankForAddress(q, data.features)
    .map((f) => ({
      label: photonLabel(f.properties),
      lng: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      kind: f.properties.osm_value ?? f.properties.type,
    }))
    .slice(0, limit);
}

async function nominatim(env: Env, q: string, limit: number): Promise<Place[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("addressdetails", "1");
  const res = await fetch(url, { headers: { "User-Agent": userAgent(env) } });
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const data = (await res.json()) as {
    display_name: string; lat: string; lon: string; type: string;
    address?: Record<string, string | undefined>;
  }[];
  return data.map((d) => {
    const a = d.address ?? {};
    const street = a.house_number && a.road ? `${a.house_number} ${a.road}` : a.road;
    const rawPlace = a.suburb && a.city === "City of New York" ? a.suburb : a.city ?? a.town ?? a.village ?? a.hamlet ?? a.suburb;
    const place = rawPlace?.replace(/^(Village|Town|City) of /, "");
    const region = a["ISO3166-2-lvl4"]?.split("-")[1] ?? a.state;
    const label = street ? [street, place, [region, a.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ") : d.display_name;
    return { label, lat: Number(d.lat), lng: Number(d.lon), kind: a.house_number ? `house:${a.house_number}` : d.type };
  });
}

export async function geocode(env: Env, q: string, opts: { limit?: number; bias?: { lat: number; lng: number } } = {}): Promise<Place[]> {
  const direct = parseLatLng(q);
  if (direct) return [direct];
  const query = q.trim().replace(/\s+/g, " ");
  if (query.length < 2) return [];
  const limit = Math.min(opts.limit ?? 5, 10);
  const bias = opts.bias ?? REGION_BIAS;
  const key = `v6|${query.toLowerCase()}|${limit}|${bias.lat.toFixed(1)},${bias.lng.toFixed(1)}`;

  const cached = await env.DB.prepare("SELECT result_json, fetched_at FROM geocode_cache WHERE q = ?").bind(key)
    .first<{ result_json: string; fetched_at: string }>();
  if (cached && Date.now() - Date.parse(cached.fetched_at) < CACHE_DAYS * 86400_000) return JSON.parse(cached.result_json);

  let places: Place[] = [];
  try {
    places = await photon(env, query, limit, bias);
  } catch {
    places = [];
  }
  const { house, street } = parseAddressQuery(query);
  if (house && !places.some((p) => isExactAddress(p.label, house, street))) {
    try {
      const exact = (await nominatim(env, query, 3)).filter((p) => p.kind === `house:${house}`);
      places = [...exact.map((p) => ({ ...p, kind: "house" })), ...places].slice(0, limit);
    } catch {
      /* keep Photon's results */
    }
  }
  if (!places.length) {
    try {
      places = await nominatim(env, query, limit);
    } catch {
      places = [];
    }
  }
  if (places.length) {
    await env.DB.prepare("INSERT OR REPLACE INTO geocode_cache (q, result_json, fetched_at) VALUES (?, ?, ?)")
      .bind(key, JSON.stringify(places), new Date().toISOString()).run();
  }
  return places;
}

export async function reverseGeocode(env: Env, lat: number, lng: number): Promise<Place | null> {
  const key = `rev|${lat.toFixed(3)},${lng.toFixed(3)}`;
  const cached = await env.DB.prepare("SELECT result_json FROM geocode_cache WHERE q = ?").bind(key).first<{ result_json: string }>();
  if (cached) return JSON.parse(cached.result_json);
  try {
    const res = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&lang=en`, { headers: { "User-Agent": userAgent(env) } });
    if (!res.ok) return null;
    const f = ((await res.json()) as { features: PhotonFeature[] }).features[0];
    if (!f) return null;
    const p = f.properties;
    const place = { label: [p.district ?? p.city ?? p.name, p.state].filter(Boolean).join(", "), lat, lng, kind: "reverse" };
    await env.DB.prepare("INSERT OR REPLACE INTO geocode_cache (q, result_json, fetched_at) VALUES (?, ?, ?)")
      .bind(key, JSON.stringify(place), new Date().toISOString()).run();
    return place;
  } catch {
    return null;
  }
}

/** Resolve a free-form location ("Garden City, NY", "11550", "40.7,-73.6") to one place. */
export async function resolveLocation(env: Env, location: string): Promise<Place | null> {
  return (await geocode(env, location, { limit: 1 }))[0] ?? null;
}
