// Realmdle on the server: the planned puzzles, scoring guesses and stats.
// The answer only ever leaves the server once a player's puzzle is over.

import cardData from '../data/cards.json';
import type { Board } from './lib/board';
import type { RankedRow } from './lib/discord';
import { HINT_AFTER, LOCK_DAYS, MAX_GUESSES, compare, extendSchedule, puzzleDate, releaseGate } from './lib/engine';
import { playerStats, type Play } from './lib/stats';
import type { Card, CardData } from './lib/types';

const data = cardData as CardData;
export const cardsById = new Map(data.cards.map((c) => [c.id, c]));
const eligibleFrom = releaseGate(data.sets, data.setDates);

const now = () => new Date().toISOString();

/**
 * Makes sure every puzzle up to `today + LOCK_DAYS` has an answer. Rows are
 * only ever added, never changed: the planner replays the whole history
 * (for the name gap and fair-share rules) and appends the missing days.
 * INSERT OR IGNORE makes two overlapping runs harmless.
 */
export async function ensurePlanned(db: D1Database, salt: string, today: number): Promise<void> {
  const until = today + LOCK_DAYS;
  const { results } = await db.prepare('SELECT card_id FROM puzzles ORDER BY puzzle').all<{ card_id: string }>();
  if (results.length >= until) return;
  const planned = extendSchedule(data.cards, results.map((r) => r.card_id), until, { eligibleFrom, salt });
  const insert = db.prepare('INSERT OR IGNORE INTO puzzles (puzzle, date, card_id, planned_at) VALUES (?, ?, ?, ?)');
  const rows = planned.slice(results.length).map((id, i) => {
    const puzzle = results.length + i + 1;
    return insert.bind(puzzle, puzzleDate(puzzle), id, now());
  });
  if (rows.length) await db.batch(rows);
}

export async function answerFor(db: D1Database, puzzle: number): Promise<Card | null> {
  const row = await db.prepare('SELECT card_id FROM puzzles WHERE puzzle = ?').bind(puzzle).first<{ card_id: string }>();
  return row ? (cardsById.get(row.card_id) ?? null) : null;
}

type PlayRow = { puzzle: number; guesses: string; attempts: number; solved: number; finished: number };

const toPlay = (r: PlayRow): Play => ({ puzzle: r.puzzle, solved: r.solved === 1, attempts: r.attempts, finished: r.finished === 1 });

