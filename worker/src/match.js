// What a watch matches — the same rule the page's own watch uses (index.html,
// watchMatches), so a Discord DM and an on-page notice never disagree.
//
// A subscription:
//   { city, days, from, rent, areas, all_new, dm, notified, outbid, closing,
//     created, last_active }
// `days` is the queue-day count on `from`; it grows a day per Stockholm day.

export function stockholmToday(now = new Date()) {
  return now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
}

export function daysBetween(fromISO, toISO) {
  return Math.round((Date.parse(toISO + 'T00:00:00Z') - Date.parse(fromISO + 'T00:00:00Z')) / 86400000);
}

export function runningDays(sub, today) {
  if (sub.days == null) return null;
  return sub.days + Math.max(0, daysBetween(sub.from || today, today));
}

// SSSB-style listings (a queue-days figure) match when your running count
// meets it. Listings decided by a deadline instead (Bostadsförmedlingen, SGS,
// AF) have nothing to compare a count against, so they only match a watch
// that asked for every new listing.
export function matches(sub, l, today) {
  if (sub.areas && sub.areas.length && !sub.areas.includes(l.area)) return false;
  if (sub.rent != null && l.rent_sek != null && Number(l.rent_sek) > sub.rent) return false;
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
export function plan(sub, listings, today) {
  const notified = new Set(sub.notified || []);
  const outbid = new Set(sub.outbid || []);
  const closing = new Set(sub.closing || []);
  const mine = runningDays(sub, today);
  const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  const out = { fresh: [], outbid: [], closing: [] };
  for (const l of listings) {
    const ok = matches(sub, l, today);
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
