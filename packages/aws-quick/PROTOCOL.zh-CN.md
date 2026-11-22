[English](PROTOCOL.md) | [中文](PROTOCOL.zh-CN.md)

# Amazon Quick 聊天协议（v1.2.4660 实测）

本文档记录插件依赖的线上协议。所有字段均来自对桌面端
`app.asar`（`dist/main`、`dist/renderer`）的逆向与真实流量抓包。
敏感值（token、账号 id、tenant url）一律用占位符表示。

## 1. 拓扑

```
magpie ──OpenAI Chat Completions──▶ 插件 fetch
                                      │ spawn / connect
                                      ▼
                        quickwork-agent --outpost-only  (Python, 127.0.0.1:<port>)
                          ├─ /health                  公开
                          ├─ /auth/status             Bearer <instanceToken>
                          ├─ /auth/sncs-session       Bearer <instanceToken>
                          └─ /local/outpost-id        Bearer <instanceToken>
                                      │  id_token + ws_host
                                      ▼
              wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream
              （qbs-cell…dp.appintegrations.<region>.prod.plato.ai.aws.dev）
```

instance token 契约（与 Electron `AgentBridge.pipeToken` 一致）：
主进程把 token 作为**第一行**写入子进程 stdin，子进程之后所有 `/auth/*`、`/local/*`
请求都用 `Authorization: Bearer <token>`。

## 2. outpost 启动参数

```
quickwork-agent(.exe) --outpost-only --manifest desktop --port <port>
```

环境变量（插件设置的最小集）：

| 变量 | 说明 |
|---|---|
| `QUICKWORK_BUILD_STAGE` | `prod`（默认）/ `beta` 等，决定 feature flag 通道 |
| `QUICKWORK_CLOUD_MODE` | `1` |
| `QUICKWORK_OUTPOST_PORT` | 监听端口 |
| `QUICKWORK_PROFILE_STAGE` | 同 build stage |
| `QUICKWORK_USER_DATA_DIR` | 可选；指向 app userData 以复用本地状态 |

stdout 会打印 `OUTPOST_PORT: <port>`、`LEP_PORT: <port>` 等行。
`/health` 返回 `{"status":"ok","service":"outpost"}`。

## 3. 会话接口

### `GET /auth/sncs-session`

返回（字段经脱敏）：

```json
{
  "id_token": "<JWT>",
  "actor_arn": "arn:aws:quicksight:…:user/…",
  "ws_host": "qbs-cell….dp.appintegrations.us-east-1.prod.plato.ai.aws.dev",
  "tenant_url": "https://qbs-cell…dp.appintegrations…",
  "provider": "social",
  "aws_account_id": "…",
  "embed_host": "https://quick.aws.com",
  "region": "us-east-1",
  "usable_until": 1763…,          // epoch 秒；过期需重新获取
  "ws_replay_enabled": true
}
```

### `GET /local/outpost-id`

```json
{ "outpostId": "<uuid>" }
```

设备/会话复用维度；WS URL 与 `session_connect` 都要带它。
（另有 `nook-set-outpost-id` IPC 把它推给 renderer 的 invokeAgent 路径。）

## 4. WebSocket

### 4.1 URL

```
wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream
  ?surfaceType=QUICK_WORK_DESKTOP_WINDOWS
  &token=<id_token URL-encoded>     // social 留在 query；enterprise 才改走 Authorization
  &outpostId=<uuid>                 // 桌面端始终带这个参数，空也带
  &workingSessionId=<uuid>          // 客户端生命周期内固定，重连复用
  &channel=prod                     // 只有 beta 或 prod 才附加
  [&agentRuntimeArnOverride=…]      // enterprise 路径用，social 不需要
```

social/AIDP 路径**不需要 SigV4 签名**（那是 enterprise provider 的
`nook-sign-ws-url` IPC 才做的事）。

### 4.2 上行帧（client → server）

WS binary frame，payload 为 UTF-8 JSON：

```json
{ "eventType": "rawInputEvent",
  "payload": { "payload": "<base64(utf8(inner JSON))>" } }
```

inner JSON 形如 `{"type": "…", "payload": {…}}`。常用类型：

