// The bot's messages as Discord embeds ("cards"): a header card with the
// counts, then one card per kind of listing with a field per place.
//
//   mode 'all'     — /watch now: every listing that fits your filters, grouped
//                    into what you'd get today, what's decided by deadline,
//                    and what needs more queue days;
//   mode 'summary' — the scheduled DM: what's new since the last one, what
//                    closes soon, and the counts for everything.
//
// Discord's limits shape the rest: ≤ 10 embeds, ≤ 25 fields each, field
// values ≤ 1024 characters and ≤ 6000 characters across one message. Past
// the budget a card says how many more there are and links to the site.

import { commuteMin, fits, wouldGet, bfStanding, runningDays, stockholmToday, NO_UNION_CAP } from './match.js';
import { CITIES, describeFilters } from './summary.js';

const COLOR = { head: 0xd9a13b, get: 0x3ba55c, deadline: 0x5865f2, wait: 0x99aab5, fresh: 0xd9a13b, closing: 0xed4245 };
const BUDGET = 5600;
const nf = n => Number(n).toLocaleString('sv-SE');
const day = iso => new Date(String(iso).slice(0, 10) + 'T12:00:00Z')
  .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const unit = l => (String(l.id || '').startsWith('sssb-') ? (String(l.id).match(/-(\d{3,5})$/) || [])[1] : null);
