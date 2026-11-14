# Cursor · Magpie Bridge for Linux

<p align="center">
  <b>English</b> | <a href="README.zh.md">中文</a>
</p>

A protocol bridge plugin specifically tailored for **Linux (x64 / arm64)** connecting **Cursor IDE** and the **Magpie** AI Gateway. It allows Cursor on Linux to seamlessly leverage all large models and intelligent routing groups configured in Magpie: model selections appear directly in Cursor's model picker, the default Cursor Auto entry is hidden, and native Cursor login and Tab autocompletion are fully preserved.

---

## 1. Why a Dedicated Linux Edition?

Original upstream (`nodlles`) and community enhanced forks are predominantly geared toward macOS and Windows, often leaving Linux environments plagued with missing native engine binaries, lack of system daemon support, or background subagents hanging indefinitely. This project provides full-stack Linux optimization:

* 🐧 **Native Linux System Daemon (`systemd --user`)**:
  Integrated seamlessly with the Linux user service manager. Runs in the background without `root` privileges, auto-starts on login, recovers automatically on failure, and centralizes logs via `journalctl`.
* 🔐 **Automated CA Certificate Trust Across Distros**:
  Automatically provisions and registers local self-signed root CAs across Debian/Ubuntu (`update-ca-certificates`), RHEL/Fedora/CentOS (`update-ca-trust`), and Arch/Manjaro (`trust extract-compat`), while configuring Cursor's local `argv.json` with `certificate-authority` for zero-friction loopback TLS interception.
* ⚡ **Multitask Subagent Background Execution**:
  Resolves the notorious issue where Cursor's concurrent background subagents get stuck in "Stopped" upon completion, leaving parent agents unwoken. Implements exact Statsig `djb2` hash alignment, listens for `BackgroundTaskCompletionAction`, writes back `Success/Error` outcomes, and automatically triggers parent agent execution resumption.
* 💾 **Lightweight In-Memory SQLite Mode**:
  Defaults to `sqlite::memory:` (multi-connection shared cache). Temporary sessions, tool calls, and checkpoints are stored entirely in RAM and freed upon exit. **Completely eliminates disk bloat (where `bridge.db` previously grew up to 2GB–5GB)**, with an environment toggle to revert to disk persistence if needed.
* 🚀 **Zero-Copy Compatibility for Cursor 3.29+ / 3.30+**:
  Supports the latest `data_binary` raw Protobuf upstream format with `Cow::Borrowed` zero-copy decoding in Rust, accompanied by exhaustive 3.29+ Protobuf field alignment to prevent 30-second "Connection stalled" timeouts.
* 🎨 **Smart Model Short-Naming**:
  Cleans verbose multi-segment model tags (e.g., `Opus · routing group · group/opus`) into concise labels (`Opus`, `Sonnet`) to prevent UI truncation in Cursor's compact menus.
* 📦 **Minimalist & Pure Linux**:
  Strips all cross-platform precompiled `.exe` binaries, Windows batch files, and macOS scripts. Only contains native Linux components and deterministic patches.

---

## 2. Architecture Overview

```text
┌─────────────────────────────────────────────────────────────┐
│ Magpie Gateway                                              │
│  Serves 127.0.0.1:3425/v1 (OpenAI-compatible & model catalog)│
└──────────────────────────┬──────────────────────────────────┘
                           │ Dynamic sync / Model proxying
┌──────────────────────────▼──────────────────────────────────┐
│ Background Daemon (bridge.js / systemd --user)              │
│  ├─ Hot-syncs Magpie model catalog every 15s → effective.json│
│  ├─ Manages lifecycle of headless engine cursor-magpie-bridge│
│  └─ Backs up & restores Cursor proxy configs                │
└──────────────────────────┬──────────────────────────────────┘
                           │ Spawns
┌──────────────────────────▼──────────────────────────────────┐
│ Native Engine (Rust + hudsucker, based on cursor-byok)      │
│  ├─ Local TLS MITM proxy (automatically sets up local CA)   │
│  ├─ Decodes Cursor Connect/Protobuf protocol (data_binary)   │
│  ├─ Multitask subagent completion & parent wake state machine│
│  └─ In-Memory SQLite mode (zero disk footprint)             │
└──────────────────────────┬──────────────────────────────────┘
                           │ Local loopback proxy
┌──────────────────────────▼──────────────────────────────────┐
│ Cursor IDE (Linux)                                          │
│  ~/.config/Cursor/User/settings.json (http.proxy)           │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Installation & Quick Start

### Prerequisites
- A Linux operating system (tested on Ubuntu, Debian, Fedora, Arch, Manjaro);
- **Cursor IDE** installed and logged in;
- **Magpie** installed, running, and configured with at least one active model or routing group.

### Option A: Zero-CLI Automatic Setup via Magpie GUI (Recommended)
1. **Install Plugin**:
   Open Magpie → Go to **Plugins** → Add repository:
   ```text
   github:Ice0828/magpie-agent-cursor-bridge-linux
   ```
   Click **Install** to add the plugin.
2. **Enable Bridge**:
   - In Magpie's **Agents** view, locate **Cursor · Magpie Bridge**, switch it **ON**, and pick your preferred model;
   - The plugin **silently and automatically handles everything**: downloads the native engine binary (with mirror acceleration and dynamic `SHA256SUMS` verification), configures local CA trust, and registers the `systemd --user` background daemon;
   - No reboot is required.
3. **Use inside Cursor**:
   - Open Cursor, click the model selector dropdown in Chat or Composer;
   - Your configured Magpie models appear automatically. Select one and enjoy coding!

---

### Option B: CLI Manual Setup for Developers (Fallback)
For offline environments, headless setups, or developer testing:
```bash
# Initialize daemon and trust certificates
./setup.sh setup

