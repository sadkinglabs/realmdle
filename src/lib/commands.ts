// The /guess and /realmdle slash commands as Discord registers them. The Worker keeps
// Discord in step with this (syncCommands in src/discord.ts): whenever the
// definition changes, the next visit to the Worker's address or the next
// hourly run re-registers it on the server.

const SUB = 1;
const STRING = 3;
const BOOLEAN = 5;
const USER = 6;

const CARD = { type: STRING, name: 'card', description: 'Start typing a card name', required: true, autocomplete: true };

export const COMMANDS = [
  // the quick way in: `/gu`, pick the command, type a few letters, pick the card
  { name: 'guess', description: 'Guess today’s Realmdle card', contexts: [0], options: [CARD] },
  {
    name: 'realmdle',
    description: 'Guess the Sorcery card of the day',
    // in the server only, not in DMs
    contexts: [0],
    options: [
      { type: SUB, name: 'play', description: 'Show your board for today (only you can see it)' },
      {
        type: SUB,
        name: 'guess',
        description: 'Guess a card (or just use /guess)',
        options: [CARD],
      },
      {
        type: SUB,
        name: 'stats',
        description: 'Your streak, solved % and guess spread',
        options: [{ type: USER, name: 'player', description: 'Someone else on the leaderboard' }],
      },
      {
        type: SUB,
        name: 'leaderboard',
        description: 'Longest streaks, or best solved %',
        options: [
          {
            type: STRING,
            name: 'sort',
            description: 'What to rank by',
            choices: [
              { name: 'Current streak', value: 'streak' },
              { name: 'Solved % (5+ games)', value: 'solved' },
            ],
          },
        ],
      },
      {
        type: SUB,
        name: 'settings',
        description: 'Join or leave the leaderboard',
        options: [{ type: BOOLEAN, name: 'leaderboard', description: 'Show your streak and solved % to the server', required: true }],
      },
      {
        type: SUB,
        name: 'forget-me',
        description: 'Delete your Realmdle stats and every game you have played',
        options: [{ type: BOOLEAN, name: 'confirm', description: 'True to delete, which cannot be undone', required: true }],
      },
    ],
  },
];
