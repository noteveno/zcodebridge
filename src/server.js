'use strict';

// HTTP server: routing, request handlers, auth, error rendering.

const http = require('node:http');
const { config, log, VERSION, APP_VERSION } = require('./config');
const { HttpError, makeSessionId, readResponseText } = require('./util');
const { accountNames, loadAccountCredentials } = require('./credentials');
const { upstreamUrl, upstreamRequestWithRetry, clampMaxTokens } = require('./upstream');
const { fetchAccountUsage, cachedAccountUsage, capabilityModels } = require('./billing');
const stats = require('./stats');
const { modelList, mapModel, mergeDiscoveredModels, knownModels, splitEffortSuffix, normalizeEffort } = require('./models');
const { openAIToAnthropic, anthropicToOpenAIResponse, streamAnthropicToOpenAI } = require('./openai');
const { rewriteAnthropicJson, streamAnthropicPassthrough } = require('./anthropic');
const { responsesToAnthropic, anthropicToResponses, streamAnthropicToResponses } = require('./responses');

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function setCors(res) {
  if (!config.cors) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, x-zcode-account');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendOpenAIError(res, status, message, code = 'proxy_error', type = 'invalid_request_error') {
  sendJson(res, status, { error: { message, type, param: null, code } });
}

function sendAnthropicError(res, status, message, type = 'invalid_request_error') {
  sendJson(res, status, { type: 'error', error: { type, message } });
}

