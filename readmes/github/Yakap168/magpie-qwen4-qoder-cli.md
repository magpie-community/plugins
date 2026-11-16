# Qwen4-Max via Qwen Code (Qoder) for magpie

[![magpie plugin](https://img.shields.io/badge/magpie-plugin-2a78d6)](https://usemagpie.ai/docs/plugins)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-Yakap168%2Fmagpie--qwen4--qoder--cli-181717?logo=github)](https://github.com/Yakap168/magpie-qwen4-qoder-cli)

**把本机 Qwen Code CLI 的 Qwen4-Max 接进 Magpie，消耗 Qwen Code 自己的限时免费额度。**

这是一个 CLI 包装型 Magpie Provider 插件：每条请求调用一次本机 `qwen -p`，
把官方 `-o json` 输出转成 OpenAI Chat Completions 响应。它不复制 OAuth token，
也不调用 Qwen Code 的私有 HTTP 接口。

---

## Qoder 和 Qwen Code CLI 的区别

**Qoder** 是阿里的一套 AI 编程产品（桌面端、JetBrains 插件、Qoder CLI 等），有自己的账号体系和 **Qoder Credits**。在 Qoder 里用 `qoder-cn/qmodel_latest`，扣的是 Qoder CN 套餐的 Credits。

**Qwen Code CLI** 是另一个开源命令行工具（`QwenLM/qwen-code`）。它的 1.0 预览支持用 **Qoder 账号登录**，但领取的是 **Qwen Code 自己的 Qwen4 限时免费体验额度**，不是 Qoder 的 Credits。两者可以用同一个 Qoder 账号登录，但计费池不同。

本插件调用的是本机 `qwen` 命令，所以走的是 **Qwen Code CLI 的额度路径**：请求由 Qwen Code 发出，不经过 Qoder 桌面端/Qoder CLI 的 Credits 计费。实测通过本插件请求后，Qoder CN 套餐 Credits 保持 2811/3300 不变。

所以：

- Magpie 里的 `qoder-cn/qmodel_latest` = Qoder 套餐额度。
- 本插件的 `qwen4-qoder/qwen4-max` = Qwen Code CLI 的额度。

不要把两者混为一谈。同一个 Qoder 账号可以同时登录 Qoder 和 Qwen Code CLI，但两边额度不互通。

---

## 功能

- **Qwen4-Max 接入 Magpie** —— 模型名 `qwen4-qoder/qwen4-max`。
- **复用本机登录** —— 读取 `~/.qwen/qoder_oauth_creds.json` 的 Qwen Code 登录态，不复制 token。
- **走 Qwen Code 额度** —— 请求由本机 `qwen -p` 发出，和你在终端里用 Qwen Code 是同一条路径。
- **官方 CLI 接口** —— 只用 `-p` / `-o json` / `--tools ""` 等公开参数。
- **流式兼容** —— `stream: true` 返回一个 SSE 块，Magpie 和多数 OpenAI 客户端可接受。
- **单进程串行** —— 插件内部排队，避免同时启动多个 Qwen Code 进程。

---

## 思考强度

插件把请求里的 `reasoning_effort`（也兼容 `reasoningEffort`、`reasoning.effort`、`thinking.effort`）传给 `qwen --reasoning-effort`：

- `none` / `off`：关闭思考
- `low` / `minimal`：低
- `medium`：中
- `high`：高（未指定时的默认值）
- `xhigh` / `max`：最高

Magpie 模型选择器里会列出 none / low / medium / high / xhigh。

---

## 模型

| 模型 | ID | 上下文 | 输出 | 说明 |
|---|---|---:|---:|---|
| Qwen4-Max | `qwen4-qoder/qwen4-max` | 1,000,000 | 393,216 | 映射到 Qwen Code 的 `qmodel_latest` |

文本 only；不转发图片、不暴露工具调用。

---

## 要求

- 已安装 **Qwen Code CLI**（`qwen` 命令可用）。
- 已在 Qwen Code 里登录：运行 `qwen`，`/auth` → Qoder → 完成授权。
- 在终端里 `qwen -p "只回复 OK"` 能正常返回。

---

## 安装

在 Magpie 里：

```bash
magpie plugin add github:Yakap168/magpie-qwen4-qoder-cli
```

如果 `github:` 安装遇到 GitHub tarball 连接问题（国内网络常见），改用 `git clone`：

```bash
git clone https://github.com/Yakap168/magpie-qwen4-qoder-cli
magpie plugin add ./magpie-qwen4-qoder-cli
```

本地开发：

```bash
magpie plugin add ./magpie-qwen4-qoder-cli
```

> 目前只发布在 GitHub，未发布到 npm。

然后给 `Qwen4-Max via Qwen Code` 添加账号：

```bash
magpie plugin login qwen4-qoder
```

API Key 一栏随便填，例如 `local`。插件不使用这个值，只把它当作“已登录”标记。

---

## 使用

```bash
magpie claude qwen4-qoder/qwen4-max
```

或在 Magpie UI 里选 **Qwen4-Max via Qwen Code → Qwen4-Max**。

检查：

```bash
magpie models | grep qwen4
magpie accounts | grep qwen4
```

---

## 限制

- **慢**：每条请求启动一个 CLI 进程，短提示约 2–15 秒。
- **文本 only**：不转发图片、不暴露工具调用；Claude Code / Codex 这类依赖工具循环的 Agent 可能不好用。
- **伪流式**：`stream: true` 只返回一个 SSE 块，不是逐 token 流。
- **一次一条**：插件内部串行执行。
- **额度在 Qwen Code 侧**：精确余额请在 Qwen Code 终端里 `/usage` 查看。
- **非官方**：不是阿里/Qwen 官方插件；走的是公开的 `qwen -p` 接口。

---

## 工作原理

```text
Magpie / Agent
  → OpenAI Chat Completions 请求
  → 本插件把 messages 拼成一个 prompt
  → qwen -p <prompt> -m qmodel_latest -o json --tools ""
  → 解析 result
  → 返回 OpenAI Chat Completions（或单个 SSE 块）
```

支持环境变量：

- `QWEN_CODE_BIN` —— 覆盖 `qwen` 可执行文件路径。

默认查找顺序：

1. `QWEN_CODE_BIN`
2. `~/.qwen/bin/qwen/qwen(.exe)`
3. PATH 里的 `qwen`

---

## 参考源

- [Magpie 插件文档](https://usemagpie.ai/docs/plugins)
- [Magpie 插件脚手架](https://github.com/MYCF711/magpie-plugin-scaffold)
- [Qwen Code CLI 文档](https://qwenlm.github.io/qwen-code-docs/1.x/zh/users/authentication/)
- 插件形态参考：[`@r4coder/magpie-plugin`](https://www.npmjs.com/package/@r4coder/magpie-plugin)（MIT）

---

## 许可

MIT。见 [LICENSE](LICENSE)。

> 更新记录：[CHANGELOG.md](./CHANGELOG.md)
