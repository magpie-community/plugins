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

   启动实例（在 muse2api 仓库目录里，先 `pip install -r requirements.txt`）：

   ```bash
   python -m uvicorn app:app --host 127.0.0.1 --port 18610
   ```

   **不要直接 `python app.py`**：`app.py` 只定义 FastAPI 应用和 startup/shutdown 钩子，
   没有 `if __name__ == "__main__"` 的 uvicorn 入口，直接跑会只打印两条 DeprecationWarning 然后退出，
   端口始终不监听——看起来像「启动了但连不上」。

3. **视频取回依赖**：Magpie core 的 `@ai-sdk/openai-compatible` 视频适配器在生成完成后
   按 OpenAI 视频协议直接拉 `GET <地址>/v1/videos/{task_id}/content` 下载成品（不读任务里的
   `result.url`）。muse2api 需含该路由（[teddyztd/muse2api](https://github.com/teddyztd/muse2api)
   commit `c7054b18` 起实现，`/v1/videos/generations/{task_id}/content` 同步支持）；
   网关缺该路由时视频任务已完成，但取回报 `muse2api: {"detail":"Not Found"}`（FastAPI 未匹配路由的默认 404）。
   用 [muse2api_generate_video](#配置图片--视频工具工具用) 等内置视频链路时必须满足；走插件自带
   `video_status`（读 `result.url`）不受影响。

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
> Muse provider。本插件走你自建的 muse2api：账号登录既可以直接填 API key，也可以由插件拉起
> 浏览器完成 muse.ai 网页登录（cookie 自动导入 muse2api 的账号池）。

## 登录（对话用）

**供应商 → muse2api → 登录**，弹窗里有两种方式：

### 方式一：muse.ai 网页登录（Cookie）← 推荐

对齐 `magpie-muse-web` 的登录体验：插件自己拉起一个浏览器窗口打开 `https://muse.ai/`，你在里面正常登录
（或本来就在这个 profile 里登录过），插件从浏览器的调试协议里读取 muse.ai 域下的 cookie，取到核心项
`hatch_sess` 后自动 `POST <地址>/admin/accounts` 导入 muse2api 的账号池，然后关掉窗口。

- 需要先在**插件 → 已安装 → muse2api → 选项**里填 `baseUrl` 与 `apiKey`（网页登录要先能校验 `/v1/models`）。
- **每次登录都开一个全新的独立 profile**（`~/.config/magpie/plugins/muse2api-login-profiles/p-<时间戳>-<随机>`），
  登录结束（成功、失败、超时）就整目录删除，所以多个 muse.ai 账号之间不会串 cookie，也不会碰你日常的 Chrome 配置。
  崩溃或强杀留下的旧 profile 会在下次登录时按 12 小时清理。
- 同一个 muse.ai 账号重复登录不会重复建账号：插件按会话 cookie 算指纹，命中本地账本
  （`~/.config/magpie/plugins/muse2api-login-ledger.json`）时改为 `POST /admin/accounts/<id>/cookies`
  刷新已有账号；上游账号被删则回退成新建。上游 `/admin/accounts` 不返回 cookie 值，所以账本只能记在插件本机。
- 15 分钟内没登录成功会超时失败，可重试；超时会连同浏览器进程一起收掉。
- 登录成功后账号出现在 muse2api 管理页 `/admin` 的账号列表里，之后所有对话/图片/视频都用这个 cookie 池。

### 方式二：直接填 API key

| 字段 | 例 | 说明 |
| --- | --- | --- |
| muse2api 地址（不含 `/v1`） | `http://127.0.0.1:18610` | 插件会请求 `<地址>/v1/models` 校验 |
| MUSE2API_KEY | `m2a_…` | muse2api 的 Bearer key |

两种方式最终都拿到同一个 `MUSE2API_KEY`：地址存进账号 metadata，`loader` 用 `<地址>/v1` 作 baseURL，
模型固定为 `muse-spark`。

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

优先级：插件选项 > `input.magpie.option()` > 环境变量。

## 工具怎么用

| 工具 | 入参（必需加粗） | 返回 |
| --- | --- | --- |
| `generate_image` | **prompt**、size、aspect_ratio、reference_images（≤8 张）、model、extra | `{ok:true, task_id, status, progress, hint}` |
| `image_status` | **task_id**、wait_seconds（默认 40，上限 40） | 完成：`{ok:true, status:"completed", task_id, url, size, kind, bytes, revised_prompt}`；未完成：`{ok:true, status, progress, task_id, hint}` |
| `generate_video` | **prompt**、duration、aspect_ratio、size、reference_images（≤8 张）、model | `{ok:true, task_id, status, progress, hint}` |
| `video_status` | **task_id** | 完成：`{ok:true, status:"completed", task_id, url}`；未完成：`{ok:true, status, progress, task_id, hint}` |

**返回契约**：任何一次调用（成功、缺配置、连接失败、上游 4xx/5xx、参考图读不到）都返回**可 `JSON.parse` 的字符串**。
失败统一为 `{ok:false, status, error, …}`，按需带上 `baseUrl` / `task_id` / `http_status` / `field` / `hint`。不存在「错误返回中文纯文本」这一路。

例外（宿主行为，插件无法覆盖）：**参数类型 / 必填项由 Magpie 在调用工具前用 schema 校验**，
写错类型时返回的是宿主文案，例如 `generate_image's arguments are wrong: prompt: Invalid input:
expected string, received undefined`，这时代码根本没执行到插件里。

要点：

- **图片一律异步**：`generate_image` 只提交，立刻返回 `task_id`；再调 `image_status` 取结果。
  `image_status` 会在工具时限内短轮询（默认最多 40 秒），拿到就返回 URL，没完成的返回 `task_id` 让你稍后重查。
- **视频天然异步**：`generate_video` 提交后返回 `task_id`，视频通常要几分钟；`video_status` **只查一次**、
  立即返回当前 `status` / `progress`，完成时给 `url`，没完成就隔一会儿用同一个 `task_id` 再查。
- `reference_images` 支持 `http(s)` URL 和本地文件路径（本地文件会被读成 data URL 再提交）；
  本地先按张数与体积拦：**最多 8 张，单张 ≤40 MiB，合计 ≤100 MiB**（与 muse2api 上游同量级，base64 按解码后字节算）。
  超限时请求根本不发出，直接返回可操作的 JSON 错误。
- 返回的 `url` 是 muse2api 的 `/v1/media/<name>`（该路由不鉴权），能直接在浏览器打开 / 下载。
  **如果 URL 打不开**，检查 muse2api 的 `PUBLIC_BASE`：它生成的是 `PUBLIC_BASE/v1/media/...`，
  远端访问时必须设成外部可达地址。
- Magpie 每个工具最多跑 55 秒，超时会 abort；因此 `image_status` 的轮询预算默认
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

   先拿 `task_id`，再调 `muse2api_video_status`；它只查一次并立即返回状态，没完成就隔一会儿用同一个
   `task_id` 再查，直到 `completed` 并拿到 `.mp4` 链接。

## 网关自动拉起与保活（v0.2.0 起）

插件加载时（Magpie 启动 / 插件启用）会在后台自动把本机 muse2api 网关拉起来，
之后每 30 秒探一次端口，连续 2 次失败就自动重启（指数退避，上限 5 分钟）。
登录校验、模型列表刷新、网页登录前也会先确保网关在跑。

- **只管本机实例**（`127.0.0.1` / `localhost` / `::1`）；`baseUrl` 指向远端时不会动远端进程。
- 拉起命令等价于 `python -m uvicorn app:app --host 127.0.0.1 --port 18610`（在网关目录下执行），
  日志写到 `<网关目录>/data/logs/gateway-keepalive.log`。
- Python 自动探测顺序：显式配置 → 环境变量 `MUSE2API_PYTHON` → 网关目录里的 `.venv` / `venv` → PATH 上的 `python` / `py`。
- 只杀自己拉起的进程；手动起的 uvicorn 不会被误杀。
- 拉起失败（目录不对 / 没装 uvicorn / 端口被别的程序占用）时，登录报错会附带网关日志末尾，方便定位。

在 **插件 → 已安装 → muse2api → 选项** 里可以覆盖（都是可选）：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `gatewayEnabled` | `true` | 关掉则完全不自动拉起 |
| `gatewayKeepAlive` | `true` | 关掉则只拉起一次，不做崩溃重启 |
| `gatewayDir` | `E:\github\muse2api` | 网关仓库目录（含 `app.py`） |
| `gatewayPython` | 自动探测 | Python 解释器路径 |

环境变量兜底：`MUSE2API_GATEWAY_AUTOLAUNCH=0`、`MUSE2API_GATEWAY_KEEPALIVE=0`、`MUSE2API_GATEWAY_DIR`、`MUSE2API_PYTHON`。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 登录报「API key 无效（401）」 | 核对 `MUSE2API_KEY` 是否与 muse2api 实例一致（注意 muse2api 的 `MUSE2API_KEY` 为空时是不校验的，这时填任何 key 都能过） |
| 登录报「无法连接 …/v1/models」 | 实例没起 / 地址写错 / 端口不是 18610；先 `curl` 验一遍。v0.2.0 起插件会自动拉起本机实例（见上节），拉起失败时错误里会带网关日志末尾 |
| 重启机器后 Magpie 报连不上 | v0.2.0 起插件加载即自动拉起 + 保活；若仍失败，检查 `gatewayDir` 是否指向真实网关目录、`.venv` 里有没有 uvicorn，或看 `data/logs/gateway-keepalive.log` |
| 对话 404 或 400 | `baseURL` 拼错了；本插件固定用 `<地址>/v1`，登录时地址**不要带** `/v1`（带了会被 validate 拦下） |
| 工具说「没有配置 muse2api 连接信息」 | 去 **插件 → 已安装 → muse2api → 选项** 填 `baseUrl` / `apiKey`，或设环境变量后重启 Magpie |
| 工具返回 401 | 插件选项里的 `apiKey` 与 provider 登录用的不是同一个 |
| 网页登录报「需要先有 muse2api 的 API key」 | 先到 **插件 → 已安装 → muse2api → 选项** 填 `apiKey`；网页登录要用它校验 `/v1/models` |
| 网页登录报「没有找到 Chrome / Edge / Chromium / Brave」 | 装一个 Chromium 内核浏览器，或改用「手填 API key」方式 |
| 网页登录一直失败「没有在 15 分钟内完成」 | 确认弹出窗口里登录的是 muse.ai（不是其它站点），并确认该账号在 muse.ai 上确实可用；每次重试都会新开一个干净的 profile |
| 网页登录成功但对话仍报没有账号 | 去 muse2api 管理页 `/admin` 看账号列表与 cookie 数量；核心 cookie 是 `hatch_sess` |
| **管理页 `/admin` 账号池显示 0，但 `/admin/accounts` 明明有账号** | 页面顶部没填 API Key：页面只在填了 key 后才带 `Authorization` 调 `/admin/accounts`，否则一律 401、所有数字显示 0（不是后端问题）。点右上「保存」存 key 即可；也可以直接打开 `http://127.0.0.1:18610/?key=<m2a_…>` 免填 |
| 图片 / 视频链接打不开 | muse2api 的 `PUBLIC_BASE` 不是外部可达地址；图片本身生成成功时任务里也有 `bytes` / `size` 可核对 |
| 视频生成成功但报 `muse2api: {"detail":"Not Found"}` | 网关缺 OpenAI 视频下载端点 `GET /v1/videos/{task_id}/content`（Magpie core 不读 `result.url`，直接拉该路由）；换用含 commit `c7054b18` 的 muse2api。注意 `{"detail":"Not Found"}` 是 FastAPI 未匹配路由的默认体，业务 404 会带 `{"error":{"message":…}}` |
| 对话里选 Muse Image 报 `413 preflight_compress_failed` | DSH 在 preflight 阶段把会话工具目录（`tools[]`）发给了 32k 窗口的图像模型：报错 meter 里 `tools[] ~70,903` > 窗口 `32,000`，请求根本没转发。图像模型不需要工具，给 `muse2api/muse-image` 关闭工具挂载（或只留 0-1 个最小工具）即可 |

## 更新

仓库 push 后 Magpie 会在 10 分钟内通过 GitHub API 发现新提交；
**插件 → 已安装** 里对本插件点更新即可。命令行：`magpie plugin add github:teddyztd/magpie-plugin-muse2api`（同 spec 会覆盖为最新）。
若 Magpie 面板显示的还是旧版本，重启 Magpie 强制刷新。

## 开发

```bash
bun test              # 67 条单元测试，含 mock muse2api
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

## 文档

- [`docs/spec.md`](docs/spec.md)：设计与实现决策（问题、方案、用户故事、测试策略、不在范围内的事）
- [`docs/qa-report.md`](docs/qa-report.md)：全功能 QA 报告（登录 / 多账号 / 三能力 / 错误契约，含证据）
- [`docs/troubleshooting-admin-pool.md`](docs/troubleshooting-admin-pool.md)：后台页账号池显示 0 的根因排查
- [`CONTRIBUTING.md`](CONTRIBUTING.md)：本地开发、改动约定、发布方式
- [`CHANGELOG.md`](CHANGELOG.md)：版本变更记录

## License

MIT
