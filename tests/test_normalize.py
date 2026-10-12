import json
from pathlib import Path

import pytest

from sync.normalize import (
    in_region,
    make_match_key,
    normalize_church,
    normalize_url,
    normalized_name,
    parse_days,
    parse_last_update,
    parse_time,
)

SAMPLE = json.loads((Path(__file__).parent.parent / "docs" / "sample-response.json").read_text())["response"]
BY_NAME = {c["name"]: c for c in SAMPLE}


def church(name):
    return normalize_church(BY_NAME[name])


@pytest.mark.parametrize("raw,expected", [
    ("09:00:00", "09:00"), ("19:25:00", "19:25"), ("00:40:00", "00:40"),
    ("", None), (None, None), ("  ", None),
    ("1/1/1900 5:00:00 PM", "17:00"), ("garbage", None),
])
def test_parse_time(raw, expected):
    assert parse_time(raw) == expected


@pytest.mark.parametrize("raw,expected", [
    ("Sunday    ", [0]), ("Saturday  ", [6]), ("Wednesday ", [3]),
    ("Weekdays  ", [1, 2, 3, 4, 5]), (None, []), ("", []),
    ("0", [0]), ("99", []), ("Someday", []),
])
def test_parse_days(raw, expected):
    assert parse_days(raw) == expected


def test_parse_last_update():
    assert parse_last_update("8/19/2026 7:42:16 AM") == "2026-08-19T07:42:16"
    assert parse_last_update("10/23/2024 5:37:54 PM") == "2024-10-23T17:37:54"
    assert parse_last_update("") is None


@pytest.mark.parametrize("raw,expected", [
    ("www.stannesgc.org/", "https://www.stannesgc.org/"),
    ("http://lorettochurch.org/", "http://lorettochurch.org/"),
    (None, None), ("", None),
])
def test_normalize_url(raw, expected):
    assert normalize_url(raw) == expected


def test_every_sample_church_normalizes():
    for raw in SAMPLE:
        c = normalize_church(raw)
        assert c is not None
        assert c["timezone"] == "America/New_York"
        assert c["content_hash"]


def test_trims_strings_and_parses_numbers():
    c = church("St. Stephen's Knanaya Catholic Forane Church")
    assert c["street"] == "384 Clinton St, Hempstead, NY"
    assert c["lat"] == pytest.approx(40.717588, abs=1e-6)
    assert c["wheelchair"] is None
    assert c["directions"] is None
    assert c["rite"] == "Syro-Malabar"


def test_pastor_and_language_trimmed():
    c = church("St. Vladimir [Ukrainian]")
    assert c["pastor"] == "Reverend Wasyl Hrynkiw, Administrator"
    assert c["primary_language"] == "English"
    assert c["languages"] == "|English|Ukrainian|"


def test_perpetual_adoration_has_no_day_or_time():
    c = church("Curé of Ars")
    perpetual = [s for s in c["services"] if s["perpetual"]]
    assert len(perpetual) == 1
    assert perpetual[0] == {
        "kind": "adoration", "source_type": "Adorations", "days": [], "start": None, "end": None,
        "language": None, "comment": None, "perpetual": True, "holy_day": False, "vigil": False,
    }
    assert c["has_perpetual_adoration"] == 1


def test_service_kinds_and_flags():
    c = church("St. Anne")
    by_type = {s["source_type"]: s for s in c["services"]}
    assert by_type["Vigil for Holy Days"]["kind"] == "mass"
    assert by_type["Vigil for Holy Days"]["vigil"] and by_type["Vigil for Holy Days"]["holy_day"]
    assert by_type["Holy Days"]["days"] == [1, 2, 3, 4, 5]
    assert by_type["Confessions"] == {
        "kind": "confession", "source_type": "Confessions", "days": [6], "start": "16:00", "end": "16:45",
        "language": "English", "comment": None, "perpetual": False, "holy_day": False, "vigil": False,
    }
    assert c["website"] == "https://www.stannesgc.org/"


def test_service_type_bitmask():
    assert church("St. Joseph")["service_types"] == 1 | 2 | 4  # mass, confession, adoration
    assert church("St. Anne")["service_types"] == 1 | 2 | 16  # mass, confession, holy day


def test_comment_kept_verbatim():
    c = church("St. Joseph")
    comments = {s["comment"] for s in c["services"] if s["comment"]}
    assert "mid-September to mid-June only" in comments
    assert "2nd, 3rd & 4th Saturdays of the month" in comments


def test_name_normalization():
    assert normalized_name("St. Vladimir [Ukrainian]") == "st vladimir"
    assert normalized_name("Saint Vladimir Church") == "st vladimir"
    assert normalized_name("Ss. Joachim and Anne") == "st joachim and anne"
    assert normalized_name("Curé of Ars") == "cure ars"
    assert make_match_key("St. Anne", 40.71853527, -73.67858361) == "st anne|40.719|-73.679"


def test_content_hash_stable_and_sensitive():
    raw = BY_NAME["St. Ladislaus"]
    a, b = normalize_church(raw), normalize_church(json.loads(json.dumps(raw)))
    assert a["content_hash"] == b["content_hash"]
    changed = json.loads(json.dumps(raw))
    changed["church_worship_times"][0]["time_start"] = "10:00:00"
    assert normalize_church(changed)["content_hash"] != a["content_hash"]
    moved_id = dict(raw, id="999999")  # MassTimes id changes alone must not count as a change
    assert normalize_church(moved_id)["content_hash"] == a["content_hash"]


def test_rejects_missing_coordinates():
    assert normalize_church(dict(BY_NAME["St. Anne"], latitude="", longitude=None)) is None
    assert normalize_church(dict(BY_NAME["St. Anne"], latitude="0", longitude="0")) is None


@pytest.mark.parametrize("state,zip_,expected", [
    ("New York", "11550", True),   # Nassau
    ("New York", "11901", True),   # Suffolk (Riverhead)
    ("New York", "10001", True),   # Manhattan
    ("New York", "10314", True),   # Staten Island
    ("New York", "10458", True),   # Bronx
    ("New York", "11201", True),   # Brooklyn
    ("New York", "11368", True),   # Queens
    ("New York", "10701", False),  # Yonkers (Westchester)
    ("New Jersey", "07030", False),
    ("Connecticut", "06901", False),
    ("New York", None, False),
])
def test_in_region(state, zip_, expected):
    assert in_region({"state": state, "postal_code": zip_}, "nyc-li") is expected


@pytest.mark.parametrize("start,kind,expected", [
    ("00:00", "confession", None),   # placeholder: "by appointment", "30 min before Mass"
    ("00:00", "mass", None),
    ("00:40", "confession", "12:40"),  # noon typo
    ("00:10", "mass", "12:10"),
    ("04:59", "mass", "16:59"),
    ("05:00", "mass", "05:00"),
    ("00:05", "adoration", "00:05"),  # overnight adoration is real
    (None, "mass", None),
])
def test_fix_start_time(start, kind, expected):
    from sync.normalize import fix_start_time
    assert fix_start_time(start, kind) == expected


def test_placeholder_time_drops_end_too():
    from sync.normalize import normalize_service
    s = normalize_service({"service_typename": "Confessions", "day_of_week": "Saturday  ",
                           "time_start": "00:00:00", "time_end": "00:30:00", "comment": "By appointment"})
    assert s["start"] is None and s["end"] is None and s["comment"] == "By appointment"
