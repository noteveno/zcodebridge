'use strict';

// OpenAI <-> Anthropic translation: request conversion, response
// conversion, and Anthropic-SSE -> OpenAI-chunk streaming.

const crypto = require('node:crypto');
const { config } = require('./config');
const { HttpError, firstDefined } = require('./util');
const { mapModel, splitEffortSuffix, normalizeEffort } = require('./models');
const { clampMaxTokens } = require('./upstream');
const { iterateSse, sseWrite } = require('./sse');
const stats = require('./stats');

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && part.type === 'text' && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function openAIContentToAnthropic(content) {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'text', text: String(content) }];

  const blocks = [];
  for (const part of content) {
    if (typeof part === 'string') {
      blocks.push({ type: 'text', text: part });
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'output_text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url && part.image_url.url;
      if (typeof url === 'string' && url.startsWith('data:')) {
        const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
        if (match) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: match[1], data: match[2] },
          });
          continue;
        }
      }
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        blocks.push({ type: 'image', source: { type: 'url', url } });
        continue;
      }
      blocks.push({ type: 'text', text: '[image omitted]' });
      continue;
    }
    if (part.type === 'input_text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'input_image' && typeof part.image_url === 'string') {
      blocks.push({ type: 'image', source: { type: 'url', url: part.image_url } });
      continue;
    }
  }
  return blocks;
}

function openAIToolsToAnthropic(tools) {
  if (!Array.isArray(tools)) return undefined;
  const converted = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type === 'function' && tool.function && typeof tool.function.name === 'string') {
      converted.push({
        name: tool.function.name,
        description: typeof tool.function.description === 'string' ? tool.function.description : undefined,
        input_schema: tool.function.parameters && typeof tool.function.parameters === 'object'
          ? tool.function.parameters
          : { type: 'object', properties: {} },
      });
      continue;
    }
    if (typeof tool.name === 'string' && tool.input_schema) {
      converted.push({
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : undefined,
        input_schema: tool.input_schema,
      });
    }
  }
  return converted.length ? converted : undefined;
}

function openAIToolChoiceToAnthropic(choice, hasTools) {
  if (!hasTools) return undefined;
  if (choice === undefined || choice === null || choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'auto' };
  if (choice === 'required' || choice === 'any') return { type: 'any' };
  if (typeof choice === 'object') {
    if (choice.type === 'function' && choice.function && typeof choice.function.name === 'string') {
      return { type: 'tool', name: choice.function.name };
    }
    if (choice.type === 'tool' && typeof choice.name === 'string') return { type: 'tool', name: choice.name };
  }
  return { type: 'auto' };
}

function appendJsonModeInstruction(system, schema) {
  const instruction =
    '### JSON OUTPUT MODE\n' +
    'Your next reply must be ONLY a raw JSON value. No markdown code fences, no ``` markers, ' +
    'no explanations, no text before or after the JSON. Start the reply with { or [ and end with } or ].\n' +
    (schema
      ? 'The JSON must conform exactly to this JSON Schema:\n' + JSON.stringify(schema, null, 2)
      : 'The JSON must be a single valid JSON object.');
  return (system ? `${system}\n\n` : '') + instruction;
}

