'use strict';

// Talking to the ZCode plan gateway: headers, request execution, retries,
// account rotation and plan-error detection.

const crypto = require('node:crypto');
const { config, log, APP_VERSION } = require('./config');
const { HttpError, sleep, makeSessionId, readResponseText } = require('./util');
const { systemBlocks } = require('./prompts');
const { loadAccountCredentials, accountNames, pickAccount, pickFrom } = require('./credentials');
const { routingUsage, summarizeBalances, remainingForModel, fetchAccountUsage } = require('./billing');
const { platformHeaders } = require('./platform');

function upstreamUrl() {
  const base = config.baseUrl.replace(/\/+$/, '');
  if (/\/v1$/i.test(base)) return `${base}/messages`;
  // A bare origin (e.g. ZCODE_BASE_URL=https://zcode.z.ai) is not a valid
  // messages endpoint; route it to the plan gateway path instead.
  if (/^https?:\/\/[^/]+$/i.test(base)) return `${base}/api/v1/zcode-plan/anthropic/v1/messages`;
  return `${base}/v1/messages`;
}

function buildUpstreamHeaders(credentials, sessionId) {
  const { xPlatform, osCategory, osVersion } = platformHeaders();
  return {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
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
    'x-zcode-session-type': 'main',
    'x-zcode-trace-id': crypto.randomUUID(),
    'x-query-id': crypto.randomUUID(),
    'x-zcode-query-source': 'main_turn',
    'x-session-id': sessionId,
    'x-device-mid': credentials.deviceMid,
    authorization: `Bearer ${credentials.jwt}`,
  };
}

function buildMetadata(credentials, sessionId, clientMetadata) {
  const userId = JSON.stringify({
    device_id: credentials.deviceMid,
    account_uuid: credentials.accountUuid || '',
    session_id: sessionId,
  });
  const metadata = { ...(clientMetadata && typeof clientMetadata === 'object' ? clientMetadata : {}) };
  metadata.user_id = userId;
  return metadata;
}

function clampMaxTokens(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return config.maxTokens;
  return Math.max(1, Math.min(128000, Math.floor(number)));
}

async function upstreamRequest(body, options = {}) {
  const account = options.account || '';
  const credentials = loadAccountCredentials(account, options.forceCredentials === true);
  const sessionId = options.sessionId || makeSessionId();
  const includeExtra = options.includeExtra === true;
  const stream = body.stream === true;

  const payload = {
    ...body,
    system: systemBlocks(body.system, includeExtra),
    metadata: buildMetadata(credentials, sessionId, body.metadata),
    max_tokens: clampMaxTokens(body.max_tokens),
    stream,
  };

  const url = upstreamUrl();
  const headers = buildUpstreamHeaders(credentials, sessionId);
  const started = Date.now();

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    log('warn', `upstream network error: ${error.message}`);
    throw new HttpError(502, `ZCode upstream request failed: ${error.message}`, 'upstream_network_error', 'api_error');
  }

  const status = response.status;
  const contentType = response.headers.get('content-type') || '';
  const requestId = response.headers.get('x-request-id') || response.headers.get('x-log-id') || '';
  log(
    'info',
    `upstream ${status} ${stream ? 'stream' : 'json'} account=${account || '(default)'} model=${body.model || '?'} ${Date.now() - started}ms` +
      (requestId ? ` request=${requestId}` : ''),
  );

  if (status < 200 || status >= 300) {
    const text = await readResponseText(response);
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // ignore
    }
    const error = new HttpError(
      status,
      extractUpstreamErrorMessage(parsed, text, status),
      extractUpstreamErrorCode(parsed),
      status === 429 ? 'rate_limit_error' : 'api_error',
    );
    error.upstreamStatus = status;
    error.upstreamBody = text;
    error.upstreamRequestId = requestId;
    error.isWafBlock = status === 405 || (parsed && parsed.code === 3012);
    error.isPlanError = isPlanError(parsed, text);
    error.isRetryable = status === 502 || status === 503 || status === 504 || status === 429;
    throw error;
  }

  return { response, credentials, sessionId, url, status, contentType };
}

function extractUpstreamErrorMessage(parsed, text, status) {
  if (parsed) {
    if (typeof parsed.message === 'string') return parsed.message;
    if (parsed.error && typeof parsed.error.message === 'string') return parsed.error.message;
    if (typeof parsed.msg === 'string') return parsed.msg;
    if (typeof parsed.code === 'number') return `ZCode upstream error ${parsed.code}`;
  }
  if (text) return text.slice(0, 500);
  return `ZCode upstream returned HTTP ${status || 'error'}`;
}

function extractUpstreamErrorCode(parsed) {
  if (parsed) {
    if (typeof parsed.code === 'number') return String(parsed.code);
    if (parsed.error && typeof parsed.error.code === 'string') return parsed.error.code;
    if (parsed.error && typeof parsed.error.type === 'string') return parsed.error.type;
  }
  return 'upstream_error';
}

// True when the upstream rejects a request because the account has no active
// coding plan, the plan expired, or its token quota is used up.
function isPlanError(parsed, text) {
  if (parsed) {
    if (parsed.code === 3101 || parsed.code === 402) return true;
    const nested = parsed.error || {};
    if (nested.code === 3101 || nested.type === 'billing' || nested.type === 'insufficient_quota') return true;
  }
  return /coding plan|plan.{0,30}(required|expire|exhaust)|(quota|balance).{0,30}(exhaust|exceed|insufficient)|insufficient.{0,30}(quota|balance)|套餐|余额不足/i.test(text || '');
}

