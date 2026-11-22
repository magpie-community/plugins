# Gemini 网页版中继（gemini-web-relay）

把 Gemini 网页版（gemini.google.com）接进 OpenCode 和
[magpie](https://usemagpie.ai)：请求由一个**常驻的真实浏览器中继**代发——
裸的 Node 客户端在很多网络上会被 Google 以 `/sorry` 拒掉，而同一条请求从
Gemini 自己的页面里发出（用页面自己的 Cookie、自己的 TLS），就能被正常服务。
浏览器跨请求保活，每次对话只是页面内的一次 fetch，边读边流式返回。

> Unofficial, use at your own risk. This package is not affiliated with,
> authorized or endorsed by Google. "Gemini" is a trademark of Google, used
> here solely to identify the service. The plugin drives the same endpoints
> the Gemini web app itself uses, with your own signed-in browser profile;
> it does not bypass captchas, rate limits or any platform restriction.
> The protocol is not documented and may change or stop working at any time.

## 工作方式

两条传输路径，页内执行（页面自己的 Cookie、TLS、令牌）：

1. **WebChannel**（`webchannel.mjs`，`processSession`）——主路径。在页面里
   跑，服务端看到的是页面自己的会话上下文，模型档位由它决定。
2. **StreamGenerate**（`relay.mjs`，旧的 batchexecute）——回退路径。
   WebChannel 握手被拒、端点变更等传输级失败时使用。

模型档位由应用自己的 mode 字节路由（请求头 `x-goog-ext-525001261`）：
`1` 走免费档，`3` 走 Pro 档。**严格模式默认开**（`strict_model !== false`）：
要了 Pro 却被服务端静默降级成免费档时，直接报错而不是当作成功返回。

每次对话都是**临时会话**（inner[45] = 1，实测 2026-11-22）：不进账号的
历史记录。会话池（`session_pool.mjs`）让接续上一轮的请求复用服务端会话、
只发新消息——但临时会话无法续接（服务端回 400），所以池里的都是普通会话。

## 模型

| 模型 | mode 字节（b14） | 说明 |
|---|---|---|
| `gemini-auto` | 不带头 | Google 自己挑（访客可用） |
| `gemini-3.6-flash` | 1 | 4 Hydrogen（免费档） |
| `gemini-3.1-pro` | 3 | 4 Neon（Pro 档），思考深度走 `reasoning_effort` |

`gemini-3.1-pro`（4 Neon）带思考深度三档，用 OpenAI 的 `reasoning_effort`
传：`low` / `medium` / `high`（对应应用选择器的 低/中/高，协议字节 1/4/2）。
不传就用应用自己的默认档。

## 登录方式

| 方式 | 做什么 | 给什么 |
|---|---|---|
| **复用已登录的浏览器配置（推荐）** | 填一个含 Gemini 登录态的 Chrome 配置目录；留空则自动挑 magpie 的 `gemini-web-browser` 下最近登录过的 profile | 全部模型 |
| **在单独的浏览器窗口登录** | 插件拉起独立 Chrome 窗口（独立配置，不碰日常浏览器），你登录 Google 账号，打开 Gemini 后窗口自动关闭 | 全部模型 |
| **不登录使用（访客）** | 用无登录的独立浏览器；网页版也回答访客 | 仅 `gemini-auto`（经由 Auto，多半是较轻的模型） |

**Profile 边界**：与 moss/quick 插件同规则——只用插件自己的专用 profile
（默认复用 gemini-web 插件的 `gemini-web-browser` 根目录），绝不碰日常浏览器。

## OpenAI 兼容接口

- `model`：上表之一（可带 `gemini-web-relay/` 前缀）
- `stream: true` → SSE：`reasoning_content` 先行、正文随后、`[DONE]` 结束；
  最后一个 finish 块带 usage（token 数按字符数 ÷3 估算，网页端不回报计数）
- `stream: false` → 聚合 JSON：正文在 `choices[0].message.content`，思考在
  `reasoning_content`（同时以 `reasoning` 字段给出，两种 SDK 读法都照顾）
- 历史：把全部 OpenAI messages 压平成一段文本（system 在前，工具调用与结果
  作为上下文内联）经临时会话发出
- `reasoning_effort`：`low`/`medium`/`high`，仅 4 Neon（`gemini-3.1-pro`）
  生效，对应应用选择器的思考深度三档
- `strict_model: false` 可关掉档位校验（不建议）

## 自检

```bash
bun test packages/gemini-web-relay   # 离线测试（假 ask，不碰网络）
bun scripts/check.mjs gemini-web-relay
node packages/gemini-web-relay/selftest.mjs   # 端到端，需要真实登录态
```

## 包名

`@nonamelane/magpie-gemini-web-relay`（自用，未注册进 magpie 市场）。
