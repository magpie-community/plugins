# @magpie-community/opencode-catpaw-auth

[OpenCode](https://opencode.ai) / [magpie](https://usemagpie.ai) provider 插件：**妙手（CatPaw，美团 `ai.catpaw.meituan.com`）**——登录、模型清单、聊天转发、余额查询。

请求形态按妙手桌面客户端 2026-10-09 的真实抓包移植（`round → event(running) → turn(SSE)` 简化链路，无跨请求会话复用）：请求头、`permissionMode` 均为客户端原样取值，脱敏抓包存于 `testdata/captured-*.json`，测试逐键比对。

## 安装

```
magpie plugin add @magpie-community/opencode-catpaw-auth
magpie plugin login catpaw     # 选「网页登录」/「妙手桌面端登录态」/「手动粘贴 token」
```

## 能力

- **登录**：
  - `网页登录`：插件问 `login-config` 取官方登录页，浏览器完成登录后，插件按官方客户端同款 **poll-token 通道**每秒轮询 `?sid` 直接拿 token——服务端对服务端，无监听端口、不受浏览器私有网络检查（PNA）影响；再问一次 `current-user` 补 uid/昵称（失败不影响登录）。
  - `妙手桌面端登录态`：每次请求前实时读 `~/.meituan-catpaw/auth.json`（mtime 缓存 5 分钟内；重开妙手即自动刷新）。
  - `手动粘贴 token`。
- **无续期接口**：token 过期后 401，网页登录重新发起一次即可；桌面端登录态则在妙手里重新登录（下一请求自动读新 token）。
- **聊天**：`round → event → turn` 三步会话机；上游 SSE 帧为累积式，插件做差分转 OpenAI delta（`content` + `reasoning_content`），流式与非流式都支持。
- **模型**：妙手桌面端的 9 个模型（longcat-2.0 / glm-5.3 系列 / deepseek-v4 系列 / minimax-m3 / kimi-k3 / auto），静态表（无远程目录接口）。不声明各模型的上下文/输出窗口（客户端未公布，不编造数字），也不声明图片输入（见下）。
- **工具与图片**：会话协议只收一段扁平文本 prompt，工具定义、工具结果与图片都无法送达——带这些的请求以 **400 明确拒绝**（而不是悄悄丢掉后答错）。
- **余额（usage）**：`GET https://catx.nocode.cn/api/gateway/credit/balance`，鉴权头是 **`X-Auth-Token: <accessToken>`**。
  - ⚠️ 这个接口与聊天网关**不是同一个鉴权头**：它只认 `X-Auth-Token`，把聊天用的 `Cookie: X-Passport-Token` 发到这里会稳定 401（body `code 4010`）。magpie 把 usage 的 401 当作「登录态失效」，所以鉴权头必须分开核对。
  - 读成功后**不带 `signIn` 字段**：magpie 以此把「已退出登录」的标记撤掉。
- **无签到**：CatPaw 没有每日签到活动。

## 协议细节

- 请求头（客户端抓包原样）：`m-appkey: com.sankuai.mcopilot.cli`、`m-debug: true`、`User-Agent: axios/1.19.0`、`m-traceid`/`x-request-id`/`x-trace-id` 每请求随机、`x-agent-version: 1.2.0-beta.6`、`Cookie: X-Passport-Token=...`（聊天网关 `ai.catpaw.meituan.com`）；抓包里的 `m-host` 是客户端本机局域网 IP，插件不发这个头。
- 请求体（客户端抓包原样）：`source: CatX`、`mode: CATX_APP`、`permissionMode: "unsafeBypassPermissions"`、`toolVersion: 2.0.2`。
- **注意**：上表是**聊天网关**的头；**余额接口**（`catx.nocode.cn`）改用 `X-Auth-Token`（见上）。
- turn SSE 总超时：15 分钟（带工具循环的长回答全程在推流，更短会把长回答掐断）。

## 环境变量（测试 / 镜像用）

| 变量 | 默认 |
|---|---|
| `CATPAW_AUTH_PATH` | `~/.meituan-catpaw/auth.json`（妙手桌面端登录态） |
| `CATPAW_BALANCE_URL` | `https://catx.nocode.cn/api/gateway/credit/balance`（余额接口，测试用） |
| `CATPAW_PASSPORT_BASE` | `https://catx.nocode.cn`（网页登录的 passport 域，测试用） |

## 测试

```
bun test packages/catpaw
```

测试打到本地假上游（`fake.mjs`），不触网、不使用真实 token。

## 许可

MIT。
