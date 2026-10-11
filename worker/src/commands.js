// Keeps Discord's copy of /watch in step with COMMANDS, so a new option needs
// a deploy and nothing else — no bot token pasted into a terminal. A hash of
// what was last registered sits in KV; registering only happens when it
// differs. Checked on every interaction (one KV read) and every hourly cron.

import { COMMANDS, discordFetch } from './discord.js';

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function syncCommands(env, fetchImpl = fetch) {
  if (!env.DISCORD_BOT_TOKEN || !env.SUBS) return { skipped: 'not configured' };
  const body = JSON.stringify(COMMANDS);
  const hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
  if (await env.SUBS.get('meta:commands') === hash) return { unchanged: true };
  // The application id comes from the token itself unless it's configured.
  let app = env.DISCORD_APP_ID;
  if (!app) {
    const r = await discordFetch(env, '/oauth2/applications/@me', {}, fetchImpl);
    if (!r.ok) return { ok: false, step: 'application', status: r.status };
    app = (await r.json()).id;
  }
  const r = await discordFetch(env, `/applications/${app}/commands`, { method: 'PUT', body }, fetchImpl);
  if (r.ok) await env.SUBS.put('meta:commands', hash);
  return { ok: r.ok, status: r.status };
}
