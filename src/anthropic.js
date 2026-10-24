'use strict';

// Anthropic /v1/messages passthrough: responses go through nearly
// untouched (only the model name is rewritten to the requested alias).

const { iterateSse } = require('./sse');
const stats = require('./stats');

function rewriteAnthropicJson(json, requestedModel) {
  if (json && typeof json === 'object' && requestedModel) {
    json.model = requestedModel;
  }
  return json;
}

async function streamAnthropicPassthrough(response, res, requestedModel, statsCtx) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  try {
    for await (const event of iterateSse(response)) {
      const type = event.event || '';
      let data = event.data;
      if (data) {
        try {
          const parsed = JSON.parse(data);
          if (statsCtx && parsed.type === 'message_delta' && parsed.usage) stats.noteUsage({ ...statsCtx, usage: parsed.usage });
          if (parsed && typeof parsed === 'object' && requestedModel && typeof parsed.model === 'string') {
            parsed.model = requestedModel;
          }
          data = JSON.stringify(parsed);
        } catch {
          // keep original data
        }
      }
      if (type) res.write(`event: ${type}\n`);
      if (data !== undefined && data !== '') res.write(`data: ${data}\n\n`);
      else res.write('\n');
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: error.message } }));
      return;
    }
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: error.message } })}\n\n`);
      res.end();
    } catch {
      // ignore
    }
  }
}

module.exports = { rewriteAnthropicJson, streamAnthropicPassthrough };
