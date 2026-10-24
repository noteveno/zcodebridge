'use strict';

// OpenAI Responses API (/v1/responses) translation. Codex only speaks this
// wire format, so the proxy converts Responses requests to Anthropic
// Messages and streams the result back as Responses SSE events.

const crypto = require('node:crypto');
const { config } = require('./config');
const { HttpError } = require('./util');
const { mapModel, splitEffortSuffix, normalizeEffort } = require('./models');
const { clampMaxTokens } = require('./upstream');
const { iterateSse, sseWrite } = require('./sse');
const stats = require('./stats');
const {
  contentToText,
  openAIContentToAnthropic,
  openAIToolChoiceToAnthropic,
  appendJsonModeInstruction,
  stripJsonFences,
} = require('./openai');

function responseId() {
  return `resp_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function responsesToAnthropic(body) {
  const messages = [];
  const systemParts = [];
  let pendingToolResults = [];

  const flushToolResults = () => {
    if (!pendingToolResults.length) return;
    messages.push({ role: 'user', content: pendingToolResults });
    pendingToolResults = [];
  };

  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    systemParts.push(body.instructions.trim());
  }

  const items = Array.isArray(body.input) ? body.input
    : typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: body.input }]
    : [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'function_call' && typeof item.name === 'string') {
      flushToolResults();
      let input = {};
      if (typeof item.arguments === 'string' && item.arguments.trim()) {
        try {
          input = JSON.parse(item.arguments);
        } catch {
          input = { _raw: item.arguments };
        }
      }
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: item.call_id || item.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
          name: item.name,
          input,
        }],
      });
      continue;
    }

    if (item.type === 'function_call_output') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: item.call_id || 'unknown_tool',
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '(no output)'),
      });
      continue;
    }

    if (item.type === 'reasoning' || item.type === 'local_shell_call' || item.type === 'web_search_call') {
      continue; // history artifacts; nothing to replay
    }

    const role = item.role;
    if (role === 'system' || role === 'developer') {
      const text = contentToText(item.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (role === 'user') {
      flushToolResults();
      messages.push({ role: 'user', content: openAIContentToAnthropic(item.content) });
      continue;
    }
    if (role === 'assistant') {
      flushToolResults();
      const blocks = openAIContentToAnthropic(item.content);
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (typeof item.content === 'string' || Array.isArray(item.content)) {
      // Unknown item type that still carries content: treat as user text.
      flushToolResults();
      messages.push({ role: 'user', content: openAIContentToAnthropic(item.content) });
    }
  }

  flushToolResults();

  if (messages.length === 0) {
    throw new HttpError(400, 'input must contain at least one message', 'invalid_input');
  }

  const tools = Array.isArray(body.tools)
    ? body.tools
        .filter((t) => t && typeof t === 'object' && t.type === 'function' && typeof t.name === 'string')
        .map((t) => ({
          name: t.name,
          description: typeof t.description === 'string' ? t.description : undefined,
          input_schema: t.parameters && typeof t.parameters === 'object'
            ? t.parameters
            : { type: 'object', properties: {} },
        }))
    : [];

  const { base, effort: suffixEffort } = splitEffortSuffix(body.model);
  const anthropic = {
    model: mapModel(base),
    max_tokens: clampMaxTokens(body.max_output_tokens),
    stream: body.stream === true,
    messages,
  };

  if (systemParts.length) anthropic.system = systemParts.join('\n\n');
  if (tools.length) {
    anthropic.tools = tools;
    anthropic.tool_choice = openAIToolChoiceToAnthropic(body.tool_choice, true);
  }
  if (body.temperature !== undefined) anthropic.temperature = Number(body.temperature);
  if (body.top_p !== undefined) anthropic.top_p = Number(body.top_p);

  const textFormat = body.text && typeof body.text === 'object' ? body.text.format : null;
  if (textFormat && typeof textFormat === 'object' && textFormat.type === 'json_schema' && textFormat.schema) {
    anthropic.output_config = {
      ...(anthropic.output_config || {}),
      format: { type: 'json_schema', schema: textFormat.schema },
    };
    anthropic.system = appendJsonModeInstruction(anthropic.system, textFormat.schema);
  } else if (textFormat && textFormat.type === 'json_object') {
    anthropic.system = appendJsonModeInstruction(anthropic.system, null);
  }

  const effort = body.reasoning && typeof body.reasoning === 'object' ? body.reasoning.effort : null;
  if (typeof effort === 'string' && effort) {
    // Upstream supports low/high/max only; richer client scales
    // (minimal, medium, xhigh, ultracode, ...) collapse onto them.
    const effortMap = {
      minimal: 'low', low: 'low',
      medium: 'high', high: 'high',
      xhigh: 'max', ultra: 'max', ultracode: 'max', max: 'max',
    };
    anthropic.output_config = {
      ...(anthropic.output_config || {}),
      effort: effortMap[effort.toLowerCase()] || 'high',
    };
  } else if (suffixEffort) {
    anthropic.output_config = { ...(anthropic.output_config || {}), effort: normalizeEffort(suffixEffort) };
  }

  return anthropic;
}

function usageToResponses(usage) {
  const input = Number(usage?.input_tokens) || 0;
  const output = Number(usage?.output_tokens) || 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: Number(usage?.cache_read_input_tokens) || 0 },
    output_tokens: output,
    total_tokens: input + output,
  };
}

function anthropicToResponses(json, requestedModel, options = {}) {
  const content = Array.isArray(json.content) ? json.content : [];
  const output = [];
  let text = '';

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
      output.push({
        type: 'reasoning',
        id: `rs_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        summary: [{ type: 'summary_text', text: block.thinking }],
      });
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
      output.push({
        type: 'message',
        id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: block.text, annotations: [] }],
      });
      continue;
    }
    if (block.type === 'tool_use') {
      output.push({
        type: 'function_call',
        id: `fc_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        call_id: block.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        name: block.name || 'unknown_tool',
        arguments: JSON.stringify(block.input || {}),
        status: 'completed',
      });
    }
  }

  if (options.jsonMode) {
    const stripped = stripJsonFences(text);
    if (stripped !== text) {
      for (const item of output) {
        if (item.type === 'message') {
          item.content = [{ type: 'output_text', text: stripped, annotations: [] }];
        }
      }
    }
  }

  return {
    id: responseId(),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: requestedModel || json.model || config.defaultModel,
    output,
    usage: usageToResponses(json.usage),
  };
}

// Streams Anthropic SSE translated into Responses API SSE events.
async function streamAnthropicToResponses(response, res, requestedModel, statsCtx) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const id = responseId();
  const createdAt = Math.floor(Date.now() / 1000);
  const base = { id, object: 'response', created_at: createdAt, model: requestedModel };

  let outputIndex = -1;
  const output = [];
  let usage = null;
  let textByIndex = new Map();
  const messageIds = new Map();
  let closed = false;

  const emit = (type, payload) => sseWrite(res, { type, ...payload });

  const sendCompleted = () => {
    if (closed) return;
    closed = true;
    emit('response.completed', {
      response: { ...base, status: 'completed', output, usage: usage || usageToResponses(null) },
    });
    res.end();
  };

  try {
    emit('response.created', { response: { ...base, status: 'in_progress', output: [] } });
    emit('response.in_progress', { response: { ...base, status: 'in_progress', output: [] } });

    for await (const event of iterateSse(response)) {
      if (closed) break;
      const type = event.event || '';
      let data;
      try {
        data = event.data ? JSON.parse(event.data) : null;
      } catch {
        continue;
      }
      if (!data) continue;

      if (type === 'content_block_start') {
        const block = data.content_block || {};
        if (block.type === 'thinking') {
          outputIndex += 1;
          const rsId = `rs_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
          messageIds.set(data.index, rsId);
          textByIndex.set(data.index, '');
          const item = { type: 'reasoning', id: rsId, summary: [] };
          output.push(item);
          emit('response.output_item.added', { output_index: outputIndex, item });
          emit('response.reasoning_summary_part.added', {
            item_id: rsId,
            output_index: outputIndex,
            summary_index: 0,
            part: { type: 'summary_text', text: '' },
          });
          continue;
        }
        if (block.type === 'text') {
          outputIndex += 1;
          const msgId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
          messageIds.set(data.index, msgId);
          textByIndex.set(data.index, '');
          const item = { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] };
          output.push(item);
          emit('response.output_item.added', { output_index: outputIndex, item });
          emit('response.content_part.added', {
            item_id: msgId,
            output_index: outputIndex,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          });
          continue;
        }
        if (block.type === 'tool_use') {
          outputIndex += 1;
          const callId = block.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
          messageIds.set(data.index, callId);
          textByIndex.set(data.index, '');
          const item = {
            type: 'function_call',
            id: `fc_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
            call_id: callId,
            name: block.name || 'unknown_tool',
            arguments: '',
            status: 'in_progress',
          };
          output.push(item);
          emit('response.output_item.added', { output_index: outputIndex, item });
        }
        continue;
      }

      if (type === 'content_block_delta') {
        const delta = data.delta || {};
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
          const itemId = messageIds.get(data.index);
          const full = (textByIndex.get(data.index) || '') + delta.thinking;
          textByIndex.set(data.index, full);
          emit('response.reasoning_summary_text.delta', {
            item_id: itemId,
            output_index: outputIndex,
            summary_index: 0,
            delta: delta.thinking,
          });
          continue;
        }
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
          const itemId = messageIds.get(data.index);
          const full = (textByIndex.get(data.index) || '') + delta.text;
          textByIndex.set(data.index, full);
          emit('response.output_text.delta', {
            item_id: itemId,
            output_index: outputIndex,
            content_index: 0,
            delta: delta.text,
          });
          continue;
        }
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && delta.partial_json) {
          const itemId = messageIds.get(data.index);
          const full = (textByIndex.get(data.index) || '') + delta.partial_json;
          textByIndex.set(data.index, full);
          emit('response.function_call_arguments.delta', {
            item_id: itemId,
            output_index: outputIndex,
            delta: delta.partial_json,
          });
        }
        continue;
      }

      if (type === 'content_block_stop') {
        const blockTypeAt = data.index;
        const itemId = messageIds.get(blockTypeAt);
        const full = textByIndex.get(blockTypeAt) || '';
        const item = output[outputIndex];
        if (item && item.type === 'reasoning') {
          item.summary = full ? [{ type: 'summary_text', text: full }] : [];
          if (full) {
            emit('response.reasoning_summary_text.done', { item_id: itemId, output_index: outputIndex, summary_index: 0, text: full });
          }
          emit('response.reasoning_summary_part.done', {
            item_id: itemId,
            output_index: outputIndex,
            summary_index: 0,
            part: { type: 'summary_text', text: full },
          });
          emit('response.output_item.done', { output_index: outputIndex, item });
        } else if (item && item.type === 'message') {
          item.status = 'completed';
          item.content = [{ type: 'output_text', text: full, annotations: [] }];
          emit('response.output_text.done', { item_id: itemId, output_index: outputIndex, content_index: 0, text: full });
          emit('response.content_part.done', {
            item_id: itemId,
            output_index: outputIndex,
            content_index: 0,
            part: { type: 'output_text', text: full, annotations: [] },
          });
          emit('response.output_item.done', { output_index: outputIndex, item });
        } else if (item && item.type === 'function_call') {
          item.status = 'completed';
          item.arguments = full;
          emit('response.function_call_arguments.done', { item_id: itemId, output_index: outputIndex, arguments: full });
          emit('response.output_item.done', { output_index: outputIndex, item });
        }
        continue;
      }

      if (type === 'message_delta') {
        if (data.usage) {
          usage = usageToResponses(data.usage);
          if (statsCtx) stats.noteUsage({ ...statsCtx, usage: data.usage });
        }
        continue;
      }

      if (type === 'message_stop') {
        sendCompleted();
        return;
      }

      if (type === 'error' || data.type === 'error') {
        closed = true;
        emit('response.failed', {
          response: {
            ...base,
            status: 'failed',
            error: { code: (data.error && data.error.code) || 'upstream_error', message: (data.error && data.error.message) || 'ZCode upstream stream error' },
            output,
          },
        });
        res.end();
        return;
      }
    }

    sendCompleted();
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: error.message, type: 'api_error', code: 'stream_error' } }));
      return;
    }
    try {
      emit('response.failed', {
        response: { ...base, status: 'failed', error: { code: 'stream_error', message: error.message }, output },
      });
      res.end();
    } catch {
      // ignore
    }
  }
}

module.exports = { responsesToAnthropic, anthropicToResponses, streamAnthropicToResponses };
