// Realmdle in Discord: the /guess and /realmdle slash commands, card
// autocomplete, the Play button, the public result and the midnight post.
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
//   /guess card:<name>                 the quick way to guess, with autocomplete
//   /realmdle play                     your board for today (also the Play buttons)
//   /realmdle guess card:<name>        the same as /guess
//   /realmdle stats [player]           your stats, or a leaderboard player's
//   /realmdle leaderboard [sort]       longest streaks, or solved %
//   /realmdle settings leaderboard:<>  leave or rejoin the leaderboard (players are on it by default)
//   /realmdle forget-me confirm:True   delete my player record and every play

import type { Board } from './lib/board';
import {
  PLAY_BUTTON,
  announcementEmbed,
  boardEmbed,
  leaderboardEmbed,
  playButton,
  rank,
  recapEmbed,
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
import { channelReady, discordApi, type RealmdleEnv } from './env';
import {
  answerFor,
  board,
  cardsById,
  claimAnnouncement,
  claimOnce,
  dayCounts,
  dayWinner,
  deletePlayer,
  ensurePlanned,
  getPlayer,
  guess,
  guessableCards,
  guessedEntries,
  guessedToday,
  leaderboardRows,
  pickCard,
  releaseAnnouncement,
  releaseOnce,
  setLeaderboard,
  upsertPlayer,
  weekInReview,
} from './game';

type Ready = RealmdleEnv & { DB: D1Database; PLAN_SALT: string; DISCORD_PUBLIC_KEY: string; DISCORD_GUILD_ID: string };

const EPHEMERAL = 64;

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
  data?: { name?: string; custom_id?: string; options?: Option[]; resolved?: { users?: Record<string, DiscordUser> } };
};

