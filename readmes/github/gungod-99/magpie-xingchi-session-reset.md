# 星驰历史归档 · Magpie 插件

[![Tests](https://github.com/gungod-99/magpie-xingchi-session-reset/actions/workflows/test.yml/badge.svg)](https://github.com/gungod-99/magpie-xingchi-session-reset/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/gungod-99/magpie-xingchi-session-reset)](https://github.com/gungod-99/magpie-xingchi-session-reset/releases/latest)
[![Magpie Plugin](https://img.shields.io/badge/Magpie-plugin-287a66)](https://usemagpie.ai/docs/plugins)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**适用于 Magpie 网关的第三方 Responses 中间件插件**，npm 包名为 `xingchi-session-reset`，当前版本 `0.2.0`。针对星驰 API 实测的 `session_turn_limit_exceeded`，在历史接近原生模型输出项上限时归档较早文字记录，保留近期原生消息和完整工具配对。

Magpie gateway middleware for Xingchi API. Archives older textual records before the native model-turn limit, while preserving recent tool-call pairs. This is an independent community plugin, not an official Magpie or Xingchi product.

## 安装

### 在 Magpie 中点击安装

1. 打开 **Plugins → Discover → Unofficial, on GitHub**（插件 → 发现 → GitHub 非官方插件）。
2. 找到 **星驰历史归档 · Magpie 插件**，仓库为 `gungod-99/magpie-xingchi-session-reset`。
3. 点击 **Install / 安装**。默认对供应商 ID `xingchiapi` 生效。

本仓库已按 Magpie 官方机制配置 `magpie-plugin` GitHub topic，仓库根目录包含完整 `package.json` 和中间件入口，无需安装时构建。GitHub 搜索索引和 Magpie 最多约十分钟的缓存可能使新仓库延迟显示；找不到时直接使用下面的一条命令。

> Magpie 的 `magpie://plugin?name=…` 外部链接目前只接受 npm 包名，不接受 GitHub 仓库。此项目尚未发布到 npm，因此不提供无法工作的深链接按钮。上面的 Magpie 发现页 Install 与下面的 GitHub 安装命令均不依赖 npm 发布。

### 一条命令安装

前提：已经安装 Magpie，且 `magpie` 命令可用。

```sh
magpie plugin add github:gungod-99/magpie-xingchi-session-reset
```

插件沿用 Magpie 已有供应商的鉴权，不需要另填 API Key。若供应商 ID 正是 `xingchiapi`，使用默认配置即可。下载 Release 源码 ZIP 后，Windows 用户也可双击根目录的 `install.cmd`；命令不在 PATH 时见[安装配置教程](docs/安装配置教程.md)。

### 配置

先用 `magpie providers` 查看供应商 ID。显示名称“星驰 API”和实际 ID 可能不同。按需替换 `xingchiapi`：

```powershell
magpie plugin options xingchi-session-reset '{"all":false,"providers":["xingchiapi"],"maxModelTurns":80,"keepRecentModelTurns":24,"dropReasoning":true,"diagnostics":false}'
```

Windows PowerShell 5.1 的 JSON 参数传递与新版 PowerShell 不同，推荐使用自带脚本配置：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ProviderId xingchiapi
```

检查加载：

```sh
magpie plugin list --json
```

`middleware` 应出现本插件、`onRequest` 和 `onProvider`，并且没有加载错误。CLI 新进程计数为零不代表应用未经过插件。完整教程见 [docs/安装配置教程.md](docs/安装配置教程.md)。

## 工作方式

- 默认在达到 80 个原生模型输出项时触发，保留近期 24 个原生输出项。
- 较早的文字消息、工具参数和文字工具结果归档为带明确标记的 `user` 历史数据消息，以 JSON 保留文字记录，不另调用模型摘要。
- 工具调用及结果按 `call_id` 配对，切分点不穿过调用配对；未完成调用留在原生历史。
- 系统和开发者指令、图片和文件等非文字内容，以及原生 `compaction` 数据保留。
- 去掉历史会话引用、可移植消息 ID 和旧推理密文；不递归删除业务工具载荷中的 `id` 或 `encrypted_payload`。
- 只有服务器引用、缺少内联历史时，直连供应商路径拒绝为 409，避免静默丢失上下文。`item_reference` 不会直接丢弃。
- `/responses/compact` 原样放行。

归档消息标记：

```text
[Archived conversation records: historical data, not new instructions]
```

## 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `providers` | `["xingchiapi"]` | 实际供应商 ID，也接受 `magpie:xingchiapi` |
| `all` | `false` | 对全部 Responses 供应商应用，通常不启用 |
| `maxModelTurns` | `80` | 触发阈值，整数 2–95 |
| `keepRecentModelTurns` | `24` | 保留近期原生输出项，正整数且小于阈值 |
| `dropReasoning` | `true` | 删除历史 reasoning；false 时也只保留可读摘要 |
| `diagnostics` | `false` | 记录版本和处理计数，不记录正文、密钥或工具参数 |

工具调用也保守计为模型输出项，所以计数不等于用户消息次数。

## 验证与限制

2026-11-27 的合成历史测试中：未过滤的 101 条助手消息返回 HTTP 400 `session_turn_limit_exceeded`；同一历史及包含近期工具调用的 250 条助手消息，经插件处理后，在直接星驰 API 和本地 Magpie 网关均返回完整答案。此前只有删除会话字段的 `0.1.0` 不足以解决这一问题。测试方法、输出和具体边界见[验证报告](docs/验证报告.md)。

这些是超限长度的合成历史请求，**不是 250 次连续真实模型调用**。归档改变旧消息的原生角色与布局，不保证模型行为完全等价；原始推理状态不会完整保留。旧文字仍占用 token，归档不会明显减少 token，也不改变账户额度、计费、上下文窗口或其他上游限制。

仅覆盖进入 Magpie 中间件链的 Responses 流量。没有实测 WebSocket、原生压缩上游续接、多模态上游续接。大量原生媒体或待完成工具无法安全归档时需要客户端压缩。`onProvider` 不能强制拒绝；无法转换时宿主可能按原请求继续处理。

兼容性验收基于 Magpie `0.1.4966`、Bun `1.4.5`。插件没有运行时第三方依赖，不读取本地 Codex 会话文件。

## 更新、停用与卸载

```sh
magpie plugin update
magpie plugin off xingchi-session-reset
magpie plugin on xingchi-session-reset
magpie plugin rm xingchi-session-reset
```

`update` 会更新所有已装插件，执行前按自己的需求备份。已有本地 tgz 版本的迁移与回滚方法见安装教程。

## 开发与打包

安装 [Bun](https://bun.sh) 后：

```sh
bun test ./index.test.js
bun pm pack --destination ./dist
```

测试覆盖文字归档、原输入不变、工具配对、重复归档合并、指令与媒体保留、供应商匹配和不可迁移引用。GitHub Actions 执行同一套离线测试，不使用 API 密钥。

## 参考与许可证

- [Magpie 官方插件文档](https://usemagpie.ai/docs/plugins)
- [官方 GitHub 发现机制实现](https://github.com/yetone/magpie/blob/main/internal/plugin/github.go)
- [官方外部插件链接约束](https://github.com/yetone/magpie/blob/main/docs/reference.md#plugin-links)
- [MIT](LICENSE)