// Removes markdown code fences around a JSON reply. Applied only when the
// client asked for response_format JSON, so normal text is never touched.
function stripJsonFences(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  const wrapped = /^\s*```[\w+-]*[^\S\n]*\r?\n([\s\S]*?)\r?\n?\s*```\s*$/;
  const match = out.match(wrapped);
  if (match) return match[1].trim();
  if (/^\s*```/.test(out)) out = out.replace(/^\s*```[\w+-]*[^\S\n]*\r?\n?/, '');
  out = out.replace(/(?:\r?\n)?\s*```\s*$/, '');
  return out.trim();
}

function openAIToAnthropic(body) {
  const messages = [];
  const systemParts = [];
  let pendingToolResults = [];

  const flushToolResults = () => {
    if (!pendingToolResults.length) return;
    messages.push({ role: 'user', content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role;

    if (role === 'system' || role === 'developer') {
      const text = contentToText(message.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (role === 'tool' || role === 'function') {
      const toolUseId = message.tool_call_id || message.name || 'unknown_tool';
      const text = contentToText(message.content) || (typeof message.content === 'string' ? message.content : '');
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: text || '(no output)',
      });
      continue;
    }

    flushToolResults();

    if (role === 'user') {
      messages.push({ role: 'user', content: openAIContentToAnthropic(message.content) });
      continue;
    }

    if (role === 'assistant') {
      const blocks = openAIContentToAnthropic(message.content);
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!call || typeof call !== 'object') continue;
          const fn = call.function || {};
          let input = {};
          if (typeof fn.arguments === 'string' && fn.arguments.trim()) {
            try {
              input = JSON.parse(fn.arguments);
            } catch {
              input = { _raw: fn.arguments };
            }
          } else if (fn.arguments && typeof fn.arguments === 'object') {
            input = fn.arguments;
          }
          blocks.push({
            type: 'tool_use',
            id: call.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
            name: fn.name || 'unknown_tool',
            input,
          });
        }
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }
  }

  flushToolResults();

  if (messages.length === 0) {
    throw new HttpError(400, 'messages must contain at least one user or assistant message', 'invalid_messages');
  }

  const tools = openAIToolsToAnthropic(body.tools);
  const maxTokens = firstDefined(body.max_tokens, body.max_completion_tokens, config.maxTokens);
  const { base, effort: suffixEffort } = splitEffortSuffix(body.model);
  const anthropic = {
    model: mapModel(base),
    max_tokens: clampMaxTokens(maxTokens),
    stream: body.stream === true,
    messages,
  };

  if (systemParts.length) anthropic.system = systemParts.join('\n\n');
  if (tools) {
    anthropic.tools = tools;
    anthropic.tool_choice = openAIToolChoiceToAnthropic(body.tool_choice, true);
  }
  if (body.temperature !== undefined) anthropic.temperature = Number(body.temperature);
  if (body.top_p !== undefined) anthropic.top_p = Number(body.top_p);
  if (body.top_k !== undefined) anthropic.top_k = Number(body.top_k);
  if (body.stop !== undefined) {
    anthropic.stop_sequences = Array.isArray(body.stop) ? body.stop : [String(body.stop)];
  }
  if (body.metadata && typeof body.metadata === 'object') anthropic.metadata = body.metadata;

  if (body.response_format && typeof body.response_format === 'object') {
    const format = body.response_format;
    if (format.type === 'json_schema' && format.json_schema && format.json_schema.schema) {
      // The gateway does not enforce output_config.format, so the schema is
      // also injected into the system prompt and fences are stripped from
      // the reply (see stripJsonFences).
      anthropic.output_config = {
        ...(anthropic.output_config || {}),
        format: { type: 'json_schema', schema: format.json_schema.schema },
      };
      anthropic.system = appendJsonModeInstruction(anthropic.system, format.json_schema.schema);
    } else if (format.type === 'json_object' || format.type === 'json_schema') {
      anthropic.system = appendJsonModeInstruction(anthropic.system, null);
    }
    // The model always thinks upstream and thinking is billed against
    // max_tokens; a low effort keeps JSON replies from being truncated.
    // An explicit reasoning_effort below still takes precedence.
    anthropic.output_config = { ...(anthropic.output_config || {}), effort: 'low' };
  }

  if (body.reasoning_effort && typeof body.reasoning_effort === 'string') {
    // Upstream supports low/high/max only; richer client scales
    // (minimal, medium, xhigh, ultracode, ...) collapse onto them.
    const effortMap = {
      minimal: 'low', low: 'low',
      medium: 'high', high: 'high',
      xhigh: 'max', ultra: 'max', ultracode: 'max', max: 'max',
    };
    anthropic.output_config = {
      ...(anthropic.output_config || {}),
      effort: effortMap[body.reasoning_effort.toLowerCase()] || 'high',
    };
  } else if (suffixEffort) {
    // Effort picked via a model-name suffix (e.g. "glm-5.3-max").
    anthropic.output_config = { ...(anthropic.output_config || {}), effort: normalizeEffort(suffixEffort) };
  }

  return anthropic;
}

function anthropicStopReasonToOpenAI(reason) {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return reason || 'stop';
  }
}

function usageToOpenAI(usage) {
  if (!usage || typeof usage !== 'object') {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
  const prompt = Number(usage.input_tokens) || 0;
  const completion = Number(usage.output_tokens) || 0;
  const result = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  const cached = Number(usage.cache_read_input_tokens) || 0;
  if (cached > 0) {
    result.prompt_tokens_details = { cached_tokens: cached };
  }
  return result;
}

function anthropicToOpenAIResponse(json, requestedModel, options = {}) {
  const content = Array.isArray(json.content) ? json.content : [];
  let text = '';
  let reasoning = '';
  const toolCalls = [];

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
      continue;
    }
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      reasoning += block.thinking;
      continue;
    }
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: {
          name: block.name || 'unknown_tool',
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
  }

  if (options.jsonMode) text = stripJsonFences(text);

  const message = { role: 'assistant', content: text || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: json.id || `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || json.model || config.defaultModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? 'tool_calls' : anthropicStopReasonToOpenAI(json.stop_reason),
        logprobs: null,
      },
    ],
    usage: usageToOpenAI(json.usage),
  };
}

