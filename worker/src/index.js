// Nästet's one small server-side piece.
//
// The site itself stays static files on GitHub Pages. This Worker exists for
// the two things a static site can't do on its own:
//   · keep time — dispatch the scrape every hour, since GitHub's own scheduler
//     drops most scheduled runs, and alert an admin channel when data goes stale;
//   · talk to Discord — slash commands and DMs for the watch (see discord.js).

import { dispatchWorkflow } from './github.js';
import { checkFreshness } from './health.js';
import { handleInteraction } from './discord.js';
import { handleNotify, runNotify } from './notify.js';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/interactions') {
      return handleInteraction(request, env, ctx);
    }
    if (request.method === 'POST' && url.pathname === '/notify') {
      return handleNotify(request, env, ctx);
    }
    return new Response('Nästet worker — nothing to see here.\n', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};

export async function runCron(env) {
  const dispatch = await dispatchWorkflow(env);
  // Logged so `wrangler tail` shows each hour's outcome at a glance.
  console.log(`dispatch: ${dispatch.ok ? 'ok' : 'FAILED'} (HTTP ${dispatch.status}) ${dispatch.detail}`);
  const health = await checkFreshness(env);
  console.log(`freshness: ${health.ageH === null ? 'unknown' : health.ageH.toFixed(1) + ' h'}`
    + `${health.stale ? ' — STALE' : ''}${health.posted ? ' — posted to admin channel' : ''}`);
  // Fallback for the workflow's own /notify call; a no-op when nothing changed.
  let notify = null;
  try {
    notify = await runNotify(env);
    console.log(`notify: ${JSON.stringify(notify)}`);
  } catch (e) {
    console.log(`notify: failed — ${e && e.message}`);
  }
  return { dispatch, health, notify };
}
