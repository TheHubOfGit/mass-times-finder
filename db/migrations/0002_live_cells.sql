-- Live fetching (owner decision 2026-10-12): which areas the Worker has fetched from MassTimes, and when.
-- A cell is a ~0.05° square (≈3.5 mi). covered_mi is how far out from the cell centre the fetch reached.
CREATE TABLE fetch_cells (
  cell        TEXT PRIMARY KEY,   -- "<lat*20>:<lng*20>" rounded
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  covered_mi  REAL NOT NULL,
  pages       INTEGER NOT NULL,
  churches    INTEGER NOT NULL,
  fetched_at  TEXT NOT NULL
);
