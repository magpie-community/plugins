# Smart Middleware & Agent Space Manager

**Universal Multi-IDE & Multi-Agent Component Orchestrator with Dynamic Intent-Based Tool Gateway for [Magpie](https://usemagpie.ai).**

[English](README.md) | [简体中文](README.zh-CN.md)

---

## Core Purpose & Design Philosophy

Agent Space Manager is a centralized control plane that **universally manages every type of AI component in one single folder**—**Plugins, MCP Servers, Hooks, Skills, Subagents, and Rules**—and lets you **connect any AI coding agent or project repository** so enabled components become immediately usable **without duplicating files into each agent's default configuration directory**.

As developers work across multiple AI environments (Antigravity, Claude Code, Codex CLI, OpenCode, VS Code Copilot, Cursor, Windsurf, Gemini CLI, Cline, Roo Code, Kiro), component files normally get copied and fragmented across dozens of agent-specific folders. Agent Space Manager eliminates that duplication:

1. **One Unified Storage Folder (Single Source of Truth)**: Store all plugins, MCP configs, hooks, skills, subagent templates, and rules in a single **Components Storage Path** (Hub Root, defaulting to `~/AI-Agent-Space`).
2. **Zero File Duplication to Agent Default Config**: Connected agents receive **non-destructive OS links** (NTFS directory junctions on Windows, symlinks on macOS/Linux) pointing back to your central storage folder—never full redundant copies of your component repositories. Where a runtime requires native file adaptation (such as Go `os.ReadDir` on Windows for Antigravity, or single-file JSON/TOML/Markdown configs for MCPs and rules), Agent Space Manager materializes lightweight `.asm-owned.json`-tracked wrappers with child junctions and isolated config blocks.
3. **Toggle & Use Immediately**: Enable or disable any component per connected agent (Global) or per project repository (Override). Enabled components are linked into the agent's native discovery path and become immediately usable via hot-reload; disabled components are cleanly unlinked without touching the original source files.

---

## Detailed Feature Breakdown

### 1. Centralized Components Storage & Universal Discovery
- **Universal Path Resolution (`Components Storage Path`)**: Point to any directory—whether a full multi-plugin hub (`<hub>/plugins/<name>`), a standalone skills folder, a single plugin directory, or leave blank to use the default Hub (`~/AI-Agent-Space`). Handles quoted paths and trailing slashes automatically.
- **Expandable Discovered Components Registry**: Click **Expand Components List** to browse every discovered asset across **7 filter tabs** (`All`, `Plugins`, `MCPs`, `Hooks`, `Skills`, `Agents`, `Rules`) with instant keyword search by name, skill, MCP, or file path.
- **Live Metrics Tiles**: Displays real-time counts for all 6 component types (`Plugins`, `MCPs`, `Hooks`, `Skills`, `Agents`, `Rules`), plus counts of **Connected IDEs** and **Registered Projects**.

### 2. Multi-Agent Connection, Auto-Detection & Native Format Adaptation
Agent Space Manager includes **13 built-in Agent Profiles** (`agents.mjs` & `adapters.mjs`) plus **Custom Agent** support:
- **Auto-Detect Configuration Link Directory**: Toggleable **Auto-detect** probes the filesystem, executable/shortcut (`.exe` / `.lnk`), environment variables (`$AGENT_TOOLS_ROOT`, `$AI_WORKSPACE_DIR`), and IDE CLI tools (e.g., `opencode debug paths`) to locate each agent's native config directory.
- **Custom Component Target Path Overrides**: Expand **Component Target Paths** in the Add/Edit IDE modal to customize destination paths per component type:
  - Bundle Path (Antigravity Plugins)
  - Skills Directory
  - Slash Commands Directory (`/` quick actions)
  - MCP Configuration File
  - Rules File or Folder
  - Subagents Directory (`@` mentions)
  - Hooks Configuration File
- **Cross-Agent Native Format Conversion**: Automatically adapts components to each agent's required schema without manual editing:
  - **MCP Schemas**: Normalizes root keys (`mcpServers` for Claude/Cursor/Windsurf/Gemini/Cline/Roo/Kiro, `servers` for VS Code Copilot, `mcp` with `type: "local" | "remote"` and `environment` for OpenCode, and `[mcp_servers.*]` TOML tables for Codex CLI).
  - **Rule Normalization**: Injects valid YAML frontmatter (`trigger: always_on` for Antigravity Cortex, `.mdc` for Cursor) or isolated delimiter blocks (`<!-- agent-space-manager:start -->` / `# >>> agent-space-manager`) into monolithic rule files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `global_rules.md`).
  - **OpenCode Subagent Schema**: Automatically ensures `mode: subagent` in `.opencode/agents/*.md` frontmatter.

