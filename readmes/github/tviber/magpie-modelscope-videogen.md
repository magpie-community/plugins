# magpie-modelscope-videogen

把魔搭（ModelScope）的免费/魔粒视频生成能力接进 [Magpie](https://github.com/MisonL/magpie-plugin-msmoli)（OpenCode 生态），在对话里直接做文生视频、首帧图生视频、首尾帧插值、魔粒估价与 LoRA/Checkpoint 检索。

## 支持的模型

| 模型 ID | 输入模式 | 特点 |
| --- | --- | --- |
| `minimax-h3` | 文生视频 / 图生视频 / 首尾帧 | 默认 t2v 模型，支持 LoRA 推理加速（4 步）与自定义采样步数 |
| `ltx-2.3` | 文生视频 / 图生视频 / 首尾帧 | 轻量快速，适合分镜草稿与高频迭代 |
| `wan2.2-i2v-a14b` | 图生视频 | 默认 i2v 模型，支持自定义 Checkpoint / LoRA / VAE |
| `wan2.2-ti2v-5b` | 文生视频 / 图生视频 | WAN 2.2 5B 轻量文/图生视频 |
| `wan2.2-t2v-a14b` | 文生视频 | WAN 2.2 14B 文生视频 |
| `wan2.1-flf2v-14b` | 首尾帧 / 图生视频 | 默认 flf2v 模型，适合镜头衔接 |
| `wan2.1-i2v-14b` | 图生视频 | WAN 2.1 14B 图生视频 |
| `wan2.1-t2v-14b` | 文生视频 | WAN 2.1 14B 文生视频 |
| `wan2.1-t2v-1.3b` | 文生视频 | WAN 2.1 1.3B 快速文生视频 |

实际可用参数范围（分辨率、时长、是否支持首尾帧）以运行时 `videogen_get_models` 返回为准。

## 为什么需要本地服务 + 无头 Chrome？

魔搭 AIGC 视频生成目前没有开放推理 API，只能通过已登录的浏览器会话提交与轮询；而单个视频通常需要几分钟才能出片，远超 Magpie 单次工具调用的超时上限。

因此这个插件拆成两部分协同工作：

1. **本地 Python 服务（`magpie-wan-service`）**：默认绑定在 `127.0.0.1:8765`，常驻后台负责无头 Chrome 会话保活、任务排队、SQLite 持久化与成品下载。
2. **Magpie 插件（`index.mjs`）**：把生成、查状态、下成品、估价、搜 LoRA 等能力暴露为 14 个 `videogen_*` 工具，提交任务后立刻返回任务 ID，不阻塞对话，出片后主动提醒。

登录时只会短暂弹出一个 Chrome 窗口让你完成短信/滑块验证码，验证通过后自动关闭并切回后台无头模式，不需要手动复制 Cookie。

## 3 步快速开始

环境要求：Node.js 20+、Python 3.11+、本机已安装 Chrome / Chromium。

### 第 1 步：安装并初始化本地服务

```bash
# 克隆仓库并安装 Python 服务
git clone https://github.com/tviber/magpie-modelscope-videogen.git
cd magpie-modelscope-videogen
python3 -m venv .venv
source .venv/bin/activate
pip install -e .

# 创建允许读取图片的目录并生成启动片段，然后自检环境
magpie-wan-service init --media-dir ~/Pictures/wan-inputs
magpie-wan-service doctor
```

确认 `doctor` 全部通过后，启动本地服务（按 `init` 输出的环境变量运行）：

```bash
export WAN_MEDIA_ROOTS=~/Pictures/wan-inputs
magpie-wan-service
```

### 第 2 步：在 Magpie 中安装插件

```bash
magpie plugin add /你的本地路径/magpie-modelscope-videogen
# 或安装已发布的包名：
# magpie plugin add magpie-modelscope-videogen
```

### 第 3 步：登录魔搭账号

打开 Magpie 设置中的 **ModelScope VideoGen**，点击 **登录新账号**：

1. 插件会自动拉起一个 Chrome 登录窗口；
2. 完成魔搭的短信和拖动验证码；
3. 验证成功后窗口自动关闭，账号状态与可用魔粒余额会直接显示在 Magpie 中。

如果有多账号，可以重复点击 **登录新账号** 添加，默认开启 **VideoGen 均衡负载**（优先用剩余魔粒最多、队列最短的账号）。

## 在对话里怎么用

直接用自然语言告诉 Magpie 即可，常见用法：

* **文生视频**：`用 minimax-h3 生成一段 5 秒视频：雨夜东京街头霓虹倒影，慢推镜头`
* **图生视频 / 首尾帧**：`把 /Users/me/Pictures/wan-inputs/start.png 和 end.png 用 wan2.1-flf2v-14b 做成 5 秒过渡视频`
* **生成前先估价**：`先估算一下用 wan2.2-i2v-a14b 生成 5 秒 720p 视频要多少魔粒，别提交`
* **搭配 LoRA**：`先搜一下适配 wan2.2-i2v-a14b 的电影质感 LoRA，再结合首帧出片`
* **查进度与取成品**：提交后会拿到 `job_id`，随时让 Magpie 查询进度或下载成品（会自动保存 MP4、关键帧预览和 HTML 预览页）。

## 常见问题

| 现象 | 排查方式 |
| --- | --- |
| 提示找不到浏览器 | 运行 `magpie-wan-service doctor` 查看探测结果，确认已安装 Google Chrome 或 Chromium |
| 图片提示不在允许目录 | 服务端只读取 `WAN_MEDIA_ROOTS` 内的文件；把图片放进该目录，或在调用时允许 `copy_to_media_root=true` |
| 账号显示过期或余额不可用 | 在 Magpie 中重新点 **登录新账号** 刷新会话，或用 `videogen_diagnose` 检查服务与插件版本是否一致 |
| 端口冲突或服务未启动 | 检查 `127.0.0.1:8765` 是否被占用；可用 `WAN_SERVICE_PORT` 换端口，并让插件 `serverUrl` 指向同一地址 |
| 升级后看不到旧账号 | 插件内部 provider ID 固定为 `modelscope-wan`，升级包名不会丢账号；若更换了数据目录请参考进阶文档迁移 |

## 刻意不做的事

* **不做云端托管或代理**：账号会话、图片输入和生成结果全部留在本机，不经过任何第三方服务器。
* **不做绕过验证码的自动化**：登录验证必须由你自己在弹出的 Chrome 窗口手动完成。
* **不做失败自动盲重试**：如果网络在提交瞬间断开（状态为 `unknown_submission`），服务端会暂停该任务而不是自动重发，避免重复扣魔粒；核对魔搭网页记录后再决定关联已有任务或重排。

## 进阶文档与隐私

* 进阶配置（手动接管 CDP 端口、多账号路由、14 个工具完整参考、`unknown_submission` 对账、架构与模块划分）：见 [ADVANCED.md](ADVANCED.md)
* 本地数据与隐私说明：见 [PRIVACY.md](PRIVACY.md)
* 开源协议：MIT，见 [LICENSE](LICENSE)