const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
// mentions show a member's name without notifying them
const quiet = { allowed_mentions: { parse: [] } };
const privately = (embeds: Embed[], content?: string) => reply({ type: 4, data: { flags: EPHEMERAL, embeds, content, ...quiet } });
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
  const body = JSON.stringify({ embeds: [resultEmbed(b, who)], components: playButton(b.puzzle), ...quiet });
  const res = channelReady(env)
    ? await fetch(`${discordApi(env)}/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
        body,
      })
    : await fetch(`${discordApi(env)}/webhooks/${interaction.application_id}/${interaction.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  if (!res.ok) console.error('result post failed', res.status, await res.text());
}

/** The midnight post, once per puzzle: yesterday's reveal and winner, how to play, the top ten and a Play button. */
export async function announce(env: RealmdleEnv & { DB: D1Database }, today: number) {
  if (!channelReady(env) || !(await claimAnnouncement(env.DB, today))) return;
  const card = today > 1 ? await answerFor(env.DB, today - 1) : null;
  const yesterday = card ? { card, ...(await dayCounts(env.DB, today - 1)), winner: await dayWinner(env.DB, today - 1) } : null;
  const ranked = rank(await leaderboardRows(env.DB, today), 'streak');
  const res = await fetch(`${discordApi(env)}/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    body: JSON.stringify({ embeds: [announcementEmbed(today, yesterday, ranked)], components: playButton(today), ...quiet }),
  });
  // let the next hourly run try again
  if (!res.ok) {
    console.error('announcement failed', res.status, await res.text());
    await releaseAnnouncement(env.DB, today);
  }
}

/** Puzzles run Monday to Sunday: #1 was a Monday, so a week is #1–#7, #8–#14 and so on. */
export const WEEK = 7;

/**
 * The Monday recap of the week just finished, once per week, posted just
 * before that day's "is live" post so the Play button stays the latest.
 * Skipped for a week nobody played.
 */
export async function recap(env: RealmdleEnv & { DB: D1Database }, today: number) {
  if (!channelReady(env) || today <= WEEK || (today - 1) % WEEK !== 0) return;
  const from = today - WEEK;
  const key = `recap:${from}`;
  if (!(await claimOnce(env.DB, key))) return;
  const week = await weekInReview(env.DB, from, today - 1);
  if (!week.players) return;
  const ranked = rank(await leaderboardRows(env.DB, today), 'streak');
  const res = await fetch(`${discordApi(env)}/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    body: JSON.stringify({ embeds: [recapEmbed(week, ranked)], ...quiet }),
  });
  // let the next hourly run try again
  if (!res.ok) {
    console.error('weekly recap failed', res.status, await res.text());
    await releaseOnce(env.DB, key);
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

// ---- the commands ----

/** Which command was used and its options: `/guess card:…` is the same as `/realmdle guess card:…`. */
function subcommand(interaction: Interaction): { name: string; options: Option[] } {
  if (interaction.data?.name === 'guess') return { name: 'guess', options: interaction.data.options ?? [] };
  const sub = interaction.data?.options?.[0];
  return sub ? { name: sub.name, options: sub.options ?? [] } : { name: 'play', options: [] };
}

const option = (options: Option[], name: string) => options.find((o) => o.name === name)?.value;

async function handle(env: Ready, ctx: ExecutionContext, interaction: Interaction): Promise<Response> {
  const today = puzzleNumber(new Date());
  await ensurePlanned(env.DB, env.PLAN_SALT, today);
  const answer = await answerFor(env.DB, today);
  if (!answer) return notice('Today’s puzzle is missing. Please try again shortly.');
  const who = whoIs(interaction);

  // card autocomplete, as the player types: one entry per name, leaving out names already guessed
  if (interaction.type === 4) {
    const focused = subcommand(interaction).options.find((o) => o.focused);
    const exclude = guessedEntries(await guessedToday(env.DB, who.id, today));
    const choices = suggest(guessableCards, String(focused?.value ?? ''), exclude, 25).map((c) => ({ name: c.name.slice(0, 100), value: c.name.slice(0, 100) }));
    return reply({ type: 8, data: { choices } });
  }

  await upsertPlayer(env.DB, who.id, who.name, who.avatar);
  const { name, options } = interaction.type === 3 && interaction.data?.custom_id === PLAY_BUTTON ? { name: 'play', options: [] } : subcommand(interaction);

  if (name === 'play') {
    const b = await board(env.DB, today, answer, who.id);
    return privately([boardEmbed(b, cardsById)]);
  }

  if (name === 'guess') {
    const picked = pickCard(String(option(options, 'card') ?? ''), answer, guessedEntries(await guessedToday(env.DB, who.id, today)));
    if ('error' in picked) return notice(picked.error);
    const result = await guess(env.DB, who.id, today, answer, picked.card.id);
    const b = await board(env.DB, today, answer, who.id);
    if (!result.ok) return privately([boardEmbed(b, cardsById)], result.error);
    if (!b.over) return privately([boardEmbed(b, cardsById)]);
    // the one public step: the finished result, after the private reply
    ctx.waitUntil(postResult(env, interaction, b, who));
    const where = channelReady(env) ? ` in <#${env.DISCORD_CHANNEL_ID}>` : '';
    return privately([boardEmbed(b, cardsById)], `Your result has been posted${where}.`);
  }

  if (name === 'stats') {
    const targetId = String(option(options, 'player') ?? who.id);
    const self = targetId === who.id;
    const target = await getPlayer(env.DB, targetId);
    if (!self && (!target || !target.leaderboard)) return notice('That player has left the leaderboard, so their Realmdle stats are private.');
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
    const tip = me?.leaderboard ? undefined : 'You have left the leaderboard. Rejoin with `/realmdle settings leaderboard:True`.';
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

  return notice('That is not a Realmdle command. Try `/realmdle play`, `/realmdle guess`, `/realmdle stats` or `/realmdle leaderboard`.');
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
  try {
    return await handle(env as Ready, ctx, interaction);
  } catch (err) {
    // an answer Discord can show, rather than "the application did not respond"; the error goes to Workers Logs
    console.error('interaction failed', interaction.type, JSON.stringify(interaction.data ?? {}), err);
    if (interaction.type === 4) return reply({ type: 8, data: { choices: [] } });
    return notice('Something went wrong on Realmdle’s side. Please try again in a moment.');
  }
}

