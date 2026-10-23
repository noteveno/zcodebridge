#!/usr/bin/env node
/* Regression suite for zcode2proxy. */
const BASE = process.env.PROXY_URL || 'http://127.0.0.1:8787';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, detail = '') {
  pass += 1;
  console.log(`PASS  ${name}${detail ? '  -- ' + detail : ''}`);
}
function bad(name, detail) {
  fail += 1;
  failures.push({ name, detail });
  console.log(`FAIL  ${name}  -- ${detail}`);
}

async function post(path, body, headers = {}) {
  const started = Date.now();
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240000),
  });
  return { res, ms: Date.now() - started };
}

async function postJson(path, body, headers = {}) {
  const { res, ms } = await post(path, body, headers);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { res, ms, text, json };
}

async function readSse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = '';
      const data = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      events.push({ event, data: data.join('\n') });
    }
  }
  return events;
}

function textOfOpenAI(json) {
  const msg = json?.choices?.[0]?.message;
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) return msg.content.map((p) => p.text || '').join('');
  return '';
}

async function openaiNonStream(name, model, prompt, extra = {}) {
  try {
    const { res, ms, text, json } = await postJson('/v1/chat/completions', {
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 256,
      ...extra,
    });
    if (res.status !== 200) return bad(name, `HTTP ${res.status}: ${text.slice(0, 300)}`);
    const content = textOfOpenAI(json);
    if (!content) return bad(name, `empty content: ${text.slice(0, 300)}`);
    ok(name, `${ms}ms: ${content.replace(/\s+/g, ' ').slice(0, 120)}`);
    return { json, content };
  } catch (error) {
    return bad(name, error.message);
  }
}

async function openaiStream(name, model, prompt, extra = {}) {
  try {
    const { res, ms } = await post('/v1/chat/completions', {
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 256,
      stream: true,
      ...extra,
    });
    if (res.status !== 200) {
      const t = await res.text();
      return bad(name, `HTTP ${res.status}: ${t.slice(0, 300)}`);
    }
    const events = await readSse(res);
    const done = events.some((e) => e.data === '[DONE]');
    const chunks = events.filter((e) => e.data && e.data !== '[DONE]').map((e) => JSON.parse(e.data));
    const roleChunk = chunks.some((c) => c.choices?.[0]?.delta?.role === 'assistant');
    const content = chunks.map((c) => c.choices?.[0]?.delta?.content || '').join('');
    const finish = chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean).pop();
    const usage = chunks.map((c) => c.usage).filter(Boolean).pop();
    if (!done) return bad(name, 'missing [DONE]');
    if (!roleChunk) return bad(name, 'missing assistant role chunk');
    if (!content.trim()) return bad(name, 'no content deltas');
    ok(name, `${ms}ms finish=${finish} chunks=${chunks.length} usage=${JSON.stringify(usage || null)} text=${content.replace(/\s+/g, ' ').slice(0, 80)}`);
    return { chunks, content, finish, usage };
  } catch (error) {
    return bad(name, error.message);
  }
}

async function anthropicNonStream(name, model, prompt, extra = {}) {
  try {
    const { res, ms, text, json } = await postJson('/v1/messages', {
      model,
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
      ...extra,
    });
    if (res.status !== 200) return bad(name, `HTTP ${res.status}: ${text.slice(0, 300)}`);
    const content = (json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!content) return bad(name, `empty content: ${text.slice(0, 300)}`);
    ok(name, `${ms}ms stop=${json.stop_reason} model=${json.model} text=${content.replace(/\s+/g, ' ').slice(0, 100)}`);
    return { json, content };
  } catch (error) {
    return bad(name, error.message);
  }
}

