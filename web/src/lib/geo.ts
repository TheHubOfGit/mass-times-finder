import { get, type Place } from "./api";

export class GeoError extends Error {}

/** Ask the browser for the current position, then label it via our reverse-geocoder. */
export async function locateMe(): Promise<Place> {
  if (!("geolocation" in navigator)) throw new GeoError("This browser can't share your location. Search for a place instead.");
  const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, (err) => {
      reject(new GeoError(err.code === err.PERMISSION_DENIED
        ? "Location permission is off. Search for a place instead, or allow location in your browser settings."
        : "Couldn't get your location. Try again or search for a place."));
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 }),
  );
  const { latitude: lat, longitude: lng } = pos.coords;
  let label = "Current location";
  try {
    const r = await get<{ result: Place | null }>("/reverse", { lat, lng });
    if (r.result?.label) label = r.result.label;
  } catch {
    /* label is cosmetic */
  }
  return { lat, lng, label };
}
