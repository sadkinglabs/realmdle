import { describe, expect, it } from 'vitest';
import type { Board } from './board';
import { announcementEmbed, boardEmbed, distributionBars, grid, leaderboardEmbed, rank, resultEmbed, statsEmbed, type RankedRow } from './discord';
import { compare } from './engine';
import { playerStats } from './stats';
import type { Card } from './types';

// Made-up cards
const card = (over: Partial<Card> & { id: string; name: string }): Card => ({
  type: 'Minion',
  elements: ['Fire'],
  cost: 3,
  power: 3,
  rarity: 'Ordinary',
  subtypes: ['Beast'],
  set: 'Alpha',
  image: 'https://img.test/a.webp',
  ...over,
});
const SETS = ['Alpha', 'Beta', 'Arthurian Legends'];
const answer = card({ id: 'ans', name: 'Test Drake', elements: ['Fire', 'Water'], cost: 5, power: 4, rarity: 'Elite', set: 'Beta', subtypes: ['Dragon'] });
const miss = card({ id: 'miss', name: 'Test Imp', set: 'Arthurian Legends', cost: 4 });
const cards = new Map([answer, miss].map((c) => [c.id, c]));
const who = { id: '222222222222222222', name: 'Bob', avatar: null };

const board = (over: Partial<Board>): Board => ({
  puzzle: 12,
  date: '2026-10-09',
  player: { name: 'Bob', leaderboard: false },
  guesses: [],
  over: false,
  won: false,
  hint: null,
  answer: null,
  stats: null,
  community: { finished: 31, solved: 24 },
  ...over,
});

describe('private board', () => {
  it('shows every guess with its six clues, never the answer while playing', () => {
    const e = boardEmbed(board({ guesses: [{ id: 'miss', feedback: compare(miss, answer, SETS) }] }), cards);
    expect(e.title).toBe('Realmdle #12 · guess 2 of 6');
    expect(e.description).toContain('**Test Imp** · Arthurian Legends');
    expect(e.description).toContain('🟨 Fire'); // shares an element
    expect(e.description).toContain('🟨 4▲'); // cost close, answer higher
    expect(e.description).toContain('Arthurian▼');
    expect(JSON.stringify(e)).not.toContain('Test Drake');
  });

  it('adds the hint on the last guess', () => {
    const e = boardEmbed(board({ hint: ['Dragon'] }), cards);
    expect(e.fields?.[0]).toEqual({ name: 'Last guess, a hint', value: 'The card is a **Dragon**.' });
  });

  it('reveals the card with its art once over', () => {
    const e = boardEmbed(board({ over: true, won: true, answer: 'ans', guesses: [{ id: 'ans', feedback: compare(answer, answer, SETS) }] }), cards);
    expect(e.title).toBe('Solved in 1: Test Drake');
    expect(e.image?.url).toBe(answer.image);
  });
});

describe('public result', () => {
  const finished = board({
    over: true,
    won: true,
    answer: 'ans',
    guesses: [
      { id: 'miss', feedback: compare(miss, answer, SETS) },
      { id: 'ans', feedback: compare(answer, answer, SETS) },
    ],
    stats: playerStats([{ puzzle: 11, solved: true, attempts: 3, finished: true }, { puzzle: 12, solved: true, attempts: 2, finished: true }], 12),
  });

  it('shows the squares, score, streak and the day, but never the card', () => {
    const e = resultEmbed(finished, who);
    expect(e.author?.name).toBe('Bob · Realmdle #12 · 2/6');
    expect(e.description).toBe(`<@${who.id}> solved it in 2.\n\n${grid(finished.guesses.map((g) => g.feedback))}`);
    expect(e.fields).toEqual([
      { name: 'Streak', value: '🔥 2', inline: true },
      { name: 'Solved', value: '100% of 2', inline: true },
      { name: 'Today', value: '24 of 31 solved', inline: true },
    ]);
    const text = JSON.stringify(e);
    expect(text).not.toContain('Test Drake');
    expect(text).not.toContain('img.test');
  });

  it('marks a loss', () => {
    expect(resultEmbed({ ...finished, won: false }, who).author?.name).toContain('X/6');
  });
});

describe('stats', () => {
  it('shows the numbers and a bar per guess count, marking today', () => {
    const s = playerStats([{ puzzle: 1, solved: true, attempts: 3, finished: true }, { puzzle: 2, solved: true, attempts: 3, finished: true }, { puzzle: 3, solved: true, attempts: 1, finished: true }], 3);
    const e = statsEmbed(who, s, { state: 'won', guesses: 1 }, true);
    expect(e.fields?.slice(0, 5).map((f) => f.value)).toEqual(['3', '100%', '2.3', '🔥 3', '3']);
    expect(distributionBars(s.distribution, 1)).toBe('```\n1 ███████ 1  ← today\n2 · 0\n3 ██████████████ 2\n4 · 0\n5 · 0\n6 · 0\n```');
  });
});

describe('leaderboard', () => {
  const row = (id: string, over: Partial<RankedRow>): RankedRow => ({ id, name: id, currentStreak: 0, maxStreak: 0, winRate: 0, played: 10, averageGuesses: 3, ...over });
  const rows = [
    row('a', { currentStreak: 3, winRate: 90 }),
    row('b', { currentStreak: 9, winRate: 70 }),
    row('c', { currentStreak: 1, winRate: 100, played: 2 }),
    ...Array.from({ length: 12 }, (_, i) => row(`z${i}`, { currentStreak: 0, winRate: 10 })),
  ];

  it('ranks by streak, or by solved % among players with enough games', () => {
    expect(rank(rows, 'streak').slice(0, 3).map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(rank(rows, 'solved')[0].id).toBe('a'); // c has 100% but only 2 games
  });

  it('shows the top ten with medals and adds the viewer further down', () => {
    const e = leaderboardEmbed(rank(rows, 'streak'), 'streak', 'z9', 12);
    const lines = e.description!.split('\n');
    expect(lines[0]).toBe('🥇 <@b>  🔥 **9** · best 0 · 70% solved');
    expect(lines).toHaveLength(12);
    expect(lines[10]).toBe('⋯');
    expect(lines[11]).toContain('<@z9>'); // names sort as text, so z9 is last
    expect(lines[11]).toContain('← you');
  });
});

describe('midnight post', () => {
  it('recaps yesterday and invites people to play', () => {
    const e = announcementEmbed(13, { card: answer, finished: 31, solved: 24 });
    expect(e.title).toBe('Realmdle #13 is live');
    expect(e.description).toContain("Yesterday's card was **Test Drake** (Beta). 24 of 31 players solved it.");
  });
});
