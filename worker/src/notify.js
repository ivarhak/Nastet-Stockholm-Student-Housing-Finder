// The notification pass: after each publish, compare every watch against the
// fresh listings and DM whoever has news. Started two ways, both harmless to
// repeat because each subscriber's sent ids are remembered:
//   · POST /notify from the publish workflow, signed with NOTIFY_SECRET —
//     arrives minutes after the data lands;
//   · the hourly cron, as a fallback when that call doesn't arrive.
// Cities whose data hasn't changed since the last pass are skipped without
// reading a single subscription, which keeps KV reads and writes well inside
// the free tier.

import { plan, remember, stockholmToday } from './match.js';
import { sendDm, CITIES } from './discord.js';

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

const md = s => String(s ?? '').replace(/([*_~`|>\\])/g, '\\$1');
function line(env, city, l) {
  const site = (env.SITE_URL || '').replace(/\/$/, '');
  const bits = [l.rent_sek != null ? `${Number(l.rent_sek).toLocaleString('sv-SE')} kr` : null,
                l.size_sqm ? `${l.size_sqm} m²` : null,
                typeof l.queue_days === 'number' ? `${l.queue_days} queue days` : null,
                l.deadline ? `apply by ${String(l.deadline).slice(0, 10)}` : null].filter(Boolean).join(' · ');
  return `• **${md(l.address || l.area)}** (${md(l.area)}) · ${bits} — <${site}/?listing=${encodeURIComponent(l.id)}#${city}>`;
}
export function compose(env, city, sent) {
  const parts = [];
  const name = CITIES[city] || city;
  if (sent.fresh.length) {
    parts.push(sent.fresh.length === 1 ? `**A place you could get in ${name}**` : `**${sent.fresh.length} places you could get in ${name}**`);
    parts.push(...sent.fresh.slice(0, MAX_LINES).map(l => line(env, city, l)));
    if (sent.fresh.length > MAX_LINES) parts.push(`…and ${sent.fresh.length - MAX_LINES} more on the site.`);
  }
  if (sent.outbid.length) {
    parts.push('', `**Overtaken** — someone with more queue days is now first:`);
    parts.push(...sent.outbid.slice(0, MAX_LINES).map(l => line(env, city, l)));
  }
  if (sent.closing.length) {
    parts.push('', `**Closing tomorrow:**`);
    parts.push(...sent.closing.slice(0, MAX_LINES).map(l => line(env, city, l)));
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
  const out = { changed: [], subs: 0, sent: 0, failed: 0, deleted: 0, digests: 0 };
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
  if (!out.changed.length) return out;

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
      const data = fresh[sub.city];
      if (!data) continue;
      const todo = plan(sub, data.listings, today);
      if (!todo.fresh.length && !todo.outbid.length && !todo.closing.length) continue;
      const res = await sendDm(env, sub, name.slice(4), { content: compose(env, sub.city, todo),
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
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  for (const city of out.changed) {
    if (await digest(env, city, fresh[city], fetchImpl)) out.digests++;
    await env.SUBS.put(`meta:seen:${city}`, fresh[city].generated_at);
  }
  return out;
}
