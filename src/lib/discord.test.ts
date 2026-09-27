import { describe, expect, it } from 'vitest';
import type { Board } from './board';
import { HOW_TO, announcementEmbed, boardEmbed, distributionBars, grid, hardestAndEasiest, leaderboardEmbed, playButton, rank, recapEmbed, resultEmbed, statsEmbed, type RankedRow, type WeekDay } from './discord';
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
    expect(e.title).toBe('Realmdle #12 · 5 guesses left');
    expect(e.description).toContain('**Test Imp** · Arthurian Legends');
    expect(e.description).toContain('🟨 Threshold **Fire**'); // shares an element
    expect(e.description).toContain('🟨 Mana **4**▲'); // cost close, answer higher
    expect(e.description).toContain('Set **Arthurian**▼');
    expect(JSON.stringify(e)).not.toContain('Test Drake');
  });

  it('welcomes the player with the puzzle, its Sydney date and how to play', () => {
    const e = boardEmbed(board({}), cards);
    expect(e.title).toBe('Welcome to Realmdle #12 - Friday 9 October 2026');
    expect(e.description).toBe(HOW_TO);
    expect(HOW_TO).toContain('**/guess**');
    expect(HOW_TO).toContain('Threshold · Type · Mana · Power · Rarity · Set');
  });

  it('labels each clue, three to a line', () => {
    const lines = boardEmbed(board({ guesses: [{ id: 'miss', feedback: compare(miss, answer, SETS) }] }), cards).description!.split('\n');
    expect(lines[1]).toBe('🟨 Threshold **Fire** · 🟩 Type **Minion** · 🟨 Mana **4**▲');
    expect(lines[2]).toBe('🟨 Power **3**▲ · ⬛ Rarity **Ordinary**▲ · ⬛ Set **Arthurian**▼');
  });

  it('warns about the last guess and adds the hint', () => {
    const miss5 = Array.from({ length: 5 }, () => ({ id: 'miss', feedback: compare(miss, answer, SETS) }));
    const e = boardEmbed(board({ hint: ['Dragon'], guesses: miss5 }), cards);
    expect(e.title).toBe('Realmdle #12 · ⚠️ last guess');
    expect(e.fields?.[0]).toEqual({ name: '⚠️ Last guess! Here is a hint ⚠️', value: '💡 The card is a **Dragon**.' });
  });

  it('reveals the card with its art, the streak and a countdown to the next card', () => {
    const stats = playerStats([{ puzzle: 11, solved: true, attempts: 3, finished: true }, { puzzle: 12, solved: true, attempts: 1, finished: true }], 12);
    const e = boardEmbed(board({ over: true, won: true, answer: 'ans', stats, guesses: [{ id: 'ans', feedback: compare(answer, answer, SETS) }] }), cards);
    expect(e.title).toBe('🏆 Solved in 1: Test Drake');
    expect(e.description).toContain('Got it in one!');
    // #13 starts at midnight on 10 October in Sydney, in daylight saving (UTC+11)
    expect(e.description).toContain(`🔥 Streak **2** · ⏳ Next card <t:${Date.UTC(2026, 9, 9, 13) / 1000}:R>`);
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

  it('shows the score, a cheer, the squares, streak, place and the day, but never the card', () => {
    const e = resultEmbed(finished, who);
    expect(e.author?.name).toBe('Bob · Realmdle #12 · 2/6');
    expect(e.description).toBe(
      `<@${who.id}> solved **Realmdle #12** in **2/6**\n*🔥 Scary good!*\n\n${grid(finished.guesses.map((g) => g.feedback))}\n\n` +
        '🔥 **2**-day streak · 🏅 24th to solve today\n👥 **31** players today · **24** solved',
    );
    expect(e.fields).toBeUndefined();
    const text = JSON.stringify(e);
    expect(text).not.toContain('Test Drake');
    expect(text).not.toContain('img.test');
  });

  it('celebrates the first solver, and counts a lone player', () => {
    const e = resultEmbed({ ...finished, community: { finished: 1, solved: 1 } }, who);
    expect(e.description).toContain('🥇 First to solve today');
    expect(e.description).toContain('👥 **1** player today · **1** solved');
  });

  it('marks a loss without a place', () => {
    const e = resultEmbed({ ...finished, won: false, stats: null }, who);
    expect(e.author?.name).toContain('X/6');
    expect(e.description).toContain('ran out of guesses');
    expect(e.description).not.toContain('to solve today');
  });

  it('comes with a Play button, so one tap takes anyone to their own board', () => {
    expect(playButton(12)[0].components[0]).toMatchObject({ custom_id: 'realmdle:play', label: 'Play Realmdle #12' });
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
    expect(e.title).toBe('🔮 Realmdle #13 is live');
    expect(e.description).toContain("Yesterday's card was **Test Drake** (Beta).\n👥 **31** played · **24** solved");
    expect(e.description).toContain(HOW_TO);
    expect(e.fields).toBeUndefined(); // nobody on the leaderboard yet
  });

  it('shows the top ten with streak, solved % and games played', () => {
    const rows: RankedRow[] = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `p${i}`, currentStreak: 12 - i, maxStreak: 12, winRate: 90, played: 20, averageGuesses: 3 }));
    const lines = announcementEmbed(13, null, rows).fields![0].value.split('\n');
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe('🥇 <@p0>  🔥 **12** · 90% · 20 played');
    expect(lines[9]).toBe('`10` <@p9>  🔥 **3** · 90% · 20 played');
  });
});

describe('weekly recap', () => {
  const day = (puzzle: number, c: typeof answer, finished: number, solved: number, average: number | null): WeekDay => ({ puzzle, card: c, finished, solved, average });
  const days = [day(1, miss, 10, 9, 3.1), day(2, answer, 10, 3, 5.2), day(3, miss, 0, 0, null), day(4, answer, 10, 3, 4.0)];
  const row = (id: string, currentStreak: number): RankedRow => ({ id, name: id, currentStreak, maxStreak: currentStreak, winRate: 100, played: 7, averageGuesses: 3 });

  it('finds the hardest day (fewest solved, then most guesses) and the easiest', () => {
    const { hardest, easiest } = hardestAndEasiest(days);
    expect(hardest?.puzzle).toBe(2); // 3 of 10 like #4, but took more guesses
    expect(easiest?.puzzle).toBe(1);
    expect(hardestAndEasiest([days[0]])).toEqual({ hardest: days[0], easiest: null });
  });

  it('sums up the week, lists every card, the streaks and the perfect weeks', () => {
    const e = recapEmbed({ from: 1, to: 7, players: 12, days, perfect: ['a'] }, [row('a', 7), row('b', 3), row('c', 0)]);
    expect(e.title).toBe('📅 Realmdle week in review · #1–#7');
    expect(e.description).toContain('👥 **12** players · **30** games · **50%** solved');
    expect(e.description).toContain('`#2` **Test Drake** · Beta · 3/10 solved');
    expect(e.description).toContain('`#3` **Test Imp** · Arthurian · nobody played');
    expect(e.description).toContain('💀 **Hardest:** Test Drake (Beta), 3 of 10 solved');
    expect(e.description).toContain('🍰 **Easiest:** Test Imp (Arthurian Legends), 90% solved, 3.1 guesses on average');
    expect(e.description).toContain('🥇 <@a> **7** days\n🥈 <@b> **3** days');
    expect(e.description).not.toContain('<@c>'); // no streak, not listed
    expect(e.description).toContain('🎯 **Perfect week**, all 7 solved: <@a>');
    expect(e.thumbnail?.url).toBe(answer.image);
  });
});
