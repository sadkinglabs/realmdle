// How Realmdle looks in Discord: the private board, the public result, the
// stats card and the leaderboard, as Discord embed objects. Pure functions
// of game data, so the Worker only fetches and sends, and the tests can
// check the designs without Discord.
//
// Emoji are Discord's native way to show colour, so the designs use them.

import type { Board } from './board';
import { COLUMNS, MAX_GUESSES, formatElements, type Clue, type Column, type Feedback } from './engine';
import type { PlayerStats } from './stats';
import type { Card } from './types';

export type Embed = {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  author?: { name: string; icon_url?: string };
  thumbnail?: { url: string };
  image?: { url: string };
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
};

export const COLOURS = { win: 0x5f8f55, loss: 0x8a6f5a, neutral: 0xe07a2c, gold: 0xc9a24f } as const;
const SQUARE = { correct: '🟩', partial: '🟨', wrong: '⬛' } as const;
const ARROW = { up: '▲', down: '▼' } as const;
const SHORT_SET: Record<string, string> = { 'Arthurian Legends': 'Arthurian' };
const MEDALS = ['🥇', '🥈', '🥉'];

const shortSet = (set: string) => SHORT_SET[set] ?? set;

function cell(card: Card, column: Column, clue: Clue): string {
  const raw =
    column === 'elements'
      ? formatElements(card.elements)
      : column === 'cost' || column === 'power'
        ? (card[column] ?? 'None')
        : column === 'set'
          ? shortSet(card.set)
          : (card[column] ?? 'None');
  return `${SQUARE[clue.verdict]} ${raw}${clue.direction ? ARROW[clue.direction] : ''}`;
}

/** One guess: the card, then its six clues on one line. */
export function guessLines(card: Card, feedback: Feedback): string {
  return `**${card.name}** · ${card.set}\n${COLUMNS.map((c) => cell(card, c, feedback[c])).join('  ')}`;
}

/** The spoiler-free grid: squares only. */
export function grid(feedbacks: Feedback[]): string {
  return feedbacks.map((f) => COLUMNS.map((c) => SQUARE[f[c].verdict]).join('')).join('\n');
}

/** The player's own board, shown privately after every step. */
export function boardEmbed(board: Board, cards: Map<string, Card>): Embed {
  const rows = board.guesses.flatMap(({ id, feedback }) => {
    const card = cards.get(id);
    return card ? [{ card, feedback }] : [];
  });
  const answer = board.answer ? cards.get(board.answer) : undefined;
  const lines = rows.map((r) => guessLines(r.card, r.feedback)).join('\n\n');

  if (board.over && answer) {
    return {
      color: board.won ? COLOURS.win : COLOURS.loss,
      title: board.won ? `Solved in ${rows.length}: ${answer.name}` : `Out of guesses. It was ${answer.name}`,
      description: `${answer.type}${answer.subtypes.length ? `, ${answer.subtypes.join(' ')}` : ''} · ${answer.set}\n\n${lines}`,
      image: answer.image ? { url: answer.image } : undefined,
      footer: { text: `Realmdle #${board.puzzle} · your result has been posted for the server` },
    };
  }

  const fields: Embed['fields'] = [];
  if (board.hint) fields.push({ name: 'Last guess, a hint', value: board.hint.length ? `The card is a **${board.hint.join(' ')}**.` : 'The card has no subtype.' });
  return {
    color: COLOURS.neutral,
    title: `Realmdle #${board.puzzle} · guess ${rows.length + 1} of ${MAX_GUESSES}`,
    description: rows.length
      ? lines
      : 'Guess the Sorcery card of the day in six tries.\nUse `/realmdle guess` and start typing a card name.\n\n🟩 match  🟨 close  ⬛ no match  ▲▼ the answer is higher or lower, rarer, or newer',
    fields,
    footer: { text: 'Only you can see this · /realmdle guess' },
  };
}

export type Who = { id: string; name: string; avatar: string | null };

export const avatarUrl = (who: Who) =>
  who.avatar ? `https://cdn.discordapp.com/avatars/${who.id}/${who.avatar}.png?size=128` : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(who.id) >> 22n) % 6}.png`;

/**
 * The public result, posted once a player finishes. It never names the
 * card: only the squares, the score, the streak and how the day is going.
 */
export function resultEmbed(board: Board, who: Who): Embed {
  const feedbacks = board.guesses.map((g) => g.feedback);
  const stats = board.stats;
  const score = board.won ? `${feedbacks.length}/${MAX_GUESSES}` : `X/${MAX_GUESSES}`;
  const headline = board.won
    ? feedbacks.length === 1
      ? 'got it in one!'
      : `solved it in ${feedbacks.length}.`
    : 'ran out of guesses.';
  const fields: Embed['fields'] = [];
  if (stats) {
    fields.push({ name: 'Streak', value: stats.currentStreak ? `🔥 ${stats.currentStreak}` : '0', inline: true });
    fields.push({ name: 'Solved', value: `${stats.winRate}% of ${stats.played}`, inline: true });
  }
  fields.push({ name: 'Today', value: `${board.community.solved} of ${board.community.finished} solved`, inline: true });
  return {
    color: board.won ? (feedbacks.length <= 2 ? COLOURS.gold : COLOURS.win) : COLOURS.loss,
    author: { name: `${who.name} · Realmdle #${board.puzzle} · ${score}`, icon_url: avatarUrl(who) },
    description: `<@${who.id}> ${headline}\n\n${grid(feedbacks)}`,
    fields,
    footer: { text: 'Play with /realmdle' },
    timestamp: new Date().toISOString(),
  };
}

