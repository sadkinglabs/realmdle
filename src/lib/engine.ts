// Realmdle rules, kept free of Discord and the database so they can be
// tested: the puzzle day, which cards can be the answer, the planner that
// chooses them, and the clues a guess gets.

import { ELEMENTS, RARITIES, type Card } from './types';

export const MAX_GUESSES = 6;
/** The subtype hint appears once this many guesses have been used, i.e. for the last guess. */
export const HINT_AFTER = MAX_GUESSES - 1;
export const TIME_ZONE = 'Australia/Sydney';
/** Puzzle #1. */
const EPOCH = Date.UTC(2026, 8, 28);
const DAY_MS = 86_400_000;

/** The calendar date in Sydney as [year, month (1-12), day]. */
export function sydneyDate(now: Date): [number, number, number] {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [y, m, d] = parts.split('-').map(Number);
  return [y, m, d];
}

/** Days since puzzle #1, negative before launch. */
function dayIndex(now: Date): number {
  const [y, m, d] = sydneyDate(now);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY_MS);
}

/** The Sydney date (YYYY-MM-DD) of a puzzle. */
export function puzzleDate(puzzle: number): string {
  return new Date(EPOCH + (puzzle - 1) * DAY_MS).toISOString().slice(0, 10);
}

export function puzzleNumber(now: Date): number {
  return Math.max(1, dayIndex(now) + 1);
}

/** When a puzzle starts: midnight in Sydney (UTC+10, or +11 in daylight saving), as epoch ms. */
export function puzzleStart(puzzle: number): number {
  const midnightUtc = EPOCH + (puzzle - 1) * DAY_MS;
  const hour = (t: number) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23' }).format(t));
  const standard = midnightUtc - 10 * 3_600_000;
  return hour(standard) === 0 ? standard : standard - 3_600_000;
}

/** FNV-1a then a murmur3 finaliser: a cheap hash that spreads well. */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Cards that can be the answer: every card with a rarity (avatars have
 * none). Look-alikes are allowed: seven Ordinary Air Magics cost 2 in Beta,
 * so a player can turn every square green and still be wrong. The board
 * says so when that happens, and the last-guess hint (the answer's
 * typeline) tells them apart; every typeline is different.
 */
export function answerPool(cards: Card[]): Card[] {
  return cards.filter((c) => c.rarity !== null && c.set !== '');
}

/** Highest `hash(puzzle:id)` wins: a stable, even-handed pick from any list. */
function rendezvous(pool: Card[], puzzle: number, salt = ''): Card | null {
  let best: Card | null = null;
  let bestScore = -1;
  for (const card of pool) {
    const score = hash(salt ? `realmdle:${salt}:${puzzle}:${card.id}` : `realmdle:${puzzle}:${card.id}`);
    if (score > bestScore || (score === bestScore && best !== null && card.id < best.id)) {
      best = card;
      bestScore = score;
    }
  }
  return best;
}

/** A card name may not be the answer again within this many days, whatever its set. */
export const NAME_GAP = 365;

/** Days a new set's cards wait after release before they can be the answer. */
export const GRACE_DAYS = 14;
/** How many days ahead the answers are planned (the Worker's puzzles table). */
export const LOCK_DAYS = 7;

export type PlanOptions = {
  /** Minimum days between two answers with the same name. */
  gap?: number;
  /** The date (YYYY-MM-DD) a card may first be the answer; always, if left out. */
  eligibleFrom?: (card: Card) => string;
  /**
   * A secret mixed into the tie-breaking hash. The code and card data are
   * public, so without one anyone could run the planner and read the
   * answers ahead; the server plans with a secret salt.
   */
  salt?: string;
};

/** When each card may first be the answer: its set's release date plus GRACE_DAYS. */
export function releaseGate(sets: string[], setDates: string[]): (card: Card) => string {
  const from = new Map(sets.map((set, i) => [set, new Date(Date.parse(setDates[i]) + GRACE_DAYS * DAY_MS).toISOString().slice(0, 10)]));
  return (card) => from.get(card.set) ?? '0000-00-00';
}

