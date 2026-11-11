# Agnes-Code

把 **Agnes Code 桌面端** 的账号额度接入 [magpie](https://usemagpie.ai/) 与 [OpenCode](https://opencode.ai/)：复用桌面端登录态（会话文件解密），直连云端 OpenAI 兼容网关，agent 以 `agnes/<model>` 使用它的模型；支持「每日登录送积分」自动观测与积分余额显示。

## 与 `agnes`（Agnes AI 国际版）的区别

Agnes 在 registry 里有两个入口，都保留（[#614](https://github.com/magpie-community/plugins/issues/614)）：

| | 本包（`agnes-code`） | [agnes](packages/agnes)（`agnes`） |
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

## 登录什么

两种方式（登录时二选一）：

1. **读取 Agnes Code 桌面端登录态（推荐）**——本机装有 Agnes Code 桌面版并登录过即可，不用填任何东西。没装/没登录时这一步会给出 [Agnes Code 官网页](https://agnes-ai.com/agnescode) 链接并自动等待：装好登录后自动完成，不用回来点按钮。本机已有数据但读不出来（登录已过期、DPAPI 解不开、会话里没有 accessToken）会直接说明原因，打开桌面端登录或修好后同样自动完成。插件按 Chrome 同款方案解出会话（`Local State` 的 DPAPI 包裹 AES 主密钥 → 解 `code-auth-session.v1` 的 AES-256-GCM），只在本机、当前 Windows 用户下可解，凭据不外传：
   - Windows：`%APPDATA%\AgnesCode\`；macOS：`~/Library/Application Support/AgnesCode/`（仅粘贴方式）；Linux：`~/.config/AgnesCode/`（仅粘贴方式）。
   - 会话 JWT 过期会提示打开 Agnes Code 重新登录后重试（桌面端负责续期）。
2. **粘贴 accessToken**——从桌面端会话里复制 JWT（`eyJ…`）；可选填用户名便于区分账号。

每个账号登录一次即得一个 magpie 账号，可多账号故障切换。凭据保存在 magpie 的 `plugin-auth.json`（权限 600），不上传。

## 模型

供应商 id `agnes-code`。目录**按账号实时拉取**（`GET /v1/models`，读取不计费）。2026-11 实测目录：

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

免费档「每日登录送 600 积分」由服务端随当日会话自动发放，没有领取接口——插件的 `auth.checkin` 每天做一次账号会话活跃（只读请求）并观测发放前后的余额差：涨了记已领取（+600），没涨记今日已发/未观测到。

## 用量

显示真实积分余额（`GET /api/v2/subscription/credits-balance`，读取不计费）：积分总额、限时积分、永久积分（有则显示）。401/403 会把账号标记为需要重新登录。

## 协议与上游

- 模型调用：`POST https://api-agnes-code.agnes-ai.com/v1/chat/completions`（OpenAI chat 协议，`Authorization: Bearer <accessToken>`，思考在 `reasoning_content`）。
- 模型目录：`GET https://api-agnes-code.agnes-ai.com/v1/models`。
- 积分：`GET https://api.agnes-ai.com/api/v2/subscription/credits-balance`。

## 风险提示

非官方集成，凭据与协议来自桌面客户端逆向，上游随时可能变更；共享登录态的自动化使用可能违反 Agnes Code 服务条款，账号风险自担。请勿用于批量/滥用场景。

## 安装与开发

```
magpie plugin add ./Agnes-Code
magpie plugin login agnes-code              # 选「读取 Agnes Code 桌面端登录态」
magpie provider test agnes-code agnes-3.0-flash
```

测试（零依赖，Node ≥18 或 Bun）：

```
npm test          # = node --test
# 或 bun test
```
