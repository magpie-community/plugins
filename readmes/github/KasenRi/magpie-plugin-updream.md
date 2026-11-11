# opencode-updream — UPdream 视频生成 Magpie / OpenCode 工具插件

[中文说明](#-中文说明) | [English Documentation](#-english-documentation) | [API Reverse-Engineering Reference (docs/API.md)](./docs/API.md)

---

> 📌 **状态 / Status**：v0.1.1 已用真实账号端到端验证（2026-11-10，经 magpie v0.1.3563 的 MCP 端点调用）：`account`、`list_video_models live`、`estimate_credits`、`create_video`（Seedance 2.5 样片模式 480p 4s 文生视频，预估与实扣均为 340 积分）、`wait_task`（约 1 分钟出片，854×480 / 4.04s mp4）以及 token 刷新轮换均正常。
> Verified end-to-end against a live account on 2026-11-10 through magpie's MCP endpoint: account, live model list, credit estimate, create_video (Seedance 2.5 draft, 480p, 4 s, t2v: 340 credits estimated = 340 charged), wait_task (~1 min, 854×480 4.04 s mp4) and refresh-token rotation.
>
> 实测与静态表的差异 / Live vs static table: live `GET /ai/video-models` returns `value` ids `sed2`, `sed2-5`, `sed2-fast`, `sed2-mini` (plus non-Seedance models); `sed2-5-draft` is a web-side variant (sent as `sed2-5` + `draft:true`); `wonder-ultra` / `wonder-pro` (导演专属) only appear for eligible accounts. Live config also lists `1080p` for `sed2-5` (the web UI only reaches it by promoting a draft) and `min_tier` (`pro` for sed2 / sed2-5 / sed2-mini, `origin` for sed2-fast). Use `list_video_models {"live": true}` to see what your account has.

## 🇨🇳 中文说明

`opencode-updream` 是一个非官方的 **Magpie / OpenCode 工具插件（Tools Plugin）**，将你的 **UPdream（`https://www.updream.cn`，哔哩哔哩 AI 视频创作平台）** 网页端账号封装为标准 MCP 工具（通过 Magpie 的 `http://127.0.0.1:3425/mcp/magpie/tools` 暴露给 Claude Code、Codex、OpenCode、Cursor 等任意 Agent）。

> ⚠️ **免责声明（DISCLAIMER — 请务必在使用前阅读）**
> 1. **非官方项目**：本项目为社区独立开发的非官方插件，与 **UPdream**、**哔哩哔哩（Bilibili）** 或 **字节跳动（Seedance）** 无任何隶属、合作或官方背书关系。
> 2. **逆向接口不稳定性**：本插件基于对 UPdream 网页端前端代码的逆向工程（详见 [`docs/API.md`](./docs/API.md)）实现，未经过官方开放平台授权，网页端 API 可能随时变更或失效。
> 3. **服务条款与封号风险**：使用自动化工具调用网页端接口可能违反 UPdream 的用户服务协议（Terms of Service）。请自行承担账号受限、封禁或积分损失等全部风险（**Use at your own risk**）。
> 4. **积分消耗提醒**：调用 `updream_create_video` 会真实消耗你 UPdream 账号内的通用积分或模型专属积分，建议先用 `updream_estimate_credits` 或 `sed2-5-draft`（样片模式）测试。
> 5. **凭据安全**：请妥善保管你的 `access_token`、`refresh_token` 及本地持久化文件 `~/.config/magpie/updream-tokens.json`，切勿将其提交到 Git 仓库或分享给他人。

### ✨ 核心功能

- **零依赖原生实现**：纯 Node.js / Bun ES Module，JSON Schema 参数定义，无任何第三方运行时依赖。
- **全系列 Seedance 模型支持**：内置 Seedance 2.5、Seedance 2.5 样片模式（Draft）、Seedance 2.5 导演专属（`wonder-ultra`）、Seedance 2.0、Seedance 2.0 导演专属（`wonder-pro`）、Seedance 2.0 Fast、Seedance 2.0 Mini 的完整参数校验表。
- **多种生成模式**：支持文生视频（`t2v`）、图生视频（`i2v`）、首尾帧视频（`firstlast`）、多模态参考生视频（`ref2v`，支持在提示词中引用 `[@图片1]`、`[@视频1]`、`[@音频1]`）、视频编辑（`video_edit`）与视频延长（`clip2v`）。
- **智能 Token 续期与持久化**：
  - 请求前若 `access_token` 距离过期不足 60 秒自动刷新；遇到 HTTP `401` 自动单飞（Single-flight）刷新并重试一次。
  - 由于 `/api/auth/refresh` 会轮换（Rotate）Refresh Token，插件会自动将最新 `{access_token, refresh_token, project_id}` 以 `0600` 权限持久化到 `~/.config/magpie/updream-tokens.json`，并在重启后优先使用更新的持久化凭据（无写权限环境下自动降级为内存模式）。
- **画布项目与节点自动管理**：自动复用或创建名为 `magpie-updream` 的画布项目与视频节点，无需手动在网页端建项目。
- **本地图片自动上传**：`first_frame`、`last_frame`、`reference_images` 若传入本地文件路径或 Base64，会自动调用 `/upload/image` 上传至 UPdream BOSS 图床。
- **隐私与凭据脱敏**：所有错误消息自动脱敏 Token/Cookie；`updream_account` 自动脱敏手机号与邮箱。

---

### 🎬 支持的 Seedance 模型参数一览

| 模型 ID (`model`) | 名称 | 实际发送 `model_name` | 支持模式 (`mode`) | 时长 (`duration`) | 画面比例 (`aspect_ratio`) | 分辨率 (`resolution`) | 音频 (`audio`) | 专属参数 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `sed2-5` *(默认)* | Seedance 2.5 | `sed2-5` | `t2v`, `i2v`, `firstlast`, `ref2v`, `video_edit`, `clip2v` | `4`–`30`s（默认 `5`；`video_edit` 为 `-1`；`clip2v` 为 `4`–`180`s） | `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, `adaptive`（`i2v`/`firstlast` 强制 `adaptive`） | `480p`, `720p`（默认 `720p`） | 默认开启 (`true`) | `output_format`: `mp4` / `mov` |
| `sed2-5-draft` | Seedance 2.5 (样片模式) | `sed2-5` + `draft: true` | 同 `sed2-5` | `4`–`30`s（默认 `5`；`video_edit` 为 `-1`） | 同 `sed2-5` | 仅 `480p`（默认 `480p`） | 默认开启 (`true`) | `draft: true`, `output_format`: `mp4` / `mov` |
| `wonder-ultra` | Seedance 2.5 (导演专属) | `wonder-ultra` | 同 `sed2-5` | 同 `sed2-5` | 同 `sed2-5` | `720p`, `1080p`（默认 `720p`） | 默认开启 (`true`) | `output_format`: 仅 `mp4` |
| `sed2` | Seedance 2.0 | `sed2` | `t2v`, `i2v`, `firstlast`, `ref2v`, `video_edit` | `4`–`15`s（默认 `5`） | `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, `adaptive` | `480p`, `720p`, `1080p`, `4k`（默认 `720p`） | 默认开启 (`true`) | `bitrate_mode`: `high` / `standard` |
| `wonder-pro` | Seedance 2.0 (导演专属) | `wonder-pro` | `t2v`, `i2v`, `firstlast`, `ref2v`, `video_edit` | `4`–`15`s（默认 `5`） | `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9` *(不支持 `adaptive`)* | `720p`, `1080p`（默认 `720p`） | 默认开启 (`true`) | `bitrate_mode`: `high` / `standard` |
| `sed2-fast` | Seedance 2.0 Fast | `sed2-fast` | 同 `sed2` | `4`–`15`s（默认 `5`） | `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, `adaptive` | `480p`, `720p`, `1080p`, `2k`, `4k`（默认 `720p`） | 默认开启 (`true`) | `bitrate_mode`: `high` / `standard` |
| `sed2-mini` | Seedance 2.0 Mini | `sed2-mini` | 同 `sed2`（`ref2v` 最多 12 张参考图） | `4`–`15`s（默认 `5`） | `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` *(不支持 `adaptive`)* | `480p`, `720p`（默认 `720p`） | 默认开启 (`true`) | `bitrate_mode`: `high` / `standard` |

---

### 📦 安装

使用 Magpie CLI 安装远程 GitHub 仓库或本地目录：

```bash
# 从 GitHub 安装
magpie plugin add github:KasenRi/magpie-plugin-updream

# 或者从本地目录安装
magpie plugin add /path/to/magpie-plugin-updream
```

---

### 🔑 获取凭据与配置

#### 1. 如何从浏览器获取 `access_token` 与 `refresh_token`
1. 在浏览器中打开并登录 [https://www.updream.cn](https://www.updream.cn)。
2. 按 `F12`（或右键 → 检查）打开 **开发者工具（DevTools）**。
3. 切换到 **Application（应用）** 面板 → 左侧展开 **Storage → Local Storage → `https://www.updream.cn`**。
4. 复制以下两个键的值：
   - `access_token`（形如 `eyJhbGciOi...` 的 JWT 字符串）
   - `refresh_token`（用于自动续期与轮换的刷新令牌）

#### 2. 在 Magpie `plugins.json` 中配置（推荐）

在 Magpie 的 `plugins.json` 中为插件添加 `options`：

```json
{
  "plugins": [
    {
      "spec": "opencode-updream",
      "options": {
        "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
        "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
        "workspace": "personal",
        "projectId": ""
      }
    }
  ]
}
```

#### 3. 环境变量配置（备选，优先级：`options` > 环境变量）

| `options` 字段 | 环境变量名 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `accessToken` | `UPDREAM_ACCESS_TOKEN` | — | UPdream 网页端 JWT `access_token` |
| `refreshToken` | `UPDREAM_REFRESH_TOKEN` | — | UPdream 网页端 `refresh_token`（支持自动刷新轮换） |
| `cookie` | `UPDREAM_COOKIE` | — | 可选的原始 `Cookie` 请求头 |
| `baseUrl` | `UPDREAM_BASE_URL` | `https://www.updream.cn/api` | API 基础地址 |
| `projectId` | `UPDREAM_PROJECT_ID` | 自动查找/创建 `magpie-updream` | 存放生成视频节点的画布项目 ID |
| `tokenFile` | `UPDREAM_TOKEN_FILE` | `~/.config/magpie/updream-tokens.json` | 轮换后最新 Token 与 `project_id` 的持久化路径（权限 `0600`） |
| `workspace` | `UPDREAM_WORKSPACE` | `personal` | `X-Workspace` 请求头（个人为 `personal`，团队为 `team:<id>`） |

---

### 🔌 在 Claude Code / Codex 中接入使用

Magpie 启动后会将所有工具插件聚合到 `http://127.0.0.1:3425/mcp/magpie/tools`。由于包名为 `opencode-updream`，Magpie 会剥离 `opencode-` 前缀，将工具暴露为 `updream_<tool>`：

```bash
# 在 Claude Code 中添加 Magpie 工具 MCP 服务
claude mcp add --transport http magpie-tools http://127.0.0.1:3425/mcp/magpie/tools
```

---

### 🛠️ 工具参考（MCP Tools）

| MCP 工具名 | 插件内部名 | 功能说明与主要参数 |
| :--- | :--- | :--- |
| `updream_account` | `account` | 查询账号 ID/昵称（手机号与邮箱自动脱敏）、积分余额明细（总余额/永久/临时/今日消耗/本月消耗）与会员状态。无参数。 |
| `updream_list_video_models` | `list_video_models` | 返回 Seedance 全系列模型参数规格表。可选参数：`all_models` (`boolean`，返回全部 31 个平台模型)、`live` (`boolean`，请求 `/ai/video-models` 获取实时可用状态)。 |
| `updream_upload_image` | `upload_image` | 上传参考图或首尾帧图片到 UPdream BOSS 图床（最大 20 MB）。参数：`url` \| `path` \| `base64`（三选一），可选 `filename`、`folder`。返回 `{ url, filename, mime_type, size }`。 |
| `updream_estimate_credits` | `estimate_credits` | 预估视频生成所需积分（`GET /credit/estimate`）。接受与 `create_video` 相同的模型与参数（`model`, `mode`, `duration`, `resolution`, `audio`, `first_frame`, `reference_images`, `reference_videos`, `ref_video_seconds`, `num_videos`）。 |
| `updream_create_video` | `create_video` | 创建异步视频生成任务（`POST /ai/generate-video/async`）。必填：`prompt`；可选：`model`、`mode`/`generate_type`、`duration`、`aspect_ratio`、`resolution`、`audio`、`output_format`、`bitrate_mode`、`first_frame`、`last_frame`、`reference_images`、`reference_videos`、`reference_audios`、`num_videos` (1–4)、`project_id`、`wait_seconds` (0–40)。 |
| `updream_get_task` | `get_task` | 查询单次任务状态与结果视频（`GET /ai/task/{id}`，传入 `node_id` 时同步检查画布节点是否处于 `waiting_asset_review` 或失败）。参数：`task_id`（必填）、`node_id`（推荐传入）。 |
| `updream_wait_task` | `wait_task` | 轮询等待任务完成或失败（默认最长等待 40 秒，上限 45 秒，轮询间隔 5 秒）。参数：`task_id`、`node_id`、`timeout_seconds`、`interval_seconds`。若返回 `timed_out: true`，请再次调用 `updream_wait_task`。 |
| `updream_cancel_task` | `cancel_task` | 取消排队或进行中的任务（`POST /ai/task/{id}/cancel`）。参数：`task_id`（必填）。 |

---

### 🔄 Agent 调用流程示例

1. **创建任务（`updream_create_video`）**：
   ```json
   {
     "prompt": "赛博朋克雨夜霓虹街道，镜头缓慢向前推进，电影感灯光反射",
     "model": "sed2-5",
     "duration": 5,
     "aspect_ratio": "16:9",
     "resolution": "720p",
     "audio": true
   }
   ```
   返回：
   ```json
   {
     "task_id": "9f8e7d6c-...",
     "status": "pending",
     "project_id": 102400,
     "node_id": 508912,
     "model": "sed2-5"
   }
   ```
2. **轮询等待完成（`updream_wait_task`）**：
   ```json
   {
     "task_id": "9f8e7d6c-...",
     "node_id": "508912",
     "timeout_seconds": 40
   }
   ```
   - 若视频仍在生成（通常需要 1–3 分钟），工具会在 40 秒后返回 `timed_out: true` 和当前 `progress`，Agent 只需继续调用 `updream_wait_task` 即可。
   - 生成完成后返回：
   ```json
   {
     "task_id": "9f8e7d6c-...",
     "node_id": "508912",
     "status": "completed",
     "progress": 100,
     "timed_out": false,
     "videos": [
       {
         "video_url": "https://boss.hdslb.com/updream/video/.../output.mp4",
         "cover_url": "https://boss.hdslb.com/updream/image/.../cover.jpg"
       }
     ]
   }
   ```

### ⚠️ 已知限制（Limitations）
- **单次工具调用超时上限**：Magpie 对每次工具调用设有 55 秒硬超时，因此 `updream_wait_task` 单次最多等待 45 秒。对于耗时较长的视频生成任务，Agent 需多次调用 `updream_wait_task` 直到 `status` 变为 `completed` 或 `failed`。
- **真人素材审核**：Seedance 系列模型对包含真人面部特写的参考图/首帧可能会触发资产审核（`waiting_asset_review`）或拦截。
- **单点登录互踢**：若在网页端退出登录或触发 `session_expired`，刷新令牌将失效，需重新从浏览器获取 Token。

---

## 🌐 English Documentation

`opencode-updream` is an unofficial **Magpie / OpenCode tools plugin** that turns your **UPdream (`https://www.updream.cn`, Bilibili's AI video generation platform)** web account into MCP tools exposed through Magpie's MCP server (`/mcp/magpie/tools`). Because the package is named `opencode-updream`, Magpie exposes its tools with the `updream_` prefix (e.g., `updream_create_video`, `updream_wait_task`).

> ⚠️ **DISCLAIMER — READ BEFORE USE**
> 1. **Unofficial & Unaffiliated**: This project is an independent, unofficial community plugin and is **not** affiliated with, endorsed by, or sponsored by **UPdream**, **Bilibili**, or **ByteDance (Seedance)**.
> 2. **Reverse-Engineered Web API**: This plugin interacts with UPdream's undocumented web API (documented in [`docs/API.md`](./docs/API.md)), which may change or break at any time without notice.
> 3. **Terms of Service & Account Risk**: Automated access to the web API may violate UPdream's Terms of Service. Use this plugin entirely at your own risk.
> 4. **Credit Consumption**: Calling `updream_create_video` spends real credits from your UPdream account. Use `updream_estimate_credits` or `sed2-5-draft` (480p draft mode) to test at lower cost.
> 5. **Keep Tokens Secret**: Never commit your `access_token`, `refresh_token`, or `updream-tokens.json` file to version control.

### ✨ Features

- **Zero Runtime Dependencies**: Pure ES modules running on Node.js >= 20 and Bun, using plain JSON Schema tool definitions.
- **Full Seedance 2.5 & 2.0 Schema Validation**: Validates modes (`t2v`, `i2v`, `firstlast`, `ref2v`, `video_edit`, `clip2v`), durations, aspect ratios, resolutions, audio flags, output formats, bitrate modes, and reference media counts locally before sending requests.
- **Automatic Token Rotation & Persistence**: Proactively refreshes JWT access tokens expiring within 60 seconds, retries once on HTTP `401` (single-flight), and persists rotated `{access_token, refresh_token, project_id}` to `~/.config/magpie/updream-tokens.json` with `0600` file permissions (gracefully falling back to in-memory state if the filesystem is read-only).
- **Automatic Canvas Project & Node Lifecycle**: Automatically reuses or creates the `magpie-updream` project and a video canvas node required by UPdream's generation pipeline.
- **Local Frame Auto-Upload**: Local file paths or base64 data URIs passed to `first_frame`, `last_frame`, or `reference_images` are automatically uploaded via `/upload/image`.

### 🎬 Supported Seedance Models

| Model ID (`model`) | Display Name | API `model_name` Sent | Modes (`mode`) | Duration (`duration`) | Aspect Ratios (`aspect_ratio`) | Resolutions (`resolution`) | Audio (`audio` -> `supports_audio`) | Extra Params |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `sed2-5` *(default)* | Seedance 2.5 | `sed2-5` | `t2v`, `i2v`, `firstlast`, `ref2v`, `video_edit`, `clip2v` | `4`–`30`s (def `5`; `-1` for `video_edit`; `4`–`180`s for `clip2v`) | `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, `adaptive` (forced to `adaptive` on `i2v`/`firstlast`) | `480p`, `720p` (def `720p`) | `true` / `false` (def `true`) | `output_format`: `mp4`, `mov` |
| `sed2-5-draft` | Seedance 2.5 (Draft / 样片模式) | `sed2-5` + `draft: true` | Same as `sed2-5` | `4`–`30`s (def `5`; `-1` for `video_edit`) | Same as `sed2-5` | `480p` only (def `480p`) | `true` / `false` (def `true`) | `draft: true`, `output_format`: `mp4`, `mov` |
| `wonder-ultra` | Seedance 2.5 (Director / 导演专属) | `wonder-ultra` | Same as `sed2-5` | Same as `sed2-5` | Same as `sed2-5` | `720p`, `1080p` (def `720p`) | `true` / `false` (def `true`) | `output_format`: `mp4` only |
| `sed2` | Seedance 2.0 | `sed2` | `t2v`, `i2v`, `firstlast`, `ref2v`, `video_edit` | `4`–`15`s (def `5`) | `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, `adaptive` | `480p`, `720p`, `1080p`, `4k` (def `720p`) | `true` / `false` (def `true`) | `bitrate_mode`: `high`, `standard` |
| `wonder-pro` | Seedance 2.0 (Director / 导演专属) | `wonder-pro` | `t2v`, `i2v`, `firstlast`, `ref2v`, `video_edit` | `4`–`15`s (def `5`) | `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9` *(no `adaptive`)* | `720p`, `1080p` (def `720p`) | `true` / `false` (def `true`) | `bitrate_mode`: `high`, `standard` |
| `sed2-fast` | Seedance 2.0 Fast | `sed2-fast` | Same as `sed2` | `4`–`15`s (def `5`) | `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, `adaptive` | `480p`, `720p`, `1080p`, `2k`, `4k` (def `720p`) | `true` / `false` (def `true`) | `bitrate_mode`: `high`, `standard` |
| `sed2-mini` | Seedance 2.0 Mini | `sed2-mini` | Same as `sed2` (up to 12 ref images) | `4`–`15`s (def `5`) | `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` *(no `adaptive`)* | `480p`, `720p` (def `720p`) | `true` / `false` (def `true`) | `bitrate_mode`: `high`, `standard` |

### 📦 Installation & Configuration

```bash
# Install from GitHub or a local folder
magpie plugin add github:KasenRi/magpie-plugin-updream
# or
magpie plugin add /path/to/magpie-plugin-updream
```

To grab your tokens:
1. Sign in at `https://www.updream.cn`.
2. Open Browser **DevTools → Application → Local Storage → `https://www.updream.cn`**.
3. Copy `access_token` (`eyJ...`) and `refresh_token` (`eyJ...`).

Configure in Magpie's `plugins.json`:

```json
{
  "plugins": [
    {
      "spec": "opencode-updream",
      "options": {
        "accessToken": "eyJ...",
        "refreshToken": "eyJ...",
        "workspace": "personal"
      }
    }
  ]
}
```

Or via environment variables: `UPDREAM_ACCESS_TOKEN`, `UPDREAM_REFRESH_TOKEN`, `UPDREAM_COOKIE`, `UPDREAM_BASE_URL`, `UPDREAM_PROJECT_ID`, `UPDREAM_TOKEN_FILE`, `UPDREAM_WORKSPACE`.

### 🔌 Connecting Claude Code / Codex

```bash
claude mcp add --transport http magpie-tools http://127.0.0.1:3425/mcp/magpie/tools
```

### 🧪 Running Tests

```bash
node --check index.mjs
node --test tests/
```

For complete protocol details and bundle citations, see [`docs/API.md`](./docs/API.md).
