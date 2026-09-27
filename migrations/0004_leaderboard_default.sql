-- Playing Realmdle puts you on the server leaderboard; /realmdle settings
-- leaderboard:False takes you off. New players are created with
-- leaderboard = 1 (upsertPlayer in src/game.ts), and everyone who had
-- played before the change joins it here.
UPDATE players SET leaderboard = 1;
