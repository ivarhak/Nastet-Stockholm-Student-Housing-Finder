// A wider, rougher pass than explore.mjs, run after it by explore.yml:
//
//   node scripts/sweep.mjs <out-dir> [site-url]
//
// Pokes every control it can find — chips, sliders, inputs with odd values,
// row actions, compare, city picker, theme and language toggles, legal page,
// keyboard-only use, resizing, a broken network, bogus URLs — in both themes,
// both languages, on desktop, tablet and phone. After each step it runs the
// same visual audit: clipped text, text overlapping other text, words split
// across lines, "undefined"/"NaN" and raw string keys on screen, broken
// images, things sticking out of the window, focus you can't see. Writes
// sweep.md / sweep.json and sweep-*.png next to explore's report.
import { chromium, devices } from 'playwright';
import fs from 'fs';
import path from 'path';

const OUT = process.argv[2] || 'explore-out';
const SITE = (process.argv[3] || 'https://xn--nstet-gra.se').replace(/\/$/, '');
fs.mkdirSync(OUT, { recursive: true });

const findings = [];
const notes = [];
const shots = [];
const find = (severity, area, what, detail = '') => findings.push({ severity, area, what, detail: String(detail).slice(0, 700) });
const note = s => notes.push(s);
let curStep = '';

let shotN = 0;
async function shot(page, name, opts = {}) {
  const file = `sweep-${String(++shotN).padStart(2, '0')}-${name}.png`;
  try { await page.screenshot({ path: path.join(OUT, file), ...opts }); shots.push(file); } catch (e) { note(`screenshot ${name} failed: ${e.message}`); }
}
const settle = (page, ms = 600) => page.waitForTimeout(ms);

function watch(page, label) {
  page.on('pageerror', e => find('high', label, 'Uncaught page error',
    `${e.message} @ ${(e.stack || '').split('\n').slice(1, 4).join(' / ')} (during: ${curStep})`));
  page.on('console', m => {
    if (m.type() === 'error') find('medium', label, 'Console error', `${m.text()} (during: ${curStep})`);
    else if (m.type() === 'warning') note(`console warning [${label}] ${m.text().slice(0, 200)}`);
  });
  page.on('requestfailed', r => {
    const u = r.url();
    if (/cartocdn|tile|google/.test(u) || r.failure()?.errorText === 'net::ERR_ABORTED') return;
    find('medium', label, 'Request failed', `${u} — ${r.failure()?.errorText} (during: ${curStep})`);
  });
  page.on('response', r => {
    if (r.status() >= 400 && r.url().startsWith(SITE)) find('medium', label, `HTTP ${r.status()}`, `${r.url()} (during: ${curStep})`);
  });
}

async function step(label, fn) {
  curStep = label;
  try { await fn(); } catch (e) { find('high', label, 'Flow broke', e.stack?.split('\n').slice(0, 3).join(' ') || e.message); }
}

