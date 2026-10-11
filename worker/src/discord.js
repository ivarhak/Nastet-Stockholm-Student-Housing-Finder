// Discord: slash commands in, DMs out. Plain REST — no gateway connection,
// so it fits a Worker that only wakes for a request or the hourly cron.
//
// What is stored, in KV under sub:<discord user id>: the city, queue days and
// the date they were given, max rent, areas, campus and longest commute, how
// often to write and at what hour, the DM channel id, and the listing ids
// already told about or already counted in a summary. Nothing else — no
// username, no messages. /watch stop deletes it; six months without a command
// deletes it too (see notify.js).

import { stockholmToday, runningDays, latestSlot, FREQS, DEFAULT_HOUR, NO_UNION_CAP } from './match.js';
import { CITIES, describeFilters, preview } from './summary.js';
import { cards } from './cards.js';

export { CITIES };
const API = 'https://discord.com/api/v10';
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

const FREQ_TEXT = { instant: 'a DM for each new listing you could get', twice_daily: 'a summary twice a day',
                    daily: 'a daily summary', weekly: 'a weekly summary (Mondays)' };
const hh = h => String(h).padStart(2, '0');

export function describe(sub, today, data) {
  const bits = [`**${CITIES[sub.city] || sub.city}**`];
  const d = runningDays(sub, today);
  bits.push(d == null ? 'no queue days given'
    : sub.union === false ? `${d} queue days today (no student union, so capped at ${Math.max(sub.days, NO_UNION_CAP)})`
    : `${d} queue days today (counting a day per day)`);
  bits.push(describeFilters(sub, data));
  const freq = sub.freq || 'instant';
  const at = Number.isInteger(sub.hour) ? sub.hour : DEFAULT_HOUR;
  bits.push(freq === 'instant' ? FREQ_TEXT.instant + (sub.all_new ? ', plus every new deadline listing' : '')
    : `${FREQ_TEXT[freq]} at ${hh(at)}:00${freq === 'twice_daily' ? ` and ${hh((at + 12) % 24)}:00` : ''}`
      + (sub.always ? ', even when nothing is new' : ''));
  return bits.join(' · ');
}

async function cityData(env, city, fetchImpl = fetch) {
  const site = (env.SITE_URL || '').replace(/\/$/, '');
  if (!site) return null;
  try {
    const r = await fetchImpl(`${site}/listings-${city}.json`, { cf: { cacheTtl: 300 } });
    return r.ok ? await r.json() : null;
  } catch (e) {
    return null;
  }
}

