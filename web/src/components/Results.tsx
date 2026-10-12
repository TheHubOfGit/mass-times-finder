import type { ReactNode } from "react";
import { Link } from "wouter";
import type { HolyDay, Occurrence } from "../lib/api";
import { addressLine, addDays, fmtDate, fmtDistance, fmtRelative, fmtTime, KIND_LABEL, localToday, splitName, timeParts } from "../lib/format";
import { useStore } from "../lib/store";
import { IconAccessible, IconChevron, IconInfo, IconRoute } from "./icons";

function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "now" | "gold" }) {
  const tones = {
    neutral: "bg-surface-2 text-muted",
    accent: "bg-accent-soft text-accent",
    now: "bg-now-soft text-now",
    gold: "bg-surface-2 text-gold",
  };
  return <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${tones[tone]}`}>{children}</span>;
}

function OccBadges({ o, showKind, showAccess }: { o: Occurrence; showKind?: boolean; showAccess?: boolean }) {
  const [, rite] = splitName(o.church.name);
  return (
    <>
      {o.in_progress && <Badge tone="now">Happening now</Badge>}
      {showKind && <Badge tone="accent">{KIND_LABEL[o.kind]}</Badge>}
      {o.holy_day && <Badge tone="gold">{o.source_type?.startsWith("Vigil") ? `Vigil · ${o.holy_day}` : o.holy_day}</Badge>}
      {o.language && o.language !== "English" && <Badge>{o.language}</Badge>}
      {rite && <Badge>{rite}</Badge>}
      {showAccess && o.church.wheelchair && <span className="text-muted" title="Wheelchair accessible"><IconAccessible size={14} aria-label="Wheelchair accessible" /></span>}
    </>
  );
}

/** One row in a timeline: big time on the left, church on the right. */
export function OccurrenceRow({ o, showKind, bead }: { o: Occurrence; showKind?: boolean; bead?: boolean }) {
  const { settings } = useStore();
  const [time, ampm] = timeParts(o.local_start, settings.clock);
  const [name] = splitName(o.church.name);
  return (
    <Link href={`/church/${o.church.id}`}
      className="group flex items-stretch gap-4 rounded-2xl px-3 py-3 transition-colors hover:bg-surface md:px-4">
      <div className="w-[68px] shrink-0 pt-0.5 text-right">
        <span className="font-serif text-[26px] leading-none font-medium tabular">{time}</span>
        {ampm && <span className="ml-0.5 text-[11px] font-semibold text-muted">{ampm}</span>}
        {o.local_end && <div className="mt-1 text-[11px] text-muted tabular">to {fmtTime(o.local_end, settings.clock)}</div>}
      </div>
      <div className={`relative min-w-0 flex-1 pl-4 ${bead ? "border-l-2 border-[var(--bead)]" : "border-l border-line"}`}>
        {bead && <span aria-hidden="true" className="absolute top-1.5 -left-[7px] size-3 rounded-full bg-[var(--bead)] ring-4 ring-bg" />}
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 text-[15px] leading-snug font-semibold group-hover:text-accent">{name}</h3>
          <span className="shrink-0 pt-0.5 text-[13px] font-medium text-muted tabular">{fmtDistance(o.church.distance_mi, settings.units)}</span>
        </div>
        <p className="mt-0.5 truncate text-[13px] text-muted">{addressLine(o.church.address)}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <OccBadges o={o} showKind={showKind} />
        </div>
        {o.comment && (
          <p className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-snug text-muted">
            <IconInfo size={13} className="mt-px shrink-0" />
            <span>{o.comment}</span>
          </p>
        )}
      </div>
    </Link>
  );
}

/** The hero: the soonest service you can still make. */
export function NextUpCard({ o, label, secondary }: { o: Occurrence; label: string; secondary?: Occurrence | null }) {
  const { settings } = useStore();
  const [time, ampm] = timeParts(o.local_start, settings.clock);
  const [name] = splitName(o.church.name);
  const day = fmtDate(o.local_date);
  const arch = settings.style === "cathedral";
  const distance = o.church.distance_mi !== undefined ? fmtDistance(o.church.distance_mi, settings.units) : null;
  return (
    <section aria-label={label} className="overflow-hidden rounded-[var(--card-radius)] border border-line bg-surface shadow-card"
      style={arch ? { borderRadius: "170px 170px 6px 6px / 120px 120px 6px 6px" } : undefined}>
      <Link href={`/church/${o.church.id}`} className={`block px-5 pb-4 transition-colors hover:bg-surface-2/40 ${arch ? "pt-14 text-center" : "pt-5"}`}>
        <div className={`flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-accent ${arch ? "justify-center" : ""}`}>
          {arch ? (
            <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true"><path d="M5 0C7 4 9 6 9 9.5A4 4 0 0 1 1 9.5C1 6 3 4 5 0Z" fill="currentColor" /></svg>
          ) : (
            <span className="relative flex size-2"><span className={`relative size-2 rounded-full bg-now ${o.in_progress ? "" : "pulse"}`} /></span>
          )}
          {label}
        </div>
        {arch ? (
          <div className="mt-3">
            <div className="font-serif leading-none">
              <span className="text-[60px] font-medium tracking-tight tabular">{time}</span>
              {ampm && <span className="ml-1.5 text-xl text-muted italic">{ampm.toLowerCase()}</span>}
            </div>
            <div className="mt-2 text-[14px] text-muted italic">
              {day} · {o.in_progress ? "happening now" : fmtRelative(o.start)}{distance ? ` · ${distance}` : ""}
            </div>
          </div>
        ) : (
          <div className="mt-3 flex items-end justify-between gap-3">
            <div>
              <div className="text-[13px] font-medium text-muted">{day} · {o.in_progress ? "happening now" : fmtRelative(o.start)}</div>
              <div className="mt-0.5 font-serif leading-none">
                <span className="text-[56px] font-medium tracking-tight tabular">{time}</span>
                {ampm && <span className="ml-1.5 text-xl font-semibold text-muted">{ampm}</span>}
              </div>
            </div>
            {distance && (
              <div className="pb-1 text-right">
                <div className="text-lg font-semibold tabular">{distance}</div>
                <div className="text-[12px] text-muted">away</div>
              </div>
            )}
          </div>
        )}
        <h2 className="mt-3 font-heading text-[22px] leading-tight font-semibold">{name}</h2>
        <p className="mt-0.5 text-[14px] text-muted">{addressLine(o.church.address)}</p>
        <div className={`mt-2.5 flex flex-wrap items-center gap-1.5 ${arch ? "justify-center" : ""}`}>
          <OccBadges o={o} showKind={o.kind !== "mass"} showAccess />
        </div>
        {o.comment && <p className="mt-2 text-[13px] text-muted">Note: {o.comment}</p>}
      </Link>
      <div className="flex gap-2 border-t border-line px-5 py-3">
        <a href={o.church.directions_url} target="_blank" rel="noreferrer"
          className="flex flex-1 items-center justify-center gap-2 rounded-[min(1rem,var(--card-radius))] bg-accent py-2.5 text-[15px] font-semibold text-accent-ink hover:opacity-90">
          <IconRoute size={18} /> Directions
        </a>
        <Link href={`/church/${o.church.id}`}
          className="flex flex-1 items-center justify-center gap-1 rounded-[min(1rem,var(--card-radius))] border border-line py-2.5 text-[15px] font-semibold hover:bg-surface-2">
          Full schedule <IconChevron size={16} />
        </Link>
      </div>
      {secondary && (
        <Link href={`/church/${secondary.church.id}`} className="flex items-center gap-3 border-t border-line bg-surface-2/50 px-5 py-3 text-[13px] hover:bg-surface-2">
          <span className="font-semibold text-muted">Closest church</span>
          <span className="min-w-0 flex-1 truncate">
            <span className="font-semibold">{splitName(secondary.church.name)[0]}</span>
            <span className="text-muted"> · {fmtDate(secondary.local_date)} {fmtTime(secondary.local_start, settings.clock)} · {fmtDistance(secondary.church.distance_mi, settings.units)}</span>
          </span>
          <IconChevron size={16} className="shrink-0 text-muted" />
        </Link>
      )}
    </section>
  );
}

/** Group occurrences into Now / Next hour / Later today / Tomorrow / weekday buckets. */
export function groupOccurrences(list: Occurrence[], now = Date.now()) {
  const today = localToday();
  const tomorrow = addDays(today, 1);
  const groups: { key: string; title: string; items: Occurrence[] }[] = [];
  const push = (key: string, title: string, o: Occurrence) => {
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push((g = { key, title, items: [] }));
    g.items.push(o);
  };
  for (const o of list) {
    const mins = (Date.parse(o.start) - now) / 60000;
    if (o.in_progress) push("now", "Happening now", o);
    else if (o.local_date === today && mins <= 60) push("hour", "Within the hour", o);
    else if (o.local_date === today) push("today", "Later today", o);
    else if (o.local_date === tomorrow) push("tomorrow", "Tomorrow", o);
    else push(o.local_date, fmtDate(o.local_date), o);
  }
  return groups;
}

export function Timeline({ items, showKind }: { items: Occurrence[]; showKind?: boolean }) {
  const { settings } = useStore();
  const rosary = settings.style === "rosary";
  const groups = groupOccurrences(items);
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <section key={g.key} aria-label={g.title}>
          <h2 className="sticky top-0 z-[1] -mx-1 flex items-center gap-2.5 bg-bg/95 px-1 py-2 font-heading text-lg font-semibold backdrop-blur">
            {/* Rosary: a large bead opens each day, like the Our Father bead between decades. */}
            {rosary && <span aria-hidden="true" className="ml-[76px] size-[18px] shrink-0 rounded-full bg-accent" />}
            {g.title} <span className="font-sans text-sm font-normal text-muted">{g.items.length}</span>
          </h2>
          <div className="-mx-3 md:-mx-4">
            {g.items.map((o) => <OccurrenceRow key={`${o.church.id}|${o.start}|${o.kind}`} o={o} showKind={showKind} bead={rosary} />)}
          </div>
        </section>
      ))}
      {rosary && groups.length > 0 && (
        <svg aria-hidden="true" width="16" height="24" viewBox="0 0 16 24" className="ml-[77px] text-accent">
          <path d="M8 0v24M2 7h12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      )}
    </div>
  );
}

export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-4 px-0 py-3">
          <div className="h-7 w-[68px] animate-pulse rounded-lg bg-surface-2" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-2/3 animate-pulse rounded bg-surface-2" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-surface-2" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">{icon}</div>
      <h2 className="font-heading text-2xl font-semibold">{title}</h2>
      <div className="mt-2 max-w-sm text-[15px] text-muted">{children}</div>
    </div>
  );
}

// ---------- sort: soonest (timeline) vs nearest (churches by distance) ----------

export function SortToggle({ count, noun }: { count: number; noun: string }) {
  const { filters, setFilters } = useStore();
  const options = [{ value: "soonest", label: "Soonest" }, { value: "nearest", label: "Nearest" }] as const;
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-[13px] text-muted">{count} {noun}</p>
      <div role="radiogroup" aria-label="Sort results" className="flex rounded-full border border-line bg-surface p-0.5">
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={filters.sort === o.value}
            onClick={() => setFilters({ sort: o.value })}
            className={`rounded-full px-3.5 py-1 text-[13px] font-semibold transition-colors ${
              filters.sort === o.value ? "bg-ink text-bg" : "text-muted hover:text-ink"}`}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One church with all of its upcoming times in the current window. */
function ChurchRow({ items, showKind, showDay }: { items: Occurrence[]; showKind?: boolean; showDay: boolean }) {
  const { settings } = useStore();
  const first = items[0];
  const c = first.church;
  const [name] = splitName(c.name);
  const today = localToday();
  const times = items.slice(0, 6);
  const notes = [...new Set(items.map((o) => o.comment).filter(Boolean))] as string[];
  return (
    <Link href={`/church/${c.id}`} className="group block rounded-2xl px-3 py-3.5 transition-colors hover:bg-surface md:px-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] leading-snug font-semibold group-hover:text-accent">{name}</h3>
          <p className="mt-0.5 truncate text-[13px] text-muted">{addressLine(c.address)}</p>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[15px] font-semibold tabular">{fmtDistance(c.distance_mi, settings.units)}</div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {times.map((o, i) => {
          const dayPrefix = !showDay ? "" : o.local_date === today ? "Today " : `${fmtDate(o.local_date).slice(0, 3)} `;
          return (
            <span key={`${o.start}|${o.kind}`}
              className={`rounded-lg px-2 py-1 text-[13px] font-semibold tabular ${
                o.in_progress ? "bg-now-soft text-now" : i === 0 ? "bg-accent-soft text-accent" : "bg-surface-2 text-ink"}`}>
              {o.in_progress ? "Now" : `${dayPrefix}${fmtTime(o.local_start, settings.clock)}`}
              {o.language && o.language !== "English" && <span className="ml-1 font-normal opacity-75">{o.language}</span>}
              {showKind && <span className="ml-1 font-normal opacity-75">{KIND_LABEL[o.kind]}</span>}
            </span>
          );
        })}
        {items.length > times.length && <span className="px-1 py-1 text-[13px] text-muted">+{items.length - times.length} more</span>}
      </div>
      {notes.length > 0 && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-snug text-muted">
          <IconInfo size={13} className="mt-px shrink-0" /><span>{notes.join(" · ")}</span>
        </p>
      )}
    </Link>
  );
}

export function ChurchList({ items, showKind }: { items: Occurrence[]; showKind?: boolean }) {
  const byChurch = new Map<string, Occurrence[]>();
  for (const o of items) byChurch.set(o.church.id, [...(byChurch.get(o.church.id) ?? []), o]);
  const groups = [...byChurch.values()].sort((a, b) => (a[0].church.distance_mi ?? 0) - (b[0].church.distance_mi ?? 0));
  const showDay = new Set(items.map((o) => o.local_date)).size > 1; // only label days when results span several
  return (
    <div className="-mx-3 divide-y divide-line md:-mx-4">
      {groups.map((g) => <ChurchRow key={g[0].church.id} items={g} showKind={showKind} showDay={showDay} />)}
    </div>
  );
}

/** Results in the user's chosen order. */
export function ResultList({ items, showKind }: { items: Occurrence[]; showKind?: boolean }) {
  const { filters } = useStore();
  return filters.sort === "nearest" ? <ChurchList items={items} showKind={showKind} /> : <Timeline items={items} showKind={showKind} />;
}

/** Shown on Nearby when a holy day of obligation is coming up. */
export function HolyDayBanner({ holyDay, active, onShow }: { holyDay: HolyDay; active: boolean; onShow: () => void }) {
  const today = localToday();
  const when = holyDay.date === today ? "Today" : holyDay.date === addDays(today, 1) ? "Tomorrow" : fmtDate(holyDay.date, { relative: false });
  return (
    <section aria-label="Upcoming holy day" className="flex items-center gap-3 rounded-[var(--card-radius)] border border-line bg-surface px-4 py-3 shadow-card">
      <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-gold">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 3v18M7 8h10" /></svg>
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-heading text-[16px] leading-tight font-semibold">{holyDay.name}</div>
        <div className="text-[13px] text-muted">
          {when} · {holyDay.obligatory ? "Holy day of obligation" : "Not obligatory this year"}
        </div>
      </div>
      {!active && (
        <button type="button" onClick={onShow} className="shrink-0 rounded-full bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-ink hover:opacity-90">
          See Masses
        </button>
      )}
    </section>
  );
}
