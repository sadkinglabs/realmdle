# Realmdle

Guess the Sorcery: Contested Realm card of the day in six tries, with the
`/realmdle` slash command in the Sorcery TCG Australia Discord. A
Cloudflare Worker at `realmdle.realmofoz.com` with a D1 database.

Every step of the game is private (Discord's ephemeral replies, visible
only to the player). The one public message is the player's result,
posted to #realmdle when they finish. The bot only answers in the
community's server, so the stats and leaderboard are that server's.

```
/realmdle play                      your board for today (also the Play button on the midnight post)
/realmdle guess card:<name>         autocomplete lists each set separately, e.g. "Pudge Butcher (Beta)"
/realmdle stats [player]            your stats; someone else's only if they joined the leaderboard
/realmdle leaderboard [sort]        top ten by current streak, or by solved % (5+ games), plus your place
/realmdle settings leaderboard:<>   join or leave the leaderboard
/realmdle forget-me confirm:True    delete your record and every game
```

## Rules

- **Clues:** element (match, or close if one element is shared), type,
  cost and power (close within one, with a higher/lower arrow), rarity
  and set (with a rarer/newer arrow). The sixth and last guess also shows
  the answer's subtypes (Monster, Mortal, Spirit...) as a hint.
- **One entry per card per set:** Apprentice Wizard in Alpha
  (`C000001-001`) and in Beta (`C000001-002`) are separate guesses and
  answers, with the same stats and a different set. Foils and other
  finishes in a set are the same entry. Tokens and promo printings are
  left out.
- **One possible answer:** a card can only be the answer if no other card
  shares all six of its clue values; otherwise a player could turn every
  clue green and still be wrong. About 620 of ~1,480 entries qualify.
  Avatars (no rarity) can be guessed but are never the answer.

## Choosing each day's answer

`extendSchedule` in `src/lib/engine.ts` picks each new day by these
rules, in order:

1. A new set's cards wait 14 days after release (`GRACE_DAYS`).
2. A card name is never the answer twice within 365 days, in any set
   (`NAME_GAP`); there are more eligible names than days, so this never
   has to bend.
3. The entry that has been the answer the fewest times goes next; a card
   that becomes eligible later joins level with those still waiting in
   the current round, so a new set gets a fair share of days.
4. Then the name that has waited longest, then a hash of the day mixed
   with the secret `PLAN_SALT`, so the public card data and this code
   cannot be used to work out answers.

The Worker keeps the `puzzles` table filled a week ahead (`LOCK_DAYS`),
replaying the history in the table; rows are never changed once written.
Puzzle #1 is 28 September 2026 in Sydney (`EPOCH` in `engine.ts`).

## How it fits together

```
src/index.ts          POST /interactions and the hourly cron
src/discord.ts        signature check, the commands, posting results and the midnight message
src/game.ts           planning, scoring guesses, stats and leaderboard queries
src/env.ts            the bindings and secrets, all optional until set up
src/lib/              rules and planner (engine), stats, embed designs (discord), card adapter
data/cards.json       the card pool, refreshed daily by .github/workflows/refresh-cards.yml
migrations/           D1 schema: puzzles, players, plays, announcements
scripts/              fetch-cards (card pool), discord-commands (register /realmdle), discord-smoke (rehearsal)
```

- **Trust:** Discord signs every interaction with the application's
  Ed25519 key; unsigned or altered requests get 401, so nobody can play as
  someone else by calling the endpoint directly. Commands from any server
  other than `DISCORD_GUILD_ID`, or from DMs, are refused.
- **Stats** (played, solved %, current and best streak, guess spread,
  average) are computed from `plays` by `src/lib/stats.ts`, never stored.
  A streak survives until a whole day is missed.
- **The public result** shows the player (a mention, which does not ping
  them), score, squares, streak, solved % and the day's solve count. It
  never names the card. The bot posts it to `DISCORD_CHANNEL_ID`.
