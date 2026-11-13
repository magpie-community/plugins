# agy-acp

Multi-account **Antigravity CLI (`agy acp`)** model provider plugin for [Magpie](https://usemagpie.ai) and [OpenCode](https://opencode.ai).

`agy-acp` drives your installed `agy` binary over the official Agent Client Protocol (`agy acp`), exposing Gemini, Claude, and GPT-OSS models offered to `agy` under provider ID **`agy-acp`** while keeping tool execution 100% client-owned.

## How It Differs

| Capability | `agy-acp` (this plugin) | `agy-cli` (`@magpie-community/opencode-agy-cli-auth`) | `antigravity` (`@magpie-community/opencode-antigravity-auth`) |
|---|---|---|---|
| Upstream transport | Local `agy acp` subprocess pool | Local `agy acp` subprocess pool | Direct HTTP API with OAuth token |
| Multi-account pool | **Yes** — isolated per-account credentials + host login | No (`single: true`, one keychain login) | Yes |
| Client tool bridge | Native Streamable-HTTP MCP (`127.0.0.1`) | `PATH` `nc` wrapper over stdio | Direct wire tool calls |
| Session & cache handling | Warm worker affinity + `session/resume` + WAL SQLite per-step cache accounting | Warm worker pool + `session/resume` | Stateless HTTP |

> Note: On the same Google account, `agy-acp`, `agy-cli`, and `antigravity` draw from the same Antigravity subscription quota pool.

## Requirements

- **`agy` CLI** `>= 1.5.0` installed on `PATH` (or set `AGY_PATH`)
- **Magpie** `>= 0.1.3900`

## Install & Sign In

```sh
magpie plugin add github:sidkang/agy-acp
magpie plugin login agy-acp
```

Models are served as `agy-acp/<model>` (for example `agy-acp/gemini-3.8-flash`, `agy-acp/gemini-4-hydrogen`, `agy-acp/claude-sonnet-5-5`, `agy-acp/claude-opus-5-5`).

### Sign-In Modes

Run `magpie plugin login agy-acp` (or add accounts in **Magpie › Providers › Antigravity ACP**) as many times as needed:

1. **Sign in isolated Google account (multi-account)** *(recommended)* — creates an isolated `0700` account directory under `$XDG_DATA_HOME/agy-acp/accounts/<uuid>` using file-backed credentials without touching your system Keychain or terminal `agy` login. Open the printed Google OAuth URL and paste back the authorization code or callback URL.
2. **Adopt existing local agy login (host default)** — reuses the account already signed in via `agy` in your shell.

Check per-account 5-hour / weekly quota windows:

```sh
magpie quota agy-acp
```

## Options

### Provider Switches (Magpie › Providers › Antigravity ACP)

| Option | Default | Description |
|---|---|---|
| `quota_routing` | `false` | Expose 5-hour/weekly buckets to Magpie routing so exhausted accounts fail over automatically |
| `cloak_prompts` | `true` | Strip billing headers and cloak third-party harness phrases that trigger upstream 429 refusals |
| `minimal_agent` | `false` | Enable `excludeDefaultComponents` on the bridge agent to reduce built-in system prompt tokens |
| `expose_thinking` | `false` | Emit ACP thought summaries as Anthropic `thinking` blocks |

### Plugin Options (`plugins.json` / Magpie › Plugins › Installed › Options)

```json
{
  "maxGlobalWorkers": 16,
  "maxPerAccountWorkers": 6,
  "idleTimeoutMs": 3600000
}
```

`AGY_PATH` overrides the `agy` binary location; `AGY_ACP_DATA_DIR` overrides the isolated account storage root. See [docs/claude-bridge-parity.md](./docs/claude-bridge-parity.md) for alignment notes with Magpie's official Claude Code bridge.

## Development

```sh
bun install
bun x tsc --noEmit
HOME=$(mktemp -d) bun test
```

## Credits & License

Forked and rewritten in strict TypeScript from [`@magpie-community/opencode-agy-cli-auth`](https://github.com/magpie-community/plugins/tree/main/packages/agy-cli) (`DylanLIiii`, `gitxm`, `yce`). See [NOTICE.md](./NOTICE.md) and [LICENSE](./LICENSE) (MIT).
