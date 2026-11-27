# @magpie-community/opencode-minimax-design-auth

把本机已登录的 **MiniMax Design** 桌面端订阅接入 [magpie](https://usemagpie.ai/) 与 [OpenCode](https://opencode.ai/)（兼容 OpenCode 1.x / 2.x）：只读解密桌面端会话文件（`hub-config.json` + `.token-key`），动态拉取对话模型（`@ai-sdk/anthropic` 与 `@ai-sdk/openai`，保留上游原始 ID）以及 magpie 原生图像/视频模型（`/v1/images/generations`、`/v1/images/edits`、`/v1/videos`），并支持实时积分钱包余额查询。

## 与仓库内现有 MiniMax 包的区别

| 包 | 类型 | 方向与用途 |
| --- | --- | --- |
| **本包（`@magpie-community/opencode-minimax-design-auth`）** | **Provider 插件** | **MiniMax Design → magpie**：把本机 MiniMax Design 桌面端订阅（`design.minimax.cn` / `hub.minimaxi.com` 与国际版 `design.minimax.io` / `hub.minimax.io`）接入 magpie，提供 `minimax-design` 与 `minimax-design-global` 两个 provider，供其他 agent 调用其对话模型、原生图像/视频生成与积分钱包。 |
| [`@magpie-community/opencode-minimax-auth`](../minimax) | Provider 插件 | **MiniMax Code (`mcode`) → magpie**：走设备码 OAuth（`account.minimax.cn` / `agent.minimax.cn`），服务 MiniMax Code 的 M Plan、独立积分签到与 MCP 工具。 |
| [`@magpie-community/agent-minimax-design`](../minimax-design) | **Agent 插件** | **magpie → MiniMax Design（方向相反）**：把 magpie 网关写进 MiniMax Design 的自定义模型列表，让 MiniMax Design 调用 magpie 下的模型。 |

English: This package is an unofficial **provider plugin** (`minimax-design` for China, `minimax-design-global` for Global) that reuses the local MiniMax Design desktop client's session (read-only AES-256-GCM decryption of `hub-config.json` + `.token-key`, or a pasted `accessToken`) to serve MiniMax Design's live Anthropic Messages and OpenAI Responses chat models (keeping upstream chat model IDs), native magpie image and video generation models (`/v1/images/generations`, `/v1/images/edits`, `/v1/videos`), and credit wallet balances inside magpie and OpenCode. It differs from [`@magpie-community/opencode-minimax-auth`](../minimax) (MiniMax Code `mcode` device OAuth and M Plan) and works in the opposite direction of [`@magpie-community/agent-minimax-design`](../minimax-design) (which configures MiniMax Design as a client of magpie).

## 安装与登录

```sh
magpie plugin add @magpie-community/opencode-minimax-design-auth
magpie plugin login minimax-design           # 中国区；国际版使用 minimax-design-global
magpie provider test minimax-design MiniMax-M3.1-Flash
magpie provider test minimax-design alpha
magpie provider test minimax-design gamma-6-astra
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

登录后通过 `GET /api/v1/config`（对话模型）与 `GET /api/v1/models/config`（图像与视频模型）按账号实时拉取（5 分钟缓存，断网回退解密后的 `lkgProviderConfig` 与启动表）。对话模型保留上游原始 ID 与显示名，避免与真实账号误并入同一自动分组；图像与视频模型按站点区域隔离，并将国内站合规化名映射为规范模型 ID 与显示名：

### 对话模型

| 模型 ID | 显示名 | 协议（SDK） | 特性 |
| --- | --- | --- | --- |
| `MiniMax-M3.1-Flash` | MiniMax-M3.1-Flash | `@ai-sdk/anthropic` (`/messages`) | 1M 上下文，工具调用，自适应思考 |
| `MiniMax-M3` | MiniMax-M3 | `@ai-sdk/anthropic` (`/messages`) | 工具调用，思考 |
| `MiniMax-M2.7` | MiniMax-M2.7 | `@ai-sdk/anthropic` (`/messages`) | 工具调用，思考 |
| `alpha` | Gamma-Op 5.5 | `@ai-sdk/anthropic` (`/messages`) | `low` / `medium` / `high`（会员） |
| `gamma_high` | Gamma | `@ai-sdk/openai` (`/responses`) | 自动强制 `store: false`，`low` / `medium` / `high` |
| `gamma-6-astra` | Gamma-Astra | `@ai-sdk/openai` (`/responses`) | 自动强制 `store: false`，`low` / `medium` / `high`（会员） |

注：`/api/v1/config` 中声明为 `@ai-sdk/google` 的 `omega-3.1-pro` 直连 `/api/v1/models/*` 返回 404，本插件已主动过滤。

### 原生图像与视频模型（magpie Settings → Images / Video）

- **图像（`/v1/images/generations`、`/v1/images/edits`）**：`MiniMax-H3-Image`、`MiniMax-H3-Image-Highspeed`、`gpt-image-2.6-sunburst`、`gpt-image-2.6-flare`、`gpt-image-2.5-sunburst`、`gpt-image-2.5-flare`、`gpt-image-2`、`nano-banana-2`、`nano-banana-pro`、`doubao-seedream-5-0-pro-260628`、`doubao-seedream-4-5-251128`、`midjourney-8.2`（国际版另含 `midjourney-8.1` / `midjourney-7` / `midjourney-niji7`）。编辑请求中的参考图会自动通过 `/api/v1/files/upload` 上传（`openai` / `nano_banana` 使用 data URI），不支持 mask 蒙版编辑（返回 400）。
- **视频（`/v1/videos`、`GET /v1/videos/{id}`、`GET /v1/videos/{id}/content`）**：`MiniMax-H3`、`MiniMax-H3-Max`、`seedance-2.5`、`seedance-2.5-draft`、`seedance-2.0`、`wan-3.0-video`、`wan-3.0-video-prime`、`kling-v3-omni-video`、`kling-avatar`（需传 `input_reference` 与 `extra.sound_file`），国际版另含 `veo-3.1`、`veo-3.1-fast`。
- **原生语音（`/v1/audio/speech`、`/v1/audio/transcriptions`）**：
  - TTS（`POST /v1/audio/speech`）：`speech-2.8-hd`（`minimax_tts`，支持 `voice`/`speed`/`emotion`/`vol`/`pitch`/`pronunciation_dict`/`voice_modify`）与 `seed-audio-1.0`（`seedaudio`，支持 `instructions`/`speed`/`response_format` `mp3`/`wav`/`pcm`/`opus`/`sample_rate` 与参考音频/图像）。
  - ASR（`POST /v1/audio/transcriptions`）：`minimax-asr`（支持 `multipart/form-data` 上传 `file` ≤ 64 MB，超限返回 413，或 HTTPS `audio_url`，输出 `json`/`text`/`verbose_json`/`srt`/`vtt`）。
  - 注：音频模型不进入对话模型选择器，调用时请显式传入带前缀的模型 ID（如 `minimax-design/speech-2.8-hd`、`minimax-design/minimax-asr`）。

## 额度查询（`auth.usage`）

通过 `GET /api/v1/credit/wallet`（随当前工作空间携带 `X-Group-Id`；失败或余额缺失时回退 `GET /api/v1/credit/balance`，团队空间优先展示 `team_credit`）读取会员方案名、到期日、数字余额主窗口（支持 magpie 按余额路由与 0 余额停用）及分项积分明细（`aside`，含同刻到期批次汇总）。

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
