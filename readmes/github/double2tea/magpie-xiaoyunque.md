# 小云雀 · Magpie 供应商插件

将你的小云雀账号图片与视频模型直接接入 Magpie：在 Magpie 中原生选模型、查积分、生成与编辑图片/视频，并通过内置工具完成参考素材上传、任务恢复、本地下载与 Draft 样片升级。

> 社区开发的第三方插件，非小云雀官方产品，不代表官方背书。图标为自行绘制的 `XYQ` 字母标记。

## 核心特性

- **原生媒体接入**：按当前账号实时拉取可用图片／视频模型、参数枚举与创作模式，直接出现在 Magpie 原生媒体入口。
- **两种官方登录方式**：支持浏览器一键授权登录与 Access Key 登录，凭据由 Magpie 托管；走官方 Skill API，无 Cookie 后端。
- **零外部依赖**：无需安装小云雀 CLI、无需手动填写 Base URL 或启动额外服务。
- **四个进阶工具**：提供 `models`、`generate`、`video_process`、`result`，补足参考音视频、首尾帧、视频编辑／延长、视频超分、擦字幕、任务恢复、本地保存和 Draft 样片升级。
- **默认无水印 & 计费保护**：首次提交时自动关闭账号 AIGC 水印（受服务端策略约束）；提交前完成全部校验与素材直传；已提交任务在查询或下载异常时绝不自动重提，下载不覆盖已有文件。

## 安装与登录

在 Magpie 插件市场搜索安装，或在终端执行：

```sh
magpie plugin add github:double2tea/magpie-xiaoyunque
```

安装后打开 Magpie **供应商页 → 小云雀**：

1. **网页登录（推荐）**：点击「登录小云雀」，在浏览器确认授权后自动返回。
2. **Access Key**：在小云雀网页「CLI/API → API」页面创建密钥，粘贴到「Access Key」登录框（切勿把密钥发到聊天、日志或截图）。[1]

登录成功后即可自动读取模型列表和积分余额。日常生图／生视频可直接使用 Magpie 原生入口；需要参考素材、首尾帧、视频编辑或 Draft 升级时，在 Magpie Library 中将插件工具分配给 Agent。

## 四个插件工具

| 工具 | 用途 |
| --- | --- |
| `models` | 查看当前账号可用模型、参数范围、创作模式及个人／团队空间 |
| `generate` | 提交图片或视频生成，立即返回任务 `id` 与官方页面链接 |
| `video_process` | 提交视频超分（`super_resolution`）或视频擦字幕（`erase_subtitle`），返回任务 `id` |
| `result` | 查询进度、限时等待并下载到本地；不传 `id` 时列出本机最近 20 条任务 |

典型调用顺序：`models` 查模型 → `generate` / `video_process` 提交任务 → `result` 查询与下载。

## 常见用法示例

### 生成与编辑图片

```json
// 1. 查询图片模型（工具：models）
{ "kind": "image" }

// 2. 文生图（工具：generate）
{
  "kind": "image",
  "model": "从 models 返回的完整图片名称",
  "prompt": "窗边的一只小云雀，柔和晨光，水彩质感",
  "size": "1:1"
}

// 3. 参考图编辑（单张用 image，多张用 reference_images）
{
  "kind": "image",
  "model": "从 models 返回的完整图片名称",
  "prompt": "保留参考图里的水彩小鸟，把背景换成淡蓝色",
  "image": "/完整绝对路径/参考图.png",
  "size": "1:1"
}
```

### 生成视频（文生／首帧）

```json
// 文生视频
{
  "kind": "video",
  "model": "从 models 返回的视频 ID",
  "prompt": "小云雀站在树枝上轻轻转头，镜头缓慢推进",
  "seconds": 4,
  "ratio": "16:9"
}

// 首帧生视频（加 last_frame 可指定尾帧）
{
  "kind": "video",
  "model": "从 models 返回的视频 ID",
  "prompt": "小云雀轻轻转头，背景树叶随风摇动",
  "image": "/完整绝对路径/首帧.png",
  "seconds": 4
}
```

### 视频创作模式与参考素材

参考图片、视频、音频支持 **HTTPS 地址**、**Base64 data URL** 或 **本机绝对路径**：

| 模式 | 参数写法 |
| --- | --- |
| 文生视频 | 仅填 `prompt`，不附参考素材 |
| 参考生成 | 传 `reference_images` / `reference_videos` / `reference_audios`；需显式指定时加 `task_type: "reference"` |
| 首尾帧 | 用 `image` 或 `input_reference` 指定首帧，可选加 `last_frame`（不可与 `reference`/`edit`/`extend` 混用） |
| 视频编辑 | `task_type: "edit"` + 1 条 `reference_videos` |
| 视频延长 | `task_type: "extend"` + 1 条 `reference_videos` |

> 部分模式会自动沿用素材比例或时长，此时省略 `ratio` / `seconds` 即可。Seedance 2.0 Mini 体验版普通生成必须填写 `ratio` 或 `size`。

### 参数速查

| 参数 | 说明 |
| --- | --- |
| `size` | 通用尺寸或比例（如 `1024x1024`、`16:9`，图片还支持 `16:9@2K`、`adaptive@2K` 组合扩展）；像素尺寸不保证原样输出 |
| `ratio` / `resolution` | 单独指定比例或分辨率；与 `size` 同传时显式字段优先，并在 `adaptation` 中说明 |
| `quality` / `effort` | 图片推理强度，二选一（`quality: "auto"` 为默认），与 `resolution` 独立控制 |
| `seconds` / `duration` | 视频时长（秒）；同时填写时 `duration` 优先。自动时长请直接省略，勿传 `-1` |
| `image` / `input_reference` | 视频首帧，二选一；图片生成中 `image` 作为单张参考图 |
| `seed` | 随机种子，仅在模型目录明确支持时使用 |

