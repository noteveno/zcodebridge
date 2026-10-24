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

// Writes the model catalog codex loads via model_catalog_json. The base
// instructions are codex's own fallback agent template (kept verbatim in
// deploy/codex-base-instructions.txt) so GLM sessions get the same
// tool-use guidance as built-in models.
function writeCodexCatalog(catalogFile) {
  let template;
  try {
    template = fs.readFileSync(path.join(__dirname, '..', 'codex-base-instructions.txt'), 'utf8').trim();
  } catch {
    template = 'You are Codex, a coding assistant. Use the available tools to complete tasks.';
  }
  const efforts = [
    { effort: 'low', description: 'Fast responses, light reasoning' },
    { effort: 'medium', description: 'Balanced reasoning' },
    { effort: 'high', description: 'Thorough reasoning' },
    { effort: 'xhigh', description: 'Extra thorough reasoning' },
    { effort: 'max', description: 'Maximum reasoning depth' },
  ];
  const mk = (slug, name, description, priority, defaultEffort) => ({
    slug,
    display_name: name,
    description,
    base_instructions: template,
    default_reasoning_level: defaultEffort,
    supported_reasoning_levels: efforts,
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority,
    default_reasoning_summary: 'auto',
    support_verbosity: false,
    truncation_policy: { mode: 'tokens', limit: 100000 },
    experimental_supported_tools: [],
    context_window: 1048576,
    max_context_window: 1048576,
    effective_context_window_percent: 80,
    input_modalities: ['text', 'image'],
    supports_reasoning_summary_parameter: true,
  });
  const catalog = {
    models: [
      mk('glm-5.3', 'GLM-5.3 (ZCode)', 'Flagship GLM-5.3 through ZCodeBridge - 1M token context', 120, 'medium'),
      mk('glm-5.3-flash', 'GLM-5.3 Flash (ZCode)', 'Fast GLM-5.3-Flash through ZCodeBridge - 1M token context', 110, 'low'),
    ],
  };
  fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 2));
}

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

  // Custom model catalog: puts the GLM models into Codex's model picker
  // (with xhigh/max efforts and the real 1M context window) and removes
  // the "model metadata not found" warning. Format reverse-engineered from
  // codex's ModelsResponse/ModelInfo (protocol/src/openai_models.rs).
  const catalogFile = path.join(path.dirname(target), 'zcodebridge-models.json');
  writeCodexCatalog(catalogFile);
  const catalogSetting = `model_catalog_json = "${catalogFile.split(path.sep).join('/')}"`;

  head = head
    .replace(/^model_provider\s*=.*$/m, '')
    .replace(/^model\s*=.*$/m, '')
    .replace(/^model_reasoning_effort\s*=.*$/m, '');

  const topLevel = [
    catalogSetting,
    `model_provider = "${PROVIDER_KEY}"`,
    'model = "glm-5.3-flash"',
    'model_reasoning_effort = "low"',
    '',
    head.trim(),
  ].filter((part, index) => index !== 5 || part).join('\n');

  toml = rest ? `${topLevel}\n\n${rest.trimEnd()}\n` : `${topLevel}\n`;
  toml = toml.replace(/\n{3,}/g, '\n\n').trim();

  // No env_key: the proxy needs no API key, so Codex never nags about a
  // missing key variable.
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
      .filter((line) => !/^(model_provider|model|model_reasoning_effort|model_catalog_json)\s*=/.test(line.trim()))
      .join('\n'),
  );
  toml = stripTuiStrays(toml);

  ensureParent(target);
  fs.writeFileSync(target, toml.trimStart() + '\n');
  console.log(`  Codex -> ${target}`);
  if (backup) console.log(`  backup: ${backup}`);
  console.log(`  model catalog -> ${catalogFile}`);
  console.log('  picker shows GLM-5.3 (ZCode) / GLM-5.3-Flash (ZCode) with low..max efforts');
  console.log('  no API key needed');
}

// --- OpenCode -------------------------------------------------------------

function setupOpencode() {
  const target = configPaths().opencode;
  const backup = backupFile(target);
  const settings = readJsonOrEmpty(target);
  // v2 config format ("providers", plural). The v1 "provider" key is
  // deprecated and its normalizer silently drops "capabilities" - which is
  // what carries the effort list. Capabilities give the /efforts picker the
  // full range (low/medium/high/xhigh/max) for openai-compatible models.
  delete settings.provider;
  delete settings.providers?.planbridge;
  delete settings.providers?.zcodebridge;
  settings.$schema = settings.$schema || 'https://opencode.ai/config.json';
  settings.providers = {
    ...(settings.providers && typeof settings.providers === 'object' ? settings.providers : {}),
    [PROVIDER_KEY]: {
      name: 'ZCodeBridge',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: `${PROXY_URL}/v1`, apiKey: 'zcodebridge' },
      models: {
        'GLM-5.3': {
          name: 'GLM-5.3 (ZCode)',
          capabilities: {
            reasoning: { supported: true, effort: ['low', 'medium', 'high', 'xhigh', 'max'] },
          },
        },
        'GLM-5.3-Flash': {
          name: 'GLM-5.3-Flash (ZCode)',
          capabilities: {
            reasoning: { supported: true, effort: ['low', 'medium', 'high', 'xhigh', 'max'] },
          },
        },
      },
    },
  };
  ensureParent(target);
  fs.writeFileSync(target, JSON.stringify(settings, null, 2) + '\n');
  console.log(`  OpenCode -> ${target}`);
  if (backup) console.log(`  backup: ${backup}`);
  console.log('  models: GLM-5.3 (ZCode), GLM-5.3-Flash (ZCode)');
  console.log('  /efforts picker: low, medium, high, xhigh, max');
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

async function setup() {
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



module.exports = { setup };

if (require.main === module) {
  setup().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
