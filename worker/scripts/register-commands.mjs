// Registers /watch with Discord. Run once, and again whenever COMMANDS changes:
//   DISCORD_APP_ID=… DISCORD_BOT_TOKEN=… npm run register-commands
// Global commands can take a few minutes to appear in clients.
import { COMMANDS } from '../src/discord.js';

const { DISCORD_APP_ID: app, DISCORD_BOT_TOKEN: token } = process.env;
if (!app || !token) {
  console.error('Set DISCORD_APP_ID and DISCORD_BOT_TOKEN (from the Discord developer portal).');
  process.exit(1);
}
const res = await fetch(`https://discord.com/api/v10/applications/${app}/commands`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(COMMANDS),
});
const text = await res.text();
console.log(res.ok ? `registered: ${JSON.parse(text).map(c => '/' + c.name).join(', ')}` : `failed: HTTP ${res.status} ${text}`);
process.exit(res.ok ? 0 : 1);
