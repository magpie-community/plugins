# 小云雀 · Magpie 供应商

这个插件把当前小云雀账号里的图片和视频模型接进 Magpie。登录后，你可以在 Magpie 里直接选模型、查看积分、生成图片或视频，并把结果取回本地。

凭据由 Magpie 保存，不需要安装小云雀 CLI，也不用自己填 Base URL 或启动额外服务。

这是社区开发的插件，不是小云雀官方产品，也不代表官方背书。图标为本插件自行绘制的 XYQ 字母标记。

## 安装和登录

在终端执行：

```sh
magpie plugin add @magpie-community/opencode-xiaoyunque-auth
```

也可以下载源码，在插件目录执行 `magpie plugin add .`。

然后打开 Magpie 的供应商页，选择“小云雀”，点“登录小云雀”并在浏览器里确认授权。

也可以使用 Access Key：在小云雀网页的「CLI/API → API」页面创建密钥，再粘贴到 Magpie 的“Access Key”登录框。密钥只填在供应商页，不要发到聊天、日志或截图里。[1]

登录成功后，模型和积分会自动读取。日常生成直接在 Magpie 的图片或视频入口选择小云雀模型即可。

需要参考素材、首尾帧、视频编辑或 Draft 升级时，再把下面的插件工具分配给 Agent。

## 三个工具

在 Magpie Library 里，把需要的工具分配给负责生成媒体的 Agent：

| 工具 | 用途 |
| --- | --- |
| `models` | 查看当前账号可用的模型、参数、创作模式和团队 |
| `generate` | 提交图片或视频生成，返回任务 ID 和官方页面 |
| `result` | 查询进度、等待完成、下载产物；不传 ID 时列出本机最近任务 |

最常见的流程是：

1. 用 `models` 看当前账号有哪些模型。
2. 用 `generate` 提交任务。
3. 用 `result` 查询结果并下载。

下面的示例都是工具参数，不需要自己拼 HTTP 请求。示例里的模型名和文件路径要换成实际值。

## 生成图片

先用 `models` 查图片目录：

```json
{"kind":"image"}
```

然后提交生成：

```json
{
  "kind": "image",
  "model": "从 models 返回的完整图片名称",
  "prompt": "窗边的一只小云雀，柔和晨光，水彩质感",
  "size": "1:1"
}
```

`size` 可以写 `1024x1024` 这样的像素尺寸，也可以写 `1:1`、`16:9` 这样的比例。不写就使用服务端默认值。

需要参考图时，加 `reference_images` 数组；只有一张图时也可以直接用 `image`：

```json
{
  "kind": "image",
  "model": "从 models 返回的完整图片名称",
  "prompt": "保留参考图里的水彩小鸟，把背景换成淡蓝色",
  "image": "/完整绝对路径/参考图.png",
  "size": "1:1"
}
```

图片的 `quality`、`effort` 和 `resolution` 都是可选项，具体支持哪些值以 `models` 返回的模型目录为准。

## 生成视频

文生视频：

```json
{
  "kind": "video",
  "model": "从 models 返回的视频 ID",
  "prompt": "小云雀站在树枝上轻轻转头，镜头缓慢推进",
  "seconds": 4,
  "ratio": "16:9"
}
```

从首帧生成视频：

```json
{
  "kind": "video",
  "model": "从 models 返回的视频 ID",
  "prompt": "小云雀轻轻转头，背景树叶随风摇动",
  "image": "/完整绝对路径/首帧.png",
  "seconds": 4
}
```

`seconds` 和 `ratio` 要落在模型支持的范围内。不确定时先看 `models`；例如 Seedance 2.0 Mini 体验版做普通生成时，需要明确填写比例。

`generate` 会立即返回任务 `id`、提交状态和官方页面。拿到 ID 后交给 `result` 查询，不要重复提交。

## 参考素材和视频模式

参考图片、视频和音频可以传 HTTPS 地址、Base64 data URL，或本机的完整绝对路径。

视频模型常见的使用方式如下：

| 想做什么 | 怎么填 |
| --- | --- |
| 文生视频 | 只写提示词，不加参考素材 |
| 参考生成 | 用 `reference_images`、`reference_videos` 或 `reference_audios`；需要明确指定时加 `task_type: "reference"` |
| 首尾帧 | 用 `image` 或 `input_reference` 指定首帧，需要尾帧时再加 `last_frame` |
| 视频编辑 | `task_type: "edit"`，并附一条 `reference_videos` |
| 视频延长 | `task_type: "extend"`，并附一条 `reference_videos` |

