import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { Attribution } from "../components/Shell";
import { IconAccessible, IconBack, IconChurch, IconFlag, IconGlobe, IconInfo, IconPhone, IconRoute, IconShare, IconStar } from "../components/icons";
import { EmptyState, SkeletonList } from "../components/Results";
import { get, type ChurchDetails, type Kind, type Service } from "../lib/api";
import { addressLine, DAY_NAMES, fmtDate, fmtRelative, fmtTime, fmtUpdated, KIND_LABEL, localToday, splitName, weekday } from "../lib/format";
import { useStore } from "../lib/store";

const KIND_ORDER: Kind[] = ["mass", "confession", "adoration", "devotion"];

function Action({ href, onClick, icon, label, active }: { href?: string; onClick?: () => void; icon: ReactNode; label: string; active?: boolean }) {
  const cls = `flex flex-1 flex-col items-center gap-1.5 rounded-2xl border py-3 text-[12px] font-semibold transition-colors ${
    active ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface hover:bg-surface-2"}`;
  return href
    ? <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className={cls}>{icon}{label}</a>
    : <button type="button" onClick={onClick} aria-pressed={active} className={cls}>{icon}{label}</button>;
}

function ServiceLine({ s, clock }: { s: Service; clock: "12" | "24" }) {
  return (
    <li className="flex items-baseline gap-3 py-1.5">
      <span className="w-[112px] shrink-0 font-serif text-[17px] font-medium tabular">
        {s.start ? fmtTime(s.start, clock) : "All day"}
        {s.end && <span className="text-[13px] text-muted"> – {fmtTime(s.end, clock)}</span>}
      </span>
      <span className="min-w-0 flex-1 text-[14px]">
        {s.language && <span className="mr-2 font-medium">{s.language}</span>}
        {s.comment && <span className="text-muted">{s.comment}</span>}
      </span>
    </li>
  );
}