- **The midnight post** goes to the same channel on the first hourly run
  of the Sydney day: yesterday's card and solve count, and a Play button.
  The `announcements` table makes it once per day.
- **Privacy:** the database holds the Discord id, display name, avatar
  hash and guesses, nothing else. The leaderboard is opt-in, and
  `/realmdle forget-me` deletes everything for that player.

### Card data

`data/cards.json` comes from the [Sorcery Card Registry](https://github.com/sadkinglabs/sorcery-registry),
served by KairosArchive at `api.kairosarchive.net/v3/registry.json`. The
daily refresh workflow fetches the 80-byte `registry.json.sha256` and only
downloads the 6 MB export when it changed, as the registry asks, sending a
`User-Agent` that names the project. On a change it runs the tests,
commits `cards.json` to `main` and starts a deploy. To seed from a local
clone of the registry:
`npx tsx scripts/fetch-cards.ts path/to/sorcery-registry/export/registry.json`.

## Setup

Once, by someone with the Cloudflare account that hosts realmofoz.com and
admin rights in the Discord server. Never commit or paste the bot token or
the salt anywhere; they only go into Cloudflare.

1. **Database.** In a clone of this repo: `npm ci`, `npx wrangler login`,
   then `npx wrangler d1 create realmdle`. Put the `database_id` it prints
   into `wrangler.jsonc` (replacing `PASTE-ID-HERE`).
2. **Discord application** at https://discord.com/developers/applications:
   New Application "Realmdle". From General Information, copy the
   **Application ID** and **Public Key**. Under Bot, turn **Public Bot**
   off and **Reset Token** (keep the token safe for step 5).
3. **Server and channel.** In Discord, User Settings, Advanced, Developer
   Mode on. Create #realmdle. Copy the server id and the channel id. Put
   the Public Key, server id and channel id into `vars` in `wrangler.jsonc`.
4. **Deploy.** Add repository secrets `CLOUDFLARE_ACCOUNT_ID` and
   `CLOUDFLARE_API_TOKEN` (a token with Account: Workers Scripts Edit, D1
   Edit; Zone realmofoz.com: Workers Routes Edit, DNS Edit). Push to
   `main`: CI tests, applies the migrations and deploys. Check that
   https://realmdle.realmofoz.com shows the one-line note.
5. **Secrets.** `openssl rand -base64 32`, then
   `npx wrangler secret put PLAN_SALT` (paste it; never change it once
   live) and `npx wrangler secret put DISCORD_BOT_TOKEN`.
6. **Connect Discord.** In the developer portal, General Information, set
   Interactions Endpoint URL to `https://realmdle.realmofoz.com/interactions`
   and save. Discord sends a signed ping; if it saves, everything is wired.
7. **Invite the bot.** OAuth2, URL Generator: scopes `bot` and
   `applications.commands`; permissions View Channels, Send Messages,
   Embed Links. Open the URL and pick the server. If #realmdle is private,
   give the bot's role access.
8. **Register the command:**
   ```sh
   read -s DISCORD_BOT_TOKEN && export DISCORD_BOT_TOKEN
   DISCORD_APPLICATION_ID=<application id> DISCORD_GUILD_ID=<server id> npm run register-commands
   ```
9. **Try it:** `/realmdle play` anywhere in the server. The first hourly
   run posts "Realmdle #N is live" in #realmdle.

For the daily card refresh to commit to `main`, set Settings, Actions,
General, Workflow permissions to **Read and write**.

## Local development

```sh
npm ci
node scripts/discord-smoke.mjs keys > .dev.vars   # test key pair, fake server and channel ids
npm run dev                                        # local D1 + Worker on :8787
npm run smoke                                      # 25 checks, with a stand-in Discord API on :8799
npm test && npm run typecheck
```

Card names, text and images are © Erik's Curiosa; card data from the
Sorcery Card Registry. Fan-made, not affiliated with Erik's Curiosa.