function shouldRetry(error, attempt) {
  if (attempt >= config.retries) return false;
  if (error.isWafBlock) return true;
  if (error.isRetryable) return true;
  return false;
}

// Builds the "what should the user do now" message when every account is out
// of tokens for the requested model: point at the other model if it still
// has quota somewhere, otherwise ask for another account.
async function quotaExhaustedMessage(model, names) {
  const others = [config.defaultModel, config.flashModel]
    .filter((m) => m !== model);
  for (const other of others) {
    let remaining = 0;
    for (const name of names) {
      try {
        const summary = summarizeBalances(await routingUsage(loadAccountCredentials(name)));
        const value = remainingForModel(summary, other);
        if (value !== null) remaining += value;
      } catch {
        // ignore
      }
    }
    if (remaining > 0) {
      return `${model} tokens are exhausted on all accounts, but ${other} still has ` +
        `${remaining >= 1e6 ? `${(remaining / 1e6).toFixed(0)}M` : remaining} tokens left. ` +
        `Switch the model to ${other}, or add another account: node accounts.js login <name>`;
    }
  }
  return `Token quota is exhausted for ${model} on all accounts. ` +
    'Add another account with: node accounts.js login <name>';
}

async function upstreamRequestWithRetry(body, options = {}) {
  let lastError;
  let includeExtra = options.includeExtra === true;
  let forceCredentials = options.forceCredentials === true;
  const allNames = accountNames();

  // Route around accounts whose token bucket for this model is empty
  // (each model has its own quota). Unknown usage never blocks a request,
  // and a suspected exhaustion is always re-checked against fresh billing
  // data before any request is rejected - the billing snapshot can lag or
  // glitch, the gateway itself is the source of truth.
  let names = allNames;
  if (allNames.length > 0 && body.model) {
    const evaluate = async (force) => {
      const eligible = [];
      const known = [];
      for (const name of allNames) {
        try {
          const credentials = loadAccountCredentials(name);
          const data = force
            ? await fetchAccountUsage(credentials, true)
            : await routingUsage(credentials);
          if (!data) {
            eligible.push(name);
            continue;
          }
          known.push(name);
          if (remainingForModel(summarizeBalances(data), body.model) > 0) eligible.push(name);
        } catch {
          eligible.push(name);
        }
      }
      return { eligible, known };
    };

    let { eligible, known } = await evaluate(false);
    if (known.length > 0 && eligible.length === 0) {
      ({ eligible, known } = await evaluate(true));
    }
    if (known.length > 0 && eligible.length === 0) {
      throw new HttpError(
        402,
        await quotaExhaustedMessage(body.model, allNames),
        'quota_exhausted',
        'insufficient_quota',
      );
    }
    if (eligible.length > 0) names = eligible;
  }

  // A failing account must not eat the retry budget meant for transient
  // upstream errors, so allow one attempt per account at minimum.
  const attempts = Math.max(config.retries + 1, names.length);
  const tried = new Set();
  let account;
  if (options.account) {
    account = pickAccount(options.account); // throws 404 for unknown names
    if (!names.includes(account)) {
      log('warn', `account ${account} has no remaining quota for model ${body.model}; using another account`);
      account = pickFrom(names);
    }
  } else {
    account = pickFrom(names);
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await upstreamRequest(body, {
        ...options,
        account,
        includeExtra,
        sessionId: options.sessionId || makeSessionId(),
        forceCredentials,
      });
    } catch (error) {
      lastError = error;
      tried.add(account);

      // A plan rejection means the billing cache is stale; refresh it so
      // later routing decisions skip this account.
      if (error.isPlanError) {
        try {
          await fetchAccountUsage(loadAccountCredentials(account, true), true);
        } catch {
          // ignore
        }
      }

      // Auth rejection or plan problem (expired / quota used up / never
      // claimed): this account cannot serve the request, so switch to the
      // next one instead of failing outright.
      const rotateReason = error.status === 401 || error.status === 403 || error.isPlanError;
      const nextAccount = rotateReason ? names.find((n) => !tried.has(n)) : undefined;
      if (nextAccount !== undefined) {
        log('warn', `account ${account || '(default)'} rejected (${error.status} ${error.code}); rotating to ${nextAccount || '(default)'}`);
        account = nextAccount;
        forceCredentials = true;
        continue;
      }
      if (rotateReason && error.isPlanError) {
        throw new HttpError(
          402,
          `No usable ZCode plan on any account (${tried.size} tried): the plan is expired or its token quota is exhausted. ` +
            'Login another account with: node accounts.js login <name>',
          'plan_expired',
          'insufficient_quota',
        );
      }

      if (!shouldRetry(error, attempt)) throw error;

      // The WAF wants the full ZCode prompt when it blocks a request.
      // Other upstream failures (502/503/504/429) are usually transient;
      // retry them with the same core prompt and a fresh session id.
      if (error.isWafBlock) {
        includeExtra = true;
      } else {
        includeExtra = false;
      }
      forceCredentials = true;

      const delay = error.isWafBlock ? 500 : 1500 * (attempt + 1);
      log('warn', `upstream retry ${attempt + 1}/${attempts} after ${error.status || 'error'} (${error.code})`);
      await sleep(delay);
    }
  }
  throw lastError;
}

module.exports = {
  platformHeaders,
  upstreamUrl,
  buildUpstreamHeaders,
  buildMetadata,
  clampMaxTokens,
  upstreamRequest,
  upstreamRequestWithRetry,
  isPlanError,
};
