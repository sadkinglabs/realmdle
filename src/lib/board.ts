// A player's view of one puzzle, as the Worker builds it for the Discord
// embeds (src/lib/discord.ts).

import type { Feedback } from './engine';
import type { PlayerStats } from './stats';

export type Board = {
  puzzle: number;
  /** YYYY-MM-DD in Sydney. */
  date: string;
  /** Null for someone who has never played. */
  player: { name: string; leaderboard: boolean } | null;
  guesses: { id: string; feedback: Feedback }[];
  over: boolean;
  won: boolean;
  /** The answer's subtypes, once the last guess is reached. */
  hint: string[] | null;
  /** The answer's card id, only once the puzzle is over. */
  answer: string | null;
  stats: PlayerStats | null;
  /** Everyone who has finished today's puzzle, anonymously. */
  community: { finished: number; solved: number };
};
