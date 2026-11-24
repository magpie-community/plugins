<a href="https://opc.fish"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/YE4IM/readme/main/assets/opc-fish-project-signature-web-dark.svg"><img src="https://raw.githubusercontent.com/YE4IM/readme/main/assets/opc-fish-project-signature.svg" alt="OPC.FISH Project" width="720"></picture></a>

# magpie-ducoro

[**English**](./README.md) | [中文](./README.zh-CN.md)

Sync Magpie models, connectors, skills, instructions, and explicitly selected subagents into Ducoro, then assign them by Bot from the plugin page.

[![npm version 0.4.10](https://img.shields.io/npm/v/magpie-ducoro)](https://www.npmjs.com/package/magpie-ducoro) [![MIT license](https://img.shields.io/github/license/YE4IM/magpie-ducoro)](./LICENSE)

[Quick start](#quick-start)

```text
Usage: node diagnostics-cli.mjs [--lang en|zh] [--json] [--state-dir <directory>] [--port <port>] [--doctor] [--cli <path>]
Read-only live report. --doctor checks daemon status without changing configuration.
```

That text is the output of `npm exec --package=magpie-ducoro@0.4.10 -- magpie-ducoro-status --help`, run on 2026-11-24. The script prints this usage line even when started through the `magpie-ducoro-status` bin. It is the diagnostics help. A sync was not completed in this environment.

## Contents

- [Overview](#overview)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Features](#features)
- [Usage](#usage)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Changelog](#changelog)
- [Contributing](#contributing)
- [License](#license)

## Overview

`magpie-ducoro` 0.4.10 is a Magpie plugin. It connects Ducoro to Magpie models and syncs the Magpie resources you assign. Saves go through a preview. The plugin page listens on loopback.

> [!NOTE]
> The repository states no minimum Magpie or Ducoro version, and it states no verified Windows or Linux compatibility. Ducoro and `ducoro-cli` are installed separately. This plugin's install steps leave both of those to you.

## Requirements

- Magpie with a plugin agent and a page service. The current repository guide names `magpie.agent` and `magpie.page.service`.
- Ducoro installed and signed in, with its daemon running, and access to the local device and Bots you want to manage.
- `ducoro-cli` on the `PATH` used to start Magpie. The project points to the [CLI download](https://ducoro.ai/download/cli).

`package.json` has no `engines` field. The diagnostics command on this machine ran with Node.js v26.13.1. That is the version used for the check, and the repository does not declare it as a minimum.

## Installation

Register the plugin in Magpie. This command is the 0.4.10 step in the repository. `magpie plugin --help` on this machine lists `magpie plugin add`. The add itself was left unrun, so registration is unverified here.

```bash
magpie plugin add magpie-ducoro@0.4.10
```

You can also enter `magpie-ducoro@0.4.10` in Magpie under Plugins → Add a plugin.

`npm install magpie-ducoro` only downloads the package. It does not register the plugin with Magpie. The npm package is [`magpie-ducoro`](https://www.npmjs.com/package/magpie-ducoro).

<details>
<summary>Install from a folder or a Git tag</summary>

Download a release from [GitHub Releases](https://github.com/YE4IM/magpie-ducoro/releases), unpack it, and add that folder's absolute path in Magpie. Or add the GitHub ref `github:YE4IM/magpie-ducoro#v0.4.10`.

</details>

## Quick start

1. Open **Ducoro** from the Magpie sidebar. If the page does not load, check `ducoro-cli`, the Ducoro daemon, and the page service port (`127.0.0.1:3487` by default).
2. In **Sync settings**, check the connection slug, which resource types are enabled, and the target Bots.
3. Choose **Preview changes**, then **Preview and save**, and confirm the preview. Saving reloads the plugin host and starts a sync.
4. Open **Sync status** and read the saved, written, read-back, and session-loaded results. A successful command leaves the question of whether a running session loaded the change to that report.

Those four steps are the repository's first-use path. They were not executed here. The save button label is the current page text in `ui/index.html`. The Chinese repository README still says 保存设置, and that older string remains in the language table.

This command was executed against npm package 0.4.10 and exited 0:

```bash
npm exec --package=magpie-ducoro@0.4.10 -- magpie-ducoro-status --help
```

`magpie-ducoro-status --doctor` was also run here and exited 2. Ducoro's read-only `info` check succeeded. The report said no sync had completed, and the plugin's live diagnostics service was unreachable. The next step it printed is to enable the Ducoro plugin in Magpie, reopen the page, or check the service port.

## Features

- Assign models, Magpie library connectors, and skills globally or per Bot. An empty per-Bot list means this plugin assigns none of that type. Other global or user configuration stays in place.
- Append instructions inside a plugin-owned block, and sync only subagents you explicitly select.
- Preview additions and revocations before writing. Saving asks for confirmation.
- Track each item through saved, written, read-back, and session-load. Items without enough evidence stay unverified.
- Create a configuration checkpoint before each save, and pause automatic sync after a management-record restore until you preview and continue.
- Read a live diagnostics report from the terminal. The command writes no report file.

## Usage

From a checkout:

```bash
node diagnostics-cli.mjs
node diagnostics-cli.mjs --lang zh
node diagnostics-cli.mjs --json
node diagnostics-cli.mjs --port 3488
node diagnostics-cli.mjs --doctor
```

After the package is installed, the same entry point is `magpie-ducoro-status` with the same flags. `--doctor` only reads daemon info. It leaves configuration unchanged.

The page follows Magpie's language. Simplified and Traditional Chinese use Chinese. Other and unknown languages use English.

Stop the previous plugin host before loading another version, so two copies leave the shared management state to one writer. Compatible v1 and v2 records are kept.

Before rolling back, stop the current host and compact the journal from this package:

```bash
npm run state:compact -- /absolute/path/to/state.json
```

## Configuration

The page service listens on `127.0.0.1:3487` unless `servicePort` changes. Requests check `Host`, `Origin`, and the page token. The page receives resource names and status, and connection credentials stay off the page.

The default management file is `~/.config/magpie/ducoro-bridge/state.json`. `XDG_CONFIG_HOME` and `DUCORO_BRIDGE_STATE_DIR` change that directory. Small changes append to `state.json.journal` and compact after 128 records or 1 MiB.

| Option | Default | Meaning |
| --- | --- | --- |
| `modelScope` | `global` | `global`, or `agents` for per-Bot model assignment |
| `botModels` | `{}` | Bot ID to model ID. Omitted entries inherit |
| `mcpScope` | `global` | Global or per-Bot assignment of Magpie library connectors |
| `skillsScope` | `global` | Global or per-Bot skill assignment |
| `resourceAssignments` | `{}` | Bot ID to `mcp` and `skills` name lists |
| `accountConnectors` | `{}` | Bot ID to connector slug to `{allow, deny}` |
| `servicePort` | `3487` | Loopback page-service port |
| `connectionSlug` | `magpie-ducoro` | Plugin model connection slug |
| `modelCapabilityRefs` | `{}` | Manual model capability references |

The same defaults object also stores `botPlansCatalog`, `botPlans`, `botInstructions`, `pausedModels`, and `modelGuards`. Hooks and RTK stay out of sync.

## Documentation

- [Changelog](docs/CHANGELOG.md)
- [Release notes](docs/RELEASE-NOTES.md)

## Troubleshooting

> [!WARNING]
> Keep `state.json`. Replacing it with an empty object drops the previous permissions used when assignments are revoked.

If records are unreadable, corrupt, or an unsupported version, synchronization pauses and the original file is kept. Preview a backup under **Sync status → Troubleshooting**, then synchronize manually. Restoring a backup restores management records. Bot configuration stays as it was until a later sync. The current page tab is **Sync status**. The repository README still calls that area Sync diagnostics.

Stop every plugin host before clearing a leftover lock. Inspect ownership again and use the latest recovery token:

```bash
npm run lock:inspect -- /absolute/path/to/ducoro-bridge
npm run lock:inspect -- /absolute/path/to/ducoro-bridge TOKEN --all-hosts-stopped
```

Run the second command only after every host has stopped and you have inspected again. `TOKEN` is the recovery token from that inspect command.

If a draft lock stays in place, stop all plugin hosts, back up `page-draft.lock` and `page-draft-locks`, move them out of the state directory, and reopen the page. Keep `page-draft.json`.

## Development

`bridge.mjs` is the plugin entry. `ducoro.agent.js` is the Magpie agent definition. `diagnostics-cli.mjs` is the diagnostics command. `lib/` holds sync, state, and page-service code. `ui/` and `assets/` hold the page. `scripts/` holds the maintenance commands. `docs/` holds the changelog and release notes.

```bash
npm run diagnostics
npm run state:compact -- /absolute/path/to/state.json
npm run lock:inspect -- /absolute/path/to/ducoro-bridge
```

## Changelog

[docs/CHANGELOG.md](docs/CHANGELOG.md). Current release: [v0.4.10](https://github.com/YE4IM/magpie-ducoro/releases/tag/v0.4.10).

## Contributing

Open an issue at <https://github.com/YE4IM/magpie-ducoro/issues>.

## License

MIT. See [LICENSE](./LICENSE).
