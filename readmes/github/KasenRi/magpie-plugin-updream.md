# opencode-updream — UPdream 视频生成 Magpie / OpenCode 多账号与全模型插件

[中文说明](#-中文说明) | [English Documentation](#-english-documentation) | [API Reverse-Engineering Reference (docs/API.md)](./docs/API.md) | [Agent Skill (`skills/updream/`)](./skills/updream/SKILL.md)

---

> 📌 **状态 / Status**：
> - **v0.2.0（2026-11-11）**：新增 **Magpie「模型 → 供应商」页面多账号导入与切换**（`config` + `auth` 钩子，0 聊天模型暴露，OAuth 槽位独立轮换续期）、全工具 `account` 参数与任务归属槽位自动回绑，以及 **23 个非 Seedance 平台模型完整适配**（Kling 4.0 / v3.0 Omni / v3.0 Std / v3.0 Turbo / O1 / 2.5 Turbo、Wan 3.0 / 2.7 / 2.6 / 2.5 / 2.2、VIDU Q4 / Q2 Pro、PixVerse V6 Max、Hailuo H3 / MiniMax H3 Max / Hailuo 2.3、Happyhorse 1.1 / 1.0、Omni 1.1 Flash / Omni Flash、Veo 3.1），并通过线上只读 `/ai/video-models` 与免费 `/credit/estimate` 校验（未调用付费生成接口）。仓库内同步附带脱敏版 `/updream` Agent Skill（[`skills/updream/`](./skills/updream/)）。
> - **v0.1.1（2026-11-10）**：已用真实账号端到端验证 Seedance 生成链路（`account`、`list_video_models live`、`estimate_credits`、`create_video` Seedance 2.5 样片模式 480p 4s 预估=实扣 340 积分、`wait_task` 及 Token 刷新轮换）。

## 🇨🇳 中文说明

`opencode-updream` 是一个非官方的 **Magpie / OpenCode 工具与供应商认证插件**，将你的一个或多个 **UPdream（`https://www.updream.cn`，哔哩哔哩 AI 视频创作平台）** 网页端账号接入 Magpie「模型 → 供应商」管理页，并通过 Magpie 的 `http://127.0.0.1:3425/mcp/magpie/tools` 暴露标准 MCP 工具（`updream_*`）给 Claude Code、Codex、OpenCode、Cursor 等任意 Agent。

> ⚠️ **免责声明（DISCLAIMER — 请务必在使用前阅读）**
> 1. **非官方项目**：本项目为社区独立开发的非官方插件，与 **UPdream**、**哔哩哔哩（Bilibili）** 或各视频模型厂商无任何隶属、合作或官方背书关系。
> 2. **逆向接口不稳定性**：本插件基于对 UPdream 网页端前端代码的逆向工程（详见 [`docs/API.md`](./docs/API.md)）实现，未经过官方开放平台授权，网页端 API 可能随时变更或失效。
> 3. **服务条款与封号风险**：使用自动化工具调用网页端接口可能违反 UPdream 的用户服务协议（Terms of Service）。请自行承担账号受限、封禁或积分损失等全部风险（**Use at your own risk**）。
> 4. **积分消耗提醒**：调用 `updream_create_video` 会真实消耗你 UPdream 账号内的通用积分或模型专属积分，建议先用 `updream_estimate_credits` 核算成本。
> 5. **凭据安全**：请妥善保管你的 `access_token`、`refresh_token`、Magpie `plugin-auth.json` 及本地 `~/.config/magpie/updream-tokens.json`，切勿将其提交到 Git 仓库或分享给他人。

### ✨ 核心功能

- **Magpie「模型 → 供应商」多账号管理**：
  - 在「模型 → 供应商 → + 添加供应商 → 来自插件」中直接看到 **UPdream**，粘贴 `access_token` + `refresh_token` + 可选备注名即可导入多个账号。
  - **故意声明 0 个模型**（`/v1/models` 保持纯净），不污染聊天模型路由或 `/v1/videos`。
  - 每个页面账号独立以 OAuth 结构保存在 `plugin-auth.json`（`updream`、`updream#<hash>`），支持 Magpie 后台自动续期与工具内单飞刷新写回对应槽位，**绝不混写 `~/.config/magpie/updream-tokens.json`**。
- **确定性账号路由与任务回绑**：
  - 所有工具支持可选 `account` 参数（可匹配备注名、自定义别名、槽位键、Token 末 4 位，或 `"options"` 指定旧版配置）。
  - 优先级：`args.account` > `task_id` 历史提交槽位 > 页面置顶启用账号（`first: true`）> `plugins.json` `options` > `UPDREAM_*` 环境变量（页面未添加账号时零中断回退到现有配置；严禁按次轮换账号）。
  - `create_video` 成功后自动记住 `task_id → slot`，后续 `get_task` / `wait_task` / `cancel_task` 即使未传 `account` 甚至中途切换了默认账号，也会精准回到原账号查询；历史未绑定任务遇到 `404` 自动遍历其余启用账号兜底。
- **Seedance + 非 Seedance 全平台模型覆盖（共 30 个可用生成模型）**：
  - Seedance 2.5 / 2.0 全家族（7 个模型）+ 可灵 Kling、通义万相 Wan、生数 VIDU、海螺 MiniMax/Hailuo、拍我 PixVerse、Happyhorse、Omni、Google Veo 等 23 个非 Seedance 模型，涵盖 `t2v`、`i2v`、`firstlast`、`multiframe`（智能多帧）、`ref2v`、`video_edit`、`clip2v`。

---

### 🔑 在 Magpie 供应商页面添加与管理多账号（推荐）

#### 1. 从浏览器获取 `access_token` 与 `refresh_token`
1. 登录 [https://www.updream.cn](https://www.updream.cn)，按 `F12` 打开 **开发者工具（DevTools）**。
2. 打开 **Application（应用） → Storage → Local Storage → `https://www.updream.cn`**。
3. 复制 `access_token`（`eyJhbGciOi...`）和 `refresh_token`。

#### 2. 在 Magpie Web 页面导入账号
1. 打开 Magpie 控制台（默认 `http://127.0.0.1:3430`）→ **模型（Models） → 供应商（Providers）**。
2. 点击 **+ 添加供应商（Add provider） → 来自插件（From plugins） → UPdream**。
3. 依次粘贴 `access_token`、`refresh_token`，并填写便于识别的 **账号备注名称**（例如 `主号`、`二号机`；留空则自动从 JWT 提取 `uid-xxx`）。
4. 如需导入第二个账号，在已出现的 **UPdream** 供应商卡片上点击 **添加账号（Add account）** 即可。
5. 在卡片上将常用账号设为默认（置顶），或随时开关单个账号；工具未传 `account` 时始终使用当前置顶且启用的账号。

#### 3. 兼容旧版 `plugins.json` `options` 与环境变量（自动兜底）

若未在供应商页面登录任何账号（或将整个供应商卡片设为 Off），插件会自动回退读取 `plugins.json` 的 `options` 与环境变量：

| `options` 字段 | 环境变量名 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `accessToken` | `UPDREAM_ACCESS_TOKEN` | — | 旧版单账号 JWT `access_token` |
| `refreshToken` | `UPDREAM_REFRESH_TOKEN` | — | 旧版单账号 `refresh_token` |
| `tokenFile` | `UPDREAM_TOKEN_FILE` | `~/.config/magpie/updream-tokens.json` | 仅在 `options` 单账号兜底模式下读写（页面多账号槽位强制隔离不读写此文件） |
| `baseUrl` | `UPDREAM_BASE_URL` | `https://www.updream.cn/api` | API 基础地址（对所有账号生效） |
| `workspace` | `UPDREAM_WORKSPACE` | `personal` | `X-Workspace` 请求头（`personal` 或 `team:<id>`） |
| `projectId` | `UPDREAM_PROJECT_ID` | 自动查找/创建 `magpie-updream` | 画布项目 ID |

---

### 🎬 支持的视频生成模型一览

#### 1. Seedance 系列（7 个模型）

| 模型 ID (`model`) | 名称 | 支持模式 (`mode`) | 时长 (`duration`) | 画面比例 (`aspect_ratio`) | 分辨率 (`resolution`) | 音频 (`audio`) | 专属参数 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `sed2-5` *(默认)* | Seedance 2.5 | `t2v`, `i2v`, `firstlast`, `ref2v`, `video_edit`, `clip2v` | `4`–`30`s（`video_edit`: `-1`；`clip2v`: `4`–`180`s） | `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, `adaptive`（`i2v`/`firstlast` 强制 `adaptive`） | `480p`, `720p` | `supports_audio`（默认 `true`） | `output_format`: `mp4`/`mov` |
| `sed2-5-draft` | Seedance 2.5 (样片) | 同 `sed2-5` | `4`–`30`s（`video_edit`: `-1`） | 同 `sed2-5` | `480p` | `supports_audio` | 发送 `sed2-5` + `draft: true` |
| `wonder-ultra` | Seedance 2.5 (导演专属) | 同 `sed2-5` | 同 `sed2-5` | 同 `sed2-5` | `720p`, `1080p` | `supports_audio` | `output_format`: `mp4` |
| `sed2` | Seedance 2.0 | `t2v`, `i2v`, `firstlast`, `ref2v`, `video_edit` | `4`–`15`s | `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, `adaptive` | `480p`, `720p`, `1080p`, `4k` | `supports_audio` | `bitrate_mode`: `high`/`standard` |
| `wonder-pro` | Seedance 2.0 (导演专属) | 同 `sed2` | `4`–`15`s | `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9` *(无 `adaptive`)* | `720p`, `1080p` | `supports_audio` | `bitrate_mode`: `high`/`standard` |
| `sed2-fast` | Seedance 2.0 Fast | 同 `sed2` | `4`–`15`s | 同 `sed2` | `480p`, `720p`, `1080p`, `2k`, `4k` | `supports_audio` | `bitrate_mode`: `high`/`standard` |
| `sed2-mini` | Seedance 2.0 Mini | 同 `sed2`（`ref2v` 最多 12 图） | `4`–`15`s | `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` *(无 `adaptive`)* | `480p`, `720p` | `supports_audio` | `bitrate_mode`: `high`/`standard` |

#### 2. 非 Seedance 系列（23 个已适配模型）

| 模型 ID (`model`) | 名称 | 线上 `/ai/video-models` 在售 | 支持模式 (`mode`) | 时长 (`duration`) | 分辨率 / `quality_mode` | 比例 (`aspect_ratio`) | 原生音频 (`audio`) | 额外支持参数 / 约束 |
| :--- | :--- | :---: | :--- | :--- | :--- | :--- | :---: | :--- |
| `kling-v4` | Kling 4.0 | ✅ | `t2v`, `i2v`, `firstlast`, `multiframe`, `ref2v`, `video_edit` | `3`–`30`s（默认 `10`） | `720p`, `1080p`（默认 `1080p`） | `21:9`, `16:9`, `9:16`, `1:1`, `adaptive`（`t2v` 无 `adaptive`） | 无（`ref2v` 支持参考音频） | `multiframe` 3–10 图；`ref2v` 至少 1 图或视频 |
| `kling-v3-omni` | Kling v3.0 Omni | ✅ | `t2v`, `i2v`, `firstlast`, `ref2v` | `3`–`15`s（默认 `5`） | `quality_mode`: `std`(720P), `pro`(1080P), `4k` | `16:9`, `9:16`, `1:1` | `sound`（带参考视频时自动关） | `negative_prompt`, `keep_original_sound`；带视频时参考图 ≤4 |
| `kling-v3.0-std` | Kling v3.0 Standard | ✅ | `t2v`, `i2v`, `firstlast` | `3`–`15`s（默认 `5`） | `quality_mode`: `std`, `pro`, `4k` | `16:9`, `9:16`, `1:1` | `sound` | `negative_prompt`, `cfg_scale` (`0`–`1`) |
| `kling-v3.0-turbo` | Kling 3.0 Turbo | ✅ | `t2v`, `i2v` | `3`–`15`s（默认 `5`） | `720P`, `1080P`（大小写不敏感） | `16:9`, `9:16`, `1:1` | 无 | — |
| `kling-o1` | Kling-o1 | ✅ | `t2v`, `i2v`, `firstlast`, `ref2v` | `5`–`10`s（默认 `5`） | `quality_mode`: `std`, `pro` | `16:9`, `9:16`, `1:1` | 无 | 带参考视频时参考图 ≤4 |
| `kling-v2-5-turbo` | Kling 2.5 Turbo | ✅ | `t2v`, `i2v` | `5`, `10`s | `quality_mode`: `std`, `pro` | `16:9`, `9:16`, `1:1` | 无 | `negative_prompt` |
| `wan-3.0` | Wan 3.0 | ✅ | `t2v`, `i2v`, `firstlast`, `ref2v`, `video_edit` | `2`–`30`s（默认 `5`） | `480P`, `720P`, `1080P` + `quality_mode`: `standard`/`prime` | `adaptive`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` | `sound` | `prompt_extend`（默认 `true`） |
| `vidu-q4` | VIDU Q4 Preview | ✅ | `i2v`, `ref2v` *(无 `t2v`)* | `3`–`16`s（默认 `5`） | `540p`, `720p`, `1080p`, `2k`, `4k` | `16:9`, `9:16`, `1:1`, `4:3`, `3:4` | `supports_audio` | `ref2v` 支持 0–15 图 + 0–3 音频 |
| `vidu-q2-pro` | VIDU Q2 Pro | ✅ | `i2v`, `firstlast`, `multiframe`, `ref2v` *(无 `t2v`)* | `1`–`10`s（默认 `5`） | `540p`, `720p`, `1080p` | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`（仅 `ref2v`） | `supports_audio` | `multiframe` 3–10 图，`ref2v` 1–20 图 |
| `paiwo-v6max` | PixVerse V6 Max | ✅ | `t2v`, `i2v` | `1`–`15`s（默认 `5`） | `360p`, `540p`, `720p`, `1080p` | `16:9`, `9:16`, `4:3`, `3:4`, `1:1`, `2:3`, `3:2`, `21:9` | `supports_audio` | — |
| `hailuo-h3` | Hailuo H3 | ✅ | `t2v`, `i2v`, `firstlast`, `ref2v` | `5`–`15`s（默认 `5`） | `768P`, `2K`（默认 `2K`） | `adaptive`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` | 无（`ref2v` 支持参考音频） | `ref2v` 至少 1 图或视频 |
| `minimax-h3-max` | MiniMax H3 Max | ✅ | `t2v`, `i2v` | `5`–`15`s（默认 `5`） | `480P`, `768P`（默认 `768P`） | `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` | 无 | — |
| `hailuo-2.3` | Hailuo 2.3 | ✅ | `t2v`, `i2v` | `6`, `10`s（默认 `6`） | `768P`, `1080P`（`10s` 仅限 `768P`） | 固定 `16:9`（自动省略） | 无 | — |
| `happyhorse-1.1` | Happyhorse 1.1 | ✅ | `t2v`, `i2v`, `ref2v`, `video_edit` | `3`–`15`s（默认 `5`） | `720P`, `1080P`（默认 `1080P`） | `16:9`, `9:16`, `1:1`, `4:3`, `3:4` | 无 | `ref2v` 1–9 图，`video_edit` 1 视频 + 0–5 图 |
| `happyhorse` | Happyhorse | ✅ | `t2v`, `i2v`, `ref2v`, `video_edit` | `3`–`15`s（默认 `5`） | `720P`, `1080P`（默认 `1080P`） | `16:9`, `9:16`, `1:1`, `4:3`, `3:4` | 无 | 同 `happyhorse-1.1` |
| `gemini-omni-1.1-flash` | Omni 1.1 Flash | ✅ | `t2v`, `i2v`, `firstlast`, `ref2v`, `video_edit`, `clip2v` | `3`–`10`s（默认 `10`） | `360p`, `720p`, `1080p`, `4k` | `16:9`, `9:16`（`i2v` 同样支持） | 无 | `clip2v` 支持 1 参考视频 + 可选尾帧 |
| `gemini-omni-flash` | Omni Flash | ✅ | `t2v`, `i2v`, `ref2v`, `video_edit` | `10`s | `720p` | `16:9`, `9:16` | 无 | `ref2v` 1–4 图 |
| `veo-3.1-preview` | Veo 3.1 | 仅前端/计价表 | `t2v`, `i2v` | `4`, `6`, `8`s（默认 `8`） | `720p`, `1080p` | `16:9`, `9:16` | `sound` | `negative_prompt`, `enhance_prompt` |
| `wan-2.7` | Wan 2.7 | `/ai/supported-models` | `t2v`, `i2v`, `firstlast`, `ref2v`, `video_edit` | `5`, `10`, `15`s | `720p`, `1080p` | `16:9`, `9:16`, `1:1`, `4:3`, `3:4` | 无 | `negative_prompt`, `keep_original_sound` |
| `wan-2.6` | Wan 2.6 | `/ai/supported-models` | `t2v`, `i2v` | `5`, `10`, `15`s | `720p`, `1080p`（`t2v` 自动转 `size`） | `16:9`, `9:16`, `1:1`, `4:3`, `3:4` | `sound` | `negative_prompt`, `shot_type` (`single`/`multi`) |
| `wan-2.6-ref2v` | Wan 2.6 参考生视频 | 仅前端静态表 | `ref2v` | `5`, `10`s | `720p`, `1080p`（自动转 `size`） | `16:9`, `9:16`, `1:1` | `sound` | `negative_prompt`, `shot_type` |
| `wan-2.5-preview` | Wan 2.5 Preview | `/ai/supported-models` | `t2v`, `i2v` | `5`, `10`s | `t2v`: `720p`/`1080p` (`size`)；`i2v`: `480p`/`720p`/`1080p` | `16:9`, `9:16`, `1:1`, `4:3`, `3:4` | `sound` | `negative_prompt` |
| `wan-2.2` | Wan 2.2 | `/ai/supported-models` | `t2v`, `i2v` | `5`s | `t2v`: `720p`/`1080p` (`size`)；`i2v`: `480p`/`1080p` | `16:9`, `9:16`, `1:1`, `4:3`, `3:4` | 无 | `negative_prompt` |

> 注：`test` 为前端内部 Mock 模型，`video-enhance-standard` / `video-enhance-pro` / `subtitle-erase-pro` 为画质增强/去字幕后处理接口，均不属于 `create_video` 生成模型，调用时会返回明确提示。

---

### 🛠️ 工具参考（MCP Tools）

所有工具均接受可选参数 `account`（指定已登录账号备注名/别名/槽位键/末 4 位，或 `"options"`）：

| MCP 工具名 | 插件内部名 | 功能说明与主要参数 |
| :--- | :--- | :--- |
| `updream_account` | `account` | 查询当前选中账号信息、积分余额与会员状态（返回含 `selected: { slot, label }`）。传 `all_accounts: true` 可一次列出所有已导入账号及各自余额。 |
| `updream_list_video_models` | `list_video_models` | 返回 Seedance 模型表及 `non_seedance_models` / `supported_model_ids`；`all_models: true` 在 `models` 中返回全部 31 个模型；`live: true` 请求 `/ai/video-models` 获取实时开放列表。 |
| `updream_upload_image` | `upload_image` | 上传参考素材到指定账号对应的 UPdream BOSS 存储（最大 20 MB）。参数：`url` \| `path` \| `base64`（三选一），可选 `filename`、`folder`、`account`。 |
| `updream_estimate_credits` | `estimate_credits` | 免费预估视频生成积分（`GET /credit/estimate`），支持全部已适配模型及 `quality_mode`、`ref_video_seconds`、`account`。 |
| `updream_create_video` | `create_video` | 创建异步视频生成任务（`POST /ai/generate-video/async`），自动将 `task_id` 绑定到本次使用的账号槽位。 |
| `updream_get_task` | `get_task` | 查询单次任务状态与结果视频；未传 `account` 时自动回绑提交账号，历史任务遇 404 自动遍历其余启用账号。 |
| `updream_wait_task` | `wait_task` | 轮询等待任务完成（单次最长 45 秒，适配 Magpie 55 秒工具硬超时）；自动回绑提交账号。 |
| `updream_cancel_task` | `cancel_task` | 取消排队或进行中的任务（`POST /ai/task/{id}/cancel`）；自动回绑提交账号。 |

---

## 🌐 English Documentation

`opencode-updream` (v0.2.0) is an unofficial **Magpie / OpenCode tools & multi-account provider plugin** for **UPdream (`https://www.updream.cn`)**. It integrates with Magpie's **Models → Providers** UI for multi-account sign-in (declaring **0 chat/video models** so `/v1/models` stays untouched) while exposing 8 `updream_*` MCP tools via `/mcp/magpie/tools`.

### ✨ Highlights in v0.2.0

- **Multi-Account Provider UI (`config` + `auth` + `MagpieAccountPool`)**:
  - Sign in multiple UPdream accounts under **Models → Providers → + Add provider → From plugins → UPdream** by pasting `access_token`, `refresh_token`, and an optional account label.
  - Each UI account is stored as an isolated `oauth` slot (`updream`, `updream#<hash>`) in `plugin-auth.json` with automatic background & single-flight JWT rotation via `client.auth.set` (never touching `~/.config/magpie/updream-tokens.json`).
  - **Credential Precedence**: explicit `account` arg (`"options"` selects legacy config) > `task_id` bound slot > top enabled UI account (`first: true`) > `plugins.json` `options` > `UPDREAM_*` env vars. Never round-robins across accounts.
  - `updream_account` supports `all_accounts: true` to inspect all configured slots and credit balances at once.
- **Full Platform Video Model Support (30 Generative Models)**:
  - **Seedance 2.5 & 2.0 (7 models)**: `sed2-5`, `sed2-5-draft`, `wonder-ultra`, `sed2`, `wonder-pro`, `sed2-fast`, `sed2-mini`.
  - **Non-Seedance (23 adapted models)**: `kling-v4`, `kling-v3-omni`, `kling-v3.0-std`, `kling-v3.0-turbo`, `kling-o1`, `kling-v2-5-turbo`, `wan-3.0`, `wan-2.7`, `wan-2.6`, `wan-2.6-ref2v`, `wan-2.5-preview`, `wan-2.2`, `vidu-q4`, `vidu-q2-pro`, `paiwo-v6max`, `hailuo-h3`, `minimax-h3-max`, `hailuo-2.3`, `happyhorse-1.1`, `happyhorse`, `gemini-omni-1.1-flash`, `gemini-omni-flash`, `veo-3.1-preview`.
  - Supports model-specific payload rules including `supports_audio` vs `sound`, `quality_mode` (`std`/`pro`/`4k`/`standard`/`prime`), `WAN_SIZE_MAP` `size` conversion, `multiframe` keyframe splitting, `ref_video` vs `ref_videos`, `negative_prompt`, `cfg_scale`, `prompt_extend`, `enhance_prompt`, `shot_type`, and `keep_original_sound`.
- **Bundled `/updream` Agent Skill**: See [`skills/updream/`](./skills/updream/) for a portable Claude Code / Agent workflow skill with CLI helper (`scripts/updream.py`), QA inspection (`scripts/qa_clip.py`), lipsync alignment (`scripts/lipsync_align.py`), and credit ledger tracking.

### 📦 Installation & Verification

```bash
magpie plugin add github:KasenRi/magpie-plugin-updream
# or from local path:
magpie plugin add /path/to/magpie-plugin-updream

# Run syntax check & unit tests:
node --check index.mjs
node --test tests/
```

For reverse-engineered protocol details, see [`docs/API.md`](./docs/API.md).
