// How Realmdle looks in Discord: the private board, the public result, the
// stats card and the leaderboard, as Discord embed objects. Pure functions
// of game data, so the Worker only fetches and sends, and the tests can
// check the designs without Discord.
//
// Emoji are Discord's native way to show colour, so the designs use them.

import type { Board } from './board';
import { COLUMNS, MAX_GUESSES, allMatch, formatElements, puzzleStart, type Clue, type Column, type Feedback } from './engine';
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

export const COLOURS = { win: 0x5f8f55, loss: 0x8a6f5a, neutral: 0xe07a2c, gold: 0xc9a24f, warning: 0xc8423b } as const;
const SQUARE = { correct: '🟩', partial: '🟨', wrong: '⬛' } as const;
const SHORT_SET: Record<string, string> = { 'Arthurian Legends': 'Arthurian' };
const MEDALS = ['🥇', '🥈', '🥉'];

/** What each clue is called on the board, in Sorcery's own words. */
export const LABELS: Record<Column, string> = { elements: 'Threshold', type: 'Type', cost: 'Mana', power: 'Power', rarity: 'Rarity', set: 'Set' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const shortSet = (set: string) => SHORT_SET[set] ?? set;

/** A puzzle's Sydney date (YYYY-MM-DD) as "Monday 28 September 2026". */
export function longDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
}

function cell(card: Card, column: Column, clue: Clue): string {
  const raw = column === 'elements' ? formatElements(card.elements) : column === 'set' ? shortSet(card.set) : (card[column] ?? 'None');
  return `${SQUARE[clue.verdict]} ${LABELS[column]} **${raw}**${clue.direction === 'up' ? '▲' : clue.direction === 'down' ? '▼' : ''}`;
}

/** One guess: the card, then its six labelled clues on two lines of three. */
export function guessLines(card: Card, feedback: Feedback): string {
  const cells = COLUMNS.map((c) => cell(card, c, feedback[c]));
  return `**${card.name}** · ${card.set}\n${cells.slice(0, 3).join(' · ')}\n${cells.slice(3).join(' · ')}`;
}

/** A cheer for the finish, by how many guesses it took; index 0 is a loss. */
const CHEERS = [
  '💀 The card won this time.',
  '🤯 Got it in one! Pure sorcery.',
  '🔥 Scary good!',
  '✨ Brilliant!',
  '🎉 Nicely done!',
  '👏 Solid!',
  '😅 Phew, just in time!',
];
export const cheer = (won: boolean, guesses: number) => CHEERS[won ? guesses : 0];

/** How to play, on the welcome board and the midnight post. */
export const HOW_TO =
  'Guess the Sorcery card of the day in 6 tries.\n' +
  'Type **/guess** and pick a card from the list as you type.\n\n' +
  `Each guess compares **${COLUMNS.map((c) => LABELS[c]).join(' · ')}**\n` +
  '🟩 exact  🟨 close  ⬛ miss\n' +
  '🟨 close: an element in common, or one away on mana, power, rarity or set\n' +
  '▲▼ on mana only: the answer costs more or less\n' +
  '💡 Your last guess comes with a hint.';

/** The spoiler-free grid: squares only. */
export function grid(feedbacks: Feedback[]): string {
  return feedbacks.map((f) => COLUMNS.map((c) => SQUARE[f[c].verdict]).join('')).join('\n');
}

/** A Discord timestamp that counts down in each viewer's own time, e.g. "in 7 hours". */
const countdown = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

