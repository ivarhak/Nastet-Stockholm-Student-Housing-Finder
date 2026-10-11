// The notification pass. Two kinds of watch:
//   · instant — after each publish, compare the watch against the fresh
//     listings and DM a line per listing you could get;
//   · summaries (twice a day, daily, weekly) — at the watch's hour, one DM
//     with what's new since the last one (see summary.js).
// Run two ways, both harmless to repeat because each watch remembers what it
// was sent and which slot it last wrote for:
//   · POST /notify from the publish workflow, signed with NOTIFY_SECRET —
//     arrives minutes after the data lands;
//   · the hourly cron, which is also what brings each summary's hour round.
// A city's listings are read only when they changed (instant) or when a
// summary there is due, which keeps KV and fetches well inside the free tier.

import { plan, remember, stockholmToday, dueSlot } from './match.js';
import { sendDm, CITIES } from './discord.js';
import { summarize, listingLine, md } from './summary.js';

const IDLE_DAYS = 182;          // a watch nobody has touched in six months is deleted
const MAX_LINES = 6;

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
}
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handleNotify(request, env, ctx) {
  if (!env.NOTIFY_SECRET) return new Response('not configured', { status: 501 });
  const body = await request.text();
  const sig = (request.headers.get('X-Nastet-Signature') || '').replace(/^sha256=/, '');
  if (!sameString(sig, await hmacHex(env.NOTIFY_SECRET, body))) return new Response('bad signature', { status: 401 });
  // A signed body is still replayable; a stale one is refused.
  let at = 0;
  try { at = Date.parse(JSON.parse(body).at); } catch (e) { /* falls through to the check */ }
  if (!(Math.abs(Date.now() - at) < 10 * 60 * 1000)) return new Response('stale', { status: 401 });
  ctx.waitUntil(runNotify(env).then(r => console.log('notify:', JSON.stringify(r))));
  return new Response('accepted', { status: 202 });
}

function line(env, city, l) {
  const site = (env.SITE_URL || '').replace(/\/$/, '');
  const bits = [l.rent_sek != null ? `${Number(l.rent_sek).toLocaleString('sv-SE')} kr` : null,
                l.size_sqm ? `${l.size_sqm} m²` : null,
                typeof l.queue_days === 'number' ? `${l.queue_days} queue days` : null,
                l.deadline ? `apply by ${String(l.deadline).slice(0, 10)}` : null].filter(Boolean).join(' · ');
  return `• **${md(l.address || l.area)}** (${md(l.area)}) · ${bits} — <${site}/?listing=${encodeURIComponent(l.id)}#${city}>`;
}
export function compose(env, city, sent, sub, data, today) {
  // With the watch at hand each line also says the commute and where you stand.
  const fmt = l => (sub && data ? listingLine(env, city, sub, data, l, today) : line(env, city, l));
  const parts = [];
  const name = CITIES[city] || city;
  if (sent.fresh.length) {
    parts.push(sent.fresh.length === 1 ? `**A place you could get in ${name}**` : `**${sent.fresh.length} places you could get in ${name}**`);
    parts.push(...sent.fresh.slice(0, MAX_LINES).map(fmt));
    if (sent.fresh.length > MAX_LINES) parts.push(`…and ${sent.fresh.length - MAX_LINES} more on the site.`);
  }
  if (sent.outbid.length) {
    parts.push('', `**Overtaken** — someone with more queue days is now first:`);
    parts.push(...sent.outbid.slice(0, MAX_LINES).map(fmt));
  }
  if (sent.closing.length) {
    parts.push('', `**Closing tomorrow:**`);
    parts.push(...sent.closing.slice(0, MAX_LINES).map(fmt));
  }
  parts.push('', '-# `/watch show` · `/watch stop`');
  return parts.join('\n').slice(0, 1990);
}