// ── The visual audit, run in the page ─────────────────────────────────────
async function audit(page, label) {
  const r = await page.evaluate(() => {
    const out = { clipped: [], overlap: [], split: [], junk: [], broken: [], offscreen: [] };
    const vw = innerWidth, vh = innerHeight;
    const MAP_PANES = '.leaflet-tile-pane, .leaflet-overlay-pane, .leaflet-marker-pane, .leaflet-shadow-pane';
    const shown = el => {
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };
    const desc = el => {
      const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls} "${(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50)}"`;
    };
    const ownText = el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    const scrollsX = el => { for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) { const o = getComputedStyle(e).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
    const inView = r => r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    const els = [...document.querySelectorAll('body *')].filter(el =>
      !el.closest(MAP_PANES) && !el.closest('svg') && !['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(el.tagName));
    const textEls = els.filter(el => ownText(el) && shown(el));

    for (const el of textEls) {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (!inView(r)) continue;
      // Clipped: text wider than its box, cut off by overflow (ellipsis is a choice, but it's noted).
      if ((s.overflowX === 'hidden' || s.textOverflow === 'ellipsis') && el.scrollWidth > el.clientWidth + 2)
        out.clipped.push(`${desc(el)} ${el.scrollWidth}>${el.clientWidth}${s.textOverflow === 'ellipsis' ? ' (ellipsis)' : ''}`);
      if (s.overflowY === 'hidden' && s.webkitLineClamp === 'none' && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 3)
        out.clipped.push(`${desc(el)} height ${el.scrollHeight}>${el.clientHeight}`);
      // Sticking out of the window with nothing to scroll it into view.
      if ((r.right > vw + 1 || r.left < -1) && !scrollsX(el) && s.position !== 'fixed')
        out.offscreen.push(`${desc(el)} x ${Math.round(r.left)}–${Math.round(r.right)} of ${vw}`);
    }

    // Words split across two lines without a hyphen. A soft hyphen is a
    // deliberate break point, so words carrying one are skipped.
    for (const el of textEls) {
      for (const n of el.childNodes) {
        if (n.nodeType !== 3) continue;
        const text = n.textContent; const re = /[\p{L}\p{N}­]{4,}/gu; let m;
        while ((m = re.exec(text))) {
          if (m[0].includes('­')) continue;
          const rg = document.createRange(); rg.setStart(n, m.index); rg.setEnd(n, m.index + m[0].length);
          const rs = [...rg.getClientRects()].filter(x => x.width > 0);
          if (!rs.length || !inView(rs[0])) continue;
          if (new Set(rs.map(x => Math.round(x.top / 3))).size > 1) out.split.push(`${desc(el)} — "${m[0]}"`);
        }
      }
    }

    // Text on top of other text. Only text that's actually showing at its own
    // centre counts, so content under an open dialog isn't compared.
    const boxes = [];
    for (const el of textEls) {
      for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) {
        const rg = document.createRange(); rg.selectNodeContents(n);
        for (const b of rg.getClientRects()) {
          if (b.width < 3 || b.height < 3 || !inView(b)) continue;
          const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          if (top && (top === el || el.contains(top) || top.contains(el))) boxes.push({ el, b });
        }
      }
    }
    const seen = new Set();
    for (let i = 0; i < boxes.length && i < 1500; i++) for (let j = i + 1; j < boxes.length && j < 1500; j++) {
      const A = boxes[i], B = boxes[j];
      if (A.el === B.el || A.el.contains(B.el) || B.el.contains(A.el)) continue;
      const w = Math.min(A.b.right, B.b.right) - Math.max(A.b.left, B.b.left);
      const h = Math.min(A.b.bottom, B.b.bottom) - Math.max(A.b.top, B.b.top);
      if (w > 4 && h > 4) {
        const k = desc(A.el) + '|' + desc(B.el);
        if (!seen.has(k)) { seen.add(k); out.overlap.push(`${desc(A.el)} ⨯ ${desc(B.el)} (${Math.round(w)}×${Math.round(h)}px)`); }
      }
    }

    // Values that leaked through unformatted, and untranslated string keys.
    const body = document.body.innerText;
    for (const m of body.matchAll(/(^|[^\p{L}])(undefined|NaN|null|\[object Object\]|Invalid Date|Infinity)(?![\p{L}])/gu))
      out.junk.push(body.slice(Math.max(0, m.index - 40), m.index + 50).replace(/\s+/g, ' '));
    if (typeof I18N !== 'undefined') {
      const keys = new Set(Object.keys(I18N.sv));
      for (const m of body.matchAll(/\b[a-z]{1,10}_[a-z0-9_]{1,20}\b/g)) if (keys.has(m[0])) out.junk.push(`raw key ${m[0]}`);
    }
    for (const img of document.images) if (shown(img) && img.complete && img.naturalWidth === 0) out.broken.push(img.currentSrc || img.src);
    for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].slice(0, 12);
    return out;
  });
  if (r.split.length) find('medium', label, 'Word split across lines', r.split.join(' | '));
  if (r.overlap.length) find('medium', label, 'Text overlaps other text', r.overlap.join(' | '));
  const realClip = r.clipped.filter(x => !/\(ellipsis\)/.test(x));
  if (realClip.length) find('low', label, 'Text clipped by its box', realClip.join(' | '));
  if (r.clipped.length > realClip.length) note(`[${label}] ellipsised: ${r.clipped.filter(x => /\(ellipsis\)/.test(x)).join(' | ').slice(0, 300)}`);
  if (r.offscreen.length) find('medium', label, 'Content outside the window', r.offscreen.join(' | '));
  if (r.junk.length) find('high', label, 'Raw value on screen', r.junk.join(' | '));
  if (r.broken.length) find('medium', label, 'Broken image', r.broken.join(' | '));
  const o = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  if (o[0] > o[1] + 1) find('medium', label, 'Horizontal page overflow', `scrollWidth ${o[0]} > ${o[1]}`);
}

const rows = page => page.locator('#listings .listing-row').count();
const markers = page => page.locator('.leaflet-marker-icon').count();
const resetMap = page => page.evaluate(() => { leafletMap.setView(centre(), 12, { animate: false }); });
const visible = async (page, sel) => (await page.locator(sel).count()) > 0 && page.locator(sel).first().isVisible();

async function load(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await settle(page, 1500);
}

// Keyboard only: Tab through the page and check focus is visible and lands
// somewhere that can be seen.
async function keyboard(page, label, presses = 70) {
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); });
  const invisible = new Set(), hidden = new Set(); let stuck = 0, last = '';
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(120);       // panning to a focused marker is animated
    const f = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const ring = e => { const c = getComputedStyle(e); return (c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) > 0) || c.boxShadow !== 'none'; };
      const child = el.firstElementChild;
      // Inside the map, "seen" means inside the map's own box.
      const box = el.closest('.leaflet-container')?.getBoundingClientRect() || { top: 0, left: 0, right: innerWidth, bottom: innerHeight };
      return {
        d: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} "${(el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`,
        ring: ring(el) || (child && ring(child)) || s.textDecorationLine.includes('underline'),
        seen: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && r.bottom > box.top && r.top < box.bottom && r.right > box.left && r.left < box.right,
      };
    });
    if (!f) continue;
    if (f.d === last) stuck++; last = f.d;
    if (!f.seen) hidden.add(f.d);
    else if (!f.ring) invisible.add(f.d);
  }
  if (hidden.size) find('medium', label, 'Keyboard focus lands on something you can’t see', [...hidden].slice(0, 10).join(' | '));
  if (invisible.size) find('low', label, 'No visible focus indicator', [...invisible].slice(0, 10).join(' | '));
  if (stuck > 3) find('medium', label, 'Keyboard focus stuck', last);
}

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });

