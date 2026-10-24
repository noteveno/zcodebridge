# ZCodeBridge

Use your **ZCode / Z.ai plan** through the APIs every tool already speaks:

- **OpenAI Chat Completions** — `POST /v1/chat/completions`
- **OpenAI Responses** — `POST /v1/responses` (what Codex uses)
- **Anthropic Messages** — `POST /v1/messages`
- `GET /v1/models` · `GET /v1/usage` (plan tokens left + expiry) · `GET /health`

Works with **Claude Code**, **Codex**, **OpenCode**, and any OpenAI/Anthropic SDK — on **Windows, macOS and Linux**. The ZCode desktop app does not need to be running; you can even skip it entirely and log in right from the terminal.

- **Zero dependencies** — pure Node.js 18+, nothing to install
- **Multi-account** — round-robin rotation, per-request pinning, auto-rotation when a plan expires
- **Per-model quota awareness** — each model has its own token bucket; the proxy routes around empty buckets, falls back to daily tokens when the big plan runs dry, and tells you what to do when everything is used up
- **Auto model discovery** — new models Z.ai ships later are detected and served automatically
- **One-command setup** — an interactive wizard configures your coding tools for you

## Install

```bash
git clone https://github.com/noteveno/zcodebridge.git
cd zcodebridge
node server.js        # start the proxy on http://127.0.0.1:8787
node setup            # connect Claude Code / Codex / OpenCode (your choice)
```

That's it — no `npm install`, no build step. If you've signed into ZCode before, the proxy works with that account immediately; otherwise add one right away:

```bash
node accounts login
```

(To run as a service on Linux, see `deploy/zcodebridge.service`.)

## Adding accounts

```bash
node accounts login            # name is derived from the account email automatically
node accounts login work       # ...or give it an explicit name
node accounts add <name>       # or capture the login from the ZCode desktop app
node accounts list             # all accounts
node accounts usage            # live tokens used/left + expiry per account
node accounts remove <name>
```

`login` prints a link you open in any browser yourself (nothing auto-opens — the browser can be on any device or network). After you sign in:

1. The page may ask to open the ZCode app or show an **"Authorization Failed"** screen — that's fine.
2. **Don't click any "open app" button** — instead copy the link from the browser **address bar** (it contains `code=...`).
3. Paste it into the terminal.

The CLI exchanges the code, saves the account (named after your email when no name is given), **claims any free plan automatically**, and prints your balance.

### Rotation and quota

With several accounts:

- requests rotate across all of them to spread quota
- `x-zcode-account: <name>` pins a request to one account
- each model has its own bucket (e.g. 300M Flash tokens + 200M GLM-5.3 tokens); accounts with 0 left for the requested model are skipped
- expired plans and rejected tokens auto-rotate to the next account
- when a model's tokens are gone everywhere you get a clear message: which other model still has quota, or to add a new account
- **when the big one-time plan runs out**, the proxy automatically continues on the plan's daily-reset buckets (e.g. 5M Flash / 3M GLM-5.3 per day), and the usage output says so, including when the next daily refill lands

## Usage & limits

```bash
curl http://127.0.0.1:8787/v1/usage
```

Shows per account: active plans, expiry, per-model buckets (total / used / remaining / reset time), and a `plan_status` field (`active`, or "one-time plan tokens finished; using daily tokens …"). Add `x-refresh-usage: 1` to bypass the 30-second cache. `node accounts usage` prints a friendly version.

## Models

- `GLM-5.3` and `GLM-5.3-Flash` — 1M-token context window, 128K max output tokens
- Common aliases map automatically (`gpt-4o`, `claude-sonnet` → GLM-5.3; `gpt-4o-mini`, `claude-haiku` → GLM-5.3-Flash)
- **Effort variants**: any model name may carry an effort suffix — `glm-5.3-max`, `glm-5.3-xhigh`, `glm-5.3-flash-max`, … — for tools whose effort picker doesn't go up to max (e.g. OpenCode). The suffix sets the thinking effort and the name routes to the base model.
- **New models appear automatically**: plan entitlements list every model the account may use, and the proxy serves them the moment they show up. `node models.js watch` also runs as a standalone monitor.

## Thinking & effort

The models always think, and thinking is visible:

- **Claude Code / Anthropic wire**: thinking blocks stream natively
- **OpenAI wire**: exposed as `reasoning_content` (deltas while streaming)
- **Codex / Responses wire**: emitted as `reasoning` summary items/events

Effort scales map cleanly: the upstream supports `low`, `high`, `max`; client scales like `minimal`, `medium`, `xhigh`, `ultracode` are translated automatically (`xhigh`/`ultracode` → `max`). `thinking: {"type":"disabled"}` (unsupported upstream) becomes effort `low` instead of failing. If thinking ever consumes the whole `max_tokens` budget, the proxy retries once at low effort so you still get an answer.

## JSON mode

`response_format` (`json_schema` / `json_object`) and the Responses `text.format` are fully enforced by the proxy: schema-aware instruction, thinking pinned low so it can't eat the budget, and markdown fences stripped — your `content` is always parseable JSON, streamed or not.

## Tool-specific notes

- **Claude Code**: `node setup` restricts the model picker to GLM-5.3 / GLM-5.3 Flash and maps every built-in alias to them. Thinking works (`MAX_THINKING_TOKENS`).
- **Codex**: configured via the Responses wire, no API key variable needed. `node setup` also installs a custom model catalog (`~/.codex/zcodebridge-models.json`) that **replaces Codex's model picker with GLM-5.3 (ZCode) / GLM-5.3-Flash (ZCode)**, gives them the real 1M-token context metadata, and removes the "model metadata not found" warning. The picker's effort list comes from the catalog: low / medium / high / xhigh / max.
- **OpenCode**: configured with the v2 `providers` format — exactly two models, **GLM-5.3 (ZCode)** and **GLM-5.3-Flash (ZCode)** — with declared reasoning capabilities, so the `/efforts` picker offers **low / medium / high / xhigh / max** (verified end-to-end; the older v1 `provider` config key is deprecated and silently drops capabilities, which is why effort lists used to cap at high).

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
node backup.js     # or: npm run backup
```

Writes `zcodebridge-backup.zip` containing the **entire folder including secrets** (accounts, configs). Keep it private; it is gitignored and never committed. A git pre-commit hook refreshes it automatically (`cp deploy/pre-commit .git/hooks/pre-commit`).

## Testing

```bash
node tests/test_regression.mjs    # or: npm test (proxy must be running)
```

Covers all endpoints (normal + streaming), tool calls and round trips, system-prompt override, JSON mode, long conversations, and account routing.

## Project layout

```
server.js        entry point            setup.js     setup wizard
accounts.js      account CLI            models.js    model watcher
backup.js        admin backup zip       tests/       regression suite
src/             implementation modules
prompts/         ZCode system prompt blocks (required)
deploy/          systemd unit + git hook
```

## Notes

- Meant for `localhost`. If you expose it to a LAN, set `PROXY_API_KEY`.
- Message content is never logged — only status, model, account, timing.
- MIT licensed.
