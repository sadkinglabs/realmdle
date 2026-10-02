// End-to-end check of Realmdle's Discord side against the local Worker,
// with a stand-in for Discord's API that records what the bot posts.
//
//   node scripts/discord-smoke.mjs keys   # prints .dev.vars lines (a test key pair)
//   npm run dev                            # with those lines in .dev.vars
//   node scripts/discord-smoke.mjs         # signs interactions like Discord does
//
// Checks: signatures, the one-server lock, private boards, autocomplete,
// /guess and matching cards by name in any set,
// the hint, the public result in the Realmdle channel (never naming the
// card), stats privacy, the leaderboard, the Play button, deleting your
// data and the once-a-day midnight post.

import { execSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

if (process.argv[2] === 'keys') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex');
  console.log(`DISCORD_PUBLIC_KEY=${pub}\nDISCORD_TEST_PRIVATE_KEY=${priv}\nPLAN_SALT=local-test-salt\nDISCORD_BOT_TOKEN=test-token\nDISCORD_APPLICATION_ID=app1\nDISCORD_GUILD_ID=777\nDISCORD_CHANNEL_ID=555\nDISCORD_API=http://127.0.0.1:8799`);
  process.exit(0);
}

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8787';
const vars = Object.fromEntries(
  readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const key = createPrivateKey({ key: Buffer.from(vars.DISCORD_TEST_PRIVATE_KEY, 'hex'), format: 'der', type: 'pkcs8' });
const cards = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url), 'utf8')).cards;

// ---- a stand-in for discord.com/api that records posts ----
const posts = [];
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    posts.push({ method: req.method, path: req.url, auth: req.headers.authorization ?? null, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"1"}');
  });
});
await new Promise((r) => mock.listen(8799, '127.0.0.1', r));
const channelPosts = () => posts.filter((p) => p.path.startsWith('/channels/'));
const waitForPost = async (n) => {
  for (let i = 0; i < 50 && channelPosts().length < n; i++) await new Promise((r) => setTimeout(r, 100));
  return channelPosts()[n - 1];
};
/** The edit that replaces "Realmdle is thinking…" for the interaction with this token. */
const waitForEdit = async (token) => {
  const path = `/webhooks/app1/${token}/messages/@original`;
  for (let i = 0; i < 100 && !posts.some((p) => p.path === path); i++) await new Promise((r) => setTimeout(r, 50));
  return posts.find((p) => p.path === path);
};

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
  if (!ok) failures++;
};