function authenticate(req) {
  if (!config.apiKey) return true;
  const authorization = req.headers.authorization || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const xApiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : '';
  return bearer === config.apiKey || xApiKey === config.apiKey;
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large', 'payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new HttpError(400, `Invalid JSON body: ${error.message}`, 'invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function parsePath(url) {
  try {
    return new URL(url, 'http://localhost').pathname.replace(/\/+$/, '') || '/';
  } catch {
    return '/';
  }
}

function clientSessionId(req) {
  const header = req.headers['x-session-id'] || req.headers['x-zcode-session-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return makeSessionId();
}

function requestAccount(req) {
  const header = req.headers['x-zcode-account'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return undefined;
}

// anthropic-* headers from the client that must reach the gateway
// unchanged (e.g. anthropic-beta for Claude Code auto mode classifiers).
function clientAnthropicHeaders(req) {
  const forwarded = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (/^anthropic-/i.test(name) && typeof value === 'string') {
      forwarded[name] = value;
    }
  }
  return forwarded;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleModels(req, res) {
  // Merge models granted by the plan (from cached billing data) so new
  // Z.ai models show up automatically once an account's plan covers them.
  const granted = [];
  for (const name of accountNames()) {
    granted.push(...capabilityModels(cachedAccountUsage(name)));
  }
  const fresh = mergeDiscoveredModels(granted);
  if (fresh.length) log('info', `discovered new models from plan: ${fresh.join(', ')}`);
  // Plan capabilities use lowercase ids; map them onto the configured
  // canonical names instead of listing duplicates.
  const known = knownModels();
  const canonical = new Set(
    granted.map((id) => known.find((m) => m.toLowerCase() === id.toLowerCase()) || id),
  );
  sendJson(res, 200, { object: 'list', data: modelList([...canonical]) });
}

// A daily-reset bucket spans about a day between period_start and period_end;
// the big one-time grants span days or the whole plan lifetime.
function isDailyBucket(balance, nowMs) {
  if (!balance || !balance.period_start || !balance.period_end) return false;
  return (balance.period_end - balance.period_start) <= 1.5 * 24 * 3600;
}

async function handleUsage(req, res) {
  const names = accountNames();
  const accounts = await Promise.all(names.map(async (name) => {
    const entry = { account: name || '(default)' };
    try {
      const credentials = loadAccountCredentials(name);
      entry.email = credentials.userInfo.email || credentials.accountUuid || '';
      const data = await fetchAccountUsage(credentials, req.headers['x-refresh-usage'] === '1');
      const nowMs = (data.server_time ? data.server_time * 1000 : Date.now());
      const plans = Array.isArray(data.plans) ? data.plans : [];
      const balances = Array.isArray(data.balances) ? data.balances : [];
      entry.server_time = data.server_time;
      entry.plans = plans.map((p) => ({
        name: p.name,
        plan_id: p.plan_id,
        status: p.status,
        starts_at: p.starts_at,
        ends_at: p.ends_at,
        grants: Array.isArray(p.entitlements)
          ? p.entitlements.map((e) => ({ model: e.show_name, tokens: e.grant_units, period: e.period }))
          : [],
      }));
      entry.balances = balances.map((b) => ({
        model: b.show_name,
        plan: b.plan_id,
        total_tokens: b.total_units,
        used_tokens: b.used_units,
        remaining_tokens: b.remaining_units,
        period_end: b.period_end,
        expires_at: b.expires_at,
      }));
      const active = entry.plans.filter((p) => p.status === 'active');
      entry.plan_expires_at = active.length ? Math.max(...active.map((p) => p.ends_at)) : null;
      entry.total_remaining_tokens = balances.reduce((sum, b) => sum + (Number(b.remaining_units) || 0), 0);
      entry.expired = entry.plan_expires_at
        ? entry.plan_expires_at * 1000 < nowMs
        : active.length === 0;
      // Distinguish the big one-time grants from daily-reset buckets so the
      // "plan finished, on daily tokens now" state is visible.
      const dayMs = 24 * 3600 * 1000;
      const oneTime = balances.filter((b) => !isDailyBucket(b, nowMs));
      const daily = balances.filter((b) => isDailyBucket(b, nowMs));
      const oneTimeLeft = oneTime.reduce((sum, b) => sum + (Number(b.remaining_units) || 0), 0);
      const dailyLeft = daily.reduce((sum, b) => sum + (Number(b.remaining_units) || 0), 0);
      if (oneTime.length && oneTimeLeft <= 0 && dailyLeft > 0) {
        entry.plan_status = `one-time plan tokens finished; using daily tokens (${dailyLeft} left)`;
      } else if (oneTime.length && oneTimeLeft <= 0) {
        entry.plan_status = 'all tokens used up; waiting for the daily reset or add another account';
      } else {
        entry.plan_status = 'active';
      }
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
    return entry;
  }));
  sendJson(res, 200, {
    object: 'usage',
    generated_at: new Date().toISOString(),
    accounts,
    hint: 'Send header x-refresh-usage: 1 to bypass the 30s cache.',
  });
}

async function requestUpstreamJson(anthropicBody, req, upstreamOptions = {}) {
  const upstream = await upstreamRequestWithRetry(anthropicBody, {
    sessionId: clientSessionId(req),
    account: requestAccount(req),
    ...upstreamOptions,
  });
  const text = await readResponseText(upstream.response);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new HttpError(502, 'ZCode upstream returned invalid JSON', 'upstream_invalid_json', 'api_error');
  }
  stats.noteUsage({ account: upstream.credentials.name, model: anthropicBody.model, usage: json.usage });
  return { upstream, json };
}

// The model always thinks and thinking is billed against max_tokens, so a
// small budget can be consumed entirely by thinking, leaving no text. When
// that happens, retry once with thinking effort "low".
async function requestUpstreamJsonWithText(anthropicBody, req, translate) {
  let { json } = await requestUpstreamJson(anthropicBody, req);
  let translated = translate(json);
  const message = translated.choices ? translated.choices[0]?.message : null;
  const empty = translated.output
    ? translated.output.every((o) => o.type === 'reasoning')
    : (!message?.content && !message?.tool_calls?.length);
  if (empty) {
    const retryBody = {
      ...anthropicBody,
      output_config: { ...(anthropicBody.output_config || {}), effort: 'low' },
    };
    ({ json } = await requestUpstreamJson(retryBody, req));
    translated = translate(json);
  }
  return translated;
}

async function handleOpenAIChat(req, res) {
  const body = await readBody(req);
  const requestedModel = body.model || config.defaultModel;
  let anthropicBody;
  try {
    anthropicBody = openAIToAnthropic(body);
  } catch (error) {
    if (error instanceof HttpError) {
      sendOpenAIError(res, error.status, error.message, error.code, error.type);
      return;
    }
    throw error;
  }

  const upstreamOptions = { sessionId: clientSessionId(req), account: requestAccount(req) };
  const formatType = body.response_format && typeof body.response_format === 'object'
    ? body.response_format.type
    : null;
  const jsonMode = formatType === 'json_schema' || formatType === 'json_object';

  if (body.stream === true) {
    const upstream = await upstreamRequestWithRetry(anthropicBody, upstreamOptions);
    const statsCtx = { account: upstream.credentials.name, model: anthropicBody.model };
    await streamAnthropicToOpenAI(upstream.response, res, requestedModel, { jsonMode, statsCtx });
    return;
  }

  const translated = await requestUpstreamJsonWithText(
    anthropicBody,
    req,
    (json) => anthropicToOpenAIResponse(json, requestedModel, { jsonMode }),
  );
  sendJson(res, 200, translated);
}

async function handleAnthropicMessages(req, res) {
  const body = await readBody(req);
  const requestedModel = body.model || config.defaultModel;
  const anthropicBody = {
    ...body,
    model: mapModel(splitEffortSuffix(body.model).base),
    max_tokens: clampMaxTokens(body.max_tokens),
    stream: body.stream === true,
  };
  const suffixEffort = splitEffortSuffix(body.model).effort;
  if (suffixEffort && !anthropicBody.output_config?.effort) {
    anthropicBody.output_config = {
      ...(anthropicBody.output_config || {}),
      effort: normalizeEffort(suffixEffort),
    };
  }
  delete anthropicBody.user;
  // The upstream model always thinks and rejects thinking.type "disabled"
  // (error 1210); translate it to the supported low effort instead.
  if (anthropicBody.thinking && typeof anthropicBody.thinking === 'object'
    && anthropicBody.thinking.type === 'disabled') {
    delete anthropicBody.thinking;
    anthropicBody.output_config = { ...(anthropicBody.output_config || {}), effort: 'low' };
  }
  if (anthropicBody.metadata && typeof anthropicBody.metadata === 'object') {
    // Keep client metadata fields except user_id; the proxy sets its own.
    const { user_id, ...rest } = anthropicBody.metadata;
    anthropicBody.metadata = rest;
  }

  const upstreamOptions = {
    sessionId: clientSessionId(req),
    account: requestAccount(req),
    clientHeaders: clientAnthropicHeaders(req),
  };

  if (body.stream === true) {
    const upstream = await upstreamRequestWithRetry(anthropicBody, upstreamOptions);
    await streamAnthropicPassthrough(upstream.response, res, requestedModel, { account: upstream.credentials.name, model: anthropicBody.model });
    return;
  }

  const hasUsefulContent = (json) => (Array.isArray(json.content) ? json.content : [])
    .some((block) => block && (block.type === 'text' || block.type === 'tool_use'));

  let { json } = await requestUpstreamJson(anthropicBody, req);
  if (!hasUsefulContent(json)) {
    const retryBody = {
      ...anthropicBody,
      output_config: { ...(anthropicBody.output_config || {}), effort: 'low' },
    };
    ({ json } = await requestUpstreamJson(retryBody, req));
  }
  sendJson(res, 200, rewriteAnthropicJson(json, requestedModel));
}

async function handleResponses(req, res) {
  const body = await readBody(req);
  const requestedModel = body.model || config.defaultModel;
  let anthropicBody;
  try {
    anthropicBody = responsesToAnthropic(body);
  } catch (error) {
    if (error instanceof HttpError) {
      sendOpenAIError(res, error.status, error.message, error.code, error.type);
      return;
    }
    throw error;
  }

  const upstreamOptions = { sessionId: clientSessionId(req), account: requestAccount(req) };

  if (body.stream === true) {
    const upstream = await upstreamRequestWithRetry(anthropicBody, upstreamOptions);
    await streamAnthropicToResponses(upstream.response, res, requestedModel, { account: upstream.credentials.name, model: anthropicBody.model });
    return;
  }

  const translated = await requestUpstreamJsonWithText(
    anthropicBody,
    req,
    (json) => anthropicToResponses(json, requestedModel),
  );
  sendJson(res, 200, translated);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  setCors(res);
  const started = Date.now();
  const pathname = parsePath(req.url);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!authenticate(req)) {
    if (pathname === '/v1/messages' || pathname === '/anthropic/v1/messages') {
      sendAnthropicError(res, 401, 'Invalid proxy API key', 'authentication_error');
    } else {
      sendOpenAIError(res, 401, 'Invalid proxy API key', 'invalid_api_key', 'authentication_error');
    }
    return;
  }

  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
      sendJson(res, 200, {
        ok: true,
        name: 'zcodebridge',
        version: VERSION,
        upstream: config.baseUrl,
        models: [config.defaultModel, config.flashModel],
        accounts: accountNames().map((name) => (name ? name : '(default)')),
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/models') {
      await handleModels(req, res);
      return;
    }

    if (req.method === 'GET' && (pathname === '/v1/usage' || pathname === '/usage')) {
      await handleUsage(req, res);
      return;
    }

    if (req.method === 'GET' && (pathname === '/v1/stats' || pathname === '/stats')) {
      stats.flush();
      sendJson(res, 200, { object: 'stats', generated_at: new Date().toISOString(), ...stats.summary() });
      return;
    }

    if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/chat/completions')) {
      await handleOpenAIChat(req, res);
      return;
    }

    if (req.method === 'POST' && (pathname === '/v1/messages' || pathname === '/anthropic/v1/messages' || pathname === '/messages')) {
      await handleAnthropicMessages(req, res);
      return;
    }

    if (req.method === 'POST' && (pathname === '/v1/responses' || pathname === '/responses')) {
      await handleResponses(req, res);
      return;
    }

    sendJson(res, 404, { error: { message: `No route for ${req.method} ${pathname}`, type: 'invalid_request_error', code: 'not_found' } });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof HttpError ? error.code : 'internal_error';
    const isAnthropic = pathname.includes('/messages');
    log('error', `${req.method} ${pathname} -> ${status} ${code}: ${message}`);
    // Upstream error bodies are forwarded verbatim on the Anthropic wire -
    // clients match on the upstream error wording for their retry logic.
    if (isAnthropic && error.upstreamBody) {
      res.writeHead(error.upstreamStatus || status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(error.upstreamBody);
      return;
    }
    if (isAnthropic) {
      sendAnthropicError(res, status, message, status === 401 ? 'authentication_error' : 'api_error');
    } else {
      sendOpenAIError(res, status, message, code, status === 401 ? 'authentication_error' : 'api_error');
    }
  } finally {
    log('debug', `${req.method} ${pathname} ${Date.now() - started}ms`);
  }
});

server.on('clientError', (error, socket) => {
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } catch {
    // ignore
  }
});

