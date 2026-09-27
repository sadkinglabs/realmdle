import { describe, expect, it } from 'vitest';
import { playerStats, type Play } from './stats';

const win = (puzzle: number, attempts: number): Play => ({ puzzle, solved: true, attempts, finished: true });
const loss = (puzzle: number): Play => ({ puzzle, solved: false, attempts: 6, finished: true });

describe('playerStats', () => {
  it('is empty for a new player', () => {
    expect(playerStats([], 10)).toEqual({ played: 0, won: 0, winRate: 0, currentStreak: 0, maxStreak: 0, distribution: [0, 0, 0, 0, 0, 0], averageGuesses: null });
  });

  it('counts wins, the guess spread and the average', () => {
    const s = playerStats([win(1, 3), win(2, 4), loss(3), win(4, 3)], 4);
    expect(s).toMatchObject({ played: 4, won: 3, winRate: 75, distribution: [0, 0, 2, 1, 0, 0], averageGuesses: 3.3 });
  });

  it('keeps a streak alive until a whole day is missed', () => {
    const plays = [win(5, 2), win(6, 2), win(7, 2)];
    expect(playerStats(plays, 7).currentStreak).toBe(3); // played today
    expect(playerStats(plays, 8).currentStreak).toBe(3); // today not played yet
    expect(playerStats(plays, 9).currentStreak).toBe(0); // missed yesterday
  });

  it('breaks the streak on a loss, and remembers the best run', () => {
    const plays = [win(1, 2), win(2, 2), win(3, 2), loss(4), win(5, 2)];
    expect(playerStats(plays, 5)).toMatchObject({ currentStreak: 1, maxStreak: 3 });
    expect(playerStats([...plays.slice(0, 3), loss(4)], 4).currentStreak).toBe(0);
  });

  it('ignores a puzzle still in progress', () => {
    const s = playerStats([win(1, 2), { puzzle: 2, solved: false, attempts: 3, finished: false }], 2);
    expect(s).toMatchObject({ played: 1, currentStreak: 1 });
  });
});
