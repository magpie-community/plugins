# agent-nanobot

`@magpie-community/agent-nanobot` adds [nanobot](https://github.com/HKUDS/nanobot) to Magpie's Agents page. Pick one of Magpie's models in its row and Magpie writes it into nanobot's configuration; Library gives it MCP servers and workspace skills. Upstream credentials stay in Magpie. This is an unofficial integration and implies no endorsement by the nanobot project.

Tested with Magpie 0.1.3384 and 0.1.3373, and nanobot 0.4.1. On Windows only; other nanobot versions, macOS, Linux and WSL are untested.

## Installation

```sh
uv tool install --python 3.12 nanobot-ai
nanobot onboard

magpie plugin add @magpie-community/agent-nanobot
```

## Use

1. Pick a model in the **nanobot** row on Magpie's Agents page. It becomes nanobot's default preset, so a session started afterwards begins on it. A session already running may keep its own.
2. In Library → MCP, tick nanobot for the servers it should have. Restart nanobot to load them.
3. In Library → Skills, tick the skills it should have. Prefer **Copy** for nanobot in Library's **How** setting: with workspace restrictions, a per-skill link can keep `read_file` from opening the skill's bundled files.

## What Magpie manages

In `~/.nanobot/config.json`: `providers.magpie`, `modelPresets.magpie` and `agents.defaults.modelPreset`. In `tools.mcpServers`: the entries for ticked servers, plus the exact loopback address a server at `127.0.0.1` or `::1` needs, which nanobot blocks otherwise. Everything else in the file is left alone.

A same-name entry you wrote yourself is refused rather than taken over. Editing a managed field by hand pauses synchronisation and keeps a recovery record. A journal is written before every change, so an interrupted run is replayed instead of half-applied.

## Disconnect

Turn the agent off in Magpie, or run `magpie nanobot default`. The managed fields go back to what they were, or disappear where there was nothing before. Restart nanobot afterwards. MCP servers and skills are unticked in Library separately. Turn the agent off before disabling or uninstalling the plugin.

If Magpie is killed before it can restore, the one-shot fallback is `node cli.mjs restore` from this package.

## Development

From `packages/nanobot` in a checkout of the community plugins repository:

```sh
bun test nanobot.test.mjs
```

The repository's `scripts/check.mjs` skips Agent packages; `nanobot.test.mjs` covers the descriptor, the published-package contract and what `connect()` returns.

## 中文

把 [nanobot](https://github.com/HKUDS/nanobot) 加到 Magpie 的 Agent 页。在 **nanobot** 一行选 Magpie 的模型，Magpie 会写进 nanobot 的配置；资源库里可以为它勾选 MCP 服务和技能。上游凭证仍留在 Magpie。这是非官方集成。

先装 nanobot 并执行 `nanobot onboard`，再执行 `magpie plugin add @magpie-community/agent-nanobot`。选中的模型就是 nanobot 的默认 preset，之后启动的会话从它开始；已在运行的会话可能保留自己的模型。MCP 变更后要重启 nanobot，技能和模型不用。资源库的 **How** 建议仅对 nanobot 设为 Copy，避免工作区限制读不到技能附带文件。

受管字段只有配置里的 `providers.magpie`、`modelPresets.magpie`、`agents.defaults.modelPreset`，以及勾选服务的 `tools.mcpServers` 条目和 loopback 白名单。手写的同名条目不会被接管；手改受管字段会暂停同步并保留恢复记录。关掉这个 Agent 即可还原，MCP 和技能在资源库单独取消；卸载前先关掉 Agent。若 Magpie 在还原前被强制结束，可用包内 `node cli.mjs restore` 手动完成。仅在 Windows 上验证过。
