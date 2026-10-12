import json
from pathlib import Path

from sync.load import address_key, build_sql, sql_literal
from sync.normalize import content_hash, in_region, normalize_church

SAMPLE = json.loads((Path(__file__).parent.parent / "docs" / "sample-response.json").read_text())["response"]
NOW = "2026-10-12T00:00:00+00:00"


def crawl(churches, complete=False):
    stats = {"region": "nyc-li", "requests": 1, "errors": [], "started_at": NOW, "finished_at": NOW,
             "complete": complete}
    return {"stats": stats, "churches": churches}


def sample_churches():
    return [dict(c, region="nyc-li") for c in map(normalize_church, SAMPLE) if in_region(c, "nyc-li")]


def existing_from(churches, **over):
    return [dict({"id": f"id-{i}", "match_key": c["match_key"], "name": c["name"], "lat": c["lat"],
                  "lng": c["lng"], "street": c["street"], "postal_code": c["postal_code"],
                  "content_hash": c["content_hash"], "missed_syncs": 0, "is_active": 1}, **over)
            for i, c in enumerate(churches)]


def test_sql_literal_escapes():
    assert sql_literal("St. Stephen's") == "'St. Stephen''s'"
    assert sql_literal(None) == "NULL"
    assert sql_literal(True) == "1"
    assert sql_literal(40.5) == "40.5"


def test_address_key_normalizes():
    assert address_key("130 Fifth Street", "11530-1234") == address_key("130 Fifth St.", "11530")
    assert address_key("384 Clinton St, Hempstead, NY", "11550") == "384 clinton st|11550"
    assert address_key(None, "11550") is None


def test_first_load_inserts_everything():
    cs = sample_churches()
    sql, counts, fuzzy = build_sql(crawl(cs), [], NOW)
    assert counts == {"new": len(cs), "changed": 0, "unchanged": 0, "deactivated": 0}
    assert sql.count("INSERT INTO churches") == len(cs)
    assert "INSERT INTO sync_runs" in sql


def test_unchanged_reload_only_touches_last_seen():
    cs = sample_churches()
    sql, counts, _ = build_sql(crawl(cs), existing_from(cs), NOW)
    assert counts["unchanged"] == len(cs) and counts["new"] == counts["changed"] == 0
    assert "INSERT INTO churches" not in sql
    assert sql.count("UPDATE churches SET last_seen_at") == 1  # one batched statement


def test_moved_church_fuzzy_matches_instead_of_duplicating():
    cs = sample_churches()
    existing = existing_from(cs)
    moved = json.loads(json.dumps(cs))
    moved[0]["lat"] += 0.0006  # ~65 m north: new match_key, same church
    moved[0]["match_key"] = moved[0]["match_key"].rsplit("|", 2)[0] + f"|{moved[0]['lat']:.3f}|{moved[0]['lng']:.3f}"
    moved[0]["content_hash"] = content_hash(moved[0])
    sql, counts, fuzzy = build_sql(crawl(moved), existing, NOW)
    assert counts["new"] == 0 and counts["changed"] == 1
    assert fuzzy[0]["how"] == "name+200m" and fuzzy[0]["id"] == "id-0"


def test_missing_churches_only_count_on_complete_crawls():
    cs = sample_churches()
    existing = existing_from(cs, missed_syncs=2)
    _, counts, _ = build_sql(crawl(cs[1:], complete=False), existing, NOW)
    assert counts["deactivated"] == 0
    sql, counts, _ = build_sql(crawl(cs[1:], complete=True), existing, NOW)
    assert counts["deactivated"] == 1
    assert "missed_syncs = 3, is_active = 0 WHERE id = 'id-0'" in sql
