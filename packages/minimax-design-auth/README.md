# @magpie-community/opencode-minimax-design-auth

把本机已登录的 **MiniMax Design** 桌面端订阅接入 [magpie](https://usemagpie.ai/) 与 [OpenCode](https://opencode.ai/)（兼容 OpenCode 1.x / 2.x）：只读解密桌面端会话文件（`hub-config.json` + `.token-key`），动态拉取多协议模型目录（`@ai-sdk/anthropic` 与 `@ai-sdk/openai`），支持流式对话、工具调用与实时积分钱包余额查询。

## 与仓库内现有 MiniMax 包的区别

| 包 | 类型 | 方向与用途 |
| --- | --- | --- |
| **本包（`@magpie-community/opencode-minimax-design-auth`）** | **Provider 插件** | **MiniMax Design → magpie**：把本机 MiniMax Design 桌面端订阅（`design.minimax.cn` / `hub.minimaxi.com` 与国际版 `design.minimax.io` / `hub.minimax.io`）接入 magpie，提供 `minimax-design` 与 `minimax-design-global` 两个 provider，供其他 agent 调用其 Anthropic/OpenAI Responses 模型与积分钱包。 |
| [`@magpie-community/opencode-minimax-auth`](../minimax) | Provider 插件 | **MiniMax Code (`mcode`) → magpie**：走设备码 OAuth（`account.minimax.cn` / `agent.minimax.cn`），服务 MiniMax Code 的 M Plan、独立积分签到与 MCP 工具。 |
| [`@magpie-community/agent-minimax-design`](../minimax-design) | **Agent 插件** | **magpie → MiniMax Design（方向相反）**：把 magpie 网关写进 MiniMax Design 的自定义模型列表，让 MiniMax Design 调用 magpie 下的模型。 |

English: This package is an unofficial **provider plugin** (`minimax-design` for China, `minimax-design-global` for Global) that reuses the local MiniMax Design desktop client's session (read-only AES-256-GCM decryption of `hub-config.json` + `.token-key`, or a pasted `accessToken`) to serve MiniMax Design's live Anthropic Messages and OpenAI Responses models and credit wallet balances inside magpie and OpenCode. It differs from [`@magpie-community/opencode-minimax-auth`](../minimax) (MiniMax Code `mcode` device OAuth and M Plan) and works in the opposite direction of [`@magpie-community/agent-minimax-design`](../minimax-design) (which configures MiniMax Design as a client of magpie).

## 安装与登录

```sh
magpie plugin add @magpie-community/opencode-minimax-design-auth
magpie plugin login minimax-design           # 中国区；国际版使用 minimax-design-global
magpie provider test minimax-design MiniMax-M3.1-Flash
magpie provider test minimax-design gamma_high
magpie quota
```

两种登录方式：

1. **读取 MiniMax Design 桌面端登录态（推荐，macOS / Windows / Linux）**
   - 只读解析本地数据目录中的 `hub-config.json` 与 32 字节 `.token-key`（AES-256-GCM `v2enc:`），不修改任何桌面端文件，不弹窗索要钥匙串。
   - 默认路径：macOS `~/Library/Application Support/@hilo/desktop`、Windows `%APPDATA%\@hilo\desktop`、Linux `${XDG_CONFIG_HOME:-~/.config}/@hilo/desktop`（及 `MiniMax Hub` / `MiniMax Hub Global`）；可通过 `MINIMAX_DESIGN_DATA_DIR` 严格覆盖。
   - 未登录时给出官网链接并轮询等待（最长 5 分钟，支持取消）；同一 `userID` 下支持热感知桌面端刷新后的 token 与团队工作空间（`X-Group-Id`）切换/取消，切到其他账号时不会跨账号扣费。
2. **粘贴 `accessToken`**
   - 使用宿主原生的掩码密钥输入框粘贴会话 JWT（同时兼容 OpenCode 1.x / 2.x 与 magpie）；需要指定团队 `X-Group-Id` 时可配合环境变量 `MINIMAX_DESIGN_GROUP_ID`。

## 模型目录与协议

登录后通过 `GET /api/v1/config` 按账号实时拉取（5 分钟缓存，断网回退解密后的 `lkgProviderConfig` 与启动表）：

| 模型 ID | 显示名 | 协议（SDK） | 特性 |
| --- | --- | --- | --- |
| `MiniMax-M3.1-Flash` | MiniMax M3.1 Flash | `@ai-sdk/anthropic` (`/messages`) | 1M 上下文，工具调用，自适应思考 |
| `MiniMax-M3` | MiniMax-M3 | `@ai-sdk/anthropic` (`/messages`) | 工具调用，思考 |
| `MiniMax-M2.7` | MiniMax-M2.7 | `@ai-sdk/anthropic` (`/messages`) | 工具调用，思考 |
| `alpha` | Gamma-Op 5.5 | `@ai-sdk/anthropic` (`/messages`) | `low` / `medium` / `high`（会员） |
| `gamma_high` | Gamma | `@ai-sdk/openai` (`/responses`) | 自动强制 `store: false`，`low` / `medium` / `high` |
| `gamma-6-astra` | Gamma-Astra | `@ai-sdk/openai` (`/responses`) | 自动强制 `store: false`，`low` / `medium` / `high`（会员） |

注：`/api/v1/config` 中声明为 `@ai-sdk/google` 的 `omega` 条目直连 `/api/v1/models/*` 返回 404，本插件已主动过滤。

## 额度查询（`auth.usage`）

通过 `GET /api/v1/credit/wallet`（随当前工作空间携带 `X-Group-Id`；失败或余额缺失时回退 `GET /api/v1/credit/balance`，团队空间优先展示 `team_credit`）读取会员方案名、到期日、顶层可用积分余额及分项积分明细（`aside`，含同刻到期批次汇总）。

## 环境变量

- `MINIMAX_DESIGN_DATA_DIR`：严格覆盖桌面端数据目录（设置后仅读该路径，不回落默认系统目录）。
- `MINIMAX_DESIGN_GROUP_ID`：手动粘贴 `accessToken` 时可选指定的 `X-Group-Id`。
- `MINIMAX_DESIGN_VERSION_CODE`：覆盖 `version_code` 请求头（默认检测本机应用版本，读不到时回退 `4.0.18`）。

## 风险与验证范围

- 非官方社区集成，协议与凭据读取基于对 MiniMax Design 桌面端的只读分析，上游随时可能变更；请仅在个人合规范围内使用。
- 已在 macOS 本机结合 `magpie 0.1.4790` 隔离沙箱实测中国区 `minimax-design` 登录、9 个实时模型拉取、`MiniMax-M3.1-Flash`/`alpha`/`gamma_high`/`gamma-6-astra` 双协议调用及 `magpie quota` 展示；Windows/Linux 路径与国际版 `minimax-design-global` 通过单元测试与源码对照验证。

## 测试

```sh
HOME=$(mktemp -d) bun test
node --test
```
