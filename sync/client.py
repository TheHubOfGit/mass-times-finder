"""Throttled client for the MassTimes.org church search endpoint.

Courtesy rules (see CLAUDE.md): one request at a time, 1-2 s between
requests, identifying User-Agent, backoff on errors.

Usage:
    python -m sync.client --dry-run --lat 40.718 --lng -73.602 [--pages 2] [--save docs/sample-response.json]
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time

import httpx

BASE_URL = "https://masstimes.org"
SEARCH_PATH = "/Churchs/"
PAGE_SIZE = 30
CONTACT = os.environ.get("MASSTIMES_CONTACT", "contact@example.com")
USER_AGENT = f"MassTimesFinder/0.1 (contact: {CONTACT})"
# Netlify returns 403 unless Referer is masstimes.org (a hotlink-style check).
# Off until MassTimes confirms in writing that sending it is fine; see CLAUDE.md.
SEND_REFERER = os.environ.get("MASSTIMES_SEND_REFERER") == "1"

MIN_DELAY_S = 1.0
MAX_DELAY_S = 2.0
MAX_RETRIES = 5


class MassTimesClient:
    def __init__(self, timeout: float = 30.0) -> None:
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        if SEND_REFERER:
            headers["Referer"] = f"{BASE_URL}/"
        self._http = httpx.Client(base_url=BASE_URL, timeout=timeout, headers=headers)
        self._last_request_at = 0.0

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "MassTimesClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def _throttle(self) -> None:
        wait = random.uniform(MIN_DELAY_S, MAX_DELAY_S) - (time.monotonic() - self._last_request_at)
        if wait > 0:
            time.sleep(wait)

    def _get(self, path: str, params: dict) -> list | dict:
        for attempt in range(MAX_RETRIES):
            self._throttle()
            self._last_request_at = time.monotonic()
            try:
                resp = self._http.get(path, params=params)
                if resp.status_code == 200:
                    return resp.json()
                retryable = resp.status_code == 429 or resp.status_code >= 500
                if not retryable:
                    resp.raise_for_status()
            except (httpx.TransportError, json.JSONDecodeError):
                pass
            time.sleep(min(60, 2 ** (attempt + 1)))
        raise RuntimeError(f"GET {path} {params} failed after {MAX_RETRIES} attempts")

    def search_page(self, lat: float, lng: float, page: int = 1) -> list[dict]:
        """One page (up to 30 churches) ordered by distance from (lat, lng)."""
        data = self._get(SEARCH_PATH, {"lat": f"{lat:.3f}", "long": f"{lng:.3f}", "pg": page})
        return data if isinstance(data, list) else []

    def search(self, lat: float, lng: float, max_pages: int = 1, max_distance_mi: float | None = None):
        """Yield churches page by page until a short page, max_pages, or max_distance_mi."""
        for page in range(1, max_pages + 1):
            rows = self.search_page(lat, lng, page)
            for row in rows:
                if max_distance_mi is not None and float(row.get("distance") or 0) > max_distance_mi:
                    return
                yield row
            if len(rows) < PAGE_SIZE:
                return


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true", help="query a single point and print a summary")
    p.add_argument("--lat", type=float, default=40.718)
    p.add_argument("--lng", type=float, default=-73.602)
    p.add_argument("--pages", type=int, default=1)
    p.add_argument("--save", help="write the raw JSON array to this path")
    args = p.parse_args(argv)

    if not args.dry_run:
        p.error("only --dry-run is implemented in M1")

    with MassTimesClient() as client:
        rows = list(client.search(args.lat, args.lng, max_pages=args.pages))

    if args.save:
        with open(args.save, "w") as f:
            json.dump(rows, f, indent=2, ensure_ascii=False)

    print(f"{len(rows)} churches from ({args.lat}, {args.lng}), {args.pages} page(s)")
    for r in rows:
        times = r.get("church_worship_times") or []
        print(f"  {float(r['distance']):6.2f} mi  {r['name'].strip()[:50]:50}  {r.get('church_address_city_name','').strip():18} {len(times):3} services")
    return 0


if __name__ == "__main__":
    sys.exit(main())
