# agent-getkiki

`@magpie-community/agent-getkiki` adds [Kiki](https://getkiki.ai), the Mac app where one chief of staff runs a team of AI agents, to magpie's Agents page. Pick a model on Kiki's row and Kiki (and every team member in it) goes through magpie's local gateway, with every provider, subscription and account failover magpie has.

把 [Kiki](https://getkiki.ai)（Mac 上的 AI 首席秘书，带一支 AI 团队）接进 magpie 的 Agent 页：在 magpie 里给 Kiki 选一个模型，Kiki 和所有团队成员就都走 magpie 的本地网关。

> Not the same product as [X-T-E-R/kiki](https://github.com/X-T-E-R/kiki) and its `magpie-agent-kiki` (an open-source workbench, config in `~/.kiki`). This is the getkiki.ai Mac app, data in `~/kiki-data`, so its id is `getkiki`.
> 跟 X-T-E-R/kiki 的 `magpie-agent-kiki` 不是同一个产品：那个配置在 `~/.kiki`；这个是 getkiki.ai 的 Mac App，数据在 `~/kiki-data`，所以 id 叫 `getkiki`。

## Install / 安装

```sh
magpie plugin add @magpie-community/agent-getkiki
```

Or open Plugins → Discover in magpie and search for Kiki. 或者在 magpie 里打开 插件 → 发现，搜 Kiki。

## What it writes / 它改什么

| File | What |
| --- | --- |
| `~/kiki-data/engine/models.json` | One provider, `magpie`: the gateway address, magpie's key for Kiki, every model magpie gives Kiki |
| `~/kiki-data/.env` | `MODEL=magpie/<provider>/<model>`, the model Kiki starts on |

Turn Kiki's row off in magpie, or pick Kiki's own model again, and both files go back as they were. Kiki's other providers, keys and settings are left alone.

Kiki reads its model when it starts: quit Kiki (⌘Q) and open it again. After that magpie's models are also in Kiki's own model menu.

Kiki 启动时读模型，换完要 ⌘Q 退出再打开。在 magpie 里关掉 Kiki 那一行，两个文件都恢复原样。

A Kiki whose data folder is not `~/kiki-data` (`DATA_DIR` set) is not found yet.

## Test

```sh
bun test getkiki.test.mjs
```
