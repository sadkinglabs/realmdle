-- Realmdle: the daily puzzle, its players and their plays.
-- Applied with `wrangler d1 migrations apply realmdle --remote` (see HANDOVER.md).

-- One row per day: every past puzzle plus the week ahead, planned by the
-- Worker's hourly cron. A row is never changed once written.
CREATE TABLE puzzles (
  puzzle     INTEGER PRIMARY KEY,         -- 1 is 28 Sep 2026, Sydney time
  date       TEXT    NOT NULL UNIQUE,     -- YYYY-MM-DD in Sydney
  card_id    TEXT    NOT NULL,            -- e.g. C000001-002 (codex id + set code)
  planned_at TEXT    NOT NULL
);

-- Anyone who has played, keyed by Discord user id.
CREATE TABLE players (
  discord_id   TEXT    PRIMARY KEY,
  display_name TEXT    NOT NULL,          -- refreshed each time they play
  leaderboard  INTEGER NOT NULL DEFAULT 0, -- 1 = chose to appear on the leaderboard
  created_at   TEXT    NOT NULL,
  seen_at      TEXT    NOT NULL
);

-- One row per player per puzzle. Stats (streaks, solved %, averages) are
-- computed from these rows, never stored.
CREATE TABLE plays (
  discord_id  TEXT    NOT NULL REFERENCES players (discord_id) ON DELETE CASCADE,
  puzzle      INTEGER NOT NULL REFERENCES puzzles (puzzle),
  guesses     TEXT    NOT NULL DEFAULT '[]', -- JSON array of card ids, in order
  attempts    INTEGER NOT NULL DEFAULT 0,
  solved      INTEGER NOT NULL DEFAULT 0,
  finished    INTEGER NOT NULL DEFAULT 0,
  source      TEXT    NOT NULL DEFAULT 'discord', -- where it was played, should another way to play be added
  started_at  TEXT    NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (discord_id, puzzle)
);

CREATE INDEX plays_by_puzzle ON plays (puzzle);
