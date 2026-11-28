# magpie-codearts

[magpie](https://github.com/yetone/magpie) 的华为云 CodeArts 插件，把 CodeArts 接进 magpie 统一管起来，两件事：

- **代理出模型**：登录一次（浏览器授权，与 CodeArts CLI 同一条链路），CodeArts 订阅里的模型——GLM、DeepSeek、OpenPangu、Kimi 等——就以 `codearts/<模型>` 出现在 magpie 的模型列表，并随网关的 OpenAI 兼容接口暴露出去，任何接网关的工具都能用；临时 AK/SK 到期自动续期，无需手动管密钥。
- **管理 Agent**：CodeArts 作为受管 Agent 出现在 magpie 的 Agents 页——模型一键切换；资源库的指令、MCP 服务器、技能也能勾选下发给它。装完打开接入即可，CodeArts 自己的配置不被改写，重启后白名单自动恢复。

## 安装

在 magpie 中执行：

```
plugin add github:liu-zhengdong/magpie-codearts
```

或安装 npm 包后重启 magpie。

## 接入 CodeArts（Agent 页）

安装后 CodeArts 出现在 magpie 的 Agents 页（CLI 里 `magpie ls` 也能看到）。打开接入后，magpie 会把 `provider.magpie` 写进 `~/.codeartsdoer/codearts_cli.json`，并把本插件注册为 CodeArts 的插件——CodeArts 每次启动都会重算 `enabled_providers` 白名单，插件的 config hook 会把 `magpie` 加回白名单，保证重启后仍然可用。

之后在 Agents 页直接选模型，或用命令行：

```
magpie codearts magpie/group/glm-5.3
```

切换后重启 CodeArts 生效。

## 登录（反代方向）

```
auth login codearts
```

浏览器会打开华为云 CodeArts 授权页，登录后自动完成。凭据保存在 magpie 的插件凭据存储中，与 CodeArts CLI 无关，不读取 CLI 的本地数据。

本机装有 CodeArts Agent IDE 并已登录时，登录方法里还会出现「Use the CodeArts Agent on this machine」：直接读取 IDE 自己的登录态（只读它的 `state.vscdb` 副本，不写回），由 IDE 续期，适合浏览器登录不方便的环境。

## 使用

登录后即可在 magpie 中选择 `codearts/…` 模型。magpie 网关（默认 `127.0.0.1:3425`，Token `magpie`）自动以 OpenAI 兼容接口暴露这些模型：

```
curl http://127.0.0.1:3425/v1/chat/completions \
  -H "Authorization: Bearer magpie" \
  -H "Content-Type: application/json" \
  -d '{"model": "codearts/openpangu-2.0-flash", "messages": [{"role": "user", "content": "你好"}]}'
```

## 插件做的事

- **会话治理**：网关按账号限 3 个并发会话（`TM.00001041`）。插件给每个账号分配一个稳定的 `x-ot-session-id`（随登录态换，不随请求换），按账号做并发闸门；撞上限时按退避重试，预算耗尽后回 429 交给 magpie 失败转移。上游把请求排进 trace-queue 时（`queue-status: queued`），按厂商的语义轮询直至晋升，放弃时主动出队。
- **流式兜底**：上游把所有聊天都按 SSE 计账，且常把错误（配额耗尽、未知模型、并发上限）藏在 HTTP 200 的流事件里。插件探测响应头部：只有错误事件的 200 会变成真实的 429/400/502；请求 JSON 的调用方拿到的流会被折叠回单个 completion。
- **thinking 治理**：默认注入 `thinking: enabled`，让推理进 `reasoning_content` 而不是混进正文；`reasoning_effort` 按每模型实测的档位表规范化，`none/off/disabled` 映射到网关自己的 `thinking: disabled`。
- **请求体适配**：`stop`（境内网关拒绝一切非空值）剔除、`max_tokens` 收进 65536、超 64 字符的工具名截断成「55 字符 + sha256」并在响应里还原、GLM 模型自动加 `tool_stream` 防止 60s 空闲断流。
- **免费额度**：`maas_type: benefit` 签名头走免费渠道；每日 benefit 未领取时按 CLI 的方式先 `POST /api/v1/benefit/claim` 再重发；账号没有免费渠道时自动回落为同名的内置收费模型。
- **凭据续期**：refresh token 是一次性的——同一条刷新链上所有续期请求共用一个闸门，续出的新凭据写回 magpie 存储（保住 accountId/uid），401/`APIG.0602` 时带内续一次并重发；只有 `invalid_grant`/token 被用掉才标记「需要重新登录」，STS 抖一下不会误判。
- **用量与签到**：`usage` 读 `statistics/plugin` 的积分桶（总积分在最上，基础/按需/赠送分包折叠展示）+ opengw 的每日免费 token 池 + 各积分批次的过期时间；`checkin` 按 IDE 的「每日领取」流程走 `ops/delivery → claim → confirm`，领取未确认的 claim 和批次过期记进本地账本 `~/.config/magpie/codearts-checkins.json`。
- **签名与出口**：一切请求按华为云 SDK-HMAC-SHA256 签名，签名只发给 snap-access/opengw 两个域——其他任何地址在签名前就被拒；STS 只收 refresh token，IAM 只被用来查一次手机号。

## 可调参数

`magpie plugin options magpie-codearts '{…}'`：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `maxInflight` | 3 | 每账号并发上限（超 3 只会排队，不会更快） |
| `retryBudgetMs` | 150000 | 撞 `TM.00001041` 后的总重试预算 |
| `queueBudgetMs` | 300000 | 在网关队列里等待晋升的预算 |
| `thinking` | true | 关掉后不注入 `thinking`/`tool_stream` 参数 |
| `ledgerPath` | `~/.config/magpie/codearts-checkins.json` | 签到账本位置 |

## 工作原理

- **登录**：走 CodeArts_Tui 的 OAuth（PKCE + DPoP，ES256），本地回环服务器（127.0.0.1，端口 ≥10000）接收授权码或 ticket secret，STS 端点换取临时凭据 `{access_key_id, secret_access_key, security_token}`（约 1 小时有效）；浏览器只被送回 portal 自己的结果页。magpie 在过期前 30 分钟用 refresh token 自动续期。
- **模型列表**：主 agent（`original_id` 为 `build`/`CodeAgent`）的 `agents/detail` 给出每个模型的消耗系数与 thinking 支持，opengw `gateway/config` 给出免费渠道模型，`/v1/model/builtin` 给出内置清单；三路合并去重、隐藏 `-vl` 视觉型号。全部失败时回退内置表。
- **对话**：POST `{inferhub}/api/v2/chat/completions`，OpenAI 兼容；附 x-ot-* 追踪头与 CLI 一致的 client 头（`x-ot-function: agent-tui`、`x-ot-client-version: 26.9.12`）。

## 开发

```
node --test index.test.mjs
```

50 个单测覆盖签名守卫、请求体重塑、SSE 折叠与错误检测、工具名截断、会话/刷新链、用量映射与 signedFetch 端到端路径。

## 许可

MIT
