# antigravity-acp-auth

[简体中文](./README.zh-CN.md)

Google Antigravity provider plugin using the **official `agy acp` channel** (OpenCode v1 plugin contract, compatible with **magpie** and **Astra**).

Request path:

`Client -> magpie / Astra -> plugin loader.fetch -> liftgate (/v1/responses) -> agy acp -> Google`

All ACP transport, token persistence, and TLS stay inside the official `agy` binary and local `liftgate` gateway instead of reverse-engineered private endpoints.

## Features

- **Multi-account OAuth isolation**: Browser OAuth and pasted callback URL login flows write isolated `agy` credentials under `~/.antigravity-acp/accounts/<email>/` (with `WSL_DISTRO_NAME=Ubuntu` + `--gemini-dir` on Windows to avoid overwriting the shared Windows Credential Manager entry).
- **Auto-managed `liftgate` instances**: Assigns a dedicated local port per account (starting from `8787`) and launches `liftgate` automatically on demand.
- **Accurate dual-endpoint quota (`auth.usage`)**: Queries both `daily-cloudcode-pa.googleapis.com` and `cloudcode-pa.googleapis.com` (`retrieveUserQuotaSummary` + `loadCodeAssist`), merging real usage across 5-hour / weekly windows and preserving `Gemini 4 Argon` as a separate weekly pool.
- **Live model catalog**: Fetches live models from `liftgate /v1/models` with built-in fallback models.
- **Manual gateway mode**: Also supports pointing directly to an already-running `liftgate` instance.

## Prerequisites

1. **Official Antigravity CLI (`agy`)**
   - Install `agy` and ensure it is in your default install path or `PATH` (or set `AGY_BIN=/path/to/agy`).
   - Windows PowerShell example:
     ```powershell
     irm https://antigravity.google/cli/install.ps1 | iex
     ```
2. **liftgate gateway (`acking-you/antigravity-gateway`)**
   - Build unmodified upstream [antigravity-gateway](https://github.com/acking-you/antigravity-gateway) (`cargo build --release`) and place `liftgate` in `PATH`, `~/.antigravity-acp/bin/`, `~/.cargo/bin/`, or set `LIFTGATE_BIN=/path/to/liftgate`.
   - *Windows GNU note*: Build from a pure ASCII path with MinGW-w64 `bin/` prepended to `PATH` so `ld` and `dlltool` resolve cleanly.

## Installation

```bash
# Astra
astra plugin add github:yanamianna0501/antigravity-acp-auth

# magpie
magpie plugin add github:yanamianna0501/antigravity-acp-auth
```

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `AGY_BIN` | Override path to the `agy` executable |
| `LIFTGATE_BIN` | Override path to the `liftgate` executable |

## Login & Usage

In the Astra / magpie account panel, choose one of:

1. **Browser OAuth (recommended)**: `Antigravity (ACP · Google 账号浏览器授权)` — completes Google OAuth locally, writes isolated credentials under `~/.antigravity-acp/accounts/<email>/`, and starts an account-scoped `liftgate` instance.
2. **Paste callback URL**: `Antigravity (ACP · 粘贴授权回调地址)` — useful when loopback callback ports cannot be accessed directly.
3. **Existing `liftgate` URL (advanced)**: Manually specify an already-running `liftgate` endpoint (e.g. `http://127.0.0.1:8787/v1`) and optional `accountLabel`.

Models appear under `antigravity-acp/<model-id>` (e.g. `antigravity-acp/gemini-3.8-flash-high`, `antigravity-acp/claude-opus-5-5-medium`).

## Troubleshooting

| Symptom | Resolution |
| --- | --- |
| Cannot connect to `liftgate` | Verify `liftgate` binary is discoverable (`LIFTGATE_BIN` or `PATH`) and `curl http://127.0.0.1:8787/healthz` succeeds |
| `401` / expired credentials | Re-authenticate the account in magpie / Astra (or re-run `agy acp --login` in manual mode) |
| Only fallback models appear | Check `curl http://127.0.0.1:8787/v1/models` and ensure `agy` is authenticated |

## Attribution & License

- Plugin code in this repository is licensed under the [MIT License](./LICENSE).
- This plugin bridges to upstream [acking-you/antigravity-gateway](https://github.com/acking-you/antigravity-gateway) (`liftgate`, `MIT OR Apache-2.0`) and the official `agy` CLI without bundling third-party source or binaries. See [NOTICE.md](./NOTICE.md) for details.
