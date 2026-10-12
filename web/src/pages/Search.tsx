import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useLocateMe } from "../components/Controls";
import { IconChurch, IconClose, IconHistory, IconHome, IconLocate, IconPin, IconSearch } from "../components/icons";
import { get, type Church, type Place } from "../lib/api";
import { addressLine, fmtDistance, splitName } from "../lib/format";
import { useStore } from "../lib/store";

function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Row({ icon, title, subtitle, onClick, href, trailing }: {
  icon: React.ReactNode; title: string; subtitle?: string; onClick?: () => void; href?: string; trailing?: React.ReactNode;
}) {
  const inner = (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium">{title}</span>
        {subtitle && <span className="block truncate text-[13px] text-muted">{subtitle}</span>}
      </span>
      {trailing}
    </>
  );
  const cls = "flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-surface";
  return href ? <Link href={href} className={cls}>{inner}</Link> : <button type="button" onClick={onClick} className={cls}>{inner}</button>;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-muted">{title}</h2>
      <div className="-mx-1">{children}</div>
    </section>
  );
}

export function Search() {
  const { location, setLocation, addRecent, recents, places, settings } = useStore();
  const [, navigate] = useLocation();
  const [text, setText] = useState("");
  const q = useDebounced(text.trim());
  const { locate, busy, error } = useLocateMe();
  const bias = location ? { lat: location.lat, lng: location.lng } : {};

  const placesQ = useQuery({
    queryKey: ["geocode", q, location?.lat, location?.lng],
    queryFn: ({ signal }) => get<{ results: Place[] }>("/geocode", { q, limit: 5, ...bias }, signal),
    enabled: q.length >= 2,
    staleTime: 60 * 60_000,
  });
  const churchesQ = useQuery({
    queryKey: ["church-search", q, location?.lat, location?.lng],
    queryFn: ({ signal }) => get<{ results: Church[] }>("/churches/search", { q, limit: 8, ...bias }, signal),
    enabled: q.length >= 2,
    staleTime: 10 * 60_000,
  });

  const choose = (p: Place, source: "search" | "saved" = "search") => {
    setLocation({ ...p, source });
    if (source === "search") addRecent(p);
    navigate("/");
  };

  const gps = async () => {
    await locate();
    navigate("/");
  };

  return (
    <div className="mx-auto max-w-2xl px-4 pt-4 pb-10 md:pt-8">
      <h1 className="mb-4 font-heading text-[26px] font-semibold tracking-tight md:text-4xl">Search</h1>
      <div className="relative">
        <IconSearch size={20} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-muted" />
        <input autoFocus type="search" value={text} onChange={(e) => setText(e.target.value)} enterKeyHint="search"
          placeholder="Town, address, ZIP, or church name"
          aria-label="Search for a place or church"
          onKeyDown={(e) => { if (e.key === "Enter" && placesQ.data?.results[0]) choose(placesQ.data.results[0]); }}
          className="w-full rounded-2xl border border-line bg-surface py-3.5 pr-11 pl-12 text-[16px] shadow-card placeholder:text-muted focus:border-accent focus:outline-none" />
        {text && (
          <button type="button" onClick={() => setText("")} aria-label="Clear search" className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full p-1 text-muted hover:bg-surface-2">
            <IconClose size={18} />
          </button>
        )}
      </div>

      {q.length < 2 ? (
        <>
          <div className="mt-3 -mx-1">
            <Row icon={<IconLocate size={18} className={busy ? "animate-pulse text-accent" : "text-accent"} />}
              title={busy ? "Locating…" : "Use my current location"} onClick={gps} />
            {error && <p role="alert" className="px-3 text-sm text-accent">{error}</p>}
          </div>
          {places.length > 0 && (
            <Group title="Saved places">
              {places.map((p) => <Row key={p.name} icon={<IconHome size={18} />} title={p.name} subtitle={p.label} onClick={() => choose(p, "saved")} />)}
            </Group>
          )}
          {recents.length > 0 && (
            <Group title="Recent">
              {recents.map((p) => <Row key={p.label} icon={<IconHistory size={18} />} title={p.label} onClick={() => choose(p)} />)}
            </Group>
          )}
        </>
      ) : (
        <>
          <Group title="Places">
            {placesQ.isPending ? <p className="px-3 py-2 text-sm text-muted">Searching…</p>
              : placesQ.data?.results.length ? placesQ.data.results.map((p) => (
                <Row key={`${p.lat},${p.lng}`} icon={<IconPin size={18} />} title={p.label.split(", ")[0]}
                  subtitle={p.label.split(", ").slice(1).join(", ")} onClick={() => choose(p)} />
              )) : <p className="px-3 py-2 text-sm text-muted">No places found.</p>}
          </Group>
          <Group title="Churches">
            {churchesQ.isPending ? <p className="px-3 py-2 text-sm text-muted">Searching…</p>
              : churchesQ.data?.results.length ? churchesQ.data.results.map((c) => (
                <Row key={c.id} href={`/church/${c.id}`} icon={<IconChurch size={18} />} title={splitName(c.name)[0]}
                  subtitle={addressLine(c.address)}
                  trailing={c.distance_mi !== undefined ? <span className="text-[13px] text-muted tabular">{fmtDistance(c.distance_mi, settings.units)}</span> : null} />
              )) : <p className="px-3 py-2 text-sm text-muted">No churches match “{q}”.</p>}
          </Group>
        </>
      )}
      <p className="mt-10 text-center text-xs text-muted">Works anywhere MassTimes.org lists churches, in the US and abroad.</p>
    </div>
  );
}
