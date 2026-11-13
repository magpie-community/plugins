# Minekuai (麦块云) for OpenCode and magpie

把 [麦块云](https://minekuai.cn)（minekuai.cn）接入 [magpie](https://usemagpie.ai) 的 provider 插件：
用 OpenAI 兼容密钥调用模型，并用网页登录令牌读出账号的真实额度。

## 为什么需要这个插件

麦块云的 `/v1` 网关只实现了三种对话协议：

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`

**没有** sub2api 的 `GET /v1/usage`（实测返回 `404 No endpoint GET /v1/usage.`）。
所以：

- 用现成的 `sub2api` 插件：模型能列、能发请求，但额度行永远是
  `Sub2API query returned HTTP 404`；
- 用现成的 `newapi` 插件：它依赖的 `/api/status`、`/api/user/self`
  在麦块云不存在（返回站点首页 HTML），额度同样读不到。

麦块云自己的额度放在控制台私有接口 `GET /app/token` 上，用**网页登录令牌（JWT）**
鉴权，且必须额外带一个前端硬编码的 `clientid` 请求头。本插件就是补这一段。

## 两套凭证，互不通用

| 凭证                   | 用途               | 接口         | 有效期                      |
| ---------------------- | ------------------ | ------------ | --------------------------- |
| API Key（`sk-…`）      | 列模型、发对话请求 | `/v1/*`      | 长期，可随时停用            |
| 网页登录令牌（`eyJ…`） | 读余额与已用 token | `/app/token` | 约 7 天，过期需重新登录网站 |

- API Key 调 `/app/token` → `401 认证失败`；
- 网页令牌调 `/v1/models` → `401 Incorrect API key provided`。

两者不能互相替代，插件登录时会分别校验。

## 安装

```sh
magpie plugin add @magpie-community/opencode-minekuai-auth
```

## 登录

```sh
magpie plugin login minekuai
```

依次填写三项：

| #   | 问题           | 填什么                                                    |
| --- | -------------- | --------------------------------------------------------- |
| 1   | 麦块云站点地址 | 直接回车用 `https://minekuai.cn`                          |
| 2   | API Key        | 控制台 → API 密钥 → 创建密钥，分组选「按量付费（paygo）」 |
| 3   | 网页登录令牌   | 可留空。留空只接模型，不显示额度                          |
| 4   | 手机号         | 可留空。填了才能**自动续期**（见下节）                    |
| 5   | 登录密码       | 可留空。与网页登录同一个密码                              |

也可以一行喂进去（第 4、5 行为空即不启用自动续期）：

```sh
printf 'https://minekuai.cn\nsk-你的密钥\neyJ你的网页令牌\n你的手机号\n你的密码\n' | magpie plugin login minekuai
```

### 怎么取网页登录令牌

1. 用手机号登录 https://minekuai.cn
2. 按 F12 打开开发者工具 → Console
3. 执行：

```js
JSON.parse(localStorage.getItem("aivideo-auth")).state.token;
```

4. 复制输出的 `eyJ…` 开头的长字符串（约 381 字符）

> 这是**完整登录会话**，能打开你的控制台（订单、密钥前缀、账户资料）。
> 它比 API Key 敏感得多，只存在本机 `~/.config/magpie/logins.json`（0600 权限）。
> 不要发给任何人，也不要贴进聊天工具。

## 网页令牌自动续期

麦块云的网页令牌约 7 天失效，而且**没有 refresh 接口**
（前端 bundle 里搜不到任何 `refreshToken` / `/app/auth/refresh`）。
所以自动续期只能用手机号 + 密码重新登录换一枚新令牌：

```http
POST /app/auth/login
{ "grantType": "password", "phone": "…", "password": "…", "clientId": "…" }
→ { "access_token": "eyJ…", "expire_in": 604800 }
```

插件在两种时机续期：

| 时机              | 行为                                      |
| ----------------- | ----------------------------------------- |
| 令牌距到期 ≤ 1 天 | 查额度/签到前**提前**续期，用户看不到 401 |
| 令牌已被判 401    | 续期后**重试一次**，成功则正常返回额度    |

续期成功后新令牌会写回账号（`client.auth.set`），所以不会每次查询都登录一次。

**失败时会明确说明，不静默**：

- 没填手机号密码 → `网页令牌已过期，且账号未保存手机号与密码，无法自动续期`
- 密码被改过 → `自动续期失败：/app/auth/login: 手机号或密码错误`

登录时如果填了手机号密码，插件会先试一次续期登录，失败只在账号里留一条
`renewNote`，**不阻断登录**（模型部分仍然可用）。

## 每日签到

签到走 **magpie 原生 `auth.checkin` 钩子**（magpie ≥ v0.1.1083）：

1. 打开 Settings → Usage → Plugins，给「麦块云」打开 **Daily check-in**；
2. magpie 每天对每个账号自动签一次（启动 2 分钟后首查、每 30 分钟轮询、
   失败 30 分钟后重试）；
3. 账户的 Usage 卡片显示结果，也可以点 **Check in now** 手动触发。

命令行手动签所有账号：

```sh
magpie accounts checkin
```

### 三种结果都有明确提示

| 情况       | magpie 显示                    | `magpie quota` 里的签到行  |
| ---------- | ------------------------------ | -------------------------- |
| 签到成功   | `claimed` + 奖励、连续天数     | `今日已签 ✓ +10 鱼币`      |
| 今天已签过 | `done`，不算失败               | `今日已签 ✓ +10 鱼币`      |
| 签到失败   | `failed` + 原因，30 分钟后重试 | `签到失败：<原因>`         |
| 今日未签   | 等宿主调度                     | `今日未签，等待自动签到`   |
| 站点名额满 | —                              | `今日未签（今日名额已满）` |

签到状态行是 `aside` 行（只有 `text: true`），**只展示、不参与路由**，
不会被 magpie 当成「还有多少额度」。

## 额度怎么显示

插件把 `GET /app/token` 的两个额度桶都转成 magpie 的窗口：

```text
minekuai · 按量付费 · minekuai.cn …ui4u
  付费按量 token  0% (已用 135 / 共 10 亿)
  免费按量额度    0% (已用 0 / 共 1,000 万)
  鱼币余额        40 鱼币
  今日用量        569.97 万 token · 17 次调用
  每日签到        今日已签 ✓ +10 鱼币
  10.1 亿 token left
```

- **付费按量 token**：买了 10 亿或 100 亿的包，扣完为止，1 元 = 1 亿 token；
- **免费按量额度**：免费档赠送的 token；
- **鱼币余额**：站内货币（签到、邀请、充值进这里，可兑换按量额度），
  来自 `GET /app/wallet` 的 `totalPoints`；有充值和冻结时会展开细分，
  如 `145 鱼币（赠送 40 · 充值 100 · 冻结 5）`；
- **今日用量**：来自 `GET /app/llm/requests/daily`，口径与站点一致——
  **未命中输入 + 缓存读 + 输出**，再加上当天的调用次数；今天没有调用时显示
  `今日暂无调用`；
- **总剩余**：两个 token 桶相加，显示在账号行。鱼币是另一套单位，**不相加**。

两种额度都是**预付费包，没有周期重置**，所以插件不写 `span` / `resetsAt`，
magpie 不会把它画成「每日重置」。

### 已知限制

- 额度只能到**账户级**。密钥列表接口（`/app/apikeys`）里 `quotaPoints` 为 `null`、
  `usedPoints` 对 paygo 恒为 `0.0000`，站点不提供按密钥拆分的 token 用量。
- 网页令牌约 7 天后失效（前端 `expireAt` 记录，JWT 本身没有 `exp` 字段），
  失效后额度行显示「认证失败」，需重新登录网站取新令牌，再执行
  `magpie plugin login minekuai`。

## 站点条款

麦块云《使用规范与禁止内容》写明：

> 不得把 API 密钥接入 new-api、one-api 等中转站、聚合平台或代理服务……
> 发现接入中转站、转售或逆向测试的，直接封禁 API，情节严重的封禁账号。

magpie 是多账号池化并可对外提供 `/v1/magpie/...` 网关，按条款口径属于聚合平台。
**使用本插件存在 API 被冻结或账号被封禁的风险，请自行判断。**

## 开发

```sh
node --check index.mjs
node --test            # 54 项：纯函数 + 本地假站点集成测试
```

- `test.mjs`：地址规整、展示格式、额度换算、账号命名、令牌续期判断、签到结果映射
- `test-integration.mjs`：起一个本地假站点，复刻麦块云的真实响应形状
  （HTTP 200 + body `code:401` 的鉴权失败、`/v1/usage` 的 404、
  `POST /app/checkin` 的 409 已签、`POST /app/auth/login` 的 `access_token`），
  走完 `config → authorize → models → usage → checkin` 整条链路，
  覆盖自动续期的成功/失败/提前续期三种路径

### 站点改版时要跟着改的地方

| 常量                   | 当前值                                            | 来源                                           |
| ---------------------- | ------------------------------------------------- | ---------------------------------------------- |
| `CLIENT_ID`            | `428a8310cd442757ae699df5d894f051`                | 前端 bundle 里硬编码的 `Lc`                    |
| `WEB_TOKEN_TTL`        | 7 天                                              | 前端登录时 `expireAt` 的算法                   |
| `/app/token` 字段      | `paid.{balance,totalIn,totalUsed}`、`permanent.*` | 2026-11-13 实测                                |
| `/app/checkin` 状态    | `checkedIn`、`awardedToday`、`streakDays`         | 2026-11-13 实测                                |
| `/app/auth/login` 响应 | `access_token`、`expire_in`                       | 前端 `setSession(o.access_token, o.expire_in)` |
| 签到重复的业务码       | `409` + `reason: already_checked_in`              | 2026-11-13 实测                                |