// The edits /watch set accepts, applied over the watch you already have, so
// changing one thing doesn't mean typing the rest again. Returns
// { sub, problems } — problems are explained in the reply and nothing is saved.
export function applySet(existing, o, data, today) {
  const city = CITIES[o.city] ? o.city : (existing && existing.city) || 'stockholm';
  const base = existing && existing.city === city ? existing : {};
  const sub = { ...base, city };
  const problems = [];
  if (o.days !== undefined) {
    if (Number.isInteger(o.days) && o.days >= 0 && o.days <= 20000) { sub.days = o.days; sub.from = today; }
    else problems.push('`days` must be a whole number from 0 to 20000.');
  }
  if (o.max_rent !== undefined) sub.rent = Number.isInteger(o.max_rent) && o.max_rent > 0 ? o.max_rent : null;
  if (o.max_commute !== undefined) sub.commute = Number.isInteger(o.max_commute) && o.max_commute > 0 ? o.max_commute : null;
  if (o.areas !== undefined) {
    const raw = String(o.areas).trim();
    sub.areas = /^(any|all|alla|-)?$/i.test(raw) ? [] : raw.split(',').map(x => x.trim()).filter(Boolean).slice(0, 40);
    if (data && sub.areas.length) {
      // Typed without accents ("lappkarrsberget") still finds the area.
      const known = new Set([...Object.keys(data.areas || {}), ...(data.listings || []).map(l => l.area)]);
      const fold = x => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      const byFold = new Map([...known].map(k => [fold(k), k]));
      sub.areas = sub.areas.map(a => known.has(a) ? a : (byFold.get(fold(a)) || a));
      const unknown = sub.areas.filter(a => !known.has(a));
      if (unknown.length) {
        problems.push(`Not an area in ${CITIES[city]}: ${unknown.join(', ')}. Areas there: ${Object.keys(data.areas || {}).slice(0, 30).join(', ')}.`);
      }
    }
  }
  if (o.campus !== undefined) {
    const schools = (data && data.schools) || {};
    const hit = Object.keys(schools).find(k => k.toLowerCase() === String(o.campus).trim().toLowerCase());
    if (hit) sub.campus = hit;
    else if (Object.keys(schools).length) problems.push(`Unknown campus "${o.campus}". In ${CITIES[city]}: ${Object.keys(schools).join(', ')}.`);
    else sub.campus = String(o.campus).trim();
  }
  if (o.frequency !== undefined) sub.freq = FREQS.includes(o.frequency) ? o.frequency : 'daily';
  if (o.hour !== undefined) sub.hour = Number.isInteger(o.hour) && o.hour >= 0 && o.hour <= 23 ? o.hour : DEFAULT_HOUR;
  if (o.always !== undefined) sub.always = !!o.always;
  if (o.all_new !== undefined) sub.all_new = !!o.all_new;
  if (o.student_union !== undefined) sub.union = !!o.student_union;
  // A new watch gets summaries by default; the original one-DM-per-listing
  // behaviour is still there as frequency: instant.
  if (!base.city) sub.freq = sub.freq || 'daily';
  if (!Number.isInteger(sub.hour)) sub.hour = DEFAULT_HOUR;
  if (sub.days == null && !sub.all_new && (sub.freq || 'instant') === 'instant') {
    problems.push('Instant DMs need your queue days (`days`), or `all_new: True` to hear about every new listing within your limits.');
  }
  return { sub, problems };
}

// Discord wants an answer within three seconds. Anything that reads the
// listings answers "thinking…" at once and edits the reply when it's done.
function deferred(interaction, env, ctx, work) {
  const finish = (async () => {
    let out;
    try {
      out = await work();
    } catch (e) {
      out = `Something went wrong: ${e && e.message}`;
    }
    // A string is a plain reply; an object can carry embeds (see cards.js).
    const msg = typeof out === 'string' ? { content: out.slice(0, 1990) } : { content: out.content || '', embeds: out.embeds || [] };
    await discordFetch(env, `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
      { method: 'PATCH', body: JSON.stringify({ ...msg, allowed_mentions: { parse: [] } }) });
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(finish);
  return json({ type: 5, data: { flags: EPHEMERAL } });
}

export async function handleInteraction(request, env, ctx) {
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
    return deferred(interaction, env, ctx, async () => {
      await env.SUBS.put(key, JSON.stringify({ ...existing, last_active: new Date().toISOString() }));
      const data = await cityData(env, existing.city);
      return `Watching: ${describe(existing, today, data)}.${data ? `\n${preview(existing, data)}` : ''}\n`
        + 'Change any one setting with `/watch set` · a summary now with `/watch now` · stop with `/watch stop`.';
    });
  }
  if (o.name === 'now') {
    if (!existing) return reply('No watch running. Start one with `/watch set`.');
    return deferred(interaction, env, ctx, async () => {
      const data = await cityData(env, existing.city);
      if (!data) return 'Could not read the listings right now — try again in a minute.';
      // Every listing that fits, as cards. A look, not a summary: it doesn't
      // move the "new since" marker of the next scheduled one.
      return { embeds: cards(env, existing, data, new Date(), 'all') };
    });
  }
  if (o.name === 'set') {
    return deferred(interaction, env, ctx, async () => {
      const city = CITIES[o.city] ? o.city : (existing && existing.city) || 'stockholm';
      const data = await cityData(env, city);
      const { sub, problems } = applySet(existing, o, data, today);
      if (problems.length) return `Not saved:\n• ${problems.join('\n• ')}`;
      const fresh = !existing || existing.city !== sub.city;
      Object.assign(sub, {
        created: (existing && existing.created) || new Date().toISOString(),
        last_active: new Date().toISOString(),
        // Kept across an update so changing the rent cap doesn't re-send old news.
        notified: (!fresh && existing.notified) || [],
        outbid: (!fresh && existing.outbid) || [],
        closing: (!fresh && existing.closing) || [],
      });
      // The first summary reports what's new from here on, not the whole list,
      // and a change of schedule waits for the next slot instead of firing now.
      if (fresh || !sub.seen) sub.seen = data ? data.listings.map(l => l.id) : [];
      if (fresh || o.frequency !== undefined || o.hour !== undefined || !sub.last_slot) sub.last_slot = latestSlot(sub, new Date());
      // Proves DMs can reach them before they rely on it.
      const dm = await sendDm(env, sub, userId, { content: `Watch ${fresh ? 'on' : 'updated'} — ${describe(sub, today, data)}. I'll write here.` });
      if (dm.ok) sub.dm = dm.channel;
      await env.SUBS.put(key, JSON.stringify(sub));
      const look = data ? `\n${preview(sub, data)}` : '';
      return dm.ok
        ? `Watch ${fresh ? 'on' : 'updated'}: ${describe(sub, today, data)}.${look}\nCheck your DMs — that's where it'll write. \`/watch now\` shows a summary straight away.`
        : `Watch saved: ${describe(sub, today, data)} — but I couldn't DM you (Discord said ${dm.status}). Allow direct messages from this server's members, or add the app to your account, then run \`/watch show\`.${look}`;
    });
  }
  return reply('Unknown subcommand.');
}

