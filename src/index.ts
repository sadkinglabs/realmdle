// Realmdle, the daily Sorcery card game in the Sorcery TCG Australia
// Discord, as a Cloudflare Worker at realmdle.realmofoz.com.
//
//   POST /interactions   the /realmdle slash command (see discord.ts)
//   GET  /               a one-line note; also registers /realmdle if its definition changed
//
// and an hourly cron plans the week ahead and posts the midnight message
// (and, on Mondays, the recap of the week before).

import { puzzleNumber } from './lib/engine';
import { announce, handleInteraction, recap, syncCommands } from './discord';
import { gameReady, type RealmdleEnv } from './env';
import { ensurePlanned } from './game';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/interactions' && request.method === 'POST') {
      try {
        return await handleInteraction(request, env, ctx);
      } catch (err) {
        console.error(err);
        return new Response('Something went wrong', { status: 500 });
      }
    }
    if (url.pathname === '/' && request.method === 'GET') {
      // opening the address after a deploy registers the command straight away
      ctx.waitUntil(syncCommands(env).catch((err) => console.error(err)));
      return new Response('Realmdle: the daily Sorcery card game, played with /realmdle in the Sorcery TCG Australia Discord.\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return new Response('Not found', { status: 404 });
  },

  // Hourly, on the hour (see triggers in wrangler.jsonc): plan today and the
  // week ahead, so a player never waits on the planner, and post the day's
  // message on the midnight run in Sydney (retried hourly if Discord refuses it).
  async scheduled(event, env, ctx) {
    if (!gameReady(env)) return;
    // runs on the hour: the midnight run's scheduled time is exactly midnight in Sydney, so it
    // always counts as the new day (and the post goes out before anyone's result)
    const today = puzzleNumber(new Date(Math.max(Date.now(), event.scheduledTime)));
    // on Mondays the week's recap goes first, so the day's post (with its Play button) is the latest
    ctx.waitUntil(
      ensurePlanned(env.DB, env.PLAN_SALT, today)
        .then(() => recap(env, today))
        .catch((err) => console.error('weekly recap', err))
        .then(() => announce(env, today)),
    );
    ctx.waitUntil(syncCommands(env));
  },
} satisfies ExportedHandler<RealmdleEnv>;
