-- Global per-minute budget for live MassTimes requests, for hosts without a rate-limit binding (Pages).
CREATE TABLE outbound_budget (
  minute TEXT PRIMARY KEY,   -- "2026-10-12T20:48"
  n      INTEGER NOT NULL
);
