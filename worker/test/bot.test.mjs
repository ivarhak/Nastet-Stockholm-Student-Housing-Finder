import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySignature, handleInteraction } from '../src/discord.js';
import { plan, remember, matches, runningDays } from '../src/match.js';
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

test('/watch set stores, DMs, show and stop delete', async () => {
  const { k, pub } = await keypair();
  const SUBS = kv();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push(url);
    return new Response(JSON.stringify({ id: 'dm123' }), { status: 200 }); };
  try {
    const env = { DISCORD_PUBLIC_KEY: pub, DISCORD_BOT_TOKEN: 't', SUBS };
    const cmd = (name, options = []) => JSON.stringify({ type: 2, user: { id: '42' },
      data: { name: 'watch', options: [{ type: 1, name, options }] } });
    let r = await (await handleInteraction(await signed(k, cmd('set', [
      { name: 'city', value: 'stockholm' }, { name: 'days', value: 300 },
      { name: 'areas', value: 'Jerum, Lappkärrsberget' }, { name: 'max_rent', value: 6000 }])), env)).json();
    assert.match(r.data.content, /Check your DMs/);
    assert.equal(r.data.flags, 64);
    const sub = JSON.parse(SUBS.m.get('sub:42'));
    assert.deepEqual(sub.areas, ['Jerum', 'Lappkärrsberget']);
    assert.equal(sub.dm, 'dm123');
    assert.equal(sub.days, 300);
    assert.ok(calls.some(u => String(u).endsWith('/users/@me/channels')));
    r = await (await handleInteraction(await signed(k, cmd('show')), env)).json();
    assert.match(r.data.content, /300 queue days/);
    r = await (await handleInteraction(await signed(k, cmd('stop')), env)).json();
    assert.match(r.data.content, /deleted/);
    assert.equal(SUBS.m.has('sub:42'), false);
  } finally { globalThis.fetch = realFetch; }
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
  await SUBS.put('sub:2', JSON.stringify({ city: 'stockholm', days: 100, from: '2026-10-11', last_active: '2025-01-01T00:00:00Z' }));
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
  assert.equal(r.sent, 1); assert.equal(r.deleted, 1); assert.equal(r.digests, 1);
  const dm = posts.find(p => p[0].includes('/channels/c1/messages'));
  assert.match(dm[1].content, /Studentbacken 1/);
  assert.match(dm[1].content, /\?listing=x#stockholm/);
  r = await runNotify(env, now, f);
  assert.deepEqual(r.changed, []);                 // same generated_at: nothing read
  await SUBS.delete('meta:seen:stockholm');
  r = await runNotify(env, now, f);
  assert.equal(r.sent, 0);                         // already told
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
