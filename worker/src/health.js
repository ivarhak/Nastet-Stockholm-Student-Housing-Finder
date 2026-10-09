// A dead-man's switch for the scrape.
//
// The site says how old its data is, but nobody is looking at the site when it
// matters — at 3 a.m. when a run starts failing. This checks the published
// cities.json each time the cron fires and posts to an admin Discord channel
// once when the data goes stale, and once more when it recovers. The KV flag is
// what makes it once: without it a stale site would post every hour.

const STALE_KEY = 'health:stale-alerted';

export function newestGeneratedAt(citiesJson) {
  const cities = (citiesJson && citiesJson.cities) || {};
  let newest = null;
  for (const c of Object.values(cities)) {
    const t = Date.parse(c.generated_at || '');
    if (!Number.isNaN(t) && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

export async function checkFreshness(env, now = Date.now(), fetchImpl = fetch) {
  const staleHours = Number(env.STALE_HOURS || 3);
  let newest = null;
  let fetchError = '';
  try {
    const res = await fetchImpl(`${env.SITE_URL}/cities.json`, { cf: { cacheTtl: 0 } });
    if (res.ok) newest = newestGeneratedAt(await res.json());
    else fetchError = `cities.json answered HTTP ${res.status}`;
  } catch (e) {
    fetchError = `cities.json unreachable: ${e.message}`;
  }

  const ageH = newest === null ? null : (now - newest) / 3.6e6;
  const stale = ageH === null || ageH > staleHours;
  const alerted = env.SUBS ? await env.SUBS.get(STALE_KEY) : null;

  let posted = '';
  if (stale && !alerted) {
    posted = ageH === null
      ? `⚠️ Nästet: couldn't read the published data (${fetchError}).`
      : `⚠️ Nästet: the newest listings are ${ageH.toFixed(1)} h old — no scrape has published since. Check the Actions tab.`;
    await postAdmin(env, posted, fetchImpl);
    // Re-arms after a day so a long outage is mentioned again, not forgotten.
    if (env.SUBS) await env.SUBS.put(STALE_KEY, String(now), { expirationTtl: 24 * 3600 });
  } else if (!stale && alerted) {
    posted = `✅ Nästet: fresh again — newest listings are ${ageH.toFixed(1)} h old.`;
    await postAdmin(env, posted, fetchImpl);
    if (env.SUBS) await env.SUBS.delete(STALE_KEY);
  }
  return { ageH, stale, alerted: !!alerted, posted };
}

async function postAdmin(env, content, fetchImpl) {
  if (!env.ADMIN_WEBHOOK_URL) return;
  await fetchImpl(env.ADMIN_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  }).catch(() => {});
}
