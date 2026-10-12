"""Crawl a region of MassTimes into a normalized JSON file.

The region's bounding box is covered by a grid of square cells. Each cell's center
is queried page by page until results pass the cell's half-diagonal, so every
church in the box is within reach of some query. Raw pages are cached under
data/raw/<run>/ so a crawl can resume and parsing can be re-run offline.

    python -m sync.crawl --region nyc-li                 # full crawl (MASSTIMES_SEND_REFERER=1 needed)
    python -m sync.crawl --region nyc-li --max-points 3  # quick test
    python -m sync.crawl --region nyc-li --run-dir data/raw/<run> --offline  # re-parse cached pages
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from sync.client import PAGE_SIZE, MassTimesClient
from sync.normalize import in_region, normalize_church

ROOT = Path(__file__).resolve().parent.parent

REGIONS = {
    # NYC five boroughs + Nassau + Suffolk. The box also catches NJ, Westchester and CT,
    # which in_region() filters out by state and ZIP.
    "nyc-li": {"south": 40.49, "north": 41.17, "west": -74.27, "east": -71.85, "cell_mi": 5.0},
}

MILES_PER_DEG_LAT = 69.0
MAX_PAGES_PER_POINT = 20
MAX_CONSECUTIVE_FAILURES = 10
SUSPECT_DISTANCE_MI = 15.0


def haversine_mi(lat1, lng1, lat2, lng2) -> float:
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def grid_points(box: dict) -> tuple[list[tuple[float, float]], float]:
    """Cell centers covering the box, and the radius each must reach (half-diagonal + 5%)."""
    cell = box["cell_mi"]
    mid_lat = (box["south"] + box["north"]) / 2
    dlat = cell / MILES_PER_DEG_LAT
    dlng = cell / (MILES_PER_DEG_LAT * math.cos(math.radians(mid_lat)))
    rows = math.ceil((box["north"] - box["south"]) / dlat)
    cols = math.ceil((box["east"] - box["west"]) / dlng)
    points = [
        (round(box["south"] + (i + 0.5) * dlat, 3), round(box["west"] + (j + 0.5) * dlng, 3))
        for i in range(rows) for j in range(cols)
    ]
    # Rounding to 3 dp (as the client sends) moves a point by up to ~0.05 mi; include it in the margin.
    return points, cell * math.sqrt(2) / 2 * 1.05 + 0.1


def page_path(run_dir: Path, lat: float, lng: float, page: int) -> Path:
    return run_dir / f"{lat:.3f}_{lng:.3f}_p{page}.json.gz"


def fetch_point(client, run_dir: Path, lat: float, lng: float, radius: float, offline: bool, stats: dict):
    """Yield raw churches for one grid point, paging until past `radius`."""
    for page in range(1, MAX_PAGES_PER_POINT + 1):
        path = page_path(run_dir, lat, lng, page)
        if path.exists():
            rows = json.loads(gzip.decompress(path.read_bytes()))
        elif offline:
            return
        else:
            rows = client.search_page(lat, lng, page)
            stats["requests"] += 1
            path.write_bytes(gzip.compress(json.dumps(rows).encode()))
        yield from rows
        if len(rows) < PAGE_SIZE or float(rows[-1].get("distance") or 0) > radius:
            return
    stats["errors"].append(f"{lat},{lng}: hit {MAX_PAGES_PER_POINT}-page cap; shrink cell_mi")


def flag_suspect_coordinates(churches: list[dict]) -> None:
    """Flag churches far from the median position of others sharing their ZIP."""
    by_zip: dict[str, list[dict]] = {}
    for c in churches:
        if c["postal_code"]:
            by_zip.setdefault(c["postal_code"][:5], []).append(c)
    for group in by_zip.values():
        if len(group) < 3:
            continue
        mlat = statistics.median(c["lat"] for c in group)
        mlng = statistics.median(c["lng"] for c in group)
        for c in group:
            c["coord_suspect"] = int(haversine_mi(c["lat"], c["lng"], mlat, mlng) > SUSPECT_DISTANCE_MI)


def crawl(region: str, run_dir: Path, max_points: int | None, offline: bool) -> dict:
    box = REGIONS[region]
    points, radius = grid_points(box)
    if max_points:
        points = points[:max_points]
    run_dir.mkdir(parents=True, exist_ok=True)

    stats = {"region": region, "points": len(points), "radius_mi": round(radius, 2),
             "requests": 0, "raw_rows": 0, "errors": [],
             "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    found: dict[str, dict] = {}
    t0 = time.monotonic()
    failures = 0

    with MassTimesClient() as client:
        for n, (lat, lng) in enumerate(points, 1):
            try:
                for raw in fetch_point(client, run_dir, lat, lng, radius, offline, stats):
                    stats["raw_rows"] += 1
                    c = normalize_church(raw)
                    if c and in_region(c, region):
                        c["region"] = region
                        found.setdefault(c["match_key"], c)
                failures = 0
            except Exception as e:  # noqa: BLE001 — log and keep going, within limits
                failures += 1
                stats["errors"].append(f"{lat},{lng}: {e}")
                if failures >= MAX_CONSECUTIVE_FAILURES:
                    stats["aborted"] = True
                    print(f"Stopping: {failures} consecutive failures", file=sys.stderr)
                    break
            if n % 10 == 0 or n == len(points):
                print(f"  {n}/{len(points)} points · {stats['requests']} requests · "
                      f"{len(found)} churches · {time.monotonic() - t0:.0f}s", file=sys.stderr)

    churches = sorted(found.values(), key=lambda c: (c["lat"], c["lng"]))
    flag_suspect_coordinates(churches)
    stats.update(churches=len(churches), seconds=round(time.monotonic() - t0),
                 complete=not max_points and not stats.get("aborted"),
                 finished_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    return {"stats": stats, "churches": churches}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--region", default="nyc-li", choices=REGIONS)
    p.add_argument("--run-dir", type=Path, help="raw page cache (default: new data/raw/<timestamp>)")
    p.add_argument("--max-points", type=int, help="only query the first N grid points (testing)")
    p.add_argument("--offline", action="store_true", help="use cached pages only; never fetch")
    p.add_argument("--out", type=Path, help="output JSON (default: data/churches-<region>.json)")
    args = p.parse_args(argv)

    run_dir = (args.run_dir or ROOT / "data" / "raw" / datetime.now().strftime("%Y%m%d-%H%M%S")).resolve()
    out = (args.out or ROOT / "data" / f"churches-{args.region}.json").resolve()
    result = crawl(args.region, run_dir, args.max_points, args.offline)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=1, ensure_ascii=False))

    s = result["stats"]
    print(json.dumps({k: v for k, v in s.items() if k != "errors"}, indent=1))
    print(f"{len(s['errors'])} errors · wrote {out.relative_to(ROOT)} · raw pages in {run_dir.relative_to(ROOT)}")
    return 1 if s.get("aborted") else 0


if __name__ == "__main__":
    sys.exit(main())