/**
 * Extends a schedule so it covers `until` puzzles, replaying the days it
 * already has so the rules see the whole history. Each new day is chosen
 * by these rules, in order:
 *
 * 1. The card may be the answer by that date: a new set's cards wait
 *    GRACE_DAYS after release (they can still be guessed).
 * 2. Its name has not been the answer in the last `gap` days, in any set.
 *    There are more eligible names than days in the gap, so some name is
 *    always free and this never has to bend.
 * 3. Of those, the entry that has been the answer the fewest times. Every
 *    entry has a day before any comes back, and a card that becomes
 *    eligible later joins level with the entries still waiting in the
 *    current round: a new set gets its fair share of days alongside them,
 *    rather than taking over or waiting a full round.
 * 4. Then the name that has waited longest, then a hash of the day, so the
 *    order is fixed by the data and not by when the script ran.
 */
export function extendSchedule(cards: Card[], schedule: string[], until: number, options: PlanOptions = {}): string[] {
  const gap = options.gap ?? NAME_GAP;
  const eligibleFrom = options.eligibleFrom ?? (() => '0000-00-00');
  const pool = answerPool(cards);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const out = [...schedule];

  const plays = new Map<string, number>(); // id -> times it has been the answer, once eligible
  const nameSeen = new Map<string, number>(); // name -> latest day (index) it was the answer
  // cards in the order they become eligible, admitted as the days pass
  const pending = pool.map((c) => ({ card: c, from: eligibleFrom(c) })).sort((a, b) => a.from.localeCompare(b.from));
  let next = 0;
  const admit = (day: number) => {
    const date = puzzleDate(day + 1);
    if (next >= pending.length || pending[next].from > date) return;
    // join level with whoever is still waiting in the current round
    const level = plays.size ? Math.min(...plays.values()) : 0;
    for (; next < pending.length && pending[next].from <= date; next++) {
      if (!plays.has(pending[next].card.id)) plays.set(pending[next].card.id, level);
    }
  };
  const record = (id: string, day: number) => {
    plays.set(id, (plays.get(id) ?? 0) + 1);
    const name = byId.get(id)?.name;
    if (name) nameSeen.set(name, day);
  };

  out.forEach((id, day) => {
    admit(day);
    record(id, day);
  });

  while (out.length < until) {
    const day = out.length;
    admit(day);
    const open = pool.filter((c) => plays.has(c.id));
    if (!open.length) break;
    const nameAge = (c: Card) => nameSeen.get(c.name) ?? -Infinity;
    const free = open.filter((c) => day - nameAge(c) >= gap);
    // only reachable with fewer names than `gap` days: fall back to every eligible entry
    let candidates = free.length ? free : open;
    const fewest = Math.min(...candidates.map((c) => plays.get(c.id)!));
    candidates = candidates.filter((c) => plays.get(c.id) === fewest);
    const oldestName = Math.min(...candidates.map(nameAge));
    const pick = rendezvous(
      candidates.filter((c) => nameAge(c) === oldestName),
      day + 1,
      options.salt,
    )!;
    out.push(pick.id);
    record(pick.id, day);
  }
  return out;
}

/** Days where a name repeats within NAME_GAP days of its last appearance, as [day, name] (1-based days). */
export function nameRepeats(cards: Card[], schedule: string[], gap = NAME_GAP): [number, string][] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const lastSeen = new Map<string, number>();
  const repeats: [number, string][] = [];
  schedule.forEach((id, day) => {
    const name = byId.get(id)?.name;
    if (!name) return;
    const last = lastSeen.get(name);
    if (last !== undefined && day - last < gap) repeats.push([day + 1, name]);
    lastSeen.set(name, day);
  });
  return repeats;
}

/**
 * 🟩 exact, 🟨 close, ⬛ miss. Only mana also says which way the answer
 * lies (up: the answer costs more); elsewhere close says near, not which way.
 */
export type Verdict = 'correct' | 'partial' | 'wrong';
export type Clue = { verdict: Verdict; direction?: 'up' | 'down' };

export const COLUMNS = ['elements', 'type', 'cost', 'power', 'rarity', 'set'] as const;
export type Column = (typeof COLUMNS)[number];
export type Feedback = Record<Column, Clue>;

const exact = (same: boolean): Clue => ({ verdict: same ? 'correct' : 'wrong' });

