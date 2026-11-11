# opencode-perch-auth

> Perch Terminal (`app.perchai.app`) as a magpie / OpenCode provider: browser sign-in
> (Google / GitHub), Perch-hosted models streamed through the CLI surface.

把 Perch Terminal（`app.perchai.app`）的托管模型接成 magpie / OpenCode 的供应商插件。

插件自己负责：读 CLI 会话 → 续期 Supabase token → 换单轮票据 → 发 Perch 的 SSE 请求 →
把 Perch 的自定义事件流翻译成 OpenAI `chat.completion.chunk`。

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
登录成功后 magpie 保存 `access` / `refresh` / `expires`，账号名取自 token 里的 email。

插件在 access token 到期前 5 分钟自动续期（`refreshLead`），续期失败抛
`signIn: "expired"`，magpie 会提示重新登录。

### 同时写出 CLI 会话文件（可选）

想让 `perch` 命令直接复用这次登录，给插件加选项：

```json
{ "writeSessionFile": true, "sessionPath": "~/.perch/cli-auth-session.json" }
```

写出的内容与官方 CLI 完全同构：

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
传 `perch-auto` 则不带 `preferredModelId`，交回服务端路由；
其它不认识的 id 会当作 `preferredModelId` 直接转发。

## 为什么必须用 `perch login` 的会话

服务端有一道表面（surface）校验。用桌面端「登录」得到的会话，即使请求体里
声明 `"surface":"cli"`、`clientSurface:"cli"`，换票端点仍然返回：

```
HTTP 403
{"ok":false,"errorCode":"perch_surface_required",
 "error":"Your plan includes Perch-hosted models for use in Perch AI Web, Desktop,
          and CLI only. Direct API access is not included. ..."}
```

JWT 里没有表面字段，判定绑定在会话的签发方式上。只有 `perch login` 产出的会话
能通过，换票后 `runId` 形如 `tkt-cli-...`。

插件不会伪造这个标记：它用的就是 CLI 自己的会话和 CLI 自己的换票请求体。

## 错误处理

| 上游 | 插件返回 |
|---|---|
| 401 | 401 + `X-Magpie-Sign-In: expired`（触发重新登录） |
| 403 `perch_surface_required` | 403，错误信息原样透出 |
| 其它非 2xx | 同状态码，body 里的 `error` / `errorCode` 转成 OpenAI 错误结构 |
| 网络不可达 | 502 `upstream_unreachable` |

上游非 2xx 会被 magpie 当作"供应商的正式答复"，因此不会静默 failover 到别的模型。

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
- 票据换取失败时不阻断请求（与桌面端一致：`ticketRequiredForCurrentTurn = false`），
  真正的判定在 `model-call`。
