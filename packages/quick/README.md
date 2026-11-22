# Amazon Quick（quick.aws.com）

把 [Amazon Quick](https://quick.aws.com) 的对话模型接进 OpenCode 和
[magpie](https://usemagpie.ai)：用你 Quick 账号的浏览器会话，走 Quick 自己的
CBOR WebSocket 通道（`ChatBidirectionalStream`）对话，对上层暴露 OpenAI
Chat Completions 兼容接口。

> Unofficial, use at your own risk. This package is not affiliated with,
> authorized or endorsed by Amazon. "Amazon Quick" is a trademark of Amazon,
> used here solely to identify the service. The plugin drives the same
> WebSocket protocol the Quick web app itself uses, with your own imported
> session; it does not bypass captchas, rate limits or any platform
> restriction. The protocol is not documented and may change or stop working
> at any time. Usage is metered by the wall-clock minutes your turns take.

## 模型

Quick 的对话档位按 `agent_mode` 分三档，每档带全部思考档位：

| 模型 | agent_mode | 思考档位 | 上下文 |
|---|---|---|---|
| `quick-fast` | fast | off / low / medium / high / max | 1M |
| `quick-balanced` | balanced | off / low / medium / high / max | 1M |
| `quick-smart` | smart | off / low / medium / high / max | 1M |

- **思考档位每轮显式下发**（`thinking_effort`）。服务端对新会话默认关闭思考、
  对 smart 默认 medium，所以插件不依赖服务端默认值。`max` 在协议枚举里存在
  （UI 未露出）。
- 服务端每轮在 `turn_usage` 里回报**模型指纹**（`resolved_model_id` /
  `served_model_id`）、token 计数、`cost_usd` 与 `context_window`；插件原样放进
  每轮的元数据（OpenAI 侧是 `quick.*` 字段）。
- 计费按**回合墙钟时长**（分钟）计入配额，不是按 token。

## 登录方式

| 方式 | 做什么 | 给什么 |
|---|---|---|
| **一键登录（浏览器）** | 插件拉起**自己的专用浏览器**打开 quick.aws.com，你在里面登录（或复用上次留下的会话），插件自动读会话、识别账号、关窗 | 三档模型 + 会话/每月分钟池 |
| **Cookie 导入** | 粘贴 Quick 网页版的 `Cookie` 请求头（需含 `mbtc=…`），或粘贴账号 JSON | 三档模型 + 会话/每月分钟池 |

两种方式都用 `/profile/usage` 探活账号并读出用量池。

**一键登录的边界**（与 moss 插件同规则）：只用插件自己的专用 profile
（`%LOCALAPPDATA%\magpie\quick-browser`，可用 `MAGPIE_QUICK_PROFILE` 覆盖），
**绝不碰日常浏览器**——残留进程只按命令行里的 `--user-data-dir=<本插件
profile>` 精确匹配清理；会话 cookie 是 httpOnly 的，通过浏览器调试协议的
Network 域读取（`Network.getAllCookies`），不在页面里执行/注入任何代码；
登录窗口本身不带调试端口，保持普通浏览器形态。浏览器路径可用
`MAGPIE_QUICK_BROWSER` 指定。账号 id 与 csrf 由会话自动发现（带 cookie 访问
quick.aws.com 落到 `/sn/account/<id>/start/chat`，页面配置里带 csrf），无需
手动拼 URL。

### httpOnly Cookie 怎么拿（粘贴方式）

Quick 的会话 Cookie 是 httpOnly 的，`document.cookie` 读不到。两种拿法：

1. **DevTools**：打开 quick.aws.com → F12 → Network → 任意请求 → 复制请求头里
   的整条 `Cookie:` 值（确认里面有 `mbtc=…`）。
2. **浏览器扩展**（如 Cookie-Editor）：导出 quick.aws.com 的 Cookie，拼成
   `name=value; …` 的 Cookie 头格式。

插件只保存必需的具名凭据（`cookie`、`accountId`、`mbtc`），日志里脱敏显示；
不要把整条 Cookie 粘贴到聊天或截图里。

### 账号 JSON 格式

```json
{ "cookie": "mbtc=…; …", "accountId": "1234567890", "mbtc": "…" }
```

### 多账号池

一次粘贴可以带**多个账号**，插件把它们组成一个池（宿主只有一条活动凭据，
所以所有账号都住在这一条凭据的 `metadata.accounts` 里）：

- 多行粘贴：一行一个 `Cookie` 头 + 该账号的 URL 行（`…/account/<id>/…?mbtc=…`）；
  JSON 数组（每项 `{cookie, accountId, mbtc}`）；或 JSON Lines（每行一个账号 JSON）。
- 请求**轮询**使用健康账号；某账号 Cookie 被拒（401/403）、被服务端拒绝或用量
  窗口耗尽时，**该账号冷却 60 秒**，本轮自动换下一个账号重试。其他错误（超时、
  无消息等）不换号，直接返回。
- 池内所有账号都不可用时，返回最后一次的账号级错误；冷却到期后自动恢复轮询。
- `usage` 面板**逐账号**列出每个账号的用量池与健康状态（`accounts` 数组）。
- **没有自动降级、没有自动停手**——配额状态只上报，决策权在调用方。

## OpenAI 兼容接口

- `model`：`quick-fast` / `quick-balanced` / `quick-smart`
- `thinking`（或 `reasoning_effort`）：`off` / `low` / `medium` / `high` / `max`
  （布尔 `true` 归一为 `high`；非法值返回 400）
- `stream: true` → SSE（`reasoning_content` 先行、`[DONE]` 结束，最后一个内容块
  带 `quick.*` 元数据与 usage）
- `stream: false` → 聚合 JSON，正文在 `choices[0].message.content`，思考在
  `reasoning_content`，元数据在 `quick` 字段
- 历史：默认**无状态**——每次请求新开一个 Quick 线程，把全部历史压平成一段文本
  发出（上下文 1M、计费按分钟，压平不增加成本）。工具调用与工具结果作为上下文
  内联。
- **同线程续接**：请求体里带 `quick.thread_id` 可把这一轮钉在指定的服务端线程上
  （上一轮回复的 `quick.thread_id` 元数据或 `X-Quick-Thread-Id` 响应头给出这个
  值）；不带则每次新开线程。服务端按线程续写上下文。
- **会话恢复**：请求体里带 `quick.session_id` 可把连接直接挂到那个服务端会话上
  （`session_connect` 复用它），配合 `quick.thread_id` 在既有会话里续写。
- **无痕模式（默认开）**：插件发起的会话默认带 `incognito: true`（与网页端
  "无痕模式"按钮同款字段，2026-11-22 在页面实测：服务端记录该标志，会话**不进**
  侧边栏"最近使用"列表），插件调用不会刷屏你的会话列表。想在网页端保留某次
  对话时，请求体带 `"quick": {"incognito": false}` 关掉；每轮回复的
  `quick.incognito` 元数据回显实际值。
- **主动中断**：请求被 abort（客户端断开）时，插件停止读取本轮事件，尽力向
  服务端发 `stop_generation`，并以 `finish_reason: "aborted"` 收尾。

## Research（研究代理）

Quick 的 Research agent（网页端"研究"功能，Vibranium）走的是独立的 REST 通道
（`/qbsproxy/quicksight/research/*`，与聊天 WS 分开），配额也是独立的
**研究分钟池**（本账号 600 分钟，`RESEARCH_AGENT_HOUR_UNIT`）。插件把它桥接成
一次 OpenAI 形状的调用：**必须显式**在请求体里带 `quick.research`，普通聊天
永远不会触发研究：

```json
{
  "model": "quick-balanced",
  "messages": [{ "role": "user", "content": "ignore" }],
  "quick": {
    "research": {
      "goal": "对比 X 协议与 Y 协议的重试语义差异",
      "mode": "FAST",
      "include": ["example.com"],
      "exclude": ["pinterest.com"],
      "budgetMs": 600000,
      "pollMs": 5000
    }
  }
}
```

- `goal`（必填）：研究问题本身；`mode`：`FAST`（默认，分钟级）或 `DEEP`（更慢更透）。
- `include` / `exclude`：网页来源过滤（域名数组，可选）。
- `budgetMs`：轮询预算（默认 10 分钟）；`pollMs`：轮询间隔（默认 5 秒）。
- 插件流程：`execute-research-immediate` → 轮询 `get-updates`（带 trace 序号
  增量）→ 终态（`REPORT_COMPLETE` 成功；`FAILED_*` / `TERMINATED` /
  `USER_CANCELED` 失败）→ `get` 读报告。abort 信号会触发 `cancel`。
- 响应：报告全文在 `choices[0].message.content`；`quick.research_id` /
  `quick.research_mode` / `quick.research_status` / `quick.turn_seconds` 元数据
  回显运行信息；`X-Quick-Research-Id` 响应头给出 researchId，之后可用
  `read()`/`get` 复取。研究不支持的 stream 请求返回 400。
- 用量面板的 `accounts[].research` 列出研究池：`availableMinutes` /
  `provisionedMinutes` / `throttled` / 订阅信息（只读）。

## 用量

`usage` 返回只读的用量信息，**逐账号**列出：

- `windows`：会话窗口（默认 100 分钟）与每月窗口（默认 600 分钟 = 10 小时，
  即计划里的 agent_hours 池），各带 `used/limit/percent`、重置时间（`resetsAt`，
  ISO UTC）和恢复等待（`resumeInMinutes`，仅在有等待时出现）
- `subscription`：订阅类型、试用状态与到期时间
- `accounts`：池内每个账号自己的卡片（同上结构，失败账号带 `error`）
- `accounts[].panel`：该账号在 Quick 服务端的只读概览——
  `sessions`（最近会话元数据，含 `incognito` / `pinned` / `archived` / fork 字段）、
  `runs`（进行中/待输入的代理任务）、`agents`（a2a 与 acp 代理注册表）。
  某一项读取失败只降级为该项的 `error`，不影响其余内容；面板**只读**，
  不改任何服务端状态。

每轮回复的 `quick.*` 元数据带模型指纹（`resolved_model_id` / `served_model_id` /
`router`）、token 计数、`cost_usd`、`context_window` 与本轮墙钟秒数
（`turn_seconds`）；若服务端在本轮发了 `routing_decision` 事件，则原样附在
`quick.routing_decision`。这些都只做展示——插件**不做**自动降级或自动停手。

## 已知不支持

- **工具调用**：Quick 聊天通道没有客户端 tools 字段，带 `tools` 的请求返回 400
  （静默丢弃会破坏调用方 agent）。
- **附件/文件上传**：未实现。
- **语音（voice/TTS）、屏幕共享、PTY、a2ui 服务端 UI 编排**：未实现。
- 非官方接口，协议可能随时变化；请自行控制用量（插件**不做**自动降级或自动停手）。