> 说明：模型能力严格区分“支持 / 不支持 / 未知”，未知限额不会伪造为 0；图片美学模型 V8.2 实测 `n: 1` 仍可能返回 4 张图，插件会完整保留所有产物。

### 视频超分与擦字幕（`video_process`）

```json
// 视频超分（output_resolution: 720p | 1080p | 2k | 4k；tool_version 可选）
{
  "action": "super_resolution",
  "video": "/完整绝对路径/待超分.mp4",
  "output_resolution": "2k",
  "tool_version": "professional_v2"
}

// 视频擦字幕
{
  "action": "erase_subtitle",
  "video": "/完整绝对路径/带字幕.mp4"
}
```

> 返回的任务 `id` 直接交给 `result` 查询进度并下载成品。

## Draft 样片与升级

1. **生成样片**：选择模型 `Seedance_2.5_draft` 提交即可（自动生成 480p 样片，无需额外传 `draft: true`）。
2. **预览并升级**：先用 `result` 查看样片；确认升级后再调用 `generate` 传入原任务 ID：

```json
{ "source_task_id": "原样片 generate 返回的任务 ID" }
```

- 插件会自动复用原账号、原团队、原模型并提取真实 `draftTaskId`；原任务含多个视频时用 `video_index`（从 0 开始）指定。
- 也可直接传 `draft_task_id`（需自行提供 `kind`、Draft 模型和原账号／空间）；两种 ID 不可互换。
- 升级成片为 1080p，沿用原样片设置（附带提示词、参数或素材会被忽略且不上传），样片与升级分别计费，插件不会自动升级。有效升级期（通常 7 天）以服务端为准。[1]

## 查询结果、恢复与本地下载

```json
// 查询、最多等待 40 秒并保存到本地目录（工具：result）
{
  "id": "generate 返回的任务 ID",
  "wait_seconds": 40,
  "download_dir": "/完整绝对路径/输出目录"
}
```

- **时间上限**：`wait_seconds` 为 `0–40` 秒，单次查询加下载总上限 48 秒；超时会返回 `timed_out: true`，继续用同一 `id` 查询即可。
- **安全保存**：`download_dir` 须为绝对目录，不覆盖已有文件；下载中断会清理半成品并保留已保存文件及原任务信息。
- **状态说明**：`running` 继续查；`failed` / `canceled` 按原因处理；`unknown` 请先到官方页面核对，勿重提。
- **找回任务**：传 `{}` 调用 `result` 可列出本机当前账号最近 20 个任务。注意插件工具与 Magpie 原生媒体工具各自返回的 ID 不能混用。

## 账号、团队与计费安全

- **多账号与空间**：默认跟随 Magpie 供应商页置顶的启用账号，也可通过 `account`（账号 ID 或备注）和 `team_id`（个人为 `"0"`，团队 ID 见 `models`）指定。
- **任务归属**：查询任务和 `source_task_id` 升级自动切回原账号和原团队。Access Key 方式没有网页用户 UID，任务按密钥绑定，更换密钥后需用原密钥恢复旧任务。
- **计费边界**：拿到任务 ID 仅代表已提交，不代表必成功；插件不根据余额差值伪造单任务账单，仅透传服务端实际返回的积分消耗字段。

## 限制与共存说明

- **与另一个小云雀插件共存**：本插件与 `KasenRi/magpie-plugin-xiaoyunque` 共用供应商 ID `xiaoyunque`，**请只启用其中一个**。两者访问同一小云雀服务、同账号／空间下积分共享；本插件侧重 Magpie 原生模型目录与媒体路由（支持网页登录 + Access Key，无 Cookie 后端），同时保留四个工具。
- **功能边界**：不提供服务端未开放的局部 `mask`、透明背景、输出格式转换或取消接口；Magpie 内置标准媒体工具无法表达全部扩展字段，复杂需求优先用插件 `generate`。
- **运行环境**：Magpie 使用内置宿主，无需额外安装 Node.js；开发测试需 Node.js ≥ 22。同时提供 OpenCode 1.x / 2.x 入口（OpenCode 2.x 通用适配器不转接工具和积分，完整体验以 Magpie 为准）。
- **验证边界**：团队空间计费、其他操作系统及音频听审暂未完整实测。

## 验证与开发

```sh
npm test
npm run check
```

Node 与 Bun 离线测试 97/97 通过；主要实测链路已覆盖两种登录、模型与积分读取、图片生成与参考图编辑、`effort` 与美学模型、普通视频、混合参考素材、首尾帧、Draft 样片转 1080p 成片以及原生 HTTP 媒体闭环。版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 参考

1. [小云雀 API 体验指南](https://bytedance.larkoffice.com/docx/CQOYdJNLioLz6fxRzKXcCsKLnJh) & [官方 CLI](https://github.com/Pippit-dev/cli)
2. [Magpie 插件文档](https://usemagpie.ai/docs/plugins) & [Magpie 社区插件](https://github.com/magpie-community/plugins)
3. [KasenRi 小云雀插件](https://github.com/KasenRi/magpie-plugin-xiaoyunque) / [Magpie Image Models](https://github.com/double2tea/magpie-image-models)
4. [火山方舟视频生成 API](https://www.volcengine.com/docs/82379/1520757)
