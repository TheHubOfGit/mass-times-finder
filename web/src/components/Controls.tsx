import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { get, type Facets, type HolyDay, type Kind, type Meta } from "../lib/api";
import { addDays, DAY_SHORT, fmtDate, KIND_LABEL, localToday, nextWeekday } from "../lib/format";
import { locateMe } from "../lib/geo";
import { DEFAULT_FILTERS, useStore, type When } from "../lib/store";
import { IconAccessible, IconClose, IconFilter, IconLocate, IconPin } from "./icons";

// ---------- location ----------

export function useLocateMe() {
  const { setLocation, addRecent } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locate = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await locateMe();
      setLocation({ ...p, source: "gps" });
      addRecent(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { locate, busy, error, clearError: () => setError(null) };
}

export function LocationBar() {
  const { location } = useStore();
  const { locate, busy, error, clearError } = useLocateMe();
  return (
    <div>
      <div className="flex items-center gap-2">
        <Link href="/search" className="flex min-w-0 flex-1 items-center gap-2.5 rounded-2xl border border-line bg-surface px-3.5 py-2.5 shadow-card transition-colors hover:border-muted/40">
          <IconPin size={18} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-medium uppercase tracking-wider text-muted">
              {location?.source === "gps" ? "Near you" : "Near"}
            </span>
            <span className="block truncate text-[15px] font-medium">{location?.label ?? "Choose a location"}</span>
          </span>
        </Link>
        <button type="button" onClick={locate} disabled={busy} aria-label="Use my current location"
          className="flex size-[54px] shrink-0 items-center justify-center rounded-2xl border border-line bg-surface text-accent shadow-card transition-colors hover:bg-accent-soft disabled:opacity-60">
          <IconLocate size={20} className={busy ? "animate-pulse" : ""} />
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 flex items-start gap-2 rounded-xl bg-accent-soft px-3 py-2 text-sm text-ink">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={clearError} aria-label="Dismiss" className="text-muted"><IconClose size={16} /></button>
        </p>
      )}
    </div>
  );
}

// ---------- holy days ----------

const HOLY_DAY_WINDOW_DAYS = 14;

/** The next holy day (not on a Sunday) within two weeks, or null. */
export function useUpcomingHolyDay(): HolyDay | null {
  const meta = useQuery({ queryKey: ["meta"], queryFn: ({ signal }) => get<Meta>("/meta", {}, signal), staleTime: 60 * 60_000 });
  const today = localToday();
  const limit = addDays(today, HOLY_DAY_WINDOW_DAYS);
  return meta.data?.holy_days.find((h) => !h.onSunday && h.date >= today && h.date <= limit) ?? null;
}

// ---------- kind + when ----------

const KINDS: Kind[] = ["mass", "confession", "adoration", "devotion"];

export function KindTabs() {
  const { filters, setFilters } = useStore();
  return (
    <div role="tablist" aria-label="Service type" className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4">
      {KINDS.map((k) => {
        const active = filters.kind === k;
        return (
          <button key={k} role="tab" aria-selected={active} type="button" onClick={() => setFilters({ kind: k })}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
              active ? "bg-ink text-bg" : "text-muted hover:bg-surface-2 hover:text-ink"}`}>
            {KIND_LABEL[k]}
          </button>
        );
      })}
    </div>
  );
}

function Chip({ active, onClick, children, label }: { active?: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} aria-label={label}
      className={`relative flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
        active ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-ink hover:border-muted/50"}`}>
      {children}
    </button>
  );
}

export function WhenChips({ onOpenFilters }: { onOpenFilters: () => void }) {
  const { filters, setFilters, activeFilterCount } = useStore();
  const holyDay = useUpcomingHolyDay();
  const dateRef = useRef<HTMLInputElement>(null);
  const today = localToday();
  const sunday = nextWeekday(0, today);
  const options: { when: When; label: string }[] = [
    { when: "soon", label: "Next few hours" },
    { when: "today", label: "Today" },
    { when: "tomorrow", label: DAY_SHORT[new Date(`${addDays(today, 1)}T12:00:00Z`).getUTCDay()] === "Sun" ? "Tomorrow (Sun)" : "Tomorrow" },
    { when: "sunday", label: sunday === today ? "Today is Sunday" : "This Sunday" },
  ];
  return (
    <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
      <Chip active={activeFilterCount > 0} onClick={onOpenFilters} label="More filters">
        <IconFilter size={15} />
        Filters
        {activeFilterCount > 0 && (
          <span className="flex size-5 items-center justify-center rounded-full bg-accent text-[11px] text-accent-ink">{activeFilterCount}</span>
        )}
      </Chip>
      {holyDay && (
        <Chip active={filters.when === "holyday"} onClick={() => setFilters({ when: "holyday", date: holyDay.date })}>
          {holyDay.name}
        </Chip>
      )}
      {options.filter((o) => !(o.when === "sunday" && sunday === today)).map((o) => (
        <Chip key={o.when} active={filters.when === o.when} onClick={() => setFilters({ when: o.when })}>{o.label}</Chip>
      ))}
      <Chip active={filters.when === "date"} onClick={() => dateRef.current?.showPicker?.() ?? dateRef.current?.focus()}>
        {filters.when === "date" && filters.date ? fmtDate(filters.date, { relative: false }).replace(/^\w+, /, "") : "Pick a date"}
        <input ref={dateRef} type="date" min={today} max={addDays(today, 13)} className="sr-only" tabIndex={-1}
          value={filters.date ?? ""} onChange={(e) => e.target.value && setFilters({ when: "date", date: e.target.value })} />
      </Chip>
    </div>
  );
}

// ---------- filter sheet ----------

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}
      className="m-0 mt-auto max-h-[88dvh] w-full max-w-none rounded-t-3xl bg-surface p-0 text-ink shadow-card backdrop:bg-black/40 md:m-auto md:max-w-lg md:rounded-3xl">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface px-5 py-4">
        <h2 className="font-heading text-xl font-semibold">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-muted hover:bg-surface-2"><IconClose /></button>
      </div>
      <div className="px-5 py-4">{children}</div>
    </dialog>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-muted">{title}</h3>
      {children}
    </section>
  );
}

