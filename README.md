# ZCodeBridge

Use your **ZCode / Z.ai plan** through the APIs every tool already speaks:

- **OpenAI Chat Completions** — `POST /v1/chat/completions`
- **OpenAI Responses** — `POST /v1/responses` (what Codex uses)
- **Anthropic Messages** — `POST /v1/messages`
- `GET /v1/models` · `GET /v1/usage` (plan tokens left + expiry) · `GET /v1/stats` · `GET /health`

Works with **Claude Code**, **Codex**, **OpenCode**, and any OpenAI/Anthropic SDK — on **Windows, macOS and Linux**. The ZCode desktop app does not need to be running; you can even skip it entirely and log in right from the terminal.

- **Zero dependencies** — pure Node.js 18+, nothing to install
- **Multi-account** — round-robin rotation, per-request pinning, auto-rotation when a plan expires
- **Per-model quota awareness** — each model has its own token bucket; the proxy routes around empty buckets, falls back to daily tokens when the big plan runs dry, and tells you what to do when everything is used up
- **Auto model discovery** — new models Z.ai ships later are detected and served automatically
- **GLM in every tool's picker** — Codex's model list is replaced with GLM-5.3 / GLM-5.3-Flash; Claude Code's aliases are remapped; OpenCode gets a full low → max effort range

## Install

```bash
git clone https://github.com/noteveno/zcodebridge.git
cd zcodebridge
node server        # start the proxy on http://127.0.0.1:8787
node setup         # connect Claude Code / Codex / OpenCode (your choice)
```

That's it — no `npm install`, no build step. If you've signed into ZCode before, the proxy works with that account immediately; otherwise add one right away:

```bash
node auth
```

(To run as a service on Linux, see `deploy/zcodebridge.service`.)

## Commands

Every command is a one-liner, styled, and works the same on Windows / macOS / Linux:

| Command | What it does |
| --- | --- |
| `node server` | Start the proxy — banner shows accounts + today/7-day request & token stats |
| `node auth` | Add a Z.ai account (interactive OAuth; auto-named from your email) |
| `node usage` | Live plan usage: token bars, remaining amounts, expiry countdowns |
| `node stats` | Proxy requests + tokens per day / week / all time, with cache hit rate |
| `node list` | All configured accounts with email and token status |
| `node claim [name]` | Claim any free plan Z.ai offers that account |
| `node add <name>` | Capture the login from the ZCode desktop app |
| `node remove <name>` | Delete a stored account |
| `node setup` | (Re)configure Claude Code / Codex / OpenCode |
| `node backup` | Admin backup zip (includes secrets; gitignored) |
| `node models watch` | Standalone monitor for newly released Z.ai models |

`node accounts <command>` also still works (`node accounts usage`, …), and the npm scripts (`npm start`, `npm test`, `npm run backup`) are shortcuts for the same things. Colors turn off automatically when output is piped.

## Adding accounts

`node auth` prints a sign-in link you open in any browser yourself (nothing auto-opens — the browser can be on any device or network). After you sign in:

1. The page may ask to open the ZCode app or show an **"Authorization Failed"** screen — that's fine.
2. **Don't click any "open app" button** — instead copy the link from the browser **address bar** (it contains `code=...`).
3. Paste it into the terminal.

The CLI exchanges the code, saves the account (named after your email when no name is given), claims every free plan Z.ai offers to that account (re-run `node claim` later if a new one becomes available), and prints your balance.

### Rotation and quota

With several accounts:

- requests rotate across all of them to spread quota
- `x-zcode-account: <name>` pins a request to one account
- each model has its own bucket (e.g. 300M Flash tokens + 200M GLM-5.3 tokens); accounts with 0 left for the requested model are skipped
- expired plans and rejected tokens auto-rotate to the next account
- when a model's tokens are gone everywhere you get a clear message: which other model still has quota, or to add a new account
- **when the big one-time plan runs out**, the proxy automatically continues on the plan's daily-reset buckets (e.g. 5M Flash / 3M GLM-5.3 per day), and the usage output says so, including when the next daily refill lands

## Usage, limits & stats

```bash
curl http://127.0.0.1:8787/v1/usage     # per-account plans + token buckets
curl http://127.0.0.1:8787/v1/stats     # requests + tokens per day/week/all time
```

`/v1/usage` shows per account: active plans, expiry, per-model buckets (total / used / remaining / reset time), and a `plan_status` field (`active`, or "one-time plan tokens finished; using daily tokens …"). Add `x-refresh-usage: 1` to bypass the 30-second cache.

`/v1/stats` (or `node stats`) adds the **prompt-cache hit rate** — ZCode's system prompt is byte-identical on every request, so the gateway caches it and the rate climbs quickly within a session.

## Models

- `GLM-5.3` and `GLM-5.3-Flash` — 1M-token context window, 128K max output tokens
- Common aliases map automatically (`gpt-4o`, `claude-sonnet` → GLM-5.3; `gpt-4o-mini`, `claude-haiku` → GLM-5.3-Flash)
- **Effort variants**: any model name may carry an effort suffix — `glm-5.3-max`, `glm-5.3-xhigh`, `glm-5.3-flash-max`, … — for tools whose effort picker doesn't go up to max. The suffix sets the thinking effort and the name routes to the base model.
- **New models appear automatically**: plan entitlements list every model the account may use, and the proxy serves them the moment they show up. `node models watch` also runs as a standalone monitor.

