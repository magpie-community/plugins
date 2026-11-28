# magpie-agent-nibi

[magpie](https://github.com/yetone/magpie) 的 Agent 插件：把 [NIBI](https://github.com/nibistudio)（ZCode 系桌面客户端）接到 magpie 的 **Agent 页**——勾选 magpie 的模型，它们就会出现在 NIBI 的模型菜单里，一个额度用完自动切下一个。

A magpie agent plugin that adds NIBI (a ZCode-family desktop client) to magpie's Agents page: tick magpie's models there and they are hot-applied into NIBI's provider list.

## 安装 / Install

- **magpie 插件市场**：扩展 → 插件 → 发现，搜 “NIBI”（GitHub 上带 `magpie-plugin` 话题，标记为未审核）。
- **命令行**：`magpie plugin add github:Ebonyhtx/magpie-agent-nibi`

装好后，magpie 的 Agent 页会出现 **NIBI** 一行；打开「接入」，勾选要给 NIBI 用的模型。

## 怎么工作 / How it works

NIBI 的供应商存在 `~/.nibi/v2/provider_config.json` 的**数组**里，而 magpie 写 agent 配置用的点号路径遇到数组会整体替换——直接写会毁掉你已有的其他供应商。所以这个插件和 Deva 插件一样分两层：

1. **`nibi.agent.js`**（跑在 magpie 的 moejs 沙箱里）：声明 agent，`connect()` 把网关地址、密钥和勾选的模型写进 **magpie 自己的暂存文件** `~/.nibi/.magpie-agent.json`，从不碰 NIBI 的配置。
2. **`index.mjs`**（magpie 托管的 Bun 子进程）：每 2 秒把暂存文件应用到 NIBI 的 `provider_config.json`——精确地加/拆 magpie 的 provider 规则和每模型规则，你手动设置过的模型规则（manual rules）与其他供应商一律不动。

NIBI 每秒热轮询这份文件（继承自 ZCode），所以**写入即生效，无需重启 NIBI**。在 magpie 里断开接入（或关掉 NIBI 行的开关），插件会把 magpie 加的条目整条拆下，恢复原状。

在 NIBI 里：**新任务 → 模型菜单 → magpie 供应商** 下选模型；用量在 magpie 的用量页记在 `nibi` 名下。

## 边界 / Notes

- 需要 NIBI 至少启动过一次（有 `~/.nibi` 数据根）。
- 设置了 `NIBI_DATA_BASE_DIR` 的也支持：插件写 `<NIBI_DATA_BASE_DIR>/.nibi/v2/provider_config.json`。
- magpie 退出后 NIBI 里会留下指向已关闭网关的 magpie 供应商（请求会失败）——这是暂存文件方案固有的；在 magpie 里断开即可清理。
- 只在本机文件之间搬运数据，无网络请求、无遥测。

## 开发 / Development

```sh
npm test        # node --test test/
```

规则手术的核心逻辑在 `lib/nibi-config.mjs`（纯函数、可单测）：接线、拆线、幂等、保留用户手动规则与在 NIBI 里改过的名字/开关。

## 许可 / License

MIT