function FacetChips({ facets, value, onChange, anyLabel }: { facets: { value: string; churches: number }[]; value?: string; onChange: (v?: string) => void; anyLabel: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? facets : facets.slice(0, 10);
  return (
    <div className="flex flex-wrap gap-2">
      <Chip active={!value} onClick={() => onChange(undefined)}>{anyLabel}</Chip>
      {shown.map((f) => (
        <Chip key={f.value} active={value === f.value} onClick={() => onChange(value === f.value ? undefined : f.value)}>
          {f.value} <span className="text-muted">{f.churches}</span>
        </Chip>
      ))}
      {facets.length > 10 && !all && <Chip onClick={() => setAll(true)}>+{facets.length - 10} more</Chip>}
      {value && !facets.some((f) => f.value === value) && <Chip active onClick={() => onChange(undefined)}>{value}</Chip>}
    </div>
  );
}

const TIME_PRESETS = [
  { label: "Any time", after: undefined, before: undefined },
  { label: "Morning", after: "05:00", before: "11:59" },
  { label: "Midday", after: "11:00", before: "14:00" },
  { label: "Afternoon", after: "12:00", before: "16:59" },
  { label: "Evening", after: "17:00", before: "23:59" },
];

export function FilterSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { filters, setFilters, resetFilters, location, settings } = useStore();
  const facets = useQuery({
    queryKey: ["facets", location?.lat, location?.lng, filters.radius],
    queryFn: ({ signal }) => get<Facets>("/facets", { lat: location!.lat, lng: location!.lng, radius_mi: Math.max(filters.radius, 10) }, signal),
    enabled: open && !!location,
    staleTime: 10 * 60_000,
  });
  const f = facets.data;
  const preset = TIME_PRESETS.find((p) => p.after === filters.after && p.before === filters.before);
  const radiusLabel = settings.units === "km" ? `${Math.round(filters.radius * 1.609)} km` : `${filters.radius} mi`;

  return (
    <Sheet open={open} onClose={onClose} title="Filters">
      <Section title={`Distance · within ${radiusLabel}`}>
        <input type="range" min={1} max={25} step={1} value={filters.radius} aria-label="Search radius in miles"
          onChange={(e) => setFilters({ radius: Number(e.target.value) })} className="w-full accent-[var(--accent)]" />
        <div className="mt-1 flex justify-between text-xs text-muted"><span>1 mi</span><span>25 mi</span></div>
      </Section>

      <Section title="Time of day">
        <div className="flex flex-wrap gap-2">
          {TIME_PRESETS.map((p) => (
            <Chip key={p.label} active={preset?.label === p.label} onClick={() => setFilters({ after: p.after, before: p.before })}>{p.label}</Chip>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2 text-sm">
          <label className="flex items-center gap-2">From
            <input type="time" value={filters.after ?? ""} onChange={(e) => setFilters({ after: e.target.value || undefined })}
              className="rounded-lg border border-line bg-surface-2 px-2 py-1 tabular" />
          </label>
          <label className="flex items-center gap-2">to
            <input type="time" value={filters.before ?? ""} onChange={(e) => setFilters({ before: e.target.value || undefined })}
              className="rounded-lg border border-line bg-surface-2 px-2 py-1 tabular" />
          </label>
        </div>
      </Section>

      <Section title="Language">
        {f ? <FacetChips facets={f.languages} value={filters.lang} onChange={(lang) => setFilters({ lang })} anyLabel="Any language" />
          : <p className="text-sm text-muted">{location ? "Loading…" : "Pick a location to see languages nearby."}</p>}
      </Section>

      <Section title="Rite">
        {f && <FacetChips facets={f.rites} value={filters.rite} onChange={(rite) => setFilters({ rite })} anyLabel="Any rite" />}
      </Section>

      <Section title="Church type">
        {f && <FacetChips facets={f.church_types} value={filters.churchType} onChange={(churchType) => setFilters({ churchType })} anyLabel="Any" />}
      </Section>

      <Section title="Accessibility">
        <label className="flex cursor-pointer items-center justify-between rounded-2xl border border-line px-4 py-3">
          <span className="flex items-center gap-2.5 text-[15px]"><IconAccessible size={18} /> Wheelchair accessible only</span>
          <input type="checkbox" checked={!!filters.wheelchair} onChange={(e) => setFilters({ wheelchair: e.target.checked || undefined })}
            className="size-5 accent-[var(--accent)]" />
        </label>
      </Section>

      <div className="sticky bottom-0 -mx-5 flex gap-3 border-t border-line bg-surface px-5 py-4">
        <button type="button" onClick={resetFilters} className="flex-1 rounded-2xl border border-line py-3 font-semibold hover:bg-surface-2">Reset</button>
        <button type="button" onClick={onClose} className="flex-[2] rounded-2xl bg-accent py-3 font-semibold text-accent-ink hover:opacity-90">Show results</button>
      </div>
    </Sheet>
  );
}

export function isDefaultRadius(r: number) {
  return r === DEFAULT_FILTERS.radius;
}
