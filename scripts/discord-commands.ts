// Registers /realmdle by hand. Rarely needed: the Worker registers it
// itself whenever the definition in src/lib/commands.ts changes.
//
//   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... npm run register-commands

import { COMMANDS } from '../src/lib/commands';

const { DISCORD_APPLICATION_ID: app, DISCORD_BOT_TOKEN: token, DISCORD_GUILD_ID: guild } = process.env;
if (!app || !token || !guild) {
  console.error('Set DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN and DISCORD_GUILD_ID.');
  process.exit(1);
}

const res = await fetch(`https://discord.com/api/v10/applications/${app}/guilds/${guild}/commands`, {
  method: 'PUT',
  headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(COMMANDS),
});
if (!res.ok) {
  console.error(res.status, await res.text());
  process.exit(1);
}
console.log(`Registered /realmdle on server ${guild}.`);
