<p align="center"><img src="./assets/icon.png" width="128" alt="Kaku"></p>

# magpie-agent-kaku

English | [简体中文](./README.zh-CN.md)

A [Magpie](https://usemagpie.ai) plugin for [Kaku](https://github.com/tw93/Kaku) Assistant. It does two things:

1. **Points Kaku at the Magpie gateway.** It writes the gateway's `base_url` and API key into Kaku's `~/.config/kaku/assistant.toml`.
2. **Gives each Kaku role its own Magpie routing group.** Kaku uses different models for different jobs. The plugin binds each role to a group, and Magpie picks the model inside that group.

When you disconnect, your original Kaku config is restored byte for byte.

## How routing works

Routing happens in two layers.

**Layer 1: the plugin binds Kaku's roles to groups.**

| Kaku role | Used for | Field in `assistant.toml` | Plugin option |
| --- | --- | --- | --- |
| Simple | `#` commands, command fixes, light chat | `model` | `simple` (required) |
| Deep | `Cmd+L` overlay, `k` chat, tool calls | `chat_model` | `deep` (required) |
| Memory | Memory curation. Uses Deep if not set | `memory_curator_model` | `memory` (optional) |

**Layer 2: Magpie picks a model inside each group.**

A group is a list of member models plus a routing strategy (`smart`, `order`, `cheap`, `fast`, `weight`, and others). For every request, Magpie chooses a member using that strategy, falls back to the next one when a model is out of quota or down, and can apply intent rules ("a multi-step coding task" goes to a strong model, "a quick question" goes to a cheap one). Intent rules look only at the latest user message. During a tool-call round trip, Magpie keeps the turn on the model it already picked.

The plugin never classifies requests itself. All model choice lives in your Magpie groups, so you change routing with `magpie group` commands, not by editing the plugin.

## Install with an AI agent

Paste this prompt into Grok Build, Codex, Claude Code, or any coding agent running on your computer:

```text
Install the Kaku plugin for Magpie on this computer. Read https://raw.githubusercontent.com/shlroland/magpie-agent-kaku/main/INSTALL_FOR_AGENTS.md and follow every step. Ask me which models I want for Kaku's Simple and Deep roles before creating the groups, and never print any API key.
```

The agent backs up your Kaku config, installs the plugin, sets up the routing groups with you, connects Kaku, and checks which model answers. To do it by hand, follow the steps below.

## Requirements

- macOS (or Linux) with Magpie running. Magpie brings its own Bun runtime, so you don't need to install Bun.
- Kaku installed, with `~/.config/kaku/assistant.toml` present.

On macOS the `magpie` command lives inside the app and is usually not on your `PATH`:

```sh
alias magpie=/Applications/Magpie.app/Contents/MacOS/magpie
```

The commands below assume this alias.

## Usage

### 1. Install the plugin

```sh
git clone https://github.com/shlroland/magpie-agent-kaku.git ~/magpie-agent-kaku
magpie plugin add ~/magpie-agent-kaku
```

`dist/` is committed, so there is no build step.

### 2. Pick or create groups

List the groups you already have:

```sh
magpie groups
```

Each line shows the group's id, its strategy, and its members. Inspect one group with `magpie group <id>`.

To create dedicated groups for Kaku (replace the model ids with ones you have; `magpie models` lists them):

```sh
magpie group add "Kaku simple" models=provider/cheap-model,provider/backup-model routing=order
magpie group add "Kaku deep"   models=provider/strong-model,provider/backup-model routing=smart

# Optional: route by what the user asked
magpie group rule add kaku-deep use=provider/strong-model intent="a multi-step coding task" classifier=provider/small-fast-model
magpie group rule add kaku-deep use=provider/cheap-model  intent="a quick question"
```

A group named `"Kaku simple"` gets the id `kaku-simple`, and you refer to it as `group/kaku-simple`. A plain `provider/model` also works if you don't want routing for a role.

### 3. Set the plugin options

```sh
magpie plugin options ~/magpie-agent-kaku '{
  "simple": "group/kaku-simple",
  "deep":   "group/kaku-deep",
  "memory": ""
}'
```

| Option | Meaning |
| --- | --- |
| `simple` | Required. Written to `model`. |
| `deep` | Required. Written to `chat_model`. |
| `memory` | Optional. Empty means `memory_curator_model` is left alone. |
| `configPath` | Optional. Path to a different `assistant.toml`. Defaults to `$XDG_CONFIG_HOME/kaku/assistant.toml` or `~/.config/kaku/assistant.toml`. |

The plugin refuses to write anything if `simple` or `deep` is empty.

### 4. Connect

Turn on the **Kaku** switch on Magpie's Agents page, or run:

```sh
magpie kaku magpie
```

Then **reopen** Kaku's `Cmd+L` overlay or send a new `#` command. Kaku reads its config when the overlay opens and when each `#` task starts, so an overlay that is already open keeps the old settings.

After connecting, `assistant.toml` looks like this (comments and other keys are kept):

```toml
model = "group/kaku-simple"
chat_model = "group/kaku-deep"
base_url = "http://127.0.0.1:3425/v1"
api_key = "<this agent's Magpie gateway key>"
auth_type = "api_key"
```

### 5. See which model actually answered

- **Group setup:** `magpie groups` and `magpie group <id>` show members, strategy, and rules.
- **Each request:** Magpie's usage view (and `GET /v1/magpie/usage/requests` on the gateway) lists every Kaku request with the group it asked for and the model that served it.
- **Raw check:** a gateway response carries `X-Magpie-Model` and `X-Magpie-Provider` headers.

### 6. Change routing

- To change which models a role can use, edit the group with `magpie group set <id> ...` or add rules. No plugin change is needed and it takes effect on the next request.
- To point a role at a different group, update the plugin options, then turn the Kaku switch off and on again.

### 7. Disconnect

Turn the Kaku switch off, or run:

```sh
magpie kaku default
```

Every field the plugin changed goes back to its original value, and keys that didn't exist before are removed. If you edited one of those fields yourself while connected, your edit is kept and reported as a conflict.

Always disconnect before removing the plugin. If Magpie was force-quit while connected, re-enable the plugin or run `bun ./bin/magpie-kaku.mjs restore` from the plugin folder.

## What the plugin touches

While connected it writes `base_url`, `api_key`, `auth_type`, `model`, `chat_model`, and `memory_curator_model` (only if `memory` is set). It removes the legacy `fast_model` key, which would otherwise override Simple, and puts it back on disconnect.

It never touches `enabled`, `api_mode`, `web_search_provider`, `web_search_api_key`, `chat_model_choices`, `custom_headers`, or any other key.

The original values, including your previous `api_key`, are kept in `~/.config/magpie-agent-kaku/state.json` (mode `0600`) until you disconnect. Logs never print key values.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Kaku still uses the old model | Reopen the `Cmd+L` overlay; an open overlay doesn't reload. |
| Nothing changed in `assistant.toml` | `magpie kaku` should say `provider magpie`, and `simple`/`deep` must both be set. |
| A group never uses one member | `magpie groups` marks members that can't be served, for example when their provider is turned off. |

## How it works

`agent.js` runs inside Magpie as the agent definition. It has no model field, so the Agents page shows it as a connection switch. When connected it writes the gateway URL and key to `~/.config/magpie-agent-kaku/bridge.json`.

`dist/index.js` runs in Magpie's Bun plugin host. It watches that bridge file and patches only the needed keys in `assistant.toml`, preserving comments and layout. This split exists because Magpie's agent writer can't edit TOML.

## Development

```sh
bun install
bun run typecheck
bun test
bun run build                                # regenerates dist/
MAGPIE_BIN=$(which magpie) node scripts/integration-smoke.mjs   # end-to-end test against a mock upstream
```

## License

MIT

The Kaku logo is from [tw93/Kaku](https://github.com/tw93/Kaku) (MIT).

## Releasing

Releases are automatic. Bump `version` in `package.json` in a pull request; when it's merged into `main`, the [Publish workflow](.github/workflows/publish.yml) runs the checks, publishes to npm through npm Trusted Publishing, and creates a GitHub release `v<version>`. A push that doesn't change the version publishes nothing.
