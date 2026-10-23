#!/usr/bin/env node
'use strict';

/*
 * ZCodeBridge
 * -------------
 * OpenAI-compatible (/v1/chat/completions), Responses-compatible
 * (/v1/responses, used by Codex) and Anthropic-compatible (/v1/messages)
 * proxy for ZCode / Z.ai plans.
 *
 * It reads the ZCode login token from ~/.zcode/v2/credentials.json,
 * decrypts it with the same AES-256-GCM scheme ZCode uses, and talks
 * directly to the ZCode plan gateway. ZCode does not need to be running.
 *
 * The implementation lives in src/:
 *   src/config.js       configuration + logging
 *   src/credentials.js  credential decryption + multi-account storage
 *   src/prompts.js      ZCode system prompt blocks
 *   src/models.js       model registry + discovery
 *   src/upstream.js     gateway requests, retries, quota-aware routing
 *   src/billing.js      plan usage / balances / claims
 *   src/sse.js          SSE parsing helpers
 *   src/openai.js       OpenAI Chat Completions translation
 *   src/responses.js    OpenAI Responses API translation (Codex)
 *   src/anthropic.js    Anthropic passthrough
 *   src/server.js       HTTP routing + handlers
 */

const { start } = require('./src/server');

if (require.main === module) {
  start();
}

module.exports = { start };