async function anthropicStream(name, model, prompt, extra = {}) {
  try {
    const { res, ms } = await post('/v1/messages', {
      model,
      max_tokens: 256,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
      ...extra,
    });
    if (res.status !== 200) {
      const t = await res.text();
      return bad(name, `HTTP ${res.status}: ${t.slice(0, 300)}`);
    }
    const events = await readSse(res);
    const types = events.map((e) => e.event);
    const deltas = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => { try { return JSON.parse(e.data).delta?.text || ''; } catch { return ''; } })
      .join('');
    const start = types.includes('message_start');
    const stop = types.includes('message_stop');
    const usage = events
      .filter((e) => e.event === 'message_delta')
      .map((e) => { try { return JSON.parse(e.data).usage; } catch { return null; } })
      .filter(Boolean)
      .pop();
    if (!start || !stop) return bad(name, `events=${types.join(',')}`);
    if (!deltas.trim()) return bad(name, 'no text deltas');
    ok(name, `${ms}ms events=${types.length} usage=${JSON.stringify(usage || null)} text=${deltas.replace(/\s+/g, ' ').slice(0, 80)}`);
    return { events, deltas };
  } catch (error) {
    return bad(name, error.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
console.log('--- health & models ---');
try {
  const res = await fetch(BASE + '/health');
  const json = await res.json();
  if (res.status === 200 && json.ok === true) ok('GET /health', JSON.stringify(json.models));
  else bad('GET /health', `HTTP ${res.status}`);
} catch (e) { bad('GET /health', e.message); }

try {
  const res = await fetch(BASE + '/v1/models');
  const json = await res.json();
  const ids = (json.data || []).map((m) => m.id);
  if (res.status === 200 && ids.length === 2) ok('GET /v1/models', ids.join(', '));
  else bad('GET /v1/models', `HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
} catch (e) { bad('GET /v1/models', e.message); }

try {
  const res = await fetch(BASE + '/nope');
  if (res.status === 404) ok('unknown route -> 404');
  else bad('unknown route -> 404', `HTTP ${res.status}`);
} catch (e) { bad('unknown route -> 404', e.message); }

// ---------------------------------------------------------------------------
console.log('--- OpenAI ---');
const oa = await openaiNonStream('OpenAI non-stream (flash)', 'GLM-5.3-Flash', 'Reply with exactly the token PROXY_OK and nothing else.', { max_tokens: 64 });
if (oa?.content && !/PROXY_OK/i.test(oa.content)) bad('OpenAI flash content check', `expected PROXY_OK, got: ${oa.content.slice(0, 120)}`);
else if (oa) ok('OpenAI flash content check');

await sleep(500);
await openaiStream('OpenAI stream (flash)', 'GLM-5.3-Flash', 'Count from 1 to 5, separated by spaces.', { max_tokens: 128 });

await sleep(500);
await openaiNonStream('OpenAI model alias gpt-4o-mini', 'gpt-4o-mini', 'Reply with one word: alias-ok', { max_tokens: 64 });

// ---------------------------------------------------------------------------
console.log('--- Anthropic ---');
await sleep(500);
await anthropicNonStream('Anthropic non-stream (flash)', 'GLM-5.3-Flash', 'Reply with exactly: ANTHROPIC_OK', { max_tokens: 64 });

await sleep(500);
await anthropicStream('Anthropic stream (flash)', 'GLM-5.3-Flash', 'Say the word "stream" three times.', { max_tokens: 128 });

// ---------------------------------------------------------------------------
console.log('--- tools ---');
await sleep(500);
let toolCallId = null;
try {
  const { res, ms, text, json } = await postJson('/v1/chat/completions', {
    model: 'GLM-5.3-Flash',
    max_tokens: 512,
    tool_choice: 'required',
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get current weather for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      },
    }],
    messages: [{ role: 'user', content: 'Use get_weather for Paris.' }],
  });
  if (res.status !== 200) bad('OpenAI tool call (non-stream)', `HTTP ${res.status}: ${text.slice(0, 300)}`);
  else {
    const msg = json.choices?.[0]?.message;
    const call = msg?.tool_calls?.[0];
    if (!call) bad('OpenAI tool call (non-stream)', `no tool_calls: ${text.slice(0, 300)}`);
    else {
      toolCallId = call.id;
      let args = null;
      try { args = JSON.parse(call.function.arguments); } catch {}
      const argsOk = args && typeof args.city === 'string' && /paris/i.test(args.city);
      ok('OpenAI tool call (non-stream)', `${ms}ms finish=${json.choices?.[0]?.finish_reason} name=${call.function.name} args=${call.function.arguments}`);
      if (!argsOk) bad('OpenAI tool args check', `expected city=Paris, got ${call.function.arguments}`);
      else ok('OpenAI tool args check');
    }
  }
} catch (e) { bad('OpenAI tool call (non-stream)', e.message); }

await sleep(500);
try {
  const { res, ms } = await post('/v1/chat/completions', {
    model: 'GLM-5.3-Flash',
    max_tokens: 512,
    stream: true,
    tool_choice: 'required',
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get current weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    }],
    messages: [{ role: 'user', content: 'Use get_weather for Tokyo.' }],
  });
  if (res.status !== 200) {
    const t = await res.text();
    bad('OpenAI tool call (stream)', `HTTP ${res.status}: ${t.slice(0, 300)}`);
  } else {
    const events = await readSse(res);
    const chunks = events.filter((e) => e.data && e.data !== '[DONE]').map((e) => JSON.parse(e.data));
    const calls = [];
    for (const c of chunks) {
      for (const tc of c.choices?.[0]?.delta?.tool_calls || []) {
        const idx = tc.index ?? 0;
        calls[idx] = calls[idx] || { id: '', name: '', args: '' };
        if (tc.id) calls[idx].id = tc.id;
        if (tc.function?.name) calls[idx].name = tc.function.name;
        if (tc.function?.arguments) calls[idx].args += tc.function.arguments;
      }
    }
    const finish = chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean).pop();
    if (!calls.length || !calls[0]?.name) bad('OpenAI tool call (stream)', `no tool call chunks (finish=${finish})`);
    else ok('OpenAI tool call (stream)', `${ms}ms finish=${finish} name=${calls[0].name} args=${calls[0].args}`);
  }
} catch (e) { bad('OpenAI tool call (stream)', e.message); }

// ---------------------------------------------------------------------------
console.log('--- tool result round trip ---');
await sleep(500);
if (!toolCallId) {
  bad('OpenAI tool result round trip', 'skipped: no tool call id from previous test');
} else {
  try {
    const { res, ms, text, json } = await postJson('/v1/chat/completions', {
      model: 'GLM-5.3-Flash',
      max_tokens: 256,
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather for a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      }],
      messages: [
        { role: 'user', content: 'Use get_weather for Paris.' },
        { role: 'assistant', content: null, tool_calls: [{ id: toolCallId, type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
        { role: 'tool', tool_call_id: toolCallId, content: '{"temperature_c":21,"condition":"sunny"}' },
      ],
    });
    if (res.status !== 200) bad('OpenAI tool result round trip', `HTTP ${res.status}: ${text.slice(0, 300)}`);
    else {
      const content = textOfOpenAI(json);
      if (!content) bad('OpenAI tool result round trip', `empty answer: ${text.slice(0, 300)}`);
      else ok('OpenAI tool result round trip', `${ms}ms: ${content.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  } catch (e) { bad('OpenAI tool result round trip', e.message); }
}

// ---------------------------------------------------------------------------
console.log('--- system prompt override ---');
await sleep(500);
try {
  const { res, ms, text, json } = await postJson('/v1/chat/completions', {
    model: 'GLM-5.3-Flash',
    max_tokens: 128,
    messages: [
      { role: 'system', content: 'You are a helpful assistant. Always answer in French, in one short sentence.' },
      { role: 'user', content: 'What is the capital of France?' },
    ],
  });
  if (res.status !== 200) bad('OpenAI system prompt override', `HTTP ${res.status}: ${text.slice(0, 300)}`);
  else {
    const content = textOfOpenAI(json);
    const french = /paris/i.test(content) && /(est|la|le|capitale)/i.test(content);
    if (!french) bad('OpenAI system prompt override', `expected French answer about Paris, got: ${content.slice(0, 200)}`);
    else ok('OpenAI system prompt override', `${ms}ms: ${content.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
} catch (e) { bad('OpenAI system prompt override', e.message); }

// ---------------------------------------------------------------------------
console.log('--- Anthropic tools + JSON schema ---');
await sleep(500);
try {
  const { res, ms, text, json } = await postJson('/v1/messages', {
    model: 'GLM-5.3-Flash',
    max_tokens: 512,
    tool_choice: { type: 'any' },
    tools: [{
      name: 'lookup_order',
      description: 'Look up an order by id',
      input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
    }],
    messages: [{ role: 'user', content: 'Look up order A-123 using the tool.' }],
  });
  if (res.status !== 200) bad('Anthropic tool call (non-stream)', `HTTP ${res.status}: ${text.slice(0, 300)}`);
  else {
    const use = (json.content || []).find((b) => b.type === 'tool_use');
    if (!use) bad('Anthropic tool call (non-stream)', `no tool_use block: ${text.slice(0, 300)}`);
    else ok('Anthropic tool call (non-stream)', `${ms}ms stop=${json.stop_reason} name=${use.name} input=${JSON.stringify(use.input)}`);
  }
} catch (e) { bad('Anthropic tool call (non-stream)', e.message); }

await sleep(500);
try {
  const { res, ms, text, json } = await postJson('/v1/chat/completions', {
    model: 'GLM-5.3-Flash',
    max_tokens: 512,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'city_info',
        schema: {
          type: 'object',
          properties: { city: { type: 'string' }, country: { type: 'string' } },
          required: ['city', 'country'],
          additionalProperties: false,
        },
      },
    },
    messages: [{ role: 'user', content: 'Return JSON for Paris, France.' }],
  });
  if (res.status !== 200) bad('OpenAI json_schema', `HTTP ${res.status}: ${text.slice(0, 300)}`);
  else {
    const content = textOfOpenAI(json);
    let parsed = null;
    try { parsed = JSON.parse(content); } catch {}
    if (!parsed || !/paris/i.test(parsed.city || '') || !/france/i.test(parsed.country || '')) {
      bad('OpenAI json_schema', `expected {"city":"Paris","country":"France"}, got: ${content.slice(0, 200)}`);
    } else ok('OpenAI json_schema', `${ms}ms: ${content.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
} catch (e) { bad('OpenAI json_schema', e.message); }

// ---------------------------------------------------------------------------
console.log('--- long conversation ---');
await sleep(500);
try {
  const messages = [];
  for (let i = 0; i < 8; i += 1) {
    messages.push({ role: 'user', content: `Remember number ${i}.` });
    messages.push({ role: 'assistant', content: `I will remember ${i}.` });
  }
  messages.push({ role: 'user', content: 'What is the sum of the numbers I asked you to remember? Reply with just the number.' });
  const { res, ms, text, json } = await postJson('/v1/chat/completions', {
    model: 'GLM-5.3-Flash',
    max_tokens: 128,
    messages,
  });
  if (res.status !== 200) bad('Long conversation', `HTTP ${res.status}: ${text.slice(0, 300)}`);
  else {
    const content = textOfOpenAI(json);
    if (!/28/.test(content)) bad('Long conversation', `expected 28, got: ${content.slice(0, 200)}`);
    else ok('Long conversation', `${ms}ms: ${content.replace(/\s+/g, ' ').slice(0, 80)}`);
  }
} catch (e) { bad('Long conversation', e.message); }

// ---------------------------------------------------------------------------
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (fail) {
  for (const f of failures) console.log(`  FAILED: ${f.name} -- ${f.detail}`);
  process.exitCode = 1;
}
