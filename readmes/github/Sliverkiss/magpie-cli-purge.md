<p align="center"><img src="icon.png" width="88" height="88" alt=""></p>

# magpie-cli-purge

[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![author](https://img.shields.io/badge/author-Sliverkiss-8A2BE2)](https://github.com/Sliverkiss)
[![magpie](https://img.shields.io/badge/magpie-插件-00ADD8)](https://usemagpie.ai)

**人设改写插件** —— [magpie](https://usemagpie.ai) 专用。

把经过 magpie 网关的 agent 请求里的系统提示词换成你自己的人设：Claude Code、Codex、pi、omp、dsh、grok 等 78 家经网关的 agent 全部生效；pi / omp 额外在进程内再装一层原生扩展。

## 功能

- **一个开关，零配置** —— 不用填 agent 名、模型名或任何名单
- **三档模式** —— `append`（人设挂最前）/ `strict`（宿主提示词整段丢掉）/ `off`
- **人设库** —— 导入带 frontmatter 的 Markdown，各 agent 共用，换人设不用重启
- **只改对话轮** —— 意图判断、自动审批、标题、压缩等旁路请求被门禁放行，不改
- **pi / omp 原生层** —— 进程内拿到拼好的最终提示词整段替换，与网关层不叠两遍
- **四协议** —— anthropic / chat / responses / gemini，块结构原地保留，Anthropic 缓存断点不丢
- **fail-open** —— 钩子出错一律原样放行

## 快速开始

```bash
magpie plugin add github:Sliverkiss/magpie-cli-purge
```

打开 **Plugins → CLI Purge**（中文：**破限**），打开开关即可。

## 模式

| 模式 | 发给模型的系统提示词 |
|---|---|
| `append` | 人设 + 宿主提示词（默认） |
| `strict` | 人设 + 仅工作目录 |
| `off` | 原样 |

`strict` 会丢掉项目上下文与工具说明（工具仍可用，harness 会变笨一点）。

## 人设

页面 **Library → 人设 → 导入文件…** 选一个 `.md` / `.txt`：

```markdown
---
name: my-assistant
description: 一句话说明
---
正文，会进系统提示词。
```

正文归磁盘文件，页面只做导入与选中；单个上限 256KB。

## 开发

```bash
node --test    # 114 条
```

## 免责声明

只改本机 magpie 转发请求的系统提示词文本，不改变模型本身，也不保证任何绕过模型安全策略的效果；provider 的使用条款仍然适用。仅供学习研究与合法的提示词工程使用，风险自负。

## 许可证

MIT © Sliverkiss
