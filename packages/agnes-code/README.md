# @magpie-community/opencode-agnes-code-auth

把 **Agnes Code 桌面端** 的账号额度接入 [magpie](https://usemagpie.ai/) 与 [OpenCode](https://opencode.ai/)：复用桌面端登录态（会话文件解密），直连云端 OpenAI 兼容网关，agent 以 `agnes-code/<model>` 使用它的模型；支持「每日登录送积分」自动观测与积分余额显示。

## 登录什么

两种方式（登录时二选一）：

1. **读取 Agnes Code 桌面端登录态（推荐，仅 Windows）**——本机装有 Agnes Code 桌面版并登录过即可。插件按 Chrome 同款方案解出会话（`Local State` 的 DPAPI 包裹 AES 主密钥 → 解 `code-auth-session.v1` 的 AES-256-GCM），只在本机、当前 Windows 用户下可解，凭据不外传：
   - 会话目录：`%APPDATA%\AgnesCode\`。macOS/Linux 下桌面端解密不可用，会明确提示改用粘贴方式。
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

免费档「每日登录送 600 积分」由服务端随当日会话自动发放，没有领取接口——插件的 `auth.checkin` 每天做一次账号会话活跃（只读请求）并观测发放前后的余额差：涨了记已领取（+600）；没涨**不谎称已签**，如实报「未观测到新发放」（发放可能挂靠桌面端登录）。

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
magpie plugin add @magpie-community/opencode-agnes-code-auth
magpie plugin login agnes-code              # 选「读取 Agnes Code 桌面端登录态」或「粘贴 accessToken」
magpie provider test agnes-code agnes-3.0-flash
```

测试（零依赖，Node ≥18 或 Bun）：

```
npm test          # = node --test
# 或 bun test
```