function WeeklySchedule({ services, clock }: { services: Service[]; clock: "12" | "24" }) {
  const kinds = KIND_ORDER.filter((k) => services.some((s) => s.kind === k && (s.start || s.perpetual || s.comment)));
  const [kind, setKind] = useState<Kind>(kinds[0] ?? "mass");
  const todayDow = weekday(localToday());
  const ofKind = services.filter((s) => s.kind === kind);
  const regular = ofKind.filter((s) => !s.holy_day && s.start);
  const holy = ofKind.filter((s) => s.holy_day && s.start).sort((a, b) => Number(a.vigil) - Number(b.vigil) || (a.start ?? "").localeCompare(b.start ?? ""));
  const perpetual = ofKind.some((s) => s.perpetual);
  // Entries with no set time ("By appointment", "30 minutes before every Mass").
  const untimed = [...new Set(ofKind.filter((s) => !s.start && !s.perpetual && s.comment).map((s) => {
    const days = s.days.length === 7 || !s.days.length ? "" : s.days.length === 5 && s.days[0] === 1 ? "Weekdays: " : `${s.days.map((d) => DAY_NAMES[d].slice(0, 3)).join(", ")}: `;
    return `${days}${s.comment}`;
  }))];
  // Group consecutive days with identical schedules ("Monday – Friday"), Sunday first.
  const sig = (d: number) => regular.filter((s) => s.days.includes(d))
    .sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""))
    .map((s) => `${s.start}|${s.end}|${s.language}|${s.comment}`).join(";");
  const groups: { days: number[]; list: Service[] }[] = [];
  for (let d = 0; d < 7; d++) {
    const list = regular.filter((s) => s.days.includes(d)).sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
    if (!list.length) continue;
    const last = groups.at(-1);
    if (last && last.days.at(-1) === d - 1 && sig(last.days[0]) === sig(d)) last.days.push(d);
    else groups.push({ days: [d], list });
  }

  if (!kinds.length) return <p className="text-muted">No schedule listed.</p>;
  return (
    <div>
      {kinds.length > 1 && (
        <div role="tablist" className="no-scrollbar mb-4 flex gap-1 overflow-x-auto">
          {kinds.map((k) => (
            <button key={k} role="tab" type="button" aria-selected={kind === k} onClick={() => setKind(k)}
              className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold ${kind === k ? "bg-ink text-bg" : "text-muted hover:bg-surface-2"}`}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      )}
      {perpetual && (
        <p className="mb-3 rounded-2xl bg-now-soft px-4 py-3 text-[14px] font-medium text-now">Perpetual adoration: the chapel is open around the clock.</p>
      )}
      {untimed.length > 0 && (
        <ul className="mb-3 space-y-1.5 rounded-2xl border border-line bg-surface px-4 py-3 text-[14px]">
          {untimed.map((u) => <li key={u} className="flex gap-2"><IconInfo size={16} className="mt-0.5 shrink-0 text-muted" />{u}</li>)}
        </ul>
      )}
      {groups.length > 0 && (
        <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {groups.map((g) => {
            const hasToday = g.days.includes(todayDow);
            const label = g.days.length === 1 ? DAY_NAMES[g.days[0]]
              : g.days.length === 2 ? `${DAY_NAMES[g.days[0]]} & ${DAY_NAMES[g.days[1]]}`
              : `${DAY_NAMES[g.days[0]]} – ${DAY_NAMES[g.days.at(-1)!]}`;
            return (
              <div key={g.days.join()} className={`flex gap-4 px-4 py-3 ${hasToday ? "bg-accent-soft/40" : ""}`}>
                <div className="w-[96px] shrink-0 pt-1.5">
                  <div className={`text-[14px] leading-snug font-semibold ${hasToday ? "text-accent" : ""}`}>{label}</div>
                  {hasToday && <div className="text-[11px] font-semibold uppercase tracking-wider text-accent">{g.days.length > 1 ? "Incl. today" : "Today"}</div>}
                </div>
                <ul className="min-w-0 flex-1">{g.list.map((s, i) => <ServiceLine key={i} s={s} clock={clock} />)}</ul>
              </div>
            );
          })}
        </div>
      )}
      {holy.length > 0 && (
        <div className="mt-4 rounded-2xl border border-line bg-surface px-4 py-3">
          <h4 className="text-[14px] font-semibold text-gold">Holy days of obligation</h4>
          <ul>{holy.map((s, i) => <ServiceLine key={i} s={{ ...s, comment: [s.vigil ? "Vigil (evening before)" : null, s.comment].filter(Boolean).join(" · ") || null }} clock={clock} />)}</ul>
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="flex gap-4 py-2.5">
      <dt className="w-28 shrink-0 text-[13px] text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-[14px]">{children}</dd>
    </div>
  );
}

export function ChurchPage({ id }: { id: string }) {
  const { settings, toggleFavorite, isFavorite } = useStore();
  const [shared, setShared] = useState(false);
  const q = useQuery({
    queryKey: ["church", id],
    queryFn: ({ signal }) => get<ChurchDetails>(`/churches/${id}`, {}, signal),
    staleTime: 5 * 60_000,
  });
  const c = q.data;
  const nextUp = useMemo(() => c?.next.filter((n) => n.kind === "mass").slice(0, 3) ?? [], [c]);

  const share = async () => {
    const url = `${location.origin}/church/${id}`;
    const title = c ? splitName(c.name)[0] : "Church";
    try {
      if (navigator.share) await navigator.share({ title, text: `${title}: Mass times`, url });
      else {
        await navigator.clipboard.writeText(url);
        setShared(true);
        setTimeout(() => setShared(false), 2000);
      }
    } catch {
      /* user cancelled */
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 pt-3 pb-10 md:pt-8">
      <button type="button" onClick={() => (history.length > 1 ? history.back() : (location.href = "/"))}
        className="-ml-2 mb-3 flex items-center gap-1 rounded-full px-2 py-1.5 text-[15px] font-medium text-muted hover:bg-surface-2 hover:text-ink">
        <IconBack size={18} /> Back
      </button>

      {q.isPending ? <SkeletonList rows={6} />
        : q.isError || !c ? (
          <EmptyState icon={<IconChurch size={26} />} title="Church not found">
            <p>It may have been removed from the listings. <Link href="/" className="text-accent underline">Back to nearby</Link></p>
          </EmptyState>
        ) : (
          <article>
            <header>
              <div className="flex flex-wrap items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-muted">
                {c.church_type && <span>{c.church_type}</span>}
                {c.rite && c.rite !== "Roman-Latin" && <span className="text-accent">· {c.rite}</span>}
              </div>
              <h1 className="mt-1 font-heading text-[32px] leading-tight font-semibold tracking-tight md:text-[40px]">{splitName(c.name)[0]}</h1>
              <p className="mt-1 text-[15px] text-muted">
                {[addressLine(c.address), c.address.state, c.address.postal_code].filter(Boolean).join(", ")}
              </p>
            </header>

            <div className="mt-5 flex gap-2">
              <Action href={c.directions_url} icon={<IconRoute size={20} />} label="Directions" />
              {c.phone && <Action href={`tel:${c.phone.replace(/[^\d+]/g, "")}`} icon={<IconPhone size={20} />} label="Call" />}
              {c.website && <Action href={c.website} icon={<IconGlobe size={20} />} label="Website" />}
              <Action onClick={share} icon={<IconShare size={20} />} label={shared ? "Copied" : "Share"} />
              <Action onClick={() => toggleFavorite({ id: c.id, name: c.name, city: c.address.city })}
                icon={<IconStar size={20} filled={isFavorite(c.id)} />} label={isFavorite(c.id) ? "Saved" : "Save"} active={isFavorite(c.id)} />
            </div>

            {nextUp.length > 0 && (
              <section className="mt-6 rounded-[var(--card-radius)] border border-line bg-surface p-5 shadow-card">
                <h2 className="text-[12px] font-semibold uppercase tracking-wider text-accent">Next Mass</h2>
                <div className="mt-2 font-serif text-[44px] leading-none font-medium whitespace-nowrap tabular">{fmtTime(nextUp[0].local_start, settings.clock)}</div>
                <div className="mt-1.5 text-[15px] text-muted">{fmtDate(nextUp[0].local_date)} · {fmtRelative(nextUp[0].start)}</div>
                {nextUp[0].comment && <p className="mt-2 text-[13px] text-muted">Note: {nextUp[0].comment}</p>}
                {nextUp.length > 1 && (
                  <p className="mt-3 text-[14px] text-muted">
                    Then {nextUp.slice(1).map((n, i, rest) => {
                      const sameDayAsNext = rest[i + 1]?.local_date === n.local_date;
                      const t = fmtTime(n.local_start, settings.clock);
                      return sameDayAsNext ? t : `${t} ${fmtDate(n.local_date).toLowerCase().replace(/^(\w+day),/, "$1")}`;
                    }).join(", ")}
                  </p>
                )}
              </section>
            )}

            <section className="mt-8">
              <h2 className="mb-3 font-heading text-2xl font-semibold">Weekly schedule</h2>
              <WeeklySchedule services={c.services} clock={settings.clock} />
            </section>

            {(c.comments || c.directions) && (
              <section className="mt-8 space-y-3">
                {c.comments && <p className="flex gap-2 text-[14px]"><IconInfo size={18} className="mt-0.5 shrink-0 text-muted" />{c.comments}</p>}
                {c.directions && <p className="flex gap-2 text-[14px]"><IconRoute size={18} className="mt-0.5 shrink-0 text-muted" />{c.directions}</p>}
              </section>
            )}

            <section className="mt-8">
              <h2 className="mb-1 font-heading text-2xl font-semibold">About</h2>
              <dl className="divide-y divide-line">
                <InfoRow label={c.diocese_type ?? "Diocese"}>{c.diocese}</InfoRow>
                <InfoRow label="Rite">{c.rite}</InfoRow>
                <InfoRow label="Pastor">{c.pastor}</InfoRow>
                <InfoRow label="Language">{c.primary_language}</InfoRow>
                <InfoRow label="Accessibility">
                  {c.wheelchair === null ? null : c.wheelchair
                    ? <span className="flex items-center gap-1.5"><IconAccessible size={16} /> Wheelchair accessible</span>
                    : "Not listed as wheelchair accessible"}
                </InfoRow>
                <InfoRow label="Phone">{c.phone && <a className="text-accent" href={`tel:${c.phone.replace(/[^\d+]/g, "")}`}>{c.phone}</a>}</InfoRow>
                <InfoRow label="Email">{c.email && <a className="break-all text-accent" href={`mailto:${c.email}`}>{c.email}</a>}</InfoRow>
                <InfoRow label="Website">{c.website && <a className="break-all text-accent" href={c.website} target="_blank" rel="noreferrer">{c.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}</a>}</InfoRow>
              </dl>
            </section>

            <section className="mt-8 rounded-2xl bg-surface-2 p-4 text-[13px] leading-relaxed">
              <p><span className="font-semibold">Last updated {fmtUpdated(c.source.last_updated)}</span> on MassTimes.org. {c.confirm_note}</p>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
                <a href={c.source.url} target="_blank" rel="noreferrer" className="font-semibold text-accent">View on MassTimes.org</a>
                <a href={c.source.report_error_url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 font-semibold text-accent">
                  <IconFlag size={14} /> Report an error
                </a>
              </div>
            </section>
          </article>
        )}
      <Attribution className="mt-10" />
    </div>
  );
}
