# Smart Middleware & Agent Space Manager

**Universal Multi-IDE & Project Skill Orchestrator with Dynamic Intent-Based Tool Gateway for [Magpie](https://usemagpie.ai)**.

[English](README.md) | [简体中文](README.zh-CN.md)

---

## Core Purpose & Why This Exists

As developers adopt multiple AI coding environments (Antigravity, Cursor, Windsurf, Claude Code, OpenCode, VS Code Copilot), skills, rules, and MCP servers become fractured across different IDE-specific directories. Managing, updating, and syncing these tools across dozens of project repositories and tools quickly becomes unmaintainable.

**Agent Space Manager solves this by acting as a single, centralized control plane for your entire AI development ecosystem:**

1. **Single Source of Truth (Central Hub)**: Store all your plugins, skills, MCP configs, hooks, agents, and rules in one centralized directory (the Components Storage Path / Hub Root). No duplicate installations across different IDE folders.
2. **Dynamic Cross-IDE Distribution**: Automatically establishes non-destructive OS directory links (NTFS junctions on Windows, symlinks on macOS/Linux) directly into each IDE's native discovery path (e.g., `~/.gemini/config/plugins`, `~/.cursor/skills`, `~/.claude/skills`).
3. **Instant IDE Sync & Auto-Unlinking**:
   - Switching the storage path immediately repoints all connected IDEs to the new location.
   - Setting a path with 0 components automatically severs all links, cleanly removing them from connected IDEs.
   - Deactivating a component unlinks it instantly without deleting the original source code.
4. **Granular Project & Workspace Overrides**: Enable only the skills and MCP servers relevant to a specific repository while maintaining clean global defaults for everything else.
5. **Smart Middleware Tool Gateway**: Prevents LLM context blowout and API `400` errors (such as exceeding model-specific limits like 128 tools in Claude/GPT models) by dynamically prioritizing and filtering active tool schemas per turn.

---

## Key Capabilities

- **Zero-Hardcoded Multi-Platform Support**: Works seamlessly across Windows, macOS, and Linux without hardcoding user home paths or drive letters.
- **Dynamic Configuration Link Discovery**: Automatically inspects filesystem probes, environment variables (`$AGENT_TOOLS_ROOT`, `$AI_WORKSPACE_DIR`), and IDE CLI tools (`opencode debug paths`, etc.) to accurately detect plugin and skill link directories.
- **Granular Multi-IDE & Project Control**: Toggle skills, MCP servers, and rules on or off per IDE and per project repository. Unregistered projects automatically inherit global platform defaults.
- **Safe Junction Lifecycle**: Linking creates safe NTFS directory junctions / symlinks; removing an IDE or project cleanly severs links without touching source plugins in `plugins/`.
- **Gateway Model Limit Protection**: Dynamically optimizes tool schemas per conversation turn (default: 96 max) to prevent API 400 errors from exceeding model tool limits (such as the 128 tools limit in GPT-4 / GPT-5 / Claude), with a 1-click toggle directly in the UI.

---

## Architecture & Data Flow

```text
[ Magpie Host (Bun / WebView2) ]
        │
        ├── IPC: globalThis.magpie.api (getPlugins, saveConfig, etc.)
        └── HTTP / REST Fallback: http://127.0.0.1:41789/api/* (server.mjs)
                    │
                    ▼
        [ manager.mjs Engine ]
        ├── scanPlugins(hubRoot)
        ├── buildCategoriesRegistry(plugins, hubRoot)
        └── syncIdePlugins(ide, allPlugins) ──> Creates/Removes Junctions
```

1. **Host Entrypoint (`index.mjs`)**: Mounts the plugin into Magpie runtime and exposes the IPC API methods. Also starts `server.mjs`.
2. **Core Engine (`manager.mjs`)**:
   - `scanPlugins(hubRoot)`: Scans for plugins under `<hubRoot>/plugins` or directly in `<hubRoot>` if plugin folders are at root.
   - `syncIdePlugins(ide, allPlugins)`: Compares existing junction points in `ide.configPath` with active plugin list. Removes obsolete/disabled junctions and links active ones.
3. **Web UI (`page/index.html`, `page/app.js`, `page/style.css`)**:
   - Running in WebView2, queries `apiClient.getPlugins(targetPath)`.
   - Renders IDE list, Project overrides, Plugin tables, and Discovered Components category browser.
   - Debounced auto-save & sync on any path/toggle change (`triggerAutoSync()` -> `persistConfig()`).

---

## Supported IDEs & Multi-Agent Native Adapter Matrix

Unlike Antigravity (which natively reads `plugins/<plugin>/plugin.json` bundles), most major AI coding agents cannot read raw plugin bundle folders directly and expect individual `<skill>/SKILL.md` directories, native JSON/TOML MCP server configurations, and Markdown rule blocks.

**Agent Space Manager v1.2+ includes 13 built-in Agent Profiles (`agents.mjs` & `adapters.mjs`) that automatically distribute components in each agent's native format:**

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
| **Custom (`custom`)** | `convert` | `<custom-dir>/<skill>` | — | — | — |

---

## Non-Destructive Ownership Manifest & Backup Guarantee

- **Ownership State Tracking (`~/.agent-space-manager/state/<id>.json`)**: Tracks every junction, copied file, JSON key, and Markdown/TOML block created by Agent Space Manager.
- **Zero Collateral Deletion**:
  - `createJunction` refuses to delete any real, user-owned directory or file at a link path.
  - `syncIdePlugins` only prunes junctions, MCP keys, and rule blocks that are recorded in its ownership manifest (or legacy junctions pointing inside the Hub), leaving user-created symlinks and hand-crafted MCP servers untouched.
  - Before modifying any existing user configuration file (`~/.claude.json`, `~/.codex/config.toml`, `opencode.json`, `mcp.json`, `CLAUDE.md`, `AGENTS.md`), a `.asm-bak` backup is created automatically.
- **Granular Project Repository Overrides**: Project overrides sync directly into the repository's native agent folder (e.g., `<repo>/.claude/skills`, `<repo>/.cursor/skills`, `<repo>/.agents/skills`) and automatically append managed paths to `<repo>/.git/info/exclude` so links are never accidentally committed.

---

## Automated Test Suite

Run the full sandboxed test suite (22 tests across 10 suites covering every feature in an isolated temp `HOME`):

```bash
npm test
npm run test:report
```

---

## Standard Plugin Format

All components inside your Hub root adhere to the standardized self-contained plugin specification:

```text
plugins/<plugin-name>/
├── plugin.json       # Required manifest (name, version, description)
├── mcp_config.json   # Optional MCP server definitions
├── hooks.json        # Optional hooks definition
├── skills/           # Optional skills (<skill-name>/SKILL.md)
├── agents/           # Optional subagent templates (<agent-name>.md)
└── rules/            # Optional prompt rules (<rule-name>.md)
```

---

## Support & Sponsorship

If you find Agent Space Manager valuable for your workflow, you can support development via:
- [Wise - Terence Ooi Teng Wei @terenceooit](https://wise.com/pay/me/terenceooit)

---

## License

MIT © Terence Ooi
