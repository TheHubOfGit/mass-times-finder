import { useQueries, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { IconChevron, IconHome, IconPlus, IconStar, IconTrash } from "../components/icons";
import { Attribution } from "../components/Shell";
import { get, type ChurchDetails, type Meta } from "../lib/api";
import { fmtDate, fmtTime, splitName } from "../lib/format";
import { useStore, type Settings } from "../lib/store";

const STYLES = [
  { value: "parchment", label: "Parchment", bg: "#f7f3ec", ink: "#1f1b17", font: "'Newsreader Variable', serif", swatches: ["#8c2f39", "#e3dacb", "#2f7d5b"] },
  { value: "rosary", label: "Rosary", bg: "#eef3fb", ink: "#15233d", font: "'Marcellus', serif", swatches: ["#2b5ca8", "#9fb6dc", "#ffffff"] },
  { value: "cathedral", label: "Cathedral", bg: "#1f1e22", ink: "#ece6da", font: "'Spectral', serif", swatches: ["#f2b544", "#b6455a", "#4a73c4"] },
] as const;

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-xl bg-surface-2 p-1">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={`flex-1 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors ${value === o.value ? "bg-surface text-ink shadow-sm" : "text-muted"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Card({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-heading text-2xl font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Saved() {
  const { favorites, toggleFavorite, places, savePlace, removePlace, location, setLocation, settings, setSettings } = useStore();
  const [, navigate] = useLocation();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const favQueries = useQueries({
    queries: favorites.map((f) => ({
      queryKey: ["church", f.id],
      queryFn: ({ signal }: { signal: AbortSignal }) => get<ChurchDetails>(`/churches/${f.id}`, {}, signal),
      staleTime: 5 * 60_000,
    })),
  });
  const meta = useQuery({ queryKey: ["meta"], queryFn: ({ signal }) => get<Meta>("/meta", {}, signal), staleTime: 60 * 60_000 });

  const saveCurrent = () => {
    if (!location || !name.trim()) return;
    savePlace({ name: name.trim(), label: location.label, lat: location.lat, lng: location.lng });
    setName("");
    setNaming(false);
  };

  return (
    <div className="mx-auto max-w-2xl px-4 pt-4 pb-10 md:pt-8">
      <h1 className="font-heading text-[26px] font-semibold tracking-tight md:text-4xl">Saved</h1>

      <Card title="Churches">
        {favorites.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-[14px] text-muted">
            Tap <IconStar size={14} className="inline -translate-y-px" /> Save on a church page to keep it here with its next Mass.
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {favorites.map((f, i) => {
              const d = favQueries[i]?.data;
              const next = d?.next.find((n) => n.kind === "mass");
              return (
                <li key={f.id} className="flex items-center">
                  <Link href={`/church/${f.id}`} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 hover:bg-surface-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold">{splitName(f.name)[0]}</span>
                      <span className="block truncate text-[13px] text-muted">
                        {f.city}{next ? ` · Next Mass ${fmtDate(next.local_date)} ${fmtTime(next.local_start, settings.clock)}` : ""}
                      </span>
                    </span>
                    <IconChevron size={16} className="shrink-0 text-muted" />
                  </Link>
                  <button type="button" onClick={() => toggleFavorite(f)} aria-label={`Remove ${f.name}`} className="px-3 py-3 text-accent hover:bg-surface-2">
                    <IconStar size={18} filled />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Places" action={location && !naming ? (
        <button type="button" onClick={() => setNaming(true)} className="flex items-center gap-1 rounded-full px-3 py-1.5 text-[14px] font-semibold text-accent hover:bg-accent-soft">
          <IconPlus size={16} /> Save current
        </button>
      ) : null}>
        {naming && location && (
          <form onSubmit={(e) => { e.preventDefault(); saveCurrent(); }} className="mb-3 rounded-2xl border border-line bg-surface p-3">
            <p className="mb-2 truncate text-[13px] text-muted">{location.label}</p>
            <div className="flex gap-2">
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name it: Home, Work, Grandma's…"
                aria-label="Place name" className="min-w-0 flex-1 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[15px] focus:border-accent focus:outline-none" />
              <button type="submit" className="rounded-xl bg-accent px-4 font-semibold text-accent-ink">Save</button>
            </div>
          </form>
        )}
        {places.length === 0 && !naming ? (
          <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-[14px] text-muted">Save places you search from often, like home or work.</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {places.map((p) => (
              <li key={p.name} className="flex items-center">
                <button type="button" onClick={() => { setLocation({ ...p, source: "saved" }); navigate("/"); }}
                  className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-surface-2">
                  <IconHome size={18} className="shrink-0 text-muted" />
                  <span className="min-w-0">
                    <span className="block text-[15px] font-semibold">{p.name}</span>
                    <span className="block truncate text-[13px] text-muted">{p.label}</span>
                  </span>
                </button>
                <button type="button" onClick={() => removePlace(p.name)} aria-label={`Delete ${p.name}`} className="px-3 py-3 text-muted hover:text-accent">
                  <IconTrash size={18} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Settings">
        <fieldset className="mb-4">
          <legend className="mb-2 text-[15px] font-medium">Style</legend>
          <div className="grid grid-cols-3 gap-2">
            {STYLES.map((st) => {
              const active = settings.style === st.value;
              return (
                <button key={st.value} type="button" aria-pressed={active} onClick={() => setSettings({ style: st.value })}
                  className={`overflow-hidden rounded-2xl border-2 text-left transition-colors ${active ? "border-accent" : "border-line hover:border-muted/50"}`}>
                  <span className="block px-3 pt-3 pb-2.5" style={{ background: st.bg, color: st.ink }}>
                    <span className="block text-[22px] leading-none" style={{ fontFamily: st.font }}>5:30</span>
                    <span className="mt-2 flex gap-1" aria-hidden="true">
                      {st.swatches.map((c) => <span key={c} className="size-3 rounded-full" style={{ background: c }} />)}
                    </span>
                  </span>
                  <span className="block bg-surface px-3 py-2 text-[13px] font-semibold">{st.label}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
        <div className="space-y-4 rounded-2xl border border-line bg-surface p-4">
          {([
            ["Theme", "theme", [{ value: "system", label: "Auto" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]],
            ["Time", "clock", [{ value: "12", label: "12-hour" }, { value: "24", label: "24-hour" }]],
            ["Distance", "units", [{ value: "mi", label: "Miles" }, { value: "km", label: "Kilometers" }]],
          ] as const).map(([label, key, options]) => (
            <div key={key} className="flex items-center justify-between gap-4">
              <span className="text-[15px] font-medium">{label}</span>
              <div className="w-56">
                <Segmented label={label} value={settings[key] as string} options={options as unknown as { value: string; label: string }[]}
                  onChange={(v) => setSettings({ [key]: v } as Partial<Settings>)} />
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="About">
        <div className="space-y-3 text-[14px] leading-relaxed text-muted">
          <p>
            Mass Times Finder works anywhere MassTimes.org lists churches. New areas are fetched the first time
            someone searches there and refreshed daily{meta.data ? ` (${meta.data.churches.toLocaleString()} churches so far)` : ""}.
            Schedules come from MassTimes.org, used with permission. Parishes update their own listings there.
          </p>
          {meta.data && meta.data.holy_days.length > 0 && (
            <div>
              <p className="mb-1.5 font-semibold text-ink">Upcoming holy days</p>
              <ul className="space-y-1">
                {meta.data.holy_days.slice(0, 5).map((h) => (
                  <li key={h.date} className="flex justify-between gap-3">
                    <span><span className="text-ink">{h.name}</span> · {fmtDate(h.date, { relative: false })}</span>
                    <span className="shrink-0 text-[13px]">{h.onSunday ? "Sunday" : h.obligatory ? "Obligation" : "Not obligatory"}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Card>

      <Attribution className="mt-10" />
    </div>
  );
}