/** Creates the player on first sign-in; afterwards refreshes their name and avatar. */
export async function upsertPlayer(db: D1Database, id: string, name: string, avatar: string | null = null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO players (discord_id, display_name, avatar, created_at, seen_at) VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT (discord_id) DO UPDATE SET display_name = excluded.display_name, avatar = excluded.avatar, seen_at = excluded.seen_at`,
    )
    .bind(id, name, avatar, now())
    .run();
}

export async function getPlayer(db: D1Database, id: string) {
  return db
    .prepare('SELECT display_name, leaderboard, avatar FROM players WHERE discord_id = ?')
    .bind(id)
    .first<{ display_name: string; leaderboard: number; avatar: string | null }>();
}

/** Card ids a player has already guessed today (to leave them out of autocomplete). */
export async function guessedToday(db: D1Database, id: string, puzzle: number): Promise<Set<string>> {
  const row = await db.prepare('SELECT guesses FROM plays WHERE discord_id = ? AND puzzle = ?').bind(id, puzzle).first<{ guesses: string }>();
  return new Set(row ? (JSON.parse(row.guesses) as string[]) : []);
}

export async function dayCounts(db: D1Database, puzzle: number) {
  const row = await db
    .prepare('SELECT COUNT(*) AS finished, COALESCE(SUM(solved), 0) AS solved FROM plays WHERE puzzle = ? AND finished = 1')
    .bind(puzzle)
    .first<{ finished: number; solved: number }>();
  return { finished: row?.finished ?? 0, solved: row?.solved ?? 0 };
}

/** Claims the day's announcement; false if another run already has. */
export async function claimAnnouncement(db: D1Database, puzzle: number): Promise<boolean> {
  const result = await db.prepare('INSERT OR IGNORE INTO announcements (puzzle, posted_at) VALUES (?, ?)').bind(puzzle, now()).run();
  return result.meta.changes === 1;
}

export async function releaseAnnouncement(db: D1Database, puzzle: number): Promise<void> {
  await db.prepare('DELETE FROM announcements WHERE puzzle = ?').bind(puzzle).run();
}

/** Everything a player's board shows for one puzzle (`playerId` null for nobody in particular). */
export async function board(db: D1Database, puzzle: number, answer: Card, playerId: string | null): Promise<Board> {
  const community = await dayCounts(db, puzzle);
  const base: Board = {
    puzzle,
    date: puzzleDate(puzzle),
    player: null,
    guesses: [],
    over: false,
    won: false,
    hint: null,
    answer: null,
    stats: null,
    community,
  };
  if (!playerId) return base;

  const player = await getPlayer(db, playerId);
  if (!player) return base;
  const { results } = await db
    .prepare('SELECT puzzle, guesses, attempts, solved, finished FROM plays WHERE discord_id = ? ORDER BY puzzle')
    .bind(playerId)
    .all<PlayRow>();
  const today = results.find((r) => r.puzzle === puzzle);
  const ids = today ? (JSON.parse(today.guesses) as string[]) : [];
  const over = today?.finished === 1;
  return {
    ...base,
    player: { name: player.display_name, leaderboard: player.leaderboard === 1 },
    guesses: ids.flatMap((id) => {
      const card = cardsById.get(id);
      return card ? [{ id, feedback: compare(card, answer, data.sets) }] : [];
    }),
    over,
    won: today?.solved === 1,
    hint: ids.length >= HINT_AFTER ? answer.subtypes : null,
    answer: over ? answer.id : null,
    stats: playerStats(results.map(toPlay), puzzle),
  };
}

export type GuessResult = { ok: true } | { ok: false; error: string };

/**
 * Records one guess. The update only applies if the play still has the
 * number of guesses it was read with, so two tabs guessing at once cannot
 * both count: the second gets `conflict` and simply reloads.
 */
export async function guess(db: D1Database, playerId: string, puzzle: number, answer: Card, cardId: string): Promise<GuessResult> {
  if (!cardsById.has(cardId)) return { ok: false, error: 'That is not a card Realmdle knows.' };
  const row = await db.prepare('SELECT guesses, attempts, finished FROM plays WHERE discord_id = ? AND puzzle = ?').bind(playerId, puzzle).first<PlayRow>();
  const previous = row ? (JSON.parse(row.guesses) as string[]) : [];
  if (row?.finished) return { ok: false, error: 'You have already finished today’s puzzle.' };
  if (previous.includes(cardId)) return { ok: false, error: 'You have already guessed that card.' };

  const guesses = [...previous, cardId];
  const solved = cardId === answer.id;
  const finished = solved || guesses.length >= MAX_GUESSES;
  const finishedAt = finished ? now() : null;

  const result = row
    ? await db
        .prepare('UPDATE plays SET guesses = ?, attempts = ?, solved = ?, finished = ?, finished_at = ? WHERE discord_id = ? AND puzzle = ? AND attempts = ?')
        .bind(JSON.stringify(guesses), guesses.length, solved ? 1 : 0, finished ? 1 : 0, finishedAt, playerId, puzzle, row.attempts)
        .run()
    : await db
        .prepare(
          `INSERT INTO plays (discord_id, puzzle, guesses, attempts, solved, finished, source, started_at, finished_at)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .bind(playerId, puzzle, JSON.stringify(guesses), solved ? 1 : 0, finished ? 1 : 0, 'discord', now(), finishedAt)
        .run();
  if (result.meta.changes !== 1) return { ok: false, error: 'That guess crossed with another one. Run `/realmdle play` to see your board.' };
  return { ok: true };
}

/** Every player who chose to be listed, with their stats. Ranking is `rank` in discord.ts. */
export async function leaderboardRows(db: D1Database, today: number): Promise<RankedRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.discord_id, p.display_name, x.puzzle, x.attempts, x.solved, x.finished
       FROM players p JOIN plays x ON x.discord_id = p.discord_id
       WHERE p.leaderboard = 1 AND x.finished = 1`,
    )
    .all<PlayRow & { discord_id: string; display_name: string }>();
  const byPlayer = new Map<string, { name: string; plays: Play[] }>();
  for (const r of results) {
    const entry = byPlayer.get(r.discord_id) ?? { name: r.display_name, plays: [] };
    entry.plays.push(toPlay(r));
    byPlayer.set(r.discord_id, entry);
  }
  return [...byPlayer.entries()].map(([id, { name, plays }]) => {
    const s = playerStats(plays, today);
    return { id, name, currentStreak: s.currentStreak, maxStreak: s.maxStreak, winRate: s.winRate, played: s.played, averageGuesses: s.averageGuesses };
  });
}

export async function setLeaderboard(db: D1Database, playerId: string, on: boolean): Promise<void> {
  await db.prepare('UPDATE players SET leaderboard = ? WHERE discord_id = ?').bind(on ? 1 : 0, playerId).run();
}

/** Deletes a player and every play of theirs. */
export async function deletePlayer(db: D1Database, playerId: string): Promise<void> {
  await db.batch([db.prepare('DELETE FROM plays WHERE discord_id = ?').bind(playerId), db.prepare('DELETE FROM players WHERE discord_id = ?').bind(playerId)]);
}
