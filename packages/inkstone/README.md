# 书生·端砚 Token Plan

[书生·端砚](https://discovery.intern-ai.org.cn)（Intern InkStone，上海人工智能实验室）的
**墨点计划（Token Plan）** 接进 OpenCode 和 [magpie](https://usemagpie.ai)：
一次控制台登录同时拿到**额度**（墨点余额、5 小时 / 7 天窗口、墨点包）
和**模型**（计划内模型的 OpenAI Chat Completions 推理）。

> Unofficial, use at your own risk. This package is not affiliated with, authorized
> or endorsed by Shanghai AI Laboratory. The "Intern InkStone" name and logo are
> trademarks of Shanghai AI Laboratory, used here solely to identify the service.
> It reads the console's non-public `/api/tokenplan/v1/*` endpoints with the browser
> session cookie, and can create (and, if enabled, delete) API keys named `ink-*`
> in your own account. None of this is documented by the platform; it may stop working
> or change at any time. It does not bypass captchas, rate limits or any platform restriction.

## 一次登录，额度与模型都在

| 凭证 | 来源 | 给什么 |
|---|---|---|
| **控制台登录态**（`uaa-token` cookie） | 浏览器登录 / 手动粘贴 | **额度**：墨点余额、5h/7d 窗口、墨点包；支持 magpie 每日签到领免费墨点 |
| **TokenPlan API Key**（`sk-…`） | 控制台「科研模型 → API Key」，或登录时自动创建 | **模型**：计划内模型，OpenAI Chat Completions |

API Key 是可选的：不填，账号仍显示额度，只是不服务模型。填了，同一个账号
既显示额度、又服务对话。

## 登录方式

| 方式 | 做什么 | 产出 |
|---|---|---|
| **浏览器登录（推荐）** | **零提示**：点一下就直接开窗。用**插件自己的专用浏览器 profile** 打开控制台，你在里面登录（密码 / 短信 / 扫码），登录完成后自动创建 `ink-*` API Key。**Windows** 上插件用窗口标题判断登录完成、**自己关窗**；**macOS / Linux** 读不了窗口标题，登录完成后请**自己关掉窗口**，插件接着自动收尾。之后的续期/重登都静默完成 | 额度 + 模型 |
| **浏览器登录 + 复用已有 Key** | 同上，但开窗前会先问一句要不要粘贴现有 Key（留空则新建） | 额度 + 模型 |
| **仅 API Key** | 只粘贴 Key；`GET /v1/models` 探活 | 只有模型 |
| **API Key + 控制台 token** | 粘贴 Key，再粘贴 `uaa-token=…` 那一项（DevTools → Application → Cookies，复制整条 `uaa-token=…` 即可，插件只取值） | 额度 + 模型 |

> 浏览器登录需要本机装有 Microsoft Edge、Google Chrome 或 Chromium（可以用 `MAGPIE_INKSTONE_BROWSER` 指定路径）。Safari 用不了：插件要在单独的浏览器 profile 里登录，Safari 不支持。没有这些浏览器时，选「仅 API Key」，或「API Key + 控制台 token」（token 可以从任何浏览器里复制，包括 Safari）。
>
> 不读、不动你日常浏览器的任何数据：Edge/Chrome 136+ 禁止在默认用户目录上开调试端口，而且把真实 profile 从别的路径打开会清掉端砚登录态。插件的专用 profile 是唯一可行且安全的地方。

账号的 Key 上限是 10 把，所以本插件建的 Key 名字是
`ink-<host>-<account>-<random>`（18 字符），清理只碰这个前缀，**手动建的 Key
永远不动**；默认保留最新两把、并始终保留本次登录创建的那把。

### 登录态复用与续期

`uaa-token` 是网页登录态，不是 OAuth refresh token；平台前端没有 refresh
逻辑。插件默认保留一个**专用浏览器 profile**，快过期时用 headless 打开控制台
页面**静默续期**（SSO 会话还在就会换新 cookie）。关掉 `keep_sign_in` 就改成
一次性 profile：登录完删除，过期后手动重登。

## 模型

插件只使用 **OpenAI Chat Completions**（`https://discovery-api.intern-ai.org.cn/v1`）。
模型清单是两层 live 数据的交集：

- `GET /v1/models`（API Key）：这个 Key 真能调用的模型；
- `GET /api/tokenplan/v1/public/models`（无需登录）：上下文、输入类型、能力、价格。

决策模型 `intern-decision-4b` 只支持 SystemOne，不是聊天接口，不列入。
**不做思考强度档位**：平台明确不支持通过请求参数开启/关闭/调整思考强度
（实测 `reasoning_effort`、`reasoning.effort`、`thinking.type` 都被静默忽略），
插件会把这些字段从请求里剥掉，免得别的入口带来的参数造成干扰。

**免费标记与倍率（magpie 专有展示字段，OpenCode 忽略）：**

- `free: true`：接口价（输入与输出）都是 0 的模型——与控制台自己的免费判定
  一致。目前是 `Agents-A1 / Atria-Dawn / Sage-A1.5 / intern-s2` 四个。
- `rate`：**推导值**，不是平台的官方倍率（平台没有倍率概念，只有"墨点/百万
  token"的绝对价）。归一化口径：**1000 墨点/1M 输入 token = x1**——qwen3.8-27b x0.8、deepseek-v4.1-flash-1017 x1、minimax-m3 x2.1、kimi-k2.6 x6.5、glm-5.3 x8。
  免费模型不设 rate（magpie 的 `rate: 0` 表示"未提供"，不是免费）。rate 不参与
  计费，平台实际按 token 扣墨点。

## 图片与限制

平台对**单次请求里的图片**有硬性限制（2026-11 实测六个模型一致：免费
`Agents-A1 / intern-s2 / Sage-A1.5` 与付费 `deepseek-v4.1-flash / qwen3.8-27b /
kimi-k2.6` 全部相同）：

| 限制 | 数值 |
|---|---|
| 单请求图片张数 | ≤ **8** 张（base64 与 URL 引用都计入） |
| 单张图片体积 | ≤ **10 MB** |
| 单请求图片总体积 | ≤ **40 MB** |
| 支持的格式 | PNG / JPEG / WebP / GIF / BMP（SVG 等被拒） |

体积按**解码后的原图字节**算，不是 base64 字符串长度（base64 有 4/3 膨胀：
11 MB 的 base64 对应约 8.2 MB 原图，是放行的；16 MB 的 base64 对应约 12 MB
原图，会被拒）。

这些限制是**每请求**的、基于请求内容本身的——新会话、重试、换 Key 都绕不开。
图片一旦进了会话历史，之后的每一轮请求都带着它们：超限后这个会话在这个
平台上就持续失败，直到历史里不再引用那么多图片。

### 超限预检

插件在**发请求之前**就检查上面四项：超限的请求**不会发出去**，插件直接
返回一个 magpie 读得懂的「请求形状被拒」错误（400 + `extra inputs are not
permitted: …`）。magpie 对这种错误的处理是**问组里的下一个成员**，而且本家
不休息、不计失败——也就是说，如果你把端砚放进一个多模型的组，图片超限的
请求会自动落到组里别的模型上，任务不中断；端砚单独使用时，你会看到一条
说明清楚原因（几张图、多大、超了哪条）的错误，而不是平台那句读不出来的
原话。拒绝消息是中英双语的：英文主干给 magpie 匹配，中文括号给人看。

### 错误码对照

| 端砚错误 | 含义 | 插件的处理 |
|---|---|---|
| `invalid_media` + "too many images in request" | 超过 8 张 | 预检拦下，不会到达平台；万一到达（如历史边缘竞态），翻译成形状错误 |
| `invalid_media` + "inline image exceeds configured byte limit" | 单张超 10 MB | 同上 |
| `invalid_media` + "cumulative image bytes exceeded …" | 总量超 40 MB | 同上。注意这条平台原话里的 "exceeded" 会让 magpie 误判成「额度用尽」从而休息好账号——插件翻译后的文案避开了这些词 |
| `invalid_media` + "unsupported media type" | 格式不支持（如 SVG） | 预检拦下 |
| `media_fetch_failed` (502) | URL 引用的图片平台拉取失败 | 翻译成形状错误（换一个能拉到的图床，或改用 base64） |
| `quota_exceeded` (429) | 5h/7d 窗口用尽（Anthropic 式响应，看 `Retry-After: 1` 头） | 原样透传，magpie 本来就认 429 |

## 额度卡片

有控制台登录态时，magpie 的账户卡显示：

- 墨点余额与可用墨点包数量；
- **5 小时 / 7 天**两个进度条（已用/总量、重置时间）；
- 每个可用墨点包一行（包名、剩余/总量、到期日）；
- RPM/TPM 限速。

按模型的 token 消耗明细不在额度卡上（那是用量页的事），额度卡只管额度。
读不到的字段不会显示成 0：额度读取失败时卡片说明原因，模型调用不受影响。

## 免费墨点领取（可选）

控制台首页加载时会 `POST /users/free-grant` 领当月免费墨点（幂等，没有按钮）。
本插件**不再自动调用这个接口**；改由 magpie 的 `auth.checkin` 钩子承接：
只有你在 magpie 里为该供应商的「签到」开启时，magpie 才会每天执行一次（幂等，
已领取返回 `done`）。未绑定手机号返回 `ineligible`，卡片不会因此报错。

## 安装

```sh
magpie plugin add @magpie-community/opencode-inkstone-auth
```

然后在 magpie 里给 `书生·端砚` 登录。

## 存储

`uaa-token` 与 API Key 和别的 magpie 钱包插件一样保存在 magpie 的
`auth.json` 里（明文）。`uaa-token` 等于网页登录态，能查看余额、创建 Key、
领取墨点：**不要分享 `auth.json`，不要把 token 贴到公开的截图或日志里**。

**专用浏览器 profile**（里面是活的登录态，等同一个能操作你账号的浏览器）：

- Windows：`%LOCALAPPDATA%\magpie\inkstone-browser`
- macOS / Linux：`$XDG_CONFIG_HOME/magpie/inkstone-browser`（默认 `~/.config/magpie/inkstone-browser`）

插件不把 token 写到任何其他地方；这个 profile 只用于登录/续期，删掉它只是
退出登录态，不影响 auth.json 里的 Key。

## OpenCode 2.x

OpenCode 2.x 没有 `auth.usage` / `auth.refresh` / `auth.checkin`：额度卡片、静默续期和每日签到只在 magpie 里可用；Chat 模型在 2.x 照常可用（预检与改写随 loader 的 fetch 一样生效）。

## 旧入口迁移

旧的书生大模型 Chat/API 入口（`internlm.intern-ai.org.cn`）将按官方公告迁移：
2026-11-09 起只保留 Intern-S2，2027-01-26 起停用。本插件用的是新的
`discovery-api.intern-ai.org.cn`，不受该停用影响。

## 开发

```sh
bun test packages/inkstone
bun scripts/check.mjs inkstone
```

`testdata/public-models.json` 是一次真实的公共模型接口回复（模型 id 未改），
测试用它驱动解析与过滤。所有测试都在本地 fake 上跑，不触网。
`preflight.test.mjs` 里有一份 magpie 宿主 `shapeRefused` 词表的本地拷贝——
改预检文案时它会验证新的措辞仍然命中形状词、不触发排除词。

## License

MIT

## English

Unofficial. One console sign-in gives both the ink credits (balance, 5-hour and
7-day windows, credit packs) and the plan's models over OpenAI Chat Completions.

Four sign-in methods produce the same `intern-inkstone` account: a **zero-prompt
browser sign-in** (one click opens the plugin's own browser profile; the plugin
closes the window itself on Windows, or reads the session after you quit it on
macOS/Linux, then creates an `ink-*` API key), the same browser sign-in with an
optional pasted key to reuse, API key only (models, no credit card), and API key
+ console token (pasted `uaa-token=…`, models and card). The sign-in window
carries no debugging port, so the console's captcha sees an ordinary browser.

Browser-created keys are named `ink-<host>-<account>-<random>` (18 characters).
Pruning (default on) touches only that prefix of this machine's and account's
keys, keeps the newest two and always the key created on this sign-in; manual
keys are never deleted. A dedicated browser profile keeps the console session
for silent renewal (`keep_sign_in`, default on); off, each login's profile is
deleted and an expired token needs a manual sign-in.

The platform caps the pictures of one request: at most **8** (base64 and URL
references both count), **10 MB** per picture and **40 MB** together, measured
in decoded image bytes, not base64 characters (base64 grows by 4/3). The formats
taken are PNG, JPEG, WebP, GIF and BMP. The caps are per request and content
based: once a session's history carries too many pictures, every later turn
fails the same way on this platform.

The plugin checks those caps **before** the request leaves and refuses an over-
the-cap one locally, in the shape magpie reads as "this request's shape is
refused" (400 + "extra inputs are not permitted: …"): magpie asks the group's
next member, and this one rests nobody and counts no failure — in a model group
the task moves on; alone, you get a bilingual message saying which cap the
request passed and by how much. The plan's own image refusals, which magpie
would misread (its "cumulative image bytes exceeded …" hits magpie's quota words
and would rest a healthy account), are translated to the same shape; the plan's
own wording never reaches the response body. Inline images missing a `detail`
get `detail: "auto"`, and the reasoning fields the plan silently ignores are
stripped from the body.

`intern-decision-4b` is a SystemOne decision model, not a chat candidate. The
plan takes no reasoning-effort controls (it silently ignores them), so the
plugin strips those fields. `free` marks the models the console prices at zero;
`rate` is a derived display multiplier against 1000 ink points per 1M input
tokens, not the platform's own (the platform has none).

The daily free ink points (`POST /users/free-grant`) run through magpie's
check-in hook when you turn it on, once a day, idempotent; an account without a
bound phone number reports `ineligible`.

## License

MIT