// For scripts/register-commands.mjs: the one command and its subcommands.
// With a watch running every /watch set option is optional — only what you
// give is changed.
export const COMMANDS = [{
  name: 'watch',
  description: 'Summaries or DMs about Nästet listings you could get',
  integration_types: [0, 1],   // installable to a server or to your own account
  contexts: [0, 1, 2],         // usable in servers, in DMs with the bot, and in other DMs
  options: [
    { type: 1, name: 'set', description: 'Start your watch, or change any of its settings', options: [
      { type: 3, name: 'city', description: 'Which city (default: your current one, or Stockholm)',
        choices: Object.entries(CITIES).map(([value, name]) => ({ name, value })) },
      { type: 4, name: 'days', description: 'Your SSSB queue days today — counted up by itself from here', min_value: 0, max_value: 20000 },
      { type: 3, name: 'frequency', description: 'How often to hear from the bot',
        choices: [{ name: 'Daily summary', value: 'daily' }, { name: 'Twice a day', value: 'twice_daily' },
                  { name: 'Weekly summary (Mondays)', value: 'weekly' },
                  { name: 'Instantly, a DM per listing you could get', value: 'instant' }] },
      { type: 4, name: 'hour', description: 'Hour for summaries, Stockholm time (default 8)', min_value: 0, max_value: 23 },
      { type: 3, name: 'campus', description: 'Campus commutes are measured to, e.g. KTH, SU, KI' },
      { type: 4, name: 'max_commute', description: 'Longest bike ride in minutes (0 = no limit)', min_value: 0, max_value: 180 },
      { type: 4, name: 'max_rent', description: 'Highest rent in kr per month (0 = no limit)', min_value: 0, max_value: 50000 },
      { type: 3, name: 'areas', description: 'Comma-separated areas, or "any"' },
      { type: 5, name: 'always', description: 'Send summaries even when nothing is new' },
      { type: 5, name: 'student_union', description: 'Member of a student union (kår)? Without one SSSB stops your days at 90' },
      { type: 5, name: 'all_new', description: 'Instant mode: also DM every new deadline listing within your limits' },
    ] },
    { type: 1, name: 'show', description: 'Show your watch and what fits it right now' },
    { type: 1, name: 'now', description: 'Every listing that fits your filters right now' },
    { type: 1, name: 'stop', description: 'Stop and delete your watch' },
  ],
}];
