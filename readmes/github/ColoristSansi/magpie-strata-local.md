# magpie-strata-local

把本机 **Strata**（Qwen3.8-Flash-Next Q2_0，256K 上下文）接进 [Magpie](https://usemagpie.ai/) 的插件：
插件宿主一启动就把 Strata 服务拉起来，把所有请求转给本机，空闲时自动关掉，并把供应商配置好——
不需要手动改任何供应商设置。

- 供应商 id：`strata-local`
- 模型（三个座位同一份本地模型，协议不同）：
  - `strata-local/strata-chat` — OpenAI Chat Completions（`/v1/chat/completions`）
  - `strata-local/strata-messages` — Anthropic Messages（`/v1/messages`）
  - `strata-local/strata-responses` — OpenAI Responses（`/v1/responses`）
- 地址：`http://127.0.0.1:18777`（只绑本机，不需要真实密钥）

## 安装

在 Magpie 里打开 **插件 → 发现 → 非官方**，就能看到 **Strata Local**（仓库带 `magpie-plugin`
topic，magpie 直接列 GitHub 上打了这个标签的仓库，不需要 npm 包）。点安装后照常
`magpie plugin login strata-local`，密钥随便填（例如 `local`），本地服务不校验。

命令行安装同理：

```bash
magpie plugin add github:ColoristSansi/magpie-strata-local
magpie plugin login strata-local      # 密钥随便填（例如 local），本地服务不校验
```

发布到 npm 之后也可以直接按包名安装：

```bash
magpie plugin add magpie-strata-local
magpie plugin login strata-local
```

本地开发时用路径安装，文件夹插件是就地加载的：

```bash
magpie plugin add "C:\Users\ZHANQUAN\AIGC\models\magpie-strata-local"
```

改完源码后，`magpie plugin off/on <路径>` 或重启 Magpie 即可生效。

## 它做了什么

1. **自动设置供应商**：`config` 钩子声明 `strata-local`（`@ai-sdk/openai-compatible`），
   `provider.models` 钩子返回完整 Model 形状，为三个座位分别指定 `api.npm`，所以 Chat / Messages / Responses
   各走各的协议。
2. **自动启动**：插件工厂加载后 1.5 秒、`provider.models` 被调用时、以及请求到来时，都会检查
   `http://127.0.0.1:18777/health`；没在跑就执行
   `strata launch --model q2_0 --context 256k --vision on --access local --port 18777 --tune skip --yes --no-tui`。
   和 `start-strata.bat` 的参数一致。
3. **自动停止**：本插件启动的服务，连续 30 分钟没有请求后执行 `strata launch --stop`。
   只停“自己启动的”服务：如果你先手动开了 Strata，插件不会抢所有权，也不会自动关它。
   所有权记在 `~/.config/magpie/.magpie-strata-owned.json`，插件宿主重启后仍然记得。
4. **给 agent 的工具**（Magpie MCP：`/mcp/magpie/tools`）：
   - `magpie-strata-local_status` — 是否运行、模型是否加载完、地址、空闲多久、最近输出
   - `magpie-strata-local_start` — 启动（`wait: true` 时最多等 45 秒）
   - `magpie-strata-local_stop` — 停止并释放显存
   - `magpie-strata-local_logs` — 最近一次 `strata launch` / `--stop` 的输出

## 自动发现（换电脑 / 换目录也能用）

插件不假设 Strata 装在哪个目录，也不假设它一定在 18777：

1. **找命令**（`ensureCli`，结果缓存到 `~/.config/magpie/.magpie-strata-cli.json`）：
   `options.cliPath` → 环境变量 `STRATA_CLI` → PATH（`where strata.cmd` / `which strata`）→
   常见安装位置（`%LOCALAPPDATA%\Strata	erminal\currentin`、`Program Files`、`ProgramData`、
   `%APPDATA%`、`scoop`、`chocolatey`、`~/.strata`、各版本 `terminal\<版本>in`）→
   在 `%LOCALAPPDATA%` / `Program Files` / `ProgramData` / 用户目录里做深度 ≤4 的有限扫描
   （跳过 node_modules、Temp 等）。非 Windows 上退回 PATH 里的 `strata`。
2. **找已经在跑的实例**：CLI 的 `strata launch --status --output json` 会给出真实端口和 URL，
   插件直接采用（所以手动用 `--port 8080` 起的服务也能被接管）；CLI 不在时再按
   `portCandidates`（默认 `[18777, 8080]`）探 `/health`，并且只认 `service: "strata"` 的响应。
3. **采用发现到的地址**：`auth.loader` 返回的 `baseURL` 和模型列表都用发现到的地址；
   发现到的实例停了以后，启动会回到配置的 `port`，不会对着空地址等。

所以在另一台电脑上：按官方安装方式装在默认位置，什么都不用配；装在自定义目录时，
设置 `STRATA_CLI` 或插件选项 `cliPath` 最稳，没有设置也会尝试扫描常见位置。
如果那台机器上的服务用的是别的端口，插件也能从 `launch --status` 或候选端口找到。

## 选项

在 `~/.config/magpie/plugins.json` 里给这一项加 `options`，或用命令：

```bash
magpie plugin options "C:\Users\ZHANQUAN\AIGC\models\magpie-strata-local" '{"idleStopMinutes": 10}'
magpie plugin options "C:\Users\ZHANQUAN\AIGC\models\magpie-strata-local" off   # 恢复默认
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `autoStart` | `true` | 随 Magpie 启动 Strata |
| `idleStopMinutes` | `30` | 空闲多少分钟后停止；`0` = 永不 |
| `idleCheckSeconds` | `60` | 空闲检查间隔 |
| `requestWaitMs` | `25000` | 一个请求最多等冷启动多久；超时返回 503（别超过客户端超时） |
| `startTimeoutMs` | `300000` | 启动 + 等待就绪的上限（首次下载模型时放宽） |
| `stopTimeoutMs` | `90000` | 等待停止的上限 |
| `port` | `18777` | Strata 端口（同时决定 API 地址） |
| `model` | `q2_0` | `strata launch --model`，即模型规格 |
| `apiModelId` | `strata` | 发给 Strata 的模型名（Strata 接受任意名字，`strata connect` 用的就是 `strata`） |
| `context` | `256k` | `--context` |
| `contextTokens` | `262144` | 模型列表里报给 Magpie 的上下文长度 |
| `outputTokens` | `32768` | 模型列表里报给 Magpie 的最大输出 |
| `vision` | `on` | `--vision` |
| `tune` | `skip` | `--tune` |
| `access` | `local` | `--access` |
| `cliPath` | 自动发现 | 指定 `strata.cmd` 路径；也可用环境变量 `STRATA_CLI` |
| `discover` | `true` | 自动找命令和运行中的实例 |
| `portCandidates` | `[18777,8080]` | CLI 找不到实例时探测的端口 |
| `scanDepth` | `4` | 常见位置都没找到时的目录扫描深度 |
| `seats` | 全开 | `{"chat":true,"messages":true,"responses":true}` 控制注册哪些座位 |
| `extraArgs` | `[]` | 追加给 `strata launch` 的参数，例如 `["--data-dir","D:\\models"]` |

供应商编辑器里还有两个开关（存在 `settings.PluginOptions` 里，默认都是“关”）：

- **不随 Magpie 自动启动** — 打开后只在请求到来或手动调用工具时启动
- **不自动停止（常驻）** — 打开后不因空闲而停止

## 首次启动

第一次启动会从 ModelScope 下载模型（环境里已带 `STRATA_SOURCE=modelscope`、
`HF_ENDPOINT=https://hf-mirror.com`）。下载期间 `/health` 未就绪，请求会收到 503
“Strata 正在加载模型”，等加载完再发即可。之后启动约 15–60 秒。

## 排查

- `magpie-strata-local_logs` 看最近一次命令输出。
- 找不到 CLI：确认 `%LOCALAPPDATA%\Strata\terminal\current\bin\strata.cmd` 存在，
  或在选项里设 `cliPath`。
- 端口被别的服务占用：`curl http://127.0.0.1:18777/health` 返回的不是 Strata 的结构，
  插件会报“端口上不是 Strata”。换 `port` 或先停掉占用者。
- 想手动验证：`curl http://127.0.0.1:18777/health`，或 `strata launch --status`。
- 旧的供应商条目：本插件用的是 `strata-local`。如果你之前手动建过 id 为 `strata` 的自定义供应商
  （指向同一个 127.0.0.1:18777），两者会同时出现在模型列表里，可以 `magpie provider rm strata` 删掉旧的。

## 结构

```
index.mjs          入口：export default { id, server }
lib/plugin.mjs     config / auth / provider / tool 钩子
lib/strata.mjs     启停、就绪探测、空闲计时、所有权标记
lib/options.mjs    选项默认值与归一化
scripts/smoke.mjs  不启动模型的冒烟测试：node scripts/smoke.mjs
scripts/idle-test.mjs 空闲自动停止实测（会真的停掉本机 Strata）
```