// ── Desktop, dark, English: everything ────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: SITE });
  const page = await ctx.newPage();
  const L = 'desktop';
  watch(page, L);
  await step('start', async () => { await load(page, `${SITE}/#stockholm`); await audit(page, 'desktop start'); });

  await step('city picker', async () => {
    if (!(await visible(page, '#cityBtn'))) { note('no city picker'); return; }
    await page.click('#cityBtn'); await settle(page, 400);
    await shot(page, 'city-picker'); await audit(page, 'city picker');
    const n = await page.locator('#cityOptions button').count();
    const names = await page.locator('#cityOptions button').allInnerTexts();
    note(`city picker: ${n} options — ${names.map(s => s.replace(/\s+/g, ' ')).join(' / ')}`);
    await page.keyboard.press('Escape'); await settle(page, 300);
    if (n && await page.locator('#cityOptions button').first().isVisible()) find('low', 'city picker', 'Escape does not close the city picker');
    for (let i = 0; i < n; i++) {
      await page.click('#cityBtn'); await settle(page, 300);
      const opt = page.locator('#cityOptions button').nth(i);
      const name = (await opt.innerText()).split('\n')[0];
      await opt.click(); await settle(page, 1800);
      const hash = await page.evaluate(() => location.hash);
      note(`picked "${name}" → ${hash}, ${await rows(page)} rows, ${await markers(page)} markers`);
      await audit(page, `city ${hash}`);
      if (!(await rows(page))) find('medium', 'city picker', `no rows after picking ${name}`);
    }
    await load(page, `${SITE}/#stockholm`);
  });

  await step('theme + language toggles', async () => {
    await page.click('#themeToggle'); await settle(page, 500);
    note(`theme after toggle: ${await page.evaluate(() => document.documentElement.dataset.theme || '')}`);
    await shot(page, 'toggled-theme'); await audit(page, 'toggled theme');
    await page.click('#themeToggle'); await settle(page, 400);
    await page.click('#langToggle'); await settle(page, 700);
    await shot(page, 'toggled-sv'); await audit(page, 'toggled to sv');
    const lang = await page.evaluate(() => document.documentElement.lang);
    if (lang !== 'sv') find('medium', 'language', 'language toggle did not switch <html lang>', lang);
    await page.click('#tabQueues'); await settle(page); await audit(page, 'sv queues');
    await page.click('#tabMarket'); await settle(page); await audit(page, 'sv market');
    await page.click('#tabListings'); await settle(page);
    await page.click('#langToggle'); await settle(page, 700);
  });

  await step('filter chips', async () => {
    const chips = page.locator('#filterBar button[aria-pressed], #providerChips button');
    const n = await chips.count();
    const base = [await rows(page), await markers(page)];
    note(`filter chips: ${n}; baseline ${base[0]} rows, ${base[1]} markers`);
    for (let i = 0; i < n; i++) {
      const c = chips.nth(i);
      if (!(await c.isVisible())) continue;
      const name = (await c.innerText()).replace(/\s+/g, ' ').trim();
      await c.click(); await settle(page, 700);
      const after = [await rows(page), await markers(page)];
      note(`chip "${name}" → ${after[0]} rows, ${after[1]} markers, pressed=${await c.getAttribute('aria-pressed')}`);
      await audit(page, `chip ${name} toggled`);
      await c.click(); await settle(page, 700);
      const back = [await rows(page), await markers(page)];
      if (back[0] !== base[0] || back[1] !== base[1]) find('medium', 'filters', `chip "${name}" doesn't restore when toggled back`, `${base} → ${after} → ${back}`);
    }
  });

  await step('sliders', async () => {
    await page.click('#advToggle').catch(() => {}); await settle(page, 400);
    await shot(page, 'advanced-filters'); await audit(page, 'advanced filters open');
    const ids = await page.evaluate(() => [...document.querySelectorAll('input[type=range]')].filter(e => e.offsetParent).map(e => e.id));
    const base = await rows(page);
    for (const id of ids) {
      const orig = await page.evaluate(id => document.getElementById(id).value, id);
      for (const where of ['min', 'mid', 'max']) {
        await page.evaluate(([id, where]) => {
          const s = document.getElementById(id);
          s.value = where === 'min' ? +s.min : where === 'max' ? +s.max : (+s.min + +s.max) / 2;
          s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
        }, [id, where]);
        await settle(page, 350);
        const label = await page.evaluate(id => { const l = document.getElementById(id + 'Label'); return l ? l.textContent.trim() : ''; }, id);
        note(`slider ${id} at ${where}: label "${label}", ${await rows(page)} rows`);
        if (/NaN|undefined/.test(label)) find('high', 'filters', `slider ${id} label shows ${label}`);
        if (where !== 'mid') await audit(page, `slider ${id} ${where}`);
      }
      await page.evaluate(([id, v]) => { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); }, [id, orig]);
      await settle(page, 300);
    }
    const after = await rows(page);
    if (after !== base) find('medium', 'filters', 'rows differ after putting every slider back', `${base} → ${after}`);
    if (await visible(page, '#moveBy')) {
      for (const v of ['2020-01-01', '2030-12-31']) {
        await page.fill('#moveBy', v); await page.locator('#moveBy').dispatchEvent('change'); await settle(page, 400);
        note(`move-in by ${v}: ${await rows(page)} rows`);
        await audit(page, `move-in by ${v}`);
      }
      await page.fill('#moveBy', ''); await page.locator('#moveBy').dispatchEvent('change'); await settle(page, 400);
    }
    if (await visible(page, '#advReset')) { await page.click('#advReset'); await settle(page, 500); }
    await page.click('#advToggle').catch(() => {});
  });

  await step('search with odd input', async () => {
    await page.click('#browseAllBtn'); await settle(page);
    for (const q of ['<b>x</b>', '(', '\\', 'KUNGSHAMRA', 'kungshamra ', 'Lappkarrsberget', 'ä', '   ', '1 rum']) {
      await page.fill('#searchInput', q); await settle(page, 350);
      note(`search ${JSON.stringify(q)}: ${await rows(page)} rows${(await page.locator('.empty-state').count()) ? ' (empty state)' : ''}`);
    }
    await page.fill('#searchInput', 'a'.repeat(300)); await settle(page, 300); await audit(page, 'very long search');
    await page.fill('#searchInput', ''); await settle(page, 300);
    await page.click('#browseAllBtn'); await settle(page);
  });

  await step('row actions + persistence', async () => {
    await page.evaluate(() => { localStorage.removeItem('nastet-marks'); localStorage.removeItem('nastet-compare'); });
    await load(page, `${SITE}/#stockholm`);
    const before = await rows(page);
    const rowMark = (i, k) => page.locator('#listings .listing-row').nth(i).locator('.row-acts .mark').nth(k);
    await rowMark(0, 0).click(); await settle(page, 300);       // save the first
    await rowMark(1, 1).click(); await settle(page, 300);       // mark the second applied
    await shot(page, 'marked-rows', { clip: { x: 1100, y: 200, width: 340, height: 700 } });
    await audit(page, 'after save + applied');
    const t2 = (await page.locator('#listings .listing-row .row-open').nth(2).innerText()).trim();
    await rowMark(2, 2).click(); await settle(page, 500);       // hide the third
    const afterHide = await rows(page);
    note(`hide "${t2}": rows ${before} → ${afterHide}`);
    if (afterHide !== before - 1) find('medium', 'marks', 'hiding a listing did not remove exactly one row', `${before} → ${afterHide}`);
    const way = await page.evaluate(() => document.body.innerText.match(/[^\n]*(hidden|dold)[^\n]*/i)?.[0] || '');
    note(`after hiding, a way back: "${way.slice(0, 120)}"`);
    if (!way) find('low', 'marks', 'after hiding a listing there is no visible way to see or undo it');
    await load(page, `${SITE}/#stockholm`);
    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('nastet-marks') || '{}'));
    note(`marks after reload: ${JSON.stringify(Object.values(persisted).map(v => v.m))}`);
    if (Object.keys(persisted).length !== 3) find('medium', 'marks', 'marks did not all survive a reload', JSON.stringify(persisted));
    if (await rows(page) !== afterHide) find('medium', 'marks', 'hidden listing back after reload', `${afterHide} vs ${await rows(page)}`);
    await page.evaluate(() => localStorage.removeItem('nastet-marks'));
    await load(page, `${SITE}/#stockholm`);
  });

  await step('compare', async () => {
    const n = Math.min(4, await rows(page));
    for (let i = 0; i < n; i++) {
      await page.locator('#listings .listing-row').nth(i).locator('.row-acts .mark').nth(3).click(); await settle(page, 300);
    }
    const bar = (await page.locator('#compareBar').innerText()).replace(/\s+/g, ' ');
    note(`compare bar after ${n} clicks: "${bar}"`);
    if (!bar.includes(`${Math.min(3, n)}/3`)) find('medium', 'compare', `compare bar does not show ${Math.min(3, n)}/3 after ${n} clicks`, bar);
    await audit(page, 'compare bar');
    await page.locator('#compareBar button').first().click(); await settle(page, 600);
    await shot(page, 'compare-modal'); await audit(page, 'compare modal');
    await page.keyboard.press('Escape'); await settle(page, 300);
    if (await page.locator('#compareModal').isVisible()) find('medium', 'compare', 'Escape does not close the compare dialog');
    await page.locator('#compareBar button.ghost').click(); await settle(page, 300);
    if (await page.locator('#compareBar').isVisible()) find('low', 'compare', 'Clear did not hide the compare bar');
  });

  await step('area select + browser back', async () => {
    await resetMap(page); await settle(page, 600);
    const hit = await page.evaluate(() => {
      const m = document.getElementById('map').getBoundingClientRect();
      for (const e of document.querySelectorAll('.area-roundel')) {
        const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        const icon = e.closest('.leaflet-marker-icon'); const l = icon.getAttribute('aria-label') || '';
        if (x > m.left + 30 && x < m.right - 30 && y > m.top + 30 && y < m.bottom - 30 && icon.contains(document.elementFromPoint(x, y))
            && /available/.test(l) && !/none/.test(l)) return { x, y, l };
      }
      return null;
    });
    if (!hit) { note('no clickable area for the back test'); return; }
    const url0 = page.url();
    await page.mouse.click(hit.x, hit.y); await settle(page, 1300);
    const url1 = page.url(); const title1 = await page.locator('#panelTitle').innerText();
    await audit(page, 'area selected');
    const dot = page.locator('.listing-dot').first();
    if (await dot.count()) {
      const b = await dot.boundingBox();
      if (b) { await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await settle(page, 800); await audit(page, 'building dot clicked'); await shot(page, 'dot-clicked'); }
    }
    await page.goBack().catch(() => {}); await settle(page, 1200);
    const url2 = page.url(); const title2 = await page.locator('#panelTitle').innerText().catch(() => '(page left)');
    note(`back: ${url0} → select "${hit.l}" (${url1}, "${title1.split('\n')[0]}") → back → ${url2}, "${title2.split('\n')[0]}"`);
    if (!url2.startsWith(SITE)) find('medium', 'navigation', 'Back after selecting an area leaves the site', url2);
    await load(page, `${SITE}/#stockholm`);
  });

  await step('map extremes', async () => {
    for (const z of [18, 9, 5, 14]) {
      await page.evaluate(z => { leafletMap.setZoom(z, { animate: false }); }, z); await settle(page, 700);
      note(`zoom ${z}: ${await markers(page)} markers`);
    }
    await page.evaluate(() => { leafletMap.panBy([3000, 3000], { animate: false }); }); await settle(page, 600);
    await audit(page, 'map panned away'); await shot(page, 'map-panned-away');
    await resetMap(page);
  });

  await step('rapid clicking', async () => {
    await resetMap(page); await settle(page, 600);
    const pts = await page.evaluate(() => [...document.querySelectorAll('.area-roundel, .bf-pin')].slice(0, 8).map(e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }));
    for (const [x, y] of pts) { await page.mouse.click(x, y); await page.waitForTimeout(60); }
    await settle(page, 1500);
    await audit(page, 'after rapid clicks');
    await page.locator('.clear-sel').click().catch(() => {});
    await page.dblclick('#tabQueues'); await page.click('#tabMarket'); await page.click('#tabListings'); await settle(page, 600);
    await audit(page, 'after rapid tab switching');
  });

  await step('queues tab inputs', async () => {
    await page.click('#tabQueues'); await settle(page);
    await audit(page, 'queues');
    for (const v of ['-5', '99999', 'abc', '0', '1500']) {
      await page.fill('#pfDays', v).catch(() => {}); await page.locator('#pfDays').dispatchEvent('change'); await settle(page, 300);
      const txt = await page.locator('#queues').innerText();
      if (/NaN|undefined|Infinity/.test(txt)) find('high', 'profile', `queue days "${v}" puts a raw value on screen`, txt.match(/.{0,40}(NaN|undefined|Infinity).{0,40}/)?.[0]);
    }
    await page.fill('#pfBudget', '1').catch(() => {}); await page.locator('#pfBudget').dispatchEvent('change').catch(() => {});
    await settle(page, 300);
    await audit(page, 'queues with odd profile');
    const btns = page.locator('#queues button:visible');
    const labels = await btns.allInnerTexts();
    note(`queues buttons: ${labels.map(s => s.replace(/\s+/g, ' ').trim()).join(' / ')}`);
    for (let i = 0; i < labels.length; i++) {
      if (!/\.ics|calendar|kalender|remind|påminn/i.test(labels[i])) continue;
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 4000 }).catch(() => null), btns.nth(i).click()]);
      if (!dl) { find('low', 'queues', `"${labels[i].trim()}" gave no download`); break; }
      const p = await dl.path(); const body = p ? fs.readFileSync(p, 'utf8') : '';
      note(`download ${dl.suggestedFilename()} (${body.length} bytes)`);
      if (!/BEGIN:VCALENDAR[\s\S]*BEGIN:VEVENT[\s\S]*END:VCALENDAR/.test(body)) find('medium', 'queues', `${dl.suggestedFilename()} is not a valid calendar file`, body.slice(0, 200));
      if (/[^\r]\n/.test(body)) find('low', 'queues', `${dl.suggestedFilename()} has bare LF line endings (RFC 5545 wants CRLF)`);
      break;
    }
    await shot(page, 'queues-odd');
    await page.evaluate(() => localStorage.removeItem('nastet-profile'));
    await page.click('#tabMarket'); await settle(page); await audit(page, 'market');
    await page.click('#tabListings'); await settle(page);
  });

  await step('watch + discord + legal', async () => {
    await page.click('#watchToggle'); await settle(page, 400);
    await audit(page, 'watch panel open');
    if (await visible(page, '#discordCopy')) {
      await page.click('#discordCopy'); await settle(page, 300);
      const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
      note(`discord copy → clipboard "${clip.slice(0, 80)}"`);
    }
    await page.click('#watchToggle'); await settle(page, 300);
    await page.click('#legalLink'); await settle(page, 500);
    await shot(page, 'legal'); await audit(page, 'legal overlay');
    await page.keyboard.press('Escape'); await settle(page, 300);
    if (await page.locator('#legalOverlay').isVisible()) find('low', 'legal', 'Escape does not close the privacy page');
  });

  await step('keyboard only', async () => {
    await load(page, `${SITE}/#stockholm`);
    await keyboard(page, 'keyboard desktop');
    await shot(page, 'keyboard-end');
  });

  await step('resizing', async () => {
    for (const [w, h] of [[1280, 800], [1024, 768], [900, 700], [768, 1024], [600, 900]]) {
      await page.setViewportSize({ width: w, height: h }); await settle(page, 700);
      await audit(page, `resized ${w}×${h}`);
      if (w === 1024 || w === 768) await shot(page, `resized-${w}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });
  await ctx.close();
}

// ── Light theme and Swedish, the screens that matter ──────────────────────
for (const [theme, lang] of [['light', 'en'], ['light', 'sv'], ['dark', 'sv']]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(th => { try { localStorage.setItem('nastet-theme', th); } catch (e) {} }, theme);
  const page = await ctx.newPage();
  const L = `${theme}/${lang}`;
  watch(page, L);
  await step(L, async () => {
    await load(page, `${SITE}/${lang === 'sv' ? '?lang=sv' : ''}#stockholm`);
    await audit(page, `${L} listings`);
    for (const tab of ['#tabQueues', '#tabMarket']) { await page.click(tab); await settle(page); await audit(page, `${L} ${tab}`); }
    await page.click('#tabListings'); await settle(page);
    if (await page.locator('.plan-btn').count()) { await page.locator('.plan-btn').first().click(); await settle(page, 700); await audit(page, `${L} floor plan`); await page.keyboard.press('Escape'); }
    if (await visible(page, '#campusBtn')) {
      await page.click('#campusBtn'); await settle(page, 1500);
      await page.fill('#campusQ', 'D2'); await settle(page, 500);
      await audit(page, `${L} campus`); await shot(page, `campus-${theme}-${lang}`);
      await page.click('#campusExit'); await settle(page);
    }
    if (lang === 'sv') {
      const english = await page.evaluate(() => {
        const words = ['Want to get', 'All available', 'queue days', 'kr / month', 'Clear selection', 'pass your filters', 'Nothing matches',
          'per month', 'apply before', 'Floor plan', 'Compare', 'Save', 'Hide', 'Applied', 'listed', 'move-in', 'min bike', 'days short',
          'good value', 'over budget', 'Show reach', 'All-in', 'floor', 'quiet', 'noise', 'away'];
        const t = document.body.innerText;
        return words.filter(w => new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, 'iu').test(t));
      });
      if (english.length) find('low', 'i18n', `English left on the Swedish page (${L})`, english.join(' · '));
    }
  });
  await ctx.close();
}

