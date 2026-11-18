<p align="center"><img src="brand/icon.svg" width="72" alt="Tinycast lightning icon"></p>
<h1 align="center">Tinycast for Magpie</h1>
<p align="center">Your Magpie models, inside Tinycast. No API key. No Keychain password.</p>

A community integration for [Magpie](https://usemagpie.ai/) and [Tinycast](https://github.com/abue-ammar/tinycast). Enable the Tinycast provider from Magpie’s Agents page and pick a model in Tinycast.

## Install

Requires macOS 13 or newer, Tinycast, Magpie with agent-plugin support, and Node.js 20+ to apply settings. The included helper is a universal arm64/x86_64 binary. Intel execution has not been tested.

```sh
magpie plugin add github:BaksiLi/magpie-agent-tinycast
```

1. Open **Agents → Tinycast** in Magpie and turn it on.
2. **Quit Tinycast from its menu-bar icon**. Tinycast’s ⌘Q closes the window without quitting the app.
3. Apply the settings and reopen Tinycast:

   ```sh
   cd "${XDG_CONFIG_HOME:-$HOME/.config}/magpie/plugins/node_modules/magpie-agent-tinycast"
   npm run sync
   ```

4. In Tinycast’s AI Chat model picker, choose a model under **Magpie**. Existing default-model choices are preserved.

Magpie shows its standard yellow agent notice after you change the Tinycast switch. The switch records the requested configuration. The sync command applies it to Tinycast, following the one-shot setup pattern used by [agent-cowork](https://github.com/cuddlesgiggles/agent-cowork). Repeat the quit, sync, and reopen steps when you want to apply an updated model list. An existing v0.2.0 connection carries over.

## Connection and privacy

Tinycast uses Magpie’s local OpenAI-compatible endpoint, such as `http://127.0.0.1:3425/agent/tinycast/v1`. Magpie accepts unauthenticated loopback requests; the agent path attributes requests to Tinycast. The plugin does not read, store, or change Keychain credentials. Remote gateways are refused; configure authenticated remote providers in Tinycast itself.

A small native helper writes Tinycast’s `aiConnections` preference through CFPreferences only while Tinycast is closed. It adds one managed **Magpie** connection and preserves other providers and settings. Model IDs, vision support, output limits, and reasoning levels are synchronized. Selecting a default model remains your choice.

The integration keeps its requested configuration and recovery record in `~/.config/magpie-tinycast/`, with directory mode 0700 and file mode 0600. The recovery record contains connection metadata and the previous default selection. It contains no API keys. If the managed connection is edited manually, sync reports the conflict and preserves the recovery record.

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

Turn **Agents → Tinycast** off, fully quit Tinycast, and run `npm run sync` as above. Sync removes the managed connection and restores the previous default only if the current default still points at the managed connection. Once sync reports `disconnected`, you can remove the plugin:

```sh
magpie plugin rm magpie-agent-tinycast
```

Keep `state.json` until recovery finishes.

## Develop and diagnose

No npm dependencies are required. Node.js 20+ and Xcode Command Line Tools are needed to build and test from source. Magpie runs the plugin using its own JavaScript host.

```sh
npm run build
npm test
npm run check
```

The helper source is `native.swift`; the build produces both macOS architectures with a macOS 13 deployment target. Native tests use isolated temporary preference domains and do not touch Tinycast’s real preferences or Keychain.

## Discovery and releases

Magpie discovers plugins through npm search and GitHub topics. This plugin is distributed on GitHub and does not require npm publication. The repository uses the GitHub topic **`magpie-plugin`**, which Magpie searches for its Discover list. A Git version tag alone does not enable discovery. GitHub indexing and Magpie’s discovery cache can delay a new listing by several minutes; the direct install command works independently. See [Magpie’s plugin documentation](https://usemagpie.ai/docs/plugins#publishing-and-listing).

## Credits and license

AGPL-3.0-or-later. The purple lightning icon comes from Tinycast’s source; see [THIRD_PARTY.md](THIRD_PARTY.md). This is a community integration, independent of the Tinycast and Magpie maintainers.
