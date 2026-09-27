/**
 * What the Worker is given by Cloudflare. Everything Realmdle needs is
 * optional: until the database and secrets exist, the bot answers "not set
 * up yet".
 */
export type RealmdleEnv = {
  DB?: D1Database;
  /** Mixed into the answer planner so answers cannot be worked out from the public code. */
  PLAN_SALT?: string;
  /** The Discord application's public key (hex), to verify that interactions really come from Discord. */
  DISCORD_PUBLIC_KEY?: string;
  /** Bot token: posts results and the midnight message to the Realmdle channel. */
  DISCORD_BOT_TOKEN?: string;
  /** The one server Realmdle runs in; commands from anywhere else are refused. */
  DISCORD_GUILD_ID?: string;
  /** The Realmdle channel in that server: results and the midnight message. */
  DISCORD_CHANNEL_ID?: string;
  /** Discord's API base; only overridden in local tests. */
  DISCORD_API?: string;
};

/** The database and salt the game needs. */
export const gameReady = (env: RealmdleEnv): env is RealmdleEnv & { DB: D1Database; PLAN_SALT: string } => Boolean(env.DB && env.PLAN_SALT);

/** The bot can post to the Realmdle channel. */
export const channelReady = (env: RealmdleEnv) => Boolean(env.DISCORD_BOT_TOKEN && env.DISCORD_CHANNEL_ID);

export const discordApi = (env: RealmdleEnv) => env.DISCORD_API ?? 'https://discord.com/api/v10';