function openAIChunk(model, delta, finishReason = null, extra = {}) {
  return {
    id: extra.id || `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    ...(extra.usage ? { usage: extra.usage } : {}),
  };
}

async function streamAnthropicToOpenAI(response, res, requestedModel, options = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  let sentRole = false;
  let finishReason = null;
  let usage = null;
  let toolIndex = -1;
  const toolIndexes = new Map();
  let closed = false;

  // JSON-mode fence filtering state: the prologue holds back text until we
  // know whether the reply starts with a ``` fence opening; the tail holds
  // back trailing backticks so a closing fence can be dropped at stream end.
  let jsonPending = '';
  let jsonPrologue = options.jsonMode === true;
  let jsonTail = '';

  const emitText = (text) => {
    if (text) sseWrite(res, openAIChunk(requestedModel, { content: text }, null, { id }));
  };

  const filterJsonText = (deltaText) => {
    jsonPending += deltaText;
    if (jsonPrologue) {
      const trimmed = jsonPending.replace(/^\s+/, '');
      if (trimmed.startsWith('```')) {
        const newline = jsonPending.indexOf('\n');
        if (newline === -1 && jsonPending.length < 64) return;
        jsonPrologue = false;
        jsonPending = newline !== -1 ? jsonPending.slice(newline + 1) : jsonPending.replace(/^\s*```[\w+-]*[^\S\n]*\r?\n?/, '');
      } else if (trimmed.length > 0 && '```'.startsWith(trimmed)) {
        return;
      } else {
        jsonPrologue = false;
      }
    }
    let out = jsonTail + jsonPending;
    jsonPending = '';
    jsonTail = '';
    const trailing = out.match(/`{1,3}$/);
    if (trailing) {
      jsonTail = trailing[0];
      out = out.slice(0, out.length - jsonTail.length);
    }
    emitText(out);
  };

  const ensureRole = () => {
    if (sentRole) return;
    sentRole = true;
    sseWrite(res, openAIChunk(requestedModel, { role: 'assistant', content: '' }, null, { id }));
  };

  try {
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

      if (type === 'message_start') {
        ensureRole();
        continue;
      }

      if (type === 'content_block_start') {
        const block = data.content_block || {};
        if (block.type === 'tool_use') {
          ensureRole();
          toolIndex += 1;
          const index = toolIndex;
          toolIndexes.set(data.index, index);
          sseWrite(
            res,
            openAIChunk(
              requestedModel,
              {
                tool_calls: [
                  {
                    index,
                    id: block.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
                    type: 'function',
                    function: { name: block.name || 'unknown_tool', arguments: '' },
                  },
                ],
              },
              null,
              { id },
            ),
          );
        }
        continue;
      }

      if (type === 'content_block_delta') {
        const delta = data.delta || {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
          ensureRole();
          if (options.jsonMode) filterJsonText(delta.text);
          else sseWrite(res, openAIChunk(requestedModel, { content: delta.text }, null, { id }));
          continue;
        }
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
          ensureRole();
          sseWrite(res, openAIChunk(requestedModel, { reasoning_content: delta.thinking }, null, { id }));
          continue;
        }
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const index = toolIndexes.get(data.index);
          if (index !== undefined) {
            sseWrite(
              res,
              openAIChunk(
                requestedModel,
                {
                  tool_calls: [
                    {
                      index,
                      function: { arguments: delta.partial_json },
                    },
                  ],
                },
                null,
                { id },
              ),
            );
          }
        }
        continue;
      }

      if (type === 'message_delta') {
        if (data.delta && data.delta.stop_reason) {
          finishReason = anthropicStopReasonToOpenAI(data.delta.stop_reason);
        }
        if (data.usage) {
          usage = usageToOpenAI(data.usage);
          if (options.statsCtx) stats.noteUsage({ ...options.statsCtx, usage: data.usage });
        }
        continue;
      }

      if (type === 'message_stop') {
        ensureRole();
        sseWrite(res, openAIChunk(requestedModel, {}, finishReason || 'stop', { id, usage }));
        res.write('data: [DONE]\n\n');
        res.end();
        closed = true;
        return;
      }

      if (type === 'error' || (data.type === 'error')) {
        ensureRole();
        sseWrite(res, {
          error: {
            message: (data.error && data.error.message) || 'ZCode upstream stream error',
            type: (data.error && data.error.type) || 'api_error',
            code: (data.error && data.error.code) || 'upstream_stream_error',
          },
        });
        res.write('data: [DONE]\n\n');
        res.end();
        closed = true;
        return;
      }
    }

    if (!closed) {
      ensureRole();
      sseWrite(res, openAIChunk(requestedModel, {}, finishReason || 'stop', { id, usage }));
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: error.message, type: 'api_error', code: 'stream_error' } }));
      return;
    }
    try {
      sseWrite(res, { error: { message: error.message, type: 'api_error', code: 'stream_error' } });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch {
      // ignore
    }
  }
}

module.exports = {
  contentToText,
  openAIContentToAnthropic,
  openAIToolsToAnthropic,
  openAIToolChoiceToAnthropic,
  appendJsonModeInstruction,
  stripJsonFences,
  openAIToAnthropic,
  anthropicToOpenAIResponse,
  streamAnthropicToOpenAI,
};
