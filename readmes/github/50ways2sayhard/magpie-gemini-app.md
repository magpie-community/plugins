# magpie-gemini-app (`opencode-gemini-app-auth`)

Native Google Gemini App Provider Plugin for Magpie & OpenCode / 原生 HTTP/2 直连 Google Gemini App 的 Magpie 插件。

Zero-dependency OpenCode v1 & Magpie provider plugin connecting directly to Google Gemini App over native HTTP/2 (`RobinService/ProcessQuery`).

> **Disclaimer**: Unofficial interoperability software. Not affiliated with, endorsed by, or sponsored by Google. You must authenticate personally with your own eligible Google account. See [DISCLAIMER.md](DISCLAIMER.md).

## Upstream Source & Attribution / 来源仓库与致谢

This repository is a native Magpie / OpenCode v1 plugin adaptation built directly on top of **[ShawTim/gemini-app2api](https://github.com/ShawTim/gemini-app2api)** by `shawtim` (MIT License), synced from commit [`d3954f2`](https://github.com/ShawTim/gemini-app2api/commit/d3954f270a15cc7da46b8000f3fcebd87b1fe7ae) (`v1.5.1`).

- **From `ShawTim/gemini-app2api` (`core/`, `LICENSE`, `DISCLAIMER.md`)**: Native HTTP/2 `RobinService/ProcessQuery` transport, protobuf codec, OAuth 2.0 loopback defaults, caller-validated tool protocol, OpenAI contract & usage accounting, structured output handling, image upload/download, and official quota/subscription decoding (`GetUsageInfo`). Synced via `scripts/sync-core.mjs`.
- **Added for Magpie / OpenCode (`index.mjs`, `lib/`, `test/`)**: Zero-runtime-dependency OpenCode v1 & Magpie provider entrypoint, Magpie `auth.usage` / `auth.refresh` / `provider.models` hooks, dynamic `node:http2` proxy-aware transport, multi-account Google email/`uid` identity lookup, configurable `cloak_sheet` workaround for the upstream standalone-`sheet` hang, and offline Bun unit tests.

## Features

- **Direct Native HTTP/2 (`node:http2`)**: No external runtime dependencies, no headless browser, and no local sidecar proxy process. Automatically honors Magpie's per-account and global proxy settings via dynamic `http2.connect`.
- **Official Quota & Subscription Integration (`auth.usage`)**: Reads `GetUsageInfo` to display your Gemini subscription tier (`Free`, `AI Plus`, `AI Pro`, `AI Ultra`, `Ultra/Neon`), 5-hour rolling window, and weekly limit in `magpie quota` and the Magpie UI—enabling quota-aware routing and failover.
- **Multi-Account Identity & Auto-Refresh (`auth.refresh`)**: Fetches verified Google email (`accountId`) and `uid` for multi-account management and automatic token renewal.
- **Models & Tier Filtering (`provider.models`)**: Exposes all supported Gemini App models for paid subscriptions and automatically restricts `Free` accounts to `gemini-auto`.
- **Full Tool Calling, Structured Outputs, Images, and Thinking**: Supports caller-validated tool execution, `response_format` JSON Schema, PNG/JPEG/WebP image inputs, and `minimal`–`xhigh` reasoning effort.
- **Built-in `cloak_sheet` Option**: Automatically inserts a zero-width space into standalone `sheet` words in prompts and tool descriptions (enabled by default; toggleable in Magpie plugin options) to work around a Google `ProcessQuery` upstream hang without modifying tool names or parameter keys.

## Models

| Model ID | Name | Context | Max Output | Account Tier | Capabilities |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `gemini-neon` | Gemini Neon | `512,000` | `16,384` | Paid (`AI Plus` / `AI Pro` / `AI Ultra` / `Ultra/Neon`) | Text, Image, Tools, Reasoning (`minimal`–`xhigh`) |
| `gemini-hydrogen` | Gemini Hydrogen | `512,000` | `16,384` | Paid (`AI Plus` / `AI Pro` / `AI Ultra` / `Ultra/Neon`) | Text, Image, Tools, Reasoning (`minimal`–`xhigh`) |
| `gemini-flash-lite` | Gemini Flash Lite | `128,000` | `8,192` | Paid (`AI Plus` / `AI Pro` / `AI Ultra` / `Ultra/Neon`) | Text, Image, Tools, Reasoning (`minimal`–`xhigh`) |
| `gemini-auto` | Gemini Auto | `128,000` | `8,192` | All (`Free` & Paid) | Text, Image, Tools |

Free accounts are automatically filtered to `gemini-auto` by the `provider.models` hook.

## Authentication & Privacy

- **Sign-in target**: Authenticates with Google Gemini App (`gemini.google.com` / `robinfrontend-pa.googleapis.com`) using Google OAuth 2.0 loopback (`magpie plugin login gemini-app`). Supports both automatic localhost callback in a browser and manual redirect-URL paste for SSH/headless environments.
- **Where credentials are stored**: OAuth tokens and resolved Google account identity (`accountId`, `uid`) are stored exclusively by Magpie in its own `plugin-auth.json` inside Magpie's config directory. Nothing is stored inside this plugin directory, and requests are sent only to Google's OAuth and Gemini App endpoints (respecting any proxy configured in Magpie).

## Installation

### Magpie

```bash
# Add from GitHub
magpie plugin add github:50ways2sayhard/magpie-gemini-app

# Or add from a local clone
magpie plugin add /path/to/magpie-gemini-app

# Sign in with Google (browser loopback or paste redirect URL for SSH/headless)
magpie plugin login gemini-app

# View official quota windows
magpie quota gemini-app

# Test connection
magpie provider test gemini-app gemini-hydrogen
```

Then assign any model to an agent, e.g.:

```bash
magpie pi gemini-app/gemini-hydrogen
magpie claude gemini-app/gemini-neon
magpie codex gemini-app/gemini-hydrogen
```

## Development & Tests

```bash
# Re-sync shared core modules from ../gemini-app2api
npm run sync-core

# Run offline unit tests
bun test test/
```

## License

MIT License — copyright notice retained from upstream [`ShawTim/gemini-app2api`](https://github.com/ShawTim/gemini-app2api). See [LICENSE](LICENSE).
