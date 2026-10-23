'use strict';

// ZCode credential decryption and multi-account storage.
//
// '' is the live ZCode login in ~/.zcode/v2; every other account is a
// folder under accounts/ containing credentials.json (+ telemetry-state.json).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { config, log, ROOT } = require('./config');
const { HttpError, readJsonIfExists } = require('./util');

function zcodeHome() {
  if (config.dataDir) return config.dataDir;
  if (process.env.ZCODE_DATA_BASE_DIR) return process.env.ZCODE_DATA_BASE_DIR;
  return path.join(os.homedir(), '.zcode');
}

function credentialSecret() {
  if (process.env.ZCODE_CREDENTIAL_SECRET) return process.env.ZCODE_CREDENTIAL_SECRET;
  let username = 'unknown';
  try {
    username = os.userInfo().username;
  } catch {
    // ignore
  }
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
}

function decryptCredential(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:v1:')) return value;
  const parts = value.slice('enc:v1:'.length).split('.');
  if (parts.length !== 3) throw new Error('invalid credential format');
  const [ivB64, tagB64, dataB64] = parts;
  if (!ivB64 || !tagB64 || dataB64 === undefined) throw new Error('invalid credential format');
  const key = crypto.createHash('sha256').update(credentialSecret()).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function accountsRoot() {
  if (config.accountsDir) return config.accountsDir;
  if (process.env.ZCODE_ACCOUNTS_DIR) return process.env.ZCODE_ACCOUNTS_DIR;
  return path.join(ROOT, 'accounts');
}

function accountNames() {
  const names = config.useDefaultAccount === false ? [] : [''];
  try {
    for (const entry of fs.readdirSync(accountsRoot(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!/^[A-Za-z0-9._-]+$/.test(entry.name)) continue;
      if (fs.existsSync(path.join(accountsRoot(), entry.name, 'credentials.json'))) {
        names.push(entry.name);
      }
    }
  } catch {
    // no accounts dir yet - single account mode
  }
  return names;
}

function accountDir(name) {
  return name ? path.join(accountsRoot(), name) : path.join(zcodeHome(), 'v2');
}

function readDeviceMid(dir) {
  for (const name of ['telemetry-state.json', 'onboarding-record.json']) {
    const value = readJsonIfExists(path.join(dir, name));
    if (value && typeof value.deviceMid === 'string' && value.deviceMid.trim()) {
      return value.deviceMid.trim();
    }
  }
  return crypto.randomUUID();
}

let credentialsCache = { mtimeMs: 0, data: null };
const accountCaches = new Map();

function loadAccountCredentials(name = '', force = false) {
  const dir = accountDir(name);
  const file = path.join(dir, 'credentials.json');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new HttpError(
      503,
      name
        ? `Account "${name}" has no credentials.json in ${dir}. Run: node accounts.js add ${name}`
        : `ZCode credentials not found at ${file}. Open ZCode and sign in once, then retry.`,
      'zcode_credentials_missing',
    );
  }

  const cache = name ? accountCaches.get(name) : credentialsCache;
  if (!force && cache && cache.data && cache.mtimeMs === stat.mtimeMs) {
    return cache.data;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new HttpError(503, `Could not read credentials for account ${name || '(default)'}: ${error.message}`, 'zcode_credentials_unreadable');
  }

  const decrypted = {};
  for (const [key, value] of Object.entries(raw)) {
    try {
      decrypted[key] = decryptCredential(value);
    } catch (error) {
      decrypted[key] = null;
      log('debug', `could not decrypt credential ${key}: ${error.message}`);
    }
  }

  const jwt = decrypted.zcodejwttoken;
  if (!jwt || typeof jwt !== 'string' || !jwt.trim()) {
    throw new HttpError(
      503,
      `Login token (zcodejwttoken) was not found for account ${name || '(default)'}. Sign in again and re-add the account.`,
      'zcode_token_missing',
    );
  }

  let userInfo = {};
  try {
    userInfo = JSON.parse(decrypted['oauth:zai:user_info'] || '{}');
  } catch {
    userInfo = {};
  }

  const data = {
    name: name || '',
    jwt: jwt.trim(),
    accessToken: (decrypted['oauth:zai:access_token'] || '').trim(),
    userInfo,
    accountUuid: typeof userInfo.user_id === 'string' ? userInfo.user_id : '',
    deviceMid: readDeviceMid(dir),
    file,
  };

  if (name) accountCaches.set(name, { mtimeMs: stat.mtimeMs, data });
  else credentialsCache = { mtimeMs: stat.mtimeMs, data };
  return data;
}

let rotationIndex = 0;

function pickFrom(names) {
  if (names.length === 1) return names[0];
  const name = names[rotationIndex % names.length];
  rotationIndex += 1;
  return name;
}

function pickAccount(preferred) {
  const names = accountNames();
  if (preferred !== undefined && preferred !== null && preferred !== '') {
    if (!names.includes(preferred)) {
      throw new HttpError(
        404,
        `Unknown account "${preferred}". Available accounts: ${names.map((n) => n || '(default)').join(', ')}`,
        'unknown_account',
      );
    }
    return preferred;
  }
  return pickFrom(names);
}

module.exports = {
  zcodeHome,
  credentialSecret,
  decryptCredential,
  accountsRoot,
  accountNames,
  accountDir,
  readDeviceMid,
  loadAccountCredentials,
  pickAccount,
  pickFrom,
};
