#!/usr/bin/env node
'use strict';

/*
 * PlanBridge model watcher
 * -------------------------
 *   node models.js list     Show configured + discovered models
 *   node models.js check    Fetch plan entitlements once and detect new models
 *   node models.js watch    Keep running; check every 10 minutes and log new
 *                           models the moment Z.ai ships them (e.g. GLM-5.4)
 *
 * Discovered models are stored in models.json and served by the proxy in
 * GET /v1/models automatically. The proxy also picks them up passively from
 * its billing cache; this tool exists for explicit monitoring.
 */

const { loadAccountCredentials, accountNames } = require('./src/credentials');
const { fetchAccountUsage, capabilityModels } = require('./src/billing');
const { knownModels, readRegistry, mergeDiscoveredModels, CONTEXT_WINDOW, MAX_OUTPUT_TOKENS, MODELS_FILE } = require('./src/models');

async function checkOnce(verbose = true) {
  const granted = [];
  for (const name of accountNames()) {
    try {
      const credentials = loadAccountCredentials(name);
      const data = await fetchAccountUsage(credentials, false);
      granted.push(...capabilityModels(data));
    } catch (error) {
      if (verbose) console.error(`account ${name || '(default)'}: ${error.message}`);
    }
  }
  const fresh = mergeDiscoveredModels(granted);
  if (fresh.length) {
    console.log(`[${new Date().toISOString()}] NEW MODELS DETECTED: ${fresh.join(', ')}`);
    console.log('They are now served via /v1/models and usable by name.');
  } else if (verbose) {
    console.log(`[${new Date().toISOString()}] no new models (known: ${knownModels().join(', ')})`);
  }
  return fresh;
}

function list() {
  const registry = readRegistry();
  console.log(`registry file: ${MODELS_FILE}`);
  console.log(`context window: ${CONTEXT_WINDOW.toLocaleString()} tokens, max output: ${MAX_OUTPUT_TOKENS.toLocaleString()}`);
  console.log(`configured: ${(registry.models.length ? registry.models : ['(defaults: GLM-5.3, GLM-5.3-Flash)']).join(', ')}`);
  console.log(`discovered: ${registry.discovered.length ? registry.discovered.join(', ') : '(none yet)'}`);
  console.log(`served by /v1/models: ${knownModels().join(', ')}`);
}

const command = process.argv[2] || 'list';

if (command === 'list') {
  list();
} else if (command === 'check') {
  checkOnce().catch((error) => { console.error(error.message); process.exitCode = 1; });
} else if (command === 'watch') {
  const INTERVAL = 10 * 60 * 1000;
  console.log(`Watching for new models every 10 minutes. Ctrl+C to stop.`);
  checkOnce().catch(() => {});
  setInterval(() => {
    checkOnce().catch(() => {});
  }, INTERVAL);
} else {
  console.log('usage: node models.js list | check | watch');
  process.exitCode = 1;
}
