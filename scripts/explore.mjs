// Exploratory pass over the live site, run by .github/workflows/explore.yml.
//
//   node scripts/explore.mjs <out-dir> [site-url]
//
// Drives nästet.se like a visitor would — cities, areas, listings, hover
// cards, tabs, campus finder, profile, search, filters, language, themes,
// phone — and records everything that looks wrong: page errors, console
// errors, failed requests, horizontal overflow, accessibility violations,
// flows that didn't do what they should, and data oddities in the published
// JSON. Screenshots go next to report.md so a human (or Claude) can look.
import { chromium, devices } from 'playwright';
import fs from 'fs';
import path from 'path';

const OUT = process.argv[2] || 'explore-out';
const SITE = (process.argv[3] || 'https://xn--nstet-gra.se').replace(/\/$/, '');
fs.mkdirSync(OUT, { recursive: true });
const axeSrc = fs.readFileSync(path.resolve('node_modules/axe-core/axe.min.js'), 'utf8');

const findings = [];   // { severity, area, what, detail }
const notes = [];      // neutral observations
const shots = [];
const find = (severity, area, what, detail = '') => findings.push({ severity, area, what, detail: String(detail).slice(0, 600) });
const note = s => notes.push(s);

let shotN = 0;
async function shot(page, name, opts = {}) {
  const file = `${String(++shotN).padStart(2, '0')}-${name}.png`;
  try { await page.screenshot({ path: path.join(OUT, file), ...opts }); shots.push(file); } catch (e) { note(`screenshot ${name} failed: ${e.message}`); }
}

function watch(page, label) {
  page.on('pageerror', e => find('high', label, 'Uncaught page error',
    `${e.message} @ ${(e.stack || '').split('\n').slice(1, 4).join(' / ')} (during: ${curStep})`));
  page.on('console', m => { if (m.type() === 'error') find('medium', label, 'Console error', m.text()); });
  page.on('requestfailed', r => {
    const u = r.url();
    if (/cartocdn|tile|cookieyes|google/.test(u)) return;    // third-party noise
    find('medium', label, 'Request failed', `${u} — ${r.failure()?.errorText}`);
  });
  page.on('response', r => {
    const u = r.url();
    if (r.status() >= 400 && u.startsWith(SITE)) find('medium', label, `HTTP ${r.status()}`, u);
  });
}

async function settle(page, ms = 600) { await page.waitForTimeout(ms); }

// Markers fully inside the map's visible area, optionally only ones with
// listings ("— N available"), so a test never pokes something off-screen or
// an empty "×" area that has no card by design.
// A marker counts only if its centre is the marker itself: on a dense map one
// marker can sit under another, and pointing there would hit the wrong one.
// The test then moves the mouse (or a finger) to that centre, as a person
// would, instead of waiting on Playwright's "is it covered?" check.
async function visibleMarkers(page, sel, withListings = false) {
  return page.evaluate(([sel, withListings]) => {
    const m = document.getElementById('map').getBoundingClientRect();
    return [...document.querySelectorAll(sel)].map((e, i) => {
      const r = e.getBoundingClientRect();
      const icon = e.closest('.leaflet-marker-icon');
      const label = icon?.getAttribute('aria-label') || '';
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return { i, label, x, y, covered: !(top && icon && icon.contains(top)),
               ok: r.left > m.left + 20 && r.right < m.right - 20 && r.top > m.top + 20 && r.bottom < m.bottom - 20
                   && (!withListings || (/available/.test(label) && !/none/.test(label))) };
    }).filter(x => x.ok);
  }, [sel, withListings]).then(all => {
    const covered = all.filter(x => x.covered).length;
    if (covered) note(`${sel}: ${covered} of ${all.length} on-screen markers are covered by another marker`);
    return all.filter(x => !x.covered);
  });
}

async function overflow(page, label) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  if (o.sw > o.cw + 1) find('medium', label, 'Horizontal overflow', `scrollWidth ${o.sw} > clientWidth ${o.cw}`);
}

async function axe(page, label) {
  await page.addScriptTag({ content: axeSrc });
  const v = await page.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] }))
    .violations.map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length,
                            target: v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | '),
                            why: v.nodes[0].failureSummary })));
  for (const x of v) find(x.impact === 'critical' || x.impact === 'serious' ? 'medium' : 'low', label,
                          `a11y: ${x.id} (${x.n})`, `${x.target} — ${x.why}`);
}

