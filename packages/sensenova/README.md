# SenseNova (SenseTime 日日新) Token Plan

SenseNova（商汤日日新）**Token Plan** 的积分额度与模型，接进 OpenCode 和
[magpie](https://usemagpie.ai)：一次登录同时拿到**额度**（积分池、5 小时 /
7 天窗口、返赠余额与到期）和**模型**（控制台计划内的模型，OpenAI 兼容推理）。

## 一次登录，额度与模型都在

控制台账号（`platform.sensenova.cn`，账号密码）登录时，可同时填入一个
API Key（`sk-…`，可选）。控制台 JWT 读额度，API Key 转发对话——一个账号，
两套凭证，和 workbuddy 式的接入体验一致。

| 凭证 | 来源 | 给什么 |
|---|---|---|
| **控制台 JWT** | OIDC 授权码流（PKCE + IAM） | **额度**：积分池、5h / 7d 窗口、返赠余额与到期 |
| **API Key**（`sk-…`） | 控制台「API Keys」页 | **模型**：计划内的模型清单，OpenAI 兼容推理 |

API Key 是可选的：不填，账号仍显示额度，只是不服务模型。填了，同一个账号
既显示额度、又服务对话。

## 额度

读 `GET /lite/console/v1/tokenplan/pool-usage`，把每个积分池的
`window_5h` / `window_7d` 显示成额度窗口，把 `grant_balance` 显示成会过期
的返赠余额。每个池的窗口标注它覆盖的模型（`models` 字段），让 magpie 按模型
分组渲染——通用积分池与 Flash-Lite 积分池各自独立显示，不挤进同一个 tooltip。

## 模型

API Key 读 `GET /v1/models`（免费、只读、不计费），目录里的 `context_length`
与 `max_output_length` 就是模型声明的窗口与输出上限。请求走
`https://token.sensenova.cn/v1`（OpenAI 兼容）。

模型列表按**计划覆盖**过滤：只列出控制台积分池 `model_ids` 内、且可对话
（非画图）的模型。计划外的模型（如 `deepseek-v4.1-flash`）不列出，避免选到
后 403。每个模型声明它支持的 reasoning effort 档位（`none` / `low` / `medium`
/ `high` / `xhigh` / `max`），magpie 出思考强度选择器。

## 安装

```sh
magpie plugin add @magpie-community/opencode-sensenova-auth
magpie plugin login sensenova-token-plan
```

登录时填控制台账号、密码，以及（可选）API Key。

## 登录的实现

控制台登录走它自己的 OIDC 授权码流（PKCE + IAM）：密码用平台 JWKS 公钥
封成 JWE（RSA-OAEP + A256GCM），明文不上网、不落盘。控制台 JWT 只有约
180 分钟，拿到 `refresh_token` 后自动续期（Hydra 会轮换 refresh token，
每次续期后的新值都会被保存），不需要再输密码。API Key 不参与轮换，续期时
保留在账号上。

## provider id

`sensenova-token-plan`。**不是** `sensenova`：那个 id 留给用户自己的 custom
provider（sk- key，`token.sensenova.cn`），本插件不与之冲突。

## 边界

- 面板显示的是**商汤控制台自己的口径**，与网页控制台一致。
- 免费公测的 key 有 TPM/RPM 限额与 5h / 7d 窗口额度，限流时商汤回 429 或
  `token plan entitlement exhausted`。
- 控制台 JWT 与 AutoClaw 桌面端共用会互踢（refresh token 双方轮换），插件
  登录的账号别同时在桌面端登录。
- 平台若变更接口或加密参数，插件可能失效。

## 许可证

MIT
