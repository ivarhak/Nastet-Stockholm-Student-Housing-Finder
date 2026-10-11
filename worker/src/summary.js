// The scheduled summary DM: what's new since the last one, how much of it
// fits your filters, what you'd get today with your queue days, what closes
// soon, and where things stand overall. Plain Discord markdown, under the
// 2000-character message limit.

import { commuteMin, fits, wouldGet, runningDays, stockholmToday } from './match.js';

export const CITIES = { stockholm: 'Stockholm', goteborg: 'Göteborg', lund: 'Lund' };
const MAX_LIST = 5;

export const md = s => String(s ?? '').replace(/([*_~`|>\\])/g, '\\$1');
const nf = n => Number(n).toLocaleString('sv-SE');
const day = iso => new Date(iso.slice(0, 10) + 'T12:00:00Z')
  .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

export function campusOf(sub, data) {
  const id = sub.campus || (data && data.default_school) || 'KTH';
  return { id, name: (data && data.schools && data.schools[id] && data.schools[id].name) || id };
}

// "≤ 45 min by bike to KTH · ≤ 6 000 kr · Jerum, Pax"
export function describeFilters(sub, data) {
  const bits = [];
  if (sub.commute != null) bits.push(`≤ ${sub.commute} min by bike to ${campusOf(sub, data).id}`);
  if (sub.rent != null) bits.push(`≤ ${nf(sub.rent)} kr`);
  if (sub.areas && sub.areas.length) {
    bits.push(sub.areas.length > 4 ? `${sub.areas.slice(0, 4).join(', ')} +${sub.areas.length - 4}` : sub.areas.join(', '));
  }
  return bits.length ? bits.join(' · ') : 'no filters — every listing';
}

function link(env, city, l) {
  const site = (env.SITE_URL || '').replace(/\/$/, '');
  return `<${site}/?listing=${encodeURIComponent(l.id)}#${city}>`;
}

// One listing as a line: where, what it costs, how far, and where you stand.
export function listingLine(env, city, sub, data, l, today) {
  const bike = commuteMin(l, data, sub.campus);
  const get = wouldGet(sub, l, today);
  const mine = runningDays(sub, today);
  const stand = typeof l.queue_days === 'number'
    ? (get ? `✅ you'd lead (${nf(l.queue_days)} queue days)`
           : `${nf(l.queue_days)} queue days${mine != null ? ` (${nf(l.queue_days - mine)} short)` : ''}`)
    : (l.deadline ? `apply by ${String(l.deadline).slice(0, 10)}` : 'open to apply');
  const facts = [l.rent_sek != null ? `${nf(l.rent_sek)} kr` : null, l.size_sqm ? `${l.size_sqm} m²` : null,
                 bike != null ? `${bike} min by bike` : null].filter(Boolean).join(' · ');
  return `• **${md(l.address || l.area)}** (${md(l.area)}) · ${facts} · ${stand} — ${link(env, city, l)}`;
}

// You'd-get first, then the shortest ride.
function rank(sub, data, today) {
  return (a, b) => {
    const ga = wouldGet(sub, a, today) === true ? 0 : 1, gb = wouldGet(sub, b, today) === true ? 0 : 1;
    if (ga !== gb) return ga - gb;
    return (commuteMin(a, data, sub.campus) ?? 999) - (commuteMin(b, data, sub.campus) ?? 999);
  };
}

const FREQ_LABEL = { twice_daily: 'twice a day', daily: 'every day', weekly: 'every Monday' };

// Returns { content, worthSending }. Nothing new and nothing closing isn't
// worth a message unless the watch asked for one every time (`always`).
export function summarize(env, sub, data, now = new Date()) {
  const city = sub.city;
  const today = stockholmToday(now);
  const L = data.listings || [];
  const seen = new Set(sub.seen || []);
  const fresh = L.filter(l => !seen.has(l.id));
  const fit = l => fits(sub, l, data);
  const freshFit = fresh.filter(fit);
  const freshLead = freshFit.filter(l => wouldGet(sub, l, today) === true);
  const freshOpen = freshFit.filter(l => wouldGet(sub, l, today) === null);
  const allFit = L.filter(fit);
  const queued = allFit.filter(l => typeof l.queue_days === 'number');
  const allLead = queued.filter(l => wouldGet(sub, l, today) === true);
  const soon = addDays(today, 2);
  const closing = allFit.filter(l => l.deadline && String(l.deadline).slice(0, 10) >= today && String(l.deadline).slice(0, 10) <= soon);
  const mine = runningDays(sub, today);

  const since = sub.last_slot ? `since ${day(sub.last_slot)}, ${sub.last_slot.slice(11)}:00` : 'since you started this watch';
  const byProvider = Object.entries(fresh.reduce((m, l) => (m[l.provider] = (m[l.provider] || 0) + 1, m), {}))
    .map(([p, n]) => `${n} ${p}`).join(' · ');

  const head = [`**Nästet · ${CITIES[city] || city} · ${day(today)}**`];
  head.push(fresh.length
    ? `**${fresh.length} new listing${fresh.length === 1 ? '' : 's'}** ${since}${byProvider ? ` (${byProvider})` : ''}`
    : `No new listings ${since}.`);
  if (fresh.length) {
    head.push(`→ **${freshFit.length}** fit your filters (${describeFilters(sub, data)})`);
    if (mine != null) head.push(`→ **${freshLead.length}** you'd get today with your **${nf(mine)}** queue days`
      + (freshOpen.length ? `, plus **${freshOpen.length}** decided by deadline, open to apply` : ''));
    else if (freshOpen.length) head.push(`→ **${freshOpen.length}** decided by deadline, open to apply`);
  }

  const top = freshFit.slice().sort(rank(sub, data, today)).slice(0, MAX_LIST);
  const parts = [head.join('\n')];
  if (top.length) parts.push(['**New and fitting**', ...top.map(l => listingLine(env, city, sub, data, l, today)),
    freshFit.length > top.length ? `…and ${freshFit.length - top.length} more on the site.` : ''].filter(Boolean).join('\n'));
  const closeLines = closing.slice(0, 3).map(l => listingLine(env, city, sub, data, l, today));
  if (closing.length) parts.push([`**Closing within two days** (${closing.length})`, ...closeLines].join('\n'));

  const overall = [`**Right now:** ${L.length} open in ${CITIES[city] || city} · ${allFit.length} fit your filters`];
  if (mine != null && queued.length) {
    overall[0] += ` · you'd lead ${allLead.length} of the ${queued.length} with queue days`;
    if (!allLead.length) {
      const least = queued.reduce((a, b) => (a.queue_days <= b.queue_days ? a : b));
      overall.push(`The shortest queue that fits you is **${nf(least.queue_days)}** days (${md(least.address || least.area)}) — ${nf(least.queue_days - mine)} more than you have.`);
    }
  } else if (mine == null && queued.length) {
    overall.push('Add your queue days (`/watch set days:`) to see which ones you\'d get.');
  }
  parts.push(overall.join('\n'));
  parts.push(`-# ${FREQ_LABEL[sub.freq] || 'on schedule'} at ${String(Number.isInteger(sub.hour) ? sub.hour : 8).padStart(2, '0')}:00 · \`/watch set\` to change · \`/watch now\` · \`/watch stop\``);

  let content = parts.join('\n\n');
  // Over the limit: drop listing lines from the end of the "new" block first.
  while (content.length > 1990 && top.length > 1) {
    top.pop();
    parts[1] = ['**New and fitting**', ...top.map(l => listingLine(env, city, sub, data, l, today)),
      `…and ${freshFit.length - top.length} more on the site.`].join('\n');
    content = parts.join('\n\n');
  }
  return { content: content.slice(0, 1990), worthSending: fresh.length > 0 || closing.length > 0,
           counts: { fresh: fresh.length, fit: freshFit.length, lead: freshLead.length, open: freshOpen.length, closing: closing.length } };
}

// A short "right now" line for replies to /watch set and /watch show.
export function preview(sub, data, now = new Date()) {
  const today = stockholmToday(now);
  const L = (data && data.listings) || [];
  const allFit = L.filter(l => fits(sub, l, data));
  const queued = allFit.filter(l => typeof l.queue_days === 'number');
  const lead = queued.filter(l => wouldGet(sub, l, today) === true).length;
  const mine = runningDays(sub, today);
  return `Right now ${allFit.length} of ${L.length} listings fit your filters`
    + (mine != null && queued.length ? `, and you'd lead ${lead} of the ${queued.length} with queue days.` : '.');
}

function addDays(iso, n) {
  return new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}
