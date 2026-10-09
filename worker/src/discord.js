// Discord: slash commands in, DMs out. Plain REST — no gateway connection,
// so it fits a Worker that only wakes for a request or the hourly cron.
//
// What is stored, in KV under sub:<discord user id>: the city, queue days and
// the date they were given, max rent, areas, whether to send every new
// listing, the DM channel id, and the ids already told about. Nothing else —
// no username, no messages. /watch stop deletes it; six months without a
// command deletes it too (see notify.js).

import { stockholmToday, runningDays } from './match.js';

const API = 'https://discord.com/api/v10';
export const CITIES = { stockholm: 'Stockholm', goteborg: 'Göteborg', lund: 'Lund' };
const EPHEMERAL = 64;

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// Discord signs every interaction; one that fails the check must get a 401,
// and Discord tests that on purpose before it accepts the endpoint URL.
export async function verifySignature(publicKeyHex, signatureHex, timestamp, body) {
  if (!publicKeyHex || !signatureHex || !timestamp) return false;
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, hexToBytes(signatureHex),
      new TextEncoder().encode(timestamp + body));
  } catch (e) {
    return false;
  }
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json' },
});
const reply = (content) => json({ type: 4, data: { content, flags: EPHEMERAL } });

export async function discordFetch(env, path, init = {}, fetchImpl = fetch) {
  const res = await fetchImpl(API + path, {
    ...init,
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json',
               'User-Agent': 'DiscordBot (https://xn--nstet-gra.se, 1.0)', ...(init.headers || {}) },
  });
  return res;
}

// The DM channel id is stable per user, so it's opened once and kept.
export async function sendDm(env, sub, userId, payload, fetchImpl = fetch) {
  let channel = sub.dm;
  if (!channel) {
    const r = await discordFetch(env, '/users/@me/channels', { method: 'POST', body: JSON.stringify({ recipient_id: userId }) }, fetchImpl);
    if (!r.ok) return { ok: false, status: r.status };
    channel = (await r.json()).id;
  }
  const r = await discordFetch(env, `/channels/${channel}/messages`, { method: 'POST', body: JSON.stringify(payload) }, fetchImpl);
  return { ok: r.ok, status: r.status, channel };
}

function options(interaction) {
  const sub = (interaction.data.options || [])[0] || {};
  const out = { name: sub.name };
  for (const o of sub.options || []) out[o.name] = o.value;
  return out;
}

function describe(sub, today) {
  const bits = [`**${CITIES[sub.city] || sub.city}**`];
  const d = runningDays(sub, today);
  if (d != null) bits.push(`${d} queue days today (counting a day per day)`);
  if (sub.rent != null) bits.push(`max ${sub.rent} kr`);
  bits.push(sub.areas && sub.areas.length ? `areas: ${sub.areas.join(', ')}` : 'any area');
  if (sub.all_new) bits.push('plus every new listing within those limits');
  return bits.join(' · ');
}

export async function handleInteraction(request, env) {
  const body = await request.text();
  const ok = await verifySignature(env.DISCORD_PUBLIC_KEY, request.headers.get('X-Signature-Ed25519'),
                                   request.headers.get('X-Signature-Timestamp'), body);
  if (!ok) return new Response('bad signature', { status: 401 });
  const interaction = JSON.parse(body);
  if (interaction.type === 1) return json({ type: 1 });            // PING
  if (interaction.type !== 2 || interaction.data.name !== 'watch') return reply('Unknown command.');
  if (!env.SUBS) return reply('The bot is not fully set up yet (no storage). Try again later.');

  const userId = (interaction.member && interaction.member.user && interaction.member.user.id)
    || (interaction.user && interaction.user.id);
  if (!userId) return reply('Could not tell who you are.');
  const key = `sub:${userId}`;
  const today = stockholmToday();
  const o = options(interaction);
  const existing = await env.SUBS.get(key, 'json');

  if (o.name === 'stop') {
    await env.SUBS.delete(key);
    return reply(existing ? 'Stopped. Everything stored about your watch has been deleted.' : 'You had no watch running.');
  }
  if (o.name === 'show') {
    if (!existing) return reply('No watch running. Start one with `/watch set`.');
    await env.SUBS.put(key, JSON.stringify({ ...existing, last_active: new Date().toISOString() }));
    return reply(`Watching: ${describe(existing, today)}.\nStop any time with \`/watch stop\`.`);
  }
  if (o.name === 'set') {
    const city = CITIES[o.city] ? o.city : 'stockholm';
    const areas = String(o.areas || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
    const days = Number.isInteger(o.days) && o.days >= 0 && o.days <= 20000 ? o.days : null;
    const rent = Number.isInteger(o.max_rent) && o.max_rent > 0 && o.max_rent <= 50000 ? o.max_rent : null;
    if (days == null && !o.all_new) {
      return reply('Give your queue days (`days`), or set `all_new: True` to hear about every new listing within your limits.');
    }
    const sub = {
      city, days, from: today, rent, areas, all_new: !!o.all_new,
      dm: existing && existing.dm, created: (existing && existing.created) || new Date().toISOString(),
      last_active: new Date().toISOString(),
      // Kept across an update so changing the rent cap doesn't re-send old news.
      notified: (existing && existing.city === city && existing.notified) || [],
      outbid: [], closing: [],
    };
    // Proves DMs can reach them before they rely on it.
    const dm = await sendDm(env, sub, userId, { content: `Watch on — ${describe(sub, today)}. I'll message you here when something matches.` });
    if (dm.ok) sub.dm = dm.channel;
    await env.SUBS.put(key, JSON.stringify(sub));
    return reply(dm.ok
      ? `Watch on: ${describe(sub, today)}. Check your DMs — that's where matches arrive.`
      : `Watch saved: ${describe(sub, today)} — but I couldn't DM you (Discord said ${dm.status}). Allow direct messages from this server's members, or add the app to your account, then run \`/watch show\`.`);
  }
  return reply('Unknown subcommand.');
}

// For scripts/register-commands.mjs: the one command, three subcommands.
export const COMMANDS = [{
  name: 'watch',
  description: 'Get a DM when Nästet finds a home you could get',
  integration_types: [0, 1],   // installable to a server or to your own account
  contexts: [0, 1, 2],         // usable in servers, in DMs with the bot, and in other DMs
  options: [
    { type: 1, name: 'set', description: 'Start or change your watch', options: [
      { type: 3, name: 'city', description: 'Which city', required: true,
        choices: Object.entries(CITIES).map(([value, name]) => ({ name, value })) },
      { type: 4, name: 'days', description: 'Your SSSB-style queue days today', min_value: 0, max_value: 20000 },
      { type: 4, name: 'max_rent', description: 'Highest rent in kr per month', min_value: 1, max_value: 50000 },
      { type: 3, name: 'areas', description: 'Comma-separated areas (leave empty for any)' },
      { type: 5, name: 'all_new', description: 'Also tell me about every new listing within my limits' },
    ] },
    { type: 1, name: 'show', description: 'Show your watch' },
    { type: 1, name: 'stop', description: 'Stop and delete your watch' },
  ],
}];
