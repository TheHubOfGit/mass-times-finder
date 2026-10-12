import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { IconMap, IconNearby, IconSearch, IconStar, Logo } from "./icons";

const TABS = [
  { href: "/", label: "Nearby", Icon: IconNearby },
  { href: "/map", label: "Map", Icon: IconMap },
  { href: "/search", label: "Search", Icon: IconSearch },
  { href: "/saved", label: "Saved", Icon: IconStar },
];

function isActive(href: string, path: string) {
  return href === "/" ? path === "/" : path.startsWith(href);
}

export function Shell({ children }: { children: ReactNode }) {
  const [path] = useLocation();
  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* Desktop rail */}
      <nav aria-label="Main" className="hidden w-[84px] shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-5 md:flex">
        <Link href="/" className="mb-5 block" aria-label="Mass Times Finder home">
          <Logo className="size-10" />
        </Link>
        {TABS.map(({ href, label, Icon }) => {
          const active = isActive(href, path);
          return (
            <Link key={href} href={href} aria-current={active ? "page" : undefined}
              className={`flex w-16 flex-col items-center gap-1 rounded-2xl py-2.5 text-[11px] font-medium transition-colors ${
                active ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-ink"}`}>
              <Icon size={22} strokeWidth={active ? 2.1 : 1.8} />
              {label}
            </Link>
          );
        })}
      </nav>

      <main className="relative min-h-0 flex-1 overflow-y-auto">{children}</main>

      {/* Mobile bottom bar */}
      <nav aria-label="Main" className="pb-safe shrink-0 border-t border-line bg-surface/95 backdrop-blur md:hidden">
        <div className="grid grid-cols-4">
          {TABS.map(({ href, label, Icon }) => {
            const active = isActive(href, path);
            return (
              <Link key={href} href={href} aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-0.5 pt-2 pb-1.5 text-[11px] font-medium ${active ? "text-accent" : "text-muted"}`}>
                <span className={`flex h-7 w-14 items-center justify-center rounded-full transition-colors ${active ? "bg-accent-soft" : ""}`}>
                  <Icon size={21} strokeWidth={active ? 2.1 : 1.8} />
                </span>
                {label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

/** Credit line required on every results view and church page (see CLAUDE.md commitments). */
export function Attribution({ className = "" }: { className?: string }) {
  return (
    <footer className={`text-center text-xs leading-relaxed text-muted ${className}`}>
      Mass times from{" "}
      <a href="https://masstimes.org" target="_blank" rel="noreferrer" className="font-medium text-ink underline decoration-line underline-offset-2 hover:decoration-accent">
        MassTimes.org
      </a>
      , used with permission. Times can change; please confirm with the parish.
      <br />
      <a href="https://secure.masstimes.org/forms/donate" target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:text-ink">
        Support MassTimes with a donation
      </a>
    </footer>
  );
}
