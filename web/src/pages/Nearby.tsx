import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Attribution } from "../components/Shell";
import { FilterSheet, KindTabs, LocationBar, useLocateMe, useUpcomingHolyDay, WhenChips } from "../components/Controls";
import { IconLocate, IconNearby, IconSearch, Logo } from "../components/icons";
import { EmptyState, HolyDayBanner, NextUpCard, ResultList, SkeletonList, SortToggle } from "../components/Results";
import { get, type Occurrence } from "../lib/api";
import { fmtDate, KIND_LABEL } from "../lib/format";
import { stateToSearch, upcomingQuery, useStore } from "../lib/store";

const GRACE_MIN = 5;

/** Next occurrence that hasn't started (a few minutes' grace), and the next one at the closest church. */
function pickHero(list: Occurrence[], now = Date.now()) {
  const reachable = list.filter((o) =>
    o.in_progress ? o.kind !== "mass" : Date.parse(o.start) >= now + GRACE_MIN * 60000);
  const soonest = reachable[0] ?? null;
  const minDist = Math.min(...reachable.map((o) => o.church.distance_mi ?? Infinity));
  const nearest = reachable.find((o) => o.church.distance_mi === minDist) ?? null;
  return { soonest, nearest: nearest && soonest && nearest.church.id !== soonest.church.id ? nearest : null };
}

export function Nearby() {
  const { location, filters, setFilters } = useStore();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const { locate, busy } = useLocateMe();
  const holyDay = useUpcomingHolyDay();

  // Keep the URL shareable.
  useEffect(() => {
    const qs = stateToSearch(location, filters);
    history.replaceState(null, "", qs ? `/?${qs}` : "/");
  }, [location, filters]);

  const q = location ? upcomingQuery(filters, location) : null;
  const query = useQuery({
    queryKey: ["upcoming", q?.params],
    queryFn: ({ signal }) => get<{ results: Occurrence[] }>("/upcoming", q!.params, signal),
    enabled: !!q,
    placeholderData: keepPreviousData,
    refetchInterval: 5 * 60_000,
  });

  const results = useMemo(() => (query.data?.results ?? []).filter((o) => q?.keep(o) ?? true), [query.data, q]);
  const hero = useMemo(() => (filters.when === "soon" || filters.when === "today" ? pickHero(results) : { soonest: null, nearest: null }), [results, filters.when]);
  const rest = hero.soonest ? results.filter((o) => o !== hero.soonest) : results;
  const kindLabel = KIND_LABEL[filters.kind];

  return (
    <div className="mx-auto max-w-2xl px-4 pt-4 pb-10 md:pt-8">
      <header className="mb-4 flex items-center justify-between md:mb-6">
        <div className="flex items-center gap-2.5">
          <Logo className="size-8 md:hidden" />
          <h1 className="font-heading text-[26px] font-semibold tracking-tight md:text-4xl">
            {filters.when === "holyday" ? "Holy day Masses" : filters.when === "soon" ? `Next ${filters.kind === "mass" ? "Mass" : kindLabel.toLowerCase()}` : kindLabel} nearby
          </h1>
        </div>
      </header>

      <div className="space-y-3">
        <LocationBar />
        {holyDay && (
          <HolyDayBanner holyDay={holyDay} active={filters.when === "holyday" && filters.date === holyDay.date}
            onShow={() => setFilters({ when: "holyday", date: holyDay.date, kind: "mass" })} />
        )}
        <KindTabs />
        <WhenChips onOpenFilters={() => setFiltersOpen(true)} />
      </div>
      <FilterSheet open={filtersOpen} onClose={() => setFiltersOpen(false)} />

      <div className="mt-5">
        {!location ? (
          <EmptyState icon={<IconNearby size={26} />} title="Where are you?">
            <p>Share your location to see the Masses starting soonest near you, or search for a town, address or ZIP.</p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
              <button type="button" onClick={locate} disabled={busy}
                className="flex items-center justify-center gap-2 rounded-2xl bg-accent px-5 py-3 font-semibold text-accent-ink hover:opacity-90 disabled:opacity-60">
                <IconLocate size={18} /> {busy ? "Locating…" : "Use my location"}
              </button>
              <Link href="/search" className="flex items-center justify-center gap-2 rounded-2xl border border-line bg-surface px-5 py-3 font-semibold text-ink hover:bg-surface-2">
                <IconSearch size={18} /> Search a place
              </Link>
            </div>
          </EmptyState>
        ) : query.isPending ? (
          <SkeletonList />
        ) : query.isError ? (
          <EmptyState icon={<IconNearby size={26} />} title="Couldn't load times">
            <p>{(query.error as Error).message}</p>
            <button type="button" onClick={() => query.refetch()} className="mt-4 rounded-2xl border border-line px-5 py-2.5 font-semibold hover:bg-surface-2">Try again</button>
          </EmptyState>
        ) : results.length === 0 ? (
          <EmptyState icon={<IconNearby size={26} />} title={`No ${kindLabel.toLowerCase()} found`}>
            <p>
              Nothing within {filters.radius} mi
              {filters.when === "soon" ? " in the next day" : filters.when === "date" && filters.date ? ` on ${fmtDate(filters.date)}` : ""}
              {" "}with these filters.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {filters.radius < 25 && (
                <button type="button" onClick={() => setFilters({ radius: Math.min(25, filters.radius * 2) })}
                  className="rounded-2xl bg-accent px-4 py-2.5 font-semibold text-accent-ink">Search {Math.min(25, filters.radius * 2)} mi</button>
              )}
              {filters.when !== "sunday" && (
                <button type="button" onClick={() => setFilters({ when: "sunday" })} className="rounded-2xl border border-line px-4 py-2.5 font-semibold hover:bg-surface-2">Try this Sunday</button>
              )}
            </div>
          </EmptyState>
        ) : (
          <div className={`space-y-6 transition-opacity ${query.isFetching && query.isPlaceholderData ? "opacity-60" : ""}`}>
            {hero.soonest && filters.sort === "soonest" && <NextUpCard o={hero.soonest} label={filters.kind === "mass" ? "Next Mass" : `Next ${kindLabel.toLowerCase()}`} secondary={hero.nearest} />}
            <div className="space-y-2">
              <SortToggle count={filters.sort === "nearest" ? new Set(results.map((o) => o.church.id)).size : results.length}
                noun={filters.sort === "nearest" ? "churches, closest first" : `${kindLabel === "Mass" ? "Mass" : kindLabel.toLowerCase()} times, soonest first`} />
              <ResultList items={filters.sort === "soonest" ? rest : results} />
            </div>
          </div>
        )}
      </div>

      {location && <Attribution className="mt-10" />}
    </div>
  );
}
