# magpie-agent-kinex

**Brings [Kinex](https://github.com/stacx-lab/kinex) into [magpie](https://usemagpie.ai)'s Agents list: pick a model for Kinex in magpie, and this plugin writes it into Kinex's own configuration.**

Pick a model for **Kinex** in magpie and the plugin writes magpie's gateway and models into Kinex's configuration. Disconnect, and everything goes back to how it was.

Kinex is [Stacx Lab](https://github.com/stacx-lab)'s robotics coding agent. It is built on Pi's SDK, so its model configuration has Pi's shape, and this plugin does for Kinex what magpie's built-in Pi integration does for Pi.

> This wires up **Kinex itself**, so that it uses magpie's models. Giving Claude Code, Codex, Pi and other agents Kinex's robotics tools is the job of the upstream [kinex-plugins](https://github.com/stacx-lab/kinex-plugins), which is a separate thing.

## Install

In magpie, open **Plugins › Discover** and search for **Kinex**. Or from the command line:

```bash
magpie plugin add github:hnrobert/magpie-agent-kinex
```

The plugin needs no Node and has no dependencies: it runs inside magpie's own process.

Once Kinex has run at least once (or `kinex` is on the `PATH`), `magpie ls` lists a **Kinex** row. Before that, `magpie kinex` still works on it directly.

## Use

1. `magpie models kinex` lists the models Kinex can pick. It is the same list as the model menu on Kinex's row on the Agents page.
2. Pick one: `magpie kinex <provider>/<model>`, for example `magpie kinex deepseek/deepseek-chat`.
3. Reopen Kinex. New sessions start on the model you picked, and `/model` inside Kinex switches to another of magpie's models.
4. To go back to Kinex's own providers: `magpie kinex default`, or disconnect on the Agents page.

## What it changes in Kinex

Kinex keeps its files in `~/.config/kinex/agent/`. Only these two are touched:

| File            | Change                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models.json`   | A `providers.magpie` entry is added: the gateway address, the key magpie issues Kinex, and an entry for each model. Your own providers are left as they are |
| `settings.json` | `defaultProvider` is set to `magpie` and `defaultModel` to the model you picked. Other keys are left alone                                                  |

Before its first write, magpie records what these two keys held and puts it back when you disconnect. If there was no `providers.magpie` to begin with, it is removed whole, leaving no empty object behind. Pi reports an error for an empty provider entry.

### How a model entry is written

The Pi that Kinex bundles fills nothing in for a custom provider's model by id. Whatever the entry leaves out takes a default: a 128K context, a 16384-token reply limit, no thinking. So every entry says all of it, the way magpie writes them for its built-in Pi (`lib/provider.js`):

- **API.** Kinex asks a model on whichever request magpie relays as it is: Responses first, then Anthropic Messages, otherwise the provider's Chat Completions. magpie then has no translating to do in between.
- **Thinking levels.** `thinkingLevelMap` maps Pi's levels to the model's own reasoning levels, and a level the model lacks does not appear in Kinex's `/thinking`. You choose the effort in Kinex, and magpie forwards it as it is.
- **Size and price.** `contextWindow`, `maxTokens`, `cost`, and the `promptCache` lifetimes magpie knows of.
- **Adaptive thinking.** Claude 4.6 and later, GLM-5.2 and 5.3, and Gemini 3 and later get `forceAdaptiveThinking` when asked on Messages. Without it Pi sends a thinking budget, which these models refuse. These rules go by model name and are a snapshot ported from magpie's gateway: when magpie's rules change, change them here too.

## Known limitations

- **The config folder is fixed at `~/.config/kinex/agent`.** Kinex itself follows `KINEX_CONFIG_DIR` and `XDG_CONFIG_HOME`, but this plugin runs inside magpie's process, where it cannot read environment variables, and magpie's plugin interface takes fixed paths only. On a machine with either variable set, the plugin writes where Kinex does not read.
- **The model menu lists magpie's models only.** To go back to a model of Kinex's own providers, use `/model` in Kinex, or disconnect. When a plugin picks "one of the agent's own models" for an agent, magpie's plugin interface writes `defaultModel` alone, and Pi resolves `defaultProvider` and `defaultModel` only as a pair. Rather than offer a choice that may not take effect, the plugin offers none.
- **`enabledModels`.** If Kinex's `settings.json` has this list and it leaves out magpie's models, a new session starts on the list's first model. For its built-in Pi, magpie adds the picked model to the list itself; the plugin interface cannot.
- **It takes effect after a restart.** Kinex reads `models.json` when it starts. Pi's `/reload` loads settings, extensions and skills again, not the model list.
- **Disconnecting a fresh install leaves two nearly empty files behind**: `{"providers": {}}` in `models.json` and `{}` in `settings.json`. Harmless, Pi reads them both.
- **Only the instructions file and skills are wired to the Library**: `~/.config/kinex/agent/AGENTS.md` and `~/.config/kinex/agent/skills`. Kinex ships no MCP extension by default, so there is no MCP configuration file to write.

## Development

The entry point is `kinex.agent.js`, the module magpie loads. `lib/provider.js` is the part that writes the contents of `models.json`. The module runs in the JS engine inside magpie's process (moejs): no Node APIs, no network, one second each for loading and for every `connect()`, and it can `import` only files beside it in the repository.

```bash
pnpm install
pnpm run check
```

`check` runs Prettier, ESLint and the tests in turn. The tests need Node 22.19 or later and come in two kinds:

- `test/provider.test.mjs` and `test/agent.test.mjs`: pure logic, depending on nothing external.
- `test/kinex-loads-it.test.mjs`: hands the `models.json` the plugin writes to the Pi that Kinex 1.1.0 bundles (`@earendil-works/*` 1.2.0, pinned in the `overrides` of `pnpm-workspace.yaml`) and checks that it loads, that each model lands on the right API, and that a new session starts on the picked model. Pi validates a `models.json` whole, and one invalid value leaves it with no provider loaded at all, so this step cannot be skipped.

### Verifying with a real magpie

Only a real magpie can verify that moejs accepts the syntax. Go through it once in a throwaway environment, leaving your own magpie alone:

```bash
export HOME="$(mktemp -d)" MAGPIE_ADDR=127.0.0.1:3941
export XDG_CONFIG_HOME="$HOME/.config" XDG_CACHE_HOME="$HOME/.cache"
magpie plugin add "$PWD"
magpie kinex <provider>/<model>
cat "$HOME/.config/kinex/agent/models.json"
magpie kinex default
```

### Icon

`assets/kinex-logo.svg` is the plugin's one picture. It is not read as a file of the package: magpie takes a picture only as an `https` address or as data embedded in `package.json`, because a card in Discover is drawn before anything of the plugin is on disk. So `magpie.icon` in `package.json` gives the file's address on GitHub, for the card in Discover and the row in Installed, and the `agent` export gives the same address as its `icon`, for Kinex's row on the Agents page. magpie fetches the picture once, through usemagpie.ai's icon proxy, and keeps it; a card or a row shows magpie's generic one only until it arrives. The SVG holds the two shapes of Kinex's logo with their paths unchanged, on a tile of Kinex's own brand purple, so that it reads on magpie's light and dark themes alike. A test checks that both addresses name this repository's file.

### How far it was verified

Done on macOS with magpie 0.1.4535 (the git install and the picture with 0.1.4727):

- The real magpie command line loading this plugin: adding it, picking a model, disconnecting. After disconnecting, both files are byte-for-byte what they were before. When the provider of the picked model is removed, magpie moves Kinex to an equivalent model by itself.
- The same through a git install, which is what installing from the Discover page does: the plugin added from a git repository of this code, a local one on the same route as `github:owner/repo`; Kinex's row loaded, a model was picked, and both files were put back byte-for-byte when the plugin was removed.
- The picture, as the window's server gives it to the pages. The row in Installed and Kinex's row on the Agents page have it about five seconds after the plugin is first loaded, and a later start reads it from disk. With `icon` left out the Agents row is `generic`, and with a relative file path in `magpie.icon` the Installed row has no picture at all.
- Pi 1.2.0 reading back the real files magpie wrote: no error, and a new session starts on the picked model.
- An end-to-end request: the Pi 1.2.0 client sending a request the way Kinex does, through a real magpie gateway (started separately in the throwaway environment) to a fake vendor. Chat Completions, Responses and Messages all went through, the reasoning parameters mapped as expected, and magpie's usage ledger recorded it under Kinex with the session.

Not verified:

- **The real Kinex was never run.** The claims above about how Kinex reads these files rest on its source and on the Pi it bundles, not on running Kinex.
- The window itself: the pictures were checked through what magpie's server gives the page, not by looking at the window.
- Discover's card with the address: it was checked with a list of one entry served on this computer. The live list has the address only once this `package.json` is on `main`.
- Windows and Linux, and a real robot workspace.
- An install from npm, and from GitHub itself: the package is not on npm yet, and the repository was cloned locally. The npm tarball was only packed and its contents listed.

## Acknowledgements and license

- [Kinex](https://github.com/stacx-lab/kinex) (Stacx Lab, Apache-2.0): the agent this plugin wires up. The icon is taken from its logo.
- [magpie](https://github.com/yetone/magpie): the agent plugin interface, and the way it writes model entries for its built-in Pi, which `lib/provider.js` follows.
- [Pi](https://github.com/earendil-works/pi/tree/v1.2.0): Kinex is built on its SDK, and the tests use it to read the written files back.

This repository is licensed under Apache-2.0; see [LICENSE](LICENSE).
