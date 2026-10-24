#!/usr/bin/env node
'use strict';

/*
 * zcode2proxy account manager
 * --------------------------------
 * node accounts login <name>
 *     Start a Z.ai OAuth login for a NEW account. Prints a link you open
 *     in your browser yourself (nothing opens automatically). After you
 *     log in, the code is captured automatically on
 *     http://127.0.0.1:<port>/callback - or you paste the final URL back
 *     here. The account is stored under accounts/<name>/ and any free
 *     coding plan is claimed automatically.
 *
 * node accounts add <name> [credentials.json [telemetry-state.json]]
 *     Capture the login currently active in the ZCode desktop app.
 *
 * node accounts usage
 *     Live plan usage for every account (tokens used/left, expiry).
 *
 * node accounts claim [name]
 *     Claim any available free plan for an account.
 *
 * node accounts list | remove <name> | path
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');
const {
  decryptCredential,
  loadAccountCredentials,
  accountNames,
  accountsRoot,
  zcodeHome,
} = require('./src/credentials');
const { billingRequest, fetchAccountUsage } = require('./src/billing');

const OAUTH = {
  clientId: 'client_P8X5CMWmlaRO9gyO-KSqtg',
  authorizeUrl: 'https://chat.z.ai/api/oauth/authorize',
  tokenUrl: 'https://zcode.z.ai/api/v1/oauth/token',
  userinfoUrl: 'https://chat.z.ai/api/oauth/userinfo',
  businessLoginUrl: 'https://api.z.ai/api/auth/z/login',
};

function usage() {
  console.log(`
  ${ui.bold('ZCodeBridge')} ${ui.dim('· account manager')}

  ${ui.cyan('node accounts login')} ${ui.dim('[name]')}
      Z.ai OAuth login for a new account. The name is optional - when
      omitted, the account is named after the signed-in email (part
      before @). After signing in, copy the zcode://oauth/callback?...
      link from the login-complete page and paste it into the terminal
      (works from any browser, on any device/network).
  ${ui.cyan('node accounts add')} ${ui.dim('<name> [credentials.json [telemetry-state.json]]')}
      Capture the login currently active in the ZCode desktop app.
  ${ui.cyan('node accounts usage')}
      Live plan usage: token bars, remaining amounts, expiry countdowns.
  ${ui.cyan('node accounts claim')} ${ui.dim('[name]')}
      Claim any available free coding plan.
  ${ui.cyan('node accounts list')}
      Show all accounts with email and token status.
  ${ui.cyan('node accounts remove')} ${ui.dim('<name>')}
      Delete a stored account (the desktop-app login is never touched).
  ${ui.cyan('node accounts path')}
      Print the accounts directory.`);
}

function clientHeaders(extra = {}) {
  return {
    'content-type': 'application/json',
    'user-agent': 'ZCode/3.16.3',
    'x-zcode-app-version': '3.16.3',
    'x-release-channel': 'production',
    'x-client-language': 'en-US',
    'x-platform': `${os.platform()}-${os.arch()}`,
    'x-request-id': crypto.randomUUID(),
    'x-zcode-trace-id': crypto.randomUUID(),
    'x-query-id': crypto.randomUUID(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// OAuth login
// ---------------------------------------------------------------------------

// Waits for the user to paste the final zcode:// (or http) callback URL.
// The chat.z.ai OAuth client only accepts the desktop app's wrapper as
// redirect_uri, so after login the browser lands on a page whose button
// links to zcode://oauth/callback?code=...&state=... - the user copies
// that link (right-click -> Copy link address) and pastes it here.
function waitForCallbackPaste(timeoutMs) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const timer = setTimeout(() => {
      rl.close();
      reject(new Error('Login timed out.'));
    }, timeoutMs);

    const ask = () => {
      rl.question('> ', (line) => {
        const text = (line || '').trim();
        const codeMatch = /[?&#](?:code|authCode)=([^&\s"']+)/.exec(text);
        if (codeMatch) {
          clearTimeout(timer);
          const stateMatch = /[?&#]state=([^&\s"']+)/.exec(text);
          console.log('Authorization code received.');
          rl.close();
          resolve({
            code: decodeURIComponent(codeMatch[1]),
            state: stateMatch ? decodeURIComponent(stateMatch[1]) : null,
          });
          return;
        }
        console.log('That line has no code= parameter. Paste the full zcode://oauth/callback?... link and press Enter.');
        ask();
      });
    };
    ask();
  });
}

function deriveAccountName(email, uuid) {
  const base = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  let candidate = base || String(uuid || '').slice(0, 8) || 'account';
  let suffix = 2;
  while (fs.existsSync(path.join(accountsRoot(), candidate, 'credentials.json'))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function cmdLogin(name) {
  if (name && !/^[A-Za-z0-9._-]+$/.test(name)) {
    console.error('Usage: node accounts login [name]   (letters, digits, . _ -; or omit to name it after the account email)');
    process.exitCode = 1;
    return;
  }
  if (name && fs.existsSync(path.join(accountsRoot(), name, 'credentials.json')) && !process.argv.includes('--force')) {
    console.error(`Account "${name}" already exists. Re-login with --force to overwrite.`);
    process.exitCode = 1;
    return;
  }

  const state = crypto.randomUUID();
  // The chat.z.ai OAuth client only has the desktop app's wrapper page
  // registered as redirect_uri; anything else (like a localhost URL) is
  // rejected with "Redirect URI not registered for this client".
  const redirectUri = `https://zcode.z.ai/app/oauth/login?`
    + new URLSearchParams({ redirect: 'zcode://oauth/callback', app_version: '3.16.3' });
  const authorizeUrl = `${OAUTH.authorizeUrl}?` + new URLSearchParams({
    redirect_uri: redirectUri,
    response_type: 'code',
    client_id: OAUTH.clientId,
    state,
  }).toString();

  console.log(`\n  ${ui.rule('─'.repeat(66))}`);
  console.log(`    ${ui.bold('ZCodeBridge')} ${ui.dim('·')} ${ui.cyan('add account')} ${ui.dim(name ? `· "${name}"` : '· auto-named from your email')}`);
  console.log(`  ${ui.rule('─'.repeat(66))}\n`);
  console.log(`  ${ui.green('1')}  ${ui.bold('Open the sign-in link')} ${ui.dim('(any browser, any device)')}\n`);
  console.log(`     ${ui.cyan(authorizeUrl)}\n`);
  console.log(`  ${ui.green('2')}  ${ui.bold('Sign in')} with the Z.ai account to add ${ui.dim('(sign-up works too)')}\n`);
  console.log(`  ${ui.green('3')}  ${ui.bold('Copy the link from the browser address bar')} ${ui.dim('(it contains code=...)')}`);
  console.log(`     ${ui.dim('The page may say "Authorization Failed" or ask to open the ZCode')}`);
  console.log(`     ${ui.dim('app - that is fine. Do NOT click any "open app" button.')}\n`);
  console.log(`  ${ui.green('›')}  ${ui.bold('Paste the link below and press Enter')} ${ui.dim('(timeout 10 min, Ctrl+C to cancel)')}\n`);

  let callback;
  try {
    callback = await waitForCallbackPaste(10 * 60 * 1000);
  } catch (error) {
    console.error(`\n  ${ui.red('✗ login failed:')} ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (callback.state && callback.state !== state) {
    console.error(`\n  ${ui.red('✗ state mismatch')} - the pasted link belongs to another session. Try again.`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n  ${ui.green('✓')} code received ${ui.dim('- exchanging tokens...')}`);
  let tokenJson;
  try {
    const res = await fetch(OAUTH.tokenUrl, {
      method: 'POST',
      headers: clientHeaders(),
      body: JSON.stringify({ provider: 'zai', code: callback.code, redirect_uri: redirectUri, state }),
    });
    tokenJson = await res.json();
  } catch (error) {
    console.error('Token exchange request failed: ' + error.message);
    process.exitCode = 1;
    return;
  }
  if (tokenJson.code !== 0 || !tokenJson.data?.token) {
    console.error(`Token exchange failed: code=${tokenJson.code} msg=${tokenJson.msg || 'missing data.token'}`);
    process.exitCode = 1;
    return;
  }
  const jwt = tokenJson.data.token;
  const zaiAccessToken = tokenJson.data.zai?.access_token || '';

  console.log(`  ${ui.green('✓')} tokens exchanged ${ui.dim('- resolving account...')}`);
  let accessToken = zaiAccessToken;
  try {
    const res = await fetch(OAUTH.businessLoginUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: zaiAccessToken }),
    });
    const json = await res.json();
    accessToken = json.data?.access_token?.trim() || json.data?.accessToken?.trim() || zaiAccessToken;
  } catch (error) {
    console.warn(`  ${ui.yellow('!')} business token fallback (${error.message})`);
  }

  let userInfo = tokenJson.data.user && typeof tokenJson.data.user === 'object' ? tokenJson.data.user : null;
  if (!userInfo && accessToken) {
    try {
      const res = await fetch(OAUTH.userinfoUrl, { headers: clientHeaders({ authorization: `Bearer ${accessToken}` }) });
      const json = await res.json();
      userInfo = json.data && typeof json.data === 'object' ? json.data : json;
    } catch {
      // keep null
    }
  }
  const normalizedUser = {
    user_id: userInfo?.user_id || userInfo?.sub || userInfo?.id || '',
    email: userInfo?.email || '',
    name: userInfo?.name || userInfo?.preferred_username || userInfo?.username || userInfo?.email || '',
  };

  if (!name) {
    name = deriveAccountName(normalizedUser.email, normalizedUser.user_id);
  }
  const destDir = path.join(accountsRoot(), name);

  const deviceMid = crypto.randomUUID();
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'credentials.json'), JSON.stringify({
    'oauth:active_provider': 'zai',
    'oauth:zai:access_token': accessToken,
    'oauth:zai:user_info': JSON.stringify(normalizedUser),
    zcodejwttoken: jwt,
  }, null, 2));
  fs.writeFileSync(path.join(destDir, 'telemetry-state.json'), JSON.stringify({ deviceMid }, null, 2));

  console.log(`\n  ${ui.rule('─'.repeat(66))}`);
  console.log(`    ${ui.green('✓ account saved')}   ${ui.bold(name)} ${ui.dim(`· ${normalizedUser.email || normalizedUser.user_id || 'unknown user'}`)}`);
  console.log(`  ${ui.rule('─'.repeat(66))}`);

  // Same "claim free plan" button the desktop app shows after signup.
  const credentials = { name, jwt, deviceMid, userInfo: normalizedUser };
  await claimAvailablePlans(credentials);
  await printAccountUsage(credentials);
  console.log(`\n  ${ui.dim('Ready - the proxy picks the account up on the very next request.')}\n`);
}

// ---------------------------------------------------------------------------
// Plans / usage
// ---------------------------------------------------------------------------

async function claimAvailablePlans(credentials) {
  try {
    const preview = await billingRequest(credentials, '/api/v1/zcode-plan/billing/preview');
    const plans = Array.isArray(preview.plans) ? preview.plans : [];
    if (!plans.length) {
      console.log('No unclaimed plans available for this account.');
      return;
    }
    for (const plan of plans) {
      try {
        const result = await billingRequest(credentials, '/api/v1/zcode-plan/billing/claim', 'POST', { plan_id: plan.plan_id });
        const endsAt = result?.plan?.ends_at;
        console.log(`Claimed plan "${plan.name || plan.plan_id}"${endsAt ? ` (valid until ${new Date(endsAt * 1000).toISOString().slice(0, 19).replace('T', ' ')})` : ''}`);
      } catch (error) {
        console.error(`Claiming plan "${plan.name || plan.plan_id}" failed: ${error.message}`);
      }
    }
  } catch (error) {
    console.error('Could not check claimable plans: ' + error.message);
  }
}

function formatTokens(n) {
  const value = Number(n) || 0;
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
}

// --- pretty terminal output (plain when not a TTY, so piping stays clean) ---

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const ui = {
  bold: (t) => paint('1', t),
  dim: (t) => paint('2', t),
  cyan: (t) => paint('36', t),
  green: (t) => paint('32', t),
  yellow: (t) => paint('33', t),
  red: (t) => paint('31', t),
  rule: (t) => paint('2', t),
};

function bar(ratio) {
  const pct = Math.max(0, Math.min(100, ratio * 100));
  const cells = 20;
  const filled = Math.round((pct / 100) * cells);
  const body = '█'.repeat(filled) + '░'.repeat(cells - filled);
  const colored = pct > 50 ? ui.green(body) : pct >= 15 ? ui.yellow(body) : ui.red(body);
  return `${colored} ${String(pct.toFixed(pct >= 100 || pct === 0 ? 0 : 1)).padStart(5)}%`;
}

function timeLeft(ms) {
  if (ms <= 0) return ui.red('expired');
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const text = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return d >= 1 ? ui.green(text) : ui.yellow(text);
}

function dateShort(seconds) {
  if (!seconds) return '-';
  const d = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCMonth() + 1}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function printAccountUsage(credentials) {
  return printAccountUsageImpl(credentials).catch((error) => {
    console.error(`  ${ui.red('usage check failed:')} ${error.message}`);
  });
}

async function printAccountUsageImpl(credentials) {
  const data = await fetchAccountUsage(credentials, true);
  const nowMs = (data.server_time ? data.server_time * 1000 : Date.now());
  const balances = Array.isArray(data.balances) ? data.balances : [];
  const plans = Array.isArray(data.plans) ? data.plans : [];
  const active = plans.filter((p) => p.status === 'active');

  if (active.length) {
    for (const plan of active) {
      console.log(`    ${ui.cyan('plans')}   ${plan.name} ${ui.dim(`· expires ${dateShort(plan.ends_at)} · ${timeLeft(plan.ends_at * 1000 - nowMs)} left`)}`);
    }
  } else {
    console.log(`    ${ui.cyan('plans')}   ${ui.yellow('none active')} ${ui.dim(`(node accounts claim ${credentials.name || ''})`)}`);
  }

  if (!balances.length) {
    console.log(`    ${ui.dim('(no token buckets found)')}`);
    return;
  }
  console.log();
  for (const b of balances) {
    const remaining = Math.max(0, Number(b.remaining_units) || 0);
    const total = Math.max(1, Number(b.total_units) || 1);
    const daily = b.period_start && b.period_end && (b.period_end - b.period_start) <= 1.5 * 24 * 3600;
    const tag = daily ? ui.dim('daily') : ui.dim('plan ');
    const name = String(b.show_name || '?').padEnd(14);
    console.log(`    ${ui.bold(name)} ${bar(remaining / total)}  ${ui.bold(formatTokens(remaining))} ${ui.dim(`of ${formatTokens(b.total_units)} left`)}  ${tag} ${ui.dim(`resets ${dateShort(b.period_end)}`)}`);
  }

  // One-time grants (the big e.g. 300M buckets) vs daily-reset buckets.
  const dayMs = 24 * 3600 * 1000;
  const oneTime = balances.filter((b) => !b.period_end || (b.period_end * 1000 - nowMs) > 3 * dayMs);
  const dailyBuckets = balances.filter((b) => b.period_start && b.period_end && (b.period_end - b.period_start) <= 1.5 * 24 * 3600);
  const oneTimeLeft = oneTime.reduce((sum, b) => sum + (Number(b.remaining_units) || 0), 0);
  const dailyLeft = dailyBuckets.reduce((sum, b) => sum + (Number(b.remaining_units) || 0), 0);
  console.log();
  if (oneTime.length && oneTimeLeft <= 0 && dailyLeft > 0) {
    const nextReset = Math.min(...dailyBuckets.filter((b) => (Number(b.remaining_units) || 0) > 0).map((b) => b.period_end));
    console.log(`    ${ui.yellow('›')} one-time plan tokens finished - running on daily tokens (${formatTokens(dailyLeft)} left, refill ${dateShort(nextReset)})`);
  } else if (oneTime.length && oneTimeLeft <= 0) {
    const nextReset = dailyBuckets.length ? Math.min(...dailyBuckets.map((b) => b.period_end)) : null;
    console.log(`    ${ui.red('›')} all tokens used up${nextReset ? ` - daily refill ${dateShort(nextReset)}` : ''} ${ui.dim('or add an account: node accounts login')}`);
  }
}

async function cmdUsage() {
  const names = accountNames();
  console.log(`\n  ${ui.bold('ZCodeBridge')} ${ui.dim('·')} ${ui.cyan('plan usage')} ${ui.dim(`· ${names.length} account${names.length === 1 ? '' : 's'}`)}\n`);
  for (const name of names) {
    try {
      const credentials = loadAccountCredentials(name);
      const email = credentials.userInfo.email || credentials.accountUuid || 'unknown';
      console.log(`  ${ui.rule('─'.repeat(72))}`);
      console.log(`  ${ui.green('●')} ${ui.bold(name || '(default)')} ${ui.dim(`· ${email}`)}`);
      console.log(`  ${ui.rule('─'.repeat(72))}`);
      await printAccountUsage(credentials);
      console.log();
    } catch (error) {
      console.log(`  ${ui.red('●')} ${ui.bold(name || '(default)')} ${ui.dim('·')} ${ui.red(error.message)}\n`);
    }
  }
}

async function cmdClaim(name) {
  const names = accountNames();
  const target = name || names[0];
  if (!names.includes(target)) {
    console.error(`Unknown account "${target}". Available: ${names.map((n) => n || '(default)').join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const credentials = loadAccountCredentials(target);
  await claimAvailablePlans(credentials);
  await printAccountUsage(credentials);
}

// ---------------------------------------------------------------------------
// Capture / list / remove
// ---------------------------------------------------------------------------

function readCredentialsInfo(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const decrypted = {};
  for (const [key, value] of Object.entries(raw)) {
    try {
      decrypted[key] = decryptCredential(value);
    } catch {
      decrypted[key] = null;
    }
  }
  let email = '';
  let uuid = '';
  try {
    const info = JSON.parse(decrypted['oauth:zai:user_info'] || '{}');
    email = info.email || '';
    uuid = info.user_id || info.id || '';
  } catch {
    // ignore
  }
  let expiresAt = null;
  const jwt = decrypted.zcodejwttoken;
  if (jwt && typeof jwt === 'string' && jwt.split('.').length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
      if (typeof payload.exp === 'number') expiresAt = payload.exp * 1000;
    } catch {
      // ignore
    }
  }
  return { jwt, email, uuid, expiresAt };
}

function formatExpiry(ms) {
  if (ms === null) return 'unknown expiry';
  const diff = ms - Date.now();
  const date = new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  if (diff <= 0) return `EXPIRED ${date}`;
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  return `valid until ${date} (${days}d ${hours}h left)`;
}

function cmdAdd(name, credFile, telemetryFile) {
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
    console.error(`\n  ${ui.yellow('usage:')} node add <name> [credentials.json [telemetry-state.json]]`);
    console.error(`  ${ui.dim('Captures the login currently active in the ZCode desktop app.')}\n`);
    process.exitCode = 1;
    return;
  }
  const destDir = path.join(accountsRoot(), name);
  const destCred = path.join(destDir, 'credentials.json');
  if (fs.existsSync(destCred) && !process.argv.includes('--force')) {
    console.error(`Account "${name}" already exists. Re-add with --force to overwrite.`);
    process.exitCode = 1;
    return;
  }

  const sourceCred = credFile || path.join(zcodeHome(), 'v2', 'credentials.json');
  const sourceTelemetry = telemetryFile || path.join(zcodeHome(), 'v2', 'telemetry-state.json');
  if (!fs.existsSync(sourceCred)) {
    console.error(credFile
      ? `File not found: ${sourceCred}`
      : `No ZCode login found at ${sourceCred}. Use "node accounts login ${name}" instead.`);
    process.exitCode = 1;
    return;
  }

  let info;
  try {
    info = readCredentialsInfo(sourceCred);
  } catch (error) {
    console.error(`Could not read ${sourceCred}: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (!info.jwt) {
    console.error(`${sourceCred} has no zcodejwttoken; cannot add this account.`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(sourceCred, destCred);
  if (fs.existsSync(sourceTelemetry)) {
    fs.copyFileSync(sourceTelemetry, path.join(destDir, 'telemetry-state.json'));
  } else {
    try {
      fs.rmSync(path.join(destDir, 'telemetry-state.json'));
    } catch {
      // ignore
    }
  }

  console.log(`Added account "${name}" (${info.email || info.uuid || 'unknown user'}).`);
  console.log(`Token: ${formatExpiry(info.expiresAt)}`);
  console.log('The proxy picks it up on the next request - no restart needed.');
}

function cmdList() {
  const names = accountNames();
  console.log(`\n  ${ui.bold('ZCodeBridge')} ${ui.dim('·')} ${ui.cyan('accounts')} ${ui.dim(`· ${names.length} configured · ${accountsRoot()}`)}\n`);
  for (const name of names) {
    const label = (name || '(default)').padEnd(18);
    const file = name
      ? path.join(accountsRoot(), name, 'credentials.json')
      : path.join(zcodeHome(), 'v2', 'credentials.json');
    try {
      const info = readCredentialsInfo(file);
      console.log(`  ${ui.green('●')} ${ui.bold(label)} ${(info.email || info.uuid || 'unknown user').padEnd(28)} ${ui.dim(formatExpiry(info.expiresAt))}`);
    } catch (error) {
      console.log(`  ${ui.red('●')} ${ui.bold(label)} ${ui.red('unreadable: ' + error.message)}`);
    }
  }
  console.log();
  if (names.length > 1) {
    console.log(`  ${ui.dim('Requests rotate across all accounts · pin one with header')} ${ui.cyan('x-zcode-account: <name>')}`);
  } else {
    console.log(`  ${ui.dim('Add more accounts with:')} ${ui.cyan('node accounts login')}`);
  }
  console.log(`  ${ui.dim('Live usage:')} ${ui.cyan('node accounts usage')}\n`);
}

function cmdRemove(name) {
  if (!name) {
    usage();
    process.exitCode = 1;
    return;
  }
  const dir = path.join(accountsRoot(), name);
  if (!fs.existsSync(dir)) {
    console.error(`No such account: ${name}`);
    process.exitCode = 1;
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`Removed account "${name}".`);
}

// ---------------------------------------------------------------------------

function run(command, args = []) {
  switch (command) {
    case 'login':
      cmdLogin(args[0]);
      break;
    case 'add':
      cmdAdd(args[0], args[1], args[2]);
      break;
    case 'usage':
      cmdUsage();
      break;
    case 'claim':
      cmdClaim(args[0]);
      break;
    case 'list':
      cmdList();
      break;
    case 'remove':
    case 'rm':
      cmdRemove(args[0]);
      break;
    case 'path':
      console.log(accountsRoot());
      break;
    default:
      usage();
      if (command && command !== 'help' && command !== '--help') process.exitCode = 1;
  }
}

// Standalone wrappers (node auth, node usage, node list, ...) call these.
module.exports = { run, cmdLogin, cmdAdd, cmdUsage, cmdClaim, cmdList, cmdRemove, usage };

if (require.main === module) {
  run(process.argv[2], process.argv.slice(3));
}
