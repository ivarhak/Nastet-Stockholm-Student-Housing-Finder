// What a watch matches — the same rule the page's own watch uses (index.html,
// watchMatches), so a Discord DM and an on-page notice never disagree.
//
// A subscription:
//   { city, days, from, rent, areas, campus, commute, freq, hour, always,
//     all_new, dm, notified, outbid, closing, seen, last_slot, created,
//     last_active }
// `days` is the queue-day count on `from`; it grows a day per Stockholm day.
// `freq` is 'instant' (a DM per matching listing, the original behaviour and
// the default for watches made before summaries existed), 'twice_daily',
// 'daily' or 'weekly'; summaries go out at `hour`, Stockholm time.

export function stockholmToday(now = new Date()) {
  return now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
}

export function daysBetween(fromISO, toISO) {
  return Math.round((Date.parse(toISO + 'T00:00:00Z') - Date.parse(fromISO + 'T00:00:00Z')) / 86400000);
}

// Without a student union (kår) membership SSSB stops the count at 90 days —
// the same rule as the site's "Member of a student union" box. A count already
// past 90 when given stays where it is.
export const NO_UNION_CAP = 90;
export function runningDays(sub, today) {
  if (sub.days == null) return null;
  const n = sub.days + Math.max(0, daysBetween(sub.from || today, today));
  return sub.union === false ? Math.min(n, Math.max(sub.days, NO_UNION_CAP)) : n;
}

// Bike minutes from a listing to a campus, worked out the way the page does
// (schoolMetrics in index.html): the area's routed figure when there is one,
// the straight-line estimate for the default campus, else distance at 15 km/h
// plus a few minutes. null when there's nothing to go on — and a commute we
// can't work out never hides a listing.
export function commuteMin(l, data, campus) {
  if (!data) return null;
  const school = campus || data.default_school || 'KTH';
  const ref = (data.areas && data.areas[l.area]) || l;
  const per = ref.per_school && ref.per_school[school];
  if (per && typeof per.bike_min === 'number') return per.bike_min;
  if (school === (data.default_school || 'KTH') && ref.straight_line && typeof ref.straight_line.bike_min === 'number') {
    return ref.straight_line.bike_min;
  }
  const c = data.schools && data.schools[school] && data.schools[school].coords;
  const at = ref.coords || l.coords;
  if (!c || !at) return null;
  const R = 6371, rad = d => d * Math.PI / 180;
  const h = Math.sin(rad(c[0] - at[0]) / 2) ** 2
    + Math.cos(rad(at[0])) * Math.cos(rad(c[0])) * Math.sin(rad(c[1] - at[1]) / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(h));
  return Math.round(km / 15 * 60 + 3);
}

// Your filters, without the queue-days question: area, rent, commute.
export function fits(sub, l, data) {
  if (sub.areas && sub.areas.length && !sub.areas.includes(l.area)) return false;
  if (sub.rent != null && l.rent_sek != null && Number(l.rent_sek) > sub.rent) return false;
  if (sub.commute != null && data) {
    const m = commuteMin(l, data, sub.campus);
    if (m != null && m > sub.commute) return false;
  }
  return true;
}

// Whether your queue days would get it today. Deadline-decided listings
// (Bostadsförmedlingen, SGS, AF) have no figure to compare against: null.
export function wouldGet(sub, l, today) {
  if (typeof l.queue_days !== 'number') return null;
  const mine = runningDays(sub, today);
  return mine != null && mine >= l.queue_days;
}

// SSSB-style listings (a queue-days figure) match when your running count
// meets it. Listings decided by a deadline instead (Bostadsförmedlingen, SGS,
// AF) have nothing to compare a count against, so they only match a watch
// that asked for every new listing.
export function matches(sub, l, today, data) {
  if (!fits(sub, l, data)) return false;
  if (typeof l.queue_days === 'number') {
    const mine = runningDays(sub, today);
    return mine != null && mine >= l.queue_days;
  }
  return !!sub.all_new;
}

// The three kinds of message, each sent once per listing per subscriber:
//   new      — a listing you could get turned up
//   outbid   — one we told you about now needs more days than you have
//   closing  — one you match closes tomorrow (deadline-based listings)
export function plan(sub, listings, today, data) {
  const notified = new Set(sub.notified || []);
  const outbid = new Set(sub.outbid || []);
  const closing = new Set(sub.closing || []);
  const mine = runningDays(sub, today);
  const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  const out = { fresh: [], outbid: [], closing: [] };
  for (const l of listings) {
    const ok = matches(sub, l, today, data);
    if (ok && !notified.has(l.id)) out.fresh.push(l);
    if (notified.has(l.id) && !outbid.has(l.id) && typeof l.queue_days === 'number'
        && mine != null && l.queue_days > mine) out.outbid.push(l);
    if (ok && l.deadline && String(l.deadline).slice(0, 10) === tomorrow && !closing.has(l.id)) out.closing.push(l);
  }
  return out;
}

// Keeps the remembered id lists from growing forever: anything no longer
// listed is dropped, which is also what lets a re-listed flat notify again.
export function remember(sub, listings, sent) {
  const live = new Set(listings.map(l => l.id));
  const keep = (arr, add) => [...new Set([...(arr || []).filter(id => live.has(id)), ...add.map(l => l.id)])];
  return {
    ...sub,
    notified: keep(sub.notified, sent.fresh),
    outbid: keep(sub.outbid, sent.outbid),
    closing: keep(sub.closing, sent.closing),
  };
}

// ── When a summary is due ──────────────────────────────────────────────────
export const FREQS = ['instant', 'twice_daily', 'daily', 'weekly'];
export const DEFAULT_HOUR = 8;

export function stockholmHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', hour: '2-digit', hourCycle: 'h23' }).format(now));
}
function addDaysISO(iso, n) {
  return new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}
const pad2 = n => String(n).padStart(2, '0');

// The most recent scheduled summary at or before now, as "YYYY-MM-DDTHH"
// (Stockholm). A summary is due when that slot differs from the last one
// sent — so a missed cron hour catches up at the next one instead of
// skipping the day.
export function latestSlot(sub, now = new Date()) {
  const freq = sub.freq || 'instant';
  if (freq === 'instant') return null;
  const hour = Number.isInteger(sub.hour) ? sub.hour : DEFAULT_HOUR;
  const hours = freq === 'twice_daily' ? [hour, (hour + 12) % 24].sort((a, b) => b - a) : [hour];
  const today = stockholmToday(now), h = stockholmHour(now);
  for (let back = 0; back <= 7; back++) {
    const d = addDaysISO(today, -back);
    if (freq === 'weekly' && new Date(d + 'T12:00:00Z').getUTCDay() !== 1) continue;   // Mondays
    for (const hr of hours) {
      if (back === 0 && hr > h) continue;
      return `${d}T${pad2(hr)}`;
    }
  }
  return null;
}
export function dueSlot(sub, now = new Date()) {
  const slot = latestSlot(sub, now);
  return slot && slot !== sub.last_slot ? slot : null;
}
