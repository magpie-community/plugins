# opencode-xiaoyunque — 小云雀（XiaoYunQue / Pippit CN）视频生成 Magpie / OpenCode 工具插件

[中文说明](#-中文说明) | [English Documentation](#-english-documentation) | [API Reverse-Engineering Reference (docs/API.md)](./docs/API.md)

---

> 📌 **状态 / Status**：官方 Access-Key (`skill/*`) 后端已默认启用并通过端到端实测 / Official Access-Key (`skill/*`) backend enabled by default & E2E verified

## 🇨🇳 中文说明

`opencode-xiaoyunque` 是一个 **Magpie / OpenCode 工具插件（Tools Plugin）**，将 **小云雀（`https://www.xiaoyunque.com` / `https://xyq.jianying.com`，字节跳动 / 剪映旗下 Pippit 国内版 AI 视频创作平台）** 封装为标准 MCP 工具（通过 Magpie 的 `http://127.0.0.1:3425/mcp/magpie/tools` 以 `xiaoyunque_*` 工具名暴露给 Claude Code、Codex、OpenCode、Cursor 等任意 Agent）。

插件支持双后端架构，**当配置了 Access Key 时默认优先使用官方 Skill API 后端**：
1. **官方 Access-Key 后端（默认推荐，支持无头 Linux 服务器）**：纯 JavaScript 直接调用小云雀官方 CLI 同款接口 `https://xyq.jianying.com/api/biz/v1/skill/*`（`Authorization: Bearer <AccessKey>`，`User-Agent: Pippit-CLI/1.0`），无需浏览器、无需 Cookie、无需 `a_bogus` 签名，也不会触发网页端 Shark 滑块风控（`ret=16014`）。
2. **网页端 Cookie 后端（兼容回退）**：当未提供 Access Key 且配置了 `cookie` / `cookieFile` 时，回退至 `https://www.xiaoyunque.com` 网页端接口（含纯 JS `bdms` `a_bogus` 签名与 `/commerce/*` MD5 签名）。

> ⚠️ **免责声明（DISCLAIMER — 请务必在使用前阅读）**
> 1. **非官方项目**：本项目为社区独立开发的插件，与 **字节跳动（ByteDance）**、**剪映（Jianying / CapCut）**、**小云雀（XiaoYunQue）** 或 **Pippit** 无任何隶属、合作或官方背书关系。
> 2. **优先使用官方 Access Key**：在 Linux 无头服务器（如 101box Magpie）上部署时，请务必使用 [https://www.xiaoyunque.com/cli?tab=api](https://www.xiaoyunque.com/cli?tab=api) 创建的官方 Access Key；网页端 Cookie 接口存在 `ret=16012` / `16014` Shark 风控拦截风险。
> 3. **积分消耗提醒**：调用 `xiaoyunque_create_video` 会真实消耗你小云雀账号内的积分（VIP 积分 / 赠送积分 / 充值积分），建议先使用 `xiaoyunque_estimate_credits` 预估，或使用低成本模型 `seedance2.0_fast_vision`（`480p` 仅 **3 积分/秒**）或 `Seedance_2.5_draft`（**9 积分/秒**）测试。
> 4. **凭据安全（极重要）**：请妥善保管你的 Access Key 与 Cookie 文件（权限建议设为 `0600`），**切勿将 Access Key 或 Cookie 提交到 Git 仓库、写入公开日志或写入测试/报告中**。

### ✨ 核心功能

- **Magpie「模型 → 供应商」多账号管理（v0.2.0 新增）**：原生接入 Magpie Web 端 **模型 → 供应商 → `小云雀 (XiaoYunQue)`** 页面（声明 0 个模型，不干扰聊天与 `/v1/videos` 路由），支持可视化添加多个 Access Key 或网页端 Cookie 账号、置顶切换默认账号、查看积分余额，并通过 `account` 参数按需指定账号及自动绑定 `task_id → 槽位`。
- **官方 Access-Key Skill API 原生直连（纯 JS，无 CLI 子进程）**：直接请求 `https://xyq.jianying.com/api/biz/v1/skill/*`（`get_credit_balance`、`get_available_model_list`、`upload_file`、`submit_run`、`get_thread`），完美适配无头 Linux 服务器。
- **全系列 Seedance 2.5 / 2.0 / 1.0 与平台模型支持（共 11 个）**：支持官方 Skill API 当前开放的 8 个模型（`Seedance_2.5`、`Seedance_2.5_draft`、`seedance2.0_vision`、`seedance2.0_fast_vision`、`Seedance_2.0_mini`、`Seedance_2.0_mini_lite`、`wan3.0`、`happyhorse-1.1`），并保留网页端兼容的 3 个旧通道模型（`seedance2.0_direct`、`seedance2.0_fast_direct`、`Seedance_1.0_fast`）。
- **完整参数与多种创作模式**：支持画面比例（`aspect_ratio`）、画质/分辨率（`resolution`：`480p`/`720p`/`1080p`/`4k`）、时长（`duration`）、随机种子（`seed`，自动拦截不支持的模型）、音频提示词控制（`audio`）、输出格式校验（`output_format: "mp4"`），以及文生视频（`t2v`）、首尾帧生视频（`first_last_frame`，`generate_type: 1`）、全能多模态参考生视频（`reference`，支持引用 `[@图片1]`、`[@视频1]`、`[@音频1]`）、视频编辑（`edit`）与视频延长（`extend`）。
- **凭据文件热加载与零中断兼容**：页面未添加任何账号时无缝回退至 `plugins.json` 的 `options`（`accessKeyFile` / `cookieFile`）与环境变量，文件 `mtime` 变化时自动热重载。
- **支持自动下载 MP4 与全链路脱敏**：`get_task` 与 `wait_task` 支持 `output_path` / `download_dir` 自动下载 MP4；所有异常输出自动抹除 Access Key 与 Cookie，永不返回用户 `uid`。

---

### 🎬 支持的视频生成模型参数与价格一览（11 个模型）

| 模型 Key (`model`) | 名称 | 通道支持 | 时长 (`duration`) | 分辨率 (`resolution`) | 支持比例 (`aspect_ratio`) | 首尾帧 / Seed | 参考上限 (`总`/`图`/`视`/`音`) 与特殊约束 | 创作模式 (`mode`) | 每秒积分价格 (`credits/s`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `Seedance_2.5` *(默认)* | Seedance 2.5 | Skill + Web | `4`–`30`s（默认 `10`s） | `480p`, `720p` (默认), `1080p`, `4k` | `adaptive`, `16:9`, `21:9`, `9:16`, `1:1`, `4:3`, `3:4` | 首 ✅ 尾 ✅ / Seed ✅ | `50` / `30` / `10` / `10`（图 ≤30MB） | `t2v`, `first_last_frame`, `reference`, `edit`, `extend` | `480p`: **12/s**<br>`720p`: **20/s**<br>`1080p`: **64/s**<br>`4k`: **99/s** *(含参视按总秒数)* |
| `Seedance_2.5_draft` | Seedance 2.5 Draft (样片) | Skill + Web | `4`–`30`s（默认 `10`s） | 固定 `480p` 样片（不发 `resolution`） | 同上 | 首 ✅ 尾 ✅ / Seed ✅ | `50` / `30` / `10` / `0`（不支持参考音频与 `edit`） | `t2v`, `first_last_frame`, `reference`, `extend` + `draft_task_id` 转正 | **9/s** |
| `seedance2.0_vision` | Seedance 2.0 VIP | Skill + Web | `4`–`15`s（默认 `10`s） | `480p`, `720p` (默认), `1080p`, `4k` | 同上 | 首 ✅ 尾 ✅ / Seed ✅ | `12` / `9` / `3` / `3` | `t2v`, `first_last_frame`, `reference` | `480p`: **8/s**<br>`720p`: **14/s**<br>`1080p`: **33/s**<br>`4k`: **80/s** *(含参视按总秒数)* |
| `seedance2.0_fast_vision` | Seedance 2.0 Fast VIP | Skill + Web | `4`–`15`s（默认 `10`s） | `480p`, `720p` (默认) | 同上 | 首 ✅ 尾 ✅ / Seed ✅ | `12` / `9` / `3` / `3` | `t2v`, `first_last_frame`, `reference` | `480p`: **3/s**<br>`720p`: **6/s** *(含参视按总秒数)* |
| `Seedance_2.0_mini` | Seedance 2.0 Mini | Skill + Web | `4`–`15`s（默认 `10`s） | 固定 `720p`（不发 `resolution`） | 同上 | 首 ✅ 尾 ✅ / Seed ✅ | `12` / `9` / `3` / `3` | `t2v`, `first_last_frame`, `reference` | **6/s** *(含参视按总秒数)* |
| `Seedance_2.0_mini_lite` | Seedance 2.0 Mini 体验版 | Skill + Web | `4`–`15`s（默认 `10`s） | 固定 `720p`（不发 `resolution`） | 同上 | 首 ✅ 尾 ✅ / Seed ✅ | `12` / `9` / `3` / `3` | `t2v`, `first_last_frame`, `reference` | **4/s** |
| `wan3.0` | Wan 3.0 | Skill + Web | `4`–`30`s（默认 `10`s） | `480p`, `720p` (默认), `1080p` | 不支持 `21:9`，其余同上 | 首 ✅ 尾 ✅ / Seed ✅ | `12` / `9` / `3` / `3`（图 ≤20MB 禁 GIF；参视 ≤15s 且参视+输出 ≤30s） | `t2v`, `first_last_frame`, `reference` | `480p`: **7/s**<br>`720p`: **14/s**<br>`1080p`: **33/s** *(含参视按总秒数)* |
| `happyhorse-1.1` | HappyHorse 1.1 | Skill + Web | `3`–`15`s（默认 `5`s） | `720p` (默认), `1080p` | 不支持 `adaptive`，支持其余 6 种 | 首 ❌ 尾 ❌ / Seed ❌ | `12` / `9` / `3` / `3`（支持 `heic/heif`，禁 `bmp/gif`） | `t2v`, `reference` | `720p`: **14/s**<br>`1080p`: **18/s** |
| `seedance2.0_direct` | Seedance 2.0 (旧通道) | 仅 Web 列表 | `4`–`15`s（默认 `4`s） | `480p` (默认), `720p` | 同 `Seedance_2.5` | 首 ✅ 尾 ✅ / Seed ✅ | `12` / `9` / `3` / `0` | `t2v`, `first_last_frame`, `reference` | `480p`: **7/s**<br>`720p`: **8/s** *(含参视按总秒数)* |
| `seedance2.0_fast_direct` | Seedance 2.0 Fast (旧通道) | 仅 Web 列表 | `4`–`15`s（默认 `10`s） | 固定 `720p`（不发 `resolution`） | 同 `Seedance_2.5` | 首 ✅ 尾 ✅ / Seed ✅ | `12` / `9` / `3` / `0` | `t2v`, `first_last_frame`, `reference` | **5/s** *(含参视按总秒数)* |
| `Seedance_1.0_fast` | Seedance 1.0 Fast | 仅 Web 列表 | `2`–`12`s（默认 `5`s） | `720p` (默认), `1080p` | 同 `Seedance_2.5` | 仅首 ✅ 尾 ❌ / Seed ❌ | `1` / `1` / `0` / `0`（不支持 `reference`） | `t2v`, `first_last_frame` (单首帧) | `720p`: **2/s**<br>`1080p`: **4/s** |

> **说明**：调用 `xiaoyunque_list_video_models` 默认仅返回 Seedance 系列（`seedance_only: true`），传入 `{"seedance_only": false}` 可查看全部模型（Access-Key 通道实时返回前 8 个，网页端 Cookie 通道或 `offline: true` 返回全部 11 个）。标有 *“含参视按总秒数”* 的模型在传入参考视频时，线上规则将参考视频时长计入计费总秒数。

### 📝 关键参数说明

1. **音频控制（`audio`）**：小云雀网页端 `biz/x_tool_name_video_part` **没有独立的静音布尔开关**，Seedance 2.0 / 2.5 默认原生生成同步语音、音效与背景音乐。当传入 `audio: false` 时，插件会自动在提示词末尾追加 `"（全片无对白、无旁白、无背景音乐，静音）"`，并在返回结果中标记 `audio_control: "prompt_hint"`。
2. **输出格式（`output_format`）**：小云雀网页端固定输出 **MP4**（`video_mp4`）。若传入非 `"mp4"` 的格式（如 `"mov"`），插件会直接报错拦截。
3. **Seedance 2.5 样片两阶段流程（Draft Two-Stage）**：
   - **第一阶段（生成 480p 样片）**：使用 `model: "Seedance_2.5_draft"`，插件自动设置 `draft: true` 并省略 `resolution`（仅消耗 9 积分/秒）。任务完成后，`get_task` / `wait_task` 返回的 `videos[0]` 中会包含 `render_task_id` / `draft_task_id`。
   - **第二阶段（样片升级正片）**：调用 `create_video` 传入 `draft_task_id: "<render_task_id>"`，插件会发送 `{draft: false, draft_task_id, model: "Seedance_2.5_draft", prompt: ""}` 将样片转正。

---

### 📦 安装

使用 Magpie CLI 从 GitHub 或本地目录安装：

```bash
# 从 GitHub 安装
magpie plugin add github:KasenRi/magpie-plugin-xiaoyunque

# 或者从本地目录安装
magpie plugin add /path/to/magpie-plugin-xiaoyunque
```

---

### 🔑 配置多账号（Magpie「模型 → 供应商」页面，推荐）与 `plugins.json`

#### 1. 在 Magpie Web「模型 → 供应商」页面添加账号（推荐，支持多账号）
1. 在浏览器中打开小云雀官方 CLI / API 密钥管理页创建 Access Key：**[https://www.xiaoyunque.com/cli?tab=api](https://www.xiaoyunque.com/cli?tab=api)**。
2. 打开 Magpie Web 管理界面 → **模型 → 供应商（Models → Providers）** → 找到 **`小云雀 (XiaoYunQue)`** 点击添加账号：
   - **登录方式 1（默认推荐）：小云雀官方 Access Key**：在密码框中粘贴刚创建的 Access Key，可选填写「账号备注名」（例如 `主号`、`二号机`，将显示为页面账号名），保存后卡片可直接显示积分余额。
   - **登录方式 2（兼容回退）：网页端 Cookie / Session JSON**：粘贴浏览器 `Cookie` 请求头或 `xiaoyunque-session.json` 全文，可选填写备注名。
3. **多账号管理、凭据优先级与任务绑定规则**：
   - 可重复点击添加账号导入多个小云雀账号；在供应商卡片中调整账号顺序（**最上方且已启用的账号即为默认账号**），或单独禁用/移除某个账号（禁用整个供应商卡片时回退至 `options`）。
   - **凭据优先级**：显式传入 `args.account` > 任务已绑定槽位 > 供应商页面置顶启用账号 > `plugins.json` 的 `options`（`accessKeyFile` / `cookieFile` 等）> 环境变量 `XYQ_*`。页面未添加任何账号时无缝回退至原有 `options`，升级零中断；**绝不按次轮换账号**。
   - **`account` 选择器**：所有 8 个工具均支持可选参数 `account`（可匹配槽位键如 `"xiaoyunque"` / `"xiaoyunque#<hash>"`、页面备注名、自定义别名、密钥末 4 位，或传 `"options"` 强制使用 `plugins.json` 凭据）；`xiaoyunque_account` 支持 `all_accounts: true` 一次查询全部账号余额。
   - **同账号素材与任务粘性**：`upload_image` 返回的 `asset_id` / `pippit_asset_id` 归属上传时使用的账号，后续 `create_video` 引用该素材时必须使用**同一个账号**。`create_video` 成功后会自动记录 `task_id → 槽位`，后续 `get_task` / `wait_task` / `cancel_task` 未传 `account` 时优先回到该槽位查询；遇任务不存在（`ret=16017`）时再遍历其余已启用账号兜底。

#### 2. （兼容旧方式）在 Magpie `plugins.json` 中配置单账号或全局选项

```json
{
  "plugins": [
    {
      "spec": "opencode-xiaoyunque",
      "options": {
        "accessKeyFile": "/home/youruser/.config/magpie/xiaoyunque-access-key",
        "cookieFile": "/home/youruser/.config/magpie/xiaoyunque-session.json",
        "teamId": "",
        "defaultModel": "Seedance_2.5"
      }
    }
  ]
}
```
*(注：`defaultModel`、`baseUrl`、`skillBaseUrl`、`teamId` 等非凭据配置对页面多账号同样全局生效；当供应商页面没有任何启用账号时，自动回退读取 `options` 中的 `accessKeyFile` / `cookieFile` 或 `pippit-cli` 的 `browser-credential.json`。)*

#### 3. `options` 配置项与环境变量一览（回退优先级：页面启用账号 > `options` > 环境变量；Access Key > Cookie）

| `options` 字段 | 环境变量名 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `accessKey` | `XYQ_ACCESS_KEY` | — | **（推荐）** 小云雀官方 Access Key（在 `https://www.xiaoyunque.com/cli?tab=api` 创建） |
| `accessKeyFile` | `XYQ_ACCESS_KEY_FILE` | — | **（推荐）** Access Key 文件路径（支持纯文本密钥文件或 `pippit-cli` 的 `browser-credential.json` `{"access_key":"..."}`，`mtime` 变化时自动热重载） |
| `skillBaseUrl` | `XYQ_SKILL_BASE_URL` | `https://xyq.jianying.com` | 官方 Access-Key Skill API 基础 URL |
| `cookie` | `XYQ_COOKIE` | — | （回退模式）原始浏览器 `Cookie` 请求头字符串（`sessionid=...; sid_tt=...`） |
| `cookieFile` | `XYQ_COOKIE_FILE` | — | （回退模式）Cookie 文件路径（支持扩展 JSON `{cookies:[...]}`、JSON 数组 `[{name,value}]`、Netscape `cookies.txt`、纯文本 Cookie 头） |
| `baseUrl` | `XYQ_BASE_URL` | `https://www.xiaoyunque.com` | 网页端 Cookie 模式基础 URL（若未显式设置 `skillBaseUrl` 且显式传入 `baseUrl`，也会作为测试覆盖地址） |
| `workspaceId` | `XYQ_WORKSPACE_ID` | 自动获取并内存缓存 | 网页端 Cookie 模式的工作空间 ID（Access-Key 模式无需此项） |
| `teamId` | `XYQ_TEAM_ID` | 个人空间（不发该头） | 团队空间 ID（设置且非 `"0"` 时自动注入请求头 `X-Team-Id: <teamId>`） |
| `defaultModel` | `XYQ_DEFAULT_MODEL` | `Seedance_2.5` | `create_video` 与 `estimate_credits` 的默认模型 Key |

#### 4.（可选回退）如何从浏览器获取网页端 Cookie
若仅使用网页端 Cookie 回退模式，可在登录 [https://www.xiaoyunque.com](https://www.xiaoyunque.com) 后通过浏览器扩展导出 Cookie JSON / `cookies.txt` 并粘贴到供应商页面「网页端 Cookie / Session JSON」或配置 `cookieFile`。注意网页端 `submit_run` 在非浏览器环境极易触发字节跳动 Shark 风控（`ret=16014`），生产环境强烈建议使用 Access Key。

---

### 🔌 在 Claude Code / Codex 中接入使用（MCP 与 `/xiaoyunque` Skill）

Magpie 启动后既提供按插件隔离的独立 MCP 端点 `http://127.0.0.1:3425/mcp/magpie/tools/xiaoyunque`，也提供聚合端点 `http://127.0.0.1:3425/mcp/magpie/tools`：

```bash
# 推荐：注册为名为 xiaoyunque 的独立 MCP 服务（配合 skills/xiaoyunque 使用）
claude mcp add --transport http xiaoyunque http://127.0.0.1:3425/mcp/magpie/tools/xiaoyunque

# 或挂载聚合工具端点
claude mcp add --transport http magpie-tools http://127.0.0.1:3425/mcp/magpie/tools
```

仓库内附带 [`skills/xiaoyunque/`](./skills/xiaoyunque/) 技能包（含 `SKILL.md`、模型计价与质检参考文档，以及支持预算门禁与 CSV 记账的无 MCP CLI 脚本 `scripts/xiaoyunque.py`），可复制到 `.claude/skills/xiaoyunque/` 直接使用 `/xiaoyunque`。

---

### 🛠️ 工具参考（MCP Tools）

> 所有工具均支持可选参数 `account`（指定账号槽位、备注名、别名、密钥末 4 位或 `"options"`），并在返回值中附带实际使用的账号标签 `account`。

| MCP 工具名 | 插件内部名 | 功能说明与主要参数 |
| :--- | :--- | :--- |
| `xiaoyunque_account` | `account` | 查询账号积分余额（支持 `account` 选择单账号，或 `all_accounts: true` 列出全部账号及余额；带 `selected_account: {slot, label}`）。永不返回敏感 `uid`。 |
| `xiaoyunque_list_video_models` | `list_video_models` | 获取可用视频模型列表。参数：`seedance_only` (`boolean`，默认 `true`)、`offline` (`boolean`，默认 `false`)、`with_prices` (`boolean`，默认 `false`)、`account`。 |
| `xiaoyunque_upload_image` | `upload_image` | 上传参考图或首尾帧图片（`wan3.0` 最大 20 MB 禁 GIF，`happyhorse-1.1` 支持 `heic/heif` 禁 `bmp/gif`，其余最大 30 MB）。参数：`url` \| `path` \| `base64`、`filename`、`account`。**注意：返回的 `asset_id` 归属上传账号，`create_video` 须用同一账号。** |
| `xiaoyunque_estimate_credits` | `estimate_credits` | 预估视频生成所需积分并对比当前账号余额。支持 `account` 参数。返回 `per_second`、`estimated_credits`、`pricing_policy`、`enough_balance` 及 `balance`。 |
| `xiaoyunque_create_video` | `create_video` | 提交视频生成任务并自动记录 `task_id → 账号槽位`。参数：`prompt`、`model`、`duration`、`aspect_ratio`、`resolution`、`audio`、`output_format` (`"mp4"`)、`mode` (`auto\|t2v\|first_last_frame\|reference\|edit\|extend`)、`first_frame`、`last_frame`、`reference_images`、`reference_videos`、`reference_audios`、`seed`、`draft_task_id`、`wait_seconds` (`0`–`40`)、`account`。 |
| `xiaoyunque_get_task` | `get_task` | 查询单次运行状态（未传 `account` 时优先回到创建槽位，遇 `16017` 遍历其余启用账号兜底）。参数：`task_id` 或 `thread_id` + `run_id`、`output_path` / `download_dir`、`account`。 |
| `xiaoyunque_wait_task` | `wait_task` | 轮询 `get_task` 直至完成/失败/取消或达到单次上限（`timeout_seconds` 默认 40s，最大 45s；`interval_seconds` 默认 5s），可选 `output_path` / `download_dir`、`account`。若返回 `timed_out: true`，请循环再次调用。 |
| `xiaoyunque_cancel_task` | `cancel_task` | 取消排队或运行中的视频任务（`POST /api/biz/v1/agent/cancel_run`）。参数：`task_id` 或 `thread_id` + `run_id`、`account`。 |

---

### 🔄 Agent 调用流程示例（预估 -> 创建 -> 轮询并下载 MP4）

1. **预估积分（`xiaoyunque_estimate_credits`）**：
   ```json
   {
     "model": "seedance2.0_fast_vision",
     "resolution": "480p",
     "duration": 4
   }
   ```
   返回：`{"per_second": 3, "total": 12, "check_deduct_status": 1, "enough_balance": true, ...}`
2. **提交视频生成任务（`xiaoyunque_create_video`）**：
   ```json
   {
     "prompt": "a cat walking on a beach at sunset",
     "model": "seedance2.0_fast_vision",
     "resolution": "480p",
     "duration": 4,
     "aspect_ratio": "16:9"
   }
   ```
   返回：
   ```json
   {
     "task_id": "skill_b4dbee9c-01f3-4c48-8263-bcec6d1333b7:skill_452aa22b-a35a-4190-b099-890d9d778cd1",
     "thread_id": "skill_b4dbee9c-01f3-4c48-8263-bcec6d1333b7",
     "run_id": "skill_452aa22b-a35a-4190-b099-890d9d778cd1",
     "model": "seedance2.0_fast_vision",
     "estimated_credits": 12
   }
   ```
3. **轮询等待出片并下载 MP4（`xiaoyunque_wait_task`）**：
   ```json
   {
     "task_id": "skill_b4dbee9c-01f3-4c48-8263-bcec6d1333b7:skill_452aa22b-a35a-4190-b099-890d9d778cd1",
     "timeout_seconds": 40,
     "output_path": "/tmp/output.mp4"
   }
   ```
   完成后返回：
   ```json
   {
     "task_id": "skill_b4dbee9c-01f3-4c48-8263-bcec6d1333b7:skill_452aa22b-a35a-4190-b099-890d9d778cd1",
     "status": "completed",
     "timed_out": false,
     "credit_consumption": { "actual_deduct_credits": 12, "returned_credits": 0 },
     "videos": [
       {
         "video_url": "https://v26-xyq-video.jianying.com/...&mime_type=video_mp4&download=true",
         "width": 864,
         "height": 496,
         "duration_ms": 4096,
         "local_path": "/tmp/output.mp4",
         "output_path": "/tmp/output.mp4"
       }
     ]
   }
   ```

---

### 🔐 鉴权、签名与风控说明（Auth & Signing Notes）

- **官方 Access-Key Skill API（`/api/biz/v1/skill/*`，默认）**：请求 `https://xyq.jianying.com/api/biz/v1/skill/*`，携带 `Authorization: Bearer <AccessKey>` 与 `User-Agent: Pippit-CLI/1.0`（可选 `X-Team-Id`），不发送 Cookie、不附加 `a_bogus`，无网页端 Shark 滑块风控拦截。
- **网页端 Cookie 接口（`/api/web/v1/*` 与 `/api/biz/v1/agent/*`，回退模式）**：携带浏览器 `Cookie`、标准请求头与纯 JS `bdms` `a_bogus` URL 签名；注意网页端 `submit_run` 在无头服务器上容易触发字节跳动 Shark 风控拦截（`ret=16012` / `16014`）。
- **`/commerce/v1/*`（剪映商业化网关，仅 Cookie 模式使用）**：携带 `Appid: "795647"`、`pf: "7"`、`appvr: "5.8.0"`、`sign-ver: "1"`、`tdid: ""`、`device-time: "<unix_sec>"` 以及 `sign: md5("9e2c|" + pathname.slice(-7) + "|7|5.8.0|" + device_time + "||11ac")`。

---

### 🙏 致谢与参考项目（Credits & Acknowledgements）

本项目的协议分析与逆向工程参考了以下开源项目（均未直接复制代码，仅作协议与鉴权对比参考）：
- **[`Pippit-dev/cli`](https://github.com/Pippit-dev/cli)**（MIT License，小云雀 / Pippit 官方 Go CLI）：参考了 `biz/x_tool_name_video_part` 工具参数结构、模型 ID 枚举、画幅比例枚举（含扩展比例码 `7/8/9/11/12`）以及 `run.state` 状态码定义。
- **[`XiakeMan777/seedance2.0_XYQ_APi`](https://github.com/XiakeMan777/seedance2.0_XYQ_APi)**：参考了网页端 `submit_run` / `get_thread` / `upload_file` 的调用流程及 `.mp4` 链接兜底提取思路。
- **[`zhizinan1997/jimeng-free-api-all`](https://github.com/zhizinan1997/jimeng-free-api-all)** 与 **[`wwwzhouhui/jimeng-mcp-server`](https://github.com/wwwzhouhui/jimeng-mcp-server)**（MIT License）：用于对比字节跳动剪映系（即梦 vs 小云雀）的商业化网关 `9e2c|...|11ac` MD5 签名与 `bdms.js` 行为差异。

### ⚠️ 已知限制（Limitations）
- **单次工具调用超时上限**：Magpie 对每次工具调用设有 55 秒硬超时，因此 `xiaoyunque_wait_task` 单次最多等待 45 秒。视频生成通常耗时 1–3 分钟，Agent 需多次调用 `xiaoyunque_wait_task` 直至完成。
- **内容安全审核**：小云雀后端会对提示词及参考图片/视频进行安全与版权审核（如 `14005 ImageLabCVRiskHit`、`14025 BaseModelReviewFailed` 或 `99999 内容涉及侵犯他人权益`），审核不通过会在 `get_task` 的 `fail_reason` 中返回具体原因。
- **Cookie 过期**：网页端退出登录或长时间未活跃会导致 Cookie 失效（`ret: 1015` / `34010105`），需重新从浏览器导出 Cookie。

---

## 🌐 English Documentation

`opencode-xiaoyunque` is a **Magpie / OpenCode tools & provider-auth plugin** that wraps **XiaoYunQue (`https://xyq.jianying.com` / `https://www.xiaoyunque.com`, ByteDance / Jianying's domestic "Pippit" AI video generation platform)** into MCP tools exposed at Magpie's `/mcp/magpie/tools/xiaoyunque` and `/mcp/magpie/tools` endpoints (`xiaoyunque_*`), with native **Models → Providers (`小云雀 (XiaoYunQue)`)** multi-account management.

It uses the **official Access-Key Skill API (`https://xyq.jianying.com/api/biz/v1/skill/*`) by default** whenever an Access Key is provided, and keeps the web Cookie backend as a fallback.

### ✨ Features

- **Magpie "Models → Providers" Multi-Account Support (v0.2.0)**: Exports `config` + `auth` hooks under provider ID `xiaoyunque` (`小云雀 (XiaoYunQue)`) with **0 models declared** (never routed for chat or `/v1/videos`). Add multiple Access-Key or Cookie accounts in the Web UI, reorder to switch the default account, view prepaid credit balance on Access-Key slots, pass `account` on any tool, and query all balances via `xiaoyunque_account({ "all_accounts": true })`.
- **Official Access-Key Skill API Backend (Default, Headless-Friendly)**: Pure JS client calling `https://xyq.jianying.com/api/biz/v1/skill/*` with `Authorization: Bearer <AccessKey>` and `User-Agent: Pippit-CLI/1.0`—no CLI subprocess, no cookies, no `a_bogus`, and no Shark risk-control blocks (`ret=16014`).
- **11 Audited Video Models**: Supports the 8 models currently exposed on the official Skill API (`Seedance_2.5`, `Seedance_2.5_draft`, `seedance2.0_vision`, `seedance2.0_fast_vision`, `Seedance_2.0_mini`, `Seedance_2.0_mini_lite`, `wan3.0`, `happyhorse-1.1`) plus 3 legacy Web-listed models (`seedance2.0_direct`, `seedance2.0_fast_direct`, `Seedance_1.0_fast`), enforcing model-specific media size/format/duration/seed/mode rules (see the 11-model table above).
- **Zero-Downtime Fallback & Sticky Task Binding**: Credential priority is `args.account` > sticky `task_id → slot` binding > top enabled Providers-page account > `plugins.json` `options` (`accessKeyFile` / `cookieFile`) > `XYQ_*` env vars (never round-robins). Note: assets uploaded via `upload_image` belong to the uploading account—use the **same `account`** when calling `create_video`.
- **Direct MP4 Download & Secret Redaction**: Pass `output_path` or `download_dir` to `get_task` or `wait_task` (single call ≤45s; loop on `timed_out: true`), with automatic redaction of Access Keys and cookies.

### 📦 Installation & Configuration

```bash
# Install via Magpie CLI
magpie plugin add github:KasenRi/magpie-plugin-xiaoyunque
# or from a local folder
magpie plugin add /path/to/magpie-plugin-xiaoyunque
```

1. **Recommended — Magpie Web UI ("Models → Providers")**:
   - Create an Access Key at **[https://www.xiaoyunque.com/cli?tab=api](https://www.xiaoyunque.com/cli?tab=api)**.
   - Open Magpie Web UI → **Models → Providers** → **`小云雀 (XiaoYunQue)`**, paste your Access Key (or web Cookie / `xiaoyunque-session.json` via Method 2), and optionally enter an account label (e.g. `main`, `sub`). Add as many accounts as needed; the top enabled slot is the default.
2. **Fallback / Global Options — `plugins.json`**:

```json
{
  "plugins": [
    {
      "spec": "opencode-xiaoyunque",
      "options": {
        "accessKeyFile": "/home/youruser/.config/magpie/xiaoyunque-access-key",
        "cookieFile": "/home/youruser/.config/magpie/xiaoyunque-session.json",
        "defaultModel": "Seedance_2.5"
      }
    }
  ]
}
```

Or via environment variables: `XYQ_ACCESS_KEY`, `XYQ_ACCESS_KEY_FILE`, `XYQ_SKILL_BASE_URL`, `XYQ_COOKIE`, `XYQ_COOKIE_FILE`, `XYQ_BASE_URL`, `XYQ_WORKSPACE_ID`, `XYQ_TEAM_ID`, `XYQ_DEFAULT_MODEL`.

### 🔌 Connecting Claude Code / Codex & `/xiaoyunque` Skill

```bash
# Per-plugin MCP endpoint (used by skills/xiaoyunque)
claude mcp add --transport http xiaoyunque http://127.0.0.1:3425/mcp/magpie/tools/xiaoyunque
# Or aggregated tools endpoint
claude mcp add --transport http magpie-tools http://127.0.0.1:3425/mcp/magpie/tools
```

Copy [`skills/xiaoyunque/`](./skills/xiaoyunque/) into `.claude/skills/xiaoyunque/` to enable the `/xiaoyunque` workflow skill and standalone CLI (`scripts/xiaoyunque.py`).

### 🙏 Credits & Acknowledgements

- **[`Pippit-dev/cli`](https://github.com/Pippit-dev/cli)** (MIT License): Official Pippit CLI used as protocol reference for the `biz/x_tool_name_video_part` payload and model/ratio enums.
- **[`XiakeMan777/seedance2.0_XYQ_APi`](https://github.com/XiakeMan777/seedance2.0_XYQ_APi)**: Referenced for the `submit_run` / `get_thread` flow and fallback MP4 URL regex.
- **[`zhizinan1997/jimeng-free-api-all`](https://github.com/zhizinan1997/jimeng-free-api-all)** and **[`wwwzhouhui/jimeng-mcp-server`](https://github.com/wwwzhouhui/jimeng-mcp-server)** (MIT License): Studied for ByteDance Jianying commerce gateway signing and auth comparison (no code copied).

### 🧪 Running Tests

```bash
node --check index.mjs
node --test tests/
```

For complete reverse-engineering details and bundle evidence, see [`docs/API.md`](./docs/API.md).