/** The player's own board, shown privately after every step. */
export function boardEmbed(board: Board, cards: Map<string, Card>): Embed {
  const rows = board.guesses.flatMap(({ id, feedback }) => {
    const card = cards.get(id);
    return card ? [{ card, feedback }] : [];
  });
  const answer = board.answer ? cards.get(board.answer) : undefined;
  const lines = rows.map((r) => guessLines(r.card, r.feedback)).join('\n\n');

  if (board.over && answer) {
    const streak = board.stats?.currentStreak ? `🔥 Streak **${board.stats.currentStreak}** · ` : '';
    return {
      color: board.won ? (rows.length <= 2 ? COLOURS.gold : COLOURS.win) : COLOURS.loss,
      title: board.won ? `${rows.length <= 2 ? '🏆' : '🎉'} Solved in ${rows.length}: ${answer.name}` : `Out of guesses. It was ${answer.name}`,
      description:
        `**${cheer(board.won, rows.length)}**\n` +
        `${answer.type}${answer.subtypes.length ? `, ${answer.subtypes.join(' ')}` : ''} · ${answer.set}\n\n` +
        `${streak}⏳ Next card ${countdown(puzzleStart(board.puzzle + 1))}\n\n${lines}`,
      image: answer.image ? { url: answer.image } : undefined,
      footer: { text: `Realmdle #${board.puzzle} · your result is posted for the server` },
    };
  }

  if (!rows.length) {
    return {
      color: COLOURS.neutral,
      title: `Welcome to Realmdle #${board.puzzle} - ${longDate(board.date)}`,
      description: HOW_TO,
      footer: { text: 'Only you can see your guesses' },
    };
  }

  const fields: Embed['fields'] = [];
  const twin = rows.find((r) => allMatch(r.feedback));
  if (twin)
    fields.push({
      name: '🪞 A perfect look-alike!',
      value: `Every square on **${twin.card.name}** is green, but it isn’t the answer: another card shares all six clues. Your last-guess hint tells them apart.`,
    });
  if (board.hint) {
    const { subtypes, typeline } = board.hint;
    const kind = subtypes.join(' ');
    const lines = [typeline ? `💡 *“${typeline}”*` : '', kind ? `🏷️ The card is ${/^[AEIOU]/.test(kind) ? 'an' : 'a'} **${kind}**.` : typeline ? '' : '💡 The card has no subtype.'];
    fields.push({ name: '⚠️ Last guess! Here is a hint ⚠️', value: lines.filter(Boolean).join('\n') });
  }
  const left = MAX_GUESSES - rows.length;
  return {
    color: board.hint ? COLOURS.warning : COLOURS.neutral,
    title: `Realmdle #${board.puzzle} · ${left === 1 ? '⚠️ last guess' : `${left} guesses left`}`,
    description: lines,
    fields,
    footer: { text: 'Only you can see this · /guess for your next card' },
  };
}

export type Who = { id: string; name: string; avatar: string | null };

export const avatarUrl = (who: Who) =>
  who.avatar ? `https://cdn.discordapp.com/avatars/${who.id}/${who.avatar}.png?size=128` : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(who.id) >> 22n) % 6}.png`;

/** The Play button, on the midnight post and every public result: one tap from seeing a result to playing. */
export const PLAY_BUTTON = 'realmdle:play';
export const playButton = (puzzle: number) => [
  { type: 1, components: [{ type: 2, style: 1, label: `Play Realmdle #${puzzle}`, emoji: { name: '🔮' }, custom_id: PLAY_BUTTON }] },
];

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;

/** How a solve ranks among the day's solvers: 🥇 First, 🥈 2nd, 🥉 3rd, then 4th and on. */
function place(n: number): string {
  return n === 1 ? '🥇 First to solve today' : `${MEDALS[n - 1] ?? '🏅'} ${ordinal(n)} to solve today`;
}

/**
 * The public result, posted once a player finishes. It never names the
 * card: the squares, the score and a cheer, then the player's streak, their
 * place among today's solvers and how the server is doing. Laid out as
 * lines rather than fields, which Discord stacks one per row on phones.
 */
export function resultEmbed(board: Board, who: Who): Embed {
  const feedbacks = board.guesses.map((g) => g.feedback);
  const { finished, solved } = board.community;
  const headline = board.won
    ? `<@${who.id}> solved **Realmdle #${board.puzzle}** in **${feedbacks.length}/${MAX_GUESSES}**`
    : `<@${who.id}> ran out of guesses on **Realmdle #${board.puzzle}**`;
  const standing = [board.stats?.currentStreak ? `🔥 **${board.stats.currentStreak}**-day streak` : '', board.won ? place(solved) : ''].filter(Boolean).join(' · ');
  const day = `👥 **${finished}** ${finished === 1 ? 'player' : 'players'} today · **${solved}** solved`;
  return {
    color: board.won ? (feedbacks.length <= 2 ? COLOURS.gold : COLOURS.win) : COLOURS.loss,
    author: { name: `${who.name} · Realmdle #${board.puzzle} · ${board.won ? feedbacks.length : 'X'}/${MAX_GUESSES}`, icon_url: avatarUrl(who) },
    description: `${headline}\n*${cheer(board.won, feedbacks.length)}*\n\n${grid(feedbacks)}\n\n${standing ? `${standing}\n` : ''}${day}`,
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
    footer: { text: self ? 'Only you can see this' : 'On the server leaderboard' },
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
      : 'Nobody has finished a Realmdle yet. Be the first: `/realmdle play`';
  return {
    color: COLOURS.gold,
    title: sort === 'streak' ? '🔥 Realmdle leaderboard · longest streaks' : `🎯 Realmdle leaderboard · solved % (${MIN_GAMES_FOR_PERCENT}+ games)`,
    description: top.length ? top.join('\n') : empty,
    footer: { text: `After puzzle #${puzzle} · leave or rejoin with /realmdle settings` },
  };
}

/**
 * The midnight post: yesterday's reveal, how to play, and the top ten so
 * far (players on the leaderboard, ranked by streak), above a Play button.
 */
export type Yesterday = { card: Card; finished: number; solved: number; winner: { id: string; guesses: number } | null };

export function announcementEmbed(puzzle: number, yesterday: Yesterday | null, ranked: RankedRow[] = []): Embed {
  const winner = yesterday?.winner
    ? `\n👑 Yesterday's winner: <@${yesterday.winner.id}>, solved in **${yesterday.winner.guesses}**${yesterday.solved > 1 ? ', fewest guesses and first to do it' : ''}`
    : '';
  const recap = yesterday
    ? `Yesterday's card was **${yesterday.card.name}** (${yesterday.card.set}).\n👥 **${yesterday.finished}** played · **${yesterday.solved}** solved${winner}`
    : 'The first Realmdle is here!';
  const top = ranked.slice(0, 10).map((r, i) => `${MEDALS[i] ?? `\`${String(i + 1).padStart(2)}\``} <@${r.id}>  🔥 **${r.currentStreak}** · ${r.winRate}% · ${r.played} played`);
  return {
    color: COLOURS.neutral,
    title: `🔮 Realmdle #${puzzle} is live`,
    description: `${recap}\n\n${HOW_TO}`,
    thumbnail: yesterday?.card.image ? { url: yesterday.card.image } : undefined,
    fields: top.length ? [{ name: '🏆 Top 10 · streak · solved · played', value: top.join('\n') }] : undefined,
    footer: { text: 'New card every midnight, Sydney time · play daily to climb the top 10' },
  };
}