let curStep = '';
async function step(label, fn) {
  curStep = label;
  try { await fn(); } catch (e) { find('high', label, 'Flow broke', e.stack?.split('\n').slice(0, 3).join(' ') || e.message); }
}

const browser = await chromium.launch();

// ── Data checks on what's published ───────────────────────────────────────
await step('data', async () => {
  const idx = await (await fetch(`${SITE}/cities.json`)).json();
  for (const [city, info] of Object.entries(idx.cities)) {
    const d = await (await fetch(`${SITE}/listings-${city}.json`)).json();
    const L = d.listings;
    const ageH = (Date.now() - Date.parse(d.generated_at)) / 3.6e6;
    note(`${city}: ${L.length} listings, generated ${ageH.toFixed(1)} h ago`);
    if (ageH > 6) find('medium', 'data', `${city} data is ${ageH.toFixed(1)} h old`, d.generated_at);
    const ids = new Set(); const dup = [];
    for (const l of L) { if (ids.has(l.id)) dup.push(l.id); ids.add(l.id); }
    if (dup.length) find('high', 'data', `${city}: duplicate listing ids`, dup.slice(0, 5).join(', '));
    const noCoords = L.filter(l => !l.coords && !(d.areas?.[l.area]?.coords));
    if (noCoords.length) find('medium', 'data', `${city}: ${noCoords.length} listings can't be placed on the map`, noCoords.slice(0, 5).map(l => l.id).join(', '));
    const noRent = L.filter(l => l.rent_sek == null);
    if (noRent.length) note(`${city}: ${noRent.length} listings without rent`);
    const weirdRent = L.filter(l => l.rent_sek != null && (l.rent_sek < 1000 || l.rent_sek > 30000));
    if (weirdRent.length) find('low', 'data', `${city}: implausible rents`, weirdRent.slice(0, 5).map(l => `${l.id}=${l.rent_sek}`).join(', '));
    const noUrl = L.filter(l => !l.url);
    if (noUrl.length) find('medium', 'data', `${city}: ${noUrl.length} listings with no link to the landlord`, noUrl.slice(0, 5).map(l => l.id).join(', '));
    const plans = L.filter(l => l.floorplan);
    note(`${city}: ${plans.length} floor plans, ${L.filter(l => l.noise).length} noise tags, isochrones: ${Object.keys(d.isochrones || {}).length}, campus maps: ${Object.keys(d.campus_maps || {}).join(',') || 'none'}`);
    for (const l of plans.slice(0, 3)) {
      const r = await fetch(`${SITE}/${l.floorplan}`, { method: 'HEAD' });
      if (!r.ok) find('medium', 'data', `floor plan missing (HTTP ${r.status})`, l.floorplan);
    }
    for (const f of Object.values(d.isochrones || {}).slice(0, 2)) {
      const r = await fetch(`${SITE}/${f}`, { method: 'HEAD' });
      if (!r.ok) find('medium', 'data', `isochrone file missing (HTTP ${r.status})`, f);
    }
    const h = await fetch(`${SITE}/history-${city}.json`);
    if (!h.ok) find('low', 'data', `history-${city}.json HTTP ${h.status}`);
  }
  for (const f of ['og.png', 'robots.txt', 'sitemap.xml', 'manifest.webmanifest', 'sw.js']) {
    const r = await fetch(`${SITE}/${f}`, { method: 'HEAD' });
    if (!r.ok) find('low', 'data', `${f} HTTP ${r.status}`);
  }
});