// --- startup banner --------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const b = (t) => paint('1', t);
const d = (t) => paint('2', t);
const c = (t) => paint('36', t);
const g = (t) => paint('32', t);

function fmtTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function printBanner() {
  const names = accountNames().map((n) => n || '(default)');
  const s = stats.summary();
  const line = d('─'.repeat(66));
  console.log('');
  console.log(`  ${line}`);
  console.log(`    ${b('ZCodeBridge')} ${d(`v${VERSION}`)}   ${d('· ZCode plan → OpenAI · Anthropic · Responses')}`);
  console.log(`  ${line}`);
  console.log(`    ${c('proxy')}       http://${config.host}:${config.port}`);
  console.log(`    ${c('endpoints')}  /v1/chat/completions · /v1/messages · /v1/responses`);
  console.log(`               /v1/models · /v1/usage · /v1/stats · /health`);
  console.log(`    ${c('models')}     ${[...new Set([config.defaultModel, config.flashModel])].join(' · ')}`);
  console.log(`    ${c('accounts')}   ${names.length ? g(names.join(' · ')) : paint('33', 'none yet - run: node auth')}`);
  console.log('');
  console.log(`    ${c('today')}      ${s.today.requests} requests · ${fmtTokens(s.today.tokensIn)} in · ${fmtTokens(s.today.tokensOut)} out`);
  console.log(`    ${c('last 7d')}    ${s.week.requests} requests · ${fmtTokens(s.week.tokensIn)} in · ${fmtTokens(s.week.tokensOut)} out`);
  console.log(`  ${line}`);
  console.log('');
}

