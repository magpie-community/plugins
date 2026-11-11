# Magpie agent plugin for ThinkRail

![ThinkRail](./icon.svg)

[ThinkRail](https://github.com/JetBrains/thinkrail) is JetBrains' coding agent desktop app; it embeds the [pi coding agent](https://pi.dev) and reads model providers from `~/.pi/agent/models.json`. This plugin adds ThinkRail to [Magpie](https://github.com/yetone/magpie) as a **connect-only agent**: connecting writes the whole `providers.magpie` object (gateway plus the full model catalog) into that one file, disconnecting restores what was there before. Models are picked in ThinkRail's own model picker. The plugin touches no other file, and `auth.json` stays untouched.

Built by a non-professional; the code was written mostly by AI, so keep expectations for code quality modest. Not actively maintained — behaviors are marked with the versions and dates they were tested on.

## Install and use

Requires **Magpie 0.1.1243 or newer** (the agent-plugin channel landed there; tested on 0.1.2075) and **ThinkRail 0.2.0 or 0.3.0** on Windows (tested; any version still reading providers from `~/.pi/agent/models.json` should work). No other tool may write a `magpie` provider id into `~/.pi/agent/models.json`.

This plugin exists in two installable places — install **one, not both** (same agent id `thinkrail`):

```sh
magpie plugin add @magpie-community/agent-thinkrail        # community registry
magpie plugin add github:crafthei/magpie-agent-thinkrail   # this repository
```

```sh
magpie ls                          # the ThinkRail row appears once the app is installed
magpie thinkrail                   # current wiring
magpie thinkrail provider magpie   # connect: writes providers.magpie (gateway + all models)
magpie thinkrail default           # disconnect: restores the previous file
```

Connect writes only `providers.magpie`; no "current model" is set — pi keeps it outside `models.json`, and `magpie thinkrail <model id>` is silently ignored (observed). **Restart ThinkRail after connecting**, then pick a model in its own picker's Magpie group.

ThinkRail is detected by its install root `~/AppData/Local/ai.thinkrail.app`; without the app installed, the row doesn't appear on the Agents page, and Magpie offers no install guidance for it — that row is hardcoded upstream for built-in CLIs, with no entry point for third-party plugins.

## Disconnect or remove

Disconnect first, then disable or remove the plugin: removing the plugin does not run the agent's disconnect/restore (per upstream). Retested 2026-11-08 on Magpie 0.1.2075: after `magpie thinkrail default`, `magpie plugin rm magpie-agent-thinkrail` left `~/.pi/agent/models.json` byte-identical to its pre-connection state with no `magpie` provider left behind, and the disconnect → remove → reinstall → reconnect cycle reproduced the connected state byte-identically.

Disconnecting restores the stashed file as one unit. If `models.json` did not exist before the first connect, disconnecting leaves an empty `{"providers": {}}` shell file (observed, harmless).

## Configuration and limits

Magpie owns exactly one object in `~/.pi/agent/models.json`, the whole `providers.magpie` entry:

| Field | Value |
|---|---|
| `name` | `Magpie` |
| `baseUrl` | the gateway's `/v1` URL |
| `apiKey` | Magpie-issued key; on local loopback it is `magpie-thinkrail`, so Usage attributes the calls to thinkrail |
| `api` | `openai-completions` (Magpie does the protocol translation) |
| `models` | Magpie's catalog, mapped to pi model entries |

Model entries keep id, name, image input, positive context/output limits and pi reasoning levels; an output limit above its window is clamped to the window, matching Magpie's built-in Pi adapter. Unknown limits are omitted, so ThinkRail's defaults apply.

ThinkRail does not watch `models.json`: reopening the picker doesn't reload it (observed), so **restarting ThinkRail is the reliable path**; mid-session catalog changes likewise apply after a restart. Once connected, ThinkRail 0.3.0 shows the Magpie entry as「已托管」("managed", user-observed 2026-10-31) with a read-only endpoint field — everything is managed on the Magpie side, and a disconnect-reconnect syncs changes over.

`~/.pi/agent` is the pi coding agent's own directory. ThinkRail's embedded pi shares it — and the same `models.json` — with a standalone pi installation. This plugin is designed for ThinkRail only; standalone-pi compatibility is untested and will not be tested. If a standalone pi on the same machine misbehaves around the written `providers.magpie`, that is at your own risk.

## License

MIT. Third-party material (ThinkRail favicon, Apache-2.0; model-mapping semantics from `@magpie-community/agent-pig`, MIT) is attributed in [NOTICE.md](NOTICE.md).
