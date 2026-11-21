<p align="center">
  <a href="https://ymtuan.live/"><img src="assets/cover.png" width="100%" alt="羊毛团维护 · Codex 图片瘦身。实际请求从 116.9 MB 降到 16.9 MB。ymtuan.live"></a>
</p>

<h1 align="center">羊毛团 · Codex 图片瘦身</h1>

<p align="center">旧图留预览，原图还能找回。生图多的长对话可以继续聊。</p>

<p align="center">
  <a href="https://ymtuan.live/"><img src="https://img.shields.io/badge/羊毛团官网-ymtuan.live-FFD43B?style=flat-square" alt="羊毛团官网"></a>
  <a href="https://github.com/PigeonAI-Yang/yangmao-magpie-image-slim/stargazers"><img src="https://img.shields.io/github/stars/PigeonAI-Yang/yangmao-magpie-image-slim?style=flat-square" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-1D1C1A?style=flat-square" alt="MIT license"></a>
  <a href="README.en.md"><img src="https://img.shields.io/badge/README-English-1D1C1A?style=flat-square" alt="English README"></a>
</p>

<p align="center"><strong>由羊毛团开发改进并维护</strong> · <a href="https://ymtuan.live/">羊毛团官网</a> · <a href="https://ymtuan.live/topics/saving-tools">省钱工具</a> · <a href="https://github.com/PigeonAI-Yang/yangmao-magpie-image-slim/issues">问题反馈</a></p>

做封面、验收截图、反复改图时，Codex 的下一轮即使只发一句「继续」，也可能把对话里的旧图一起发给模型。请求越来越大，最后可能反复等待或报 SSE 超时。这个插件在 Magpie 转发前精简图片，保留文字和工具记录。

| 哪些图 | 默认怎么处理 |
| --- | --- |
| 当前轮的参考图和工具图 | 优先保留原图。只有请求仍超预算时才尝试缩小大图 |
| 最近五轮的历史图 | 大图换成有标记的预览，小图照常带上 |
| 更早的图 | 用文字提示占位。启用本地缓存后，可按路径回读原图 |

Codex 的跨会话派单也算新一轮。派单内优先保留直接附上的原图、最近一次读入的参考图和最新一批生成图，更早的图按历史图处理。

羊毛团曾用同一条长对话实际续聊，Magpie 转发前的请求从 **116.9 MB** 降到 **16.9 MB**，续聊中也按标记成功打开了原图。数值表示处理前后的 JSON 大小，属于单个实测案例。

## 安装

首版验证环境为 **Windows、Codex 和 Magpie 0.1.3960**。先让 Codex 经 Magpie 正常工作。预览功能使用 **Python 3.11 和 Pillow**。在 PowerShell 中运行：

```powershell
python -m pip install Pillow
magpie plugin add github:PigeonAI-Yang/yangmao-magpie-image-slim
```

也可以在 Magpie 的「插件 → 发现 → 非官方」搜索 **Yangmao · Image Slim**。如果目录还没刷新，直接用上面的 GitHub 安装命令。Windows 独立版没把命令加到 PATH 时，用下载的 Magpie 可执行文件运行同样的子命令。

安装后打开插件选项，将 `"gatewayTimeoutMs": 15000` 保存到 JSON 配置中，给大批图片留出处理时间。初始适用范围是 Magpie 中的 `codex/*` 模型路由。

## 使用

装好后，在原来的 Codex 对话里继续工作即可。默认整轮预算为 **70 MB**，请求达到 **12 MiB** 时开始处理图片。极端情况下，如果文字和当前轮图片经精简仍超过预算，插件会提示缩小当前上传批次或压缩上下文。

在 Magpie 的插件选项里可以修改：

| 选项 | 默认值 | 作用 |
| --- | --- | --- |
| `request_budget_bytes` | `70000000` | 整轮 JSON 预算，单位为字节 |
| `trigger_bytes` | `12582912` | 开始处理图片的请求大小 |
| `preview_turns` | `5` | 尽量保留预览的历史轮数 |
| `python_path` | `python` | 找不到 Python 时，填 Python 可执行文件的绝对路径 |
| `gatewayTimeoutMs` | `15000` | 建议在插件选项中保留此值，给大批图片留出处理时间 |

如果图片处理失败，Magpie 的请求预算检查会尝试用文字代替历史图。停用命令为 `magpie plugin off yangmao-magpie-image-slim`。

## 音频进了长对话怎么办

插件也会把历史内嵌音频换成文字引用，保留已有转录、对话文字和工具结果。GPT‑6.2 Sol 可能拒绝任何原始音频，所以这个路由连当前轮的音频也会换成引用。其他匹配的路由继续接收当前轮音频。若你的模型可以直接听音频，并且需要继续上传完整音频，可在插件选项中设 `"keep_audio": true`。

启用下方的本地缓存后，支持的内嵌录音可以和图片一样按需找回。需要分析录音内容时，Codex 可以用现有转录，或通过已获授权的工具读取音频并返回文字。

## 开启原图恢复

在插件选项里设置下面两个目录。二者默认留空，由你主动开启：

```json
{
  "gatewayTimeoutMs": 15000,
  "archive_path": "D:/你的本机缓存目录/magpie-image-originals",
  "codex_history_path": "C:/Users/你的用户名/.codex"
}
```

只填 `archive_path` 就能缓存和回读原图。同时填写 Codex 数据目录后，缓存缺图时，Codex 可以按标记里的操作从同一条对话的本机记录找回原图。恢复以 SHA-256 核对文件，适用于记录仍嵌有原图数据的情况。超过 1 GiB 时，缓存从最早存入的副本开始清理，目标是降到 512 MiB。原图缓存和记录读取在本机进行，带预览的请求仍由你在 Magpie 选用的服务商处理。

## 维护与致谢

本项目由 **羊毛团**维护。欢迎反馈适用环境、请求体积和复现步骤。提交问题时，请用截图或去除隐私的示例，避免附上完整对话记录。

基于 Euan Guo 的 [magpie-middleware-image-slim](https://github.com/euanguo/magpie-middleware-image-slim)。原作者的版权声明和 [MIT 许可证](LICENSE)随项目保留。

[羊毛团官网 · ymtuan.live](https://ymtuan.live/) · [English README](README.en.md)