**session_connect**（连接后立即发，紧接着 `federate_status`，再等 `session_established`/`connected`）：

```json
{ "type": "session_connect",
  "payload": {
    "actor_id": "<actor_arn>",
    "surfaceType": "QUICK_WORK_DESKTOP_WINDOWS",
    "outpostId": "<uuid>",
    "appVersion": "1.2.4660",
    "acp_first_text": 1,
    "user_notification": 1,
    "subtask_progress": 1,
    "external_agent_sign_in": 1,
    "recents_promotion": 1
  } }
```

`outpostId` 只在非空时放进 payload（桌面端 `tf()` 的行为）。URL 上始终有该参数。
浏览器登录没有本地 outpost，插件为账号保存一个稳定的设备 id。

**user_message**：

```json
{ "type": "user_message",
  "payload": {
    "thread_id": "<client-chosen id, e.g. uuid>",
    "text": "<整条用户输入>",
    "custom_prompt": "<调用方系统指令（首轮发送，实测在同 thread 后续轮次持久化）>",
    "send_origin": "composer",
    "auto_routing": false,
    "web_search_enabled": true,
    "message_id": "<uuid>",
    "agent_mode": "fast|balanced|smart|advanced",
    "user_timezone": "UTC",
    "user_locale": "en-US",
    "thinking_effort": "off|low|medium|high",        // 可选（桌面端将 max 封顶到 high）
    "chat_agent_id": "…",                            // 可选
    "project_context": {…}, "attachments": […],     // 可选，插件未用
  } }
```

**ping**（桌面端应用层间隔 45s）：

```json
{ "type": "ping", "payload": { "timestamp": <ms> } }
```

### 4.3 下行帧（server → client）

AWS event-stream 消息（12B prelude + headers + payload + 4B CRC；
headers 里 `:message-type=event`、`:event-type=rawOutputEvent`、
`:content-type=application/json`）。body 是 JSON：

```json
{ "payload": "<base64(utf8(inner JSON))>" }
```

inner JSON 顶层字段：`type`、`payload`、`message_id`、`thread_id`、
`scope`（`chat`/`task_lifecycle`…）、`timestamp`、`turn_message_id`。

观察到的事件类型（节选）：

| type | 说明 |
|---|---|
| `session_established` | `session_connect` 应答（含 `workingSessionId`、`trace_id`） |
| `connected` | 会话就绪；`payload.user`/`runtime` 带账号与预热信息（**含 PII，勿落日志**） |
| `status` | 杂项状态，如 `{"status":"pong"}`、`unknown_message_type` |
| `message_start` | 一条 assistant 消息开始（`payload.role:"assistant"`） |
| `text_delta` | `payload.delta` 文本增量（`kernel_thread_id` 在 payload 内） |
| `thinking_delta` / `thinking_complete` | 推理过程增量 |
| `tool_start`/`tool_arguments`/`tool_progress`/`tool_result`/`tool_error` | agent 工具过程（服务端执行，客户端只观测） |
| `turn_usage` | `payload`：`input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_write_tokens`/`total_tokens`/`model`/`resolved_model_id`/`served_model_id`/`cost_usd`/`context_window` |
| `text_complete` | `payload.text` 本消息全文 |
| `message_complete` | `payload`：`text`、`tool_calls[]`、`kernel_thread_id`、`initiator`、`continuation_expected?` |
| `message_split` | 长回复拆分 |
| `title_generated` | 会话标题 |
| `runs_updated` / `task_list_update` | run/任务状态噪声（顶层 `thread_id` 为空，`payload.thread_id` 才有值） |
| `keepalive` | `{"type":"keepalive","ts":…}` |
| `error` / `guardrail_blocked` / `stream_truncated` / `turn_aborted` | 异常 |

### 4.4 Turn 结束判定（实测）

**没有 `turn_completed` 下行事件**（那是 REST session-store 里的持久化事件类型）。
一个 user turn 结束的判据与桌面渲染端一致：

- `message_complete` 且 `payload.continuation_expected !== true` → 该 turn 最后一条消息完成；
  agentic 多步 turn 会发多个 `message_start…message_complete` 循环，前面几轮带
  `continuation_expected:true`；
