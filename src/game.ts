// Realmdle on the server: the planned puzzles, scoring guesses and stats.
// The answer only ever leaves the server once a player's puzzle is over.

import cardData from '../data/cards.json';
import type { Board } from './lib/board';
import type { RankedRow, WeekReview } from './lib/discord';
import { HINT_AFTER, LOCK_DAYS, MAX_GUESSES, compare, extendSchedule, looseName, puzzleDate, releaseGate, suggest, veiledTypeline } from './lib/engine';
import { playerStats, type Play } from './lib/stats';
import type { Card, CardData } from './lib/types';

const data = cardData as CardData;
export const cardsById = new Map(data.cards.map((c) => [c.id, c]));
const eligibleFrom = releaseGate(data.sets, data.setDates);

/**
 * Players guess a card by name, whatever its set. A name printed in several
 * sets counts as its first printing, unless it is the answer's name, which
 * wins in any set. Printings are listed oldest set first.
 */
const printingsByName = new Map<string, Card[]>();
for (const card of [...data.cards].sort((a, b) => data.sets.indexOf(a.set) - data.sets.indexOf(b.set))) {
  const key = looseName(card.name);
  printingsByName.set(key, [...(printingsByName.get(key) ?? []), card]);
}
/** One entry per name, for autocomplete. */
export const guessableCards = [...printingsByName.values()].map((printings) => printings[0]);

/** The entry a guess of this name stands for today. */
export function printingFor(name: string, answer: Card): Card | null {
  const printings = printingsByName.get(looseName(name));
  if (!printings) return null;
  return printings.find((c) => c.id === answer.id) ?? printings[0];
}

/**
 * What a player's guess means: an autocomplete pick, or a typed name. A
 * typed name may be partial if it fits only one card; otherwise the error
 * offers the closest names.
 */
export function pickCard(value: string, answer: Card, guessed: Set<string>): { card: Card } | { error: string } {
  const exact = printingFor(cardsById.get(value)?.name ?? value, answer);
  if (exact) return { card: exact };
  const close = suggest(guessableCards, value, guessed, 3);
  if (close.length === 1) return { card: printingFor(close[0].name, answer)! };
  if (close.length) return { error: `No card called **${value.trim()}**. Did you mean ${close.map((c) => `**${c.name}**`).join(', ')}? Pick one from the list as you type.` };
  return { error: `No card called **${value.trim()}**. Start typing and pick a card from the list.` };
}

/** The autocomplete entries of the names a player has guessed today, to leave out of the list. */
export function guessedEntries(ids: Set<string>): Set<string> {
  return new Set([...ids].flatMap((id) => {
    const card = cardsById.get(id);
    return card ? [printingsByName.get(looseName(card.name))![0].id] : [];
  }));
}

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

/**
 * Creates the player on first sign-in, on the leaderboard (playing means
 * taking part; /realmdle settings takes them off); afterwards refreshes
 * their name and avatar, leaving that choice alone.
 */
export async function upsertPlayer(db: D1Database, id: string, name: string, avatar: string | null = null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO players (discord_id, display_name, avatar, leaderboard, created_at, seen_at) VALUES (?1, ?2, ?3, 1, ?4, ?4)
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

/** Claims a one-off job by name (such as a week's recap); false if another run already has. */
export async function claimOnce(db: D1Database, key: string): Promise<boolean> {
  const result = await db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').bind(key, now()).run();
  return result.meta.changes === 1;
}

export async function releaseOnce(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM meta WHERE key = ?').bind(key).run();
}

/**
 * A finished week, puzzles `from` to `to`, for the Monday recap: each day's
 * card and numbers, how many played, and the leaderboard players who
 * solved every day.
 */
export async function weekInReview(db: D1Database, from: number, to: number): Promise<WeekReview> {
  const days = await db
    .prepare(
      `SELECT p.puzzle, p.card_id, COUNT(x.discord_id) AS finished, COALESCE(SUM(x.solved), 0) AS solved,
              AVG(CASE WHEN x.solved = 1 THEN x.attempts END) AS average
       FROM puzzles p LEFT JOIN plays x ON x.puzzle = p.puzzle AND x.finished = 1
       WHERE p.puzzle BETWEEN ?1 AND ?2 GROUP BY p.puzzle ORDER BY p.puzzle`,
    )
    .bind(from, to)
    .all<{ puzzle: number; card_id: string; finished: number; solved: number; average: number | null }>();
  const players = await db
    .prepare('SELECT COUNT(DISTINCT discord_id) AS n FROM plays WHERE puzzle BETWEEN ?1 AND ?2 AND finished = 1')
    .bind(from, to)
    .first<{ n: number }>();
  const perfect = await db
    .prepare(
      `SELECT x.discord_id FROM plays x JOIN players p ON p.discord_id = x.discord_id
       WHERE p.leaderboard = 1 AND x.puzzle BETWEEN ?1 AND ?2 AND x.solved = 1
       GROUP BY x.discord_id HAVING COUNT(*) = ?3 ORDER BY MIN(x.finished_at)`,
    )
    .bind(from, to, to - from + 1)
    .all<{ discord_id: string }>();
  return {
    from,
    to,
    players: players?.n ?? 0,
    days: days.results.flatMap((d) => {
      const card = cardsById.get(d.card_id);
      return card ? [{ puzzle: d.puzzle, card, finished: d.finished, solved: d.solved, average: d.average === null ? null : Math.round(d.average * 10) / 10 }] : [];
    }),
    perfect: perfect.results.map((r) => r.discord_id),
  };
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
    hint: ids.length >= HINT_AFTER ? { subtypes: answer.subtypes, typeline: veiledTypeline(answer) } : null,
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
  const name = looseName(cardsById.get(cardId)!.name);
  if (previous.some((id) => looseName(cardsById.get(id)?.name ?? '') === name)) return { ok: false, error: 'You have already guessed that card.' };

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