async function digest(env, city, data, fetchImpl) {
  const hook = env[`DIGEST_WEBHOOK_${city.toUpperCase()}`];
  const ids = new Set(data.new_listing_ids || []);
  if (!hook || !ids.size) return false;
  const fresh = data.listings.filter(l => ids.has(l.id));
  const content = [`**${fresh.length} new in ${CITIES[city] || city}**`,
    ...fresh.slice(0, 10).map(l => line(env, city, l)),
    fresh.length > 10 ? `…and ${fresh.length - 10} more.` : ''].filter(Boolean).join('\n').slice(0, 1990);
  const r = await fetchImpl(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
  return r.ok;
}

export async function runNotify(env, now = new Date(), fetchImpl = fetch) {
  const out = { changed: [], subs: 0, sent: 0, summaries: 0, quiet: 0, failed: 0, deleted: 0, digests: 0 };
  if (!env.SUBS || !env.SITE_URL) return { ...out, skipped: 'not configured' };
  const site = env.SITE_URL.replace(/\/$/, '');
  const index = await (await fetchImpl(`${site}/cities.json`, { cf: { cacheTtl: 0 } })).json();
  const fresh = {};
  for (const [city, info] of Object.entries(index.cities || {})) {
    const seen = await env.SUBS.get(`meta:seen:${city}`);
    if (info.generated_at && seen !== info.generated_at) {
      const r = await fetchImpl(`${site}/listings-${city}.json`, { cf: { cacheTtl: 0 } });
      if (r.ok) fresh[city] = await r.json();
    }
  }
  out.changed = Object.keys(fresh);
  // Summaries need a city's listings whether or not they changed this hour;
  // read once per city, and only when someone's summary is due.
  const cache = { ...fresh };
  const dataFor = async city => {
    if (!(city in cache)) {
      const r = await fetchImpl(`${site}/listings-${city}.json`, { cf: { cacheTtl: 0 } });
      cache[city] = r.ok ? await r.json() : null;
    }
    return cache[city];
  };

  const today = stockholmToday(now);
  const idleBefore = new Date(now.getTime() - IDLE_DAYS * 86400000).toISOString();
  let cursor;
  do {
    const page = await env.SUBS.list({ prefix: 'sub:', cursor });
    for (const { name } of page.keys) {
      const sub = await env.SUBS.get(name, 'json');
      if (!sub) continue;
      out.subs++;
      if ((sub.last_active || sub.created || '') < idleBefore) {
        await env.SUBS.delete(name); out.deleted++; continue;
      }
      if ((sub.freq || 'instant') === 'instant') {
        const data = fresh[sub.city];
        if (!data) continue;
        const todo = plan(sub, data.listings, today, data);
        if (!todo.fresh.length && !todo.outbid.length && !todo.closing.length) continue;
        const res = await sendDm(env, sub, name.slice(4), { content: compose(env, sub.city, todo, sub, data, today),
                                                             allowed_mentions: { parse: [] } }, fetchImpl);
        if (res.ok) {
          out.sent++;
          await env.SUBS.put(name, JSON.stringify({ ...remember(sub, data.listings, todo), dm: res.channel || sub.dm }));
        } else {
          // Not remembered, so it's retried next pass — unless Discord says the
          // user can't be reached at all, which retrying won't fix.
          out.failed++;
          console.log(`notify: DM to ${name} failed (HTTP ${res.status})`);
        }
        continue;
      }
      // A summary watch: write when its slot comes round.
      const slot = dueSlot(sub, now);
      if (!slot) continue;
      const data = await dataFor(sub.city);
      if (!data) continue;
      const sum = summarize(env, sub, data, now);
      const next = { ...sub, last_slot: slot, seen: data.listings.map(l => l.id) };
      if (!sum.worthSending && !sub.always) {
        out.quiet++;
        await env.SUBS.put(name, JSON.stringify(next));
        continue;
      }
      const res = await sendDm(env, sub, name.slice(4), { content: sum.content, allowed_mentions: { parse: [] } }, fetchImpl);
      if (res.ok) {
        out.summaries++;
        await env.SUBS.put(name, JSON.stringify({ ...next, dm: res.channel || sub.dm }));
      } else {
        // Left due, so the next hourly run tries again.
        out.failed++;
        console.log(`notify: summary to ${name} failed (HTTP ${res.status})`);
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  for (const city of out.changed) {
    if (await digest(env, city, fresh[city], fetchImpl)) out.digests++;
    await env.SUBS.put(`meta:seen:${city}`, fresh[city].generated_at);
  }
  return out;
}
