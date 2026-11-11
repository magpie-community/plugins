# Magpie Turn Trace（每轮追踪）

一个给 Magpie 侧栏添加「每轮追踪」入口的本地插件。它读取 Magpie 本机用量 API，并按 Codex 本机 rollout 中的 turn ID 归轮，展示会话、轮次、Token、缓存命中、上下文占用、费用、工具调用和文件活动。

## 现在的功能

- Token 合计、会话、轮次和请求同时显示 `K/M` 缩写与精确数字，缩写为主。
- 会话 → 轮次 → 请求三级折叠；会话标题来自本机 Codex `session_index.jsonl`。
- 列表、地图、方格三种视图。地图按 Token 面积绘制会话和轮次；方格提供 Token 构成和会话轮次密度。
- 显示缓存命中率、上下文占用、Token 圆环图、构成明细和会话/轮次排行；排行可以展开查看全部。
- Token 圆环使用 Magpie 网关读取的 `prompt.parts`，细分为系统提示词、工具定义、技能注入、注入内容、文件、工具结果和会话内容。
- 顶部提供今天 / 7 天 / 30 天 / 全部 / 自定义日期；自动刷新可设为关闭、5 秒、10 秒、30 秒或 1 分钟。
- 展示本机 Codex rollout 中可提取的工具调用、文件活动和技能注入；不展示或上传原始提示词、回复正文或工具输出。
- 主题、颜色、字体和控件形状与 Magpie 统一。字体直接读取 Magpie 的 `uiFont` / `codeFont` 设置。
- 优先用本机 Codex rollout 的 `turn_id` 精确归轮；找不到时才按请求时间间隔估算，并明确标记「精确轮次」或「时间估算」。

## 数据口径

Magpie 的请求行使用以下字段：

| 字段 | 含义 |
| --- | --- |
| `in` | 未缓存输入 Token |
| `cache_read` | 从缓存读取的输入 Token |
| `cache_write` | 缓存写入 Token |
| `out` | 输出 Token |
| `reasoning` | 推理 Token，已包含在 `out` 内 |

本插件统一使用：

```text
输入总量 = in + cache_read + cache_write
Token 合计 = 输入总量 + out
缓存命中率 = cache_read / 输入总量
```

不要额外加 `reasoning`，否则会重复计算。Codex Token Usage 的 `input` 通常显示“输入总量（含缓存）”，而 Magpie 的 `in` 是“未缓存输入”，所以直接对比两个面板的输入数字会看起来不同；两边的 Token 合计和缓存命中率应当能对上。

上下文占用来自本机 Codex 会话 rollout 中的 `event_msg.token_count`：

```text
上下文占用 = last_token_usage.total_tokens / model_context_window
```

上下文占用只读取 token_count 元数据；Token 构成只对 `prompt.parts` 做分类聚合，不返回或上传原始文本。Codex 会话文件默认在 `%USERPROFILE%\.codex\sessions`；如果设置了 `CODEX_HOME`，会从该目录读取。

## 安装

要求 Windows 上已安装 Node.js（不需要 npm 包或第三方依赖）。

1. 解压整个文件夹，保持 `package.json`、`server.mjs`、`page` 和 `dashboard` 在同一目录。
2. 双击 `start.bat`，保持命令窗口开启。它只会在 `127.0.0.1:3426` 提供本机面板。
3. 在 Magpie 的 Plugins 页面选择添加本地插件 / 文件夹，指向此文件夹；或在终端运行：

   ```bat
   magpie plugin add "C:\实际路径\magpie-turn-trace"
   ```

4. 在 Magpie 左侧栏打开「每轮追踪」，会自动进入追踪面板。

### 后台 / 开机自启

如果不想一直保留 `start.bat` 黑窗口，可以运行一次：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-autostart.ps1
```

它会注册当前用户的 Windows 计划任务 `MagpieTurnTrace`。登录 Windows 后，计划任务会启动隐藏的监视器；Node 服务异常退出时会在约 5 秒内重新启动，不会弹出终端窗口。卸载：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-autostart.ps1
```

手动停止后台服务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\stop-background.ps1
```

`stop-background.ps1` 会先停止 `MagpieTurnTrace` 计划任务，再停止当前 Node 进程，因此不会在停止后又被监视器自动拉起。需要恢复后台服务时运行：

```powershell
Start-ScheduledTask -TaskName MagpieTurnTrace
```

`start-background.ps1` 会先检查 3426 是否已经健康运行；已运行则不会启动第二份服务。日志位于 `%LOCALAPPDATA%\MagpieTurnTrace`。

如果本机 Magpie 网关不在 `http://127.0.0.1:3425`，可以在 `server.mjs` 顶部将 `MAGPIE_BASE` 默认地址改成实际网关地址，再重新运行 `start.bat`。也可以设置 `MAGPIE_URL` 环境变量：

```bat
set MAGPIE_URL=http://127.0.0.1:3450
node server.mjs
```

如果 Codex 使用了自定义主目录：

```bat
set CODEX_HOME=D:\path\to\.codex
node server.mjs
```

## 本机 API

服务只监听 `127.0.0.1`，提供：

- `GET /api/summary?period=today|7d|30d|all`：Magpie 用量汇总。
- `GET /api/requests?...`：Magpie 请求明细。
- `GET /api/range?from=YYYY-MM-DD&to=YYYY-MM-DD`：按日期范围分页读取 Magpie 请求。
- `GET /api/composition?...`：按日期范围读取 `prompt.parts` Token 构成。
- `GET /api/context?session=<id>`：从本机 Codex rollout 读取 token_count 事件、turn ID 和上下文窗口。
- `GET /api/theme`：读取 Magpie 的主题、语言和界面/代码字体设置。
- `GET /health`：本机服务健康检查。

## 安全边界

- HTTP 服务只绑定 `127.0.0.1`，不监听局域网或公网。
- API 只接受本地面板来源的请求；其他网页的跨域请求会被拒绝。
- 无云端上报、第三方依赖、API Key 输入或数据库。
- 面板只展示聚合后的 Token 构成、用量记录和本机活动元数据；不上传原始提示词、回复正文或工具输出。
- 不会把请求记录写入磁盘；刷新页面时重新读取本机 API。

## 故障排查

- **无法连接 Magpie API**：确认 Magpie 正在运行，默认网关 `http://127.0.0.1:3425` 能访问。
- **页面没有请求记录**：确认 Codex 请求确实经过 Magpie 网关；直接连接 DeepSeek 而绕过 Magpie 的请求不会出现在这里。
- **上下文一直显示 `—`**：确认本机存在 `%USERPROFILE%\.codex\sessions` 对应会话文件，或在启动服务时设置 `CODEX_HOME`。
- **轮次显示「时间估算」**：说明该请求没有匹配到 Codex token_count 事件；可以调大轮次间隔，或确认 Codex 会话记录没有被清理。
- **侧栏页无法打开面板**：先运行 `start.bat`，或运行 `install-autostart.ps1` 安装开机自启任务，再重新进入「每轮追踪」。
- **端口冲突**：将 `TRACE_PORT` 换成其他端口，并同步修改 `page/app.js` 中的 `3426` 链接；默认使用 `3426`。


