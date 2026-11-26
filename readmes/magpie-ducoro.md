<p align="center">
<a href="https://opc.fish" title="OPC.FISH Project."><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/YE4IM/readme/main/project/assets/opc-fish-project-signature-web-dark.svg"><img src="https://raw.githubusercontent.com/YE4IM/readme/main/project/assets/opc-fish-project-signature.svg" alt="OPC.FISH Project" width="720"></picture></a>
</p>

# magpie-ducoro

[**English**](./README.md) | [中文](./README-zh-CN.md)

Configure Ducoro Bots in Magpie to follow the default model or use their own model, connectors, skills, and instructions.

[![GitHub release](https://img.shields.io/github/v/release/YE4IM/magpie-ducoro)](https://github.com/YE4IM/magpie-ducoro/releases/latest) [![MIT license](https://img.shields.io/github/license/YE4IM/magpie-ducoro)](./LICENSE)

[Quick start](#quick-start)

<img src="./assets/ducoro-plugin.png" alt="Ducoro plugin Sync settings showing the switches for the gateway connection, Bot models, connectors, skills, and instructions" width="720">

*Ducoro’s Sync settings with example data.*

[Installation](#installation) · [Usage](#usage) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting) · [Changelog](#changelog)

## Overview

Manage synchronization from the Ducoro plugin page in Magpie. Review assignments and removals before saving, then check what Ducoro wrote, read back, and loaded into a session.

## Requirements

- Magpie with support for plugin agents and page services (`magpie.agent` and `magpie.page.service`). [Magpie](https://usemagpie.ai)
- Ducoro installed and signed in, with its background service running and access to the local device and Bots you want to manage. [Ducoro](https://ducoro.ai)
- `ducoro-cli` on the `PATH` used to launch Magpie. [Download the Ducoro CLI](https://ducoro.ai/download/cli)

## Installation

In Magpie, open **Plugins → Add a plugin** and enter `github:YE4IM/magpie-ducoro#v0.4.11`, or use the Magpie CLI.

```bash
magpie plugin add github:YE4IM/magpie-ducoro#v0.4.11
```

You can also download a source archive, extract it, and register the extracted folder by absolute path. [GitHub Release](https://github.com/YE4IM/magpie-ducoro/releases/tag/v0.4.11)

## Quick start

1. In Magpie, connect **Ducoro** from the **Agent** page and select a model. Then open **Ducoro** in the sidebar.
2. Open **Sync settings** and review the connection slug, enabled resource types, and target Bots. Use **Bot resources** for individual assignments.
3. Select **Preview changes** to review additions and removal reasons. The preview also flags first-time gateway connection creation. Select **Preview and save** and confirm to save the settings and start synchronization.
4. Open **Sync status** to check writes and read-back. To confirm that Ducoro loaded the new settings, start a new session with a target Bot and check its session load status.

> [!NOTE]
> The diagnostics command was verified during this update. The plugin’s live diagnostics service was unavailable in this environment, so installation, first sync, and session loading remain unverified.

## Usage

- **Models** can follow Magpie's default or be assigned per Bot. The plugin matches model capabilities against Ducoro's catalog, with manual overrides available.
- **Connectors and skills** can be assigned globally or per Bot. An empty per-Bot list clears this plugin's assignments for that resource type, while resources from other sources stay available. For Ducoro account connectors, connect the service in Ducoro first and select the allowed tools for each Bot.
- **Instructions and subagents** sync to the selected targets. Instructions are written to a plugin-managed block. Subagents require explicit selection.
- **Plans** share model, connector, skill, and instruction settings across Bots. Individual overrides take precedence over inherited values.
- **Find Bots by resource** shows which Bots receive a skill or library connector, where the assignment comes from, and the most recent verification.
- **Compare two Bots** shows differences in model routes, resource assignments, account tool permissions, and verification. Open the corresponding settings from each result.
- **Plan trials** start from **Try with one Bot** in the save preview for a shared plan. After saving, the selected Bot receives the trial plan and the other Bots keep the current plan. Use **Plan trial** to verify the Bot, roll out the changes, or restore the original plan. Start a new session in Ducoro to confirm loading.
- **Backup and restore** provides management-record backups and configuration checkpoints. After restoring management records, select **Preview impact and resume sync** to review the changes and resume synchronization.

From the extracted source folder, run a read-only diagnostic. The `--doctor` flag checks the Ducoro background service. Use `--lang zh` for Chinese or `--json` for structured output.

```bash
node diagnostics-cli.mjs --doctor
```

The plugin page follows Magpie's language. Simplified and Traditional Chinese use Chinese. Other languages use English.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `connectionSlug` | `magpie-ducoro` | ID of the Ducoro model connection |
| `servicePort` | `3487` | Page-service port on `127.0.0.1` |
| `modelScope`, `mcpScope`, `skillsScope` | `global` | Use `agents` for per-Bot assignments |
| `targetAgents` | `[]` | Restrict model, instruction, subagent, and per-Bot library resource sync to selected Bots |
| `botModels` | `{}` | Model selections by Bot ID |
| `resourceAssignments` | `{}` | Library connector and skill selections by Bot ID |
| `accountConnectors` | `{}` | Allowed and denied account connector tools by Bot ID and connector slug |
| `modelCapabilityRefs` | `{}` | Manual references to model capabilities |
| `subagentNames` | `[]` | Explicitly selected subagents |

Management records default to `~/.config/magpie/ducoro-bridge/state.json`. The plugin uses `DUCORO_BRIDGE_STATE_DIR` when set, or the `magpie/ducoro-bridge` subdirectory of `XDG_CONFIG_HOME` when available.

## Troubleshooting

- **The page fails to load.** Check that Magpie can find `ducoro-cli`, the Ducoro service is running, and the configured `servicePort` is available.
- **Sync pauses because management records are unreadable.** Keep the original `state.json` and its journal. Open **Backup and restore**, review a valid backup, and use the resume review after restoring.
- **A sync lock remains after shutdown.** Stop all plugin hosts, then run the inspection command from a checkout. The command reports the lock owner and any available recovery instructions.

```bash
npm run lock:inspect -- /absolute/path/to/ducoro-bridge
```

Before switching versions, stop the current plugin host. If you are downgrading, merge the journal into the snapshot from the current version's directory before loading the older version.

```bash
npm run state:compact -- /absolute/path/to/state.json
```

## Changelog

[Version history and release notes](./docs/CHANGELOG.md) · [Latest release notes](./docs/RELEASE-NOTES.md) · [GitHub Releases](https://github.com/YE4IM/magpie-ducoro/releases)

## License

MIT. See [LICENSE](./LICENSE).
