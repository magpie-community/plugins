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
  - `手动粘贴 token`：粘完问一次 `current-user` 补 uid/昵称（与网页登录同款，失败不影响登录，回退 token 哈希指纹，不留 token 本身的任何片段）——每个粘贴账号有独立身份，多个粘贴账号不会互相覆盖。
- **无续期接口**：token 过期后 401，网页登录重新发起一次即可；桌面端登录态则在妙手里重新登录（下一请求自动读新 token）。
- **聊天**：`round → event → turn` 三步会话机；上游 SSE 帧为累积式，插件做差分转 OpenAI delta（`content` + `reasoning_content`），流式与非流式都支持。
- **模型**：妙手桌面端的 9 个模型（longcat-2.0 / glm-5.3 系列 / deepseek-v4 系列 / minimax-m3 / kimi-k3 / auto），静态表打底，再按妙手桌面端的做法向网关取账号的模型清单（`POST /api/agent/maas/model-types`，缓存 5 分钟），官方新增的模型（如 LongCat 2.5）无需发版即出现；取不到清单时用静态表。不声明各模型的上下文/输出窗口（客户端未公布，不编造数字），也不声明图片输入（见下）。
- **工具与图片**：会话协议只收一段扁平文本 prompt，图片无法送达——带图片的请求以 **400 明确拒绝**。工具以 **JSON 协议适配**支持：工具定义注入系统指令，模型按 `{"tool_calls":[…]}` 严格 JSON 回复，插件解析回 OpenAI `tool_calls`。只有整条回复就是调用 JSON（裸对象或单个 fence 块）才算调用——散文里引用的示例不会误判；工具名大小写漂移或前后缀漂移（`read_file` → `read`）都会匹配回声明名，但两个声明名同等匹配时放弃（宁可不要也别调错）；未声明的工具名、缺必需参数的调用会被丢弃。两类已知失准也已兜住：模型偶尔**不走 JSON、直接发原生 `tool_use` 帧**（kimi-k3.1-pro 实测），插件同样收集成 `tool_calls`（原生优先，JSON 回复作后备；丢弃规则与 JSON 路径相同：未声明的工具名、不是 `tool_choice` 指定的工具、缺必需参数；先流出一句话再发原生调用时，调用照样交给 agent）；JSON 字符串值里夹了**字面换行/制表符**导致严格解析失败时，只对字符串字面量内的控制字符做转义后重试。流式：普通回复**边出边流**，仅 JSON 开头短暂扣留；`tool_choice=required`/指定工具时整条回复扣住（SSE 心跳保活），保证未拿到调用时能带上下文重试一次；`tool_choice=none` 保持原样透传。
- **余额（usage）**：`GET https://catx.nocode.cn/api/gateway/credit/balance`，鉴权头是 **`X-Auth-Token: <accessToken>`**。
  - ⚠️ 这个接口与聊天网关**不是同一个鉴权头**：它只认 `X-Auth-Token`，把聊天用的 `Cookie: X-Passport-Token` 发到这里会稳定 401（body `code 4010`）。magpie 把 usage 的 401 当作「登录态失效」，所以鉴权头必须分开核对。
  - 读成功后**不带 `signIn` 字段**：magpie 以此把「已退出登录」的标记撤掉。
  - 「可用积分」窗口：上游只给余额（`availableCredits`），不给总额与累计用量，所以 `used` 恒为 0、不伪造。`userPlan.nextRefreshTime`（毫秒时间戳）作为窗口的 `resetsAt`，magpie 的 Smart 路由据此先用积分先刷新的账号（plugins#867）；该字段缺失或无法解析时窗口保持 `aside`，不参与排序。
- **无签到**：CatPaw 没有每日签到活动。

## 协议细节

- 请求头（客户端抓包原样）：`m-appkey: com.sankuai.mcopilot.cli`、`m-debug: true`、`User-Agent: axios/1.19.0`、`m-traceid`/`x-request-id`/`x-trace-id` 每请求随机、`x-agent-version: 1.2.0-beta.6`、`Cookie: X-Passport-Token=...`（聊天网关 `ai.catpaw.meituan.com`）；抓包里的 `m-host` 是客户端本机局域网 IP，插件不发这个头。
- 请求体：`source: CatX`、`mode: CATX_APP`（round 与 turn 同一份）、`permissionMode: "unsafeBypassPermissions"`、`toolVersion: 2.0.2`。2026-10-09 抓包里的 `CatPawCLI` / `CLI` 已被网关停用（返回 `code=400 msg=source 不存在或未启用: CatPawCLI`，plugins#605），0.1.1 起改回 `CatX` / `CATX_APP`，请求头不变。
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
