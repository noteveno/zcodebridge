'use strict';

// Lightweight request/token statistics, persisted to stats.json next to the
// project. Counted per local day; "week" is the trailing 7 days.

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./config');

const FILE = path.join(ROOT, 'stats.json');

function emptyDay() {
  return { requests: 0, streams: 0, errors: 0, tokensIn: 0, tokensOut: 0, cacheIn: 0, models: {}, accounts: {} };
}

let data = { days: {} };
let dirty = false;
try {
  const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (parsed && typeof parsed.days === 'object') data = parsed;
} catch {
  // fresh start
}

function dayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function day(key = dayKey()) {
  if (!data.days[key]) data.days[key] = emptyDay();
  return data.days[key];
}

// Drop days older than 35 so the file stays small.
function prune() {
  const cutoff = Date.now() - 35 * 24 * 3600 * 1000;
  for (const key of Object.keys(data.days)) {
    if (new Date(`${key}T00:00:00`).getTime() < cutoff) delete data.days[key];
  }
}

function noteRequest({ account = '', model = '', stream = false, error = false } = {}) {
  const entry = day();
  entry.requests += 1;
  if (stream) entry.streams += 1;
  if (error) entry.errors += 1;
  if (model) {
    entry.models[model] = entry.models[model] || { requests: 0, tokensIn: 0, tokensOut: 0 };
    entry.models[model].requests += 1;
  }
  if (account) {
    entry.accounts[account] = entry.accounts[account] || { requests: 0, tokensIn: 0, tokensOut: 0 };
    entry.accounts[account].requests += 1;
  }
  dirty = true;
}

function noteUsage({ account = '', model = '', usage } = {}) {
  if (!usage) return;
  const input = Number(usage.input_tokens) || 0;
  const cache = Number(usage.cache_read_input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  if (!input && !output) return;
  const entry = day();
  entry.tokensIn += input;
  entry.cacheIn += cache;
  entry.tokensOut += output;
  if (model) {
    entry.models[model] = entry.models[model] || { requests: 0, tokensIn: 0, tokensOut: 0 };
    entry.models[model].tokensIn += input;
        entry.models[model].cacheIn = (entry.models[model].cacheIn || 0) + cache;
    entry.models[model].tokensOut += output;
  }
  if (account) {
    entry.accounts[account] = entry.accounts[account] || { requests: 0, tokensIn: 0, tokensOut: 0 };
    entry.accounts[account].tokensIn += input;
        entry.accounts[account].cacheIn = (entry.accounts[account].cacheIn || 0) + cache;
    entry.accounts[account].tokensOut += output;
  }
  dirty = true;
}

function sumDays(keys) {
  const total = emptyDay();
  for (const key of keys) {
    const entry = data.days[key];
    if (!entry) continue;
    total.requests += entry.requests;
    total.streams += entry.streams;
    total.errors += entry.errors;
    total.tokensIn += entry.tokensIn;
    total.tokensOut += entry.tokensOut;
    total.cacheIn += entry.cacheIn || 0;
    for (const [model, stats] of Object.entries(entry.models || {})) {
      total.models[model] = total.models[model] || { requests: 0, tokensIn: 0, tokensOut: 0 };
      total.models[model].requests += stats.requests;
      total.models[model].tokensIn += stats.tokensIn;
      total.models[model].tokensOut += stats.tokensOut;
      total.models[model].cacheIn = (total.models[model].cacheIn || 0) + (stats.cacheIn || 0);
    }
    for (const [account, stats] of Object.entries(entry.accounts || {})) {
      total.accounts[account] = total.accounts[account] || { requests: 0, tokensIn: 0, tokensOut: 0 };
      total.accounts[account].requests += stats.requests;
      total.accounts[account].tokensIn += stats.tokensIn;
      total.accounts[account].tokensOut += stats.tokensOut;
      total.accounts[account].cacheIn = (total.accounts[account].cacheIn || 0) + (stats.cacheIn || 0);
    }
  }
  return total;
}

function summary() {
  prune();
  const weekKeys = [];
  for (let i = 0; i < 7; i += 1) weekKeys.push(dayKey(new Date(Date.now() - i * 24 * 3600 * 1000)));
  return {
    today: data.days[dayKey()] || emptyDay(),
    week: sumDays(weekKeys),
    allTime: sumDays(Object.keys(data.days)),
  };
}

function flush() {
  if (!dirty) return;
  dirty = false;
  prune();
  try {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  } catch {
    // stats are best-effort
  }
}

const timer = setInterval(flush, 30000);
timer.unref();

module.exports = { noteRequest, noteUsage, summary, flush, FILE };
