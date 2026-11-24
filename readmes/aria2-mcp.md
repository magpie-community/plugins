# aria2-mcp

English | [简体中文](./README.zh-CN.md)

A **zero-config, zero-dependency** [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server and [Magpie](https://usemagpie.ai) tools plugin that gives AI coding agents reliable background HTTP(S) file downloads powered by [aria2](https://aria2.github.io/).

## Why `aria2-mcp`?

Asking an agent to run ad-hoc `curl` / `Invoke-WebRequest` in a shell breaks on real-world downloads: interrupted sessions drop progress, proxies silently fail over to direct connections or leak credentials in logs, and existing files get clobbered. Most existing aria2 MCP wrappers also require you to manually start and configure an `aria2c` RPC daemon first.

`aria2-mcp` solves this out of the box:

- **Zero-config local daemon**: Automatically locates `aria2c`, binds a free `127.0.0.1` port with a random 32-byte RPC secret, locks down the state directory (`icacls` on Windows, `0700` on macOS/Linux), prevents concurrent duplicate launches, and persists resumable sessions (`downloads.session`).
- **Fail-closed OS proxy safety**: Automatically reads the system proxy (Windows Internet Settings registry, macOS `scutil --proxy`, Linux env vars), TCP-probes reachability before starting, refuses silent fallback to direct, rejects unsupported PAC/WPAD explicitly, and never modifies system/global proxy settings.
- **Agent-safe by default**: Never overwrites existing files (auto-suffixes a UUID on conflict), validates filenames and rejects embedded URL credentials, and strips URLs/proxy secrets from tool outputs.
- **Zero dependencies, fast startup**: Pure Node.js 20+ (and Bun-compatible), ~50ms cold start.
- **Dual-mode + Remote RPC**: Runs as a standard stdio MCP server (`npx -y aria2-mcp`), as a 1-click **Magpie** tools plugin (`magpie-plugin`), or pointed at an existing/NAS `aria2c` instance via `ARIA2_RPC_URL`.

## Prerequisites

- **Node.js 20+** (or **Bun** when installed as a Magpie plugin)
- **aria2** installed locally (unless connecting to a remote instance via `ARIA2_RPC_URL`):
  - Windows: `winget install aria2.aria2` or `scoop install aria2`
  - macOS: `brew install aria2`
  - Linux: `sudo apt install aria2` (or your distro's package manager)

## Quick Start

### 1. Any MCP Client (`npx`)

```json
{
  "mcpServers": {
    "aria2": {
      "command": "npx",
      "args": ["-y", "aria2-mcp"]
    }
  }
}
```

Works with **Claude Code**, **Claude Desktop**, **Codex**, **Cursor**, **Windsurf**, **Antigravity (`agy`)**, **VS Code**, and any stdio MCP host.

For Claude Code CLI:

```bash
claude mcp add aria2 -- npx -y aria2-mcp
```

### 2. Magpie (1-click for every connected agent)

Install from Magpie's **Plugins → Discover → Unofficial, on GitHub**, or via CLI:

```bash
magpie plugin add github:Neko-Yukari/aria2-mcp
# or once published to npm:
magpie plugin add aria2-mcp
```

Magpie automatically serves its tools to every connected agent over its built-in MCP router (`aria2-mcp__submit`, `aria2-mcp__status`, `aria2-mcp__list`, `aria2-mcp__control`, `aria2-mcp__wait`), with per-agent toggles in **Library → MCP**.

### 3. Remote / NAS aria2 Instance

```json
{
  "mcpServers": {
    "aria2": {
      "command": "npx",
      "args": ["-y", "aria2-mcp"],
      "env": {
        "ARIA2_RPC_URL": "http://192.168.1.10:6800/jsonrpc",
        "ARIA2_RPC_SECRET": "your-secret",
        "ARIA2_DEFAULT_PROXY": "direct"
      }
    }
  }
}
```

## Tools

| MCP Tool | Magpie Plugin Tool | Purpose |
| :--- | :--- | :--- |
| `download_submit` | `submit` | Submit a background HTTP(S) download (`url`, optional `directory`, `filename`, `proxy`). Returns a GID immediately. |
| `download_status` | `status` | Query progress, speed, status, and safe error code for a GID. |
| `download_list` | `list` | List active, waiting, and recently stopped downloads (up to 100 per queue). |
| `download_control` | `control` | `pause`, `resume`, or `cancel` a download by GID (`cancel` retains partial files). |
| `download_wait` | `wait` | Wait cleanly (up to 120s in MCP, 50s in Magpie) for completion/error/pause without tight polling loops. |

### Completion & Progress Notifications

Because MCP hosts differ in how they handle server-initiated events, `aria2-mcp` supports three layers:

1. **In-call waiting (`download_wait` + `notifications/progress`)**: For short/medium files, call `download_wait`. When the MCP client passes `_meta.progressToken`, `aria2-mcp` streams standard MCP `notifications/progress` updates as bytes arrive.
2. **Proactive MCP notifications (`notifications/message` + optional `claude/channel`)**: Downloads submitted via `download_submit` are watched in the background (every 5s by default, configurable via `ARIA2_NOTIFY_POLL_MS`). When a download completes or errors, `aria2-mcp` emits a standard MCP `notifications/message` (never leaking URLs or credentials) and, for clients advertising `experimental["claude/channel"]` (or with `ARIA2_CLAUDE_CHANNEL=1`), also emits `notifications/claude/channel`.
3. **CLI Reactive Waiter (`--wait <gid>`)**: For multi-minute downloads in agents that wake up automatically when a background shell task exits (e.g., Antigravity, Claude Code, Codex), run:

```bash
npx -y aria2-mcp --wait <gid> [--timeout 3600]
```

Exit codes: `0` = complete, `1` = error/removed, `2` = paused, `124` = timed out.

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `ARIA2_BIN` | Auto-detected | Explicit path to `aria2c` / `aria2c.exe`. |
| `ARIA2_DATA_DIR` | OS app-data dir | Directory storing `rpc.json`, `aria2.conf`, and `downloads.session`. Point multiple tools at the same folder to share one queue. |
| `ARIA2_DEFAULT_DIR` | `~/Downloads` | Default destination directory for local downloads. |
| `ARIA2_DEFAULT_PROXY` | `system` | Default proxy mode: `system`, `direct`, or `http://host:port`. |
| `ARIA2_RPC_URL` | *(unset)* | Use an external/remote aria2 JSON-RPC URL instead of spawning a local daemon. |
| `ARIA2_RPC_SECRET` | *(unset)* | RPC secret token for `ARIA2_RPC_URL`. |

## Security Model

- Loopback-only RPC (`127.0.0.1`, random free port, 256-bit random token, `rpc-allow-origin-all=false`).
- Private state directory verified via `icacls` (Windows) or `0700` (POSIX).
- Proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`) are stripped from the `aria2c` process and applied strictly per-task.
- Tool responses only return `{ gid, status, totalLength, completedLength, downloadSpeed, errorCode, progress }` — never echoing URLs, query tokens, or proxy credentials.

## Development & Tests

```bash
npm test
```

## License

[MIT](./LICENSE)