/** Horizontal bars for the guess spread, in a code block so they line up. */
export function distributionBars(distribution: number[], highlight: number | null): string {
  const top = Math.max(1, ...distribution);
  return (
    '```\n' +
    distribution
      .map((n, i) => {
        const bar = '█'.repeat(Math.max(n ? 1 : 0, Math.round((n / top) * 14)));
        return `${i + 1} ${bar || '·'} ${n}${highlight === i + 1 ? '  ← today' : ''}`;
      })
      .join('\n') +
    '\n```'
  );
}

export type Today = { state: 'not_played' } | { state: 'playing'; guesses: number } | { state: 'won'; guesses: number } | { state: 'lost' };

export function statsEmbed(who: Who, stats: PlayerStats, today: Today, self: boolean): Embed {
  const todayText =
    today.state === 'won'
      ? `Solved today's puzzle in ${today.guesses}`
      : today.state === 'lost'
        ? "Missed today's card"
        : today.state === 'playing'
          ? `Playing today, ${today.guesses} of ${MAX_GUESSES} guesses used`
          : self
            ? "Not played today yet: `/realmdle play`"
            : 'Not played today yet';
  return {
    color: COLOURS.neutral,
    author: { name: `${who.name} · Realmdle stats`, icon_url: avatarUrl(who) },
    description: todayText,
    fields: [
      { name: 'Played', value: String(stats.played), inline: true },
      { name: 'Solved', value: `${stats.winRate}%`, inline: true },
      { name: 'Avg guesses', value: stats.averageGuesses === null ? 'None' : String(stats.averageGuesses), inline: true },
      { name: 'Current streak', value: stats.currentStreak ? `🔥 ${stats.currentStreak}` : '0', inline: true },
      { name: 'Best streak', value: String(stats.maxStreak), inline: true },
      { name: '​', value: '​', inline: true },
      { name: 'Guesses to solve', value: distributionBars(stats.distribution, today.state === 'won' ? today.guesses : null) },
    ],
    footer: { text: self ? 'Only you can see this' : 'Shared on the leaderboard by choice' },
  };
}

export type RankedRow = { id: string; name: string; currentStreak: number; maxStreak: number; winRate: number; played: number; averageGuesses: number | null };
export type LeaderboardSort = 'streak' | 'solved';
/** Solved % only ranks players with this many games, so one lucky day does not top it. */
export const MIN_GAMES_FOR_PERCENT = 5;

export function rank(rows: RankedRow[], sort: LeaderboardSort): RankedRow[] {
  const byName = (a: RankedRow, b: RankedRow) => a.name.localeCompare(b.name);
  return sort === 'streak'
    ? [...rows].sort((a, b) => b.currentStreak - a.currentStreak || b.maxStreak - a.maxStreak || b.winRate - a.winRate || byName(a, b))
    : rows
        .filter((r) => r.played >= MIN_GAMES_FOR_PERCENT)
        .sort((a, b) => b.winRate - a.winRate || (a.averageGuesses ?? 9) - (b.averageGuesses ?? 9) || b.played - a.played || byName(a, b));
}

/**
 * Top ten, each with streak and solved %, plus the viewer's own place if
 * they are further down. Names are mentions, which show each member's
 * server name without pinging them (see allowed_mentions where it is sent).
 */
export function leaderboardEmbed(ranked: RankedRow[], sort: LeaderboardSort, viewerId: string | null, puzzle: number): Embed {
  const line = (r: RankedRow, i: number) => {
    const place = MEDALS[i] ?? `\`${String(i + 1).padStart(2)}\``;
    const streak = r.currentStreak ? `🔥 **${r.currentStreak}**` : '🔥 0';
    const avg = r.averageGuesses === null ? '' : ` · ${r.averageGuesses} avg`;
    const you = r.id === viewerId ? '  ← you' : '';
    return sort === 'streak'
      ? `${place} <@${r.id}>  ${streak} · best ${r.maxStreak} · ${r.winRate}% solved${you}`
      : `${place} <@${r.id}>  **${r.winRate}%** solved · ${r.played} played${avg} · ${streak}${you}`;
  };
  const top = ranked.slice(0, 10).map(line);
  const mine = viewerId ? ranked.findIndex((r) => r.id === viewerId) : -1;
  if (mine >= 10) top.push('⋯', line(ranked[mine], mine));
  const empty =
    sort === 'solved'
      ? `Nobody has played ${MIN_GAMES_FOR_PERCENT} games on the leaderboard yet.`
      : 'Nobody has joined the leaderboard yet. Be the first: `/realmdle settings leaderboard:True`';
  return {
    color: COLOURS.gold,
    title: sort === 'streak' ? '🔥 Realmdle leaderboard · longest streaks' : `🎯 Realmdle leaderboard · solved % (${MIN_GAMES_FOR_PERCENT}+ games)`,
    description: top.length ? top.join('\n') : empty,
    footer: { text: `After puzzle #${puzzle} · opt in or out with /realmdle settings` },
  };
}

/** The midnight post: yesterday's reveal and numbers, and a button to play. */
export function announcementEmbed(puzzle: number, yesterday: { card: Card; finished: number; solved: number } | null): Embed {
  const recap = yesterday
    ? `Yesterday's card was **${yesterday.card.name}** (${yesterday.card.set}). ${yesterday.solved} of ${yesterday.finished} players solved it.`
    : 'The first Realmdle is here.';
  return {
    color: COLOURS.neutral,
    title: `Realmdle #${puzzle} is live`,
    description: `${recap}\n\nGuess today's Sorcery card in six tries. Your guesses are private; your result is posted here when you finish.`,
    thumbnail: yesterday?.card.image ? { url: yesterday.card.image } : undefined,
    footer: { text: 'Press Play or use /realmdle play' },
  };
}
