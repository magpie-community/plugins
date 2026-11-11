# Agnes AI for Magpie and OpenCode

在 Magpie 中使用自己的 Agnes API key，完成聊天、编程、看图、图片生成和视频生成。
这是非官方插件；包名保持 `opencode-agnes-auth`，账号标识保持 `agnes`。

## 安装

直接从本仓库安装：

```sh
magpie plugin add https://github.com/yukiryo/magpie-plugin-agnes
magpie plugin login agnes
```

登录时填写 [Agnes 平台控制台](https://platform.agnes-ai.com/) 创建的 API key。升级后继续沿用原有的 `agnes`
账号和已保存的 key；图片选择器的标识变化见下文。

已经安装的用户可在 Magpie 插件页更新，或运行 `magpie plugin update`。

Windows 用户也可以下载或克隆本仓库，双击 `安装插件.cmd`，或在仓库目录运行
`powershell -ExecutionPolicy Bypass -File .\install.ps1`。安装脚本会查找本机
Magpie、安装插件并检查安装结果，账号登录仍通过上面的登录命令完成。

聊天兼容 OpenCode 插件接口；图片和视频操作需要宿主提供相应入口。
**视频需要 Magpie 0.1.2077 或更新版本。**

## 模型与用法

默认提供以下 8 个模型：

| 选择器中的模型标识 | 用途 |
| --- | --- |
| `agnes-3.0-flash` | 聊天、流式回复、工具调用、看图 |
| `agnes-2.5-flash` | 聊天、流式回复、工具调用、看图 |
| `agnes-2.5-pro-beta` | 聊天、流式回复、工具调用、看图 |
| `gpt-image-agnes-2.0-flash` | 图片生成与编辑 |
| `gpt-image-agnes-2.1-flash` | 图片生成与编辑 |
| `gpt-image-agnes-2.5-flash` | 图片生成与编辑 |
| `agnes-video-2.5` | 视频生成 |
| `agnes-video-2.5-flash` | 视频生成，720P、4 到 12 秒 |

三个聊天模型均提供思考开关：`none` 关闭，`high` 开启。该设置对应 Agnes 的
thinking 开关，不表示多档思考强度。

插件可刷新 Agnes 的公共模型目录，目录内容可能与默认列表不同。
已退役的 `agnes-2.0-flash` 和 `agnes-2.5-pro-alpha` 不再展示。
公共目录只用于发现模型，不代表当前账号的额度或 key 状态。

### 图片

在 Magpie 的图片设置或图片生成入口选择 `gpt-image-agnes-*` 模型。
这些标识是供选择器识别的别名，实际发给 Agnes 的请求会还原为
`agnes-image-*`，例如 `gpt-image-agnes-2.5-flash` 对应
`agnes-image-2.5-flash`。

**从旧版升级后，请在图片设置中重新选择模型。** 旧的
`agnes-image-2.0-flash`、`agnes-image-2.1-flash`、`agnes-image-2.5-flash`
选择器标识已改为表中的三个别名。

图片生成与编辑统一请求 `/v1/images/generations`。编辑支持 Magpie 发出的
multipart 和 JSON 请求，参考图与返回格式按 Agnes 协议放入
`extra_body.image` 和 `extra_body.response_format`。

### 视频

支持创建任务、查询进度和下载结果。任务标识携带真实的 `video_id` 和模型，
重启后仍可继续查询，无需依赖内存中的任务记录。

视频参考素材支持公开 URL；本地文件上传和 Data URI 参考暂不支持。
Flash 模型仅支持 **720P、4 到 12 秒**。下载结果时不携带 Agnes API key。

## 登录状态与账单

插件通过 `/v1/dashboard/billing/subscription` 检查 key。
`/v1/models` 是公共目录，即使返回模型也不能证明 key 有效。
服务端明确返回 401 或 403 时，插件会将登录状态标记为已过期。

插件仅展示登录状态。Agnes 未提供本插件能够确认含义的公开余额接口，
余额、额度和账单请到 Agnes 平台控制台查看。

## 维护与验证

本仓库是插件的维护与分发来源。插件使用 ESM，运行时无需额外依赖或服务。

```sh
npm test
npm run check
npm pack --dry-run --ignore-scripts
```

测试使用模拟请求，不需要真实 API key，也不产生付费生成请求。
本版本未使用有效 key 完成生产环境生成验证。
CI 已配置为在 Windows、Ubuntu 的 Node.js 22 和 24 上执行以上检查。
本次发布已在 Windows 的 Node.js 26.12.1 和 Magpie 自带的 Bun 1.4.4 上各通过
92 项测试。GitHub Actions 当前不可用，本次未执行云端四组环境检查。

## License

MIT
