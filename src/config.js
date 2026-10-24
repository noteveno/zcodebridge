'use strict';

// Configuration file + environment handling and logging.

const fs = require('node:fs');
const path = require('node:path');
const { readJsonIfExists, firstDefined } = require('./util');

const ROOT = path.join(__dirname, '..');
const VERSION = '2.1.0';
const APP_VERSION = '3.16.3';

function loadConfig() {
  const defaults = {
    host: '127.0.0.1',
    port: 8787,
    apiKey: '',
    baseUrl: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic',
    defaultModel: 'GLM-5.3',
    flashModel: 'GLM-5.3-Flash',
    maxTokens: 128000,
    requestTimeoutMs: 300000,
    retries: 2,
    logLevel: 'info',
    dataDir: '',
    accountsDir: '',
    // When false the proxy never reads the ZCode desktop login and only
    // serves accounts stored under accounts/ (set it in config.json).
    useDefaultAccount: true,
    systemPromptDir: path.join(ROOT, 'prompts'),
    cors: true,
  };

  const configFile = process.env.ZCODE2PROXY_CONFIG || path.join(ROOT, 'config.json');
  const fromFile = readJsonIfExists(configFile) || {};

  const fromEnv = {
    host: process.env.HOST,
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    apiKey: process.env.PROXY_API_KEY,
    baseUrl: process.env.ZCODE_BASE_URL,
    defaultModel: process.env.DEFAULT_MODEL,
    flashModel: process.env.FLASH_MODEL,
    maxTokens: process.env.MAX_TOKENS ? Number(process.env.MAX_TOKENS) : undefined,
    requestTimeoutMs: process.env.REQUEST_TIMEOUT_MS ? Number(process.env.REQUEST_TIMEOUT_MS) : undefined,
    retries: process.env.UPSTREAM_RETRIES ? Number(process.env.UPSTREAM_RETRIES) : undefined,
    logLevel: process.env.LOG_LEVEL,
    dataDir: process.env.ZCODE_DATA_DIR,
    accountsDir: process.env.ZCODE_ACCOUNTS_DIR,
  };

  const cfg = { ...defaults, ...fromFile };
  for (const [key, value] of Object.entries(fromEnv)) {
    if (value !== undefined && value !== null && value !== '') cfg[key] = value;
  }

  cfg.port = Number(cfg.port) || 8787;
  cfg.maxTokens = Math.max(1, Math.min(128000, Number(cfg.maxTokens) || 128000));
  cfg.requestTimeoutMs = Math.max(1000, Number(cfg.requestTimeoutMs) || 300000);
  cfg.retries = Math.max(0, Math.min(5, Number(cfg.retries) || 0));
  cfg.baseUrl = String(cfg.baseUrl || defaults.baseUrl).replace(/\/+$/, '');
  return cfg;
}

const config = loadConfig();

function log(level, ...args) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  if ((levels[level] || 20) < (levels[config.logLevel] || 20)) return;
  const stamp = new Date().toISOString();
  const line = `[${stamp}] [${level.toUpperCase()}] ${args.join(' ')}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

module.exports = { config, log, ROOT, VERSION, APP_VERSION, loadConfig };