# Verify status (ready when "state": "connected")
./setup.sh status
```

---

## 4. Management & CLI Commands

`setup.sh` provides convenient lifecycle commands:

| Command | Description |
| :--- | :--- |
| `./setup.sh setup` | Installs systemd service, registers local CA cert, and starts the daemon |
| `./setup.sh status` | Checks bridge connectivity, active model, and proxy port |
| `./setup.sh start` | Starts the `systemd --user` background service |
| `./setup.sh stop` | Stops the background service |
| `./setup.sh restart` | Restarts the background service |
| `./setup.sh logs` | Tails live service logs via `journalctl` |
| `./setup.sh uninstall` | Uninstalls the systemd service and unregisters CA certificates |

Standard Linux `systemd` tools can also be used directly:
```bash
# Check service status
systemctl --user status local.magpie.cursor-bridge.service

# Follow live logs
journalctl --user -u local.magpie.cursor-bridge.service -f

# Restart or stop daemon
systemctl --user restart local.magpie.cursor-bridge.service
systemctl --user stop local.magpie.cursor-bridge.service
```

---

## 5. Environment Variables

Configure behavior in `~/.config/systemd/user/cursor-magpie-bridge.service` or your shell:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `CURSOR_BRIDGE_RUN_MODE` | `lite` | `lite` uses In-Memory SQLite (zero disk footprint); set to `default` to persist database records to `data/bridge.db`. |
| `CURSOR_BRIDGE_SUBAGENT_MODE` | `async` | `async` enables multitask subagent state machine and parent wakeups; set to `sync` to force sequential execution. |
| `CURSOR_BRIDGE_PROXY_PORT` | random available port | Pin a fixed loopback proxy port to avoid port changes across restarts. |

---

## 6. Building the Native Engine from Source

This repository maintains Rust modifications deterministically via [source.patch](source.patch):

```bash
# Pulls pinned upstream baseline, applies source.patch, and compiles release binary via Cargo
./scripts/build-native.sh
```

Upon successful compilation, the output binary is placed at `bin/cursor-magpie-bridge`, and the SHA-256 hash in [integrity.json](integrity.json) is automatically updated.

Run test suite:
```bash
npm test
```

---

## 7. Acknowledgements

This project builds upon the outstanding work of the open-source community:

1. **Native Protocol Core**: [leookun/cursor-byok](https://github.com/leookun/cursor-byok) (v1.0.1) — foundational TLS MITM interception and decoding engine.
2. **Plugin Architecture & Lifecycle**: [nodlles/magpie-agent-cursor-bridge](https://github.com/nodlles/magpie-agent-cursor-bridge) (v0.2.2) — initial Magpie Agent plugin architecture and dynamic sync channel.
3. **Enhanced Feature Ideas**: [kingchen95272025/magpie-agent-cursor-bridge-enhanced](https://github.com/kingchen95272025/magpie-agent-cursor-bridge-enhanced) — subagent completion state machine and In-Memory SQLite architecture concepts.

---

## 8. Disclaimer

This project is intended strictly for personal research and development in Linux environments regarding local loopback protocol proxying. It does not patch Cursor IDE binaries or circumvent licensing mechanisms. Users are responsible for complying with the terms of service and billing guidelines of their upstream model providers.
