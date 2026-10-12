"""Write a crawl's churches to one CSV: one row per church, with readable schedule columns.

    python -m sync.export_csv data/churches-us.json exports/us-churches.csv
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
DAY_ORDER = [0, 1, 2, 3, 4, 5, 6]

COLUMNS = [
    "name", "street", "city", "state", "postal_code", "county", "country", "latitude", "longitude", "timezone",
    "diocese", "diocese_type", "rite", "church_type", "primary_language", "languages", "phone", "email", "website",
    "wheelchair_accessible", "perpetual_adoration", "pastor",
    "mass_times", "confession_times", "adoration_times", "devotion_times", "parish_notes",
    "masstimes_id", "masstimes_last_updated",
]


def fmt_time(hhmm: str) -> str:
    h, m = map(int, hhmm.split(":"))
    suffix = "AM" if h < 12 else "PM"
    h12 = (h + 11) % 12 + 1
    return f"{h12} {suffix}" if m == 0 else f"{h12}:{m:02d} {suffix}"


def fmt_entry(s: dict, primary_language: str | None) -> str:
    t = fmt_time(s["start"])
    if s.get("end"):
        t += f"–{fmt_time(s['end'])}"
    extras = []
    if s.get("language") and s["language"] != (primary_language or "English"):
        extras.append(s["language"])
    if s.get("comment"):
        extras.append(s["comment"])
    return f"{t} ({'; '.join(extras)})" if extras else t


def day_label(days: list[int]) -> str:
    if days == [1, 2, 3, 4, 5]:
        return "Mon–Fri"
    if len(days) > 2 and days == list(range(days[0], days[-1] + 1)):
        return f"{DAY[days[0]]}–{DAY[days[-1]]}"
    return ", ".join(DAY[d] for d in days)


def summarize(services: list[dict], kind: str, primary_language: str | None) -> str:
    """'Sun 8 AM, 10 AM; Mon–Fri 9 AM; Sat 5 PM; Holy days 7 AM; Vigil 7:30 PM' for one service kind."""
    mine = [s for s in services if s["kind"] == kind]
    parts: list[str] = []
    if any(s.get("perpetual") for s in mine):
        parts.append("Perpetual (around the clock)")
    regular = [s for s in mine if s.get("start") and not s.get("holy_day")]
    by_day: dict[int, list[str]] = {}
    for d in DAY_ORDER:
        entries = sorted((s for s in regular if d in s["days"]), key=lambda s: s["start"])
        if entries:
            by_day[d] = [fmt_entry(s, primary_language) for s in entries]
    # Sunday first, then Mon–Sat; merge consecutive days with identical schedules.
    groups: list[tuple[list[int], list[str]]] = []
    for d in DAY_ORDER:
        if d not in by_day:
            continue
        if groups and groups[-1][0][-1] == d - 1 and groups[-1][1] == by_day[d]:
            groups[-1][0].append(d)
        else:
            groups.append(([d], by_day[d]))
    parts += [f"{day_label(days)} {', '.join(times)}" for days, times in groups]
    holy = sorted((s for s in mine if s.get("start") and s.get("holy_day") and not s.get("vigil")), key=lambda s: s["start"])
    vigil = sorted((s for s in mine if s.get("start") and s.get("vigil")), key=lambda s: s["start"])
    if holy:
        parts.append("Holy days " + ", ".join(fmt_entry(s, primary_language) for s in holy))
    if vigil:
        parts.append("Holy-day vigil " + ", ".join(fmt_entry(s, primary_language) for s in vigil))
    untimed = sorted({s["comment"] for s in mine if not s.get("start") and not s.get("perpetual") and s.get("comment")})
    parts += untimed
    return "; ".join(parts)


def church_row(c: dict) -> dict:
    services = c["services"]
    lang = c.get("primary_language")
    return {
        "name": c["name"], "street": c.get("street"), "city": c.get("city"), "state": c.get("state"),
        "postal_code": c.get("postal_code"), "county": c.get("county"), "country": c.get("country"),
        "latitude": c["lat"], "longitude": c["lng"], "timezone": c.get("timezone"),
        "diocese": c.get("diocese"), "diocese_type": c.get("diocese_type"), "rite": c.get("rite"),
        "church_type": c.get("church_type"), "primary_language": lang,
        "languages": ", ".join(x for x in (c.get("languages") or "").split("|") if x),
        "phone": c.get("phone"), "email": c.get("email"), "website": c.get("website"),
        "wheelchair_accessible": {1: "yes", 0: "no"}.get(c.get("wheelchair"), ""),
        "perpetual_adoration": "yes" if c.get("has_perpetual_adoration") else "no",
        "pastor": c.get("pastor"),
        "mass_times": summarize(services, "mass", lang),
        "confession_times": summarize(services, "confession", lang),
        "adoration_times": summarize(services, "adoration", lang),
        "devotion_times": summarize(services, "devotion", lang),
        "parish_notes": c.get("comments"),
        "masstimes_id": c.get("source_id"), "masstimes_last_updated": c.get("source_updated_at"),
    }


def main(argv=None) -> int:
    argv = argv or sys.argv[1:]
    if len(argv) != 2:
        print(__doc__)
        return 2
    src, dst = Path(argv[0]), Path(argv[1])
    churches = json.loads(src.read_text())["churches"]
    churches.sort(key=lambda c: (c.get("state") or "", c.get("city") or "", c["name"]))
    dst.parent.mkdir(parents=True, exist_ok=True)
    with dst.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        for c in churches:
            w.writerow(church_row(c))
    print(f"{len(churches)} churches → {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
