// Realmdle in Discord: the /realmdle slash command, its card autocomplete,
// the Play button, the public result and the midnight post.
//
// Discord sends every interaction to POST /interactions, signed
// with the application's Ed25519 key; anything that fails the signature
// check is refused, so nobody can play as someone else by calling the URL
// directly. Realmdle belongs to one server (DISCORD_GUILD_ID): commands
// from any other server, or from DMs, are refused, so the stats and the
// leaderboard are that server's. Every reply about the game is ephemeral
// (only the player sees it); the one public message is the result, posted
// to the Realmdle channel when they finish.
//
//   /realmdle play                     your board for today, with a Guess button
//   /realmdle guess card:<name>        autocomplete from the card pool
//
// The Guess button opens a form to type a name into; one match is guessed
// straight away, and a name in several sets (or a part of one) comes back
// as a menu to pick from. Both redraw the same private board.
//
//   /realmdle stats [player]           your stats, or a leaderboard player's
//   /realmdle leaderboard [sort]       longest streaks, or solved %
//   /realmdle settings leaderboard:<>  join or leave the leaderboard
//   /realmdle forget-me confirm:True   delete my player record and every play

import type { Board } from './lib/board';
import {
  GUESS_BUTTON,
  announcementEmbed,
  boardButtons,
  boardEmbed,
  leaderboardEmbed,
  rank,
  resultEmbed,
  statsEmbed,
  type Embed,
  type LeaderboardSort,
  type Today,
  type Who,
} from './lib/discord';
import { COMMANDS } from './lib/commands';
import { puzzleNumber, suggest } from './lib/engine';
import { playerStats } from './lib/stats';
import type { Card } from './lib/types';
import { channelReady, discordApi, type RealmdleEnv } from './env';
import {
  answerFor,
  board,
  cardsById,
  claimAnnouncement,
  dayCounts,
  deletePlayer,
  ensurePlanned,
  getPlayer,
  guess,
  guessedToday,
  leaderboardRows,
  releaseAnnouncement,
  setLeaderboard,
  upsertPlayer,
} from './game';

type Ready = RealmdleEnv & { DB: D1Database; PLAN_SALT: string; DISCORD_PUBLIC_KEY: string; DISCORD_GUILD_ID: string };

const EPHEMERAL = 64;
const PLAY_BUTTON = 'realmdle:play';
// the Guess button opens GUESS_FORM; a name in several sets comes back as a PICK_MENU
const GUESS_FORM = 'realmdle:guess-form';
const PICK_MENU = 'realmdle:pick';
const allCards = [...cardsById.values()];

// ---- signature ----

const hex = (text: string) => new Uint8Array((text.match(/../g) ?? []).map((b) => parseInt(b, 16)));

