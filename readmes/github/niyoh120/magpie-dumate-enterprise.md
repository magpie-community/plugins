# magpie-dumate-enterprise

把**百度搭子企业版（DuMate Enterprise）**的租户资源点接入 Magpie / OpenCode 的 provider 插件。
协议于 2026-11-03 对某企业租户实测打通（HTTP 200，含流式 SSE），适用于任意企业租户成员账号。

## 已验证协议

```
企业 Cookie (dumate_enterprise_sessionid, 域 <租户域名>)
  → GET  https://<租户域名>/api/dumate-enterprise/app/v1/user       身份探测（tenantId / userId）
  → GET  https://<租户域名>/api/dumate-enterprise/app/v1/user_token  换 Bearer token（约 6h 有效）
  → POST https://dumate-svc.baidu.com/gateway/apis/ais-v2/chat/completions
       Header: Authorization: Bearer <token>
       Header: X-Dumate-Prd-Source: enterprise
       Header: X-Dumate-Tenant-Id: <tenantId>   （从 /v1/user 的 tenantId 字段获取）
       Body:   OpenAI 兼容 chat.completions
```

与个人版（[magpie-dumate](https://github.com/R227BOUT/magpie-dumate)）的差异：

| | 个人版 | 企业版 |
|---|---|---|
| Cookie | 多条百度账号 Cookie（bce-sessionid 等） | 单条 `dumate_enterprise_sessionid` |
| 租户 API | `console.bce.baidu.com/api/dumate/...` | `<租户域名>/api/dumate-enterprise/app/...`（租户域名即客户端登录时连接的 `enterpriseApiBaseUrl`） |
| token 端点 | `/api/dumate/app/token/get` | `/api/dumate-enterprise/app/v1/user_token` |
| 对话网关 | `dumate-svc.baidu.com/gateway/apis/v1/chat/completions` | `dumate-svc.baidu.com/gateway/apis/ais-v2/chat/completions`（同域名，路径 ais-v2） |
| 租户头 | 无 | `X-Dumate-Prd-Source: enterprise` + `X-Dumate-Tenant-Id` |
| 额度 | `points/quota_overview`（订阅积分） | `users/{bceUserId}/info`（userCredits 个人限额 + consume 今日/本月调用） |
| 签到 | `points/loginBonus`（+500/日） | 无此机制，资源点由组织购买进共享池 |

> 计费说明：企业版实际扣的是**企业共享资源池**，`userCredits` 是管理员给成员设的个人消耗限额；
> 个人限额未用完但池子耗尽时同样无法调用。企业版后台有按成员的用量统计与审计，请合理使用。

## 租户可用模型（来自 POST /v1/model/list-all，2026-11-03）

| ID | 名称 | 上下文 | 输出 |
|---|---|---|---|
| kimi-k31 | Kimi-K3.1 Pro | 1M | 1M |
| glm-53 | GLM-5.3 | 1M | 128K |
| glm-53-flash | GLM-5.3 Flash | 1M | 128K |
| deepseek-v4-pro | DeepSeek-V4 Pro | 1M | 384K |
| deepseek-v41-flash | DeepSeek-V4.1 Flash | 1M | 384K |
| qwen38-flash | Qwen-3.8 Flash | 983K | 128K |

所有模型走 ais-v2 网关，`apiProtocol: openai`，响应含 `reasoning_content`（推理输出）。
实际清单以你的租户 `model/list-all` 返回为准（管理员可在企业平台调整模型接入）。

## 安装

```powershell
magpie plugin add github:<你的账号>/magpie-dumate-enterprise
magpie plugin login dumate-enterprise
```

## 登录方式

1. **桌面端登录态复用**（推荐）：解密本机 `qianfan-desktop-app/auth.json`（企业登录后
   `activeProviderType: "enterprise"`），自动读取 `enterpriseApiBaseUrl`、解密 `cookies`
   （AES-256-GCM，密钥在 `.cookie-key`），并调用 `/v1/user` 探测 `tenantId`——只读，不写任何文件。
   客户端重新登录后，插件 refresh 会自动跟随新 Cookie。
2. **粘贴 auth.json 内容**（跨机/免装客户端场景）：把 `auth.json` 的完整 JSON 粘贴到登录框，
   插件自动从 `enterpriseApiBaseUrl` 计算租户 API 基址、从 `bceUserId` 计算 userId、解密 cookies、
   探测 `tenantId` 并完成登录。`.cookie-key` 的提供方式三选一：
   a. 在粘贴的 JSON 顶层加一行 `"_cookieKeyBase64": "<.cookie-key 内容转 base64>"`
   b. 环境变量 `DUMATE_COOKIE_KEY_BASE64`
   c. 与 `auth.json` 在同一台机器时插件自动从同目录读取

   也支持直接给路径：`file:C:\Users\me\AppData\Roaming\qianfan-desktop-app\auth.json`
   （省去粘贴长 JSON，插件从该文件同目录读 `.cookie-key`）。

   > 输入框在 magpie 界面里被统一标为「验证码」、标题写「请在浏览器中完成登录」——这是 magpie
   > 对 code 类登录方式的固定文案（同类插件如 magpie-codebuddy-import 也一样），无需浏览器、
> 直接粘贴 JSON 或 `file:` 路径后点「完成登录」即可。

自定义数据目录：环境变量 `DUMATE_USER_DATA_DIR`。
其他租户手动登录时用 `tenantApi=` 内联参数或环境变量 `DUMATE_ENTERPRISE_API` 指定基址。

## 已知边界

- 推理模型的思维链与正文共用同一个 `max_tokens` 配额，预算给太小会空正文 + finish_reason=length（上游特性）。
- 企业版无每日签到，插件故意不实现 checkin hook。
- Cookie 失效（约几周）需重开客户端重登（desktop 来源自动跟随）或重新粘贴（manual 来源）。
- 本插件未经官方授权，仅供学习研究；调用消耗的是企业资源池并有审计记录，请遵守公司使用规范。

## License

MIT
