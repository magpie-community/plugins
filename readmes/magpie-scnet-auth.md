# magpie-scnet-auth

**Magpie provider plugin for SCNet (scnet.cn) LLM models.**

English | [简体中文](README.zh-CN.md)

Once installed, the models served by the SCNet platform appear in magpie as a `scnet` provider and become available to every agent that magpie drives (Claude Code, Codex, dsh, and others).

- Sign in with an SCNet username and password — no desktop client, no packet capture
- Speaks standard OpenAI Chat Completions
- Passes through tool calls and reasoning content

---

## Supported models

The platform `GET /models` endpoint returns 32 models, including:

| Family | Models |
|---|---|
| Zhipu | GLM-5.3-Flash, GLM-5.3, GLM-5.2, GLM-5.1, GLM-5 |
| Qwen | Qwen3.8-Max, Qwen3.8-Flash, Qwen3.7-Max, Qwen3.7-Plus, Qwen3.6-Plus, Qwen3-235B-A22B |
| DeepSeek | DeepSeek-V4-Pro-0813, DeepSeek-V4.1-Flash, DeepSeek-V4.1-Flash-1017, DeepSeek-V4-Flash-0731 |
| Kimi | Kimi-K3.1-Pro, Kimi-K3, Kimi-K2.7-Code, Kimi-K2.6 |
| MiniMax | MiniMax-M3.1-Flash, MiniMax-M3, MiniMax-M2.7, MiniMax-M2.5 |
| Others | SCNet-Max, Spark-X2.5, MiMo-V2.5-Pro |

**Quota is granted per model.** An account does not necessarily have balance for every model; calls to an unprovisioned model return `402 Insufficient Balance`. The plugin lists all models by default and offers filtering (see Configuration).

---

## Install

```bash
# From a local folder
magpie plugin add /path/to/magpie-scnet-auth

# From GitHub
magpie plugin add github:RrOrange/magpie-scnet-auth

# From npm, once published
magpie plugin add magpie-scnet-auth
```

After installation, the provider **SCNet** appears on the Providers page in magpie.

---

## Sign in

### Username and password (recommended)

In the magpie window:

1. Providers → **SCNet** → click **＋**
2. Choose **Sign in with SCNet username and password**
3. Enter the username / phone number → Next → enter the password → Sign in

The password is used only to exchange for an API key and is not stored; only the returned `sk-…` key is saved.

Command-line equivalent:

```bash
node login.mjs          # prompts for username and password
```

### SMS code

1. Providers → **SCNet** → **＋** → choose **① Send SMS code**, enter the phone number; a 6-digit code is delivered
2. Choose **② Sign in with SMS code**, enter the phone number and the code

Or in one step from the terminal:

```bash
node login-sms.mjs
```

### API key

If an API key already exists on the platform, choose **API Key** and paste `sk-…`.

### Local client credentials

If the SCNet desktop client is installed and signed in (`~/.sclaw/agent/scnet-credentials/`), enter `local` and the plugin reads and validates the available key automatically.

### Any other compatible service

Paste a JSON credential pointing at any OpenAI-compatible endpoint:

```json
{"baseUrl":"https://example.com/v1","apiKey":"sk-…","models":["model-a","model-b"]}
```

---

## Configuration

Environment variables, applied after `magpie plugin off scnet-plugin` / `on scnet-plugin`:

| Variable | Description |
|---|---|
| `SCNET_MODELS` | `all` (default) lists everything; `known` lists only models verified on this machine; or a comma-separated list of model IDs |
| `SCNET_PROBE` | Set to `1` to probe each model's balance (`max_tokens:1`) and keep only usable ones |
| `SCNET_BASE` | Overrides the API base URL (default `https://api.scnet.cn/api/llm/v1`) |
| `SCNET_AGENT_DIR` | Overrides the client config directory (default `~/.sclaw/agent`) |

---

## Authentication and multiple accounts

The plugin contains no authentication layer of its own. A credential is simply the user's API key, stored locally:

```
~/.config/magpie/plugin-auth.json     # mode 0600, readable only by the current user
```

Identity is verified by the SCNet platform (Bearer token). The same plugin can be installed by several people, each using their own credential.

magpie supports multiple accounts for one provider: click **＋** again to add another, mark one as preferred, and the next account is used automatically when the current one runs out of quota.

To share quota with someone else, share the magpie gateway rather than the plugin:

```bash
magpie gateway-key add friend --models 'scnet-plugin/*'
magpie gateway-key limit friend day --tokens 5000000
```

---

## Known limitations

- Quota is counted per model; unprovisioned models return `402`.
- Context and output limits come from the client metadata (e.g. GLM-5.3-Flash: 1048576 / 131072).
- The server occasionally returns `500 internal_error`; retrying resolves it.
- The plugin proxies chat only; it does not expose the platform's image or video generation APIs.
- Concurrency is limited by `magpie.maxConcurrency` (default 4) to avoid triggering rate limits.

---

## Layout

```
magpie-scnet-auth/
├── index.mjs            provider declaration, credential resolution, model discovery
├── login.mjs            username/password login helper (exchanges for a key and writes it into magpie)
├── login-sms.mjs        SMS-code login helper (same, one step)
├── package.json         package manifest
├── README.md            this document
├── README.zh-CN.md      Chinese translation
└── LICENSE
```

---

## License

MIT