- `stream_ended`、`turn_aborted` → 直接终止；
- `error`/`guardrail_blocked`/`stream_truncated` → 失败。

`message_complete`/`text_complete` 的 `payload.text` 是全文兜底；正常情况下
`text_delta` 已给出全部内容。

### 4.5 thread 复用

服务端按 `thread_id` 持久化会话历史（已实测：同一 thread 第二轮能记住第一轮内容）。
客户端自选 `thread_id`（插件用 UUID）。复用判定见 README「会话复用怎么判定」。

### 4.6 客户端工具调用（约定模拟）

协议里**没有**客户端工具通道：`tool_start`/`tool_arguments`/`tool_result` 是
Quick 自有 agent 工具的服务端执行过程，`message_complete.tool_calls` 恒为空。
渲染端的工具审批/结果回传（`tool_approval`、`{"type":"tool_result",…}`）只服务于
它自己的工具循环，外部 `user_message` 无法注入一个"待执行的客户端工具调用"。

可行的桥接（插件采用，已实测跑通）：

1. 把 OpenAI `tools[]` + `tool_choice` 渲染成一段 `[Client tool calling]` 指令，
   拼进 `user_message.payload.text`，并在 `system_prompt` / `custom_prompt` 头部放入
   客户端工具规则；同时置 `web_search_enabled:false`，减少模型调用自带联网工具"抢答"。
2. 模型把调用输出为纯文本 `<tool_call>{"name":…,"arguments":{…}}</tool_call>`
   （tag 可能跨 `text_delta` 切分，插件做了 holdback 解析，见 `lib/tools.mjs`）。
3. 解析结果映射为 OpenAI `tool_calls`；`finish_reason:"tool_calls"`。
4. 若 Quick 主动发出终端类 `tool_start`/`tool_arguments`（如 `run_terminal_command`）
   且客户端声明了 shell 工具（如 `Bash`），插件会直接映射为 OpenAI `tool_calls`，
   等客户端执行完毕后再用 `{"type":"tool_result",…}` 帧回传给同一 thread。
5. 其他客户端工具回传的 `role:"tool"` 结果 → 渲染为 `[tool_result <name> <id>] <content>`
   续接同一 thread（delta 里只含新增 tool/user 内容）。

局限：依赖模型遵守约定（`tool_choice:'required'` 实测稳定）；模型也可能无视约定
直接用自带工具作答（表现为普通文本）；Quick 自带工具的执行结果不映射为
OpenAI `tool_calls`。

## 5. agent_mode → 实际模型

| agent_mode | 观测 resolved_model_id |
|---|---|
| `fast` | `us.anthropic.claude-haiku-5-5` |
| `smart` | `us.anthropic.claude-opus-5-5` |
| `balanced`/`advanced` | 服务端路由；`advanced` 可能归一到 `smart`（渲染端有 feature flag 逻辑） |

`turn_usage.model` 回显请求的 mode，`resolved_model_id`/`served_model_id` 是真实模型。
注意 Quick 的系统提示很大：实测 `input_tokens≈67k`、`cache_read_tokens≈67k`
（命中 prompt cache），`context_window=1000000`。

## 6. 已知坑

- `session_connect` 后要等 `session_established`/`connected` 再发 `user_message`，
  否则消息可能被丢弃（实测表现为永远无响应）。
- `user_message` 必须等 outpost 完成首次 agent 同步后云端才回话；
  outpost 首启有 ~30-60s 的 feature flag/agent reconcile，属正常。
- sandbox 端口 8768、LEP 端口被占用时 outpost 降级继续运行（只影响本地工具/MCP sandbox，
  聊天 WS 不受影响）。
- `connected.payload.user` 含邮箱/姓名/账号 id——**不要打印原始事件**。
- 整个 `user_message` 帧有 64KB 上限（超限服务端拒发 `FrameTooLarge`；
  已实测 `text` 与 `system_prompt` 共享该预算），插件在
  `lib/handler.mjs`/`lib/translate.mjs`/`lib/tools.mjs` 里做了尺寸预算；
  渲染文本始终 <60KB。
