// Player statistics, worked out from the plays table rather than stored,
// so they can never drift from what actually happened. Shared by the
// Worker (web API, and later the Discord commands) and the tests.

import { MAX_GUESSES } from './engine';

/** One finished (or abandoned) puzzle for one player. */
export type Play = { puzzle: number; solved: boolean; attempts: number; finished: boolean };

export type PlayerStats = {
  played: number;
  won: number;
  /** Whole percent, 0 to 100. */
  winRate: number;
  /** Solved puzzles in a row, ending today or yesterday. */
  currentStreak: number;
  maxStreak: number;
  /** distribution[i] = puzzles solved in i + 1 guesses. */
  distribution: number[];
  /** Mean guesses over solved puzzles, one decimal; null before the first win. */
  averageGuesses: number | null;
};

/**
 * `today` is the current puzzle number. A streak survives until the player
 * misses a whole day: today's puzzle not being played yet does not break
 * it, but a failed puzzle or a skipped day does.
 */
export function playerStats(plays: Play[], today: number): PlayerStats {
  const finished = plays.filter((p) => p.finished).sort((a, b) => a.puzzle - b.puzzle);
  const solved = finished.filter((p) => p.solved);
  const distribution = Array<number>(MAX_GUESSES).fill(0);
  for (const p of solved) if (p.attempts >= 1 && p.attempts <= MAX_GUESSES) distribution[p.attempts - 1] += 1;

  // longest run of consecutive puzzle numbers that were all solved
  let maxStreak = 0;
  let run = 0;
  let previous = -1;
  for (const p of finished) {
    run = p.solved ? (p.puzzle === previous + 1 ? run + 1 : 1) : 0;
    previous = p.puzzle;
    maxStreak = Math.max(maxStreak, run);
  }

  // the current run must reach today or, if today is unplayed, yesterday
  const won = new Set(solved.map((p) => p.puzzle));
  const lost = new Set(finished.filter((p) => !p.solved).map((p) => p.puzzle));
  let currentStreak = 0;
  let day = won.has(today) ? today : lost.has(today) ? -1 : today - 1;
  while (day > 0 && won.has(day)) {
    currentStreak += 1;
    day -= 1;
  }

  const total = solved.reduce((sum, p) => sum + p.attempts, 0);
  return {
    played: finished.length,
    won: solved.length,
    winRate: finished.length ? Math.round((solved.length / finished.length) * 100) : 0,
    currentStreak,
    maxStreak,
    distribution,
    averageGuesses: solved.length ? Math.round((total / solved.length) * 10) / 10 : null,
  };
}