/** Discord signs `timestamp + body` with the application's Ed25519 key. */
async function verified(request: Request, body: string, publicKey: string): Promise<boolean> {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  if (!signature || !timestamp) return false;
  try {
    const key = await crypto.subtle.importKey('raw', hex(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, hex(signature), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

// ---- replies ----

type Option = { name: string; type: number; value?: string | number | boolean; focused?: boolean; options?: Option[] };
type DiscordUser = { id: string; username: string; global_name?: string | null; avatar?: string | null };
type Interaction = {
  type: number;
  id: string;
  application_id: string;
  token: string;
  guild_id?: string;
  member?: { nick?: string | null; user: DiscordUser };
  user?: DiscordUser;
  data?: {
    name?: string;
    custom_id?: string;
    options?: Option[];
    resolved?: { users?: Record<string, DiscordUser> };
    /** A select menu's choice. */
    values?: string[];
    /** A submitted form's fields, as rows of text inputs (or labels around one). */
    components?: { components?: { custom_id: string; value?: string }[]; component?: { custom_id: string; value?: string } }[];
  };
};

const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
// mentions show a member's name without notifying them
const quiet = { allowed_mentions: { parse: [] } };
const privately = (embeds: Embed[], content?: string, components: unknown[] = []) => reply({ type: 4, data: { flags: EPHEMERAL, embeds, content, components, ...quiet } });
/** Redraws the private message the button or menu was on, so a game stays one message. */
const redraw = (embeds: Embed[], content = '', components: unknown[] = []) => reply({ type: 7, data: { embeds, content, components, ...quiet } });
const notice = (text: string) => reply({ type: 4, data: { flags: EPHEMERAL, content: text } });

function whoIs(interaction: Interaction): Who & { user: DiscordUser } {
  const user = interaction.member?.user ?? interaction.user!;
  return { id: user.id, name: interaction.member?.nick || user.global_name || user.username, avatar: user.avatar ?? null, user };
}

const todayOf = (b: Board): Today =>
  b.over ? (b.won ? { state: 'won', guesses: b.guesses.length } : { state: 'lost' }) : b.guesses.length ? { state: 'playing', guesses: b.guesses.length } : { state: 'not_played' };

/**
 * The public result. The bot posts it in the Realmdle channel, wherever in
 * the server the player was; without a channel set, it falls back to the
 * channel they played in, through the interaction's own webhook.
 */
async function postResult(env: Ready, interaction: Interaction, b: Board, who: Who) {
  const body = JSON.stringify({ embeds: [resultEmbed(b, who)], ...quiet });
  const res = channelReady(env)
    ? await fetch(`${discordApi(env)}/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
        body,
      })
    : await fetch(`${discordApi(env)}/webhooks/${interaction.application_id}/${interaction.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  if (!res.ok) console.error('result post failed', res.status, await res.text());
}

/** The midnight post, once per puzzle, with yesterday's reveal and a Play button. */
export async function announce(env: RealmdleEnv & { DB: D1Database }, today: number) {
  if (!channelReady(env) || !(await claimAnnouncement(env.DB, today))) return;
  const card = today > 1 ? await answerFor(env.DB, today - 1) : null;
  const yesterday = card ? { card, ...(await dayCounts(env.DB, today - 1)) } : null;
  const res = await fetch(`${discordApi(env)}/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    body: JSON.stringify({
      embeds: [announcementEmbed(today, yesterday)],
      components: [
        {
          type: 1,
          components: [{ type: 2, style: 1, label: 'Play', custom_id: PLAY_BUTTON }],
        },
      ],
    }),
  });
  // let the next hourly run try again
  if (!res.ok) {
    console.error('announcement failed', res.status, await res.text());
    await releaseAnnouncement(env.DB, today);
  }
}

/**
 * Registers /realmdle on the server when src/lib/commands.ts has changed
 * since the last registration, so a deploy is all it takes. Safe to call
 * often: it compares a hash first and only writes on a change.
 */
export async function syncCommands(env: RealmdleEnv) {
  if (!env.DB || !env.DISCORD_BOT_TOKEN || !env.DISCORD_APPLICATION_ID || !env.DISCORD_GUILD_ID) return;
  const body = JSON.stringify(COMMANDS);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.DISCORD_APPLICATION_ID}:${env.DISCORD_GUILD_ID}:${body}`));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const current = await env.DB.prepare("SELECT value FROM meta WHERE key = 'commands'").first<{ value: string }>();
  if (current?.value === hash) return;
  const res = await fetch(`${discordApi(env)}/applications/${env.DISCORD_APPLICATION_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    body,
  });
  if (!res.ok) return console.error('registering /realmdle failed', res.status, await res.text());
  await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('commands', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1").bind(hash).run();
}

// ---- the command ----

function subcommand(interaction: Interaction): { name: string; options: Option[] } {
  const sub = interaction.data?.options?.[0];
  return sub ? { name: sub.name, options: sub.options ?? [] } : { name: 'play', options: [] };
}

const option = (options: Option[], name: string) => options.find((o) => o.name === name)?.value;

/** Accepts the autocomplete choice (a card id) or, if the player typed and hit enter, an exact name. */
function resolveCard(value: string): { id: string } | { error: string } {
  if (cardsById.has(value)) return { id: value };
  const named = allCards.filter((c) => c.name.toLowerCase() === value.trim().toLowerCase());
  if (named.length === 1) return { id: named[0].id };
  if (named.length > 1) return { error: `**${named[0].name}** is in ${named.map((c) => c.set).join(' and ')}. Pick one from the list as you type.` };
  return { error: `No card called **${value}**. Start typing and pick from the list.` };
}

const loose = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Cards a typed name could mean: the exact name (in each set), or else the names containing it. */
function matchesFor(typed: string, exclude: Set<string>): Card[] {
  const q = loose(typed);
  const exact = allCards.filter((c) => !exclude.has(c.id) && loose(c.name) === q);
  return exact.length ? exact : suggest(allCards, typed, exclude, 25);
}

/** The text the player typed into the Guess form. */
function formValue(interaction: Interaction, field: string): string {
  const inputs = (interaction.data?.components ?? []).flatMap((row) => row.components ?? (row.component ? [row.component] : []));
  return inputs.find((c) => c.custom_id === field)?.value ?? '';
}

function guessForm(puzzle: number) {
  const input = { type: 4, custom_id: 'card', style: 1, label: 'Card name', placeholder: 'e.g. Pendulum of Peril', required: true, min_length: 2, max_length: 100 };
  return reply({ type: 9, data: { custom_id: `${GUESS_FORM}:${puzzle}`, title: `Realmdle #${puzzle}`, components: [{ type: 1, components: [input] }] } });
}

function pickMenu(puzzle: number, cards: Card[]) {
  const options = cards.map((c) => ({ label: `${c.name} (${c.set})`.slice(0, 100), value: c.id, description: `${c.type}${c.cost === null ? '' : ` · ${c.cost} mana`}` }));
  return { type: 1, components: [{ type: 3, custom_id: `${PICK_MENU}:${puzzle}`, placeholder: 'Which card?', options }] };
}

type Respond = (embeds: Embed[], content?: string, components?: unknown[]) => Response;

/** Records a guess and shows the board, posting the result publicly if that finished the game. */
async function play(env: Ready, ctx: ExecutionContext, interaction: Interaction, who: Who, today: number, answer: Card, cardId: string, respond: Respond) {
  const result = await guess(env.DB, who.id, today, answer, cardId);
  const b = await board(env.DB, today, answer, who.id);
  if (!result.ok) return respond([boardEmbed(b, cardsById)], result.error, boardButtons(b));
  if (!b.over) return respond([boardEmbed(b, cardsById)], undefined, boardButtons(b));
  // the one public step: the finished result, after the private reply
  ctx.waitUntil(postResult(env, interaction, b, who));
  const where = channelReady(env) ? ` in <#${env.DISCORD_CHANNEL_ID}>` : '';
  return respond([boardEmbed(b, cardsById)], `Your result has been posted${where}.`);
}

async function handle(env: Ready, ctx: ExecutionContext, interaction: Interaction): Promise<Response> {
  const today = puzzleNumber(new Date());
  await ensurePlanned(env.DB, env.PLAN_SALT, today);
  const answer = await answerFor(env.DB, today);
  if (!answer) return notice('Today’s puzzle is missing. Please try again shortly.');
  const who = whoIs(interaction);

  // card autocomplete, as the player types
  if (interaction.type === 4) {
    const focused = subcommand(interaction).options.find((o) => o.focused);
    const exclude = await guessedToday(env.DB, who.id, today);
    const choices = suggest(allCards, String(focused?.value ?? ''), exclude, 25).map((c) => ({ name: `${c.name} (${c.set})`.slice(0, 100), value: c.id }));
    return reply({ type: 8, data: { choices } });
  }

  await upsertPlayer(env.DB, who.id, who.name, who.avatar);
  const custom = interaction.data?.custom_id ?? '';

  // the Guess button, its form and the menu of matches, all on the player's private board
  const [, step, day] = custom.split(':');
  if (custom.startsWith(`${GUESS_BUTTON}:`) || custom.startsWith(`${GUESS_FORM}:`) || custom.startsWith(`${PICK_MENU}:`)) {
    if (Number(day) !== today) {
      const b = await board(env.DB, today, answer, who.id);
      return redraw([boardEmbed(b, cardsById)], 'A new day has started. This is today’s Realmdle.', boardButtons(b));
    }
    if (step === 'guess') return guessForm(today);
    if (step === 'pick') return play(env, ctx, interaction, who, today, answer, interaction.data?.values?.[0] ?? '', redraw);
    const typed = formValue(interaction, 'card');
    const matches = matchesFor(typed, await guessedToday(env.DB, who.id, today));
    if (matches.length === 1) return play(env, ctx, interaction, who, today, answer, matches[0].id, redraw);
    const b = await board(env.DB, today, answer, who.id);
    if (!matches.length) return redraw([boardEmbed(b, cardsById)], `No card matches **${typed.trim()}**. Press Guess to try again.`, boardButtons(b));
    return redraw([boardEmbed(b, cardsById)], `Which card did you mean by **${typed.trim()}**?`, [pickMenu(today, matches), ...boardButtons(b)]);
  }

  const { name, options } = interaction.type === 3 && custom === PLAY_BUTTON ? { name: 'play', options: [] } : subcommand(interaction);

  if (name === 'play') {
    const b = await board(env.DB, today, answer, who.id);
    return privately([boardEmbed(b, cardsById)], b.over ? 'You have finished today’s Realmdle. A new card arrives at midnight, Sydney time.' : undefined, boardButtons(b));
  }

  if (name === 'guess') {
    const picked = resolveCard(String(option(options, 'card') ?? ''));
    if ('error' in picked) return notice(picked.error);
    return play(env, ctx, interaction, who, today, answer, picked.id, privately);
  }

  if (name === 'stats') {
    const targetId = String(option(options, 'player') ?? who.id);
    const self = targetId === who.id;
    const target = await getPlayer(env.DB, targetId);
    if (!self && (!target || !target.leaderboard)) return notice('That player keeps their Realmdle stats private.');
    if (!target) return notice('No games yet. Start with `/realmdle play`.');
    const b = await board(env.DB, today, answer, targetId);
    const resolved = interaction.data?.resolved?.users?.[targetId];
    const person: Who = self ? who : { id: targetId, name: target.display_name, avatar: resolved?.avatar ?? target.avatar };
    const stats = b.stats ?? playerStats([], today);
    // a player's unfinished game is theirs alone
    const shown = self ? todayOf(b) : b.over ? todayOf(b) : { state: 'not_played' as const };
    return privately([statsEmbed(person, stats, shown, self)]);
  }

  if (name === 'leaderboard') {
    const sort = (option(options, 'sort') === 'solved' ? 'solved' : 'streak') as LeaderboardSort;
    const ranked = rank(await leaderboardRows(env.DB, today), sort);
    const me = await getPlayer(env.DB, who.id);
    const tip = me?.leaderboard ? undefined : 'You are not on the leaderboard. Join with `/realmdle settings leaderboard:True`.';
    return privately([leaderboardEmbed(ranked, sort, who.id, today)], tip);
  }

  if (name === 'settings') {
    const on = option(options, 'leaderboard');
    if (typeof on !== 'boolean') return notice('Choose `leaderboard:True` to join the leaderboard or `False` to leave it.');
    await setLeaderboard(env.DB, who.id, on);
    return notice(on ? 'You are on the leaderboard. Your streak and solved % are now visible to the server.' : 'You have left the leaderboard. Your stats are private again.');
  }

  if (name === 'forget-me') {
    if (option(options, 'confirm') !== true) return notice('Nothing was deleted. Use `/realmdle forget-me confirm:True` to delete your Realmdle stats and every game you have played.');
    await deletePlayer(env.DB, who.id);
    return notice('Done. Your Realmdle stats and games are deleted. Playing again starts a fresh record.');
  }

  return notice('Unknown command.');
}

export async function handleInteraction(request: Request, env: RealmdleEnv, ctx: ExecutionContext): Promise<Response> {
  if (!env.DISCORD_PUBLIC_KEY) return new Response('Discord is not set up', { status: 503 });
  const body = await request.text();
  if (!(await verified(request, body, env.DISCORD_PUBLIC_KEY))) return new Response('Bad signature', { status: 401 });
  const interaction = JSON.parse(body) as Interaction;
  if (interaction.type === 1) return reply({ type: 1 }); // Discord's ping when the URL is saved
  if (!env.DB || !env.PLAN_SALT || !env.DISCORD_GUILD_ID) return notice('Realmdle is not set up yet.');
  // one server's game: nowhere else, not in DMs
  if (interaction.guild_id !== env.DISCORD_GUILD_ID) return notice('Realmdle is played in the Sorcery TCG Australia Discord server.');
  return handle(env as Ready, ctx, interaction);
}

