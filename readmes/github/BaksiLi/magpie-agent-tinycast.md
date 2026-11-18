<p align="center"><img src="brand/icon.svg" width="72" alt="Tinycast lightning icon"></p>
<h1 align="center">Tinycast for Magpie</h1>
<p align="center">Your Magpie models, inside Tinycast. No API key. No Keychain password.</p>

A community agent plugin for [Magpie](https://usemagpie.ai/) and [Tinycast](https://github.com/abue-ammar/tinycast). It adds a Tinycast switch on Magpie’s Agents page, synchronizes the available models, and keeps a connection-status panel below the agents list. Pending changes appear in yellow until Tinycast fully exits.

## Install

Requires macOS 13 or newer, Tinycast, and Magpie with agent-plugin and page-service support. Validated with Magpie 0.1.4097 and Tinycast 0.12.15 on Apple silicon. The included helper is a universal arm64/x86_64 binary; Intel execution has not been tested.

```sh
magpie plugin add github:BaksiLi/magpie-agent-tinycast
```

1. Open **Agents → Tinycast** in Magpie and turn it on.
2. **Quit Tinycast from its menu-bar icon**, wait a few seconds, then reopen it. Tinycast’s ⌘Q closes the window without quitting the app.
3. In Tinycast’s AI Chat model picker, choose a model under **Magpie**. Existing default-model choices are preserved.

The status panel updates every three seconds. Yellow means Tinycast still needs to exit; green means settings are saved or the app is connected. This uses Magpie’s supported Agents panel slot, below the list. Agent plugins currently cannot set the built-in GPT row’s restart marker.

## Connection and privacy

Tinycast uses Magpie’s local OpenAI-compatible endpoint, such as `http://127.0.0.1:3425/agent/tinycast/v1`. Magpie accepts unauthenticated loopback requests; the agent path attributes requests to Tinycast. The plugin does not read, store, or change Keychain credentials. Remote gateways are refused; configure authenticated remote providers in Tinycast itself.

A small native helper writes Tinycast’s `aiConnections` preference through CFPreferences only while Tinycast is closed. It adds one managed **Magpie** connection and preserves other providers and settings. Model IDs, vision support, output limits, and reasoning levels are synchronized. Selecting a default model remains your choice.

The plugin keeps control, recovery, and status files in `~/.config/magpie-tinycast/`, with directory mode 0700 and file mode 0600. Recovery records contain connection metadata and the previous default selection, never API keys. No chat history is read. If the managed connection is edited manually, the bridge stops and preserves recovery information instead of overwriting it.

The read-only status server binds to `127.0.0.1:3497`, displays only a known status and model count, and has no write routes or external resources. If another program uses that port, change the plugin’s `port` option. The embedded Agents panel is intended for the local Magpie desktop app.

## Tinycast settings

| Setting | With Magpie |
| --- | --- |
| Web search | Leave off. Tinycast currently exposes it for Codex and OpenRouter, not generic OpenAI-compatible connections. |
| Suggested replies | Optional. These are requested through normal prompt text. With **Send a system prompt** off, normal chats skip the suggestion instruction too. |
| Expand thinking | Display preference; compatible. |
| Tool call rounds | Keep the normal limit, such as 25. Applies when Tinycast uses tools/MCP. |
| Send a system prompt | Optional and compatible. Turning it off skips Tinycast’s preamble and custom system prompt; preset instructions can still apply. |
| Conversation settings | Local history and window preferences; independent of Magpie. |

## Disconnect or uninstall

Turn **Agents → Tinycast** off first, then fully quit Tinycast. The bridge removes its managed connection and restores the previous default only if that default still points at the managed connection. Other providers and later default choices are retained. Wait for **Not connected** before removing the plugin:

```sh
magpie plugin rm magpie-agent-tinycast
```

Keep the plugin enabled while disconnecting so it can finish restoration. Removing it first stops the bridge; reinstall it to complete restoration. Do not delete `state.json` while recovery is pending.

## Develop and diagnose

No npm dependencies are required. Node.js 20+ and Xcode Command Line Tools are needed to build and test from source. Magpie runs the plugin using its own JavaScript host.

```sh
npm run build
npm test
npm run check
node scripts/doctor.mjs --sync
```

The helper source is `native.swift`; the build produces both macOS architectures with a macOS 13 deployment target. Native tests use isolated temporary preference domains and do not touch Tinycast’s real preferences or Keychain.

## Discovery and releases

Magpie discovers plugins through npm search and GitHub topics. This plugin is distributed on GitHub and does not require npm publication. The repository uses the GitHub topic **`magpie-plugin`**, which Magpie searches for its Discover list. A Git version tag alone does not enable discovery. GitHub indexing and Magpie’s discovery cache can delay a new listing by several minutes; the direct install command works independently. See [Magpie’s plugin documentation](https://usemagpie.ai/docs/plugins#publishing-and-listing).

## Credits and license

AGPL-3.0-or-later. The purple lightning icon comes from Tinycast’s source; see [THIRD_PARTY.md](THIRD_PARTY.md). This is a community integration, independent of the Tinycast and Magpie maintainers.
