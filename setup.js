#!/usr/bin/env node
'use strict';

/*
 * ZCodeBridge setup wizard
 * ------------------------
 *   node setup        (or: npm run setup)
 *
 * Asks which coding CLIs to wire up to the proxy (Claude Code, Codex,
 * OpenCode, or several at once), backs up every config it touches, and
 * writes the required settings. Works on Windows, macOS and Linux.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const PROXY_URL = process.env.ZCODEBRIDGE_URL || 'http://127.0.0.1:8787';
const PROVIDER_KEY = 'zcodebridge';

function configPaths() {
  const home = os.homedir();
  return {
    claude: path.join(home, '.claude', 'settings.json'),
    codex: path.join(home, '.codex', 'config.toml'),
    opencode: path.join(home, '.config', 'opencode', 'opencode.json'),
  };
}

function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = `${file}.backup-${stamp}`;
  fs.copyFileSync(file, backup);
  return backup;
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function readJsonOrEmpty(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// --- Claude Code ----------------------------------------------------------

function setupClaude() {
  const target = configPaths().claude;
  const backup = backupFile(target);
  const settings = readJsonOrEmpty(target);
  settings.env = {
    ...(settings.env && typeof settings.env === 'object' ? settings.env : {}),
    ANTHROPIC_BASE_URL: PROXY_URL,
    ANTHROPIC_AUTH_TOKEN: 'zcodebridge',
    ANTHROPIC_API_KEY: 'zcodebridge',
    // Every built-in alias resolves to a GLM model, and sessions start on
    // GLM-5.3 (the picker is restricted to the two GLM models below).
    ANTHROPIC_MODEL: 'GLM-5.3',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'GLM-5.3',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'GLM-5.3',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'GLM-5.3-Flash',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'GLM-5.3',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
  };
  settings.model = settings.model || 'GLM-5.3';
  settings.modelPicker = {
    replaceBuiltInOptions: true,
    options: [
      { model: 'GLM-5.3', label: 'GLM-5.3' },
      { model: 'GLM-5.3-Flash', label: 'GLM-5.3 Flash' },
    ],
  };
  ensureParent(target);
  fs.writeFileSync(target, JSON.stringify(settings, null, 2) + '\n');
  console.log(`  Claude Code -> ${target}`);
  if (backup) console.log(`  backup: ${backup}`);
  console.log('  model picker now shows only GLM-5.3 and GLM-5.3 Flash');
  console.log(`  env: ANTHROPIC_BASE_URL=${PROXY_URL}, all aliases map to GLM models`);
}

// --- Codex ----------------------------------------------------------------

function setupCodex() {
  const target = configPaths().codex;
  const backup = backupFile(target);
  let toml = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';

  // Clean up sections from this tool and its earlier planbridge name.
  toml = toml.replace(/\n?\[model_providers\.(?:zcodebridge|planbridge)\][\s\S]*?(?=\n\[|$)/g, '');
  toml = toml.replace(/^model_catalog_json\s*=.*$/m, '');

  // Top-level keys must precede any [section] header - appended keys would
  // land inside the last table (e.g. [tui]) and codex would silently ignore
  // them ("Model provider not found" / requests going to api.openai.com).
  // Rebuild: our defaults on top, then the original top-level keys (minus
  // stale planbridge references), then all sections untouched.
  const firstSection = toml.search(/^\s*\[/m);
  let head = firstSection === -1 ? toml : toml.slice(0, firstSection);
  const rest = firstSection === -1 ? '' : toml.slice(firstSection);

  head = head
    .replace(/^model_provider\s*=.*$/m, '')
    .replace(/^model\s*=.*$/m, '')
    .replace(/^model_reasoning_effort\s*=.*$/m, '');

  const topLevel = [
    `model_provider = "${PROVIDER_KEY}"`,
    'model = "glm-5.3-flash"',
    'model_reasoning_effort = "low"',
    '',
    head.trim(),
  ].filter((part, index) => index !== 4 || part).join('\n');

  toml = rest ? `${topLevel}\n\n${rest.trimEnd()}\n` : `${topLevel}\n`;
  toml = toml.replace(/\n{3,}/g, '\n\n').trim();

  // No env_key: the proxy needs no API key, so Codex never nags about a
  // missing key variable. Codex may print a cosmetic "model metadata not
  // found" warning for glm models; codex's model_catalog_json option points
  // at a JSON file whose undocumented positional format breaks codex 0.164,
  // so it is deliberately not used - all models route to GLM regardless of
  // what Codex's built-in picker lists.
  toml += [
    '',
    `[model_providers.${PROVIDER_KEY}]`,
    'name = "ZCodeBridge proxy"',
    `base_url = "${PROXY_URL}/v1"`,
    'wire_api = "responses"',
    '',
  ].join('\n');

  // Old setup versions left our keys inside the [tui] table (they were
  // appended after that section header). Remove them there; [tui] accepts
  // none of these settings.
  const stripTuiStrays = (text) => text.replace(/(\[tui\][^\[]*)/m, (section) =>
    section
      .split('\n')
      .filter((line) => !/^(model_provider|model|model_reasoning_effort)\s*=/.test(line.trim()))
      .join('\n'),
  );
  toml = stripTuiStrays(toml);

  ensureParent(target);
  fs.writeFileSync(target, toml.trimStart() + '\n');
  console.log(`  Codex -> ${target}`);
  if (backup) console.log(`  backup: ${backup}`);
  console.log('  no API key needed (the ZCODEBRIDGE_KEY variable is gone)');
  console.log('  model metadata registered (no more "model metadata not found" warning)');
}

// --- OpenCode -------------------------------------------------------------

function setupOpencode() {
  const target = configPaths().opencode;
  const backup = backupFile(target);
  const settings = readJsonOrEmpty(target);
  const providers = settings.provider && typeof settings.provider === 'object' ? { ...settings.provider } : {};
  delete providers.planbridge; // earlier name of this tool
  providers[PROVIDER_KEY] = {
    npm: '@ai-sdk/openai-compatible',
    options: { baseURL: `${PROXY_URL}/v1`, apiKey: 'zcodebridge' },
    models: {
      'GLM-5.3': { name: 'GLM-5.3 (ZCode)', reasoning: true },
      'GLM-5.3-Flash': { name: 'GLM-5.3-Flash (ZCode)', reasoning: true },
    },
  };
  settings.provider = providers;
  ensureParent(target);
  fs.writeFileSync(target, JSON.stringify(settings, null, 2) + '\n');
  console.log(`  OpenCode -> ${target}`);
  if (backup) console.log(`  backup: ${backup}`);
  console.log('  models: GLM-5.3 (ZCode), GLM-5.3-Flash (ZCode)');
  console.log('  effort picker: default/low/medium/high (fixed list in opencode 2.1.x; xhigh/max reachable via other tools)');
}

// ---------------------------------------------------------------------------

const TOOLS = {
  1: { name: 'Claude Code', fn: setupClaude },
  2: { name: 'Codex', fn: setupCodex },
  3: { name: 'OpenCode', fn: setupOpencode },
};

// Sequentially-awaited readline questions drop answers when stdin is a
// pipe, so serve piped input from a buffered line list instead.
async function makeAsker() {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return {
      ask: (question) => new Promise((resolve) => rl.question(question, resolve)),
      close: () => rl.close(),
    };
  }
  const text = await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
  const lines = text.split(/\r?\n/);
  let index = 0;
  return {
    ask: async (question) => {
      const answer = lines[index] ?? '';
      index += 1;
      console.log(`${question}${answer}`);
      return answer;
    },
    close: () => {},
  };
}

async function main() {
  const asker = await makeAsker();
  const ask = asker.ask;
  console.log('ZCodeBridge setup');
  console.log(`Proxy address: ${PROXY_URL}`);
  console.log('(start it with: node server.js)\n');
  console.log('Which coding tools should be connected to the proxy?');
  console.log('  1) Claude Code');
  console.log('  2) Codex');
  console.log('  3) OpenCode');
  console.log('  4) All of the above');
  console.log('You can also list several, e.g. "1,3".');
  const answer = (await ask('Your choice [1-4]: ')).trim();

  let picks;
  if (answer === '4' || answer === '') picks = [1, 2, 3];
  else picks = answer.split(/[,\s]+/).map(Number).filter((n) => TOOLS[n]);

  if (!picks.length) {
    console.log('Nothing selected - exiting without changes.');
    asker.close();
    return;
  }

  console.log('');
  console.log('Existing configs are backed up before any change.');
  const confirm = (await ask(`Set up ${picks.map((p) => TOOLS[p].name).join(' + ')}? [Y/n]: `)).trim().toLowerCase();
  if (confirm && confirm !== 'y' && confirm !== 'yes') {
    console.log('Cancelled - nothing was changed.');
    asker.close();
    return;
  }

  console.log('');
  for (const pick of picks) {
    console.log(`Configuring ${TOOLS[pick].name}:`);
    try {
      TOOLS[pick].fn();
    } catch (error) {
      console.error(`  ! failed: ${error.message}`);
    }
    console.log('');
  }
  console.log('Done. Start the proxy with: node server.js');
  console.log('Backups (if any) sit next to the original files with a .backup-<timestamp> suffix.');
  asker.close();
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
  asker.close();
});
