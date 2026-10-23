'use strict';

// SSE parsing and writing shared by the OpenAI translator and the
// Anthropic passthrough.

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  let event = '';
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  return { event, data: dataLines.join('\n') };
}

async function* iterateSse(response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (block.trim()) yield parseSseBlock(block);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield parseSseBlock(buffer);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function sseWrite(res, payload) {
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
}

module.exports = { parseSseBlock, iterateSse, sseWrite };