### 3. Per-Agent & Per-Project Toggle Matrix & Live Status
- **Connected IDEs & Project Repositories**:
  - Drag and drop to reorder Connected IDEs (the 1st IDE acts as the default storage fallback) and Project Repositories.
  - **Clone / Fork Project**: Duplicate a project entry's configuration to quickly associate the same repository with another IDE.
  - **Project-Level Overrides**: Register repositories to override global defaults; unregistered projects inherit global IDE settings. Bridged paths inside a repository are automatically added to `<repo>/.git/info/exclude` so links are never committed to Git.
- **Components & Plugins Matrix**:
  - Toggle **Active** switches per target agent or project, expand individual or all file trees (**Expand All Files**), **Rescan Hub**, and **Connect** to synchronize.
  - **Hub Rescan & Live Linking Progress Modal**: Shows step-by-step progress and per-IDE/per-repository linking status cards.
  - **Workability Status Dots (`● Agent Status`) & Quick Actions**: Verifies on-disk physical readiness (`🟢` workable / `🔴` connection failed) and auto-detects available slash commands (`/`) and `@` mentions for enabled components, backed by a **Status Checking Progress Modal** that can also run in the background.

### 4. Foreign Components Detection & Cleanup
- **Unmanaged Component Scanner**: Detects pre-existing or external ("foreign") components inside a connected agent's default config directory that did not originate from your Components Storage Path (`/api/agent/scan-foreign`).
- **Interactive Cleanup Modal**: Lists detected foreign components and lets you choose **Cancel / Keep Existing** or **Delete Foreign Components** (`/api/agent/clean-foreign`) to keep connected agents strictly synchronized with your central Hub.

### 5. Startup Snapshot Fingerprinting & Auto-Reconnect
- **SHA-256 Storage Fingerprinting**: Computes a deterministic canonical snapshot of your Components Storage directory (`getComponentsStorageSnapshot`).
- **Auto-Reconnect on External Changes**: On startup, if files were added, edited, or removed externally in Components Storage, Agent Space Manager automatically re-synchronizes configured agents and displays a dismissible **Auto-reconnected Connected Agents** banner.

### 6. Centralized Weekly Upstream Checking & Storage Rules Prompt
- **Centralized Monday Update Check**: Checks upstream repository links for all stored components once per week on Monday startup (`/api/central-update-check`), and automatically prunes legacy decentralized update scripts (`update_checker.mjs`, `update_check_state.json`).
- **Copy Prompt (`V1.5`)**: One-click button in the **Storage & Upstream Rules** tile that copies standardized instructions for your AI agent to enforce the Hub layout, record mandatory `upstream` URLs, perform complete plugin removal cleanup (including trimming Smart Middleware intents), save manifests in strict UTF-8 without BOM, respect one-time rearrangement stability, preserve the `shared/` cross-agent IPC/handoff directory, and maintain dynamic Smart Middleware intent keywords in `shared/middleware-intents.json` (auto-seeded on initial run from existing components).

### 7. Smart Middleware Tool Gateway & OmniRoute Integration
- **Dynamic Intent-Based Tool Filtering (`smart-tools.middleware.js`)**:
  - Hooks into Magpie's `onRequest` / `onResponse` lifecycle to prevent LLM context bloat and API `400` errors caused by exceeding model tool limits (e.g., 128 tools in Claude/GPT models).
  - Always preserves core file, shell, and web tools, scores remaining tools against the user's recent messages, and caps the forwarded tool list.
  - **UI Controls**: Toggle **Smart Middleware: Active / Bypassed** in the top bar and adjust **Gateway Tool Optimization** cap (`10–256`, default `96` with one-click **Default** reset).
  - **Failure Diagnostics**: Records middleware errors to `error.log`, `LAST_ERROR.json`, and `STATUS.md`.
- **OmniRoute AI Gateway Capsule**: Top-bar widget displaying the OmniRoute port (`20128`, click to copy), live health status dot (Green/Red/Gray), and backend lifecycle endpoints (`/api/omniroute/status`, `start`, `stop`, `open`).

### 8. Non-Destructive Ownership & Safety Guarantees
- **Ownership Manifests (`.asm-owned.json` & `~/.agent-space-manager/state/<id>.json`)**: Every link, materialized wrapper, JSON key, and delimited block created by Agent Space Manager is explicitly tracked. Unlinking or disabling only removes ASM-owned items—user-created files, foreign symlinks, and manual MCP servers are never deleted without consent.
- **Automatic `.asm-bak` Backups**: Before modifying any existing user configuration file (`~/.claude.json`, `~/.codex/config.toml`, `opencode.json`, `mcp.json`, `CLAUDE.md`, `AGENTS.md`), an atomic `.asm-bak` backup is created once and preserved.
- **Config Sanitization**: Automatically prunes 0-byte JSON files and empty `{}` stubs lacking `"id"` fields to prevent IDE Language Server crash loops.
- **GUI Editor Process Protection & WebView2 Safety**: Never force-kills running GUI editors (`antigravity.exe`, `cursor.exe`, `windsurf.exe`, `code.exe`, `opencode.exe`), relying on disk hot-reload; uses non-blocking two-step inline confirmations in the UI instead of `window.confirm`/`alert`/`prompt`.

