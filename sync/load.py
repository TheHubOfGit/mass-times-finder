"""Load a crawl's normalized churches into D1, writing only what changed.

Matching (CLAUDE.md "Sync strategy"): exact match_key, else same normalized name
within 200 m, else same street + ZIP. Fuzzy matches are logged for review.
Churches missing from 3 consecutive *complete* crawls are deactivated, never deleted.

    python -m sync.load data/churches-nyc-li.json --local     # local D1 (wrangler dev)
    python -m sync.load data/churches-nyc-li.json --remote    # production D1
    python -m sync.load ... --sql-out plan.sql --dry-run      # write the SQL, don't run it
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sync.crawl import haversine_mi
from sync.normalize import normalized_name

ROOT = Path(__file__).resolve().parent.parent
WORKER_DIR = ROOT / "worker"  # local dev config (wrangler dev)
WEB_DIR = ROOT / "web"        # production Pages config (real D1 database id)
DB_NAME = "masstimes"
FUZZY_NAME_RADIUS_MI = 200 / 1609.34
DEACTIVATE_AFTER_MISSES = 3
ID_BATCH = 200

COLUMNS = [
    "match_key", "source_id", "name", "street", "city", "state", "postal_code", "county", "country",
    "lat", "lng", "timezone", "diocese", "diocese_type", "rite", "church_type", "primary_language",
    "phone", "email", "website", "wheelchair", "comments", "directions", "pastor", "services_json",
    "languages", "service_types", "has_perpetual_adoration", "source_updated_at", "content_hash",
    "coord_suspect", "region",
]


def sql_literal(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return str(int(v))
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def row_values(c: dict) -> dict:
    row = {k: c.get(k) for k in COLUMNS}
    row["services_json"] = json.dumps(c["services"], ensure_ascii=False, separators=(",", ":"))
    row["coord_suspect"] = c.get("coord_suspect", 0)
    return row


def address_key(street: str | None, postal: str | None) -> str | None:
    if not street or not postal:
        return None
    s = re.sub(r"[^a-z0-9 ]", " ", street.lower().split(",")[0])
    s = re.sub(r"\b(street|st)\b", "st", s)
    s = re.sub(r"\b(avenue|ave)\b", "ave", s)
    s = re.sub(r"\b(road|rd)\b", "rd", s)
    return " ".join(s.split()) + "|" + postal[:5]


def wrangler(args: list[str], target: str) -> str:
    cmd = ["npx", "--prefix", str(WORKER_DIR), "--no-install", "wrangler", "d1", "execute", DB_NAME, f"--{target}", *args]
    res = subprocess.run(cmd, cwd=WEB_DIR if target == "remote" else WORKER_DIR, capture_output=True, text=True,
                         env={**os.environ, "npm_config_prefix": str(WORKER_DIR)})
    if res.returncode != 0:
        raise RuntimeError(f"wrangler failed:\n{res.stdout}\n{res.stderr}")
    return res.stdout


def fetch_existing(region: str, target: str) -> list[dict]:
    out = wrangler(["--json", "--command",
                    "SELECT id, match_key, name, lat, lng, street, postal_code, content_hash, "
                    f"missed_syncs, is_active FROM churches WHERE region = {sql_literal(region)}"], target)
    return json.loads(out)[0]["results"]


def match(incoming: list[dict], existing: list[dict]):
    """Return ({match_key: existing_row}, fuzzy_log)."""
    by_key = {e["match_key"]: e for e in existing}
    by_name: dict[str, list[dict]] = {}
    by_addr: dict[str, dict] = {}
    for e in existing:
        by_name.setdefault(normalized_name(e["name"]), []).append(e)
        if (k := address_key(e["street"], e["postal_code"])):
            by_addr[k] = e

    matched, fuzzy, used = {}, [], set()
    for c in incoming:
        e = by_key.get(c["match_key"])
        how = "exact"
        if e is None or e["id"] in used:
            e, how = None, None
            for cand in by_name.get(normalized_name(c["name"]), []):
                if cand["id"] not in used and haversine_mi(c["lat"], c["lng"], cand["lat"], cand["lng"]) <= FUZZY_NAME_RADIUS_MI:
                    e, how = cand, "name+200m"
                    break
            if e is None and (k := address_key(c["street"], c["postal_code"])) and k in by_addr and by_addr[k]["id"] not in used:
                e, how = by_addr[k], "street+zip"
        if e is not None:
            matched[c["match_key"]] = e
            used.add(e["id"])
            if how != "exact":
                fuzzy.append({"how": how, "incoming": c["name"], "existing": e["name"], "id": e["id"]})
    return matched, fuzzy


def build_sql(crawl: dict, existing: list[dict], now: str):
    stats = crawl["stats"]
    churches = crawl["churches"]
    region = stats["region"]
    matched, fuzzy = match(churches, existing)

    stmts, seen_unchanged = [], []
    counts = {"new": 0, "changed": 0, "unchanged": 0, "deactivated": 0}
    for c in churches:
        row = row_values(c)
        e = matched.get(c["match_key"])
        if e is None:
            counts["new"] += 1
            cols = ["id", *COLUMNS, "first_seen_at", "last_seen_at"]
            vals = [str(uuid.uuid4()), *row.values(), now, now]
            stmts.append(f"INSERT INTO churches ({', '.join(cols)}) VALUES ({', '.join(map(sql_literal, vals))});")
        elif e["content_hash"] != c["content_hash"] or e["match_key"] != c["match_key"] or not e["is_active"]:
            counts["changed"] += 1
            sets = ", ".join(f"{k} = {sql_literal(v)}" for k, v in row.items())
            stmts.append(f"UPDATE churches SET {sets}, last_seen_at = {sql_literal(now)}, missed_syncs = 0, "
                         f"is_active = 1 WHERE id = {sql_literal(e['id'])};")
        else:
            counts["unchanged"] += 1
            seen_unchanged.append(e["id"])

    for i in range(0, len(seen_unchanged), ID_BATCH):
        ids = ", ".join(map(sql_literal, seen_unchanged[i:i + ID_BATCH]))
        stmts.append(f"UPDATE churches SET last_seen_at = {sql_literal(now)}, missed_syncs = 0 WHERE id IN ({ids});")

    if stats.get("complete"):
        seen_ids = {e["id"] for e in matched.values()}
        missing = [e for e in existing if e["id"] not in seen_ids and e["is_active"]]
        for e in missing:
            misses = e["missed_syncs"] + 1
            deactivate = misses >= DEACTIVATE_AFTER_MISSES
            counts["deactivated"] += deactivate
            stmts.append(f"UPDATE churches SET missed_syncs = {misses}"
                         f"{', is_active = 0' if deactivate else ''} WHERE id = {sql_literal(e['id'])};")

    run_vals = [stats["started_at"], stats["finished_at"], region, stats["requests"], len(churches),
                counts["new"], counts["changed"], counts["deactivated"],
                json.dumps(stats["errors"][:50]) if stats["errors"] else None]
    stmts.append("INSERT INTO sync_runs (started_at, finished_at, region, requests, churches_seen, churches_new, "
                 f"churches_changed, churches_deactivated, errors) VALUES ({', '.join(map(sql_literal, run_vals))});")
    return "\n".join(stmts) + "\n", counts, fuzzy


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("crawl_file", type=Path)
    target = p.add_mutually_exclusive_group(required=True)
    target.add_argument("--local", action="store_const", dest="target", const="local")
    target.add_argument("--remote", action="store_const", dest="target", const="remote")
    p.add_argument("--sql-out", type=Path)
    p.add_argument("--dry-run", action="store_true", help="build the SQL but don't execute it")
    args = p.parse_args(argv)

    crawl = json.loads(args.crawl_file.read_text())
    existing = fetch_existing(crawl["stats"]["region"], args.target)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    sql, counts, fuzzy = build_sql(crawl, existing, now)

    for f in fuzzy:
        print(f"fuzzy match ({f['how']}): {f['incoming']!r} -> {f['existing']!r} [{f['id']}]")
    print(f"{args.target}: {counts} · {len(sql.splitlines())} statements · {len(existing)} existing rows")

    sql_path = args.sql_out
    if sql_path is None:
        sql_path = Path(tempfile.mkstemp(suffix=".sql", prefix="masstimes-load-")[1])
    sql_path.write_text(sql)
    if args.dry_run:
        print(f"dry run: SQL written to {sql_path}")
        return 0
    wrangler(["--file", str(sql_path.resolve()), "--yes"], args.target)
    print("loaded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
