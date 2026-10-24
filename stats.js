#!/usr/bin/env node
'use strict';
/*
 * `node stats` - proxy request/token statistics (per day, week, all time).
 * Prefers live numbers from a running proxy; falls back to stats.json.
 */
const { summary } = require('./src/stats');
const { config } = require('./src/config');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, t) => (useColor ? `\x1b[${code}m${t}\x1b[0m` : t);
const ui = {
  bold: (t) => paint('1', t), dim: (t) => paint('2', t), cyan: (t) => paint('36', t), green: (t) => paint('32', t),
};
const fmt = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
};

async function live() {
  try {
    const res = await fetch(`http://${config.host}:${config.port}/v1/stats`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

(async () => {
  const s = (await live()) || summary();
  const line = ui.dim('─'.repeat(66));
  console.log(`\n  ${line}`);
  console.log(`    ${ui.bold('ZCodeBridge')} ${ui.dim('·')} ${ui.cyan('proxy stats')}`);
  console.log(`  ${line}`);
  for (const [label, entry] of [['today', s.today], ['last 7 days', s.week], ['all time', s.allTime]]) {
    console.log(`\n    ${ui.cyan(label.padEnd(11))} ${ui.bold(String(entry.requests))} requests ${ui.dim(`(${entry.streams} streamed, ${entry.errors} errors)`)}`);
    console.log(`    ${' '.repeat(11)} ${ui.green(fmt(entry.tokensIn))} in · ${ui.green(fmt(entry.tokensOut))} out ${ui.dim(`· ${fmt(entry.tokensIn + entry.tokensOut)} total tokens`)}`);
    const models = Object.entries(entry.models || {}).sort((a, b) => b[1].requests - a[1].requests);
    for (const [model, m] of models) {
      console.log(`    ${' '.repeat(13)} ${ui.dim('•')} ${model.padEnd(16)} ${m.requests} req · ${fmt(m.tokensIn + m.tokensOut)} tokens`);
    }
  }
  console.log(`\n  ${line}`);
  console.log(`  ${ui.dim('Live endpoint:')} ${ui.cyan('GET /v1/stats')}\n`);
})();
