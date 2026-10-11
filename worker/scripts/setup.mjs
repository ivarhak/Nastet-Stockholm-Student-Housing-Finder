// One-time setup for the Nästet Worker and its Discord bot, as far as a script
// can take it. Run from the worker/ folder:
//
//   npm run setup
//
// What it does, in order, skipping anything already done (so it's safe to run
// again after stopping half-way):
//   1. logs you in to Cloudflare (opens the browser)
//   2. creates the KV namespace and writes its id into wrangler.toml
//   3. deploys, which also gives the URL Discord needs
//   4. asks for the GitHub token and the Discord keys and stores them as
//      Worker secrets — typed at wrangler's own prompt, never written to a
//      file — and makes a random NOTIFY_SECRET
//   5. has you paste the URL into the Discord portal
//   6. registers the /watch command with Discord
//   7. prints the two GitHub repository secrets left to add by hand
//
// The parts it can't do are the logins and the copying of keys out of the
// Discord portal; it opens each page and says exactly what to copy.
// --dry-run prints the commands instead of running them.
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../src/discord.js';

const DRY = process.argv.includes('--dry-run');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOML = path.join(ROOT, 'wrangler.toml');
const WIN = process.platform === 'win32';
const WRANGLER = ['npx', '--yes', 'wrangler@4'];
const REPO_SECRETS = 'https://github.com/ivarhak/Nastet-Stockholm-Student-Housing-Finder/settings/secrets/actions';

const bold = s => `\x1b[1m${s}\x1b[0m`;
const step = (n, s) => console.log(`\n${bold(`── ${n}. ${s}`)}`);
const say = s => console.log(`   ${s}`);

