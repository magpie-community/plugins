# @magpie-community/opencode-quwork-auth

**非官方** QuWork（Clawork，微服）接入：[magpie](https://usemagpie.ai/) 与 [OpenCode](https://opencode.ai/) 的模型供应商 `quwork`。支持浏览器手机验证码登录（不需要 QuWork 桌面客户端）、复用桌面端登录态，或粘贴 `sk-` 令牌；显示实时模型与积分余额。

> Unofficial. QuWork publishes no developer API for other clients. This package uses the account and endpoints the QuWork desktop client uses; read the risk section before using or sharing it.

## 登录方式

登录菜单有三项，任选其一：

1. **浏览器登录 QuWork（手机验证码，无需客户端）** —— magpie 在本机 `127.0.0.1` 启动一次性登录页（随机路径、仅本机可访问、10 分钟超时），你在页面里输入手机号、完成 QuWork 的阿里云验证码、填入短信验证码，插件用 QuWork 的 `/api/user/client/login` 换取账号令牌。登录成功后页面提示完成，magpie 自动接管。
2. **读取 QuWork 本机登录态** —— 本机装过 QuWork 桌面端并登录过时，读取它的 `llm_token`（`sk-` 开头）；不启动、不修改桌面端。Windows 读 `%APPDATA%\qurwork-desktop\qurwork-desktop.sqlite`（含 WAL），macOS 读对应的 Application Support 目录。
3. **粘贴 QuWork 令牌** —— 直接粘贴 `sk-` 令牌；只够调用模型，读不到积分余额（余额接口要账号 access token）。

每个登录是一个 magpie 账号，可多账号故障切换。凭据保存在 magpie 的 `plugin-auth.json`（权限 600），不上传；插件不记录请求内容或令牌。

## 模型

供应商 id `quwork`，走 OpenAI Chat Completions 协议：

`https://llm.quwork.cn/v1/chat/completions`

内置 10 个常用模型（目录随 QuWork 配置变化时以插件声明为准）：

| model | context | output | 备注 |
| --- | --- | --- | --- |
| `deepseek-flash` | 1M | 384k | 识图，思考 off/low/high/max |
| `deepseek-v4-pro` | 1M | 384k | 思考 off/low/high/max |
| `qwen3.8-max` | 1M | 128k | |
| `qwen3.8-flash` | 1M | 128k | 识图 |
| `qwen3.7-plus` | 1M | 128k | 识图 |
| `glm-5.3-flash` | 1M | 128k | 识图 |
| `glm-5.2` | 1M | 128k | |
| `kimi-k2.7-code` | 1M | 128k | |
| `kimi-k2.6` | 1M | 256k | 识图 |
| `MiniMax-M2.5` | 1M | 32k | |

在 agent 里用 `quwork/<model>`。

## 积分余额

- 侧边栏 **「QuWork 接入」** 页顶部显示积分余额（登录后自动缓存最新值）。
- magpie 的 **Quota（额度）** 页，或：

```powershell
magpie quota quwork
magpie quota quwork --json
```

余额来自 `GET https://llm.rrzu.com/api/user/self` 的 `data.points_entitlement`，读取不计费；60 秒内复用缓存。401/403 会把账号标为需要重新登录。**浏览器登录**与**读取本机登录态**能读余额；**粘贴 `sk-` 令牌**不能，因为账号接口只认 access token。

## 上游与协议

- 模型：`https://llm.quwork.cn/v1`（OpenAI Chat Completions，`Authorization: Bearer <llm_token>`，另带 `X-QurWork-Env: prod`、`X-QurWork-Version`）。
- 账号：`https://llm.rrzu.com`，登录 `/api/user/client/login`，短信 `/api/sendVerifyCode`（需阿里云验证码 `aliyun_captcha`），资料 `/api/user/self`。
- 验证码 SDK：阿里云官方 `https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`，`region=cn`、`prefix=1hms8d`、`SceneId=10vzkucv`（与 QuWork 客户端一致）。

## 安全与隐私

- 登录页只监听 `127.0.0.1`，使用每次登录随机的 URL 路径；POST 检查 `Origin`，不匹配直接 403；页面禁止被嵌入（`X-Frame-Options: DENY`）、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`。
- 浏览器登录的设备标识保存在系统临时目录的 `magpie-quwork-device.json`（稳定设备 id，降低频繁换设备的风控概率），不是账号令牌。
- 不打印、不上传令牌；错误信息不含令牌。

## 风险提示（重要）

- **非官方集成。** QuWork 没有公开的开发者 API / API Key；本插件复刻的是桌面客户端的登录与模型接口。QuWork 的服务条款可能限制在官方客户端之外使用账号与额度。
- **有账号风险。** 第三方客户端访问可能被上游识别，导致验证码加强、限流、额度冻结、警告或封号；无法保证不会发生。浏览器登录的设备标识已保持稳定，但仍不是官方客户端。
- **请只用你自己的账号。** 不要共享令牌、不要多账号批量/滥用、不要转售或对外提供网关；这些行为显著提高封号与法律风险。
- 上游接口、模型和积分规则随时可能变更；变更后插件可能失效。发布前请阅读 QuWork 客户端内的《Clawork 软件许可及服务协议》。
- 本项目按 MIT 发布，不附带任何担保；使用风险自担。

## 安装与开发

```powershell
magpie plugin add @magpie-community/opencode-quwork-auth
magpie plugin login quwork          # 选第 1 项：浏览器登录
magpie provider test quwork
```

从本仓库开发：

```powershell
magpie plugin add ./packages/quwork
bun scripts/check.mjs quwork
npm test
```

OpenCode：

```json
{ "plugin": ["@magpie-community/opencode-quwork-auth"] }
```

## 页面

安装后侧边栏出现 **「QuWork 接入」**：显示供应商是否已出现、积分余额（缓存）、登录步骤和两种备选登录方式。页面只读取 `providers:list`，不读取账号或请求内容。
