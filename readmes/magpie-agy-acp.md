# agy-acp

English | [Simplified Chinese](./README.zh-CN.md)

Multi-account **Antigravity CLI (`agy acp`)** model provider plugin for [Magpie](https://usemagpie.ai) and [OpenCode](https://opencode.ai).

`agy-acp` drives your installed `agy` binary over the official Agent Client Protocol (`agy acp`), exposing Gemini, Claude, and GPT-OSS models offered to `agy` under provider ID **`agy-acp`** while keeping tool execution 100% client-owned.

## Choosing an Antigravity Plugin

Magpie offers three plugins for Google Antigravity. All three **share the exact same Google Antigravity subscription quota pool** (5-hour and weekly windows) when using the same Google account:

| Feature | `magpie-agy-acp` (`agy-acp`, this plugin) | `opencode-agy-cli-auth` (`agy-cli`) | `opencode-antigravity-auth` (`antigravity`) |
| :--- | :--- | :--- | :--- |
| **Backend / Endpoint** | Local `agy` CLI (`agy acp --worker`); downloads nothing | Local `agy` CLI (`agy acp`); downloads nothing | Direct HTTP calls to Google's internal API (no CLI needed) |
| **Sign-in & Storage** | Isolated `0600` account dirs (no OS Keychain): browser OAuth, remote callback-URL paste, batch JSON/`refresh_token` import (Switcher / CLIProxyAPI), or one-click local `agy` login adoption | Single login stored in OS Keychain via manual `agy` shell sign-in | Multi-account OAuth tokens managed directly in Magpie |
| **Multi-Account & Quota Failover** | Multi-account pool with automatic quota-aware switching (5h/weekly windows + Google AI Pro/Ultra badges) | Single-account only (`single: true`) | Multi-account supported |
| **Headless / Remote Host Setup** | Built-in callback URL paste & JSON token batch import | Requires interactive local `agy` login / keychain setup | Built-in OAuth flow |
| **Client Tool Bridge** | Native loopback HTTP MCP (`127.0.0.1`) | Injects a wrapper `nc` script at the front of `PATH` (`--ide-mcp-port`) | Translated in HTTP payload |
| **Media & Session Resilience** | Auto-downscales inline images (`>2000px` / `>5 MiB`) & strips expired `lostMedia` images to keep sessions alive | Standard `agy` CLI handling | Direct HTTP payload handling |

## Requirements

- **`agy` CLI** `>= 1.5.0` installed on `PATH` (or set `AGY_PATH`)
- **Magpie** `>= 0.1.3900`

## Install & Sign In

```sh
magpie plugin add github:sidkang/agy-acp
# Or, once published on npm:
# magpie plugin add magpie-agy-acp

magpie plugin login agy-acp
```

> The npm package name is `magpie-agy-acp`; the Magpie/OpenCode provider ID remains **`agy-acp`**.

Models are served as `agy-acp/<model>` (for example `agy-acp/gemini-3.8-flash`, `agy-acp/gemini-4-hydrogen`, `agy-acp/claude-sonnet-5-5`, `agy-acp/claude-opus-5-5`).

### Sign-In & Import Modes

Run `magpie plugin login agy-acp` or add accounts in **Magpie › Providers › Antigravity (multi-account local agy CLI)**:

1. **Sign in with Google (browser)** *(default)* — opens Google OAuth and finishes automatically via a local callback listener (or paste the `Callback URL` when running Magpie on a remote server / Docker). Writes isolated `0600` credentials under `$XDG_DATA_HOME/agy-acp/accounts/<uuid>` without touching your system Keychain.
2. **Import from a file / JSON or refresh token** — use **Import from a file instead…** (supports single/multi-account JSON exports from Antigravity Switcher, CLIProxyAPI, `antigravity-oauth-token`, or newline-separated `refresh_token`s) or paste JSON / a refresh token directly under **Other ways to sign in…**.
3. **Adopt existing local agy login (host default)** — reuses the account already signed in via `agy` in your shell.
4. **Sign in via agy terminal code (`agy acp --login`)** — fallback manual code flow driven directly by `agy`.

Check per-account 5-hour / weekly quota windows:

```sh
magpie quota agy-acp
```

## Options

### Provider Switches (Magpie › Providers › Antigravity (multi-account local agy CLI))

| Option | Default | Description |
|---|---|---|
| `quota_routing` | `false` | Expose 5-hour/weekly buckets to Magpie routing so exhausted accounts fail over automatically |
| `cloak_prompts` | `true` | Strip billing headers and cloak third-party harness phrases that trigger upstream 429 refusals |
| `minimal_agent` | `false` | Enable `excludeDefaultComponents` on the bridge agent to reduce built-in system prompt tokens |
| `expose_thinking` | `true` | Emit ACP thought summaries as Anthropic `thinking` blocks |

### Plugin Options (`plugins.json` / Magpie › Plugins › Installed › Options)

```json
{
  "maxGlobalWorkers": 36,
  "maxPerAccountWorkers": 18,
  "idleTimeoutMs": 3600000,
  "awaitingToolTimeoutMs": 600000,
  "waitTimeoutMs": 60000,
  "maxWaiters": 128,
  "maxWorkerRssBytes": 1073741824
}
```

Saturation queues instead of failing fast: `waitTimeoutMs` bounds how long a request waits for a slot (`0` restores the immediate `503`), `maxWaiters` caps the queue, and a cleanly finished worker above `maxWorkerRssBytes` is parked and replaced (`0` disables recycling, `AGY_BRIDGE_MAX_WORKER_RSS_MB` overrides in MiB).

`AGY_PATH` overrides the `agy` binary location; `AGY_ACP_DATA_DIR` overrides the isolated account storage root. See [docs/claude-bridge-parity.md](./docs/claude-bridge-parity.md) for alignment notes with Magpie's official Claude Code bridge.

## Development

```sh
bun install
bun x tsc --noEmit
HOME=$(mktemp -d) bun test
```

## Credits & License

Forked and rewritten in strict TypeScript from [`@magpie-community/opencode-agy-cli-auth`](https://github.com/magpie-community/plugins/tree/main/packages/agy-cli) (`DylanLIiii`, `gitxm`, `yce`). See [NOTICE.md](./NOTICE.md) and [LICENSE](./LICENSE) (MIT).
