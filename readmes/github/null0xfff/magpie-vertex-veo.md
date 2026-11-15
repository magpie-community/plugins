<div align="center">

<img src="https://raw.githubusercontent.com/null0xfff/magpie-vertex-veo/main/docs/logo.svg" width="88" height="88" alt="Vertex AI Veo" />

# magpie-vertex-veo

**Google Vertex AI Veo 视频生成 · Magpie / OpenCode Provider 插件**

[![Magpie Plugin](https://img.shields.io/badge/Magpie-Plugin-3b82f6?style=flat-square)](https://usemagpie.ai/)
[![magpie >= 0.1.4029](https://img.shields.io/badge/magpie-%3E%3D0.1.4029-6366f1?style=flat-square)](https://github.com/yetone/magpie)
[![Vertex AI Veo](https://img.shields.io/badge/Vertex%20AI-Veo%203.1-4285F4?style=flat-square&logo=googlecloud&logoColor=white)](https://cloud.google.com/vertex-ai/generative-ai/docs/video/overview)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?style=flat-square&logo=bun&logoColor=black)](https://bun.sh/)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-10b981?style=flat-square)](https://github.com/null0xfff/magpie-vertex-veo/blob/main/package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-10b981?style=flat-square)](https://github.com/null0xfff/magpie-vertex-veo/blob/main/LICENSE)

中文 | [English](https://github.com/null0xfff/magpie-vertex-veo/blob/main/README.en.md)

</div>

把 **Google Vertex AI Veo**（`veo-3.1` / `fast` / `lite`）接进 [Magpie](https://usemagpie.ai/)：装好、用服务账号登录，就能在 Magpie 的 `/v1/videos` 网关和 `magpie-image` MCP（`generate_video` / `generation_result`）里直接生成视频，支持文生视频、首帧图生视频、首尾帧和参考图。

专为**无桌面的 Docker / 服务器**部署设计：不需要浏览器登录、不需要 `gcloud`、不需要 GCS 存储桶，一个 Service Account JSON 就够。

> 非官方插件，与 Google 无关。Veo 按 Google Cloud 的价格计费，费用记在你自己的 GCP 项目上。

---

## ✨ 特性

| | |
| --- | --- |
| 🎬 **模型** | Veo 3.1 / 3.1 Fast / 3.1 Lite；可选 Veo 3.0 / 3.0 Fast / 2.0，也能手动加入新的预览版 ID |
| 🖼 **输入** | 文本提示词、首帧（`input_reference`）、尾帧（`last_frame`）、最多 3 张参考图（`reference_images`），支持 `data:` URL 和 `gs://` |
| 🔐 **无头登录** | 服务账号密钥文件路径 / 直接粘贴 JSON / ADC（`GOOGLE_APPLICATION_CREDENTIALS`、gcloud、GCE 元数据服务器） |
| 📦 **不需要存储桶** | 默认让 Vertex 把视频字节直接内联返回；也可以填 `gs://` 前缀，由插件用同一个 Token 流式转发 |
| 👥 **多账号 / 多项目** | 每个账号各用各的凭据、项目、区域和 Token 缓存，互不混用 |
| 🔄 **密钥轮换友好** | 密钥文件每次请求都重新读取，换了文件不用重新登录；Token 提前 60 秒自动续期，并发请求共用同一次刷新 |
| 🧭 **登录状态判断准确** | 只有凭据本身失效才标记「需要重新登录」；没开通 Veo、区域不支持、配额不足等错误会保留登录并原样提示 |
| 🪶 **零依赖** | 只用 Bun 内置 API、`node:crypto` 和 Magpie 注入的全局 `fetch`，自动遵循 Magpie 的代理设置 |

## 🤔 怎么选？

Magpie 里能用 Vertex AI 的方式不止这一个，按需求选：

| | 本插件 `vertex-veo` | Magpie 内置 `google-vertex` | [`magpie-vertex-ai`](https://github.com/HzTTT/magpie-vertex-ai) |
| :--- | :--- | :--- | :--- |
| **定位** | 只做 Veo 视频，功能做深 | 对话 / 生图 | Vertex 全家桶（Gemini、Claude、MaaS、Imagen、Veo 等） |
| **视频生成** | ✅ | ❌ | ✅ |
| **适合** | 只想把 Veo 设成 Magpie 的视频模型，尤其是 Docker 部署 | 只用 Gemini 对话 | 想用一个 Provider 覆盖 Vertex 的所有模型 |

Provider ID 互不冲突，可以同时安装。

## 🚀 快速开始

**1. 安装**（三选一）

- **插件市场**：Magpie → Plugins → Discover，搜索 **Vertex AI Veo** 安装（带 `magpie-plugin` 标签的仓库会自动出现在这里，标注为「未审核」）。
- **命令行**：

  ```bash
  magpie plugin add github:null0xfff/magpie-vertex-veo
  ```

- **Docker**（容器名按你的实际情况改）：

  ```bash
  docker exec -it magpie-magpie-1 /magpie plugin add github:null0xfff/magpie-vertex-veo
  ```

**2. 登录**

```bash
magpie plugin login vertex-veo 1
# 按提示填写：密钥文件路径 → 项目 ID（可留空）→ 区域（可留空）→ 存储前缀（可留空）→ 显示名称 → 是否列出旧模型
```

也可以在 Magpie 网页界面里给 **Vertex AI Veo** 添加账号。

**3. 设为默认视频模型**

在 Magpie 设置的模型页，把视频生成模型（Video generation）选为 `vertex-veo/veo-3.1-generate-001`。不设置的话 Magpie 会自动挑一个能用的视频模型，不一定是 Veo。

**4. 生成**

在任意接了 Magpie MCP 的 Agent 里直接说「生成一段 8 秒的视频：……」即可（会调用 `generate_video`），或者调网关，见下方[使用](#-使用)。

## ☁️ Google Cloud 准备

1. 在项目里启用 **Vertex AI API**（`aiplatform.googleapis.com`），并确认项目有 Veo 的使用权限和配额。
2. 创建服务账号，授予 **`roles/aiplatform.user`**（Vertex AI User），下载 JSON 密钥。
3. 如果要把视频输出到 GCS（可选），这个服务账号还需要能读写该存储桶的对象，例如在存储桶上授予 `roles/storage.objectUser`。
4. Docker 部署时把密钥放进挂载目录，例如 `/config/credentials/vertex-sa.json`，并确保容器内运行 Magpie 的用户（官方镜像是 UID `65532`）能读取这个文件。

## 🔐 登录方式

| 方式 | 适合 | 保存的内容 |
| :--- | :--- | :--- |
| **1. 服务账号密钥文件（容器内路径）** | Docker / 服务器，**推荐** | 只保存路径 `file:<path>`，每次请求重新读取文件 |
| **2. 粘贴服务账号密钥 JSON** | 只能用网页界面、不方便放文件 | 整份 JSON 作为账号的 key 保存在 Magpie 凭据存储里 |
| **3. 应用默认凭据 ADC** | 本机已 `gcloud auth application-default login`，或运行在 GCE / GKE / Cloud Run | 只保存 `adc:<path>` 或 `adc:default` |

三种方式都会问以下可选项：

| 字段 | 默认 | 说明 |
| :--- | :--- | :--- |
| `projectId` | 密钥里的 `project_id` | 在别的项目里调用 Veo 时填写 |
| `location` | `us-central1` | 具体区域，不支持 `us`、`eu` 等多区域 |
| `storageUri` | 空 | 空 = 视频内联返回；填 `gs://bucket/prefix/` = 写到 GCS 后由插件转发 |
| `accountLabel` | 空 | 账号在 Magpie 里显示的名称，多项目时方便区分 |
| 是否列出 Veo 3.0 / Veo 2 | 否 | 选「是」会额外列出旧版模型 |

登录时插件会实际换一次 OAuth Token 来校验，密钥错误、项目 ID 写错会当场报出来。要接多个 GCP 项目，再执行一次 `magpie plugin login vertex-veo` 换个密钥即可。

## 🎬 模型

| 模型 ID | 名称 | 时长（秒） | 分辨率 | 音频 |
| :--- | :--- | :--- | :--- | :--- |
| `veo-3.1-generate-001` | Veo 3.1（默认推荐） | 4 / 6 / 8 | 720p / 1080p / 4k* | ✅ 默认开启 |
| `veo-3.1-fast-generate-001` | Veo 3.1 Fast | 4 / 6 / 8 | 720p / 1080p / 4k* | ✅ 默认开启 |
| `veo-3.1-lite-generate-001` | Veo 3.1 Lite | 4 / 6 / 8 | 720p / 1080p / 4k* | ✅ 默认开启 |
| `veo-3.0-generate-001` | Veo 3（可选） | 4 / 6 / 8 | 720p / 1080p* | ✅ 默认开启 |
| `veo-3.0-fast-generate-001` | Veo 3 Fast（可选） | 4 / 6 / 8 | 720p / 1080p* | ✅ 默认开启 |
| `veo-2.0-generate-001` | Veo 2（可选） | 5 – 8 | 由模型决定 | ❌ |

\* 插件会把请求的分辨率原样传给 Vertex，某个模型实际支持哪些分辨率以 Google 当前的文档为准。画面比例只有 `16:9` 和 `9:16` 两种。

旧版模型的开启方式：登录时选「是」，或给 Magpie 设置环境变量 `VERTEX_VEO_LEGACY_MODELS=1`。Google 发布了新的模型 ID（比如预览版）时，用环境变量 `VERTEX_VEO_EXTRA_MODELS="id1,id2"` 加进来，不用等插件更新。

## 🛠 使用

### MCP（Agent 里直接用）

设成默认视频模型后，Agent 调用 `magpie-image` 的 `generate_video` 就会走 Veo；生成需要几十秒到几分钟，没完成时会返回一个 ID，Agent 再用 `generation_result` 取结果。

### OpenAI Videos API（网关）

```bash
# 1. 创建任务
curl -s http://127.0.0.1:3425/v1/videos \
  -H "Authorization: Bearer $MAGPIE_KEY" -H "Content-Type: application/json" \
  -d '{"model":"vertex-veo/veo-3.1-generate-001","prompt":"A fluffy orange cat on a sunlit windowsill","seconds":"8","size":"1280x720"}'
# → {"id":"video_vertex-veo....","status":"queued",...}

# 2. 查询状态：queued → in_progress → completed / failed
curl -s http://127.0.0.1:3425/v1/videos/<id> -H "Authorization: Bearer $MAGPIE_KEY"

# 3. 下载
curl -s http://127.0.0.1:3425/v1/videos/<id>/content -H "Authorization: Bearer $MAGPIE_KEY" -o out.mp4
```

图生视频把图片作为 data URL 放进 `input_reference`；首尾帧再加 `last_frame`：

```json
{
  "model": "vertex-veo/veo-3.1-fast-generate-001",
  "prompt": "The camera slowly pushes in as the cat wakes up",
  "seconds": "6",
  "size": "9:16",
  "input_reference": "data:image/png;base64,iVBORw0KGgo...",
  "last_frame": "data:image/png;base64,iVBORw0KGgo...",
  "negative_prompt": "blurry, low quality",
  "generate_audio": true
}
```

OpenAI 官方 SDK 用 `multipart/form-data` 上传 `input_reference` 也可以，Magpie 网关会先把它转成 data URL 再交给插件。

### 参数映射

| OpenAI / Magpie 字段 | Vertex Veo |
| :--- | :--- |
| `prompt` | `instances[0].prompt`（只给首帧时可省略） |
| `input_reference`（`data:` URL 或 `gs://`） | `instances[0].image` |
| `last_frame` | `instances[0].lastFrame` |
| `reference_images[]`（最多 3 张） | `instances[0].referenceImages[] = {image, referenceType:"asset"}` |
| `seconds` | `durationSeconds`：取模型支持的时长里最接近的值（一样近时取较长的）；不传为 8 |
| `size` = `16:9` / `9:16` | `aspectRatio` |
| `size` = `WIDTHxHEIGHT` | 按宽高比得到 `aspectRatio`，按短边得到 `resolution`（≥2160 → `4k`，≥1080 → `1080p`，其余 → `720p`） |
| `size` = `720p` / `1080p` / `4k` | `resolution`（只对 Veo 3 系列生效） |
| `aspect_ratio`、`resolution` | 显式指定，优先级高于 `size` |
| `n` / `sampleCount` | `sampleCount`（1–4，只返回第一个视频） |
| `negative_prompt`、`person_generation`、`generate_audio`、`seed`、`enhance_prompt`、`compression_quality`、`resize_mode`、`storage_uri` | 对应的 camelCase 参数，snake_case 和 camelCase 都接受 |

Veo 3 系列没传 `generate_audio` 时默认开启音频（`generateAudio: true`），不要声音就传 `false`。

## ❓ 常见问题

<details>
<summary><b>登录时报「无法读取凭据文件 … EACCES / ENOENT」</b></summary>

路径要写 **Magpie 进程看到的路径**。Docker 里是容器内路径（如 `/config/credentials/xxx.json`），不是宿主机路径；同时文件要对容器内的运行用户（官方镜像 UID `65532`）可读，例如在宿主机上 `chown 65532 xxx.json` 或 `chmod 644 xxx.json`。

</details>

<details>
<summary><b>生成时报 403 PERMISSION_DENIED</b></summary>

服务账号缺少 `roles/aiplatform.user`，项目没启用 Vertex AI API，或者项目还没开通 Veo。这种错误不会让账号掉登录，修好权限后直接重试即可。

</details>

<details>
<summary><b>报 404 NOT_FOUND（模型找不到）</b></summary>

所选区域没有这个模型。Veo 目前主要在 `us-central1` 提供，把账号的区域改成 `us-central1` 再试。

</details>

<details>
<summary><b>报 429 / RESOURCE_EXHAUSTED</b></summary>

触发了项目的 Veo 配额或速率限制。等一会儿再试，或者在 Google Cloud 控制台申请提高配额。账号登录状态不受影响。

</details>

<details>
<summary><b>视频状态是 failed，错误码 content_filtered</b></summary>

视频被 Google 的安全策略过滤了，错误信息里会带上 Google 给出的原因。换个提示词或参考图；涉及人物时可以试试 `person_generation`。

</details>

<details>
<summary><b>账号显示需要重新登录</b></summary>

只有凭据本身不能用了才会这样：密钥文件读不到或格式不对、私钥无法签名、Google 返回 `invalid_grant`（密钥被删除或禁用）、或者换了新 Token 之后 Vertex 仍然返回 401。检查密钥后重新执行 `magpie plugin login vertex-veo`。

</details>

<details>
<summary><b>不想内联返回，想把视频留在 GCS 里</b></summary>

登录时填 `storageUri`（如 `gs://my-bucket/veo-output/`），或单次请求里传 `storage_uri`。视频会保存在你的存储桶里，`/content` 由插件用同一个服务账号流式下载转发。

</details>

## 🔒 隐私与安全

- 插件只会访问 Google 的接口：`oauth2.googleapis.com`（换 Token）、`{区域}-aiplatform.googleapis.com`（Veo）、`storage.googleapis.com`（仅在使用 GCS 输出时），以及使用 ADC 时的 GCE 元数据服务器。没有任何统计或上报。
- 账号由 Magpie 保存在它的配置目录（`plugin-auth.json`）。用密钥文件登录时只保存文件路径；粘贴 JSON 时，JSON 作为账号的 key 保存，不会写进 metadata。插件不打印日志，报错信息里也不会带出私钥。
- Access Token 只缓存在内存里，按账号隔离。
- 已完成的结果只在内存里短暂缓存（最多 2 条、120 秒），视频字节交给 Magpie 后立即丢弃。

## ⚙️ 工作原理

```text
Agent / SDK ──OpenAI Videos API──▶ Magpie 网关 ──▶ 插件 fetch
                                                    │
     POST /videos              ──▶  :predictLongRunning      ─┐
     GET  /videos/{id}         ──▶  :fetchPredictOperation    ├─▶ Vertex AI Veo
     GET  /videos/{id}/content ──▶  内联字节，或 GCS ?alt=media ┘
```

- **鉴权**：用 `node:crypto` 对服务账号签 RS256 JWT，换取 `cloud-platform` 范围的 Access Token。
- **视频 ID**：把 `{project, location, model, operation}` 序列化后做 base64url 编码，只含 `[A-Za-z0-9_-]`，经过 URL 也不会被转义或截断。
- **状态**：映射为 OpenAI 的 `queued` / `in_progress` / `completed` / `failed`。
- **登录状态**（`X-Magpie-Sign-In`）：凭据不可用时返回 `expired`；Vertex 的 403 / 404 / 429 等返回 `kept`，并透传 Google 的原始错误信息。

## 🌱 环境变量

| 变量 | 作用 |
| :--- | :--- |
| `VERTEX_VEO_LEGACY_MODELS=1` | 所有账号都列出 Veo 3.0 / 3.0 Fast / 2.0 |
| `VERTEX_VEO_EXTRA_MODELS="a,b"` | 额外列出的模型 ID |
| `GOOGLE_APPLICATION_CREDENTIALS` | ADC 登录方式使用的凭据文件 |
| `VERTEX_VEO_API_BASE` / `VERTEX_VEO_GCS_BASE` | 改写 Vertex / GCS 的根地址（测试或私有接入点用） |

## 🧑‍💻 开发

```bash
git clone https://github.com/null0xfff/magpie-vertex-veo.git
cd magpie-vertex-veo
bun test
magpie plugin add "$PWD"   # 以本地目录方式安装调试
```

```text
index.mjs            入口，只导出插件函数（Magpie 会把入口导出的每个函数都当作插件调用）
lib/plugin.mjs       config / provider / auth 钩子与三个视频路由
lib/credentials.mjs  凭据解析、JWT 签名、Token 缓存与续期
lib/veo.mjs          请求体转换、视频 ID 编解码、状态映射、结果缓存
lib/models.mjs       模型列表与能力声明
test/                bun test，本地 mock Google Token、Vertex、GCS
```

测试覆盖 JWT RS256 签名与 Token 缓存（过期刷新、并发去重）、`models()` 能力声明、`POST /videos` 参数映射、视频 ID 编解码往返、各种状态流转、内联与 `gs://` 视频下载、`X-Magpie-Sign-In` 判断和多账号隔离。

欢迎提 Issue 和 PR。

## 📄 License

[MIT](https://github.com/null0xfff/magpie-vertex-veo/blob/main/LICENSE)

Google、Google Cloud、Vertex AI 和 Veo 是 Google LLC 的商标。本项目与 Google 没有关联。
