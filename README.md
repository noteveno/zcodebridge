# PlanBridge

Use your **ZCode / Z.ai plan** through the APIs every tool already speaks:

- **OpenAI Chat Completions** — `POST /v1/chat/completions`
- **OpenAI Responses** — `POST /v1/responses` (what Codex uses)
- **Anthropic Messages** — `POST /v1/messages`
- `GET /v1/models` · `GET /v1/usage` (plan tokens left + expiry) · `GET /health`

Works with **Claude Code**, **Codex**, **OpenCode**, and any OpenAI/Anthropic SDK — on **Windows, macOS and Linux**. The ZCode desktop app does not need to be running; you can even skip it entirely and log in right from the terminal.

- **Zero dependencies** — pure Node.js 18+, nothing to install
- **Multi-account** — round-robin rotation, per-request pinning, auto-rotation when a plan expires
- **Per-model quota awareness** — each model has its own token bucket; the proxy routes around empty buckets and tells you which model still has quota
- **Auto model discovery** — new models Z.ai ships later are detected and served automatically
- **One-command setup** — an interactive wizard configures your coding tools for you

## Quick start

```bash
node server.js          # start the proxy on http://127.0.0.1:8787
node setup              # connect Claude Code / Codex / OpenCode (your choice)
```

The wizard asks which tools to set up (one, several, or all), **backs up every config before touching it**, and wires everything to the proxy. If you've signed into ZCode before, the proxy works with that account immediately.

## Adding accounts

```bash
node accounts.js login            # name is derived from the account email automatically
node accounts.js login work       # ...or give it an explicit name
node accounts.js add <name>       # or capture the login from the ZCode desktop app
node accounts.js list             # all accounts
node accounts.js usage            # live tokens used/left + expiry per account
node accounts.js remove <name>
```

`login` prints a link you open in any browser yourself (nothing auto-opens — the browser can be on any device or network). After you sign in, the page shows a "login complete" screen with a button linking to `zcode://oauth/callback?code=...`:

1. **Don't click the button** (it would open the ZCode desktop app) — instead **right-click it → "Copy link address"** (or copy the `zcode://...` URL from the address bar).
2. Paste that link into the terminal.

The CLI exchanges the code, saves the account (named after your email when no name is given), claims any free plan automatically, and the proxy picks it up on the next request.

With several accounts:

- requests rotate across all of them to spread quota
- `x-zcode-account: <name>` pins a request to one account
- expired plans and rejected tokens auto-rotate to the next account
- when a model's tokens are gone everywhere, you get a clear message: which other model still has quota, or to add a new account

## Usage & limits

```bash
curl http://127.0.0.1:8787/v1/usage
```

Shows per account: active plans, expiry dates, and per-model token buckets (total / used / remaining). Add `x-refresh-usage: 1` to bypass the 30-second cache.

## Models

- `GLM-5.3` and `GLM-5.3-Flash` — 1M-token context window, 128K max output tokens
- Common aliases map automatically (`gpt-4o`, `claude-sonnet` → GLM-5.3; `gpt-4o-mini`, `claude-haiku` → GLM-5.3-Flash; unknown names fall back to GLM-5.3)
- **New models appear automatically**: plan entitlements list every model the account may use, and the proxy serves them the moment they show up (`GET /v1/models` reflects it). `node models.js watch` also runs as a standalone monitor that logs the moment a new model (a future GLM-5.4, say) is detected.

## Thinking & effort

The models always think, and thinking is visible:

- **Claude Code / Anthropic wire**: thinking blocks stream natively
- **OpenAI wire**: exposed as `reasoning_content` (deltas while streaming)
- **Codex / Responses wire**: emitted as `reasoning` summary items/events

Effort scales map cleanly: the upstream supports `low`, `high`, `max`; client scales like `minimal`, `medium`, `xhigh`, `ultracode` are translated automatically (`xhigh`/`ultracode` → `max`). `thinking: {"type":"disabled"}` (unsupported upstream) becomes effort `low` instead of failing. If thinking ever consumes the whole `max_tokens` budget, the proxy retries once at low effort so you still get an answer.

## JSON mode

`response_format` (`json_schema` / `json_object`) is fully enforced by the proxy: schema-aware instruction, thinking pinned low so it can't eat the budget, and markdown fences stripped — your `content` is always parseable JSON, streamed or not.

## Configuration (optional)

Defaults work out of the box. To customize, copy `config.example.json` to `config.json`:

| Key | Env override | Meaning |
| --- | --- | --- |
| `host` / `port` | `HOST` / `PORT` | Listen address (default `127.0.0.1:8787`) |
| `apiKey` | `PROXY_API_KEY` | Require clients to send this key |
| `baseUrl` | `ZCODE_BASE_URL` | Upstream gateway URL |
| `defaultModel` / `flashModel` | `DEFAULT_MODEL` / `FLASH_MODEL` | Model ids |
| `retries` | `UPSTREAM_RETRIES` | Retries for transient upstream errors |
| `logLevel` | `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |
| `dataDir` | `ZCODE_DATA_DIR` | Custom ZCode data directory |
| `accountsDir` | `ZCODE_ACCOUNTS_DIR` | Custom accounts directory |

## Manual CLI setup (if you prefer no wizard)

**Claude Code**

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=x
claude -p "hello" --model claude-3-5-haiku-20241022
```

**Codex** — `~/.codex/config.toml`

```toml
model = "glm-5.3-flash"
model_provider = "planbridge"

[model_providers.planbridge]
name = "PlanBridge"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
env_key = "PLANBRIDGE_KEY"
```

**OpenCode** — `~/.config/opencode/opencode.json`

```json
{
  "provider": {
    "planbridge": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8787/v1", "apiKey": "x" },
      "models": { "GLM-5.3": {}, "GLM-5.3-Flash": {} }
    }
  }
}
```

## Backup (admin)

```bash
node backup.js     # or: npm run backup
```

Writes `planbridge-backup.zip` containing the **entire folder including secrets** (accounts, configs). Keep it private; it is gitignored and never committed.

## Testing

```bash
node tests/test_regression.mjs    # or: npm test (proxy must be running)
```

Covers all endpoints (normal + streaming), tool calls and round trips, system-prompt override, JSON mode, long conversations, and routing routes.

## Project layout

```
server.js        entry point            setup.js     setup wizard
accounts.js      account CLI            models.js    model watcher
backup.js        admin backup zip       tests/       regression suite
src/             implementation modules
prompts/         ZCode system prompt blocks (required)
deploy/          systemd unit for Linux services
```

## Notes

- Meant for `localhost`. If you expose it to a LAN, set `PROXY_API_KEY`.
- Message content is never logged — only status, model, account, timing.
- MIT licensed.
