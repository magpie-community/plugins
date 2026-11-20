# Magpie ZenMux Video

在 Magpie 自带的 `magpie-image` MCP 里使用 ZenMux 视频模型。插件读取已配置供应商的模型目录，把 `generate_video` 的提交、进度查询和 MP4 下载转换成 ZenMux 对应的协议。它通过本机 Magpie 网关使用原供应商的凭据，插件账号只保存供应商 ID。图片继续使用 Magpie 自带的 `generate_image`。

## 安装和连接

1. 在 Magpie 的「供应商」里配置能调用 ZenMux 的 API Key，确认 Chat Base URL 是 `https://zenmux.ai/api/v1`，记下供应商 ID，通常是 `zenmux`。
2. 在「插件」中从 GitHub 安装 `github:zghstart/magpie-zenmux-video`。也可以运行下面的命令。
3. 在 **ZenMux Video** 下选择「复用已有供应商」，输入第 1 步的供应商 ID。这一步读取模型目录，不会购买视频。
4. 在「设置 → 模型 → 图像 → 视频生成」选择 `zenmux-video/` 下的型号，例如 `zenmux-video/bytedance/doubao-seedance-2.0`。Magpie 的「生图模型」开关也控制视频工具，应保持启用。

```sh
magpie plugin add github:zghstart/magpie-zenmux-video
magpie plugin login zenmux-video 1
magpie tools generate_video
```

在 macOS 上，如果 `magpie` 不在 PATH，可使用 `/Applications/magpie.app/Contents/MacOS/magpie`。安装、登录和模型发现均可在 Magpie **0.1.4600** 的插件接口上完成。

## 使用

在已经启用 Magpie Image 的 Agent 中说「用 `zenmux-video/bytedance/doubao-seedance-2.0` 生成 5 秒海浪视频」。也可给 `generate_video` 传首帧 `image`、参考图 `reference_images`、`seconds` 和 `size`。不同型号允许的时长、分辨率和参考素材组合以 ZenMux 的模型页面为准。生成按所选供应商的 ZenMux 账户计费。

「视频生成」列表显示 ZenMux 的发布日期，按日期从新到旧排列，同一天按模型 ID 排列，缺少日期的型号排在末尾。Magpie 会单独置顶当前选中的型号，输入搜索词后按匹配程度排列。

有公开优惠的型号会标注如「商城 6.5 折」，表示 ZenMux 商城价格为原价的 65%。插件刷新时匿名读取一次视频商城目录，只给当前供应商可用的型号加标记。目录暂时不可用时仍可选择模型，刷新后不再使用已过期的折扣标记。实际费用以账户账单为准。[ZenMux 视频商城目录](https://zenmux.ai/api/frontend/model/listByFilter?output_modalities=video)

## 模型和协议

插件从 `/api/v1/models` 和 `/api/vertex-ai/v1beta/models` 读取支持视频输出的模型。两个目录里重复的 Seedance 型号走原生视频接口。公开目录和接入协议见 [ZenMux 视频模型](https://zenmux.ai/models?output_modalities=video&sort=newest)。

插件在 Magpie 数据目录的 `zenmux-video-catalog/` 中按供应商保存上次取得的模型目录。重启时，即使本机网关还在启动，Magpie 也能从缓存列出视频型号。网关就绪后，插件会在目录缓存过期时重新获取。

| 协议 | 模型示例 | 任务与取片 |
| --- | --- | --- |
| ZenMux 原生视频 | Seedance、可灵、MiniMax H3、Wan、PixVerse、FLUX | 提交 `content[]`，按任务 ID 查询，然后流式下载 `content.video_url`。[接口文档](https://zenmux.ai/docs/zh/api/zenmux/generate-videos-native.html) |
| Vertex 视频 | Veo 3.1、HappyHorse、SkyReels、Agnes | `predictLongRunning` 提交，`fetchPredictOperation` 查询，并返回视频字节或可下载的 HTTPS 文件。私有 `gs://` 文件需要额外的 Google Cloud 凭据，应使用默认的内联输出。[接口文档](https://zenmux.ai/docs/api/vertexai/generate-videos.html) |
| Google Interactions | Gemini Omni 1.2 Flash、1.1 Flash Preview | 将一次返回视频的请求转换成本地后台任务。插件先写入成片再报告完成。[接口文档](https://zenmux.ai/docs/zh/api/vertexai/create-interaction-native.html) |

Omni 任务在 Magpie 数据目录的 `zenmux-video-jobs/` 中保存成片及状态。超过 24 小时的任务在后续启动新任务时清理。如果生成途中插件宿主退出，上游请求可能已经计费，查询会报告中断。可以先在 ZenMux 查看记录，再决定是否重新提交。原生和 Vertex 任务使用上游任务 ID，重启后仍可在上游有效期内取片。

## 开发与参考

运行 `npm test` 使用 Node 的内置测试器验证协议和插件入口。运行时无需安装 npm 依赖。

Magpie 的视频接口以版本化的 [provider 插件契约](https://github.com/yetone/magpie/blob/v0.1.4600/docs/subsystems/provider-plugins.md) 为准。现有开源实现可对照 [Magpie Vertex Veo 插件](https://github.com/null0xfff/magpie-vertex-veo)、[ZenMux CLI](https://github.com/wyh267/zenmux-cli) 和 [Hermes ZenMux Video](https://github.com/colin-chang/hermes-plugin-zenmux-video)。