首尾帧不要和参考、编辑、延长模式混用。有些模式会沿用素材的比例或时长，这时省略对应参数即可，不要为了“填满”而传一个不适用的值。

## 参数怎么填

大多数情况下，只需要提示词、尺寸或时长。需要更精确的控制时，再看下面这些高级字段：

| 想控制 | 常用写法 | 说明 |
| --- | --- | --- |
| 尺寸或比例 | `size` | 可以写 `1024x1024`，也可以写 `16:9` |
| 单独指定比例 | `ratio` | 和 `size` 同时出现时，显式的比例优先 |
| 单独指定分辨率 | `resolution` | 图片里和 `effort` 独立控制 |
| 图片推理强度 | `quality` 或 `effort` | 二选一；`quality: "auto"` 表示不指定强度 |
| 视频时长 | `seconds` | `duration` 是可选别名，同时填写时以 `duration` 为准 |
| 视频首帧 | `image` 或 `input_reference` | 二选一；需要尾帧时再加 `last_frame` |
| 随机种子 | `seed` | 只在模型明确支持时使用 |

自动时长请直接省略，不要传 `-1`。

`size` 是 Magpie 的通用写法，插件会把它换算成小云雀需要的比例或分辨率。像素尺寸不保证原样输出。`16:9@2K` 这种组合写法也能识别，但它是插件扩展，不是 Magpie 的通用语法。

显式字段覆盖了通用参数时，结果里的 `adaptation` 会说明做了什么转换。

图片美学模型 V8.2 实测时，`n: 1` 仍然返回了四张图。图片数量最终由小云雀决定，插件会把返回的图片都保留下来。

模型能力分为“支持”“不支持”和“未知”。未知不等于不支持，插件不会把未知限额写成 0，也不会替你猜一个值。需要完整参数时，优先使用插件 `generate`；Magpie 的原生图片 HTTP 入口不保证转发所有扩展字段。

## 账号和团队

只有一个账号时，不用填写 `account`。有多个账号时，默认使用 Magpie 里置顶的启用账号，也可以用账号 ID 或备注明确选择。

个人空间使用 `team_id: "0"`。要使用团队积分时，填写 `models` 返回的团队 ID；不填则沿用账号的默认空间。

查询任务和通过 `source_task_id` 升级时，插件会自动使用原账号和原团队。原账号不可用时，先到供应商页恢复登录。

Access Key 没有网页登录的用户标识，任务会按密钥绑定。换密钥或切换登录方式后，旧任务不一定还能查到；要恢复旧任务，请使用创建任务时的原密钥。

## Draft 样片和升级

选择 `Seedance_2.5_draft` 就会生成样片，不需要再传 `draft: true`：

```json
{
  "kind": "video",
  "model": "Seedance_2.5_draft",
  "prompt": "小云雀站在树枝上轻轻转头，背景树叶随风摇动",
  "seconds": 4,
  "ratio": "16:9"
}
```

先用 `result` 查询并预览样片。确认要升级后，把原任务 ID 传给 `generate`：

```json
{"source_task_id":"原样片生成返回的任务ID"}
```

插件会从原任务里取出真正的 `draftTaskId`，并沿用原账号、团队和模型。原任务有多个视频时，用从 0 开始的 `video_index` 指定其中一个。

如果原任务没成功、不是 Draft，或者拿不到原始 Draft ID，插件不会提交升级。

也可以直接传 `draft_task_id`，但这时要自己提供 `kind`、同一个 Draft 模型和原账号／空间。通常用 `source_task_id` 更省事；这两种 ID 不能互换。

升级时附带的提示词、时长、比例、分辨率、seed 和素材会被忽略，成片沿用样片设置。样片和升级分别计费，插件不会自动升级。

样片是 480p，成片是 1080p；样片创建后 7 天内可以升级，最终以服务端判断为准。[1]

## 查结果和下载

查询、等待并保存到本地：

```json
{
  "id": "任务ID",
  "wait_seconds": 40,
  "download_dir": "/完整绝对路径/输出目录"
}
```

`wait_seconds` 的范围是 0–40 秒。超时会返回当前状态和 `timed_out: true`，继续用同一个 ID 查询即可。查询和下载一共最多等 48 秒。