---

## Supported IDEs & Multi-Agent Native Adapter Matrix

| Agent Profile (`agentType`) | Mode | Skills Target | MCP Servers Target | Rules / Instructions Target | Subagents Target |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Antigravity (`antigravity`)** | `bundle` | `~/.gemini/config/plugins/<id>` | Inside bundle (`mcp_config.json`) | Inside bundle (`rules/*.md`) | Inside bundle (`agents/*.md`) |
| **Claude Code (`claude-code`)** | `convert` | `~/.claude/skills/<skill>` | `~/.claude.json` (`mcpServers`) | `~/.claude/CLAUDE.md` (`@path` block) | `~/.claude/agents/*.md` |
| **Codex CLI (`codex`)** | `convert` | `~/.codex/skills/<skill>` | `~/.codex/config.toml` (`[mcp_servers.*]`) | `~/.codex/AGENTS.md` (managed block) | — |
| **OpenCode (`opencode`)** | `convert` | `~/.config/opencode/skills/<skill>` | `~/.config/opencode/opencode.json` (`mcp`) | `~/.config/opencode/AGENTS.md` | `~/.config/opencode/agents/*.md` |
| **VS Code / Copilot (`vscode-copilot`)** | `convert` | `~/.copilot/skills/<skill>` | `<AppData>/Code/User/mcp.json` (`servers`) | `Code/User/prompts/*.instructions.md` | `Code/User/prompts/*.agent.md` |
| **Cursor AI (`cursor`)** | `convert` | `~/.cursor/skills/<skill>` | `~/.cursor/mcp.json` (`mcpServers`) | Workspace `.cursor/rules` | — |
| **Windsurf (`windsurf`)** | `convert` | `~/.codeium/windsurf/skills/<skill>` | `~/.codeium/windsurf/mcp_config.json` | `~/.codeium/windsurf/memories/global_rules.md` | — |
| **Gemini CLI (`gemini-cli`)** | `convert` | `~/.gemini/skills/<skill>` | `~/.gemini/settings.json` (`mcpServers`) | `~/.gemini/GEMINI.md` | — |
| **Cline (`cline`)** | `convert` | `~/.cline/skills/<skill>` | `globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | `~/Documents/Cline/Rules/*.md` | — |
| **Roo Code (`roo-code`)** | `convert` | `~/.roo/skills/<skill>` | `globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` | `~/.roo/rules/*.md` | — |
| **Kiro (`kiro`)** | `convert` | `~/.kiro/skills/<skill>` | `~/.kiro/settings/mcp.json` | `~/.kiro/steering/*.md` | — |
| **Universal (`agents-universal`)** | `convert` | `~/.agents/skills/<skill>` | — | — | — |
| **Custom (`custom`)** | `convert` | `<custom-dir>/<skill>` | Optional custom overrides | Optional custom overrides | Optional custom overrides |

---

## Architecture & Standard Storage Layout

```text
[ Magpie Host (Bun / WebView2) ]
        │
        ├── IPC: globalThis.magpie.api (getPlugins, saveConfig, connectAgent, etc.)
        └── HTTP / REST API: http://127.0.0.1:41789/api/* (server.mjs)
                    │
                    ▼
        [ manager.mjs + adapters.mjs + agents.mjs ]
        ├── scanPlugins(hubRoot) & buildCategoriesRegistry()
        ├── Smart Middleware (smart-tools.middleware.js: onRequest / onResponse)
        └── connectAgent / syncAllIdes ──> OS Junctions/Symlinks & Native Config Blocks
```

Standard Components Storage layout:

```text
<Components Storage Path>/
├── plugins/<plugin-name>/
│   ├── plugin.json       # Required manifest (name, version, description, upstream)
│   ├── mcp_config.json   # Optional MCP server definitions
│   ├── hooks.json        # Optional hooks definition
│   ├── skills/           # Optional skills (<skill-name>/SKILL.md)
│   ├── agents/           # Optional subagent templates (<agent-name>.md)
│   └── rules/            # Optional prompt rules (<rule-name>.md)
├── skills/               # Optional standalone skills
├── shared/               # Cross-agent IPC, handoff/, _upstream_backups/, shared tooling
├── hub-config.json       # Hub configuration
├── plugins.json          # Discovered plugins index
└── skills.json           # Discovered skills index
```

---

## Automated Test Suite

Run the sandboxed test suite (runs in an isolated temp `HOME` with `ASM_TEST=1` / `NODE_ENV=test`):

```bash
npm test
npm run test:report
npm run test:universal
```

---

## Support & Sponsorship

If you find Agent Space Manager valuable for your workflow, you can support development via:
- [Wise - Terence Ooi Teng Wei @terenceooit](https://wise.com/pay/me/terenceooit)

---

## License

MIT © Terence Ooi
