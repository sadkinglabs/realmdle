import { describe, expect, it } from 'vitest';
import { answerPool, compare, extendSchedule, nameRepeats, puzzleDate, puzzleNumber, releaseGate, suggest } from './engine';
import type { Card } from './types';

// Made-up cards: the rules are tested against shapes, not real card data.
const SETS = ['First', 'Second', 'Third'];
const card = (over: Partial<Card> & { name: string }): Card => ({
  id: over.name.toLowerCase().replace(/ /g, '-'),
  type: 'Minion',
  elements: ['Fire'],
  cost: 3,
  power: 3,
  rarity: 'Ordinary',
  subtypes: [],
  set: 'First',
  image: null,
  ...over,
});
const answer = card({ name: 'Test Drake', elements: ['Fire', 'Water'], cost: 5, power: 4, rarity: 'Elite', set: 'Second' });

describe('puzzleNumber', () => {
  it('starts at 1 on launch day in Sydney', () => {
    // 28 Sep 2026 00:30 in Sydney (AEST, UTC+10) is still the 27th in UTC
    expect(puzzleNumber(new Date('2026-09-27T14:30:00Z'))).toBe(1);
    expect(puzzleNumber(new Date('2026-09-28T13:59:00Z'))).toBe(1);
    expect(puzzleNumber(new Date('2026-09-28T14:00:00Z'))).toBe(2);
  });

  it('follows the Sydney clock across daylight saving', () => {
    // DST starts 4 Oct 2026, so midnight moves from 14:00 to 13:00 UTC
    expect(puzzleNumber(new Date('2026-10-05T12:59:00Z'))).toBe(8);
    expect(puzzleNumber(new Date('2026-10-05T13:00:00Z'))).toBe(9);
  });

});

describe('answerPool', () => {
  it('only allows a card no other card can be mistaken for', () => {
    const twinA = card({ name: 'Twin A', type: 'Site', elements: [], cost: null, power: null });
    const twinB = card({ name: 'Twin B', type: 'Site', elements: [], cost: null, power: null });
    const loner = card({ name: 'Loner', cost: 9 });
    expect(answerPool([twinA, twinB, loner]).map((c) => c.name)).toEqual(['Loner']);
    expect(new Set(extendSchedule([twinA, twinB, loner], [], 20))).toEqual(new Set([loner.id]));
  });

  it('skips cards without a rarity', () => {
    expect(answerPool([card({ name: 'No Rarity', rarity: null })])).toEqual([]);
  });
});

