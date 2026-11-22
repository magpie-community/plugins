# MOSS (模思智能)

[MOSS 开放平台](https://platform.mosi.cn)（模思智能，复旦 OpenMOSS 团队孵化）接进
OpenCode 和 [magpie](https://usemagpie.ai)：用你的 API Key 调用 **Nex-N2.6**
对话模型（OpenAI Chat Completions），按账号从 `/v1/models` 列出可用模型。

> Unofficial, use at your own risk. This package is not affiliated with, authorized
> or endorsed by MOSI.AI. The "MOSS" name and logo are trademarks of MOSI.AI,
> used here solely to identify the service. Browser sign-in reads the console's
> non-public balance endpoints with your own console session, in a dedicated
> browser profile. None of this is documented by the platform; it may stop
> working or change at any time. It does not bypass captchas, rate limits or
> any platform restriction.

## 模型

- **Nex-N2.6**：多模态语言模型（文本、图片、视频 → 文本），当前**限时免费（0 积分，
  模型清单里标 `free`）**。
  上下文窗口 **256K（262144）**，输出参数上限 131072（生产默认 8192）。插件声明
  reasoning、tool_call 与图片输入能力（视频经实测可用，但模型清单的模态只声明到
  图片）；`/v1/chat/completions`、`/v1/responses`、`/v1/messages` 三个协议均支持。
  - 多模态输入（2026-11-21 实测）：图片走 `image_url.url`，视频走 `video_url.url`
    （MP4/WebM 均可；Messages 协议实测不收视频）。两者都接受完整 base64 data URL；
    公网 URL 由 MOSS 服务端代抓，能不能用取决于对方站点是否屏蔽其抓取
    （media.w3.org、httpbin.org、picsum.photos 实测可抓，wikimedia/google 被拒
    `media download failed`）。base64 视频（25KB MP4 与 WebM）实测可用。
  - 请求体实测上限是 **8 MiB（8388608 字节，ASCII 时）**，不是文档写的 10 MiB；
    超出返回 400 `invalid_request`。中文等多字节字符约 **3 MiB（≈105 万字）**即触顶。
    不支持 `file_id`/文件字段进聊天。
  - 已知行为（实测）：`thinking: {type: "disabled"}` 在 Chat 与 Messages 协议都会被
    400 拒绝（Chat: `invalid_field_value`"Nex does not support disabling thinking"；
    Messages: `invalid request`）；`thinking: {type: "enabled"}` 与省略均正常，思考
    过程在 `reasoning_content`。Responses 协议用 `reasoning: {effort}`，无 disable。
    客户端执行的函数工具可用。
  - 限流：文档称 Nex-N2.6 每用户并发 10、其余模型共享 70 RPM / 30,000 RPD。
    `maxConcurrency` 按文档设为 10。注意上游实际执行比文档严得多，且随负载浮动
    （2026-11-21 实测：瞬时并发有时放行 2–3 个，有时 10 个全过；全天网关日志里
    出现过约 130 次 429 `concurrency_limit_exceeded`，多数集中在多会话并行时段；
    被拒的请求会被上游挂住 37–42 秒才返回）。被 429 时 magpie 会自动重试。若
    你的使用场景经常多会话并行、且想减少重试等待，可在安装目录 package.json 里
    自行调低 `maxConcurrency`。
- 快照 `nex-n2.6-2026-11-05` 可固定版本。
- **tob-kimi-k3**（Kimi K3，ToB）：平台模型列表里的另一个对话模型；本插件的
  自助 Key 未开通该模型（调用返回 403 forbidden），官方也未公布其上下文数字，
  因此声明为能力未知、不标免费。OpenCode 2.x 桥接层会给未知上下文填默认值
  128K，这只是桥接层的兜底，不代表该模型实际有 128K 上下文。
- 模型清单按账号从 `/v1/models` 动态刷新；浏览器登录（含自动建 Key）与粘贴 Key
  两种登录都走同一份在线清单。在线清单读不到（账号没有可用 Key、网络失败或
  应答异常）时使用内置表兜底。
- 其余模型（TTS、转写、文生图、实时视频理解等）不是 Chat Completions 对话接口，
  不进入聊天清单。

## 登录方式

| 方式 | 做什么 | 给什么 |
|---|---|---|
| **浏览器登录** | 专用浏览器 profile 打开 [platform.mosi.cn](https://platform.mosi.cn) 控制台登录（零输入，无需粘贴） | 积分卡 + 模型；按需自动创建 API Key |
| **浏览器登录 + 已有 Key** | 同上，但粘贴已有 API Key | 积分卡 + 模型（不创建新 Key） |
| **API Key** | 粘贴 Key | 模型（Key 探活，不读控制台） |
| **API Key + 控制台 Cookie** | 粘贴 Key 与 `moss_studio_prod_access_token` Cookie 值 | 积分卡 + 模型（无浏览器） |

浏览器登录使用两段式流程：先打开可见窗口完成登录（含阿里云 WAF 验证码），登录完成后
优雅关闭窗口，再用无头 CDP 读取控制台会话 Cookie——与"书生专业"插件同一套反检测设计。
进程管理只按本插件专用 profile 的 `--user-data-dir` 路径匹配，绝不触碰日常浏览器。

### 积分与 Key 管理

- **积分卡**：展示可用积分（控制台原始显示串）、冻结积分、近期流水与预估可用天数；
  会话过期时先尝试用浏览器 profile 静默续期，成功后自动重试一次。积分卡行文案
  目前为中文（与控制台中文界面一致），暂不随宿主语言切换。
- **每日赠送提示**：MOSS 每日登录 [MOSS Create](https://create.moss.cn)（左下角入口，
  与控制台同账号 SSO）可领 50 积分、当日有效；新用户注册另送 50 积分（30 天内有效）。
  这部分在 Create 侧发放，控制台 API 查不到领取状态，插件在积分卡里以提示行展示入口。
- **积分有效期**：充值积分自购买日起 365 天有效；赠送积分有效期以发放页标注为准
  （每日赠送当日有效）。余额与流水来自控制台 `usage-summary` 与 `transactions`。
- **自动创建 Key**：登录后在本机+账号前缀（`moss-<host>-<acct>-*`）下创建并探活新 Key；
  粘贴的 Key 探活通过后直接使用。
- **自动清理**：账号达 50 个 Key 上限时，先清理本前缀最旧的 Key（保留最新 2 个、
  保护本次新建、跳过手工 Key 与时间不可读的 Key）再创建。若已达上限且关闭了
  自动清理，登录会失败并提示去控制台删 Key 或开启自动清理。
- **静默续期**：`keep_sign_in` 开启时（默认开），积分卡读取遇到会话失效会用
  无头浏览器静默重登一次；失败则如实显示"登录已过期"。
- **账号状态语义**：API Key 被 MOSS 拒绝（401/403）→ 账号标记为"登录已过期"，
  需重新登录；仅控制台会话过期 → 聊天不受影响，积分卡显示"会话已过期"，
  重新完成一次浏览器登录即可恢复积分显示。

## 环境变量

| 变量 | 作用 |
|---|---|
| `MAGPIE_MOSS_BROWSER` | 指定浏览器可执行文件路径，覆盖 Edge/Chrome/Chromium 的自动探测 |
| `MAGPIE_MOSS_PROFILE` | 指定专用浏览器 profile 目录，覆盖默认位置（`%LOCALAPPDATA%\magpie\moss-browser`） |

代理：请求经宿主（magpie/OpenCode）发出，账号上配置的代理会作用于全部 MOSS 请求；
插件自身不读代理环境变量。

## Base URL

- API：`https://api.mosi.cn/v1`（OpenAI SDK 兼容）
- 控制台：`https://platform.mosi.cn`

## 协议支持

MOSS 的 Nex-N2.6 同时支持三种协议：Chat Completions（`Authorization: Bearer`）、
Responses、Anthropic 风格 Messages（`x-api-key` + `anthropic-version: 2023-06-01`）。
本插件走 Chat Completions。

## License

MIT