const run = Date.now().toString().slice(-6);
const user = (n, name) => ({ id: `8${run}${String(n).padStart(11, '0')}`, username: name.toLowerCase(), global_name: name, avatar: null });
let seq = 0;
async function interact(body, { signed = true, guild = '777' } = {}) {
  const text = JSON.stringify({ id: String(++seq), application_id: 'app1', token: `tok${seq}`, guild_id: guild, ...body });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signed ? sign(null, Buffer.from(timestamp + text), key).toString('hex') : '00'.repeat(64);
  const res = await fetch(`${BASE}/interactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp }, body: text });
  const reply = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (reply?.type !== 5) return { status: res.status, body: reply };
  // acknowledged at once; the real reply arrives as an edit of it
  const edit = await waitForEdit(`tok${seq}`);
  return { status: res.status, deferred: reply, edit, body: { type: 4, data: { flags: reply.data?.flags, ...edit?.body } } };
}
const command = (u, sub, options = [], resolved) => interact({ type: 2, member: { user: u }, data: { name: 'realmdle', options: [{ type: 1, name: sub, options }], resolved } });
const guess = (u, card) => command(u, 'guess', [{ type: 3, name: 'card', value: card }]);

const eve = user(1, 'Eve');
const finn = user(2, 'Finn');

// ---- today's answer, read from the local database ----
const opening = await command(eve, 'play');
const today = Number(opening.body.data.embeds[0].title.match(/#(\d+)/)[1]);
const sql = `SELECT card_id FROM puzzles WHERE puzzle = ${today}`;
const ANSWER = JSON.parse(execSync(`npx wrangler d1 execute realmdle --local --env dev --json --command "${sql}"`, { stdio: ['ignore', 'pipe', 'ignore'] }))[0].results[0].card_id;
const answer = cards.find((c) => c.id === ANSWER);
const wrong = cards.filter((c) => c.name !== answer.name && !cards.some((o) => o.name === c.name && o.id !== c.id)).slice(0, 6);

let r = await interact({ type: 1 }, { signed: false });
check('refuses an unsigned request', r.status === 401);
r = await interact({ type: 1 });
check('answers Discord’s ping', r.body.type === 1);

r = opening;
check('commands are acknowledged at once, privately, then answered by editing that reply', r.deferred?.type === 5 && r.deferred.data.flags === 64 && r.edit?.method === 'PATCH' && !('flags' in r.edit.body));
check('play: a private welcome board that says how to play', r.body.data.flags === 64 && r.body.data.embeds[0].title.startsWith(`Welcome to Realmdle #${today} - `) && r.body.data.embeds[0].description.includes('/guess'));
r = await interact({ type: 2, member: { user: eve }, data: { name: 'realmdle', options: [{ type: 1, name: 'play' }] } }, { guild: '999' });
check('refuses to play in any other server', r.body.data.content.includes('Sorcery TCG Australia'));
r = await interact({ type: 2, user: eve, data: { name: 'realmdle', options: [{ type: 1, name: 'play' }] } }, { guild: null }); // a DM has no server
check('refuses to play in DMs', r.body.data.content.includes('Sorcery TCG Australia'));

// /guess, the short command: autocomplete lists each name once, whatever its sets
const quick = (u, card, focused) => interact({ type: focused ? 4 : 2, member: { user: u }, data: { name: 'guess', options: [{ type: 3, name: 'card', value: card, focused }] } });
r = await quick(eve, 'apprentice wiz', true);
const names = r.body.data.choices.map((c) => c.name);
check('autocomplete lists a card in two sets once, by name', r.body.type === 8 && names.filter((n) => n === 'Apprentice Wizard').length === 1 && !names.some((n) => n.includes('(')), names.join(', '));

// a name printed in several sets is guessed by name alone (never today's answer here); any card if none is
const reprint = cards.find((c) => c.name !== answer.name && cards.some((o) => o.name === c.name && o.set !== c.set)) ?? wrong[0];
r = await quick(eve, reprint.name.toLowerCase());
check('a card is guessed by its name, in any case, with no set to pick', r.body.data.flags === 64 && r.body.data.embeds[0].title === `Realmdle #${today} · 5 guesses left` && r.body.data.embeds[0].description.includes(`**${reprint.name}**`), reprint.name);
r = await quick(eve, reprint.name);
check('guessing the same name again is refused, in any set', r.body.data.content.includes('already guessed'));
r = await quick(eve, 'zzzz no such card');
check('a name that fits no card says so', r.body.data.content.includes('No card called'));

for (let i = 1; i < 5; i++) r = await guess(eve, wrong[i].name);
const board5 = JSON.stringify(r.body.data);
check('five wrong guesses: private board with the hint, no answer', r.body.data.flags === 64 && board5.includes('Last guess! Here is a hint') && r.body.data.embeds[0].title.includes('last guess') && !board5.includes(answer.name));

r = await quick(eve, wrong[1].name, true);
check('autocomplete leaves out cards already guessed', !r.body.data.choices.some((c) => c.name === wrong[1].name));

r = await guess(eve, answer.name);
check('solving it, by name: the private board reveals the card and points to the channel', r.body.data.flags === 64 && r.body.data.embeds[0].title === `🎉 Solved in 6: ${answer.name}` && r.body.data.content.includes('<#555>'));
const result = await waitForPost(1);
const resultText = JSON.stringify(result?.body);
check('then the bot posts the result publicly in the Realmdle channel', result?.path === '/channels/555/messages' && result.auth === 'Bot test-token' && result.body.flags === undefined && result.body.embeds[0].author.name === `Eve · Realmdle #${today} · 6/6` && result.body.components[0].components[0].custom_id === 'realmdle:play');
check('the public result never names the card', !resultText.includes(answer.name) && !resultText.includes(answer.image ?? 'no-image'));
check('the result names the player as text, no mention, pinging nobody', resultText.includes('**Eve** solved') && !resultText.includes('<@') && result.body.allowed_mentions.parse.length === 0);

r = await guess(eve, wrong[5].id);
check('no guesses after finishing', r.body.data.content.includes('already finished'));

r = await command(eve, 'stats');
check('stats: private, with streak and solved %', r.body.data.flags === 64 && r.body.data.embeds[0].fields[1].value === '100%' && r.body.data.embeds[0].description.includes('Solved today'));

const eveStats = () => command(finn, 'stats', [{ type: 6, name: 'player', value: eve.id }], { users: { [eve.id]: eve } });
r = await eveStats();
check('players are on the leaderboard by default, so others can see their stats', r.body.data.embeds?.[0].author.name === 'Eve · Realmdle stats');
r = await command(eve, 'settings', [{ type: 5, name: 'leaderboard', value: false }]);
const hidden = await eveStats();
check('leaving the leaderboard makes them private', r.body.data.content.includes('left the leaderboard') && hidden.body.data.content.includes('private'));
r = await command(eve, 'settings', [{ type: 5, name: 'leaderboard', value: true }]);
check('rejoining the leaderboard', r.body.data.content.includes('You are on the leaderboard') && (await eveStats()).body.data.embeds?.[0].author.name === 'Eve · Realmdle stats');

r = await command(finn, 'leaderboard');
check('leaderboard by streak lists Eve, and Finn needs no tip to join', r.body.data.embeds[0].description.includes("**Eve**") && !r.body.data.content);
r = await command(finn, 'leaderboard', [{ type: 3, name: 'sort', value: 'solved' }]);
check('leaderboard by solved % needs 5 games', r.body.data.embeds[0].title.includes('solved %') && !r.body.data.embeds[0].description.includes(eve.id));

r = await interact({ type: 3, member: { user: finn }, data: { custom_id: 'realmdle:play' } });
check('the Play button opens Finn’s private board', r.body.data.flags === 64 && r.body.data.embeds[0].title.startsWith('Welcome to Realmdle'));

r = await guess(finn, ANSWER);
const finnPost = await waitForPost(2);
check('Finn solves it first try: his result goes to the channel too', finnPost?.body.embeds[0].author.name === `Finn · Realmdle #${today} · 1/6`);

r = await command(finn, 'forget-me', [{ type: 5, name: 'confirm', value: false }]);
check('forget-me does nothing without confirm:True', r.body.data.content.includes('Nothing was deleted'));
r = await command(finn, 'forget-me', [{ type: 5, name: 'confirm', value: true }]);
const finnStats = await command(finn, 'stats');
check('forget-me deletes the record: stats start again from nothing', r.body.data.content.includes('deleted') && finnStats.body.data.embeds[0].fields[0].value === '0');

// a look-alike of today's answer (every clue the same) brings the hint early, if the answer has one
const clues = (c) => JSON.stringify([c.elements, c.type, c.cost, c.power, c.rarity, c.set]);
const lookAlike = cards.find((c) => c.name !== answer.name && clues(c) === clues(answer));
if (lookAlike) {
  r = await quick(user(3, 'Gus'), lookAlike.name);
  const names = r.body.data.embeds[0].fields?.map((f) => f.name) ?? [];
  check('a look-alike of the answer says so and gives the hint early', names.includes('🪞 A perfect look-alike!') && names.includes('💡 Your hint'), lookAlike.name);
} else console.log(`SKIP  look-alike check: ${answer.name} has none`);

// the midnight post: once, however often the hourly job runs
await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=0+*+*+*+*`);
await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=0+*+*+*+*`);
await new Promise((res) => setTimeout(res, 1500));
const announcements = posts.filter((p) => p.body.embeds?.[0].title?.includes('is live'));
check('the midnight post goes out once, with how to play and a Play button', announcements.length === 1 && announcements[0].body.embeds[0].description.includes('/guess') && announcements[0].body.components[0].components[0].custom_id === 'realmdle:play', `${announcements.length} posted`);
// Eve and Finn only played today: the top 10 counts finished days, so early solves give nobody a head start
check('its top 10 leaves out today’s puzzle, though the live leaderboard counts it', announcements[0]?.body.embeds[0].fields === undefined);

// the bot registers /realmdle itself, once per change of definition
await fetch(`${BASE}/`);
await fetch(`${BASE}/`);
await new Promise((res) => setTimeout(res, 1500));
const registrations = posts.filter((p) => p.path === '/applications/app1/guilds/777/commands');
check('opening the address registers /guess and /realmdle once, not on every visit', registrations.length === 1 && registrations[0].body.map((c) => c.name).join() === 'guess,realmdle' && registrations[0].auth === 'Bot test-token', `${registrations.length} registration(s)`);

mock.close();
console.log(failures ? `\n${failures} failed` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;
