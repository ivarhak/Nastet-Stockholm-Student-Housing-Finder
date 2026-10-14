import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySignature, handleInteraction, applySet } from '../src/discord.js';
import { plan, remember, matches, runningDays, commuteMin, fits, latestSlot, dueSlot, bfStanding } from '../src/match.js';
import { summarize } from '../src/summary.js';
import { syncCommands } from '../src/commands.js';
import { cards } from '../src/cards.js';
import { runNotify, hmacHex, handleNotify, compose } from '../src/notify.js';

const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
async function keypair() {
  const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return { k, pub: hex(await crypto.subtle.exportKey('raw', k.publicKey)) };
}
async function signed(k, body, ts = '1700000000') {
  const sig = hex(await crypto.subtle.sign('Ed25519', k.privateKey, new TextEncoder().encode(ts + body)));
  return new Request('https://w/interactions', { method: 'POST', body,
    headers: { 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts } });
}
function kv() {
  const m = new Map();
  return { m,
    async get(k, type) { const v = m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; } };
}

test('signature: valid passes, tampered fails', async () => {
  const { k, pub } = await keypair();
  const body = '{"type":1}';
  const req = await signed(k, body);
  assert.equal(await verifySignature(pub, req.headers.get('X-Signature-Ed25519'), '1700000000', body), true);
  assert.equal(await verifySignature(pub, req.headers.get('X-Signature-Ed25519'), '1700000000', body + ' '), false);
  assert.equal(await verifySignature(pub, 'zz', '1', body), false);
});

test('PING answered, unsigned rejected', async () => {
  const { k, pub } = await keypair();
  const env = { DISCORD_PUBLIC_KEY: pub };
  const ok = await handleInteraction(await signed(k, '{"type":1}'), env);
  assert.deepEqual(await ok.json(), { type: 1 });
  const bad = await handleInteraction(new Request('https://w/i', { method: 'POST', body: '{"type":1}' }), env);
  assert.equal(bad.status, 401);
});

// Deferred replies: the handler answers type 5 at once and edits the reply
// through ctx.waitUntil; this collects that edit.
function harness(pub, SUBS, listings) {
  const calls = [];
  const pending = [];
  const ctx = { waitUntil: p => pending.push(p) };
  const f = async (url, init = {}) => {
    url = String(url); calls.push([url, init]);
    if (url.endsWith('/listings-stockholm.json')) return new Response(JSON.stringify(listings));
    return new Response(JSON.stringify({ id: 'dm123' }), { status: 200 });
  };
  const env = { DISCORD_PUBLIC_KEY: pub, DISCORD_BOT_TOKEN: 't', SUBS, SITE_URL: 'https://s' };
  const lastBody = () => { const e = calls.filter(c => c[0].includes('/messages/@original')).pop(); return e && JSON.parse(e[1].body); };
  const lastEdit = () => { const b = lastBody(); return b && b.content; };
  return { calls, pending, ctx, f, env, lastEdit, lastBody };
}
const DATA = {
  generated_at: 'g', default_school: 'KTH',
  schools: { KTH: { name: 'KTH', coords: [59.3498, 18.0707] }, SU: { name: 'Stockholm University', coords: [59.3655, 18.0570] } },
  areas: { Jerum: { coords: [59.3502, 18.053], per_school: { KTH: { bike_min: 7 }, SU: { bike_min: 12 } } },
           Flemingsberg: { coords: [59.2167, 17.95], per_school: { KTH: { bike_min: 64 } } } },
  listings: [
    { id: 'j1', provider: 'SSSB', area: 'Jerum', address: 'Studentbacken 1', queue_days: 80, rent_sek: 4800, size_sqm: 18 },
    { id: 'j2', provider: 'SSSB', area: 'Jerum', address: 'Studentbacken 2', queue_days: 400, rent_sek: 5200 },
    { id: 'f1', provider: 'SSSB', area: 'Flemingsberg', address: 'Kvarngatan 1', queue_days: 10, rent_sek: 4000 },
    { id: 'b1', provider: 'Bostadsförmedlingen', area: 'Vasastan', address: 'Odengatan 1', coords: [59.343, 18.05], rent_sek: 6900, deadline: '2026-10-12' },
  ],
};

