"""Turn raw MassTimes church JSON into our normalized church records.

Live-data format notes are in CLAUDE.md ("Data source"); the target shape is in
docs/PRODUCT_PLAN.md ("Data model").
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from datetime import datetime
from functools import lru_cache

# MassTimes service_typename -> (kind, holy_day, vigil)
SERVICE_TYPES = {
    "weekend": ("mass", False, False),
    "week days": ("mass", False, False),
    "holy days": ("mass", True, False),
    "vigil for holy days": ("mass", True, True),
    "confessions": ("confession", False, False),
    "adorations": ("adoration", False, False),
    "devotions": ("devotion", False, False),
}

DAYS = {
    "sunday": [0], "monday": [1], "tuesday": [2], "wednesday": [3],
    "thursday": [4], "friday": [5], "saturday": [6], "weekdays": [1, 2, 3, 4, 5],
}

KIND_BITS = {"mass": 1, "confession": 2, "adoration": 4, "devotion": 8}
HOLY_DAY_BIT = 16

# NYC (100-104 Manhattan/SI/Bronx, 110-116 Queens/Brooklyn) + Long Island (110-119).
# 105-108 is Westchester, which is deliberately excluded.
REGION_ZIP3 = {
    "nyc-li": {"100", "101", "102", "103", "104", "110", "111", "112", "113",
               "114", "115", "116", "117", "118", "119"},
}


def clean(value) -> str | None:
    """Trim strings; turn empty strings into None."""
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def parse_float(value) -> float | None:
    s = clean(value)
    try:
        return float(s) if s is not None else None
    except ValueError:
        return None


def parse_time(value) -> str | None:
    """'09:00:00' -> '09:00'; '' -> None. Also accepts the V4 '1/1/1900 5:00:00 PM' form."""
    s = clean(value)
    if s is None:
        return None
    for fmt in ("%H:%M:%S", "%H:%M", "%m/%d/%Y %I:%M:%S %p"):
        try:
            return datetime.strptime(s, fmt).strftime("%H:%M")
        except ValueError:
            continue
    return None


def parse_days(value) -> list[int]:
    s = clean(value)
    if s is None:
        return []
    if s.isdigit():  # V4-style numeric day; 99 = unspecified
        n = int(s)
        return [n] if 0 <= n <= 6 else []
    return list(DAYS.get(s.lower(), []))


def parse_last_update(value) -> str | None:
    """'8/19/2026 7:42:16 AM' -> '2026-08-19T07:42:16' (MassTimes local time; zone unknown)."""
    s = clean(value)
    if s is None:
        return None
    try:
        return datetime.strptime(s, "%m/%d/%Y %I:%M:%S %p").isoformat()
    except ValueError:
        return None


def normalize_url(value) -> str | None:
    s = clean(value)
    if s is None:
        return None
    if not re.match(r"^https?://", s, re.I):
        s = "https://" + s.lstrip("/")
    return s


def fix_start_time(start: str | None, kind: str) -> str | None:
    """Source quirks seen in live data:
    - "00:00" is a placeholder for "no set time" ("by appointment", "30 min before Mass").
    - A Mass/confession/devotion at 00:01-04:59 is a mis-entered noon-hour time (00:40 -> 12:40).
    Overnight adoration really can start after midnight, so it is left alone.
    """
    if start is None or start == "00:00":
        return None
    if kind in {"mass", "confession", "devotion"} and start < "05:00":
        h, m = start.split(":")
        return f"{int(h) + 12:02d}:{m}"
    return start


def normalize_service(raw: dict) -> dict | None:
    type_name = (clean(raw.get("service_typename")) or "").lower()
    kind, holy_day, vigil = SERVICE_TYPES.get(type_name, ("other", False, False))
    start = fix_start_time(parse_time(raw.get("time_start")), kind)
    return {
        "kind": kind,
        "source_type": clean(raw.get("service_typename")),
        "days": parse_days(raw.get("day_of_week")),
        "start": start,
        "end": parse_time(raw.get("time_end")) if start else None,
        "language": clean(raw.get("language")),
        "comment": clean(raw.get("comment")),
        "perpetual": bool(raw.get("is_perpetual")),
        "holy_day": holy_day,
        "vigil": vigil,
    }


def _service_sort_key(s: dict):
    return (s["kind"], s["holy_day"], s["days"][0] if s["days"] else 9, s["start"] or "", s["language"] or "")


_NAME_STOPWORDS = {"church", "parish", "the", "of", "catholic", "roman"}


def normalized_name(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\[.*?\]", " ", s)  # drop bracketed rite notes like [Ukrainian]
    s = re.sub(r"\bsts?\b\.?|\bsaints?\b|\bss\b\.?", " st ", s)
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return " ".join(w for w in s.split() if w not in _NAME_STOPWORDS)


def make_match_key(name: str, lat: float, lng: float) -> str:
    return f"{normalized_name(name)}|{lat:.3f}|{lng:.3f}"


@lru_cache(maxsize=1)
def _tzfinder():
    from timezonefinder import TimezoneFinder
    return TimezoneFinder()


def timezone_for(lat: float, lng: float) -> str:
    return _tzfinder().timezone_at(lat=lat, lng=lng) or "America/New_York"


def in_region(church: dict, region: str) -> bool:
    if (church.get("state") or "").lower() not in {"new york", "ny"}:
        return False
    zip3 = (church.get("postal_code") or "")[:3]
    return zip3 in REGION_ZIP3[region]


def normalize_church(raw: dict) -> dict | None:
    """Return a normalized church dict, or None if it lacks a name or coordinates."""
    name = clean(raw.get("name"))
    lat, lng = parse_float(raw.get("latitude")), parse_float(raw.get("longitude"))
    if not name or lat is None or lng is None or (lat == 0 and lng == 0):
        return None

    services = [s for s in (normalize_service(w) for w in raw.get("church_worship_times") or []) if s]
    services.sort(key=_service_sort_key)

    languages = sorted({s["language"] for s in services if s["language"]} |
                       ({clean(raw.get("language_name"))} - {None}))
    service_types = 0
    for s in services:
        service_types |= KIND_BITS.get(s["kind"], 0)
        if s["holy_day"]:
            service_types |= HOLY_DAY_BIT

    wheelchair = raw.get("wheel_chair_access")
    church = {
        "match_key": make_match_key(name, lat, lng),
        "source_id": clean(raw.get("id")),
        "name": name,
        "street": clean(raw.get("church_address_street_address")),
        "city": clean(raw.get("church_address_city_name")),
        "state": clean(raw.get("church_address_providence_name")),
        "postal_code": clean(raw.get("church_address_postal_code")),
        "county": clean(raw.get("church_address_county")),
        "country": clean(raw.get("church_address_country_territory_name")),
        "lat": round(lat, 6),
        "lng": round(lng, 6),
        "timezone": timezone_for(lat, lng),
        "diocese": clean(raw.get("diocese_name")),
        "diocese_type": clean(raw.get("diocese_type_name")),
        "rite": clean(raw.get("rite_type_name")),
        "church_type": clean(raw.get("church_type_name")),
        "primary_language": clean(raw.get("language_name")),
        "phone": clean(raw.get("phone_number")),
        "email": clean(raw.get("email")),
        "website": normalize_url(raw.get("url")),
        "wheelchair": None if wheelchair is None else int(bool(wheelchair)),
        "comments": clean(raw.get("comments")),
        "directions": clean(raw.get("directions")),
        "pastor": clean(raw.get("pastors_name")),
        "services": services,
        "languages": "|" + "|".join(languages) + "|" if languages else None,
        "service_types": service_types,
        "has_perpetual_adoration": int(any(s["perpetual"] and s["kind"] == "adoration" for s in services)),
        "source_updated_at": parse_last_update(raw.get("last_update")),
    }
    church["content_hash"] = content_hash(church)
    return church


def content_hash(church: dict) -> str:
    """Hash of everything that comes from the source (not our bookkeeping fields)."""
    payload = {k: v for k, v in church.items() if k not in {"content_hash", "source_id"}}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]
