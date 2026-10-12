import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MLMap, MapLayerMouseEvent } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { FilterSheet, KindTabs, useLocateMe, WhenChips } from "../components/Controls";
import { IconLocate, IconMap } from "../components/icons";
import { EmptyState, ResultList, SkeletonList, SortToggle } from "../components/Results";
import { Attribution } from "../components/Shell";
import { get, type Church, type Occurrence } from "../lib/api";
import { fmtDate, fmtTime, KIND_LABEL, splitName } from "../lib/format";
import { upcomingQuery, useStore } from "../lib/store";

maplibregl.setWorkerUrl(workerUrl);

const NYC_LI = { lat: 40.74, lng: -73.6 };
const STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };

interface View { lat: number; lng: number; radius: number; bbox: [number, number, number, number] }

function haversineMi(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
}

function viewOf(map: MLMap): View {
  const b = map.getBounds();
  const c = map.getCenter();
  const radius = Math.min(15, Math.max(0.5, haversineMi({ lat: c.lat, lng: c.lng }, { lat: b.getNorth(), lng: b.getEast() })));
  return { lat: c.lat, lng: c.lng, radius, bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] };
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function addLayers(map: MLMap) {
  const accent = cssVar("--accent") || "#8c2f39";
  const surface = cssVar("--surface") || "#fff";
  const muted = cssVar("--muted") || "#888";
  const ink = cssVar("--ink") || "#111";
  if (!map.getSource("churches")) {
    map.addSource("churches", { type: "geojson", data: { type: "FeatureCollection", features: [] }, cluster: true, clusterMaxZoom: 11, clusterRadius: 44 });
  }
  map.addLayer({ id: "clusters", type: "circle", source: "churches", filter: ["has", "point_count"],
    paint: { "circle-color": accent, "circle-opacity": 0.9, "circle-radius": ["step", ["get", "point_count"], 16, 20, 20, 60, 26], "circle-stroke-width": 3, "circle-stroke-color": surface } });
  map.addLayer({ id: "cluster-count", type: "symbol", source: "churches", filter: ["has", "point_count"],
    layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Bold"], "text-size": 13 },
    paint: { "text-color": surface } });
  map.addLayer({ id: "church", type: "circle", source: "churches", filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": ["case", ["get", "hasNext"], accent, muted],
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 5, 15, 9],
      "circle-stroke-width": 2.5, "circle-stroke-color": surface,
    } });
  map.addLayer({ id: "church-label", type: "symbol", source: "churches", filter: ["all", ["!", ["has", "point_count"]], ["get", "hasNext"]], minzoom: 11.5,
    layout: { "text-field": ["get", "next"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-offset": [0, -1.5], "text-anchor": "bottom", "text-allow-overlap": false },
    paint: { "text-color": ink, "text-halo-color": surface, "text-halo-width": 2 } });
}

export function MapPage() {
  const { location, filters, settings } = useStore();
  const [, navigate] = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const meMarker = useRef<maplibregl.Marker | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { locate, busy } = useLocateMe();
  const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current) return;
    const start = location ?? NYC_LI;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE[theme],
      center: [start.lng, start.lat],
      zoom: location ? 12.5 : 9.5,
      attributionControl: false,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");
    // On phones the list sheet covers the bottom of the map; keep the focus point in the visible part.
    const pad = () => map.setPadding({ top: 0, left: 0, right: 0, bottom: window.innerWidth < 1024 ? map.getContainer().clientHeight * 0.38 : 0 });
    pad();
    window.addEventListener("resize", pad);
    map.on("style.load", () => addLayers(map));
    let t: ReturnType<typeof setTimeout>;
    const update = () => { clearTimeout(t); t = setTimeout(() => setView(viewOf(map)), 250); };
    map.on("load", update);
    map.on("moveend", update);

    map.on("click", "clusters", async (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const zoom = await (map.getSource("churches") as GeoJSONSource).getClusterExpansionZoom(f.properties.cluster_id);
      map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
    });
    map.on("click", "church", (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as { id: string; name: string; times: string; city: string };
      const el = document.createElement("div");
      el.className = "w-60 p-3.5";
      el.innerHTML = `
        <div style="font-family:var(--font-serif);font-size:17px;font-weight:600;line-height:1.2"></div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px"></div>
        <div style="font-size:13px;margin-top:8px"></div>
        <button style="margin-top:10px;width:100%;border-radius:12px;background:var(--accent);color:var(--accent-ink);font-weight:600;padding:8px 0;font-size:14px">View schedule</button>`;
      const [nameEl, cityEl, timesEl, btn] = el.children as unknown as HTMLElement[];
      nameEl.textContent = p.name;
      cityEl.textContent = p.city;
      timesEl.textContent = p.times || "No upcoming times for these filters";
      btn.addEventListener("click", () => navigate(`/church/${p.id}`));
      new maplibregl.Popup({ closeButton: false, offset: 12, maxWidth: "260px" })
        .setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number]).setDOMContent(el).addTo(map);
    });
    for (const layer of ["clusters", "church"]) {
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }
    return () => { clearTimeout(t); window.removeEventListener("resize", pad); map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme switch → new basemap (layers are re-added on style.load).
  useEffect(() => {
    // diff:false forces a full reload so our layers are re-added with the new style's colours.
    mapRef.current?.setStyle(STYLE[theme], { diff: false });
  }, [theme, settings.theme, settings.style]);

  // "You are here" marker; fly to a newly chosen location.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !location) return;
    if (!meMarker.current) {
      const el = document.createElement("div");
      el.className = "relative size-4 rounded-full border-[3px] border-white bg-[#2b6fd6] shadow";
      el.setAttribute("aria-label", "Your location");
      meMarker.current = new maplibregl.Marker({ element: el });
    }
    meMarker.current.setLngLat([location.lng, location.lat]).addTo(map);
    map.flyTo({ center: [location.lng, location.lat], zoom: Math.max(map.getZoom(), 13), duration: 800 });
  }, [location?.lat, location?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  const churches = useQuery({
    queryKey: ["bbox", view?.bbox.map((n) => n.toFixed(3)).join(","), filters.kind, filters.lang, filters.rite, filters.churchType, filters.wheelchair],
    queryFn: ({ signal }) => get<{ results: Church[] }>("/churches/search", {
      bbox: view!.bbox.join(","), kind: filters.kind, lang: filters.lang, rite: filters.rite,
      church_type: filters.churchType, wheelchair: filters.wheelchair, limit: 500,
    }, signal),
    enabled: !!view,
    placeholderData: keepPreviousData,
  });

  const q = view ? upcomingQuery({ ...filters, radius: view.radius }, view) : null;
  const upcoming = useQuery({
    queryKey: ["map-upcoming", q?.params],
    queryFn: ({ signal }) => get<{ results: Occurrence[] }>("/upcoming", { ...q!.params, limit: 500 }, signal),
    enabled: !!q,
    placeholderData: keepPreviousData,
  });
  const results = useMemo(() => (upcoming.data?.results ?? []).filter((o) => q?.keep(o) ?? true), [upcoming.data, q]);

  // Feed pins: every church in view, labelled with its next time.
  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource("churches") as GeoJSONSource | undefined;
    if (!map || !churches.data) return;
    const byChurch = new Map<string, Occurrence[]>();
    for (const o of results) byChurch.set(o.church.id, [...(byChurch.get(o.church.id) ?? []), o]);
    const data: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: churches.data.results.map((c) => {
        const occ = byChurch.get(c.id) ?? [];
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [c.lng, c.lat] },
          properties: {
            id: c.id, name: splitName(c.name)[0], city: c.address.city ?? "", hasNext: occ.length > 0,
            next: occ[0] ? fmtTime(occ[0].local_start, settings.clock) : "",
            times: occ.slice(0, 3).map((o) => `${fmtDate(o.local_date)} ${fmtTime(o.local_start, settings.clock)}`).join(" · "),
          },
        };
      }),
    };
    if (src) src.setData(data);
    else map.once("style.load", () => (map.getSource("churches") as GeoJSONSource | undefined)?.setData(data));
  }, [churches.data, results, settings.clock]);

  const list = (
    <>
      <div className="space-y-3 px-4 pt-4">
        <KindTabs />
        <WhenChips onOpenFilters={() => setFiltersOpen(true)} />
      </div>
      <div className="px-4 pt-3 pb-8">
        <div className="mb-2">
          <SortToggle count={filters.sort === "nearest" ? new Set(results.map((o) => o.church.id)).size : results.length}
            noun={upcoming.isFetching ? "· updating…" : filters.sort === "nearest" ? "churches in this area" : `${KIND_LABEL[filters.kind].toLowerCase()} times in this area`} />
        </div>
        {!view || upcoming.isPending ? <SkeletonList rows={4} />
          : results.length === 0 ? (
            <EmptyState icon={<IconMap size={24} />} title="Nothing here">
              <p>Zoom out or move the map, or change the filters.</p>
            </EmptyState>
          ) : <ResultList items={filters.sort === "nearest" ? results : results.slice(0, 80)} />}
        <Attribution className="mt-8" />
      </div>
    </>
  );

  return (
    <div className="relative flex h-full">
      <aside className="hidden w-[400px] shrink-0 overflow-y-auto border-r border-line bg-bg lg:block">
        <h1 className="px-4 pt-6 font-heading text-3xl font-semibold tracking-tight">Map</h1>
        {list}
      </aside>

      <div className="relative min-w-0 flex-1">
        <div className="absolute inset-0"><div ref={containerRef} className="h-full w-full" /></div>
        <button type="button" onClick={locate} disabled={busy} aria-label="Use my current location"
          className="absolute top-3 left-3 z-10 flex items-center gap-2 rounded-2xl border border-line bg-surface px-3.5 py-2.5 text-[14px] font-semibold text-accent shadow-card hover:bg-accent-soft disabled:opacity-60">
          <IconLocate size={17} className={busy ? "animate-pulse" : ""} /> {busy ? "Locating…" : "Near me"}
        </button>

        {/* Mobile / tablet bottom sheet */}
        <div className={`absolute inset-x-0 bottom-0 z-10 flex flex-col rounded-t-3xl border-t border-line bg-bg shadow-card transition-[height] duration-300 lg:hidden ${sheetOpen ? "h-[78%]" : "h-[38%]"}`}>
          <button type="button" onClick={() => setSheetOpen((v) => !v)} aria-expanded={sheetOpen}
            aria-label={sheetOpen ? "Collapse list" : "Expand list"} className="flex shrink-0 justify-center pt-2.5 pb-1">
            <span className="h-1.5 w-10 rounded-full bg-line" />
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto">{list}</div>
        </div>
      </div>
      <FilterSheet open={filtersOpen} onClose={() => setFiltersOpen(false)} />
    </div>
  );
}