test('/watch set: deferred, merges, validates, previews; show/now/stop', async () => {
  const { k, pub } = await keypair();
  const SUBS = kv();
  const h = harness(pub, SUBS, DATA);
  const realFetch = globalThis.fetch;
  globalThis.fetch = h.f;
  try {
    const cmd = (name, options = []) => JSON.stringify({ type: 2, application_id: 'app', token: 'tok', user: { id: '42' },
      data: { name: 'watch', options: [{ type: 1, name, options }] } });
    const run = async (name, opts) => {
      const r = await (await handleInteraction(await signed(k, cmd(name, opts)), h.env, h.ctx)).json();
      await Promise.all(h.pending.splice(0));
      return r;
    };
    let r = await run('set', [{ name: 'days', value: 300 }, { name: 'areas', value: 'jerum, Flemingsberg' }, { name: 'max_commute', value: 30 }]);
    assert.equal(r.type, 5); assert.equal(r.data.flags, 64);
    assert.match(h.lastEdit(), /Watch on/);
    assert.match(h.lastEdit(), /daily summary at 08:00/);
    assert.match(h.lastEdit(), /Right now 2 of 4 listings fit/);      // j1, j2: Flemingsberg is 64 min away
    let sub = JSON.parse(SUBS.m.get('sub:42'));
    assert.deepEqual(sub.areas, ['Jerum', 'Flemingsberg']);           // accent/case folded to the real name
    assert.equal(sub.freq, 'daily'); assert.equal(sub.hour, 8); assert.equal(sub.commute, 30);
    assert.deepEqual(sub.seen.sort(), ['b1', 'f1', 'j1', 'j2']);       // first summary counts from now
    assert.ok(sub.last_slot);

    // Change one thing; the rest stays.
    r = await run('set', [{ name: 'frequency', value: 'weekly' }, { name: 'hour', value: 18 }]);
    sub = JSON.parse(SUBS.m.get('sub:42'));
    assert.equal(sub.days, 300); assert.equal(sub.commute, 30); assert.equal(sub.freq, 'weekly'); assert.equal(sub.hour, 18);
    assert.match(h.lastEdit(), /weekly summary \(Mondays\) at 18:00/);

    // Bad input explains itself and saves nothing.
    r = await run('set', [{ name: 'campus', value: 'MIT' }]);
    assert.match(h.lastEdit(), /Not saved:[\s\S]*Unknown campus "MIT"[\s\S]*KTH, SU/);
    assert.equal(JSON.parse(SUBS.m.get('sub:42')).campus, undefined);
    r = await run('set', [{ name: 'areas', value: 'Narnia' }]);
    assert.match(h.lastEdit(), /Not an area in Stockholm: Narnia/);

    r = await run('show');
    assert.match(h.lastEdit(), /300 queue days/);
    r = await run('now');
    const emb = h.lastBody().embeds;
    assert.match(emb[0].title, /Nästet · Stockholm/);
    assert.match(emb[0].description, /2\*\* of 4 open listings fit/);
    assert.ok(emb.some(e => /You'd get these today/.test(e.title) && e.fields.some(f => /Studentbacken 1/.test(f.name))));
    assert.ok(emb.some(e => /Need more queue days/.test(e.title) && e.fields.some(f => /100 short/.test(f.value))));
    r = await (await handleInteraction(await signed(k, cmd('stop')), h.env, h.ctx)).json();
    assert.match(r.data.content, /deleted/);
    assert.equal(SUBS.m.has('sub:42'), false);
  } finally { globalThis.fetch = realFetch; }
});

test('applySet: instant mode still needs days or all_new', () => {
  const { problems } = applySet(null, { frequency: 'instant' }, DATA, '2026-10-11');
  assert.match(problems[0], /Instant DMs need your queue days/);
  assert.equal(applySet(null, { frequency: 'instant', all_new: true }, DATA, '2026-10-11').problems.length, 0);
  // Clearing filters.
  const { sub } = applySet({ city: 'stockholm', rent: 5000, commute: 20, areas: ['Jerum'] }, { max_rent: 0, max_commute: 0, areas: 'any' }, DATA, '2026-10-11');
  assert.equal(sub.rent, null); assert.equal(sub.commute, null); assert.deepEqual(sub.areas, []);
});

test('commute: routed figure per campus, haversine fallback, unknown never hides', () => {
  assert.equal(commuteMin(DATA.listings[0], DATA, 'KTH'), 7);
  assert.equal(commuteMin(DATA.listings[0], DATA, 'SU'), 12);
  const bf = commuteMin(DATA.listings[3], DATA, 'KTH');
  assert.ok(bf > 3 && bf < 20, `bf ${bf}`);
  assert.equal(fits({ commute: 30 }, DATA.listings[2], DATA), false);   // Flemingsberg, 64 min
  assert.equal(fits({ commute: 30 }, { area: 'Nowhere' }, DATA), true);
});

test('summary slots: daily, twice daily, weekly, catch-up', () => {
  // 2026-10-12 is a Monday. 06:17 UTC = 08:17 in Stockholm (CEST).
  const at = iso => new Date(iso);
  assert.equal(latestSlot({ freq: 'daily', hour: 8 }, at('2026-10-12T06:17:00Z')), '2026-10-12T08');
  assert.equal(latestSlot({ freq: 'daily', hour: 8 }, at('2026-10-12T05:17:00Z')), '2026-10-11T08');
  assert.equal(latestSlot({ freq: 'twice_daily', hour: 8 }, at('2026-10-12T17:17:00Z')), '2026-10-12T08');   // 19:17: 20:00 not yet
  assert.equal(latestSlot({ freq: 'twice_daily', hour: 8 }, at('2026-10-12T18:17:00Z')), '2026-10-12T20');
  assert.equal(latestSlot({ freq: 'weekly', hour: 8 }, at('2026-10-15T10:00:00Z')), '2026-10-12T08');
  assert.equal(latestSlot({ freq: 'instant' }, at('2026-10-12T06:17:00Z')), null);
  const sub = { freq: 'daily', hour: 8, last_slot: '2026-10-11T08' };
  assert.equal(dueSlot(sub, at('2026-10-12T05:17:00Z')), null);                // 07:17, not yet
  assert.equal(dueSlot(sub, at('2026-10-12T09:17:00Z')), '2026-10-12T08');    // missed 08:17, caught at 11:17
  assert.equal(dueSlot({ ...sub, last_slot: '2026-10-12T08' }, at('2026-10-12T09:17:00Z')), null);
});

test('summarize: new, fitting, would-get, closing, overall, length', () => {
  const sub = { city: 'stockholm', days: 100, from: '2026-10-11', commute: 30, freq: 'daily', hour: 8,
                seen: ['j2'], last_slot: '2026-10-10T08' };
  const s = summarize({ SITE_URL: 'https://s' }, sub, DATA, new Date('2026-10-11T06:17:00Z'));
  assert.equal(s.worthSending, true);
  assert.deepEqual(s.counts, { fresh: 3, fit: 2, lead: 1, open: 1, closing: 1 });
  assert.match(s.content, /\*\*3 new listings\*\* since Sat 10 Oct, 08:00 \(2 SSSB · 1 Bostadsförmedlingen\)/);
  assert.match(s.content, /→ \*\*2\*\* fit your filters \(≤ 30 min by bike to KTH\)/);
  assert.match(s.content, /→ \*\*1\*\* you'd get today with your \*\*100\*\* queue days, plus \*\*1\*\* decided by deadline/);
  assert.match(s.content, /Studentbacken 1\*\* \(Jerum\) · 4\s800 kr · 18 m² · 7 min by bike · ✅ you'd lead \(80 queue days\)/);
  assert.match(s.content, /Closing within two days/);
  assert.match(s.content, /you'd lead 1 of the 2 with queue days/);
  assert.ok(s.content.length <= 1990);
  const quiet = summarize({ SITE_URL: 'https://s' }, { ...sub, seen: DATA.listings.map(l => l.id) }, { ...DATA, listings: DATA.listings.slice(0, 3) }, new Date('2026-10-11T06:17:00Z'));
  assert.equal(quiet.worthSending, false);
  assert.match(quiet.content, /No new listings/);
  const many = { ...DATA, listings: Array.from({ length: 60 }, (_, i) => ({ id: 'x' + i, provider: 'SSSB', area: 'Jerum', address: 'Lång gata ' + 'x'.repeat(60) + i, queue_days: i, rent_sek: 5000 })) };
  assert.ok(summarize({ SITE_URL: 'https://s' }, { ...sub, seen: [] }, many).content.length <= 1990);
});

test('runNotify: a due summary is sent once, a quiet one is skipped', async () => {
  const SUBS = kv();
  const now = new Date('2026-10-12T06:17:00Z');
  await SUBS.put('sub:7', JSON.stringify({ city: 'stockholm', days: 100, from: '2026-10-11', freq: 'daily', hour: 8, dm: 'c7',
    seen: ['j2', 'f1', 'b1'], last_slot: '2026-10-11T08', last_active: now.toISOString() }));
  await SUBS.put('sub:8', JSON.stringify({ city: 'stockholm', freq: 'daily', hour: 8, dm: 'c8', areas: ['Flemingsberg'],
    seen: DATA.listings.map(l => l.id), last_slot: '2026-10-11T08', last_active: now.toISOString() }));
  const posts = [];
  const f = async (url, init) => {
    url = String(url);
    if (url.endsWith('/cities.json')) return new Response(JSON.stringify({ cities: { stockholm: { generated_at: 'g' } } }));
    if (url.endsWith('/listings-stockholm.json')) return new Response(JSON.stringify(DATA));
    posts.push([url, init && JSON.parse(init.body)]);
    return new Response('{"id":"c"}');
  };
  await SUBS.put('meta:seen:stockholm', 'g');                       // data unchanged: summaries still go
  const env = { SUBS, SITE_URL: 'https://s', DISCORD_BOT_TOKEN: 't' };
  let r = await runNotify(env, now, f);
  assert.equal(r.summaries, 1); assert.equal(r.quiet, 1);
  const dm = posts.find(p => p[0].includes('/channels/c7/'))[1];
  assert.match(dm.embeds[0].description, /\*\*1 new\*\* since Sun 11 Oct, 08:00/);
  assert.ok(dm.embeds.some(e => /New and fitting/.test(e.title) && /Studentbacken 1/.test(e.fields[0].name)));
  assert.equal(posts.some(p => p[0].includes('/channels/c8/')), false);
  assert.equal(JSON.parse(SUBS.m.get('sub:7')).last_slot, '2026-10-12T08');
  r = await runNotify(env, now, f);
  assert.equal(r.summaries, 0);                                      // not again in the same slot
});

test('matching: days grow, areas and rent limit, deadline listings need all_new', () => {
  const sub = { days: 100, from: '2026-10-01', areas: ['Jerum'], rent: 6000 };
  assert.equal(runningDays(sub, '2026-10-11'), 110);
  assert.equal(matches(sub, { area: 'Jerum', queue_days: 105, rent_sek: 5000 }, '2026-10-11'), true);
  assert.equal(matches(sub, { area: 'Jerum', queue_days: 120, rent_sek: 5000 }, '2026-10-11'), false);
  assert.equal(matches(sub, { area: 'Kista', queue_days: 50 }, '2026-10-11'), false);
  assert.equal(matches(sub, { area: 'Jerum', queue_days: 50, rent_sek: 7000 }, '2026-10-11'), false);
  assert.equal(matches(sub, { area: 'Jerum', deadline: '2026-10-20' }, '2026-10-11'), false);
  assert.equal(matches({ ...sub, all_new: true }, { area: 'Jerum', deadline: '2026-10-20' }, '2026-10-11'), true);
});

test('plan: new once, outbid once, closing once', () => {
  const sub = { days: 100, from: '2026-10-11', all_new: true };
  let listings = [{ id: 'a', queue_days: 90 }, { id: 'b', deadline: '2026-10-12' }];
  let p = plan(sub, listings, '2026-10-11');
  assert.deepEqual(p.fresh.map(l => l.id), ['a', 'b']);
  assert.deepEqual(p.closing.map(l => l.id), ['b']);
  let s2 = remember(sub, listings, p);
  p = plan(s2, listings, '2026-10-11');
  assert.equal(p.fresh.length + p.closing.length + p.outbid.length, 0);
  listings = [{ id: 'a', queue_days: 150 }];
  p = plan(s2, listings, '2026-10-11');
  assert.deepEqual(p.outbid.map(l => l.id), ['a']);
  s2 = remember(s2, listings, p);
  assert.deepEqual(s2.notified, ['a']);         // b no longer listed, forgotten
  assert.equal(plan(s2, listings, '2026-10-11').outbid.length, 0);
});

test('runNotify: DMs matches once, skips unchanged cities, deletes idle', async () => {
  const SUBS = kv();
  const now = new Date('2026-10-11T10:00:00Z');
  await SUBS.put('sub:1', JSON.stringify({ city: 'stockholm', days: 100, from: '2026-10-11', dm: 'c1', last_active: now.toISOString() }));
  await SUBS.put('sub:2', JSON.stringify({ city: 'stockholm', days: 100, from: '2026-10-11', dm: 'c2', last_active: '2025-01-01T00:00:00Z' }));
  const listings = { generated_at: 'g1', new_listing_ids: ['x'], listings: [{ id: 'x', area: 'Jerum', address: 'Studentbacken 1', queue_days: 80, rent_sek: 4000 }] };
  const posts = [];
  const f = async (url, init) => {
    url = String(url);
    if (url.endsWith('/cities.json')) return new Response(JSON.stringify({ cities: { stockholm: { generated_at: 'g1' } } }));
    if (url.endsWith('/listings-stockholm.json')) return new Response(JSON.stringify(listings));
    posts.push([url, init && JSON.parse(init.body)]);
    return new Response('{"id":"c1"}');
  };
  const env = { SUBS, SITE_URL: 'https://xn--nstet-gra.se', DISCORD_BOT_TOKEN: 't', DIGEST_WEBHOOK_STOCKHOLM: 'https://hook' };
  let r = await runNotify(env, now, f);
  assert.equal(r.sent, 1); assert.equal(r.deleted, 0); assert.equal(r.warned, 1); assert.equal(r.digests, 1);
  assert.ok(JSON.parse(SUBS.m.get('sub:2')).idle_warned);           // a week's notice first
  assert.match(posts.find(p => /deleted in a week/.test((p[1] || {}).content || ''))[1].content, /\/watch show/);
  const dm = posts.find(p => p[0].includes('/channels/c1/messages'));
  assert.match(dm[1].content, /Studentbacken 1/);
  assert.match(dm[1].content, /\?listing=x#stockholm/);
  r = await runNotify(env, now, f);
  assert.deepEqual(r.changed, []);                 // same generated_at: nothing read
  await SUBS.delete('meta:seen:stockholm');
  const before = posts.filter(p => p[0].includes('/channels/c1/messages')).length;
  r = await runNotify(env, now, f);
  assert.equal(posts.filter(p => p[0].includes('/channels/c1/messages')).length, before);   // already told
});

test('/notify: HMAC and freshness enforced', async () => {
  const env = { NOTIFY_SECRET: 's3cret' };
  const ctx = { waitUntil() {} };
  const body = JSON.stringify({ at: new Date().toISOString() });
  const good = new Request('https://w/notify', { method: 'POST', body, headers: { 'X-Nastet-Signature': 'sha256=' + await hmacHex('s3cret', body) } });
  assert.equal((await handleNotify(good, env, ctx)).status, 202);
  const bad = new Request('https://w/notify', { method: 'POST', body, headers: { 'X-Nastet-Signature': 'sha256=00' } });
  assert.equal((await handleNotify(bad, env, ctx)).status, 401);
  const oldBody = JSON.stringify({ at: '2020-01-01T00:00:00Z' });
  const old = new Request('https://w/notify', { method: 'POST', body: oldBody, headers: { 'X-Nastet-Signature': await hmacHex('s3cret', oldBody) } });
  assert.equal((await handleNotify(old, env, ctx)).status, 401);
});

test('compose escapes markdown and stays under the limit', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: 'i' + i, area: 'A*', address: '**bold**' + 'x'.repeat(80), queue_days: 1 }));
  const s = compose({ SITE_URL: 'https://s' }, 'stockholm', { fresh: many, outbid: [], closing: [] });
  assert.ok(s.length <= 1990);
  assert.match(s, /\\\*\\\*bold/);
  assert.match(s, /and 24 more/);
});

test('student union: without one the count stops at 90', () => {
  assert.equal(runningDays({ days: 80, from: '2026-10-01', union: false }, '2026-10-30'), 90);
  assert.equal(runningDays({ days: 90, from: '2026-10-01', union: false }, '2026-12-01'), 90);
  assert.equal(runningDays({ days: 120, from: '2026-10-01', union: false }, '2026-12-01'), 120);   // already past it: stays
  assert.equal(runningDays({ days: 90, from: '2026-10-01' }, '2026-10-11'), 100);
  const { sub } = applySet({ city: 'stockholm', days: 90 }, { student_union: false }, DATA, '2026-10-11');
  assert.equal(sub.union, false);
});

test('commands register themselves once per change', async () => {
  const SUBS = kv();
  const calls = [];
  const f = async (url, init = {}) => { calls.push([String(url), init.method || 'GET']);
    return new Response(JSON.stringify({ id: 'app9' })); };
  const env = { SUBS, DISCORD_BOT_TOKEN: 't' };
  let r = await syncCommands(env, f);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map(c => c[1] + ' ' + c[0].replace('https://discord.com/api/v10', '')),
                   ['GET /oauth2/applications/@me', 'PUT /applications/app9/commands']);
  r = await syncCommands(env, f);
  assert.equal(r.unchanged, true);
  assert.equal(calls.length, 2);
  assert.equal((await syncCommands({}, f)).skipped, 'not configured');
});

test('cards: every fitting listing, grouped, inside Discord limits', () => {
  const sub = { city: 'stockholm', days: 100, from: '2026-10-11', freq: 'daily', hour: 19 };
  const e = cards({ SITE_URL: 'https://s' }, sub, DATA, new Date('2026-10-11T10:00:00Z'), 'all');
  assert.deepEqual(e.map(x => x.title.replace(/ \(\d+\)$/, '')),
    ['Nästet · Stockholm · Sun 11 Oct', "✅ You'd get these today", '🗓️ Apply before the deadline', '⏳ Need more queue days']);
  assert.match(e[1].fields[0].value, /\[Open ↗\]\(https:\/\/s\/\?listing=/);
  assert.match(e[e.length - 1].footer.text, /Every day at 19:00/);
  const many = { ...DATA, listings: Array.from({ length: 300 }, (_, i) => ({ id: 'x' + i, provider: 'SSSB', area: 'Jerum',
    address: 'Väldigt lång gatuadress ' + 'x'.repeat(80) + i, queue_days: i, rent_sek: 5000, size_sqm: 20, move_in: '2026-11-01' })) };
  const big = cards({ SITE_URL: 'https://s' }, sub, many, new Date('2026-10-11T10:00:00Z'), 'all');
  const size = big.reduce((n, x) => n + (x.title || '').length + (x.description || '').length + (x.footer ? x.footer.text.length : 0)
    + (x.fields || []).reduce((m, f) => m + f.name.length + f.value.length, 0), 0);
  assert.ok(big.length <= 10 && size <= 6000, `${big.length} embeds, ${size} chars`);
  assert.ok(big.every(x => !x.fields || x.fields.length <= 25));
  assert.ok(big.some(x => (x.fields || []).some(f => /more — \[see them on the site\]/.test(f.value))));
  // Capped without a union.
  const capped = cards({ SITE_URL: 'https://s' }, { ...sub, days: 90, union: false }, DATA, new Date('2026-10-30T10:00:00Z'), 'all');
  assert.match(capped[0].description, /\*\*90\*\* \(capped at 90 — no student union\)/);
});

test('idle: deleted only a week after the warning', async () => {
  const SUBS = kv();
  const now = new Date('2026-10-11T10:00:00Z');
  await SUBS.put('sub:2', JSON.stringify({ city: 'stockholm', last_active: '2025-01-01T00:00:00Z', idle_warned: '2026-10-08T10:00:00Z' }));
  await SUBS.put('sub:3', JSON.stringify({ city: 'stockholm', last_active: '2025-01-01T00:00:00Z', idle_warned: '2026-10-01T10:00:00Z' }));
  const f = async url => String(url).endsWith('/cities.json') ? new Response(JSON.stringify({ cities: {} })) : new Response('{}');
  const r = await runNotify({ SUBS, SITE_URL: 'https://s', DISCORD_BOT_TOKEN: 't' }, now, f);
  assert.equal(r.deleted, 1);
  assert.ok(SUBS.m.has('sub:2')); assert.ok(!SUBS.m.has('sub:3'));
});

test('Bostadsförmedlingen standing from bf_since and the leading queue dates', () => {
  const l = { id: 'bf-1', provider: 'Bostadsförmedlingen', area: 'Kärrtorp', deadline: '2026-10-15', bf_queue_dates: ['2025-09-08', '2026-09-09'], rent_sek: 7950 };
  assert.deepEqual(bfStanding({ bf_since: '2024-01-01' }, l), { lead: true });
  assert.deepEqual(bfStanding({ bf_since: '2025-09-18' }, l), { lead: false, short: 10 });
  assert.deepEqual(bfStanding({ bf_since: '2025-09-18' }, { ...l, bf_queue_dates: [] }), { lead: true, nobody: true });
  assert.equal(bfStanding({}, l), null);
  assert.equal(matches({ bf_since: '2024-01-01' }, l, '2026-10-11', null), true);   // leading so far → worth a DM
  assert.equal(matches({ bf_since: '2026-01-01' }, l, '2026-10-11', null), false);
  const e = cards({ SITE_URL: 'https://s' }, { city: 'stockholm', bf_since: '2024-01-01' }, { ...DATA, listings: [l] }, new Date('2026-10-11T10:00:00Z'), 'all');
  assert.match(e[1].fields[0].value, /you'd lead so far · apply by \*\*(Thu 15 Oct|tomorrow|today)\*\*/);
  const { sub, problems } = applySet({ city: 'stockholm', freq: 'daily' }, { bf_since: '2025-09-01' }, DATA, '2026-10-11');
  assert.equal(sub.bf_since, '2025-09-01'); assert.equal(problems.length, 0);
  assert.match(applySet({ city: 'stockholm' }, { bf_since: 'last year' }, DATA, '2026-10-11').problems[0], /YYYY-MM-DD/);
});

test('a listing missing for one run is not announced again', () => {
  const sub = { days: 100, from: '2026-10-11', notified: ['a'] };
  const kept = remember(sub, [], { fresh: [], outbid: [], closing: [] }, { a: { gone_at: '2026-10-11T09:00:00Z' } });
  assert.deepEqual(kept.notified, ['a']);
  assert.deepEqual(remember(sub, [], { fresh: [], outbid: [], closing: [] }).notified, []);
});