// Friendly handling when the proxy is already running (very common when
// starting `node server` twice or when the background service owns it).
server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.log(`\n  ${paint('33', '!')} ZCodeBridge is ${paint('1', 'already running')} at ${c(`http://${config.host}:${config.port}`)}`);
    console.log(`    ${d('Nothing to fix - this new instance will exit.')}`);
    console.log(`    ${d('Open the running one in another terminal, or stop it first:')}`);
    console.log(`      ${c('node stats')}          ${d('(see live numbers from the running proxy)')}`);
    console.log(`      ${d('netstat -ano | findstr ' + config.port + '  ->  taskkill /PID <pid> /F')}\n`);
    process.exit(1);
  }
  console.error(`\n  ${paint('31', 'server error:')} ${error.message}`);
  process.exit(1);
});

function start() {
  const credentials = (() => {
    try {
      const names = accountNames();
      if (!names.length) return null;
      return loadAccountCredentials(names[0]);
    } catch (error) {
      log('warn', error.message);
      return null;
    }
  })();

  server.listen(config.port, config.host, () => {
    printBanner();
    if (!credentials) {
      log('warn', 'No account credentials loaded yet. Add one with: node auth');
    }
    if (config.apiKey) log('info', 'Proxy API key is enabled.');
  });
}

process.on('SIGINT', () => {
  log('info', 'shutting down');
  stats.flush();
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  log('info', 'shutting down');
  stats.flush();
  server.close(() => process.exit(0));
});

module.exports = { server, start };