function run(args, { input, capture = true } = {}) {
  const cmd = [...WRANGLER, ...args];
  if (DRY) { say(`[dry run] ${cmd.join(' ')}${input ? ' (with input)' : ''}`); return { ok: true, out: '' }; }
  const r = spawnSync(cmd[0], cmd.slice(1), {
    cwd: ROOT, shell: WIN, encoding: 'utf8', input,
    stdio: capture ? [input != null ? 'pipe' : 'inherit', 'pipe', 'pipe'] : 'inherit',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { ok: r.status === 0, out };
}

function openUrl(url) {
  if (DRY) return;
  const [c, a] = WIN ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(c, a, { stdio: 'ignore', detached: true }).unref(); } catch (e) { /* the URL is printed anyway */ }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(res => rl.question(`   ${q} `, a => res(a.trim())));
// Typed but not shown — for the bot token, which is only needed once here.
function askHidden(q) {
  return new Promise(res => {
    const out = rl.output;
    const write = rl._writeToOutput;
    rl._writeToOutput = s => { if (s.includes(q)) out.write(s); };
    rl.question(`   ${q} `, a => { rl._writeToOutput = write; out.write('\n'); res(a.trim()); });
  });
}
const pause = q => ask(`${q} — press Enter when done.`);

async function main() {
  console.log(bold('Nästet — Worker and Discord bot setup'));
  say('Each step is skipped if it is already done. Stop any time with Ctrl+C and run it again later.');

  step(1, 'Cloudflare login');
  const who = run(['whoami']);
  if (/not authenticated|You are not logged in/i.test(who.out) || !who.ok) {
    say('Opening the browser so you can log in to Cloudflare (make a free account if you have none)…');
    if (!run(['login'], { capture: false }).ok) throw new Error('Cloudflare login did not finish.');
  } else {
    say(`Logged in. ${(who.out.match(/associated with the email ([^\s]+)/) || [])[1] || ''}`);
  }

  step(2, 'Storage for watches (KV namespace)');
  let toml = readFileSync(TOML, 'utf8');
  if (/REPLACE_WITH_KV_NAMESPACE_ID/.test(toml)) {
    let r = run(['kv', 'namespace', 'create', 'SUBS']);
    let id = (r.out.match(/id\s*[=:]\s*"([0-9a-f]{32})"/) || [])[1];
    if (!id) {
      // Already created on an earlier run: find it in the list.
      r = run(['kv', 'namespace', 'list']);
      try { id = (JSON.parse(r.out.slice(r.out.indexOf('['))).find(n => /SUBS/.test(n.title)) || {}).id; } catch (e) { /* below */ }
    }
    if (!id && !DRY) throw new Error(`Could not create or find the KV namespace:\n${r.out}`);
    if (!DRY) { toml = toml.replace('REPLACE_WITH_KV_NAMESPACE_ID', id); writeFileSync(TOML, toml); }
    say(`KV namespace ${id || '(dry run)'} written into wrangler.toml.`);
  } else {
    say('Already set in wrangler.toml.');
  }

  step(3, 'Deploy');
  let dep = run(['deploy']);
  // A new Cloudflare account has no workers.dev subdomain yet, and wrangler
  // can't ask for one while this script reads its output: pick it in the
  // dashboard, then deploy again.
  for (let tries = 0; !dep.ok && /workers\.dev subdomain/i.test(dep.out) && tries < 3; tries++) {
    const onboard = (dep.out.match(/https:\/\/dash\.cloudflare\.com\/[^\s]+\/workers\/onboarding/) || [])[0]
      || 'https://dash.cloudflare.com/?to=/:account/workers/onboarding';
    say('Your Cloudflare account needs a workers.dev subdomain first (once per account).');
    say(`Opening ${onboard} — pick a name (your username is fine), confirm it.`);
    openUrl(onboard);
    await pause('Picked it');
    dep = run(['deploy']);
  }
  if (!dep.ok) throw new Error(`Deploy failed:\n${dep.out}`);
  const url = (dep.out.match(/https:\/\/[^\s]+\.workers\.dev/) || [])[0] || 'https://nastet.<your-subdomain>.workers.dev';
  say(`Deployed at ${url} — secrets can only be added to a Worker that exists, so this comes first.`);

  step(4, 'Secrets');
  const listed = run(['secret', 'list']);
  const have = new Set((listed.out.match(/"name":\s*"([A-Z_]+)"/g) || []).map(s => s.match(/"([A-Z_]+)"$/)[1]));
  const put = async (name, how) => {
    if (have.has(name) && !/^y/i.test(await ask(`${name} is already set. Replace it? [y/N]`))) return;
    if (how) { say(how); }
    say(`Paste ${name} at the prompt below (it is sent to Cloudflare, not saved here):`);
    if (!run(['secret', 'put', name], { capture: false }).ok) throw new Error(`Setting ${name} failed.`);
  };
  openUrl('https://github.com/settings/personal-access-tokens/new');
  await put('GITHUB_TOKEN', 'GitHub → Fine-grained token (just opened): Repository access → Only select repositories → '
    + 'Nastet-Stockholm-Student-Housing-Finder; Permissions → Actions: Read and write. Nothing else. Generate, copy.');
  openUrl('https://discord.com/developers/applications');
  say('Discord developer portal (just opened): New Application → name it Nästet.');
  say('Installation → tick "User Install" (and "Guild Install" if you also want it in a server).');
  await put('DISCORD_PUBLIC_KEY', 'General Information → copy the Public Key.');
  await put('DISCORD_BOT_TOKEN', 'Bot → Reset Token → copy it (it is shown once).');
  let notify = null;
  if (!have.has('NOTIFY_SECRET')) {
    notify = randomBytes(32).toString('hex');
    if (!run(['secret', 'put', 'NOTIFY_SECRET'], { input: notify + '\n' }).ok) throw new Error('Setting NOTIFY_SECRET failed.');
    say('NOTIFY_SECRET generated and stored.');
  } else {
    say('NOTIFY_SECRET already set (keep using the value you added to GitHub).');
  }

  step(5, 'Point Discord at the Worker');
  say(`Discord portal → General Information → Interactions Endpoint URL:`);
  say(bold(`${url}/interactions`));
  say('Save. Discord tests it on the spot — if it saves, the keys are right.');
  await pause('Saved it');

  step(6, 'Register the /watch command');
  const app = await ask('Application ID (General Information → Application ID):');
  const token = await askHidden('Bot token again (only used for this request, not stored):');
  if (!DRY) {
    const res = await fetch(`https://discord.com/api/v10/applications/${app}/commands`, {
      method: 'PUT', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(COMMANDS),
    });
    say(res.ok ? 'Registered /watch (may take a few minutes to show up in Discord).'
               : `Registering failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  step(7, 'Two GitHub repository secrets, so new data reaches the bot within minutes');
  openUrl(REPO_SECRETS);
  say(`${REPO_SECRETS} (just opened) → New repository secret, twice:`);
  say(`  NOTIFY_URL     = ${url}/notify`);
  say(notify ? `  NOTIFY_SECRET  = ${notify}` : '  NOTIFY_SECRET  = the value you set before');
  if (notify) say('  (This is the only time the NOTIFY_SECRET value is shown.)');

  step(8, 'Try it');
  say('Discord portal → Installation → copy the Install Link and open it to add the app to your account.');
  say('Then DM the bot:  /watch set days:100   and   /watch now');
  say('Send the Install Link to Claude to have the site\'s "Prefer Discord?" box point at it.');
  say(`Watch the Worker live with: ${WRANGLER.join(' ')} tail`);
  rl.close();
}

main().catch(e => { console.error(`\n✗ ${e.message}`); rl.close(); process.exit(1); });
