-- Mass Times Finder D1 schema. See docs/PRODUCT_PLAN.md ("Data model").
-- Services live in churches.services_json (one row per church) to stay within D1 free write limits.

CREATE TABLE churches (
  id                TEXT PRIMARY KEY,          -- our stable UUID
  match_key         TEXT UNIQUE NOT NULL,      -- normalized name + coords rounded to 3 dp
  source_id         TEXT,                      -- MassTimes id: a hint only, never a key
  name              TEXT NOT NULL,
  street            TEXT,
  city              TEXT,
  state             TEXT,
  postal_code       TEXT,
  county            TEXT,
  country           TEXT,
  lat               REAL NOT NULL,
  lng               REAL NOT NULL,
  timezone          TEXT NOT NULL,
  diocese           TEXT,
  diocese_type      TEXT,
  rite              TEXT,
  church_type       TEXT,
  primary_language  TEXT,
  phone             TEXT,
  email             TEXT,
  website           TEXT,
  wheelchair        INTEGER,                   -- 1 / 0 / NULL
  comments          TEXT,
  directions        TEXT,
  pastor            TEXT,
  services_json     TEXT NOT NULL,
  languages         TEXT,                      -- '|English|Spanish|'
  service_types     INTEGER NOT NULL DEFAULT 0,-- bits: 1 mass, 2 confession, 4 adoration, 8 devotion, 16 holy day
  has_perpetual_adoration INTEGER NOT NULL DEFAULT 0,
  source_updated_at TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  missed_syncs      INTEGER NOT NULL DEFAULT 0,-- consecutive full syncs not seen; inactive at 3
  is_active         INTEGER NOT NULL DEFAULT 1,
  content_hash      TEXT NOT NULL,
  coord_suspect     INTEGER NOT NULL DEFAULT 0,
  region            TEXT NOT NULL
);
CREATE INDEX churches_lat_lng ON churches (lat, lng);
CREATE INDEX churches_source_id ON churches (source_id);

CREATE VIRTUAL TABLE churches_fts USING fts5 (
  name, city, diocese, content = 'churches', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER churches_ai AFTER INSERT ON churches BEGIN
  INSERT INTO churches_fts (rowid, name, city, diocese) VALUES (new.rowid, new.name, new.city, new.diocese);
END;
CREATE TRIGGER churches_ad AFTER DELETE ON churches BEGIN
  INSERT INTO churches_fts (churches_fts, rowid, name, city, diocese) VALUES ('delete', old.rowid, old.name, old.city, old.diocese);
END;
CREATE TRIGGER churches_au AFTER UPDATE OF name, city, diocese ON churches BEGIN
  INSERT INTO churches_fts (churches_fts, rowid, name, city, diocese) VALUES ('delete', old.rowid, old.name, old.city, old.diocese);
  INSERT INTO churches_fts (rowid, name, city, diocese) VALUES (new.rowid, new.name, new.city, new.diocese);
END;

CREATE TABLE geocode_cache (
  q           TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
);

CREATE TABLE sync_runs (
  id               INTEGER PRIMARY KEY,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  region           TEXT,
  requests         INTEGER,
  churches_seen    INTEGER,
  churches_new     INTEGER,
  churches_changed INTEGER,
  churches_deactivated INTEGER,
  errors           TEXT
);
