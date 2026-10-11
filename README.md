<img width="1822" height="1195" alt="image" src="https://github.com/user-attachments/assets/3bade46e-551e-4849-a50f-0a894ef2d645" />

# Nästet

**Nästet** ("the nest") is a student housing dashboard for Sweden. It gathers
every vacancy currently advertised by the major student landlords — SSSB and
Bostadsförmedlingen in Stockholm, SGS in Göteborg, AF Bostäder in Lund — works
out the commute from each address to your chosen campus, and puts the result on
one map instead of four separate queue portals.

It is read-only and asks nothing of you: no account, no sign-up, nothing
tracked. If you want to support the work, there's a Ko-fi link in the header.

**Live version:** [nästet.se](https://nästet.se) — published from this repo and
re-scraped hourly. Read-only; run it locally for desktop notifications
and an on-demand Refresh. See section 4.

The pieces:
- `monitor.py` — runs on your machine: Selenium scraping for SSSB, plain HTTP
  fetches for the other three providers, commute math, and a small local API.
- `index.html` — the UI. Served by the script itself locally, and published
  as-is to GitHub Pages, where it reads a pre-scraped `listings-<city>.json`
  instead of the API.
- `history.py` — the site's memory: every published scrape is recorded on the
  `data` branch, and summaries (`history-<city>.json`) drive the Market tab.
- `enrich.py` — build-time extras: SSSB floor plans, bike isochrones per
  campus, Stockholm's road and rail noise, and campus building maps.
- `og_image.py` — the link-preview picture, drawn with the live count.
- `worker/` — a Cloudflare Worker that keeps the hourly schedule and runs the
  optional Discord bot (section 4).

What the page does beyond the map:
- **Your queues** (Queues tab): queue days, dates, budget and move-in window,
  kept in your browser only. Every listing then says whether you would lead it
  today, and queue health warns before the 90-day union cap or the
  Bostadsförmedlingen fee date, with calendar reminders (.ics). Carry it to
  another device with a link or QR code.
- **Marks and compare**: save, mark as applied, or hide any listing; compare
  up to three side by side, including an **all-in monthly cost** (rent +
  electricity + insurance, assumptions dated) and its share of a CSN month.
- **Since your last visit**: what's new and what's gone.
- **Market tab**: how the market compares with usual, *Pick your 3*, how long
  until you're likely to get a place, a difficulty map mode, and listings that
  are back on the market. Each waits until enough history exists, and says how
  far along it is until then.
- **On the map**: hover a listing for a bigger card with the floor plan and
  noise level; shade where your max bike commute reaches; open a campus map and
  find a room by its code (KTH and SU so far).
- **Shareable links**: `?listing=<id>` and `?area=<name>` open straight to a
  listing or area.


## 1. Setup

**Double-click `start.command`** (`start.bat` on Windows). That's it.

It creates the virtual environment, installs the requirements, starts the
server and opens the dashboard in your browser. Everything except the last two
steps is skipped once it's been done, so every run after the first is just
"double-click, dashboard opens". Any arguments you pass go straight through, so
`./start.command --interval 30` works too.

The only prerequisites are **Python 3.10+** and **Chrome** (or Chromium).
`webdriver-manager` fetches the matching driver by itself. Chrome is only the
fallback path for reading SSSB's listing page (see "How it reads SSSB" in
section 3), but keep it installed so that fallback exists.

<details>
<summary>Prefer to do it by hand, or run it from an IDE?</summary>

```bash
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python monitor.py      # no arguments = serve the dashboard
```

Running with no arguments serves the dashboard, which is what you want almost
every time. In PyCharm or similar, point a run configuration at
`monitor.py` with no arguments and it'll do the same thing.
</details>

<details>
<summary>Putting it in your Dock or on your Desktop (macOS)</summary>

Drag `start.command` onto the Dock, or make an alias on the Desktop:

```bash
ln -s "$PWD/start.command" ~/Desktop/Nästet.command
```

