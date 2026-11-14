# Kilo Gateway for Magpie

实验性 Magpie / OpenCode provider plugin：使用 Kilo 的 device OAuth 登录 Kilo 账户，并通过 Kilo Gateway 访问模型。

当前版本的目标是：

- 在 Magpie 中完成 Kilo device OAuth 登录；
- 通过 Kilo OAuth access token 调用 Kilo Gateway；
- 动态读取 Kilo Gateway 模型目录；
- 让 Magpie 后面的客户端使用 Kilo 的 GPT/Codex 模型；
- 读取 Kilo 账户基础信息；
- 只列出订阅通道能用的模型（`byok-only` 选项）；
- 让出站请求与 Kilo CLI 长得一样，上游看不出中转。

## 请求形态

订阅型上游会校验请求是不是来自它自己的客户端。本插件按 Kilo CLI 的真实形态发请求：

| Header | 值 | 来源 |
|---|---|---|
| `User-Agent` | `Kilo-Code/<KILO_VERSION>` | `kilocode/const.ts` 的 `DEFAULT_HEADERS` |
| `HTTP-Referer` | `https://kilocode.ai` | 同上 |
| `X-Title` | `Kilo Code` | 同上 |
| `X-KILOCODE-EDITORNAME` | `Kilo CLI <KILO_VERSION>` | `kilo-gateway/headers.ts` |
| `X-KILOCODE-MACHINEID` | 持久化的随机 UUID | `kilo-telemetry/identity.ts` |
| `x-kilocode-mode` | agent 名小写 | `session/llm/request.ts` |
| `X-KILOCODE-TASKID` | `ses_…` 会话 id | 同上 |
| `x-session-affinity` / `X-Session-Id` | 同一个 `ses_…` | 同上 |
| `X-KILOCODE-PROJECTID` | 工作目录解析出的项目 id | `kilocode/project-id.ts` |

会话 id 由 magpie 给的会话标识派生，形状照 OpenCode 的 `identifier.ts`
（`ses_` + 12 位十六进制 + 14 位 base62，低 12 位取反使最新排在最前）。
Kilo Code 是 OpenCode 的 fork，`X-KILOCODE-TASKID` 取的就是 `input.sessionID`，
所以这个形状是对的。同一会话的每一轮复用同一个 id——Gateway 按它做 prompt 缓存，
id 变了缓存就丢。最近 1000 个会话的 id 留在内存里。

机器 id 是**安装标识**，不是硬件指纹：读插件目录下的 `.machine-id`，没有就写一个
随机 UUID，跟真实客户端的 `<dataPath>/telemetry-id` 一样。可用 `KILO_MACHINE_ID` 覆盖。

项目 id 按真实客户端的优先级解析：`.kilo/config.json` → `.kilocode/config.json` →
`git config --get remote.origin.url`，规整成最后一段、去掉 `.git`、最长 100 字符。
工作目录取自 magpie 的 `X-Magpie-Work-Dir`（magpie 从请求正文里解析出来的），
解析不出就不发这个头——真实客户端在解析不出时同样不发。结果按目录缓存。

`KILO_VERSION` 要跟着 npm `@kilocode/cli` 的 latest 走，上游会按版本判断客户端。

出站前会删掉：宿主的占位凭据（`x-api-key`、`x-goog-api-key`）和全部 `X-Magpie-*`。
后者 host 自己也会剥，但它们经过插件的手转发，不能依赖宿主兜底。

### 没发的 header

`X-KILOCODE-ORGANIZATIONID` 只在账户属于某个组织时才有。`/api/profile` 对当前账户
返回 `hasPersonalAccount: true`，没有组织 id 可取，所以不发——个人账户的真实客户端
同样不发。`X-KILOCODE-PARENT_TASKID` 和 `X-KILOCODE-FEATURE` 依赖 Kilo Code 自己的
子会话与归因体系，网关侧没有对应概念，不发。

