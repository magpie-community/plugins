# magpie-plugin-muse2api

把自建的 [muse2api](https://github.com/czg86389-hub/muse2api) 网关接进 [Magpie](https://usemagpie.ai/)：
**对话走 provider，图片 / 视频走工具**——因为 Magpie 的供应商插件只转发 chat 协议，没有图片 / 视频生成钩子。

- provider：`muse2api`，模型 `muse-spark`（文本对话）
- 工具：`generate_image` / `image_status` / `generate_video` / `video_status`
- 工具名在 Magpie 里是 `muse2api_generate_image` 等（`<插件短名>_<工具>`）

## 前置条件

1. 一个能访问的 muse2api 实例（本机或远端），已按
   [muse2api 文档](https://github.com/czg86389-hub/muse2api) 配好 Chromium、Muse 账号与 `MUSE2API_KEY`。
2. 实例的 `/v1/models` 可访问，例如：

   ```bash
   curl -H "Authorization: Bearer $MUSE2API_KEY" http://127.0.0.1:18610/v1/models
   ```

   muse2api 默认端口是 `18610`，`MUSE2API_KEY` 以 `m2a_` 开头（未设置时由 muse2api 启动日志给出）。

## 安装

Magpie 桌面：**插件 → 发现 → 非官方插件 · GitHub**，搜 `magpie-plugin-muse2api`，点安装。
仓库带 `magpie-plugin` topic，Magpie 最多每 10 分钟拉一次 GitHub，打标签后几分钟内出现。

命令行：

```bash
magpie plugin add github:teddyztd/magpie-plugin-muse2api
```

本地开发目录安装：

```bash
magpie plugin add ./magpie-plugin-muse2api
```

> 建议先卸载其它 Muse 供应商插件（例如 `magpie-muse-web`），否则模型列表里会出现两个可对话的
> Muse provider。本插件走你自建的 muse2api，不需要浏览器登录 Magpie 侧的 Muse 账号。

## 登录（对话用）

**供应商 → muse2api → 登录**，按提示填两项：

| 字段 | 例 | 说明 |
| --- | --- | --- |
| muse2api 地址（不含 `/v1`） | `http://127.0.0.1:18610` | 插件会请求 `<地址>/v1/models` 校验 |
| MUSE2API_KEY | `m2a_…` | muse2api 的 Bearer key |

校验通过后，地址会存进账号 metadata，`loader` 用 `<地址>/v1` 作 baseURL，模型固定为 `muse-spark`。

## 配置图片 / 视频工具（工具用）

工具的 `execute` 读不到 provider 的登录信息，所以连接信息单独给一份，二选一：

1. **插件选项（推荐，GUI 可改）**
   **插件 → 已安装 → muse2api → 选项**，填：

   ```json
   {
     "baseUrl": "http://127.0.0.1:18610",
     "apiKey": "m2a_…"
   }
   ```

2. **环境变量**（未设置插件选项时兜底）

   ```powershell
   $env:MUSE2API_BASE_URL = "http://127.0.0.1:18610"
   $env:MUSE2API_KEY = "m2a_…"
   ```

优先级：插件选项 > `magpie.option()` > 环境变量。

## 工具怎么用

| 工具 | 入参（必需加粗） | 返回 |
| --- | --- | --- |
| `generate_image` | **prompt**、size、aspect_ratio、reference_images（≤8 张）、model、extra | `{task_id, status, progress, hint}` |
| `image_status` | **task_id**、wait_seconds（默认 40，上限 40） | 完成：`{status:"completed", task_id, url, size, kind, bytes, revised_prompt}`；未完成：`{status, progress, task_id, hint}`；出错：`{..., error}` |
| `generate_video` | **prompt**、duration、aspect_ratio、size、reference_images（≤8 张）、model | `{task_id, status, progress, hint}` |
| `video_status` | **task_id**、wait_seconds（默认 40，上限 40） | 完成：`{status:"completed", task_id, url}`；未完成：`{status, progress, task_id, hint}`；出错：`{..., error}` |

要点：

- **图片一律异步**：`generate_image` 只提交，立刻返回 `task_id`；再调 `image_status` 取结果。
  `image_status` 会在工具时限内短轮询（默认最多 40 秒），拿到就返回 URL，没完成的返回 `task_id` 让你稍后重查。
- **视频天然异步**：`generate_video` 提交后返回 `task_id`，视频通常要几分钟；`video_status` 同样支持
  `wait_seconds`（默认 40 秒），一次调用内能等到就等到，等不到就再调一次。
- `reference_images` 支持 `http(s)` URL 和本地文件路径（本地文件会被读成 data URL 再提交，最多 8 张）；
  本地文件读不到会直接返回可操作的错误，而不是把路径当 URL 发给上游。
- 返回的 `url` 是 muse2api 的 `/v1/media/<name>`（该路由不鉴权），能直接在浏览器打开 / 下载。
  **如果 URL 打不开**，检查 muse2api 的 `PUBLIC_BASE`：它生成的是 `PUBLIC_BASE/v1/media/...`，
  远端访问时必须设成外部可达地址。
- Magpie 每个工具最多跑 55 秒，超时会 abort；因此 `image_status` / `video_status` 的轮询预算默认
  40 秒（`wait_seconds` 上限也是 40），单次请求超时按剩余预算截断，不会把一次调用拖过宿主上限。

## 验证是否可用

1. **模型列表**：供应商 → muse2api 的模型列表里应只有 `Muse Spark` 一个（`muse-image` / `muse-video` 不会出现在对话模型里，这是设计）。
2. **对话**：选 `Muse Spark` 发一句，能正常流式回复。
3. **图片**：

   > 用 muse2api 生成一张「雨夜霓虹街道」的图

   agent 调 `muse2api_generate_image` 拿到 `task_id`，再调 `muse2api_image_status`，最后给一个
   `http://<你的实例>/v1/media/....png` 链接，浏览器能打开。
4. **视频**：

   > 用 muse2api 生成一段 5 秒的海浪视频

   先拿 `task_id`，再调 `muse2api_video_status`；它会在 40 秒内轮询，没完成就再调一次，直到 `completed`
   并拿到 `.mp4` 链接。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 登录报「API key 无效（401）」 | 核对 `MUSE2API_KEY` 是否与 muse2api 实例一致（注意 muse2api 的 `MUSE2API_KEY` 为空时是不校验的，这时填任何 key 都能过） |
| 登录报「无法连接 …/v1/models」 | 实例没起 / 地址写错 / 端口不是 18610；先 `curl` 验一遍 |
| 对话 404 或 400 | `baseURL` 拼错了；本插件固定用 `<地址>/v1`，登录时地址**不要带** `/v1`（带了会被 validate 拦下） |
| 工具说「没有配置 muse2api 连接信息」 | 去 **插件 → 已安装 → muse2api → 选项** 填 `baseUrl` / `apiKey`，或设环境变量后重启 Magpie |
| 工具返回 401 | 插件选项里的 `apiKey` 与 provider 登录用的不是同一个 |
| 图片 / 视频链接打不开 | muse2api 的 `PUBLIC_BASE` 不是外部可达地址；图片本身生成成功时任务里也有 `bytes` / `size` 可核对 |

## 更新

仓库 push 后 Magpie 会在 10 分钟内通过 GitHub API 发现新提交；
**插件 → 已安装** 里对本插件点更新即可。命令行：`magpie plugin add github:teddyztd/magpie-plugin-muse2api`（同 spec 会覆盖为最新）。
若 Magpie 面板显示的还是旧版本，重启 Magpie 强制刷新。

## 开发

```bash
bun test              # 28 条单元测试，含 mock muse2api
bun run test/smoke.mjs  # 端到端冒烟：插件入口 → 真 HTTP → mock muse2api，四条工具链跑通
```

`test/mock-muse2api.mjs` 是一个只实现本插件所需协议面的假 muse2api（`/v1/models`、
`/v1/images/tasks`、`/v1/videos/generations` 及对应查询），可在没有真实实例时验证全部工具。

## 设计约束（为什么是现在这个形态）

- Magpie 供应商插件只能转发 chat 协议（`/chat/completions` 等），**没有图片 / 视频生成钩子**。
- 插件页面跑在 sandbox 里，CSP `connect-src 'none'`，页面自身不能 fetch，**不能**当代理通道。
- 因此图片 / 视频只能通过**工具插件**暴露；单个工具 55 秒上限决定了必须用「提交 + 查询」两段式。
- `muse-spark` 的 `tool_call: false`：muse2api 默认不向上游注入 tools（Muse 网页无原生 function calling），
  声明支持只会让 agent 发出会被拒绝的 tools。

## License

MIT