The alias keeps working when you `git pull`, since it points at the file rather
than copying it. To give it a nicer icon, select the file in Finder, press
Cmd+I, and paste an image onto the small icon in the top-left of the Info window.
</details>

Optional, for **real transit times** (otherwise you'll just get the
straight-line/bike estimate): get a free key for the **Resrobot** API at
[trafiklab.se](https://www.trafiklab.se/) (sign up → create a project →
add the "Resrobot v2.1" API), then:

```bash
export RESROBOT_API_KEY="your key"
```

## 2. If the scrape ever comes back empty

`scrape_listings()` finds real listings by looking for links containing
`refid=` in the URL (confirmed against a real SSSB booking link), then reads
the area/rent/size/queue-days/floor values out of the surrounding card text.
If it ever comes back empty while you can see real listings on the site
yourself:

```bash
python monitor.py --debug
```

That runs a **visible** browser window (so you can watch what happens) and
saves the fully-rendered page to `debug_page.html`. Check whether that file
actually contains `refid=` anywhere (`grep -c "refid=" debug_page.html`) — if
SSSB changed their link format, that's the thing to update.

If instead the run reports listings but with empty queue days, SSSB has
probably put the "Ködagar" column back behind an account. The scrape prints
a warning telling you so — the values simply go missing rather than the run
failing, and every filter treats a missing value as "do not hide this".

Bostadsförmedlingen needs no selector fixing at all, since
`fetch_bostadsformedlingen()` reads a plain JSON feed rather than scraped
markup. If its field names ever drift, the terminal prints the first ad's
actual keys on every run, so you can fix the candidate names in `_bf_field()`
from that alone. The same goes for SGS and AF Bostäder — both are plain JSON
GETs.

**If a whole city comes back empty**, that is usually a source that didn't
answer rather than a landlord with no vacancies, and the two are now told
apart. The run prints the reason in full — the HTTP status with whatever
proxy or CDN sent it, or the actual TLS error rather than the bare word
`SSLError` — and the reason travels into the payload as `source_notes`, so the
dashboard says so at the top of the listings panel and links out to the
provider instead of showing a blank map captioned "No available listings here
right now". On GitHub Actions each failed source also raises a `::warning::`
on the run page, because a build that publishes an empty city otherwise reads
as a perfectly normal green one.

## 3. Running it

**Dashboard** — double-click `start.command`, or from a terminal:
```bash
python monitor.py          # no arguments needed
```
It scrapes if the saved listings are stale, serves the UI + API, and opens
**http://localhost:5055** in your browser by itself (`--no-browser` if you'd
rather it didn't). It then auto-checks SSSB in the background every 15 minutes
(change with `--interval 30`, don't go below 5 — see the rate-limiting note
below), and the dashboard polls for fresh results every 60 seconds, so you don't
need to click anything for it to notice new listings — you'll just see them
appear, plus the desktop notification. "Refresh" still triggers an immediate
check on demand instead of waiting for the next scheduled one.

While a check is running, **Refresh goes grey and tells you so**, with a running
timer under the button, and stays unclickable until it finishes. Clicking it
again wouldn't have made anything happen faster — scrapes run one at a time, so a
second click just queued up another full one behind the first. The page updates
itself the moment the data lands, so there's nothing to click. The same applies
while the background auto-check is running, and it survives reloading the page
mid-check.

If that startup scrape fails — SSSB briefly down, no network, Chrome missing —
the dashboard still comes up and serves the last listings it saved, and says in
the terminal what went wrong. The background auto-check retries on its own.

