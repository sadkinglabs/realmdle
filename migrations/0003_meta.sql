-- Small settings the Worker keeps for itself, e.g. which version of the
-- /realmdle command definition Discord has (so it only re-registers on change).
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
