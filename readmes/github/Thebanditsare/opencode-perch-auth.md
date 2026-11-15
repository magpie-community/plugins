# opencode-perch-auth

> Unofficial Perch Terminal provider for magpie / OpenCode. Direct API access
> requires a Perch plan or written agreement that explicitly includes it.

把 Perch Terminal（`app.perchai.app`）的托管模型接成 magpie / OpenCode 的供应商插件。

插件通过浏览器登录或导入本地会话获取 Supabase token，向 Perch 换取票据后发起模型请求。
上游接受请求并返回 SSE 时，插件把事件流翻译成 OpenAI `chat.completion.chunk`。
Perch 的 Starter、Pro 和 Ultra 套餐提供官方 Web、Desktop 和 CLI 内的托管模型使用权。
在第三方工具中直接调用内部接口，需要 Perch 明确授予直接 API 访问权限。
见 [Perch FAQ](https://www.perchai.app/faq) 和[服务条款第 6、7 节](https://www.perchai.app/terms)。

---

## 协议来源

逆向自 `Perch Terminal 2.4.2`（`resources/app.asar` 里的 `dist-electron/main.js`）
与官方 CLI `perchai-cli@2.4.115`。两个端点的形状：

```http
POST https://app.perchai.app/api/perch-terminal/turn-ticket
Authorization: Bearer <supabase access token>
{"surface":"cli","profile":"standard"}
→ {"ok":true,"ticket":"...","ticketId":"...","runId":"tkt-cli-...","expiresAt":"...","renewal":{...}}

POST https://app.perchai.app/api/perch-terminal/model-call
Authorization: Bearer <supabase access token>
Accept: text/event-stream
x-perch-turn-ticket: <ticket>
User-Agent: perchai-cli/2.4.115
x-perch-locale: en
{"request":{"messages":[...],"tools":[...],"toolChoice":"auto"},"lane":"chat",
 "strictManual":false,"preferredModelId":null,"avoidModelIds":[],
 "attribution":null,"clientSurface":"cli"}
```

上游 SSE 事件：`answer_delta` / `reasoning_delta` / `tool_call_delta` / `tool_use_end` /
`stream_restart` / `continuation_seam` / `model_call_failed` / `done`。

插件内的映射：

| Perch | OpenAI chat.completion.chunk |
|---|---|
| `answer_delta.text` | `delta.content` |
| `reasoning_delta.text` | `delta.reasoning_content` |
| `tool_call_delta` / `tool_use_end` | `delta.tool_calls[]` |
| `done.usage` | 末帧 `usage` |
| `done` | `finish_reason: "stop"` / `"tool_calls"`，随后 `data: [DONE]` |

---

## 安装

```bash
magpie plugin add opencode-perch-auth          # 从 npm
magpie plugin add github:Thebanditsare/opencode-perch-auth   # 从 GitHub
magpie plugin add ./magpie-plugin-perch        # 本地目录，改完重启生效
```

插件是单文件 ESM，无第三方依赖、无构建步骤。

## 登录

在 magpie 里添加 `Perch` 供应商，会看到三个选项：

| 选项 | 做什么 |
|---|---|
| **使用 Google 登录 Perch** | 拉起浏览器，走 Perch 自己的 Supabase PKCE 登录，回调到本机 `127.0.0.1:<随机端口>/callback`，拿到 `access_token` / `refresh_token` |
| **使用 GitHub 登录 Perch** | 同上，换 GitHub 身份 |
| **Perch CLI 会话** | 读取 `perch login` 写下的 `~/.perch/cli-auth-session.json` |

浏览器登录复刻官方 CLI 的流程：先 `GET /api/perch-terminal/cli-auth/config` 拿
`supabaseUrl` / `supabaseAnonKey` / `providers` / `redirectHost`，再按 S256 PKCE
拼 `/auth/v1/authorize`，回调收到 `code` 后用
`POST /auth/v1/token?grant_type=pkce {auth_code, code_verifier}` 换成会话。
浏览器登录成功后，插件向 magpie 返回 `access`、`refresh`、`expires` 和账号标识。

插件向 magpie 声明提前 5 分钟续期（`refreshLead`）。缺少 refresh token 或 Supabase
拒绝续期时，插件用 `signIn: "expired"` 提示重新登录。登录和续期只处理会话凭据。

### 同时写出 CLI 会话文件（可选）

如需将浏览器登录获得的会话另存为 CLI 会话文件，可配置以下选项。

```json
{ "writeSessionFile": true, "sessionPath": "~/.perch/cli-auth-session.json" }
```

文件包含以下字段。

```json
{
  "version": 1,
  "appUrl": "https://app.perchai.app",
  "accessToken": "…",
  "refreshToken": "…",
  "expiresAt": 1790000000,
  "userId": "…",
  "email": "…",
  "updatedAt": "2026-10-23T…"
}
```

默认关闭，避免覆盖你已有的 CLI 会话。文件权限 0600，目录 0700。

## 模型

默认只挂一个：`deepseek-flash` → `preferredModelId: "deepseek-v4.1-flash"`。
`preferredModelId` 是 Perch 服务端的模型 id（`main.js` 的 `modelRegistry` 里那张表，
`deepseek-v4.1-flash` 走 dashscope / W&B 后端）。

要加别的模型，在插件 options 里写：

```json
{
  "models": [
    { "id": "opus", "name": "Claude Opus 5.5", "preferredModelId": "claude-opus-5.5" }
  ]
}
```

`id` 是 magpie 里显示的名字，`preferredModelId` 原样透传给服务端。

> **Starter 套餐的路由**（本机实测，`2727901961@qq.com`，2026-10-23）：
> 只给 `preferredModelId` 没用——传 `deepseek-v4.1-flash`、`claude-opus-5-5`、`gpt-6-sol`
> 或不传，`done.model` 一律回 `Qwen/Qwen3.8-Flash`；`pro` 档直接 403
> （`starter_model_blocked`，Starter 只有 Roost Standard / Standard 1M）。
> DeepSeek 在 Starter 上是 CoreWeave 那条 pin，必须带
> `manualModelOptionId: "openrouter-deepseek-deepseek-v4-1-flash"`，
> 服务端才路由到 `deepseek/deepseek-v4.1-flash-1017`。插件默认已经带上。
> 排查时用 `PERCH_DEBUG_MODEL=1` 把 `done.model` 打到 stderr。
`perch-auto` 发送 `preferredModelId: null` 并省略 `manualModelOptionId`，由服务端选择模型。
其它不认识的 id 会当作 `preferredModelId` 直接转发。

## 如何判断 403 出在哪一步

orinsid 报告使用插件内置 GitHub OAuth 登录并选择 Starter 后，`turn-ticket` 返回
`ok: true`、`surface: "cli"`、`enforced: false`，`runId` 以 `tkt-cli-` 开头。
随后 `model-call` 返回 HTTP 403 和 `perch_surface_required`。手动指定模型和自动路由得到相同结果。
见 [Issue #2](https://github.com/Thebanditsare/opencode-perch-auth/issues/2)。

票据成功只说明本次换票被接受。实际模型调用有自己的响应，报错时应记录返回错误的端点。
这次拒绝符合 Perch 对第三方直连的公开限制。具体命中了哪条服务端规则、是否涉及会话签发渠道，
需要 Perch 确认。票据字段、JWT 中的登录提供方以及本地会话文件都不足以回答这些问题。

如要在官方 CLI 中使用 GitHub 账号，Perch 当前文档列出了 `perch login github`。
无法运行 CLI 的平台可以直接使用 Perch Web。需要在 magpie / OpenCode 直连的用户，应向
Perch 确认适用的集成方案和对应接口。导入 CLI 会话本身不会授予这种权限。
见 [CLI 登录文档](https://www.perchai.app/docs/using-perch/cli) 和 [Perch FAQ](https://www.perchai.app/faq)。

## 错误处理

对于下列请求错误，`error.stage` 标明失败端点（`turn-ticket` 或 `model-call`）。
客户端只显示 `error.message` 时，也能从消息中识别失败阶段。

| 上游结果 | 插件返回 |
|---|---|
| HTTP 401 | 保留 401，设置 `X-Magpie-Sign-In: expired` 提示重新登录 |
| HTTP 403，`perch_surface_required` | 保留 403 和错误码，标明哪一步被拒绝，本次请求到此结束 |
| 其他上游 HTTP 错误 | 保留 HTTP 状态码，并将可用的上游错误码与消息转换为 OpenAI 错误结构 |
| 换票返回 2xx，但响应无法解析或缺少可用票据 | 502 `bad_upstream`，阶段为 `turn-ticket` |
| 无法连接上游 | 502 `upstream_unreachable`，标明失败阶段 |

0.1.0 在取不到票时可能仍发出模型请求，掩盖最初的换票错误。修正后，换票失败即返回错误，
成功取得可用票据才会继续调用模型。
宿主续期或切换账号后，下一次请求会使用新的 access token 重新换票。

## 代理

插件用的是宿主运行时自带的 `fetch`。Node 下要走系统代理需要：

```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 magpie
```

Bun 与 magpie 内置运行时会自己读环境变量，不用额外开关。
如果 magpie 直接在本机跑且能直连 `app.perchai.app`，不用管这一节。

## 用量与缓存

Perch 的 `done` 事件把用量拆开报：

```json
{"inputTokens":79,"cacheReadInputTokens":5376,"cacheCreationInputTokens":0,"outputTokens":12,"totalTokens":5468}
```

`inputTokens` 只是**未命中缓存的**那部分，缓存单列。OpenAI 那边 `prompt_tokens` 含缓存，
命中数在 `prompt_tokens_details.cached_tokens`，magpie 的缓存率正是拿这两个相除算的。
插件按这个口径转换，漏掉的话面板会一直显示 0%。

上游确实有前缀缓存，实测同一个长前缀连发：第一次 `cached=0`，之后稳定 `5376/5455 = 98.6%`，
耗时从 5.9s 降到 2.8s。**首次调用必然是 0%**——没有可命中的前缀；换会话、换 system prompt、
换工具表都会让前缀变掉，缓存随之归零。

## 改代码之后

宿主把插件加载在常驻进程里，改完 `index.mjs` 要重载才生效：

```bash
magpie plugin off magpie-plugin-perch && magpie plugin on magpie-plugin-perch
```

## 限制

- 只实现 chat completions 路径，没有 embeddings / images。
- `stream_restart` 在流式端无法回收已发出的文本，插件会丢掉后续重来的片段标记，
  客户端可能看到重复段落。上游故障切换本身很少触发。