**One-off check** (scrapes once, saves, notifies if there's something new, exits):
```bash
python monitor.py --once
```
This one *does* exit non-zero if the scrape fails, since it's what cron runs and
a silent success would be worse than a loud failure.

> Opening the .html directly as a file  shows example data with a banner saying so — the live version only
> works served from `http://localhost:5055` since that's what makes the
> `/api/...` calls same-origin.

### How it reads SSSB

A normal run first tries reading the vacancy list with a plain HTTP request,
and only launches Chrome if that comes back empty — which makes the usual case
noticeably faster, since no browser has to start at all. You don't need to
think about this; it's automatic.

`--http-only` forces the fast path and fails loudly instead of falling back,
which is handy for checking whether it still works. If the page ever does need
a real browser, that run tells you so and prints any API-looking URLs it found
in the page, since one of those is probably the endpoint the page fetches its
listings from.

## 4. The published version (GitHub Pages)

There's a **live read-only copy** of the dashboard published from this repo, so
you can look at current listings without running anything:

> **https://nästet.se**

A GitHub Actions workflow (`.github/workflows/publish.yml`) scrapes every
provider **hourly** (see the Worker below), writes one `listings-<city>.json` next to the
dashboard, and deploys them to Pages. The page picks up a new scrape on its own — a tab
left open re-checks the data file every 15 minutes.

It's the **same .html as the local version, not a second
copy to keep in sync. When no local server answers, it falls back to reading
`./listings.json` and adjusts: the Refresh button disappears (there's no server
to ask for a re-scrape) and a line in its place says how often the data updates
and where it comes from. Everything else — map, filters, campus picker, search,
both themes — works identically.

What the published version can't do, by nature:

- **No Refresh.** Re-scraping needs a token, and a token cannot live in a public
  static page. The schedule is the refresh.
- **No desktop notifications.** Those are the reason to run it locally.
- **Freshness depends on the Worker.** GitHub's own scheduler drops most
  scheduled runs — asking it for hourly delivered one run every ~6 hours — so
  the hourly clock is a small Cloudflare Worker (below). Without it the
  workflow's fallback schedule still publishes, about every three hours at best.

### Keeping it fresh: the Cloudflare Worker

`worker/` is a tiny Cloudflare Worker that dispatches the publish workflow
every hour and posts to a Discord channel if the published data goes stale. It
runs on Cloudflare's free plan (one cron trigger out of the five allowed).
One-time setup, about ten minutes:

1. **A GitHub token for it.** GitHub → Settings → Developer settings →
   Fine-grained tokens → *Generate new token*. Repository access: **only this
   repository**. Permissions: **Actions: Read and write** — nothing else.
2. **Install wrangler and log in** (from the `worker/` folder):
   ```bash
   npm install -g wrangler
   wrangler login
   ```
3. **Create the KV store** it keeps its alert flag (and later the Discord
   watch subscriptions) in, then paste the printed `id` into `wrangler.toml`:
   ```bash
   wrangler kv namespace create SUBS
   ```
4. **Add the secrets:**
   ```bash
   wrangler secret put GITHUB_TOKEN         # the token from step 1
   wrangler secret put ADMIN_WEBHOOK_URL    # optional: a Discord webhook for "data went stale" alerts
   ```
5. **Deploy:** `wrangler deploy`. Check it with `wrangler tail` — each hour logs
   `dispatch: ok (HTTP 204)` and the age of the published data.

Tests run with `npm test` in `worker/` and need nothing but Node.

### Discord bot: summaries and alerts (optional)

The same Worker runs a Discord bot. You tell it your city, queue days and
filters once; it then DMs you a **summary** on your schedule — daily (the
default), twice a day or weekly — or, if you'd rather, **one DM per listing**
the moment it turns up. It needs no gateway connection: Discord calls the
Worker, and the Worker calls Discord's REST API.

A daily summary looks like this:

```
Nästet · Stockholm · Mon 12 Oct
7 new listings since Sun 11 Oct, 08:00 (3 SSSB · 4 Bostadsförmedlingen)
→ 3 fit your filters (≤ 30 min by bike to KTH · ≤ 6 000 kr)
→ 1 you'd get today with your 312 queue days, plus 2 decided by deadline, open to apply

New and fitting
• Studentbacken 23 (Jerum) · 4 861 kr · 17 m² · 7 min by bike · ✅ you'd lead (61 queue days) — link
• Odengatan 1 (Vasastan) · 6 900 kr · 9 min by bike · apply by 2026-10-14 — link

Closing within two days (1)
• …

Right now: 126 open in Stockholm · 18 fit your filters · you'd lead 9 of the 30 with queue days
```

Days with nothing new and nothing closing are skipped unless you ask for a
message every time (`always:True`).

**Commands** (once a watch exists every option is optional — only what you
give is changed):

| Command | What it does |
|---|---|
| `/watch set days:312 campus:KTH max_commute:30 max_rent:6000` | Start a watch, or change any part of it |
| `/watch set frequency:twice_daily hour:7` | Summaries at 07:00 and 19:00, Stockholm time. Also `daily`, `weekly` (Mondays) and `instant` |
| `/watch set student_union:False` | Not in a student union (kår): your days stop at 90, as SSSB counts them |
| `/watch set areas:Jerum, Lappkärrsberget` | Only these areas; `areas:any` clears it, as `max_rent:0` and `max_commute:0` clear those |
| `/watch show` | Your settings, and how many listings fit them right now |
| `/watch now` | A summary straight away |
| `/watch stop` | Stop, and delete everything stored about you |

#### Setting it up

**The quick way:** with [Node.js](https://nodejs.org) installed, run
`npm run setup` in `worker/`. It does both this section and the Worker setup
above in one go — logs you in to Cloudflare, creates the KV namespace and
writes its id into `wrangler.toml`, deploys, stores the secrets (typed at
wrangler's own prompt, never saved to a file), registers the command, and
opens each page you need to copy something from. It skips whatever is
already done, so it's safe to run again. The steps below are the same thing
by hand.

Everything here is free (Cloudflare's free plan, a Discord application). Do
the Worker setup above first; then, about fifteen minutes:

1. **Create the Discord application.** [Discord developer portal](https://discord.com/developers/applications)
   → *New Application* (call it Nästet). From *General Information* copy the
   **Application ID** and **Public Key**. Under *Bot* → *Reset Token*, copy
   the **bot token** — it's shown once; keep it out of every file in this repo.
2. **Choose how people add it.** *Installation* → tick **User Install**
   (people add it to their own account and talk to it in DMs — no server
   needed) and, if you want it in a server too, **Guild Install** with scopes
   `applications.commands` and `bot`. Copy the **Install Link**.
3. **Give the Worker its secrets** (from `worker/`):
   ```bash
   wrangler secret put DISCORD_PUBLIC_KEY
   wrangler secret put DISCORD_BOT_TOKEN
   wrangler secret put NOTIFY_SECRET        # any long random string: openssl rand -hex 32
   wrangler deploy
   ```
4. **Point Discord at it:** *General Information* → *Interactions Endpoint URL*
   = `https://nastet.<your-subdomain>.workers.dev/interactions` → *Save*.
   Discord sends a signed test request and only saves if the Worker answers
   it, so a successful save means the keys are right.
5. **Register the commands** once. After that the Worker keeps them up to
   date by itself: when a deploy changes `COMMANDS`, it re-registers on the
   next command or hourly run, using the bot token it already has. Global
   commands can take a few minutes to show up:
   ```bash
   DISCORD_APP_ID=… DISCORD_BOT_TOKEN=… npm run register-commands
   ```
6. **Try it:** open the Install Link, add the app, DM it
   `/watch set days:100` and then `/watch now`. `wrangler tail` shows each
   hour's `notify: {…"summaries":1…}`.
7. **Let the publish workflow ping it** (instant DMs then go out minutes
   after new data instead of at the next hourly run): add repository secrets
   `NOTIFY_URL` = `https://nastet.<your-subdomain>.workers.dev/notify` and
   `NOTIFY_SECRET` = the same string as in step 3.
8. **Show it on the site:** set `DISCORD_INVITE` in `index.html` to the
   Install Link. The watch panel then offers "Prefer Discord?" with a
   ready-made `/watch set` command — city, queue days, rent, areas, campus and
   commute filled in from the page.
9. **Per-city channels (optional):** create a channel webhook and
   `wrangler secret put DIGEST_WEBHOOK_STOCKHOLM` (or `_GOTEBORG`, `_LUND`);
   each publish with new listings posts a list there.

What's stored, in the `SUBS` KV namespace under the user's Discord id: city,
queue days and the date they were given, max rent, areas, campus and longest
commute, how often and at what hour to write, the DM channel id, and the
listing ids already sent or already counted in a summary. Nothing else.
`/watch stop` deletes it; so does six months without a command.



The workflow caches two files between runs, both worth understanding:
`bike_route_cache.json`, so 26 areas × 7 campuses of real cycling routes aren't
re-fetched from a free community service hourly; and
`current_listings.json`, which is what new-listing diffing compares against —
without it, every run would start from nothing and mark all ~170 listings as NEW.

If a scrape fails the job fails deliberately, and Pages keeps serving the last
good deploy rather than publishing an empty map.
</details>

## 5. Getting notified automatically

If you leave `python monitor.py --serve` running, you're already
covered — its background auto-check (every 15 min by default) fires the
same desktop notification on new listings as `--once` does. The cron/Task
Scheduler route below is only needed if you'd rather *not* keep the
dashboard process running all the time and just want periodic checks:

**macOS/Linux (cron)** — checks every 30 min:
```bash
crontab -e
# add:
*/30 * * * * cd /path/to/this-folder && /path/to/venv/bin/python monitor.py --once >> cron.log 2>&1
```

**Windows (Task Scheduler)**: create a basic task that runs
`venv\Scripts\python.exe monitor.py --once` every 30 minutes,
with "Start in" set to this folder.

## 6. Notes / known limitations

- **Light and dark themes.** The toggle sits in the header next to the title;
  dark is the default. Everything the page draws — including the map's area
  roundels, provider pins and campus markers — reads its colours from CSS
  custom properties, so switching repaints the map without re-rendering it. The
  chosen theme is remembered in `localStorage`, wrapped in a `try` so the page
  still loads where storage is blocked (it just won't persist there). That's the
  only browser storage this file touches; everything else about what's new since
  the last check is computed server-side.
- **Areas split into buildings when you zoom in or select them.** An SSSB area
  like Lappkärrsberget is two dozen buildings spread over a kilometre, so one
  roundel is a lie once you're looking closely. Click the area — or zoom to 14 —
  and it dissolves into a dot per building, placed at its real address; clicking
  the area frames its actual buildings rather than dropping to a fixed zoom.
  Deselect or zoom out and the roundel comes back.
  Only areas that are genuinely spread out do this: the scrape records how far
  apart each area's listings are, and anything under 120 m (Jerum's two blocks,
  say) keeps its single roundel, because splitting it would just produce
  overlapping dots. A building with several listings shows the count, like the
  roundel it came out of, and its tooltip lists them.
  The addresses come from each card, geocoded via OpenStreetMap and cached in
  `data/address_cache.json` — buildings don't move, so this is a one-time cost of
  about 40 lookups. An address that won't resolve leaves that listing at the area
  centre rather than dropping it, and so does one that resolves *implausibly* —
  more than 3 km from its own area, which is how a same-named street in another
  municipality gives itself away. The terminal names any address that gets
  dropped that way so you can correct it in the cache file by hand.
- **Chain supermarkets on the map.** The **Shops** chip (next to the provider
  chips) draws a dot for every ICA, Coop, Willys, Hemköp, Lidl and City Gross in
  greater Stockholm, from OpenStreetMap. On by default, but only drawn from zoom
  13 in — at city zoom a few hundred dots bury the area roundels, which are the
  point of the map. So they cost nothing until you zoom into somewhere, and then
  they're already there. The chip goes dashed when it's on but you're zoomed too
  far out, so nothing looks broken; click it to turn them off entirely.
  Every area also gets a **nearest shop** figure computed at scrape time, shown
  in the area's gauges and on rows in the cross-area list. It's straight-line
  distance, like the distance gauge next to it — a 300 m crow-flies shop can
  still be a 700 m walk.
  Shops are cached in `data/grocery_cache.json` for 30 days, since supermarkets
  don't move and re-fetching them every scrape would be pointless load on a free
  community service. Overpass's main endpoint is busy and often refuses, so a
  couple of mirrors are tried in turn and the terminal prints which answered;
  `OVERPASS_URL` puts your own first. A failed lookup keeps whatever the last
  successful one found rather than losing the dots — the chip only disappears if
  there has *never* been a successful lookup, and the run's summary says so when
  that happens (`shops: none — …`, with what each endpoint answered).
  That cache file is **committed to the repo on purpose**, unlike the other
  caches: Overpass rate-limits shared cloud IPs, so the GitHub Actions runner
  that builds the published site is the one machine that can't reliably fetch it.
  A list gathered from an ordinary connection and committed is what gives the
  published site its shop dots. To refresh it, run the tool once and commit the
  file if it changed.
- **Area colours match the tunnelbana.** A roundel's colour is the line its
  area sits on — North blue, South red, City green — matching the three lines
  drawn on the map in official SL colours. Gray × means an area exists but has
  nothing available (or nothing matching your filters) right now. The
  **SSSB lines** chips filter by those same three groups, which are SSSB's own
  grouping of its areas rather than anything invented here.
- **Built for more than one city.** The scrape, the payload and the dashboard are
  all scoped to a city: `--city` picks one (omit it to do all of them), each gets
  its own `data/current_listings_<city>.json`, and the page reads the city from
  the URL fragment (`…/#lund`) so a choice is bookmarkable without any storage.
  Stockholm is the only city so far, so the picker and the header's city button
  hide themselves — a control that can't change anything is worse than none.
- **Works on a phone.** Below 760px wide (or on a short landscape screen) the
  two-pane layout stacks into one scrolling page: map first, then the filters,
  then the listings. The filter strip becomes two columns with full-width
  sliders. It's a CSS-only change confined to one media query at the end of the
  stylesheet — the desktop layout renders pixel-for-pixel as it did before.
- **First run scrapes before serving.** `--serve` scrapes on startup unless the
  saved listings are newer than your `--interval`, and prints which it's doing.
  `data/current_listings.json` is regenerated output and deliberately *not* in
  the repo — it used to be, which meant a fresh clone was served month-old test
  listings that looked current. If the "updated" time in the top-right turns
  amber, nothing has scraped in over an hour.
- **Coordinates**: area coordinates are looked up automatically via
  OpenStreetMap (free, no key) and cached in `data/geocode_cache.json`. If a
  pin looks wrong on the map, open that file and hand-correct the
  `[lat, lon]` for that area.
- **Campus dropdown**: the "Campus" picker in the top bar re-centres the map
  and recomputes every commute from that school instead of KTH, so the max-
  commute slider, the sorting and the map counts all follow. KTH is the
  default. You can also click any of the other campus pins on the map to
  switch to it. Seven Stockholm schools are built in (KTH, SU, KI, SSE,
  Konstfack, KMH, KKH) — add more in `SCHOOLS` in `monitor.py` and
  the dropdown picks them up automatically.
- **Bike times are real routes, not straight lines.** They come from
  [FOSSGIS's public Valhalla](https://valhalla1.openstreetmap.de/) routing
  service over OSM's cycling network — free, no key. Results are cached in
  `data/bike_route_cache.json`, so the first run is slow (it routes each area
  to each campus) and later runs are instant. A listing's row shows
  `12 min bike` for a routed time and `~12 min bike` for a fallback estimate,
  so you can always tell which you're looking at. If the service is
  unreachable the run says so and falls back to the old straight-line guess
  rather than failing; `--no-bike-routes` skips routing entirely.
- **Filtering far-away areas**: the "Max commute" slider in the dashboard
  hides areas beyond that many minutes (transit time if you set up
  Resrobot, otherwise the bike estimate). Flemingsberg in particular is
  quite far from central KTH — it'll likely get filtered out by default,
  which is probably what you want.
- **Queue-days and rent sliders**: next to "Max commute". Both start at
  "Any" (hiding nothing) and filter individual listings rather than whole
  areas, so the counts on the map roundels drop as you pull them down and an
  area shows the gray × once nothing in it still qualifies. Bostadsförmedlingen
  ads are never hidden by the queue-days slider — they publish an application
  deadline instead of a queue-days figure, so there's nothing to compare
  against. The "All listings" search tab ignores every slider, so it's
  the way to look at everything regardless of what's filtered.
- **The cog** (next to those sliders) opens a second row with the
  finer-grained filters: minimum size, a lowest/highest floor range
  (floor 0 = *bottenvåning*), and minimum contract length. They behave the
  same way as the main sliders — "Any" until you pull one in — and while any
  cog filter is engaged the cog shows an amber count, so you can collapse the
  panel without forgetting the map is still narrowed. "Reset these" clears
  just that row.
  - *Min contract* uses SSSB's "Max N år" badge, which caps how long you may
    hold the contract. Only a stated cap **below** your minimum is excluded;
    listings with no stated cap always pass, since no cap is the better case.
    In practice SSSB only ever seems to print "Max 4 år", so this slider
    mostly acts as a switch between "include those" and "exclude those".
- **Electricity** is shown, not filtered on. Cards that say "Elström ingår"
  display *el ingår* in the listing row (and it's searchable in the "All
  listings" tab), but there's no toggle for it: a card saying nothing about
  electricity isn't the same as one that excludes it, and Bostadsförmedlingen
  ads have no such field at all, so a filter would have quietly dropped that
  entire provider.
- **No elevator filter**: SSSB's vacancy list doesn't publish whether a
  building has a lift — the card only carries type, address, area, size,
  rent, move-in date, queue days, floor, and the two badges above. Adding one
  would mean opening each listing's own page during every scrape (76 extra
  page loads), and it's not confirmed that page states it either. The floor
  sliders are the practical stand-in for "no walk-up".
  Bostadsförmedlingen's feed *does* publish a lift flag (and a balcony one), so
  those ads show *elevator* / *balcony* on their row where stated — but for the
  same reason as electricity above, they're display-only, since a filter would
  have hidden every SSSB listing rather than narrowed anything.
- **Rate limiting**: don't drop the cron interval much below ~15 minutes —
  there's no need to hammer their servers, and it's not clear how
  they'd react to it.
- **Bostadsförmedlingen: student housing only.** The feed
  (`bostad.stockholm.se/AllaAnnonser/`) carries the whole Stockholm rental
  queue; only ads flagged as student housing are kept. The flag is read
  tolerantly, so a renamed field shows up as a loud terminal warning listing
  the ad's real keys rather than silently returning zero listings. If the feed
  moves again, `BF_ADS_URL=<url>` overrides it without editing the script.
- **Clicking a Bostadsförmedlingen listing** opens that ad on their site. The
  feed publishes the link itself in a `Url` field, so that's what's used. Where
  it's missing, the script falls back to building
  `bostad.stockholm.se/bostad/<n>/`, where `<n>` is a year-prefixed 9-digit ad
  number — *not* the feed's `AnnonsId`, which is shorter and 404s — found by
  value shape since it's unclear which key holds it. The terminal reports the
  split between the two, and anything unresolvable links to a search page zoomed
  on the address rather than a dead page.
  `BF_LISTING_URL="https://…/{id}"` overrides the fallback template.
- **Bostadsförmedlingen ads use straight-line bike estimates**, not routed
  ones, so a scrape stays quick: there are ~100 of them and they rotate, so
  routing them all costs ~700 paced requests (about 9 minutes) per run. The 26
  SSSB areas are a fixed set and always routed. `--bike-routes-bf` opts in.
- **Desktop notifications** need nothing extra on macOS — the script uses the
  built-in `osascript`. (`plyer`, listed in requirements, needs a compiled
  `pyobjus` extension that often won't install; it's only a fallback for
  Windows now.) If a notification doesn't appear, the terminal prints what each
  path actually reported, plus the new listings themselves, so nothing is lost
  when the popup is. On macOS the usual cause is notification permission for
  whichever terminal app you ran it from: **System Settings → Notifications**.
- **Bostadsförmedlingen**: `fetch_bostadsformedlingen()` pulls Stockholm's
  city housing agency's public ad feed (`bostad.stockholm.se/AllaAnnonser/`)
  and keeps only the student ads — no login, no API key. Svenska Bostäder
  doesn't run a separate student queue of its own; their listings show up
  through this same feed. There's no landlord field in it, so the row is
  labelled with the *queue* the ad belongs to (`KoNamn`), which for the
  external queues is the landlord running it. Each ad carries its own
  coordinates, so these get individual purple pins on the map instead of
  SSSB's per-area dots, and sort by application deadline instead of queue
  days, since BF doesn't publish a queue-days figure up front.
- **Provider filter**: the dashboard's "Provider" chips (top bar) toggle
  SSSB and Bostadsförmedlingen independently of the SSSB-only "SSSB lines"
  filter. The "Queues to join" sidebar tab explains how to actually
  register for each queue.


## License

MIT — see [LICENSE](LICENSE). Feel free to use or modify however.

That covers the code in this repo. The things it builds on have their own terms,
all of them permissive but worth knowing if you fork this:

- **Map data** is © OpenStreetMap contributors, under the
  [ODbL](https://www.openstreetmap.org/copyright) — that's the basemap *and* the
  grocery-store locations. Attribution is required, which is why the map credits
  it in the corner; don't remove that.
- **Basemap tiles** are CARTO's ([attributions](https://carto.com/attributions)).
- **Routing** is FOSSGIS's public Valhalla instance and **geocoding** is
  Nominatim — both free community services, which is why this caches
  aggressively and paces its requests. Please don't remove the caching.
- **Leaflet** is BSD-2-Clause; **Familjen Grotesk** and **JetBrains Mono** are
  open fonts (OFL / Apache-2.0).
- **Listing data** belongs to SSSB and Stockholms Stad. This reads their public
  pages for personal use and links every listing back to the source — it isn't
  affiliated with either, and you apply through them.

## Roadmap

**Three cities now: Stockholm, Göteborg and Lund.** You pick one on arrival and
the site shows that one; the choice lives in the URL (`…/#lund`), so it's
bookmarkable and shareable. Each city brings its own providers, campuses, areas
and sensible slider defaults — a 45-minute commute filter means something across
Stockholm's 30 km and nothing in Lund, where everything is a short bike ride.

- **Stockholm** — SSSB + Bostadsförmedlingen
- **Göteborg** — SGS, via the Momentum platform their site runs on
- **Lund** — AF Bostäder

Providers differ in what they publish, and the dashboard reads that from the data
rather than being told: SSSB states queue days, so its rows sort by them; SGS
publishes no queue figure at all, so its rows say "open now"; AF publishes how
many people have already applied, so Lund sorts by fewest applicants first. Each
city's coverage note says plainly what it doesn't cover.

**Adding a fourth** is a scraper plus a registry entry in `monitor.py` — areas
build themselves from the feed where a provider states them. Worth checking
first whether the landlord runs on Momentum, since that scraper already exists.

**Next up: more student cities.** The scrape, the payload and the dashboard are
already scoped per city — each one has its own registry entry, its own campuses
and its own data file, and you pick a city from the URL (`…/#lund`). Stockholm is
simply the only entry so far, which is why the picker stays out of the way.

The plan is **Göteborg** and **Lund** next, each with its own housing providers
and its own campus list — the smaller specialist colleges included, the way
Stockholm lists Konstfack, KMH and KKH alongside KTH and SU, since those are
exactly the places where which campus you measure from changes the answer.

Made by IvarHak, hosted on GitHub, coded partially with the help of Claude Code
