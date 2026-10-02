# Realmdle

Guess the Sorcery: Contested Realm card of the day in six tries, with the
`/guess` and `/realmdle` slash commands in the Sorcery TCG Australia Discord. A
Cloudflare Worker at `realmdle.realmofoz.com` with a D1 database.

Every step of the game is private (Discord's ephemeral replies, visible
only to the player). The one public message is the player's result,
posted to #realmdle when they finish. The bot only answers in the
community's server, so the stats and leaderboard are that server's.

```
/guess card:<name>                  the quick way to guess: autocomplete lists each card name once
/realmdle play                      see your board: today's guesses and results, any time (also the Play buttons)
/realmdle guess card:<name>         the same as /guess
/realmdle stats [player]            your stats, or anyone's still on the leaderboard
/realmdle leaderboard [sort]        top ten by current streak, or by solved % (5+ games), plus your place; ties go to fewer average guesses
/realmdle settings leaderboard:<>   leave (False) or rejoin (True) the leaderboard; players are on it by default
/realmdle forget-me confirm:True    delete your record and every game
```

Guessing is kept to one command, because only slash commands get
Discord's autocomplete: `/gu`, pick `/guess`, type a few letters, pick
the card. A typed name also works without picking, even a partial one if
it fits only one card, ignoring case and punctuation.

## Rules

- **Clues:** 🟩 exact, 🟨 close, ⬛ miss. Threshold is close with an
  element in common; mana, power, rarity and set are close when one away,
  either side; type is right or wrong. Only mana has an arrow (▲ the
  answer costs more, ▼ less), on any miss. The sixth and last guess also shows
  a hint: the answer's printed typeline with its rarity, type and subtype
  words blanked ("A ___ at creation’s core" for Kingdom of Agartha), and
  its subtypes (Monster, Mortal, Spirit...) if it has any.
- **Guess by name, answers by set:** a card reprinted in a later set is
  its own possible answer there, but players guess by name. Guessing the
  answer's name wins whatever set it is from; any other name in several
  sets is scored as its first printing. Foils and other finishes are the
  same entry. Tokens and promo printings are left out.
- **Alpha is Beta:** Beta reprinted Alpha card for card, so a card in both
  is only its Beta entry (Apprentice Wizard is `C000001-002`). The six
  cards only printed in Alpha keep theirs: Erik's Curiosa and Winter River
  (possible answers) and the four elemental Avatars.