// ── Other cities, deeper ──────────────────────────────────────────────────
for (const city of ['goteborg', 'lund']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  watch(page, city);
  await step(city, async () => {
    await load(page, `${SITE}/#${city}`);
    note(`${city} on load: ${await rows(page)} rows, campus ${await page.locator('#schoolSelect').inputValue()}, commute cap "${await page.locator('#maxCommuteLabel').innerText().catch(() => '?')}", panel "${(await page.locator('#listingCount').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120)}"`);
    await audit(page, `${city} start`);
    const schools = await page.locator('#schoolSelect option').evaluateAll(o => o.map(x => x.value));
    note(`${city} campuses: ${schools.join(', ')}; campus finder ${await visible(page, '#campusBtn') ? 'shown' : 'hidden'}`);
    for (const s of schools.slice(0, 4)) {
      await page.selectOption('#schoolSelect', s); await settle(page, 900);
      note(`${city} ${s}: ${await rows(page)} rows, commute cap "${await page.locator('#maxCommuteLabel').innerText().catch(() => '?')}", panel "${(await page.locator('#listingCount').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120)}"`);
      await audit(page, `${city} ${s}`);
    }
    await page.click('#tabMarket'); await settle(page); await audit(page, `${city} market`);
    await page.click('#tabQueues'); await settle(page); await audit(page, `${city} queues`);
    await shot(page, `${city}-queues`);
  });
  await ctx.close();
}

