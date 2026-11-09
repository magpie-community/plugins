# magpie-hindsight

[English](#english) · [中文](#中文) · Apache-2.0

<a id="english"></a>
## English

Automatic [Hindsight](https://github.com/vectorize-io/hindsight) memory for clients behind [Magpie](https://github.com/yetone/magpie), implemented as an **asynchronous gateway hook**.

Before each new user turn, the plugin recalls related memories once and attaches the block to that user message. The block is replayed unchanged through the turn's tool loop, so the provider prompt cache keeps working. After a completed answer, it can retain the current user/assistant turn. **Capture is disabled by default.**

```text
Agent client ──► Magpie + magpie-hindsight ──► model provider
                         │
                         └──────────────► Hindsight HTTP API
                                          recall / optional retain
```

### Why a gateway plugin?

Hindsight's official **Agent Plugins and tool integrations** run inside a specific agent and expose operations such as `recall_memory` and `retain_memory` as **explicit tools** for that agent to call. This Magpie plugin works at a different layer: Magpie automatically recalls before inference, without adding tools or changing each client. Optional capture also happens at the gateway.

Use one memory-injection path at a time. Hermes Agent and DeepSeek Harness already have native automatic Hindsight injection, so this plugin **skips them by default** even with an empty `agents` list — memory is never injected twice. Name them in `agents` to force-enable, or set an allow-list of agents that have no native integration.

### Requirements

- Magpie with asynchronous gateway hooks (`magpie.hooks`), v0.1.1273 or newer.
- Bun 1.3.8 or newer; Magpie can manage its plugin runtime.
- A Hindsight server exposing the `/v1/default/banks/{bank_id}/memories` API.
- Node.js 22 or newer only if you want to run this repository's tests.

### Install

```sh
magpie plugin add @magpie-community/gateway-hindsight
magpie plugin list
```

For a source checkout:

```sh
magpie plugin add /path/to/magpie-hindsight
```

### Options

```sh
magpie plugin options @magpie-community/gateway-hindsight '{
  "hindsight_api": "http://127.0.0.1:8888",
  "bank": "hermes",
  "recall_max_tokens": 1024,
  "capture": false,
  "agents": [],
  "gatewayTimeoutMs": 5000
}'
```

| Option | Default | Meaning |
| --- | --- | --- |
| `hindsight_api` | `http://127.0.0.1:8888` | Hindsight HTTP API base URL. Do not append `/v1`; the plugin builds the full path. |
| `bank` | `hermes` | Existing Hindsight bank ID used for both recall and capture. The default reuses `hermes`; no dedicated plugin bank is needed. Multi-bank users can select another existing bank. |
| `recall_max_tokens` | `1024` | Token budget sent to Hindsight recall (`max_tokens`). Integer from 1 to 16384. |
| `capture` | `false` | Opt in to retaining the completed current turn. |
| `agents` | `[]` | Case-insensitive exact `ctx.agent` names to process. Empty = all agents **except** `hermes` / `dsh`, which are skipped by default because they already inject Hindsight natively. |
| `gatewayTimeoutMs` | `5000` | Magpie's timeout for this hook (100–10000 ms). The plugin finishes its recall 200 ms earlier to fail open cleanly. |
| `allowRemote` | `false` | Required when `hindsight_api` is not loopback: recall sends the latest user message (up to 8 KB) to that host. |
| `allowInsecureHttp` | `false` | Additionally required for plain `http://` to a non-loopback host. |

`gatewayTimeoutMs` is a **Magpie host option**, not a Hindsight server setting. The 1000 ms host default is often too short for recall from a populated bank, so the plugin ships 5000 ms; clearing all options restores the host's 1000 ms default.

Example: enable only agents without native injection, reusing the existing `hermes` bank:

```sh
magpie plugin options @magpie-community/gateway-hindsight '{"bank":"hermes","agents":["claude","codex","opencode"]}'
```

To force-enable an agent that has native injection (not recommended unless the native side is disabled):

```sh
magpie plugin options @magpie-community/gateway-hindsight '{"bank":"hermes","agents":["hermes"]}'
```

Restore runtime defaults:

```sh
magpie plugin options @magpie-community/gateway-hindsight off
```

### Behavior

- Supported wire protocols: OpenAI Chat Completions, Anthropic Messages, OpenAI Responses, and Gemini.
- Only host-classified local requests (`ctx.origin === "local"`) are processed.
- One recall per user turn: the query is `ctx.query` (client notices stripped by the host) or, when empty, the turn's text capped at 8192 characters, with Hindsight's `budget: "low"`. Tool-loop requests of the same turn reuse the cached block instead of recalling again.
- Memories are wrapped as untrusted historical evidence and appended to that turn's **user message**, never the system prompt, so the conversation prefix stays stable across tool-loop requests. They are not added as tools.
- An empty or failed recall leaves the model request unchanged. An Hindsight outage does not block inference.
- With `capture: true`, a successful final answer is retained with the latest user text as one item. The retain call uses `async: true`.
- Tool-call steps, failed requests, empty answers, and answers truncated by the output-token limit are not captured.
- The deterministic `document_id` includes the Magpie session and turn content. Metadata contains only source, agent name, and protocol.

### Cost, latency, and privacy

**Each new user turn adds one Hindsight recall request and its latency.** Recalled memories consume model input tokens, but a turn's block is sticky across its tool loop, so provider prompt-cache reuse is preserved instead of being invalidated on every request.

Recall sends the latest user text (up to 8 KB) to the configured Hindsight server on every new turn. With capture enabled, the final assistant answer is also sent, and Hindsight performs memory extraction after completed turns, which can incur its own model usage. A non-loopback server requires `allowRemote: true`, and plain HTTP to it also requires `allowInsecureHttp: true`; this plugin does not add authentication headers or TLS by itself. Keep capture off unless you want this data stored.

### Known limitations

- The plugin processes local Magpie callers only; there is no remote-caller opt-in.
- Capture stores the current user/assistant turn, not a whole conversation or tool transcript.
- Anthropic, Responses and Gemini paths are covered by mock unit tests only; Chat Completions is the only protocol verified end to end so far.
- Hindsight does not guarantee idempotency for this plugin's generated `document_id`; unusual retries can still create duplicates.
- Recalled text is marked untrusted, but no wrapper can make hostile memory content completely safe. Review bank contents and access controls.

### Development and verification

```sh
npm test
npm run check
```

The tests use mocked Hindsight responses and cover defaults, agent filtering, user-turn attachment, fail-open recall, default-disabled capture, opt-in retain payloads, and truncated-answer rejection. Unit tests are not a substitute for acceptance against your own Magpie/Hindsight versions.

**Release acceptance:** Chat Completions was exercised through a local Magpie gateway against the existing `hermes` bank on Hindsight HTTP API 1.1.0, with `gatewayTimeoutMs: 5000`. The model returned a public account name available only from recall; opt-in retain was read back through Hindsight document chunks; with `capture` omitted, a completed `stop` turn created no matching document. The other protocols currently have mocked unit coverage only.

### AI participation

This project was developed with AI assistance, including implementation, tests, and documentation. Runtime behavior must still be reviewed and verified in your own environment before handling sensitive conversations.

### License

[Apache-2.0](LICENSE) · © 2024-2026 Sam-Dancing™

---

<a id="中文"></a>
## 中文

这是一个基于 **Magpie 异步网关 hooks** 的 [Hindsight](https://github.com/vectorize-io/hindsight) 记忆插件。

每个新的用户轮次，插件只召回一次相关记忆，并把记忆块附加到该轮用户消息上；同一轮的工具循环中注入保持逐字不变（sticky），模型提供方的 prompt cache 不会失效。收到完整回答后，可选地 retain 当前用户/助手轮次。**采集默认关闭。**

```text
Agent 客户端 ──► Magpie + magpie-hindsight ──► 模型提供方
                        │
                        └──────────────► Hindsight HTTP API
                                         召回 / 可选采集
```

### 与 Hindsight 官方 Agent Plugins 的区别

Hindsight 官方 **Agent Plugins 和工具集成**位于具体 Agent 内，通常把 `recall_memory`、`retain_memory` 等操作暴露为**显式工具调用**。本插件位于网关层：Magpie 在推理前自动召回，不需要给客户端增加工具，也不要求每个 Agent 单独接入；可选采集同样发生在网关层。

同一时间只走一条记忆注入链路。Hermes Agent 和 DeepSeek Harness 自带 Hindsight 自动注入，所以本插件**默认跳过它们**——即使 `agents` 为空也不会重复注入。想强制开启就把它们写进 `agents`，或者只给没有原生集成的 Agent 配白名单。

### 环境要求

- 支持异步网关 hooks（`magpie.hooks`）的 Magpie，v0.1.1273 或更新版本。
- Bun 1.3.8 或更新版本；插件运行时可由 Magpie 管理。
- 提供 `/v1/default/banks/{bank_id}/memories` API 的 Hindsight 服务。
- 仅在运行本仓库测试时需要 Node.js 22 或更新版本。

### 安装

```sh
magpie plugin add @magpie-community/gateway-hindsight
magpie plugin list
```

从源码目录安装：

```sh
magpie plugin add /path/to/magpie-hindsight
```

### 配置

```sh
magpie plugin options @magpie-community/gateway-hindsight '{
  "hindsight_api": "http://127.0.0.1:8888",
  "bank": "hermes",
  "recall_max_tokens": 1024,
  "capture": false,
  "agents": [],
  "gatewayTimeoutMs": 5000
}'
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `hindsight_api` | `http://127.0.0.1:8888` | Hindsight HTTP API 根地址。不要附加 `/v1`，插件会构造完整路径。 |
| `bank` | `hermes` | recall 和 capture 共用的现有 Hindsight bank ID。默认直接复用 `hermes`，无需插件专用 bank；多 bank 用户可选择另一个现有 bank。 |
| `recall_max_tokens` | `1024` | 发送给 Hindsight recall 的 `max_tokens` 预算，范围 1–16384。 |
| `capture` | `false` | 显式开启后才 retain 完整结束的当前轮次。 |
| `agents` | `[]` | 要处理的 `ctx.agent` 名称，大小写不敏感精确匹配；空数组 = 全部 Agent，**但默认跳过**已有原生注入的 `hermes` / `dsh`。 |
| `gatewayTimeoutMs` | `5000` | Magpie 给本 hook 的超时时间（100–10000ms）。插件会提前 200ms 结束自身 recall，以便干净地失败放行。 |
| `allowRemote` | `false` | `hindsight_api` 非 loopback 时必须显式开启：recall 会把最新用户消息（最多 8KB）发往该主机。 |
| `allowInsecureHttp` | `false` | 非 loopback 且为纯 `http://` 时还需额外开启。 |

`gatewayTimeoutMs` 是 **Magpie 宿主选项**，不是 Hindsight 服务端配置。宿主默认 1000ms 对记忆较多的 bank 常常不够，因此插件默认 5000ms；清空全部选项会恢复宿主的 1000ms。

示例：只给没有原生注入的 Agent 开启，复用现有 `hermes` 库：

```sh
magpie plugin options @magpie-community/gateway-hindsight '{"bank":"hermes","agents":["claude","codex","opencode"]}'
```

要强制覆盖某个自带注入的 Agent（不推荐，除非原生侧已关）：

```sh
magpie plugin options @magpie-community/gateway-hindsight '{"bank":"hermes","agents":["hermes"]}'
```

清除已保存配置并恢复运行时默认值：

```sh
magpie plugin options @magpie-community/gateway-hindsight off
```

### 工作方式

- 支持 OpenAI Chat Completions、Anthropic Messages、OpenAI Responses 和 Gemini 协议。
- 只处理宿主判定为本地的请求（`ctx.origin === "local"`）。
- 每个用户轮次只召回一次：查询优先用 `ctx.query`（宿主已剥离客户端环境通知），为空时取该轮文本，最多 8192 字符，并设置 Hindsight `budget: "low"`；同一轮的工具循环直接复用缓存块，不再召回。
- 记忆作为不可信历史资料包裹后附加到该轮**用户消息**，不进入 system prompt，工具循环前后对话前缀保持稳定。
- 召回为空或失败时保留原模型请求，Hindsight 故障不会阻断推理。
- `capture: true` 时，把最新用户文本和成功的最终助手回答作为一个 item retain；请求使用 `async: true`。
- 工具调用中间步、失败请求、空回答以及因输出 token 上限截断的回答不会采集。
- 确定性 `document_id` 包含 Magpie 会话和轮次内容的哈希；metadata 只包含来源、Agent 名称和协议。

### 成本、延迟与隐私

**每个新的用户轮次只增加一次 Hindsight recall 及其延迟。** 注入的记忆消耗模型输入 token，但同一轮的工具循环复用同一注入块，prompt cache 不会每步失效。

recall 会把最新用户文本（最多 8KB）发送到所配置的 Hindsight 服务；开启 capture 后还会发送最终助手回答。非 loopback 服务必须显式 `allowRemote: true`，纯 HTTP 还需 `allowInsecureHttp: true`；本插件自身不添加认证请求头或 TLS。不希望保存这些内容时保持 capture 关闭。

### 已知限制

- 仅处理 Magpie 本地调用方，没有开放远程调用方的开关。
- capture 只保存当前用户/助手轮次，不保存整段历史或工具调用记录。
- Anthropic、Responses、Gemini 目前仅有 mock 单元测试；只有 Chat Completions 做过真实端到端验收。
- Hindsight 不保证以本插件生成的 `document_id` 去重；异常重试仍可能产生重复记忆。
- 召回文本虽被标记为不可信，但包裹格式不能彻底消除恶意记忆的提示注入风险。请审查 bank 内容和访问权限。

### 开发与验证

```sh
npm test
npm run check
```

测试使用 mock Hindsight 响应，覆盖默认配置、Agent 过滤、用户轮次附加、召回失败放行、默认不采集、显式 retain 请求体，以及截断回答拒绝采集。单元测试不能替代你对自己 Magpie/Hindsight 版本的端到端验收。

**发布验收：** Chat Completions 已在 `gatewayTimeoutMs: 5000` 下，通过本地 Magpie 网关连接 Hindsight HTTP API 1.1.0 的现有 `hermes` bank 实测。模型返回了仅能从召回记忆得知的公开账号名；显式 retain 后通过 Hindsight 文档 chunk 回读到采集内容；省略 `capture` 配置时，一个完整 `stop` 轮次没有新增匹配文档。其他协议目前仅有 mock 单元测试覆盖。

### AI 参与声明

本项目在 AI 辅助下完成，包括实现、测试与文档。在处理敏感对话前，仍须在自己的环境中审查并验证实际运行行为。

### 许可证

[Apache-2.0](LICENSE) · © 2024-2026 Sam-Dancing™