- **Look-alikes can be the answer:** any card with a rarity can (1,054 of
  1,087; avatars can be guessed but never are). Several cards can share
  all six clues, such as seven Ordinary Air Magics costing 2 in Beta, so
  a guess can turn every square green and still be wrong. The board says
  so ("A perfect look-alike!") and gives the hint straight away rather
  than on the last guess: the answer's own typeline tells them apart.

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
data/cards.json       the card pool, refreshed weekly by .github/workflows/refresh-cards.yml
migrations/           D1 schema: puzzles, players, plays, announcements
scripts/              fetch-cards (card pool), discord-commands (register /realmdle by hand), discord-smoke (rehearsal)
```

- **Trust:** Discord signs every interaction with the application's
  Ed25519 key; unsigned or altered requests get 401, so nobody can play as
  someone else by calling the endpoint directly. Commands from any server
  other than `DISCORD_GUILD_ID`, or from DMs, are refused.
- **Replies never get lost:** Discord gives a command 3 seconds to answer,
  and the database is in Western Europe while Discord calls from the US.
  So every command except autocomplete is acknowledged at once
  ("Realmdle is thinking…") and answered by editing that reply, which
  Discord allows for 15 minutes; a guess can no longer count without its
  reply arriving. Smart Placement (`wrangler.jsonc`) runs the Worker near
  the database to keep it quick.
- **Stats** (played, solved %, current and best streak, guess spread,
  average) are computed from `plays` by `src/lib/stats.ts`, never stored.
  A streak survives until a whole day is missed.
- **Names, never mentions:** posts name players by their display name in
  bold. Discord only shows a mention inside an embed as a name when the
  viewer's app has that member loaded, so mentions often showed as raw
  ids; names always read, and the bot never pings anyone.
- **The public result** shows the player, score, a cheer, the squares, their streak, their place among the
  day's solvers and how many played and solved, with a Play button so
  anyone reading it is one tap from their own board. It never names the
  card. The bot posts it to `DISCORD_CHANNEL_ID`.
- **The finished board** (private) reveals the card and art, the streak and
  a live countdown to the next card.
- **The midnight post** goes to the same channel at midnight Sydney time
  (the hourly job runs on the hour): yesterday's card and numbers,
  yesterday's winner (solved in the fewest guesses, and of those the first
  to finish, among players on the leaderboard), how to play, the top ten
  on the leaderboard (streak, solved %, average guesses, games played) and
  a Play button. The top ten, like the weekly recap's streaks, counts
  finished days only, so a player who solves the new card straight after
  midnight is not a day ahead of everyone else; `/realmdle leaderboard`
  stays live. The `announcements` table makes it once per day.
- **The weekly recap** goes out on Mondays, just before that day's post:
  the week just finished (Monday to Sunday; #1 was a Monday) with its
  totals, every day's card and how many solved it, the hardest and
  easiest card, the five longest streaks and anyone who solved all
  seven. A `recap:<first puzzle>` row in `meta` makes it once per week;
  a week nobody played is skipped.
- **Privacy:** the database holds the Discord id, display name, avatar
  hash and guesses, nothing else. Playing puts you on the server
  leaderboard; `/realmdle settings leaderboard:False` takes you off, and
  `/realmdle forget-me` deletes everything for that player.

### Card data

`data/cards.json` comes from the [Sorcery Card Registry](https://github.com/sadkinglabs/sorcery-registry),
served by KairosArchive at `api.kairosarchive.net/v3/registry.json`. The
weekly refresh workflow (Mondays, Sydney time) fetches the 80-byte `registry.json.sha256` and only
downloads the 6 MB export when it changed, as the registry asks, sending a
`User-Agent` that names the project and a contact email. On a change it runs the tests,
commits `cards.json` to `main` and starts a deploy. To seed from a local
clone of the registry:
`npx tsx scripts/fetch-cards.ts path/to/sorcery-registry/export/registry.json`.

## Setup

Once, by someone with the Cloudflare account that hosts realmofoz.com and
admin rights in the Discord server. Everything can be done from a phone
(browser plus Termux); no clone of this repo is needed. Never commit or
paste the bot token anywhere; it only goes into Cloudflare.

1. **Cloudflare API token** (My Profile, API Tokens, Create Custom Token):
   Account: Workers Scripts Edit, D1 Edit; Zone realmofoz.com: Workers
   Routes Edit, DNS Edit. Also note the Account ID.
2. **Database:** `npx wrangler d1 create realmdle` with that token in
   `CLOUDFLARE_API_TOKEN`, or Storage & Databases, D1, Create in the
   dashboard. Put the id into `wrangler.jsonc` (replacing `PASTE-ID-HERE`).
3. **Discord application** at https://discord.com/developers/applications:
   New Application "Realmdle". Under Bot, turn Public Bot off and Reset
   Token (keep it for step 6). With Developer Mode on, create #realmdle and
   copy the server and channel ids. Put the Application ID, Public Key,
   server id and channel id into `vars` in `wrangler.jsonc`.
4. **GitHub secrets** (Settings, Secrets and variables, Actions):
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Also Settings,
   Actions, General, Workflow permissions: Read and write, so the weekly
   card refresh can commit.
5. **Deploy:** push to `main` (or re-run the Deploy workflow). CI tests,
   applies the migrations and deploys to `realmdle.realmofoz.com`.
6. **Worker secrets:** `PLAN_SALT` (a long random string, never changed
   once live) and `DISCORD_BOT_TOKEN`, with `npx wrangler secret put ...
   --name realmdle` or in the dashboard (Workers, realmdle, Settings,
   Variables and Secrets, type Secret).
7. **Connect Discord:** Interactions Endpoint URL
   `https://realmdle.realmofoz.com/interactions` in the developer portal.
   Discord sends a signed ping when you save; if it saves, it is wired.
8. **Invite the bot:**
   `https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=19456`
   (View Channels, Send Messages, Embed Links). If #realmdle is private,
   give the bot's role access.
9. **Register the command:** open https://realmdle.realmofoz.com. The
   Worker registers `/realmdle` on the server whenever its definition
   (`src/lib/commands.ts`) has changed, and checks hourly too. Then
   `/realmdle play` in the server.

## Local development

```sh
npm ci
node scripts/discord-smoke.mjs keys > .dev.vars   # test key pair, fake server and channel ids
npm run dev                                        # local D1 + Worker on :8787
npm run smoke                                      # 31 checks (one only when the answer has a look-alike), with a stand-in Discord API on :8799
npm test && npm run typecheck
```

Card names, text and images are © Erik's Curiosa; card data from the
Sorcery Card Registry. Fan-made, not affiliated with Erik's Curiosa.
