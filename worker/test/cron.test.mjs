import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchWorkflow } from '../src/github.js';
import { checkFreshness, newestGeneratedAt } from '../src/health.js';

class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
}

function recorder(responder) {
  const calls = [];
  const f = async (url, init = {}) => { calls.push({ url, init }); return responder(url, init); };
  f.calls = calls;
  return f;
}

test('dispatch posts to the workflow endpoint with auth and ref', async () => {
  const f = recorder(() => new Response(null, { status: 204 }));
  const r = await dispatchWorkflow({ GITHUB_REPO: 'o/r', GITHUB_TOKEN: 't', WORKFLOW: 'publish.yml' }, f);
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].url, 'https://api.github.com/repos/o/r/actions/workflows/publish.yml/dispatches');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer t');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { ref: 'main' });
});

test('dispatch reports a failure with GitHub\'s reason', async () => {
  const f = recorder(() => new Response('{"message":"Bad credentials"}', { status: 401 }));
  const r = await dispatchWorkflow({ GITHUB_REPO: 'o/r', GITHUB_TOKEN: 'bad' }, f);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.detail, /Bad credentials/);
});

test('dispatch refuses without configuration instead of calling out', async () => {
  const f = recorder(() => { throw new Error('should not be called'); });
  const r = await dispatchWorkflow({}, f);
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, 0);
});

test('newestGeneratedAt picks the latest city', () => {
  const t = newestGeneratedAt({ cities: {
    a: { generated_at: '2026-10-09T01:00:00Z' },
    b: { generated_at: '2026-10-09T03:00:00Z' },
    c: { generated_at: 'nonsense' },
  } });
  assert.equal(t, Date.parse('2026-10-09T03:00:00Z'));
});

test('stale data alerts once, then stays quiet, then announces recovery', async () => {
  const env = { SITE_URL: 'https://site', ADMIN_WEBHOOK_URL: 'https://hook', SUBS: new FakeKV() };
  const now = Date.parse('2026-10-09T12:00:00Z');
  let generated = '2026-10-09T06:00:00Z';                       // 6 h old
  const f = recorder((url) => url.endsWith('/cities.json')
    ? new Response(JSON.stringify({ cities: { s: { generated_at: generated } } }))
    : new Response(null, { status: 204 }));

  const first = await checkFreshness(env, now, f);
  assert.equal(first.stale, true);
  assert.match(first.posted, /6\.0 h old/);

  const second = await checkFreshness(env, now, f);
  assert.equal(second.posted, '', 'must not repeat the alert every hour');

  generated = '2026-10-09T11:30:00Z';                           // fresh again
  const third = await checkFreshness(env, now, f);
  assert.equal(third.stale, false);
  assert.match(third.posted, /fresh again/);
  const posts = f.calls.filter(c => c.url === 'https://hook');
  assert.equal(posts.length, 2);
});

test('an unreachable site counts as stale and says why', async () => {
  const env = { SITE_URL: 'https://site', ADMIN_WEBHOOK_URL: 'https://hook', SUBS: new FakeKV() };
  const f = recorder((url) => url.endsWith('/cities.json')
    ? new Response('nope', { status: 503 })
    : new Response(null, { status: 204 }));
  const r = await checkFreshness(env, Date.now(), f);
  assert.equal(r.stale, true);
  assert.match(r.posted, /HTTP 503/);
});