// ── Desktop, Stockholm ────────────────────────────────────────────────────
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(th => { try { localStorage.setItem('nastet-theme', th); } catch (e) {} }, theme);
  const page = await ctx.newPage();
  const L = `desktop/${theme}`;
  watch(page, L);
  await step(`${L}: load`, async () => {
    await page.goto(`${SITE}/#stockholm`, { waitUntil: 'networkidle', timeout: 60000 });
    await settle(page, 1500);
    await shot(page, `stockholm-${theme}`);
    await overflow(page, L);
    await axe(page, `${L}: start`);
  });
  if (theme === 'light') { await ctx.close(); continue; }

  await step('areas: click each roundel', async () => {
    note(`area roundels at start: ${await page.locator('.area-roundel').count()}`);
    const picks = (await visibleMarkers(page, '.area-roundel', true)).map(x => x.label.split(' —')[0]).slice(0, 4);
    for (const name of picks) {
      await page.evaluate(() => leafletMap.setView(centre(), 12, { animate: false }));
      await settle(page, 700);
      const cur = await visibleMarkers(page, '.area-roundel', true);
      const hit = cur.find(x => x.label.startsWith(name + ' —'));
      if (!hit) { note(`area ${name} not visible at city zoom`); continue; }
      const label = hit.label;
      await page.mouse.click(hit.x, hit.y);
      await settle(page, 1300);
      const title = await page.locator('#panelTitle').innerText().catch(() => '');
      const dots = await page.locator('.listing-dot').count();
      const rows = await page.locator('#listings .listing-row').count();
      note(`clicked "${label}" → panel "${title.split('\n')[0]}", ${dots} building dots, ${rows} rows, zoom ${await page.evaluate(() => leafletMap.getZoom())}`);
      if (/available/.test(label || '') && !/none/.test(label) && rows === 0) find('high', 'areas', `area with listings shows no rows`, label);
      if (/available/.test(label || '') && !/none/.test(label) && dots === 0) find('medium', 'areas', `area didn't open into building dots`, label);
      if (name === picks[0]) await shot(page, 'area-selected');
      await page.locator('.clear-sel').click().catch(() => {});
      await settle(page, 900);
    }
  });

  await step('hover cards', async () => {
    // Back to the city view: after selecting an area the map stays zoomed in,
    // and most markers are off-screen.
    await page.evaluate(() => leafletMap.setView(centre(), 12, { animate: false }));
    await settle(page, 800);
    const targets = ['.area-roundel', '.bf-pin'];
    for (const sel of targets) {
      const vis = await visibleMarkers(page, sel, sel === '.area-roundel');
      if (!vis.length) { note(`no visible ${sel} to hover`); continue; }
      await page.mouse.move(vis[0].x, vis[0].y, { steps: 4 });
      await settle(page, 500);
      const shown = await page.locator('#hoverCard').isVisible();
      if (!shown) find('medium', 'hover', `no hover card on ${sel}`);
      else if (sel === '.bf-pin') await shot(page, 'hover-card');
      await page.mouse.move(5, 5); await settle(page, 300);
    }
  });

  await step('listing row → landlord', async () => {
    const [popup] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null),
      page.locator('#listings .listing-row .row-open').first().click(),
    ]);
    if (!popup) note('first row click did not open a new tab (may select instead)');
    else { note(`row opened ${popup.url().slice(0, 90)}`); await popup.close(); }
  });

  await step('floor plan button', async () => {
    const b = page.locator('.plan-btn').first();
    if (!(await b.count())) { note('no floor-plan buttons in the default list'); return; }
    await b.click(); await settle(page, 800);
    const ok = await page.locator('.plan-box img').evaluate(i => i.complete && i.naturalWidth > 0).catch(() => false);
    if (!ok) find('medium', 'floorplan', 'floor-plan dialog image did not load');
    await shot(page, 'floorplan');
    await page.keyboard.press('Escape');
  });

  await step('tabs', async () => {
    await page.click('#tabQueues'); await settle(page); await shot(page, 'queues');
    await page.fill('#pfDays', '300'); await page.locator('#pfDays').dispatchEvent('change');
    await page.click('#tabMarket'); await settle(page); await shot(page, 'market');
    await axe(page, 'market tab');
    await page.click('#tabListings'); await settle(page);
    const lead = await page.locator('.fact.you').count();
    note(`with 300 queue days set: ${lead} "you" chips on rows`);
    if (!lead) find('medium', 'profile', 'profile days set but no lead/short chips appeared');
  });

  await step('all listings + search', async () => {
    await page.click('#browseAllBtn'); await settle(page);
    await page.fill('#searchInput', 'Jerum'); await settle(page, 500);
    const rows = await page.locator('#listings .listing-row').count();
    note(`search "Jerum": ${rows} rows`);
    await page.fill('#searchInput', 'zzzqqq'); await settle(page, 300);
    if (!(await page.locator('.empty-state').count())) find('low', 'search', 'no empty state for a search with no hits');
    await page.click('#browseAllBtn'); await settle(page);
  });

  await step('filters', async () => {
    const before = await page.locator('#listings .listing-row').count();
    await page.evaluate(() => { const s = document.getElementById('maxRent'); s.value = s.min; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await settle(page);
    const after = await page.locator('#listings .listing-row').count();
    note(`max rent to minimum: rows ${before} → ${after}`);
    await shot(page, 'filtered');
    await page.evaluate(() => { const s = document.getElementById('maxRent'); s.value = s.max; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.check('#allInToggle').catch(e => find('low', 'filters', 'all-in toggle not clickable', e.message));
    await page.check('#isoToggle').catch(() => note('reach toggle hidden (no isochrones)'));
    await settle(page, 1200);
    if (await page.locator('#isoToggle').isChecked().catch(() => false)) {
      if (!(await page.locator('path.iso-area').count())) find('medium', 'isochrones', 'reach toggle on but nothing drawn');
      await shot(page, 'reach');
      await page.uncheck('#isoToggle');
    }
    await page.uncheck('#allInToggle').catch(() => {});
  });

  await step('campus finder', async () => {
    if (!(await page.locator('#campusBtn').isVisible())) { find('medium', 'campus', 'no campus map button for KTH'); return; }
    await page.click('#campusBtn'); await settle(page, 1500);
    await shot(page, 'campus-kth');
    // What the deployed page and the OSM data hold for KTH's main building,
    // so a miss on "Kollegiesalen" can be told apart: old page, or no data.
    note(`KTH main building in campus data: ${JSON.stringify(await page.evaluate(() => ({
      pageKnowsHall: typeof CAMPUS_RULES !== 'undefined' && !!CAMPUS_RULES.KTH.halls.Kollegiesalen,
      buildings: campusData.buildings.length,
      matches: campusData.buildings.filter(b => /huvud|main|brinell|valhalla/i.test([b.name, b.alt, b.addr].join(' ')))
        .map(b => [b.name, b.alt, b.addr].filter(Boolean).join(' / ')).slice(0, 8) })))}`);
    for (const q of ['D2', 'Q1', 'M1', 'E2', 'V1', 'bibliotek', 'Nymble', 'café', 'Kollegiesalen', 'R207']) {
      await page.fill('#campusQ', q); await settle(page, 700);
      const res = (await page.locator('#campusResults').innerText()).replace(/\s+/g, ' ').slice(0, 160);
      const nt = await page.locator('#campusNote').isVisible()
        ? (await page.locator('#campusNote').innerText()).replace(/\s+/g, ' ').slice(0, 120) : '';
      note(`campus KTH "${q}": ${nt || res}`);
      if (/Nothing found/.test(res)) find('low', 'campus', `KTH search "${q}" finds nothing`);
    }
    await shot(page, 'campus-search');
    await page.click('#campusExit'); await settle(page);
    await page.selectOption('#schoolSelect', 'SU'); await settle(page, 800);
    if (await page.locator('#campusBtn').isVisible()) {
      await page.click('#campusBtn'); await settle(page, 1500);
      for (const q of ['D7', 'E10', 'De Geersalen', 'Aula Magna', 'bibliotek']) {
        await page.fill('#campusQ', q); await settle(page, 700);
        const res = (await page.locator('#campusResults').innerText()).replace(/\s+/g, ' ').slice(0, 160);
        const nt = await page.locator('#campusNote').isVisible()
          ? (await page.locator('#campusNote').innerText()).replace(/\s+/g, ' ').slice(0, 120) : '';
        note(`campus SU "${q}": ${nt || res}`);
        if (/Nothing found/.test(res)) find('low', 'campus', `SU search "${q}" finds nothing`);
      }
      await shot(page, 'campus-su');
      await page.click('#campusExit');
    }
    await page.selectOption('#schoolSelect', 'KTH');
  });

  await step('watch panel', async () => {
    await page.click('#watchToggle'); await settle(page);
    await shot(page, 'watch', { clip: { x: 1080, y: 150, width: 360, height: 750 } });
    await page.click('#watchToggle');
  });

  await step('share link', async () => {
    const id = await page.evaluate(() => currentData.listings[0].id);
    const p2 = await ctx.newPage(); watch(p2, 'share link');
    await p2.goto(`${SITE}/?listing=${encodeURIComponent(id)}#stockholm`, { waitUntil: 'networkidle' });
    await settle(p2, 1500);
    const t = await p2.locator('#panelTitle').innerText();
    if (/All available/i.test(t)) find('medium', 'share', 'listing link did not open the listing', id);
    await p2.close();
  });
  await ctx.close();
}

// ── Other cities, Swedish ─────────────────────────────────────────────────
for (const [city, lang] of [['goteborg', 'en'], ['lund', 'en'], ['stockholm', 'sv']]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const L = `${city}/${lang}`;
  watch(page, L);
  await step(L, async () => {
    await page.goto(`${SITE}/${lang === 'sv' ? '?lang=sv' : ''}#${city}`, { waitUntil: 'networkidle', timeout: 60000 });
    await settle(page, 1500);
    await shot(page, `${city}-${lang}`);
    await overflow(page, L);
    const n = await page.locator('#listings .listing-row').count();
    note(`${L}: ${n} rows in the default list`);
    if (lang === 'sv') {
      // English left behind in the Swedish UI.
      const text = await page.evaluate(() => document.body.innerText);
      const english = ['Want to get notified', 'All available', 'queue days', 'kr / month', 'Clear selection', 'pass your filters', 'Nothing matches', 'per month', 'apply before'];
      const left = english.filter(w => text.includes(w));
      if (left.length) find('low', 'i18n', 'English strings on the Swedish page', left.join(' · '));
      await page.click('#tabMarket'); await settle(page); await shot(page, 'market-sv');
      await page.click('#tabQueues'); await settle(page); await shot(page, 'queues-sv');
    }
  });
  await ctx.close();
}

// ── Phone ─────────────────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  const L = 'phone';
  watch(page, L);
  await step(L, async () => {
    await page.goto(`${SITE}/#stockholm`, { waitUntil: 'networkidle', timeout: 60000 });
    await settle(page, 1500);
    await shot(page, 'phone');
    await overflow(page, L);
    await axe(page, L);
    const rv = await visibleMarkers(page, '.area-roundel', true);
    if (rv.length) { await page.touchscreen.tap(rv[0].x, rv[0].y); await settle(page, 1300); await shot(page, 'phone-area'); }
    await page.evaluate(() => leafletMap.setView(centre(), 12, { animate: false }));
    await settle(page, 700);
    const pv = await visibleMarkers(page, '.bf-pin');
    if (pv.length) { await page.touchscreen.tap(pv[0].x, pv[0].y); await settle(page, 600); await shot(page, 'phone-pin');
      if (!(await page.locator('#hoverCard').isVisible())) find('low', 'phone', 'tapping a pin shows no card'); }
    await page.click('#tabQueues'); await settle(page); await shot(page, 'phone-queues', { fullPage: true });
    await overflow(page, 'phone queues');
  });
  await ctx.close();
}

await browser.close();

// ── Report ────────────────────────────────────────────────────────────────
const order = { high: 0, medium: 1, low: 2 };
findings.sort((a, b) => order[a.severity] - order[b.severity]);
// Collapse repeats (the same console error on every page, say).
const seen = new Map();
for (const f of findings) {
  const k = `${f.severity}|${f.what}|${f.detail.slice(0, 120)}`;
  if (seen.has(k)) seen.get(k).count++; else seen.set(k, { ...f, count: 1 });
}
const uniq = [...seen.values()];
const md = [`# Live exploration — ${new Date().toISOString()}`, '', `Site: ${SITE}`, '',
  `## Findings (${uniq.length})`, '',
  ...uniq.map(f => `- **${f.severity}** [${f.area}] ${f.what}${f.count > 1 ? ` ×${f.count}` : ''}${f.detail ? `\n  \`${f.detail.replace(/`/g, "'")}\`` : ''}`),
  '', '## Notes', '', ...notes.map(n => `- ${n}`),
  '', '## Screenshots', '', ...shots.map(s => `- ${s}`), ''].join('\n');
fs.writeFileSync(path.join(OUT, 'report.md'), md);
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ findings: uniq, notes, shots }, null, 1));
console.log(md);