// ── Broken network, bogus URLs ────────────────────────────────────────────
{
  // The service worker would answer from its cache, past the blocked routes.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', e => find('high', 'failure modes', 'Uncaught page error', `${e.message} (during: ${curStep})`));
  await step('listings JSON fails', async () => {
    await page.route(/listings-.*\.json|\/api\/listings/, r => r.abort());
    await page.goto(`${SITE}/#stockholm`, { waitUntil: 'load', timeout: 60000 }); await settle(page, 4000);
    const txt = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 600);
    note(`with listings JSON blocked, the page says: "${txt.slice(0, 300)}"; ${await rows(page)} rows`);
    if (await rows(page)) find('high', 'failure modes', 'Listings shown although none could be loaded', txt.slice(0, 200));
    await shot(page, 'no-data');
    if (!/could ?n.?t|failed|error|try again|offline|kunde inte|fel/i.test(txt)) find('medium', 'failure modes', 'No error message when the listings can’t load', txt);
    await page.unroute(/listings-.*\.json|\/api\/listings/);
  });
  await step('cities.json fails', async () => {
    await page.route(/cities\.json|\/api\/cities/, r => r.abort());
    await page.goto(`${SITE}/#stockholm`, { waitUntil: 'load', timeout: 60000 }); await settle(page, 3000);
    note(`with cities.json blocked: ${await rows(page)} rows`);
    await shot(page, 'no-cities');
    await page.unroute(/cities\.json|\/api\/cities/);
  });
  for (const [what, url] of [['unknown city', '/#paris'], ['bogus listing', '/?listing=does-not-exist#stockholm'],
                             ['bogus lang', '/?lang=xx#stockholm'], ['empty hash', '/#'], ['listing of another city', '/?listing=x#lund']]) {
    await step(`url: ${what}`, async () => {
      await page.goto(SITE + url, { waitUntil: 'networkidle', timeout: 60000 }); await settle(page, 1500);
      const n = await rows(page);
      note(`${what} (${url}): ${n} rows, hash now ${await page.evaluate(() => location.hash)}, title "${(await page.locator('#panelTitle').innerText().catch(() => '')).split('\n')[0]}"`);
      if (!n) find('medium', 'urls', `${what} leaves an empty page`, url);
      await audit(page, `url ${what}`);
    });
  }
  await ctx.close();
}