// "today" / "tomorrow" read faster than a date when that's what it is.
function when(iso, today) {
  const d = String(iso).slice(0, 10);
  if (d === today) return 'today';
  const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  return d === tomorrow ? 'tomorrow' : day(d);
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const site = env => (env.SITE_URL || '').replace(/\/$/, '');

function field(env, sub, data, l, today, isNew) {
  const bike = commuteMin(l, data, sub.campus);
  const mine = runningDays(sub, today);
  const get = wouldGet(sub, l, today);
  const facts = [l.rent_sek != null ? `**${nf(l.rent_sek)} kr**${l.rent_months && l.rent_months < 12 ? ` (${l.rent_months} months a year)` : ''}` : null,
                 l.size_sqm ? `${l.size_sqm} m²` : null,
                 bike != null ? `${bike} min by bike` : null, l.type ? String(l.type) : null].filter(Boolean).join(' · ');
  // Bostadsförmedlingen: where you stand among those who've applied so far.
  const bf = bfStanding(sub, l);
  const bfText = bf ? (bf.nobody ? '✅ nobody has applied yet' : bf.lead ? '✅ you\'d lead so far' : `${nf(bf.short)} days short so far`)
    : (Array.isArray(l.bf_queue_dates) && l.bf_queue_dates[0] ? `first in line queued since ${l.bf_queue_dates[0]}` : null);
  const stand = typeof l.queue_days === 'number'
    ? (get ? `✅ you'd lead — ${nf(l.queue_days)} queue days`
           : `${nf(l.queue_days)} queue days${mine != null ? ` · ${nf(l.queue_days - mine)} short` : ''}`)
    : [bfText, l.deadline ? `apply by **${when(l.deadline, today)}**` : 'open to apply'].filter(Boolean).join(' · ');
  const timing = [stand, l.move_in ? `move-in ${String(l.move_in).slice(0, 10)}` : null].filter(Boolean).join(' · ');
  const url = `${site(env)}/?listing=${encodeURIComponent(l.id)}#${sub.city}`;
  return {
    // SSSB rooms in one building often look identical; the apartment number
    // (the last part of the id, "sssb-Strix-Armégatan 32 A-1213") tells them apart.
    name: clip(`${isNew ? '🆕 ' : ''}${l.address || l.area}${unit(l) ? ` (lgh ${unit(l)})` : ''}${l.address && l.area ? ` · ${l.area}` : ''}`, 250),
    value: clip(`${facts}\n${timing} · [Open ↗](${url})`, 1020),
  };
}

// Fills cards from groups until the character budget runs out.
// Fills cards from groups within the character budget, shared fairly: each
// non-empty group gets an equal slice first, and whatever a short group
// doesn't use is handed on — so one long list can't leave the next group
// as nothing but "…and 38 more". "More" goes last, as a field, since Discord
// draws a card's description above its list.
function pack(env, groups, used) {
  const live = groups.filter(g => g.list.length).slice(0, 9);
  const embeds = [];
  let budget = BUDGET - used;
  live.forEach((g, gi) => {
    const share = Math.floor(budget / (live.length - gi));
    const e = { title: `${g.title} (${g.list.length})`, color: g.color, fields: [] };
    if (g.description) e.description = g.description;
    let size = e.title.length + (g.description || '').length;
    const moreLen = 90;
    for (const f of g.list) {
      const n = f.name.length + f.value.length;
      if (e.fields.length >= 24 || size + n + moreLen > share) break;
      e.fields.push(f); size += n;
    }
    const left = g.list.length - e.fields.length;
    if (left) {
      const more = { name: '​', value: `…and ${left} more — [see them on the site](${site(env)}/#${g.city})` };
      e.fields.push(more); size += more.value.length + 1;
    }
    budget -= size;
    embeds.push(e);
  });
  return embeds;
}

function header(env, sub, data, now, lines) {
  const today = stockholmToday(now);
  const mine = runningDays(sub, today);
  const capped = sub.union === false && mine != null && mine >= NO_UNION_CAP && sub.days <= NO_UNION_CAP;
  const you = mine == null ? 'Add your queue days with `/watch set days:` to see what you\'d get.'
    : `Your queue days: **${nf(mine)}**${capped ? ' (capped at 90 — no student union)' : ''}`;
  return {
    title: `Nästet · ${CITIES[sub.city] || sub.city} · ${day(today)}`,
    url: `${site(env)}/#${sub.city}`,
    color: COLOR.head,
    description: [...lines, `Filters: ${describeFilters(sub, data)}`, you].join('\n'),
  };
}

const FREQ_LABEL = { instant: 'Instant DMs', twice_daily: 'Twice a day', daily: 'Every day', weekly: 'Mondays' };
function footer(sub) {
  const at = String(Number.isInteger(sub.hour) ? sub.hour : 8).padStart(2, '0');
  return { text: `${FREQ_LABEL[sub.freq] || 'Summaries'}${sub.freq && sub.freq !== 'instant' ? ` at ${at}:00` : ''} · /watch set to change · /watch stop` };
}

export function cards(env, sub, data, now = new Date(), mode = 'all') {
  const today = stockholmToday(now);
  const L = data.listings || [];
  const fitting = L.filter(l => fits(sub, l, data));
  const seen = new Set(sub.seen || []);
  const isNew = l => sub.seen && !seen.has(l.id);
  const bike = l => commuteMin(l, data, sub.campus) ?? 999;
  const get = fitting.filter(l => wouldGet(sub, l, today) === true).sort((a, b) => bike(a) - bike(b));
  const deadline = fitting.filter(l => wouldGet(sub, l, today) === null)
    .sort((a, b) => String(a.deadline || '9').localeCompare(String(b.deadline || '9')) || bike(a) - bike(b));
  const wait = fitting.filter(l => wouldGet(sub, l, today) === false)
    .sort((a, b) => a.queue_days - b.queue_days || bike(a) - bike(b));
  const f = l => field(env, sub, data, l, today, isNew(l));
  const counts = `✅ **${get.length}** you'd get today · 🗓️ **${deadline.length}** by deadline · ⏳ **${wait.length}** need more days`;

  let groups, lines;
  if (mode === 'summary') {
    const fresh = L.filter(l => !seen.has(l.id));
    const freshFit = fresh.filter(l => fitting.includes(l))
      .sort((a, b) => (wouldGet(sub, a, today) === true ? 0 : 1) - (wouldGet(sub, b, today) === true ? 0 : 1) || bike(a) - bike(b));
    const soon = new Date(Date.parse(today + 'T12:00:00Z') + 2 * 86400000).toISOString().slice(0, 10);
    const closing = fitting.filter(l => l.deadline && String(l.deadline).slice(0, 10) >= today && String(l.deadline).slice(0, 10) <= soon);
    const since = sub.last_slot ? `since ${day(sub.last_slot)}, ${sub.last_slot.slice(11)}:00` : 'since you started this watch';
    lines = [fresh.length ? `**${fresh.length} new** ${since} — **${freshFit.length}** fit your filters` : `Nothing new ${since}.`,
             `**${fitting.length}** of ${L.length} open listings fit · ${counts}`];
    groups = [
      { title: '🆕 New and fitting', color: COLOR.fresh, city: sub.city, list: freshFit.map(l => field(env, sub, data, l, today, false)) },
      { title: '⏰ Closing within two days', color: COLOR.closing, city: sub.city, list: closing.map(f) },
    ];
  } else {
    lines = [`**${fitting.length}** of ${L.length} open listings fit your filters`, counts];
    groups = [
      { title: '✅ You\'d get these today', color: COLOR.get, city: sub.city, list: get.map(f),
        description: 'Shortest commute first.' },
      { title: '🗓️ Apply before the deadline', color: COLOR.deadline, city: sub.city, list: deadline.map(f),
        description: 'Decided by deadline, not queue days — soonest first.' },
      { title: '⏳ Need more queue days', color: COLOR.wait, city: sub.city, list: wait.map(f),
        description: 'Closest first.' },
    ];
  }
  const head = header(env, sub, data, now, lines);
  const used = head.title.length + head.description.length + 120;
  const rest = pack(env, groups, used);
  if (!fitting.length) head.description += '\n\nNothing fits your filters right now — loosen them with `/watch set` (e.g. `max_commute:0`).';
  const embeds = [head, ...rest];
  embeds[embeds.length - 1].footer = footer(sub);
  embeds[embeds.length - 1].timestamp = now.toISOString();
  return embeds;
}