/** Numbers and ranked values: exact, or close when one away either side. */
function oneAway(guess: number, answer: number): Clue {
  return { verdict: guess === answer ? 'correct' : Math.abs(answer - guess) === 1 ? 'partial' : 'wrong' };
}

/**
 * Mana and power. 'X' (variable) and null (none) are values of their own:
 * they match only themselves, and are never close to a number.
 */
function costLike(guess: number | 'X' | null, answer: number | 'X' | null): Clue {
  if (typeof guess !== 'number' || typeof answer !== 'number') return exact(guess === answer);
  return oneAway(guess, answer);
}

/** The mana arrow: on any numeric miss, whether the answer costs more (up) or less. */
function withDirection(clue: Clue, guess: Card['cost'], answer: Card['cost']): Clue {
  if (clue.verdict === 'correct' || typeof guess !== 'number' || typeof answer !== 'number') return clue;
  return { ...clue, direction: answer > guess ? 'up' : 'down' };
}

/** Threshold: the same elements, or close with at least one in common. */
function elementClue(guess: Card['elements'], answer: Card['elements']): Clue {
  if (guess.length === answer.length && guess.every((e) => answer.includes(e))) return exact(true);
  return { verdict: guess.some((e) => answer.includes(e)) ? 'partial' : 'wrong' };
}

export function compare(guess: Card, answer: Card, sets: string[]): Feedback {
  return {
    elements: elementClue(guess.elements, answer.elements),
    type: exact(guess.type === answer.type),
    cost: withDirection(costLike(guess.cost, answer.cost), guess.cost, answer.cost),
    power: costLike(guess.power, answer.power),
    // rarity in order Ordinary, Exceptional, Elite, Unique; none (avatars) matches only none
    rarity: guess.rarity && answer.rarity ? oneAway(RARITIES.indexOf(guess.rarity), RARITIES.indexOf(answer.rarity)) : exact(guess.rarity === answer.rarity),
    // sets in release order
    set: oneAway(sets.indexOf(guess.set), sets.indexOf(answer.set)),
  };
}

/** Every clue green on a card that is not the answer: another card looks the same. */
export const allMatch = (feedback: Feedback) => COLUMNS.every((c) => feedback[c].verdict === 'correct');

export function formatElements(elements: Card['elements']): string {
  return elements.length ? [...elements].sort((a, b) => ELEMENTS.indexOf(a) - ELEMENTS.indexOf(b)).join(' ') : 'None';
}

const CARD_TYPES = ['Minion', 'Magic', 'Aura', 'Artifact', 'Site', 'Avatar'];
const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The typeline as a last-guess hint, without the clues it would give away:
 * rarity, type and subtype words (singular or plural) become "___", runs of
 * them one blank, and "An ___" becomes "A ___" so the article does not hint
 * at a vowel. "A Unique Site at creation’s core" → "A ___ at creation’s core".
 */
export function veiledTypeline(card: Card): string | null {
  if (!card.typeline) return null;
  const words = [...new Set([...RARITIES, ...CARD_TYPES, card.type, ...card.subtypes])];
  const forms = words.flatMap((w) => [`${w}es`, `${w}s`, w]).sort((a, b) => b.length - a.length);
  return card.typeline
    .replace(new RegExp(`\\b(${forms.map(escape).join('|')})\\b`, 'g'), '___')
    .replace(/___(?:[ ,]+___)+/g, '___')
    .replace(/\b(An?|an?) ___/g, (_, article: string) => `${article[0]} ___`);
}

/** A name for matching what players type: case, spaces and punctuation ignored ("kings" finds "King's"). */
export const looseName = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Names that match what has been typed: prefix matches first, then anywhere. */
export function suggest(cards: Card[], query: string, exclude: Set<string>, limit = 10): Card[] {
  const q = looseName(query);
  if (!q) return [];
  const starts: Card[] = [];
  const contains: Card[] = [];
  for (const card of cards) {
    if (exclude.has(card.id)) continue;
    const name = looseName(card.name);
    if (name.startsWith(q)) starts.push(card);
    else if (name.includes(q)) contains.push(card);
  }
  // same name: keep the pool's release order, so Alpha is listed before Beta
  const byName = (a: Card, b: Card) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  return [...starts.sort(byName), ...contains.sort(byName)].slice(0, limit);
}