`download_dir` 必须是绝对目录，插件会自动创建。它不会覆盖已有文件；下载失败时会保留原任务和已经保存的文件，重下时可以换一个目录。

`result` 会尽量返回媒体尺寸、时长、预计耗时和实际积分消费。服务端没有返回的字段会保持缺失，不会填 0。

忘记任务 ID 时，用空参数 `{}` 调用 `result`，可以查看本机为当前账号保存的最近 20 个任务。这个列表只包含本机记录，不包含尚未拿到 ID 或在其他设备提交的任务。

`running` 表示还在生成，继续查；`failed` 和 `canceled` 按返回原因处理；`unknown` 先到官方页面核对，不要当成失败重新提交。

保存成功后，结果里会有 `files`，每个媒体也会带 `local_path`。

插件 `generate` 返回的 ID 要交给插件 `result`；Magpie 原生媒体工具返回的 ID 要交给它自己的结果工具。两套 ID 不要混用。

## 计费和失败处理

提交后拿到任务 ID，只代表任务已经提交，不代表生成成功。

普通生成、Draft 样片和 Draft 升级都会消耗积分，样片和升级是两笔独立费用。小云雀不一定返回单任务账单，所以插件不会拿余额差冒充单价。

上传失败时不会提交生成。拿到任务 ID 后，查询或下载失败都不会自动重新生成；先核对原任务，再决定下一步。

## 限制

- Magpie 内置媒体工具只暴露标准参数。长视频、参考音视频和 Draft 升级请使用插件 `generate`。
- 不提供小云雀接口没有支持的局部 mask、透明背景、格式转换或取消。
- 团队空间暂未测试，其他设备、操作系统和音频听审也还没有验收。
- 本插件与 `KasenRi/magpie-plugin-xiaoyunque` 使用相同的供应商 ID，请只启用其中一个。

## 和另一个小云雀插件的区别

`KasenRi/magpie-plugin-xiaoyunque` 更偏向工具调用，支持 Access Key 和 Cookie 两种后端。

本插件支持网页登录和 Access Key，重点是把小云雀的图片／视频模型直接放进 Magpie 的模型目录和原生媒体入口，同时保留三个工具处理生成、恢复、下载和 Draft 升级。本插件不提供 Cookie 后端。

两者访问的是同一个小云雀服务。使用同一账号和空间时，积分是共享的，不会因为换了插件就多出免费额度。

## 运行环境

Magpie 使用内置插件宿主，不需要另外安装 Node.js 或小云雀 CLI。

开发和离线测试需要 Node.js 22 或更新版本。插件提供与社区仓库一致的 OpenCode 1.x／2.x 入口；OpenCode 2.x 的通用适配器不会转接本插件的工具和积分展示，完整体验以 Magpie 为准。

## 验证

```sh
npm test
npm run check
```

截至 2026-11-14，主要使用链路已经通过验收：两种登录、模型和积分读取、图片生成与参考图编辑、effort 和美学模型、普通视频、混合参考素材、首尾帧、Draft 样片转 1080p 成片，以及原生 HTTP 图片编辑和视频创建／查询／下载。

已有成片做过全时段抽帧检查，打包产物也在同机干净配置里安装成功；Node 和 Bun 各 85 项离线测试通过。

团队空间、其他设备和音频听审尚未验收。版本变化见 [更新记录](CHANGELOG.md)。

## 参考

1. [小云雀 API 体验指南](https://bytedance.larkoffice.com/docx/CQOYdJNLioLz6fxRzKXcCsKLnJh) 和 [官方 CLI](https://github.com/Pippit-dev/cli) · 密钥、登录和媒体生成协议；CLI 核查版本 1.0.52。
2. [Magpie 插件文档](https://usemagpie.ai/docs/plugins) · 供应商、授权和工具集成。
3. [Magpie 社区插件](https://github.com/magpie-community/plugins) · 账号和插件体验。
4. [KasenRi 小云雀插件](https://github.com/KasenRi/magpie-plugin-xiaoyunque) · 对比版本 0.2.0。
5. [Magpie Image Models](https://github.com/double2tea/magpie-image-models) · 对比版本 0.4.0。
6. [火山方舟视频生成 API](https://www.volcengine.com/docs/82379/1520757) · 高级参数参考；实际支持范围以小云雀实时目录为准。
