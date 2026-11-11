# Magpie–Mirasim Harness Bridge

**magpie-mirasim-harness-bridge** connects the agents inside Mirasim to their
corresponding Magpie model catalogs. It is a Magpie background plugin, not a
new Mirasim agent or a login provider.

Mirasim runs Claude Code, Codex, DSH and Pi: the same agents magpie already
wires. This plugin is no agent of its own. It lets each of them, inside
Mirasim, use what magpie gives that agent, and keeps magpie's wiring of them
out of Mirasim's own route.

Mirasim 里跑的 Claude Code、Codex、DSH、Pi，就是 magpie 已经接好的那几个
agent。这个插件不是新的 agent：它让 Mirasim 里的每个 harness 用 magpie 给
该 agent 的模型，并且不让 magpie 对它们的接线串进 Mirasim 自己的线路。

## What it does

| | |
| --- | --- |
| Models | Claude Code in Mirasim lists what magpie gives Claude Code (`magpie models claude`), Codex what it gives Codex, DSH and Pi likewise, under the provider **magpie**. Tick or hide a model for an agent in magpie and Mirasim follows within seconds. Mira Bot runs on Claude Code: its Settings › Model lists Claude Code's. |
| Route | A magpie model runs straight at the gateway, never through Mirasim's relay, on either of Mirasim's routes. Mirasim's own models keep going to its relay. |
| Codex | Codex's own model cache (`~/.codex`, which Mirasim shares) holds magpie's catalog too; on Mirasim's route those rows went to its relay, which refuses them. They are turned off in Mirasim's Codex menu (your own choices kept); the same models come as magpie's. |
| DSH | magpie's wiring of DSH sets the model DSH starts on, in a file Mirasim's DSH sessions share; Mirasim, taking that start for DSH's own default, left its own route's DSH on magpie's model. The start is recorded as one Mirasim selected, so Mirasim puts DSH on its own model. DSH runs only models DSH itself has, which are those magpie's DSH connection registers: exactly DSH's catalog. |
| MCP | Magpie Library servers are imported as Mirasim connectors. Their per-agent enabled switches follow Magpie's selections for agents Mirasim supports; agents not selected in Magpie are turned off in Mirasim. Existing same-name connectors are not reinstalled or overwritten. |
| Skills | Skills assigned to a Mirasim-supported harness are imported into Mirasim's global managed store without overwriting an existing same-name skill. The import is a copy; subsequent source edits do not automatically overwrite that copy. |
| Instructions | The harnesses still read their native instruction files (`~/.claude`, `~/.codex`, `~/.dsh`, `~/.pi`). |
| Usage | Requests count as the harness's own in magpie (claude, dsh, pi); Codex as mirasim, the name Mirasim gives the Codex it starts. |

Turn the plugin off or remove it and the bridge removes its model provider
and profiles, restores the Codex rows and takes out its DSH record. Imported
connectors, skill copies and their last enabled states stay in Mirasim; while
the plugin is off they are no longer updated from Magpie.

## How

`index.mjs` starts `adapter.mjs` in magpie's plugin host (Bun); it registers
nothing with magpie. Every 5 s it reads each agent's catalog at the gateway
(`/v1/models`, `Bearer magpie-<agent>`) and writes Mirasim's
`~/.mirasim/setting.json`: one provider (`models.providers.6d616770-…`, every
API declared so Mirasim needn't probe) and one profile per model listing the
harnesses whose catalog has it (stable ids from the model id, so a model
picked somewhere stays picked). Each round writes only what differs and a
gateway that doesn't answer leaves things as they are. The same owner also
checks Magpie's `library.json` and the live Mirasim
connector/skill host. MCP credentials are handed to Mirasim's local secret
store, never printed. New connectors and skills are imported; connector
agent switches follow the library. A removed library MCP is disabled for
previously mirrored agents but is not uninstalled. A Mirasim-uninstalled
connector (tombstone) is not re-created. What it changed of
Mirasim's own choices is kept in `~/.config/magpie-mirasim/state.json`, to put
back. magpie loads plugins in its app's host and, for a moment, in a host each
of its commands starts; only one instance keeps Mirasim (`owner.json`, renewed
every round, taken over when its holder is gone or 30 s silent), so a command's
host never writes Mirasim or puts it back.

## Install

```sh
magpie plugin add github:SammySnake-d/magpie-mirasim-harness-bridge
```

Alternatively, clone this repository and add its local directory with
`magpie plugin add /absolute/path/to/checkout`. The GitHub repository is the
release source; this project is not published to npm.

This plugin changes Mirasim's local model configuration and its own small
restore ledger. Review the paths in **How** and back up your Mirasim settings
before use. It talks to the loopback Magpie gateway at the port saved in
Magpie settings and uses Magpie's standard local `magpie` credential. Gateway
address or authentication overrides that do not accept those defaults are not
supported by this version. It does not upload your settings to this repository.

The plugin host loads it when it next starts (after an add, at the next
request to a plugin). Code changed later loads after `magpie plugin off
<path>` and `on`.

## Limits

- Mirasim refuses to *add* a model of your own past 50 profiles; magpie's count
  toward them. Hide models for Pi in magpie to make room.
- It runs while magpie's plugin host does. Quit magpie and Mirasim's magpie
  models fail, as every agent wired to magpie.
- The DSH and Codex fixes lean on Mirasim's behavior; future versions may differ.
- Mirasim can already read native MCP configuration while it also injects an
  enabled connector named `custom-<name>`. If both refer to the same server,
  a harness may load two copies. The bridge does not remove native agent
  configuration or patch Mirasim, so use the agent's own MCP tools list to
  check for duplicates. This is a Mirasim integration limitation, not a claim
  of deduplication.
- A source MCP with SSE, custom OAuth, disabled tools, or credentials embedded
  in its URL is not automatically imported/enabled: those policies cannot be
  represented safely by this bridge. Existing connectors and credentials
  are preserved, so edits to their Magpie server definition are not applied
  to an already installed connector. Skills are imported once, not live-mirrored.
- The bridge uses the desktop host's local token at its usual port; when that
  port is absent, it uses a single unambiguous local host, and otherwise waits.

## Test

`bun test`: catalogs per harness, the user's providers, profiles and
settings left alone, Codex's menu, DSH's start, a round against a gateway, and
off or removed putting Mirasim back exactly. The tests use isolated fixtures;
they do not certify compatibility with every Mirasim or Magpie release.
