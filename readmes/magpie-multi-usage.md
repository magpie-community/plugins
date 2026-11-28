# magpie-multi-usage

**English** | [简体中文](README.zh-CN.md)

An open-source, zero-dependency multi-device token usage dashboard plugin for [Magpie](https://github.com/yetone/magpie). Built for running Magpie on multiple machines with independent configs — a primary workstation, headless servers, intermittently online laptops: each device publishes sanitized usage counters to a dedicated private GitHub repository, and any machine can view the combined dashboard without merging configs, exposing gateway ports, or handing Magpie's backup decryption passphrase to a plugin.

## Highlights

- **Works out of the box**: local usage (gateway requests plus Magpie-discovered Claude Code, OpenCode, Codex, and Antigravity sessions) renders with zero setup.
- **Independent multi-device aggregation**: workstations, laptops, and headless `magpie serve` nodes publish automatically via Magpie's read-only hooks — no external cron jobs.

## Installation

Install directly from GitHub via Magpie's CLI:

```bash
magpie plugin add github:haoyuqi/magpie-multi-usage
```

Or install from a local clone:

```bash
git clone https://github.com/haoyuqi/magpie-multi-usage.git
magpie plugin add /path/to/magpie-multi-usage
```

Open **Multi-Device Usage** (**多端用量**) in the Magpie sidebar — local usage loads automatically with zero setup.

## Multi-device relay setup

### 1. Create a dedicated private GitHub repository

Create a new **Private** repository solely for sanitized usage stats (for example, `<you>/magpie-usage-stats`) and initialize its default branch (such as `main` with a README).

> [!IMPORTANT]
> Do **not** reuse your Magpie configuration sync repository, and do **not** use a public repository. This plugin verifies `private === true` before every read and ref update, and refuses public repositories (`PUBLIC_REPO_REFUSED`).

### 2. Create a fine-grained PAT

Create a GitHub **fine-grained personal access token** scoped strictly to **Only select repositories → your dedicated stats repo**, choosing permissions by what each machine will do:

- Machines that publish their own usage: `Contents: Read and write`.
- Machines that only view the combined dashboard: `Contents: Read-only`, and turn off **Publish this machine's usage** in Settings.

### 3. Configure each machine

- **Magpie Desktop / `magpie web`**: open **Multi-Device Usage** → **Settings** gear → set **Device display name** (optional), **Private GitHub repository** (`owner/repo`), and **PAT** → **Test connection** → **Save and sync**.
- **Headless `magpie serve` node**: set non-sensitive options (`repo`, `deviceName`, `pushEnabled`, `pushIntervalSec`) via `magpie plugin options`, and supply the PAT via `MAGPIE_MULTI_USAGE_GITHUB_TOKEN` (or a `0600`-mode `<dataDir>/credentials.json`) — never in plaintext `plugins.json`.

> [!NOTE]
> Background publishing on headless servers triggers after completed gateway requests. If a node routes zero traffic through the gateway, open the plugin page or trigger a refresh once to publish those sessions.

## How it works

1. Each device incrementally pulls its own usage from Magpie's loopback API and publishes sanitized monthly snapshots into its own `<prefix>/<device-id>/` folder — one atomic commit per device, no cross-machine conflicts.
2. Any machine aggregates on read: combined and per-device totals, two-tone daily bars, clickable device filters, and tabbed **Agents / Models / Providers** breakdowns. Offline devices keep their last hash-verified cached snapshot, flagged as cached.

## Configuration reference

### Settings & plugin options

| Field | Default | Description |
| --- | --- | --- |
| `lang` | `"auto"` | UI language (`auto`, `en`, or `zh`), persisted in `<dataDir>/config.json`. |
| `deviceName` | `""` | Custom label for this machine. Falls back to Magpie's `usage-computer.json` name, then OS hostname, then device ID. |
| `repo` | `""` | Dedicated private GitHub repository in `owner/repo` format. |
| `branch` | `""` | Optional target branch (defaults to the repository's default branch). |
| `prefix` | `"devices"` | Folder prefix inside the repository (`<prefix>/<device-id>/...`). |
| `pushEnabled` | `true` | Publish this machine's sanitized snapshots to the relay repo. Disable for read-only viewer mode. |
| `pushIntervalSec` | `300` | Minimum debounce interval (seconds, `30`–`86400`) between automatic hook-triggered pushes. |
| `filterForwarded` | `true` | Exclude cross-Magpie forwarded calls (`via !== ""`) to prevent double-counting when both nodes report. |
| `port` | `18792` | Loopback port for the local page service (`127.0.0.1`). |
| `dataDir` | `""` | Optional override for the plugin's isolated data directory. |

### Environment variables

| Variable | Description |
| --- | --- |
| `MAGPIE_MULTI_USAGE_GITHUB_TOKEN` | Fine-grained GitHub PAT (takes precedence over `<dataDir>/credentials.json`). |
| `MAGPIE_MULTI_USAGE_DATA_DIR` | Override plugin data directory (default: `$XDG_DATA_HOME/magpie-multi-usage` or `~/.local/share/magpie-multi-usage` on POSIX; `%LOCALAPPDATA%\magpie-multi-usage` on Windows). |
| `MAGPIE_ADDR` | Optional loopback Magpie gateway address (falls back to read-only `<magpieConfigDir>/settings.json`, then `http://127.0.0.1:3425`). |
| `MAGPIE_CONFIG_DIR` | Optional read-only Magpie configuration directory path. |

## Relay repository layout

Each device writes exclusively under its own `<prefix>/<device-id>/` folder in a single atomic commit, eliminating cross-machine merge conflicts:

```text
devices/
└── <device-id>/
    ├── manifest.json   # device metadata, coverage window, and SHA-256 hash per month
    ├── 2026-10.json    # sanitized daily & model/agent/provider aggregate counters
    └── 2026-11.json
```

Only aggregate counters (`calls`, `errors`, `excludedForwarded`, `input`, `output`, `cacheRead`, `cacheWrite`, `cost`) and dimension labels (`model`, `agent`, `provider`) are stored — never prompts, responses, headers, keys, or IPs.

## Token accounting

- **Total tokens**: `input + output + cacheRead + cacheWrite` (cache tokens are never double-counted inside `input`).
- **Cache hit rate**: `cacheRead / (input + cacheRead + cacheWrite)`, matching Magpie's `Totals.HitRate()`.
- **Forwarding deduplication**: Calls with a non-empty `via` field are excluded by default (`filterForwarded: true`) and reported in the `forwarded excluded` counter.

## Privacy and security

- Never reads or asks for Magpie's backup decryption passphrase or any credentials, and never writes to `~/.config/magpie`; plugin data lives in its own directory.
- The relay repository stores only aggregate counters and dimension labels — never prompts, responses, keys, emails, or IPs.
- PATs are stored only in an environment variable or a `0600`-mode `credentials.json`; the local page listens only on `127.0.0.1`.

## FAQ

- **`PUBLIC_REPO_REFUSED`**: the configured repository is public; switch to a dedicated private one.
- **`BRANCH_NOT_FOUND` on Test connection**: the target branch isn't initialized yet; create it on GitHub first (for example, add a README when creating the repo).
- **Device name shows the hostname**: set a friendly name in **Settings → Device display name**, then save and sync.
- **Want to reset local plugin state**: remove `<dataDir>` (default `~/.local/share/magpie-multi-usage`); Magpie's own data is untouched and re-ingests cleanly on next open.

## Documentation & development

- Architecture and file index: [docs/code-map.md](docs/code-map.md)
- Engineering and security standards: [docs/code-standards.md](docs/code-standards.md)

All tests run completely offline against isolated temporary directories and local HTTP fixtures:

```bash
HOME=$(mktemp -d) node --test test/*.test.mjs
HOME=$(mktemp -d) bun test test/
```

## License

MIT License — see [LICENSE](LICENSE).