Kilo 的 ChatGPT BYOK 连接仍需在 Kilo 的 [BYOK 页面](https://app.kilo.ai/byok)中完成。Kilo 官方说明，ChatGPT BYOK 请求经过 Kilo Gateway 后使用 ChatGPT 额度；Kilo 页面可以显示请求记录和 `$0` 成本，但没有向客户端提供 ChatGPT 实时剩余额度窗口。因此本插件不会伪造 ChatGPT quota 数据。

## 与 `@magpie-community/agent-kilo` 的区别

社区列表里还有一个 Kilo 相关的插件，两者不是一回事，可以共存：

| | `@magpie-community/agent-kilo` | 本插件 `magpie-kilo-auth` |
|---|---|---|
| 类型 | agent（`kind: "agent"`） | provider（`providers: ["kilo"]`） |
| 做什么 | 把 Kilo Code 这个 CLI agent 接到 magpie 的 Agents 页，让它改用 magpie 的模型 | 用 Kilo 账户登录，把 Kilo Gateway 的订阅模型作为 provider 供 magpie 后面的客户端调用 |
| 登录 | 不登录任何服务，只改写 Kilo Code 的配置文件 | Kilo 账户 device OAuth |
| 请求发往 | magpie 自己的网关 | Kilo Gateway |
| 什么时候装它 | 你想让 Kilo Code 跑在 magpie 后面 | 你想在 magpie 里用 Kilo 订阅的 GPT / Codex 模型 |

## 安装

在 Magpie 的 Plugins 页面搜索 Kilo Gateway 点 Install，或用命令行：

```bash
magpie plugin add github:hahhforest/magpie-kilo-auth
magpie plugin login kilo
```

登录时打开 Magpie 给出的 Kilo device URL，完成 Kilo 账户授权。

从克隆下来的目录装则是：

```bash
magpie plugin add /path/to/magpie-kilo-auth
```

## 选项

`byok-only`（默认开）：只列出 Kilo 目录里 `hasUserByokAvailable` 为 true 的模型。
Kilo 的目录有 385 个模型，其中 38 个走订阅通道；其余的请求过去只会得到
`402 Paid Model - Credits Required`。关掉后列出全部。未登录时不做过滤——
那时没有订阅通道可言，滤掉就什么都不剩。

## 代理

magpie 的插件宿主把 `globalThis.fetch` 换成了带代理的版本，插件自己发起的请求
（device auth）绕不过它：provider 的 `proxy` 设置只作用于 magpie 侧的 Fetch RPC。

Kilo 托管在 Vercel，出口 IP 被判定为 bot 时，Vercel 在边缘就回 403 和
`x-vercel-mitigated: deny`，请求到不了 Kilo 的应用层。本插件识别这个响应，
改用 `node:https` 直连重试一次。只认这一个头——用户在 Kilo 页面拒绝授权同样是
403，没有它，仍按拒绝处理。

直连只在被边缘拦下时发生，代理通的环境行为不变。

## 测试

```bash
node --test index.test.mjs
```

真实请求验证需要 Kilo 账户、Kilo Gateway 权限和一个已经连接 ChatGPT 的 BYOK 配置。

## 来源和边界

本插件参考了 Kilo 官方仓库 `packages/kilo-gateway` 中的 device authorization、Gateway provider 和账户接口实现，并按 Magpie 插件接口重新组织。它不是 Kilo 官方发布的 npm 包，也不代表 Kilo 官方维护或支持。

客户端标识的形状对照 Kilo 官方仓库本身，不是二手转述：

- `packages/opencode/src/session/llm/request.ts` —— 会话层的 header
- `packages/kilo-gateway/src/headers.ts` 与 `provider.ts` —— AI SDK 层的 header
- `packages/kilo-telemetry/src/identity.ts` —— 机器 id
- `packages/opencode/src/kilocode/project-id.ts` —— 项目 id
- `packages/kilo-gateway/src/api/url.ts` —— 网关地址的解析规则
- `packages/schema/src/identifier.ts` —— 会话 id 的形状

magpie 内置 Kilo provider 的 `internal/provider/kilo.go` 是有用的交叉参考，
但它的 `KiloVersion` 常量（7.8.3）落后于 npm，版本号以 npm 的 latest 为准。

- Kilo 官方仓库：https://github.com/Kilo-Org/kilocode
- Kilo ChatGPT BYOK：https://kilo.ai/docs/ai-providers/openai-chatgpt-plus-pro
- Kilo Gateway：https://kilo.ai/docs/gateway
- Magpie 插件文档：https://usemagpie.ai/docs/plugins
- Magpie 源码：https://github.com/yetone/magpie
