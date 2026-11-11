# MobileClaw for Magpie

<img src="assets/mobileclaw-icon.png" width="88" height="88" alt="MobileClaw icon">

给 Magpie 用的**非官方** MobileClaw（移动云）供应商插件。用自己的账号登录，用自己套餐里的模型。不共享账号，不绕过验证码、套餐或访问控制。和 MobileClaw、中国移动、Magpie 都没有隶属关系。

当前 `0.1.2`，实验性质。上游是私有接口，可能变。

## 能做什么

- 手机号验证码、MobileClaw 密码、手动令牌三种登录方式。
- 登录后显示账号真实可用的模型，不写死。
- 文本聊天、图片理解、流式回复、取消请求。
- 按 Magpie 的搜索钩子接入 MobileClaw 官方网页搜索。
- 读 Coding Plan、Token Plan 和体验额度，支持每日签到领取额度。

实测过的：

- 当前账号登录可用；
- `magpie provider test mobileclaw` 对 `glm-5.3` 返回 `✓ chat`；
- 体验额度显示 `36,000,000 tokens left`；
- 官方搜索接口返回 200。

没实测的：

- 短信、密码登录的完整流程；
- 多模态模型的真实图片请求；
- 视频理解、图片/视频生成、企业工作区。

## 安装

```sh
magpie plugin add github:lyimoexiao/opencode-mobileclaw-auth
magpie plugin login mobileclaw
```

应用里也可以打开「插件 → 添加插件」，填 `github:lyimoexiao/opencode-mobileclaw-auth`。

供应商 ID 是 `mobileclaw`，Agent 里用 `mobileclaw/模型名`。

更新、退出：

```sh
magpie plugin update
magpie plugin logout mobileclaw
```

## 登录

**手机号 + 短信验证码**：输入手机号，收验证码。手机号用客户端里的 RSA 公钥加密后发送。

**手机号 + MobileClaw 密码**：要的是 MobileClaw 里设置的密码，不是移动云控制台密码。密码加密发送，不保存。

**手动导入令牌**：填明文 access token，不要带 `Bearer `。填 refresh token 时必须同时填原登录的 `deviceId`。不要把官方客户端磁盘里的加密字符串直接贴进来。

多账号时填要用的 `userId`；留空会报错，不会替你选。`aiProvider` 留空用第一个订阅。目前只支持个人工作区。

## 模型、图片、搜索

模型列表按官方字段对齐：`contextLength`、`maxOutputLength` 乘 1000，`modelTypes` 映射成输入/输出能力，`pkgTypes` 与订阅可用套餐求交集后作为 `pkg-types` 请求头。官方的 `rate` 是 token 计价比例（例如 `1:1000Token`），不是 Magpie 的额度倍率，所以不传。

图片理解模型会标 `input.image`、`attachment`、`modalities.input`，图片消息按 OpenAI Chat 的 `image_url` 原样透传。当前账号没有多模态套餐，真实图片请求还没跑通上游。

搜索走官方：

```text
GET https://zhenze-huhehaote.cmecloud.cn/desktop/search/v2/mwebsearch
```

用已登录账号的令牌，参数包括 `q`、`ref_prom=aiso-sr`、`sid`、`count`。结果转成 Magpie 的 `{title, url, text, age}`。官方引擎还有 DuckDuckGo、Exa 兜底，这里没实现；主接口失败就交给 Magpie 重试或换搜索源。

官方 chat 不发 `context-limit`，插件也不发。Magpie 不会把模型 `headers` 带到聊天请求，插件会在第一次聊天前查一次模型列表，补上必需的 `pkg-types`。

## 额度

读三类：

- Coding Plan：日、周、月用量和重置时间；
- 个人 Token Plan：已用/总 token；
- 体验额度：剩余 token。

余额窗口不会伪造 `used/limit`，未知值不显示成 0。金融权益、免费用量统计、企业额度没接。

每日签到走官方 `/token-welfare` 接口，用 Magpie 的签到钩子：已领报 `done`，领取成功报额度金额和连续天数，未注册、未实名报 `ineligible`。签到只在个人工作区有效。

## 限制

- 多账号选择要手填 `userId`，没有交互选择界面。
- 企业工作区、扫码、SIM 登录没做。
- 没有 refresh token 的手动导入不会自动续期。
- 和官方客户端共用 refresh token 可能互相顶下线。

## 安全边界

登录信息由 Magpie 保存在 `plugin-auth.json`，插件不另存凭据。对话、模型、额度和搜索请求只去 `zhenze-huhehaote.cmecloud.cn` 的官方接口。带凭据请求拒绝重定向；模型请求只允许官方 Chat Completions 路径。日志不打印手机号、密码、令牌、提示词或服务端错误正文。

插件不发送 MobileClaw 遥测，也不伪造官方遥测来规避封号或风控。它只发完成登录、模型、额度、搜索和聊天所需的请求。

## 开发

无运行时依赖，ESM，Magpie 的 Bun 宿主直接加载。测试用 Node.js 20+：

```sh
npm test
npm run check
```

沙箱测试：

```sh
sb=$(mktemp -d)
m() { env HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add "$PWD" </dev/null
m plugin --json
m plugin login mobileclaw
m provider test mobileclaw
m quota
m plugin logout mobileclaw
```

技术调查在 [PROTOCOL.md](docs/PROTOCOL.md) 和 [FOLLOWUP-AUDIT.md](docs/FOLLOWUP-AUDIT.md)。

## English

Unofficial experimental MobileClaw provider for Magpie: SMS/password/manual-token sign-in, account-scoped renewal, subscription-aware models, image-capable model metadata, official web search, quotas and streaming Chat Completions. Install with `magpie plugin add github:lyimoexiao/opencode-mobileclaw-auth`. No build step or runtime dependencies. Use your own authorized account and follow upstream terms. No telemetry spoofing.

## License

代码是 MIT。`assets/` 里的 MobileClaw 图标只用来标识兼容目标，权利归原方，不在 MIT 授权范围内，见 [NOTICE](NOTICE)。