export type WeekDay = { puzzle: number; card: Card; finished: number; solved: number; average: number | null };
export type WeekReview = { from: number; to: number; players: number; days: WeekDay[]; perfect: string[] };

const percent = (solved: number, finished: number) => Math.round((solved / finished) * 100);

/** The day fewest players solved (then the one that took most guesses), and the day most did. */
export function hardestAndEasiest(days: WeekDay[]): { hardest: WeekDay | null; easiest: WeekDay | null } {
  const played = days.filter((d) => d.finished > 0);
  const rate = (d: WeekDay) => d.solved / d.finished;
  const guesses = (d: WeekDay) => d.average ?? 7;
  const byHardest = [...played].sort((a, b) => rate(a) - rate(b) || guesses(b) - guesses(a) || b.finished - a.finished);
  const hardest = byHardest[0] ?? null;
  const easiest = byHardest.length > 1 ? byHardest[byHardest.length - 1] : null;
  return { hardest, easiest: easiest && rate(easiest) > rate(hardest!) ? easiest : null };
}

/**
 * The Monday recap of the week just finished: its totals, each day's card
 * (all revealed by now), the hardest and easiest card, the longest streaks
 * and anyone who solved all seven. Lines rather than fields, for phones.
 */
export function recapEmbed(week: WeekReview, ranked: RankedRow[]): Embed {
  const games = week.days.reduce((n, d) => n + d.finished, 0);
  const solves = week.days.reduce((n, d) => n + d.solved, 0);
  const { hardest, easiest } = hardestAndEasiest(week.days);
  const dayLine = (d: WeekDay) =>
    `\`#${d.puzzle}\` **${d.card.name}** · ${shortSet(d.card.set)} · ${d.finished ? `${d.solved}/${d.finished} solved` : 'nobody played'}`;
  const streaks = ranked.filter((r) => r.currentStreak > 0).slice(0, 5);
  const parts = [
    `👥 **${week.players}** ${week.players === 1 ? 'player' : 'players'} · **${games}** games · **${games ? percent(solves, games) : 0}%** solved`,
    `**The week's cards**\n${week.days.map(dayLine).join('\n')}`,
    [
      hardest ? `💀 **Hardest:** ${hardest.card.name} (${hardest.card.set}), ${hardest.solved} of ${hardest.finished} solved` : '',
      easiest ? `🍰 **Easiest:** ${easiest.card.name} (${easiest.card.set}), ${percent(easiest.solved, easiest.finished)}% solved${easiest.average ? `, ${easiest.average} guesses on average` : ''}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    streaks.length ? `🔥 **Longest streaks**\n${streaks.map((r, i) => `${MEDALS[i] ?? '🏅'} <@${r.id}> **${r.currentStreak}** days`).join('\n')}` : '',
    week.perfect.length ? `🎯 **Perfect week**, all ${week.to - week.from + 1} solved: ${week.perfect.map((id) => `<@${id}>`).join(' ')}` : '',
  ];
  return {
    color: COLOURS.gold,
    title: `📅 Realmdle week in review · #${week.from}–#${week.to}`,
    description: parts.filter(Boolean).join('\n\n'),
    thumbnail: hardest?.card.image ? { url: hardest.card.image } : undefined,
    footer: { text: 'A new week starts now · every streak begins with one card' },
  };
}
