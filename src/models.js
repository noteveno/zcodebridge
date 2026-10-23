'use strict';

// Model registry: static configuration plus models discovered from the
// plan's entitlements (new models Z.ai ships, e.g. a future GLM-5.4, appear
// there automatically and get merged into /v1/models).

const fs = require('node:fs');
const path = require('node:path');
const { config, ROOT } = require('./config');

const MODELS_FILE = path.join(ROOT, 'models.json');
const CONTEXT_WINDOW = 1048576; // 1M tokens (GLM-5.3 / GLM-5.3-Flash)
const MAX_OUTPUT_TOKENS = 128000;

function readRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
    const models = Array.isArray(raw.models) ? raw.models.map(String) : [];
    const discovered = Array.isArray(raw.discovered) ? raw.discovered.map(String) : [];
    return { models, discovered };
  } catch {
    return { models: [], discovered: [] };
  }
}

function writeRegistry(registry) {
  fs.writeFileSync(MODELS_FILE, JSON.stringify(registry, null, 2) + '\n');
}

function knownModels() {
  const registry = readRegistry();
  const models = registry.models.length ? registry.models : [config.defaultModel, config.flashModel];
  return [...new Set([...models, ...registry.discovered, config.defaultModel, config.flashModel])];
}

// Merge model ids found in plan capabilities ("model:glm-5.3-flash") into
// the discovered list. Returns the newly found ids.
function mergeDiscoveredModels(ids) {
  const found = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))]
    .filter((id) => !/^(default|flash)$/i.test(id));
  const registry = readRegistry();
  const base = new Set([...registry.models, config.defaultModel, config.flashModel].map((m) => m.toLowerCase()));
  const fresh = found.filter((id) => !base.has(id.toLowerCase()));
  if (!fresh.length) return [];
  const discovered = [...new Set([...registry.discovered, ...fresh])];
  writeRegistry({ models: registry.models, discovered });
  return fresh;
}

function isFlashLike(value) {
  return /flash|mini|haiku|air|lite|turbo/i.test(value);
}

function mapModel(requested) {
  const value = String(requested || '').trim();
  const lower = value.toLowerCase();
  const known = new Set(knownModels().map((m) => m.toLowerCase()));
  if (!lower) return config.defaultModel;

  // Exact known model (configured or previously discovered) -> as-is.
  if (known.has(lower)) {
    return knownModels().find((m) => m.toLowerCase() === lower);
  }
  // New upstream models pass through untouched so they work the day
  // Z.ai ships them, before any config update.
  if (/^glm[-_.]/i.test(value) && known.size && lower.startsWith('glm')) {
    return value;
  }
  if (isFlashLike(lower)) return config.flashModel;
  return config.defaultModel;
}

function modelList(extra = []) {
  const ids = [...new Set([...knownModels(), ...extra])];
  return ids.map((id, index) => ({
    id,
    object: 'model',
    created: 1700000000,
    owned_by: 'zcode',
    permission: [],
    root: id,
    parent: null,
    context_window: CONTEXT_WINDOW,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    order: index,
  }));
}

module.exports = {
  mapModel,
  modelList,
  knownModels,
  readRegistry,
  writeRegistry,
  mergeDiscoveredModels,
  isFlashLike,
  CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  MODELS_FILE,
};
