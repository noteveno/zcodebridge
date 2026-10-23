'use strict';

// Plan billing API: current plans, token balances, claimable plans.

const crypto = require('node:crypto');
const { config, APP_VERSION } = require('./config');
const { HttpError, readResponseText } = require('./util');
const { platformHeaders } = require('./platform');

function zcodeOrigin() {
  try {
    return new URL(config.baseUrl).origin;
  } catch {
    return 'https://zcode.z.ai';
  }
}

function billingHeaders(credentials) {
  const { xPlatform, osCategory, osVersion } = platformHeaders();
  return {
    'content-type': 'application/json',
    'http-referer': 'https://zcode.z.ai',
    'user-agent': `ZCode/${APP_VERSION}`,
    'x-zcode-app-version': APP_VERSION,
    'x-title': 'Z Code@electron',
    'x-release-channel': 'production',
    'x-client-language': 'en-US',
    'x-client-timezone': 'UTC',
    'x-zcode-agent': 'glm',
    'x-platform': xPlatform,
    'x-os-category': osCategory,
    'x-os-version': osVersion,
    'x-request-id': crypto.randomUUID(),
    'x-zcode-trace-id': crypto.randomUUID(),
    'x-query-id': crypto.randomUUID(),
    'x-device-mid': credentials.deviceMid,
    authorization: `Bearer ${credentials.jwt}`,
  };
}

async function billingRequest(credentials, path, method = 'GET', body) {
  const url = `${zcodeOrigin()}${path}${path.includes('?') ? '&' : '?'}app_version=${APP_VERSION}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: billingHeaders(credentials),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new HttpError(502, `ZCode billing request failed: ${error.message}`, 'billing_network_error', 'api_error');
  }
  const text = await readResponseText(response);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new HttpError(502, `ZCode billing returned invalid JSON (HTTP ${response.status})`, 'billing_invalid_json', 'api_error');
  }
  if (json.code !== 0) {
    throw new HttpError(502, `ZCode billing error ${json.code}: ${json.msg || 'unknown'}`, 'billing_error', 'api_error');
  }
  return json.data || {};
}

const usageCache = new Map();

async function fetchAccountUsage(credentials, force = false) {
  const cached = usageCache.get(credentials.name);
  if (!force && cached && Date.now() - cached.at < 30000) return cached.data;
  const data = await billingRequest(credentials, '/api/v1/zcode-plan/billing/balance');
  usageCache.set(credentials.name, { at: Date.now(), data });
  return data;
}

// Returns the cached usage if it is fresh enough for routing decisions
// (5 minutes); refreshes in the background when older than 30 seconds so
// the hot request path never waits on the billing API.
async function routingUsage(credentials) {
  const cached = usageCache.get(credentials.name);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
    if (Date.now() - cached.at >= 30000) {
      fetchAccountUsage(credentials, true).catch(() => {});
    }
    return cached.data;
  }
  try {
    return await fetchAccountUsage(credentials, true);
  } catch {
    return cached ? cached.data : null;
  }
}

function normalizeModelKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Aggregate remaining tokens per model from a balance payload.
// Balances carry either show_name ("GLM-5.3-Flash") or capabilities
// (["model:glm-5.3-flash"]); both are matched loosely.
function summarizeBalances(data) {
  const byModel = new Map();
  let total = 0;
  for (const balance of Array.isArray(data?.balances) ? data.balances : []) {
    const remaining = Math.max(0, Number(balance.remaining_units) || 0);
    total += remaining;
    const keys = new Set([normalizeModelKey(balance.show_name)]);
    for (const capability of Array.isArray(balance.capabilities) ? balance.capabilities : []) {
      if (typeof capability === 'string' && capability.startsWith('model:')) {
        keys.add(normalizeModelKey(capability.slice('model:'.length)));
      }
    }
    keys.delete('');
    for (const key of keys) {
      byModel.set(key, (byModel.get(key) || 0) + remaining);
    }
  }
  return { byModel, total };
}

function remainingForModel(summary, model) {
  if (!summary) return null; // no usage data -> unknown, do not block
  return summary.byModel.get(normalizeModelKey(model)) || 0;
}

// Cached usage without any network access (null when never fetched).
function cachedAccountUsage(name) {
  const cached = usageCache.get(name);
  return cached ? cached.data : null;
}

// Model ids granted by the plan, e.g. capabilities ["model:glm-5.3-flash"].
function capabilityModels(data) {
  const ids = new Set();
  for (const list of [data?.plans, data?.balances]) {
    for (const entry of Array.isArray(list) ? list : []) {
      for (const capability of Array.isArray(entry.capabilities) ? entry.capabilities : []) {
        if (typeof capability === 'string' && capability.startsWith('model:')) {
          ids.add(capability.slice('model:'.length));
        }
      }
    }
  }
  return [...ids];
}

module.exports = {
  zcodeOrigin,
  billingHeaders,
  billingRequest,
  fetchAccountUsage,
  routingUsage,
  summarizeBalances,
  remainingForModel,
  cachedAccountUsage,
  capabilityModels,
};