## Thinking & effort

The models always think, and thinking is visible:

- **Claude Code / Anthropic wire**: thinking blocks stream natively
- **OpenAI wire**: exposed as `reasoning_content` (deltas while streaming)
- **Codex / Responses wire**: emitted as `reasoning` summary items/events

Effort scales map cleanly: the upstream supports `low`, `high`, `max`; client scales like `minimal`, `medium`, `xhigh`, `ultracode` are translated automatically (`xhigh`/`ultracode` → `max`). `thinking: {"type":"disabled"}` (unsupported upstream) becomes effort `low` instead of failing. If thinking ever consumes the whole `max_tokens` budget, the proxy retries once at low effort so you still get an answer.

## JSON mode

`response_format` (`json_schema` / `json_object`) and the Responses `text.format` are fully enforced by the proxy: schema-aware instruction, thinking pinned low so it can't eat the budget, and markdown fences stripped — your `content` is always parseable JSON, streamed or not.

## Tool-specific notes

- **Claude Code**: `node setup` restricts the model picker to GLM-5.3 / GLM-5.3 Flash, maps every built-in alias to them, and starts sessions on GLM-5.3. Thinking works (`MAX_THINKING_TOKENS`).
- **Codex**: configured via the Responses wire, no API key variable needed. `node setup` also installs a custom model catalog (`~/.codex/zcodebridge-models.json`) that **replaces Codex's model picker with GLM-5.3 (ZCode) / GLM-5.3-Flash (ZCode)**, gives them the real 1M-token context metadata (no more "model metadata not found" warning), and offers efforts low / medium / high / xhigh / max. Restart codex after running setup — the catalog loads at startup.
- **OpenCode**: configured with the v2 `providers` format — exactly two models, **GLM-5.3 (ZCode)** and **GLM-5.3-Flash (ZCode)** — with declared reasoning capabilities, so the `/efforts` picker offers **low / medium / high / xhigh / max** (verified end-to-end; the older v1 `provider` config key is deprecated and silently drops capabilities, which is why effort lists used to cap at high).

## Troubleshooting

- **"ZCodeBridge is already running"** — another instance owns the port. Use it, or stop it first (`netstat -ano | findstr 8787` → `taskkill /PID <pid> /F` on Windows).
- **Codex still shows GPT models in the picker** — the catalog loads at startup; close and reopen codex after running `node setup`.
- **"Model metadata not found" warning** — should not appear anymore (the catalog provides it). If it does, re-run `node setup`.
- **`model_provider "planbridge" not found`** — very old configs referenced the previous name; `node setup` replaces those references automatically.
- **Requests fail with "No accounts are configured"** — add one: `node auth`.
- **A model returns errors about its plan** — the account's quota for that model is drained; the proxy rotates accounts automatically and the final error names your options (other model, or `node auth`).

## Configuration (optional)

Defaults work out of the box. To customize, copy `config.example.json` to `config.json`:

| Key | Env override | Meaning |
| --- | --- | --- |
| `host` / `port` | `HOST` / `PORT` | Listen address (default `127.0.0.1:8787`) |
| `apiKey` | `PROXY_API_KEY` | Require clients to send this key |
| `useDefaultAccount` | — | `false` = never read the ZCode desktop login; serve only `accounts/` entries |
| `baseUrl` | `ZCODE_BASE_URL` | Upstream gateway URL |
| `defaultModel` / `flashModel` | `DEFAULT_MODEL` / `FLASH_MODEL` | Model ids |
| `retries` | `UPSTREAM_RETRIES` | Retries for transient upstream errors |
| `logLevel` | `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |
| `dataDir` | `ZCODE_DATA_DIR` | Custom ZCode data directory |
| `accountsDir` | `ZCODE_ACCOUNTS_DIR` | Custom accounts directory |

## Backup (admin)

```bash
node backup     # or: npm run backup
```

Writes `zcodebridge-backup.zip` containing the **entire folder including secrets** (accounts, configs). Keep it private; it is gitignored and never committed. A git pre-commit hook refreshes it automatically (`cp deploy/pre-commit .git/hooks/pre-commit`).

## Testing

```bash
npm test    # proxy must be running; same as node tests/test_regression.mjs
```

Covers all endpoints (normal + streaming), tool calls and round trips, system-prompt override, JSON mode, long conversations, and account routing.

## Project layout

```
server.js          thin entry point (node server)
auth.js usage.js list.js add.js remove.js claim.js stats.js
                   one-line command stubs (implementations in cli/)
accounts.js        stub for the full account manager (cli/accounts.js)
setup.js           stub for the setup wizard (cli/setup.js)
backup.js          stub for the admin backup (cli/backup.js)
models.js          stub for the model watcher (cli/models.js)
cli/               command implementations
src/               proxy engine (config, credentials, prompts, models,
                   platform, upstream, billing, sse, openai, responses,
                   anthropic, server, stats)
prompts/           ZCode system prompt blocks (required)
deploy/            systemd unit, git pre-commit hook, codex base instructions
tests/             end-to-end regression suite
```

## Notes

- Meant for `localhost`. If you expose it to a LAN, set `PROXY_API_KEY`.
- Message content is never logged — only status, model, account, timing, and anonymous token counts for the stats above.
- MIT licensed.
