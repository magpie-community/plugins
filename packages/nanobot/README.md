# agent-nanobot

`@magpie-community/agent-nanobot` adds [nanobot](https://github.com/HKUDS/nanobot) to Magpie's Agents page. Pick one of Magpie's models in its row and Magpie writes it into nanobot's configuration; Library gives it MCP servers and workspace skills. Upstream credentials stay in Magpie. This is an unofficial integration and implies no endorsement by the nanobot project.

The original integration was tested on Windows with Magpie 0.1.3384 and 0.1.3373, and nanobot 0.4.1. The parent-symlink and exit-lifecycle changes have been regression-tested on Linux x86_64 with Bun 1.4.2, including a symlinked `TMPDIR`; they have not yet been retested in a full Magpie/nanobot installation. Full integration on Linux, macOS and WSL, and other nanobot versions, remains untested.

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

Parent directories may be symlinks, including the home directory, `~/.nanobot` and `~/.config`. The final configuration, control, state, journal and lock files must be regular files; links at those file paths, including dangling links, are refused.

## Disconnect

Turn the agent off in Magpie, or run `magpie nanobot default`, to restore the managed model fields to their previous values (or remove them if they did not exist). MCP assignments and skills are independent: untick them separately in Library. Removing managed MCP servers also removes loopback exemptions introduced by this adapter when no remaining server needs them. Restart nanobot to load MCP changes; existing sessions may keep their selected model.

Before disabling or uninstalling the plugin, disconnect the model and remove any Library assignments you no longer want. Let the adapter finish synchronizing while it is still running.

Normal exit, including an update or shared-host restart, does not itself disconnect nanobot. The owning adapter synchronizes the current control files once before releasing its lock: connected model and MCP settings remain in place, while a model disconnect or MCP deselection that has not reached the next polling tick is applied. Ownership records remain available for the next host to resume. Retaining configuration does not keep the Magpie gateway online; models using it still require a running gateway.

For an explicit restore, or if Magpie is killed before a requested disconnect is applied, run the one-shot fallback `node cli.mjs restore` from this package. It restores managed fields and pauses unchanged inputs so a running adapter does not immediately reconnect them.

## Status and recovery

From this package directory:

```sh
node cli.mjs status   # Inspect recorded status and pending recovery; no config writes.
node cli.mjs sync     # Synchronize the current model and MCP inputs once.
node cli.mjs restore  # Restore managed fields and pause unchanged inputs.
```

`sync` respects an existing pause; it does not force reconnection after `restore`. Changing the model or MCP input lets synchronization resume. Skills are managed by Library and are not removed by `restore`.

If status reports `conflict`, inspect its `code` and resolve the underlying configuration or path issue before retrying `sync`. Keep the ownership and pending-journal files: they are needed to restore managed fields or finish an interrupted transaction. Status output omits configuration contents, gateway URLs and keys. Commands exit with code 1 on a conflict or operational error, and 2 for invalid arguments.

## Development

From `packages/nanobot` in a checkout of the community plugins repository:

```sh
bun test nanobot.test.mjs
```

The repository's `scripts/check.mjs` skips Agent packages; `nanobot.test.mjs` covers the descriptor, the published-package contract and what `connect()` returns.

Linux x86_64 / Bun 1.4.2 validation: `bun test packages/nanobot` from the repository root passes 60 tests (312 assertions), both with the default temporary directory and with `TMPDIR` pointing to a directory symlink. This covers apply/restore, journal replay, first-run state-directory creation, refusal of final-file links (including dangling links), reserved-file collisions through directory aliases, configuration retention across host restarts, pending disconnects on exit, paused restores, invalid inputs and lost ownership. Recovery-status tests check early parse failures without trusting invalid or foreign ownership records. Isolated subprocesses load the actual plugin entry and exit naturally to verify its exit hook, final synchronization and lock release; only the home-directory lookup is substituted. `bun scripts/check.mjs` also passes.

## 中文

把 [nanobot](https://github.com/HKUDS/nanobot) 加到 Magpie 的 Agent 页。在 **nanobot** 一行选 Magpie 的模型，Magpie 会写进 nanobot 的配置；资源库里可以为它勾选 MCP 服务和技能。上游凭证仍留在 Magpie。这是非官方集成。

先装 nanobot 并执行 `nanobot onboard`，再执行 `magpie plugin add @magpie-community/agent-nanobot`。选中的模型就是 nanobot 的默认 preset，之后启动的会话从它开始；已在运行的会话可能保留自己的模型。MCP 变更后要重启 nanobot。资源库的 **How** 建议仅对 nanobot 设为 Copy，避免工作区限制读不到技能附带文件。

受管字段只有配置里的 `providers.magpie`、`modelPresets.magpie`、`agents.defaults.modelPreset`，以及勾选服务的 `tools.mcpServers` 条目和相应的 loopback 白名单。手写的同名条目不会被接管；手改受管字段会暂停同步并保留恢复记录。

关闭 Agent 或执行 `magpie nanobot default` 只还原受管模型字段。MCP 和技能分别在资源库取消；移除受管 MCP 时，适配器添加且已无服务需要的 loopback 豁免也会移除。禁用或卸载插件前，先断开模型、取消不再需要的资源库分配，并等待仍在运行的适配器完成同步。

原始集成在 Windows 上验证过。本次父目录符号链接和退出行为变更已通过 Linux x86_64 / Bun 1.4.2 回归测试（60 项测试、312 个断言，普通临时目录和符号链接 `TMPDIR` 均通过），尚未在完整 Magpie/nanobot 安装中复测。Linux 完整集成、macOS 和 WSL 尚未验证。

主目录、`~/.nanobot` 和 `~/.config` 等父目录可以是符号链接；配置、控制、状态、日志和锁文件本身必须是普通文件，文件位置上的符号链接（包括悬空链接）仍会被拒绝。

Magpie 正常退出、更新或共享宿主重启本身不会断开 nanobot。持有锁的适配器会在退出前按当前控制文件同步一次，再释放锁：仍连接的模型和 MCP 配置保留；刚断开模型或取消 MCP、尚未被轮询处理的操作会在此时生效。所有权记录保留，下一次启动可继续管理。保留配置不代表网关仍在线，使用 Magpie 网关的模型仍需要网关运行。

在包目录中运行 `node cli.mjs status` 可查看已记录的状态和待恢复事务，不会写入配置；`node cli.mjs sync` 按当前输入同步一次；`node cli.mjs restore` 主动还原受管字段并暂停未变化的输入，适用于手动还原或 Magpie 在执行断开操作前被强制结束的情况。`restore` 不会移除资源库管理的技能。

`sync` 会遵守已有的暂停状态，不会强制重新连接；修改模型或 MCP 输入后可恢复同步。遇到 `conflict` 时先根据 `code` 排查配置或路径问题，再重试。保留所有权记录和待恢复日志，以便还原字段或完成中断的事务。状态输出不包含配置正文、网关地址或密钥；冲突或运行错误的退出码为 1，参数错误为 2。