// ── Phone and tablet ──────────────────────────────────────────────────────
for (const [name, dev] of [['phone', devices['Pixel 7']], ['phone-landscape', devices['Pixel 7 landscape']],
                           ['iphone-se', devices['iPhone SE']], ['tablet', devices['iPad Mini']]]) {
  const ctx = await browser.newContext({ ...dev });
  const page = await ctx.newPage();
  watch(page, name);
  await step(name, async () => {
    await load(page, `${SITE}/#stockholm`);
    await audit(page, `${name} start`);
    await shot(page, name, { fullPage: name === 'phone' });
    if (await visible(page, '#advToggle')) {
      await page.locator('#advToggle').tap(); await settle(page, 400);
      await audit(page, `${name} advanced filters`);
      await page.locator('#advToggle').tap();
    }
    if (await visible(page, '#cityBtn')) {
      await page.locator('#cityBtn').tap(); await settle(page, 400); await audit(page, `${name} city picker`); await shot(page, `${name}-city`);
      await page.keyboard.press('Escape'); await settle(page, 300);
    }
    for (const tab of ['#tabQueues', '#tabMarket', '#tabListings']) {
      await page.locator(tab).tap(); await settle(page, 500); await audit(page, `${name} ${tab}`);
    }
    if (await page.locator('.plan-btn').count()) {
      await page.locator('.plan-btn').first().scrollIntoViewIfNeeded(); await page.locator('.plan-btn').first().tap(); await settle(page, 700);
      await audit(page, `${name} floor plan`); await shot(page, `${name}-plan`);
      await page.keyboard.press('Escape'); await settle(page, 300);
    }
    const mk = (i, k) => page.locator('#listings .listing-row').nth(i).locator('.row-acts .mark').nth(k);
    await mk(0, 3).scrollIntoViewIfNeeded(); await mk(0, 3).tap();
    await mk(1, 3).scrollIntoViewIfNeeded(); await mk(1, 3).tap(); await settle(page, 300);
    await page.locator('#compareBar button').first().tap(); await settle(page, 600);
    await audit(page, `${name} compare`); await shot(page, `${name}-compare`);
    await page.keyboard.press('Escape'); await settle(page, 300);
    await page.locator('#compareBar button.ghost').tap().catch(() => {});
    if (await visible(page, '#campusBtn')) {
      await page.locator('#campusBtn').scrollIntoViewIfNeeded(); await page.locator('#campusBtn').tap(); await settle(page, 1500);
      await page.fill('#campusQ', 'bibliotek'); await settle(page, 500);
      await audit(page, `${name} campus`); await shot(page, `${name}-campus`);
      await page.locator('#campusExit').tap(); await settle(page, 400);
    }
    // Tap targets too small to hit with a thumb.
    const small = await page.evaluate(() => [...document.querySelectorAll('button, a, input, select, [role=button]')].filter(e => {
      const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && (r.width < 24 || r.height < 24)
        && !e.closest('.leaflet-control-attribution') && !(e.tagName === 'A' && getComputedStyle(e.parentElement).display !== 'flex');
    }).map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} "${(e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 24)}" ${Math.round(e.getBoundingClientRect().width)}×${Math.round(e.getBoundingClientRect().height)}`));
    if (small.length) find('low', name, `${small.length} tap targets under 24px`, [...new Set(small)].slice(0, 12).join(' | '));
  });
  await ctx.close();
}

await browser.close();

// ── Report ────────────────────────────────────────────────────────────────
const order = { high: 0, medium: 1, low: 2 };
findings.sort((a, b) => order[a.severity] - order[b.severity]);
const seen = new Map();
for (const f of findings) {
  const k = `${f.severity}|${f.what}|${f.detail.replace(/\(during: [^)]*\)/, '').slice(0, 160)}`;
  if (seen.has(k)) { const s = seen.get(k); s.count++; if (!s.areas.includes(f.area)) s.areas.push(f.area); }
  else seen.set(k, { ...f, areas: [f.area], count: 1 });
}
const uniq = [...seen.values()];
const md = [`# Sweep — ${new Date().toISOString()}`, '', `Site: ${SITE}`, '',
  `## Findings (${uniq.length})`, '',
  ...uniq.map(f => `- **${f.severity}** [${f.areas.slice(0, 4).join(', ')}${f.areas.length > 4 ? ` +${f.areas.length - 4}` : ''}] ${f.what}${f.count > 1 ? ` ×${f.count}` : ''}${f.detail ? `\n  \`${f.detail.replace(/`/g, "'")}\`` : ''}`),
  '', '## Notes', '', ...notes.map(n => `- ${n}`),
  '', '## Screenshots', '', ...shots.map(s => `- ${s}`), ''].join('\n');
fs.writeFileSync(path.join(OUT, 'sweep.md'), md);
fs.writeFileSync(path.join(OUT, 'sweep.json'), JSON.stringify({ findings: uniq, notes, shots }, null, 1));
console.log(md.slice(0, 20000));
