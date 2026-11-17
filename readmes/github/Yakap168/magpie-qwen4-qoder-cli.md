# Qwen4-Max via Qwen Code (Qoder) for magpie

[![magpie plugin](https://img.shields.io/badge/magpie-plugin-2a78d6)](https://usemagpie.ai/docs/plugins)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-Yakap168%2Fmagpie--qwen4--qoder--cli-181717?logo=github)](https://github.com/Yakap168/magpie-qwen4-qoder-cli)

**把本机 Qwen Code CLI 的 Qwen4-Max 接进 Magpie，消耗 Qwen Code 自己的限时免费额度。**

这是一个 CLI 包装型 Magpie Provider 插件：每条请求调用一次本机 `qwen -p`，
把官方 `-o json` 输出转成 OpenAI Chat Completions 响应。支持文本、图片和工具调用；
它不复制 OAuth token，也不调用 Qwen Code 的私有 HTTP 接口。

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
- **官方 CLI 接口** —— 只用 `-p` / `-o json` / `--tools ""` / `--attachment` 等公开参数。
- **图片输入** —— OpenAI `image_url` / `input_image` 内容块，支持 data URL 和 http(s) URL，最多 4 张、单张 20 MB。
- **工具调用** —— 支持 OpenAI `tools` / `tool_choice`，把 schema 注入 prompt，解析模型返回的 JSON 成标准 `tool_calls`；支持 tool 结果回传。
- **流式保活** —— `stream: true` 立即返回 SSE 心跳；经过 Magpie 网关时上游数据可能被缓冲，但单次 CLI 默认限制在 540 秒内，低于 dsh 的 600 秒 idle timeout。
- **有界并发** —— 默认最多 2 条 CLI 请求并行，可用 `MAGPIE_QWEN_CONCURRENCY` 调整。

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

## 工具调用

请求里带 `tools` 时，插件会把工具 schema 注入 prompt，要求模型只返回：

```json
{"tool_calls":[{"name":"...","arguments":{...}}]}
```

插件解析后返回标准 OpenAI `tool_calls`；下一轮把 assistant `tool_calls` 和 `tool` 结果映射回 prompt。支持 `tool_choice` 的 none / auto / required，以及多个 `tool_calls`。

这是 prompt-based，不是 Qoder 原生 tool_calls；复杂 schema 或并行工具可能不如原生稳定。已用 `get_weather` 做过两轮完整回环测试：第一轮返回 `tool_calls`，第二轮根据 tool 结果回答。

---

## 文件修改

Magpie 里的 Qwen Code 是 **Provider**，文件由外层 Agent 执行工具写入，不是模型自己在磁盘上写。DSH 提供 `write` / `edit` / `read` / `pwsh` 等工具；插件把工具 schema 注入 prompt，模型返回标准 `tool_calls`，由 DSH 执行。

已用 DSH 的完整 39 个工具测试：请求“创建 `D:\ds.harness\_tmp\qwen-tool-test.txt`，写入 hello”，模型返回：

```json
{"name":"write","arguments":{"file_path":"D:\\ds.harness\\_tmp\\qwen-tool-test.txt","content":"hello"}}
```

DSH 执行 `write` 后文件就会落盘；下一轮把 tool 结果回传，模型继续回答。之前这里会报 `ENAMETOOLONG`，因为 40KB 的 prompt 被当成命令行参数传给 `qwen`；v0.1.6 改为通过 stdin 传入，已修复。

---

## 图片输入

支持 OpenAI 兼容的图片内容块（`image_url` / `input_image`），来源可以是 data URL 或 http(s) URL。插件会把图片写入临时文件，通过 `qwen --attachment <file>` 传给 Qwen Code CLI，请求结束后删除。最多 4 张，单张 20 MB；视频/音频暂不支持。

---

## 模型

| 模型 | ID | 上下文 | 输出 | 说明 |
|---|---|---:|---:|---|
| Qwen4-Max | `qwen4-qoder/qwen4-max` | 1,000,000 | 393,216 | 文本 + 图片 + 工具调用；映射到 Qwen Code 的 `qmodel_latest` |

支持文本、图片和工具调用。

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
- **工具调用是 prompt-based**：不是 Qoder 原生 tool_calls；依赖 Qwen4 按 JSON 格式返回，复杂 schema 或并行调用可能不如原生稳定。
- **文件由外层 Agent 写**：插件只返回 `tool_calls`，DSH 执行 `write` / `edit`；插件本身不直接改文件。
- **usage 是估算**：`prompt_tokens` 取自 `context_usage_ratio × 1M`（缺失时按 prompt 字符数/4），`completion_tokens` 按返回字符数/4。
- **不是逐 token 流**：CLI 完成后一次性发正文；等待期间用心跳保活。
- **默认 540 秒 CLI 超时**：低于 dsh 的 600 秒 stream idle timeout；`xhigh` 长任务通常约 2–3 分钟。可用 `MAGPIE_QWEN_CLI_TIMEOUT_MS` 调整，但不建议超过 600000，否则客户端可能先超时。
- **额度在 Qwen Code 侧**：精确余额请在 Qwen Code 终端里 `/usage` 查看。
- **非官方**：不是阿里/Qwen 官方插件；走的是公开的 `qwen -p` 接口。

---

## 工作原理

```text
Magpie / Agent
  → OpenAI Chat Completions 请求
  → 本插件把 messages 拼成一个 prompt；有 tools 时注入 schema
  → qwen -p -m qmodel_latest -o json --tools "" [--attachment <image>]
     （prompt 通过 stdin 传入，避免 Windows 命令行长度限制）
  → 解析 result；如果是 JSON tool_calls 就转成 OpenAI tool_calls
  → 返回 OpenAI Chat Completions（或 SSE 流 + 心跳）
```

支持环境变量：

- `QWEN_CODE_BIN` —— 覆盖 `qwen` 可执行文件路径。
- `MAGPIE_QWEN_CLI_TIMEOUT_MS` —— CLI 超时，默认 `540000`（9 分钟，低于 dsh 的 600 秒 idle timeout）。
- `MAGPIE_QWEN_KEEPALIVE_MS` —— SSE 心跳间隔，默认 `15000`（15 秒）。
- `MAGPIE_QWEN_CONCURRENCY` —— 同时运行的 CLI 数，默认 `2`。
- `MAGPIE_QWEN_DEBUG` —— 设为 `1` 时记录思考档位字段到临时日志（不记录 prompt）。

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