describe('schedule', () => {
  const pool = Array.from({ length: 10 }, (_, i) => card({ name: `Card ${i}`, cost: i }));

  it('uses every card once before any repeats', () => {
    const s = extendSchedule(pool, [], 25);
    expect(s).toHaveLength(25);
    expect(new Set(s.slice(0, 10)).size).toBe(10);
    expect(new Set(s.slice(10, 20)).size).toBe(10);
  });

  it('never changes days already scheduled, even when the pool changes', () => {
    const first = extendSchedule(pool, [], 12);
    const grown = [...pool, card({ name: 'Newcomer', cost: 42 })];
    const longer = extendSchedule(grown, first, 30);
    expect(longer.slice(0, 12)).toEqual(first);
    expect(longer).toContain('newcomer');
  });

  it('spaces out the copies of a card from different sets', () => {
    // five cards, each printed in two sets: ten entries, five names
    const twoSets = pool.slice(0, 5).flatMap((c) => [
      { ...c, id: `${c.id}-a`, set: 'First' },
      { ...c, id: `${c.id}-b`, set: 'Second' },
    ]);
    const s = extendSchedule(twoSets, [], 10);
    const names = s.map((id) => twoSets.find((c) => c.id === id)!.name);
    // every name once before any name comes back, then in the same order
    expect(new Set(names.slice(0, 5)).size).toBe(5);
    expect(names.slice(5)).toEqual(names.slice(0, 5));
  });

  it('never brings a name back within the gap, even with more entries than names', () => {
    // 8 names, 3 of them in two sets: 11 entries. With a gap of 5 days the
    // rule always has a free name, so it must hold over many cycles.
    const names = Array.from({ length: 8 }, (_, i) => card({ name: `Name ${i}`, cost: i }));
    const entries = [...names, ...names.slice(0, 3).map((c) => ({ ...c, id: `${c.id}-b`, set: 'Second' }))];
    const s = extendSchedule(entries, [], 200, { gap: 5 });
    expect(nameRepeats(entries, s, 5)).toEqual([]);
    // and every entry still gets its day
    expect(new Set(s).size).toBe(entries.length);
  });

  it('holds a new set back until its grace period is over', () => {
    const fresh = card({ name: 'Fresh', cost: 50, set: 'Second' });
    // Second released on puzzle 5's date: with 14 days' grace, eligible from puzzle 19
    const gate = releaseGate(['First', 'Second'], ['2020-01-01', puzzleDate(5)]);
    const s = extendSchedule([...pool, fresh], [], 40, { gap: 1, eligibleFrom: gate });
    expect(s.indexOf(fresh.id) + 1).toBeGreaterThanOrEqual(19);
  });

  it('gives a new set a fair share, level with the cards still waiting their turn', () => {
    // 10 old cards: one full round (10 days) and half of the next (5 days)
    const played = extendSchedule(pool, [], 15, { gap: 1 });
    const waiting = pool.filter((c) => !played.slice(10).includes(c.id)).map((c) => c.id);
    const fresh = Array.from({ length: 5 }, (_, i) => card({ name: `Fresh ${i}`, cost: 60 + i }));
    const next = extendSchedule([...pool, ...fresh], played, 25, { gap: 1 }).slice(15);
    // the next ten days are the five old cards still waiting plus the five new ones, in some mix
    expect(new Set(next)).toEqual(new Set([...waiting, ...fresh.map((c) => c.id)]));
    expect(next.slice(0, 5).some((id) => id.startsWith('fresh'))).toBe(true);
  });

  it('reports a name that comes back too soon', () => {
    const twins = [card({ name: 'Twin', id: 'twin-a', set: 'First' }), card({ name: 'Twin', id: 'twin-b', set: 'Second' })];
    expect(nameRepeats(twins, ['twin-a', 'twin-b'])).toEqual([[2, 'Twin']]);
  });

});

describe('compare', () => {
  it('marks an exact guess correct everywhere', () => {
    const f = compare(answer, answer, SETS);
    expect(Object.values(f).every((c) => c.verdict === 'correct')).toBe(true);
  });

  it('gives partial and direction clues', () => {
    const f = compare(card({ name: 'Guess', elements: ['Fire'], cost: 4, power: 1, rarity: 'Ordinary', set: 'Third' }), answer, SETS);
    expect(f.elements).toEqual({ verdict: 'partial', direction: null });
    expect(f.type.verdict).toBe('correct');
    expect(f.cost).toEqual({ verdict: 'partial', direction: 'up' });
    expect(f.power).toEqual({ verdict: 'wrong', direction: 'up' });
    expect(f.rarity).toEqual({ verdict: 'wrong', direction: 'up' });
    expect(f.set).toEqual({ verdict: 'wrong', direction: 'down' });
  });

  it('treats a missing cost as its own value', () => {
    const site = card({ name: 'Test Site', type: 'Site', elements: [], cost: null, power: null });
    expect(compare(site, answer, SETS).cost).toEqual({ verdict: 'wrong', direction: null });
    expect(compare(site, site, SETS).elements.verdict).toBe('correct');
  });
});

describe('suggest', () => {
  const cards = [card({ name: 'Fire Drake' }), card({ name: 'Drake Rider' }), card({ name: 'Water Drake' })];
  it('lists prefix matches before other matches and leaves out guessed cards', () => {
    expect(suggest(cards, 'drake', new Set()).map((c) => c.name)).toEqual(['Drake Rider', 'Fire Drake', 'Water Drake']);
    expect(suggest(cards, 'drake', new Set(['fire-drake'])).map((c) => c.name)).toEqual(['Drake Rider', 'Water Drake']);
  });
});
