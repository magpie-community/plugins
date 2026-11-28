# @magpie-community/opencode-agnes-code-auth

把 **Agnes Code** 的账号额度接入 [magpie](https://usemagpie.ai/) 与 [OpenCode](https://opencode.ai/)：直连云端 OpenAI 兼容网关，agent 以 `agnes-code/<model>`（国内站 `agnes-code-cn/<model>`）使用它的模型；支持「每日登录送积分」自动观测与积分余额显示。

双端：国际站 `.agnes-ai.com`（供应商 id `agnes-code`）与国内站 `.agnes-ai.cn`（供应商 id `agnes-code-cn`）各一个 id。两站账号体系与后端都不互通，国内站 token 打国际站一律 401，所以不做「按账号猜域名」。

## 与 `agnes`（Agnes AI 国际版）的区别

Agnes 在 registry 里有两个入口，都保留（[#614](https://github.com/magpie-community/plugins/issues/614)）：

| | 本包（`agnes-code`） | [agnes](../agnes)（`agnes`） |
| --- | --- | --- |
| 登录 | 读 Agnes **Code 桌面端**已保存的会话（Windows，DPAPI + safeStorage），或粘贴 `accessToken` | 在 Chrome 里登录 Agnes AI 国际版网页（agnes-ai.com），不需要桌面端 |
| 服务 | Agnes Code 编码产品：`api-agnes-code.agnes-ai.com/v1`（chat completions，编码模型目录） | Agnes AI 国际版的文本模型、Token/Agent Plan 用量与美元余额 |
| 每日额度 | 本产品的每日积分（`api/v2/subscription/credits-balance`） | 该产品自己的套餐与余额读数 |
| 平台 | 桌面端解密仅 Windows，其余平台走粘贴 | 有 Chrome 即可 |

两者是 Agnes 同一个账号体系下的**两个不同产品**：各自读各自产品的余额读数，装的模型与端点也不同，装两个不会重复也不会互相替代。

English: two entries serve Agnes. This one reuses the Agnes Code desktop's
saved session (Windows) or a pasted `accessToken` and calls the Agnes Code
gateway; the `agnes` entry signs in to Agnes AI international in Chrome and
meters that product's plans and USD balance. Same account system, different
products: neither entry replaces the other.

## 双端：两个供应商 id

| | `agnes-code`（国际站） | `agnes-code-cn`（国内站） |
| --- | --- | --- |
| 登录页 | `app.agnes-ai.com/login`（Google / Apple） | `app.agnes-ai.cn/login`（微信扫码等） |
| BFF / 模型 | `api-agnes-code.agnes-ai.com` | `api-agnes-code.agnes-ai.cn` |
| 积分 | `api-agnes-code.agnes-ai.com/api/v2/subscription/credits-balance` | `api-agnes-code.agnes-ai.cn/api/v2/subscription/credits-balance` |

安装两个包各登录一次即可并存；agent 里按 `<id>/<model>` 选。两端账号不互通，一个端的 token 拿到另一端会明确报 `401`，插件不会把凭据发去错的域名。

## 登录什么

三种方式（登录时三选一）：

1. **浏览器登录（推荐，三平台）**——点一下就打开该站的登录页，本地 `127.0.0.1:<随机端口>` 起一个回调监听，登录成功后自动换票完成，不需要桌面端、不需要密码，因此也没有「错密码反复重试被锁号」的风险。协议细节见下节。窗口没自动弹出时把上面给的链接手动打开即可。
   登录页只给白名单里的 `redirect_uri` 发码：`agnes-code` 只认 `agnes://auth/callback`，`agh-code` 只认 `aghcode://`，而 `agnes-cli*` 才认 `http://127.0.0.1:<port>/auth/callback`。所以插件的回环登录必须用 `client=agnes-cli`；用 `agnes-code` 会被判 `invalidRedirect`，页面当普通登录直接跳首页、永不回调。另外打开链接请直接交给浏览器（或用本插件），别经 `cmd /c start`：URL 里的 `&` 会被 cmd 当命令分隔符，浏览器只会拿到第一段参数，表现和一个错的 client 完全一样。
2. **读取 Agnes Code 桌面端登录态（仅 Windows）**——本机装有 Agnes Code 桌面版并登录过即可，不用填任何东西。没装/没登录时这一步会给出 [Agnes Code 官网页](https://agnes-ai.com/agnescode) 链接并自动等待：装好登录后自动完成，不用回来点按钮。本机已有数据但读不出来（登录已过期、DPAPI 解不开、会话里没有 accessToken）会直接说明原因，打开桌面端登录或修好后同样自动完成。插件按 Chrome 同款方案解出会话（`Local State` 的 DPAPI 包裹 AES 主密钥 → 解 `code-auth-session.v1` 的 AES-256-GCM），只在本机、当前 Windows 用户下可解，凭据不外传：
   - 会话目录：`%APPDATA%\AgnesCode\`，文件名按端区分：`code-auth-session.v1`（国际站）、`code-auth-session.cn.v1`（国内站，实测 657 字节）。只认这一族文件，别的文件不碰。macOS/Linux 下桌面端解密不可用，会明确提示改用浏览器登录或粘贴。
   - 会话里的 `bffPublicBaseUrl` 会被读出来并钉死到 `https://*.agnes-ai.cn` / `.com`：它决定这份凭据属于哪一端。会话属于另一端时会直接报错让用户换对应端的登录入口，而不是拿着 token 去打错的域名。
   - 会话 JWT 过期会提示打开 Agnes Code 重新登录后重试（桌面端负责续期）。
3. **粘贴 accessToken**——从会话里复制 JWT（`eyJ…`）；可选填用户名便于区分账号。

## 浏览器登录协议

```
打开  {loginUrl}?client=agnes-cli&redirect_uri=http://127.0.0.1:<port>/auth/callback&state=<uuid>
页面  POST {code,state} 回本地（跨域：OPTIONS 预检必须回 Access-Control-Allow-Origin；GET query 兜底）
换票  POST {bffBase}/api/v1/code/auth/exchange-code
      headers: origin=<登录页 origin>、x-platform: 1、content-type: json
      body:    {code, redirect_uri, state, client_id:"agnes-cli"}（被拒则再按 agnes-code 重试一次）
      成功 = body.code 为 "000000" 或 "0"，token 在 data.access_token
```

`origin` 头与 `x-platform` 缺一不可（BFF 会校验）；`state` 必须比对，`code` 为空直接拒。回调监听在登录结束后关闭，超时 3 分钟。

每个账号登录一次即得一个 magpie 账号，可多账号故障切换。凭据保存在 magpie 的 `plugin-auth.json`（权限 600），不上传。

## 模型

供应商 id `agnes-code`（国际站）/ `agnes-code-cn`（国内站）。目录**按账号实时拉取**（`GET {bffBase}/v1/models`，读取不计费，两端各拉自己那份）。2026-11 实测国际站目录：

| modelId | context | 备注 |
| --- | --- | --- |
| `agnes-3.0-flash` | 512k | 免费，思考 |
| `agnes-2.5-flash` | 512k | 免费，思考 |
| `agnes-2.5-pro` | 512k | 免费，思考 |
| `gpt-6.1-sol` | 1M | 会员 |
| `gpt-6-astra` | 1M | 会员 |
| `grok-4.7` | 500k | 会员 |
| `claude-opus-5-5` | 1M | 会员 |
| `deepseek-v4.1-flash` | 1M | 会员，思考 |
| `deepseek-v4-pro` | 1M | 会员，思考 |
| `glm-5.3` | 1M | 会员 |
| `kimi-k3` | 1M | 会员 |

带 `thinking_toggle` 的模型标为推理模型；会员专属模型照常列出，免费账号调用会得到上游透明的 403（`subscription_required`），不影响登录态。

## 每日签到

免费档「每日登录送 600 积分」由服务端随当日会话自动发放，没有领取接口——插件的 `auth.checkin` 每天做一次账号会话活跃（只读请求）并观测发放前后的余额差：涨了记已领取（+600）；没涨**不谎称已签**，如实报「未观测到新发放」（发放可能挂靠桌面端登录）。

## 用量

显示真实积分余额（`GET /api/v2/subscription/credits-balance`，读取不计费）：积分总额、限时积分、永久积分（有则显示）。401/403 会把账号标记为需要重新登录。

## 协议与上游

- 模型调用：`POST https://api-agnes-code.agnes-ai.com/v1/chat/completions`（OpenAI chat 协议，`Authorization: Bearer <accessToken>`，思考在 `reasoning_content`）；国内站换成 `api-agnes-code.agnes-ai.cn`。
- 模型目录：`GET https://api-agnes-code.agnes-ai.com/v1/models`；国内站 `.cn`。
- 积分：`GET https://api-agnes-code.agnes-ai.com/api/v2/subscription/credits-balance`；国内站 `.cn`（实测两端 bff 域都直接答 401 而不是 404，所以主路径用 bff 域，`api.agnes-ai.*` 只作兜底）。

## 风险提示

非官方集成，凭据与协议来自桌面客户端逆向，上游随时可能变更；共享登录态的自动化使用可能违反 Agnes Code 服务条款，账号风险自担。请勿用于批量/滥用场景。

## 安装与开发

```
magpie plugin add @magpie-community/opencode-agnes-code-auth
magpie plugin login agnes-code              # 国际站：浏览器登录 / 读桌面端 / 粘贴 token
magpie plugin login agnes-code-cn           # 国内站：浏览器登录（微信扫码等）/ 粘贴 token
magpie provider test agnes-code agnes-3.0-flash
```

本地改包后先在自己的副本里试装（不覆盖市场版）：

```
magpie plugin add ./packages/agnes-code
```

测试（零依赖，Node ≥18 或 Bun）：

```
npm test          # = node --test
# 或 bun test
```
