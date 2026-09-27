-- Realmdle in Discord: avatars for the public result embed, and a record of
-- which days the bot has announced so the midnight post goes out once.

ALTER TABLE players ADD COLUMN avatar TEXT; -- Discord avatar hash, null for the default avatar

CREATE TABLE announcements (
  puzzle    INTEGER PRIMARY KEY REFERENCES puzzles (puzzle),
  posted_at TEXT    NOT NULL
);
