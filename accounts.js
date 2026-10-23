#!/usr/bin/env node
'use strict';

/*
 * zcode2proxy account manager
 * --------------------------------
 * node accounts.js login <name>
 *     Start a Z.ai OAuth login for a NEW account. Prints a link you open
 *     in your browser yourself (nothing opens automatically). After you
 *     log in, the code is captured automatically on
 *     http://127.0.0.1:<port>/callback - or you paste the final URL back
 *     here. The account is stored under accounts/<name>/ and any free
 *     coding plan is claimed automatically.
 *
 * node accounts.js add <name> [credentials.json [telemetry-state.json]]
 *     Capture the login currently active in the ZCode desktop app.
 *
 * node accounts.js usage
 *     Live plan usage for every account (tokens used/left, expiry).
 *
 * node accounts.js claim [name]
 *     Claim any available free plan for an account.
 *
 * node accounts.js list | remove <name> | path
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
  console.log(`usage:
  node accounts.js login [name]
      Z.ai OAuth login for a new account. The name is optional - when
      omitted, the account is named after the signed-in email (part
      before @). After signing in, copy the zcode://oauth/callback?...
      link from the login-complete page and paste it into the terminal
      (works from any browser, on any device/network).
  node accounts.js add <name> [credentials.json [telemetry-state.json]]
      Capture the login currently active in the ZCode desktop app.
  node accounts.js usage
      Live plan usage (tokens used/left, expiry) for every account.
  node accounts.js claim [name]
      Claim any available free coding plan.
  node accounts.js list
      Show all accounts with email and token expiry.
  node accounts.js remove <name>
      Delete a stored account (the default login is never touched).
  node accounts.js path
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
    console.error('Usage: node accounts.js login [name]   (letters, digits, . _ -; or omit to name it after the account email)');
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

  console.log(name
    ? `Z.ai login for account "${name}"`
    : 'Z.ai login (the account will be named after the signed-in email automatically)');
  console.log('\n1. Open this link in your browser and sign in (or sign up) with the account');
  console.log('   you want to add:');
  console.log('\n   ' + authorizeUrl + '\n');
  console.log('2. After signing in, the page may ask to open the ZCode app or show a');
  console.log('   "login complete" screen. In every case: copy the link from the browser');
  console.log('   ADDRESS BAR (it contains code=...). If there is a button linking to');
  console.log('   zcode://oauth/callback, right-click it -> "Copy link address" works too.');
  console.log('   Do not click that button - it would open the ZCode desktop app.');
  console.log('\n3. Paste the copied link here and press Enter.');
  console.log('   (This also works from a browser on another device/network.)');
  console.log('\nWaiting for the callback link... (timeout 10 minutes, Ctrl+C to cancel)');

  let callback;
  try {
    callback = await waitForCallbackPaste(10 * 60 * 1000);
  } catch (error) {
    console.error('Login failed: ' + error.message);
    process.exitCode = 1;
    return;
  }
  if (callback.state && callback.state !== state) {
    console.error('State mismatch - the login reply is not for this session. Try again.');
    process.exitCode = 1;
    return;
  }

  console.log('Exchanging authorization code...');
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

  console.log('Resolving business token...');
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
    console.warn('Business token exchange failed (' + error.message + '); using the raw OAuth token.');
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
    console.log(`\nAccount name: ${name}`);
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
  console.log(`\nAccount "${name}" saved (${normalizedUser.email || normalizedUser.user_id || 'unknown user'}).`);

  // Same "claim free plan" button the desktop app shows after signup.
  const credentials = { name, jwt, deviceMid, userInfo: normalizedUser };
  await claimAvailablePlans(credentials);
  await printAccountUsage(credentials);
  console.log('\nDone. The proxy picks the account up on the next request - no restart needed.');
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

async function printAccountUsage(credentials) {
  try {
    const data = await fetchAccountUsage(credentials, true);
    const nowMs = (data.server_time ? data.server_time * 1000 : Date.now());
    const balances = Array.isArray(data.balances) ? data.balances : [];
    const plans = Array.isArray(data.plans) ? data.plans : [];
    const active = plans.filter((p) => p.status === 'active');
    if (active.length) {
      const endsAt = Math.max(...active.map((p) => p.ends_at));
      const left = endsAt * 1000 - nowMs;
      console.log(`Plan: ${active.map((p) => p.name).join(' + ')} - ${left > 0
        ? `expires ${new Date(endsAt * 1000).toISOString().slice(0, 19).replace('T', ' ')} (${Math.floor(left / 86400000)}d ${Math.floor((left % 86400000) / 3600000)}h left)`
        : 'EXPIRED'}`);
    } else {
      console.log('Plan: none active (claim one with: node accounts.js claim ' + (credentials.name || '') + ')');
    }
    for (const b of balances) {
      console.log(`  ${String(b.show_name || '?').padEnd(14)} used ${formatTokens(b.used_units)} / ${formatTokens(b.total_units)}  remaining ${formatTokens(b.remaining_units)}  resets ${b.period_end ? new Date(b.period_end * 1000).toISOString().slice(0, 19).replace('T', ' ') : '-'}`);
    }
    if (!balances.length) console.log('  (no token buckets found)');
  } catch (error) {
    console.error('Usage check failed: ' + error.message);
  }
}

async function cmdUsage() {
  for (const name of accountNames()) {
    console.log(`\n=== ${name || '(default)'} ===`);
    try {
      const credentials = loadAccountCredentials(name);
      console.log(`user: ${credentials.userInfo.email || credentials.accountUuid || 'unknown'}`);
      await printAccountUsage(credentials);
    } catch (error) {
      console.error('  ' + error.message);
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
    console.error(`Invalid account name "${name}". Use letters, digits, . _ - only.`);
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
      : `No ZCode login found at ${sourceCred}. Use "node accounts.js login ${name}" instead.`);
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
  console.log(`Accounts directory: ${accountsRoot()}`);
  for (const name of names) {
    const label = name || '(default)';
    const file = name
      ? path.join(accountsRoot(), name, 'credentials.json')
      : path.join(zcodeHome(), 'v2', 'credentials.json');
    try {
      const info = readCredentialsInfo(file);
      console.log(`  ${label.padEnd(20)} ${info.email || info.uuid || 'unknown user'}  ${formatExpiry(info.expiresAt)}`);
    } catch (error) {
      console.log(`  ${label.padEnd(20)} unreadable: ${error.message}`);
    }
  }
  if (names.length > 1) {
    console.log('\nRequests rotate across all accounts. Pin one with the header: x-zcode-account: <name>');
  } else {
    console.log('\nAdd more accounts with: node accounts.js login <name>');
  }
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

const [command, ...args] = process.argv.slice(2);
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
