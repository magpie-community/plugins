# magpie-mistral-pool

[![CI](https://github.com/zhuangzm/magpie-mistral-pool/actions/workflows/ci.yml/badge.svg)](https://github.com/zhuangzm/magpie-mistral-pool/actions/workflows/ci.yml)

**[English → README.en.md](README.en.md)**

把 **Mistral 账号的 Vibe 额度**接进 [magpie](https://github.com/yetone/magpie)。同一个插件提供两种引擎：一种走官方 ACP，消耗套餐的 **$300 Vibe 池**；一种走诚实直连，按非 Mistral 产品计到 **$30 API 池**。

> 非官方插件，与 Mistral AI 无隶属关系。不伪造客户端指纹、不模拟官方客户端 User-Agent——直连引擎就是一个规矩的 OpenAI 兼容 provider。

## 两个引擎的差别

| 引擎 | 请求由谁发出 | 扣哪本账 |
| --- | --- | --- |
| `direct`（默认） | 插件自己，走 OpenAI Chat Completions | 2026-12-01 起，非 Mistral 产品的调用计 **$30 Platform API 额度** |
| `acp` | 官方 `vibe-acp` 子进程（ACP + 本机 MCP 回桥） | 官方产品路径，计 **$300 Monthly Vibe 额度** |

两者暴露同一份 Vibe surface 模型表，并在用量卡里同时展示计划的两本账。

Provider id：`mistral-vibe`，与 Magpie 内置的 `mistral` API key provider 相互独立。

## 双入口并存（$300 主路 + $30 兜底）

同一份插件可以加载两次，各自独立 id：

```jsonc
[
  { "spec": "github:zhuangzm/magpie-mistral-pool",
    "options": { "engine": "acp" } },
  { "spec": "github:zhuangzm/magpie-mistral-pool",
    "options": { "engine": "direct", "providerId": "mistral-vibe-api" } }
]
```

第二个入口的 provider 名是 **Mistral Vibe (API)**；`providerId` 留空则回落 `mistral-vibe`。宿主按 providerId 隔离凭证、配置与用量，两个入口不会共用同一个 key 槽。

改完 `engine` / `providerId` 后要重载插件宿主（或重启 Magpie），运行中的 UI 可能还缓存着旧的 provider 对象。

## 安装

三种方式任选其一：

```sh
# 1) GitHub
magpie plugin add github:zhuangzm/magpie-mistral-pool

# 2) 本地目录（改代码时用）
magpie plugin add <本仓库路径>

# 3) npm 包（可选，尚未发布；流程见 docs/publish.md）
# magpie plugin add @solary/magpie-mistral-pool
```

然后登录：

```sh
magpie plugin login mistral-vibe
```

## 引擎 acp：官方 CLI（$300 Vibe 池）

需要跑 Magpie 插件宿主的这台机器上有官方 CLI：

```sh
uv tool install --python 3.14 mistral-vibe
vibe-acp --version
```

在 `plugins.json` 里选择它：

```jsonc
{
  "spec": "github:zhuangzm/magpie-mistral-pool",
  "options": { "engine": "acp" }
}
```

此时 provider 名为 **Mistral Vibe (ACP · $300)**。代理默认自动跟随系统代理，要固定端口时再写 `proxyUrl`（见「代理」）。

桥接怎么做的：

- 每个会话一个 `vibe-acp` 子进程，各自独立的临时 `VIBE_HOME` 与 `config.toml`。
- Magpie 的工具通过回环 Streamable-HTTP MCP server 暴露给 ACP；工具调用以普通 OpenAI `tool_calls` 回到 Magpie，下一条 `role: tool` 消息送回同一个 ACP 会话。
- 内置 Vibe 工具（例如 `bash`）一律拒绝，只放行 `run_typescript`、`search_tool_functions` 与会话自身的 MCP 工具。
- 工具耗时超过 `relayAfterMs` 时，桥先回一条 `[MAGPIE_RELAY]` 提示并暴露 `magpie_await_result`，模型等待而不用重跑工具。

## 选项

| 选项 | 默认 | 作用 |
| --- | --- | --- |
| `engine` | `direct` | `direct` / `acp` |
| `providerId` | `mistral-vibe` | provider id，双入口时用它区分 |
| `providerName` | 按引擎推导 | 面板上显示的名字 |
| `proxyUrl` | 空（自动探测） | 出站代理：URL / `system` / `none`，同时下发给 ACP 子进程 |
| `noProxy` | 空（读 `NO_PROXY`） | 额外的直连例外，逗号分隔，支持 `*`、`.domain`、CIDR |
| `vibeAcpPath` | 走 `PATH`（Windows 用 `where.exe` 找） | 显式指定 `vibe-acp` |
| `vibeAcpArgs` | `[]` | 仅供测试用包装器，需与 `vibeAcpPath` 一起用 |
| `maxSessions` | 4 | 单个桥里并发的 ACP 会话上限 |
| `maxBridges` | 4 | 按 key 区分的桥实例上限，LRU 回收空闲桥 |
| `relayAfterMs` | 45000 | 多久后转为 relay 提示 |
| `sessionTtlMs` | 600000 | 会话空闲多久回收 |
| `firstOutputMs` | 720000 | 首字节预算 |
| `idleMs` | 300000 | 流式 chunk 之间的空闲预算 |
| `includeApiSurface` | `false` | 是否放出 `codestral` / `ministral` / `pixtral` |

环境变量：`VIBE_ACP_CMD` 覆盖 `vibe-acp` 命令；`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY` 参与下面的代理自动探测。

## 登录

- **浏览器（PKCE）**：与官方 CLI 同一流程——`POST console.mistral.ai/api/vibe/sign-in`，打开返回的页面，轮询，再把 token 换成 API key；key 存在 Magpie 的 auth store 里。
- **Vibe API key**：粘贴 console 里 *Code > Vibe Code CLI* 生成的 key。

`whoami` 的读取以 console 的 origin 为根：基址末尾的 `/v1`（或 `/api/v1`）会先被剥掉再拼 `/api/vibe/whoami`，所以永远不会打到 `/v1/api/vibe/whoami`。

## 计费：两本账

用账号的 bearer key 读 `GET /billing/subscription` 与 `GET /billing/budget`：`vibe_budget` 显示为 **Monthly Vibe**，`api_budget` 显示为 **Platform API credits**。key 实际扣的那本账参与路由判定，另一本标 `aside`。

- **2026-12-01 起**，非 Mistral 产品的直连 API 调用计 **$30 API 额度**，不再吃 **$300 Vibe 额度**。
- `acp` 引擎跑官方 CLI，计 **$300 Monthly Vibe**；`$30` 池用尽时它照常可用。
- `direct` 引擎不会伪装 Vibe 客户端去够 `$300` 池。
- `/billing/budget` 对缺少 `see_org_inference_usage` 权限的成员可能返回 403；此时降级为只显示套餐，用量卡不会坏。

## 模型

优先用账号实时的 `GET /model-catalog?surface=vibe-code`，失败回落 `GET /models`，再回落内置的 Vibe surface 列表。Vibe（或身份未知）的 key 看不到 `codestral`、`ministral`、`pixtral`（它们走 API surface）；API key 只有在 `options.includeApiSurface: true` 时才看得到。

## 传输

- 首字节：**720 s**（`options.firstOutputMs`），直连与 ACP 桥一致。
- 流式 chunk 之间的空闲：**300 s**（`options.idleMs`），两个引擎一致。
- 装了 `undici` 时开 TCP keepalive；在 Magpie 的 Bun 宿主里改用宿主 `fetch`，由宿主按请求应用已解析的代理并持有连接设置。
- 没有 60 s 的 header 超时：那会在深度思考的首字节到达前就掐断请求。
- SSE 逐块透传并带背压，不缓冲整段补全。

## 代理

默认自动跟随系统代理，不用手填端口。解析顺序：

1. `options.proxyUrl` 里写的 URL——显式指定永远优先；
2. `"none"`（也认 `off` / `direct` / `disabled`）强制直连；
3. `"system"`（也认 `auto` / `windows` / `default`）强制做一次系统探测；
4. 环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（大小写都认）；
5. Windows 的 WinINET 系统代理：`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 下的 `ProxyEnable` / `ProxyServer`，`http=…;https=…` 写法与 `ProxyOverride` 例外表都读；
6. 都没有就直连。

所以 `proxyUrl` 留空就是「自动」：Clash 换端口、换客户端、开 TUN 都不用改配置。

```jsonc
{ "proxyUrl": "system" }                 // 与留空等价：环境变量 → 系统代理 → 直连
{ "proxyUrl": "http://127.0.0.1:1080" }  // 指定端口
{ "proxyUrl": "none" }                   // 强制直连
```

- 回环地址（`127.*`、`::1`、`localhost`）永远直连，插件自己的冒烟测试与本地端点不受影响。
- 只读系统代理的静态设置，不执行 PAC 脚本；系统只配了 PAC 而没有静态端口时按直连处理——TUN 模式下本来就该这样。
- 三个出口共用同一份解析结果：控制面（`whoami` / `billing`）、API 传输、`vibe-acp` 子进程。子进程的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 由它写入，`NO_PROXY` 会合并选项、`noProxy`、系统例外表与回环地址。
- Node 下走代理需要 `undici`（可选依赖），插件建 `ProxyAgent`；Magpie 的 Bun 宿主下插件完全不加载 `undici`（那会绕开宿主 fetch），而是把解析出的代理作为 Bun 的按请求 `proxy` 选项传给宿主 `fetch`，宿主的代理与 CA 设置照常生效。
- undici agent 的 `headersTimeout` / `bodyTimeout` 是故意关掉的：默认 300 s 会在首字节晚到的请求上先动手，把 720 s 的预算废掉；首字节与空闲分别由插件的 720 s / 300 s 看门狗接管。

## 会话粘性

`chat.headers` 会从 Magpie 的 session id 写入 `x-affinity` 与 `x-session-id`，且只对本 provider 生效。要让整个会话固定在一个账号上：

```sh
magpie group set <group> stays=session
```

## 排错

| 现象 | 处理 |
| --- | --- |
| `direct` 模式 402 | `$30` API 池用尽；改 `engine: "acp"`（并装好 `vibe-acp`）去吃 `$300` Vibe 池 |
| `acp` 模式 402 | `$300` Vibe 池用尽，或子进程用的账号没有 Vibe 权益；插件原样返回上游错误，不自作重试或冷却 |
| `MAX_SESSIONS` | 默认 4 个并发 ACP 子进程；调小 `maxSessions`，或靠 `sessionTtlMs` 让空闲会话过期 |
| `/billing/budget` 403 | 缺少组织用量权限时的预期行为，卡片只显示套餐 |
| 429 | 走 Magpie 自己的重试语义，插件不发明冷却 |
| 超时 | 调大 `firstOutputMs` / `idleMs`；首字节前超时是 `TRANSPORT_TIMEOUT_FIRST_OUTPUT`，流卡住是 `TRANSPORT_TIMEOUT_IDLE`；也要确认代理可达 |
| 代理没生效 | 先看日志里的 `proxy: <source> <url>`，只有 `option` / `environment` / `windows` 才算命中；只配了 PAC 的系统代理不解析，会按直连处理，不确定就直接填 `proxyUrl`。Node 下还需要装 `undici` |
| 面板还是旧额度 | GUI 缓存，重开设置页或重启 Magpie 插件宿主 |

## 安全与边界

- 不伪造 User-Agent、不模拟客户端指纹、不做多 key 轮换；多账号与轮换交给 Magpie 原生能力。
- 出站请求头走白名单清洗，只保留必要字段，不透传宿主的杂项头。
- 只读 `billing` / `whoami`，不在本地落额度缓存。
- ACP 子进程用临时 `VIBE_HOME`，退出即清理（Windows 走 `taskkill /T` 兜底）。

## 测试

```sh
npm test                                   # 单元 + 契约测试，全部打本地 mock
node scripts/acp-smoke.mjs                 # 真实 ACP 文本流（需要 key）
node scripts/acp-tool-smoke.mjs            # 真实 MCP 工具往返（需要 key）
node scripts/billing-probe.mjs snapshot    # 双池余额快照
```

CI（`.github/workflows/ci.yml`）在 ubuntu / windows / macos × node 20/22/24 跑 `node --test` 与 `npm pack --dry-run`。`scripts/*.mjs` 是真实联网冒烟，只在本地跑，不进 CI。

## 目录

| 路径 | 内容 |
| --- | --- |
| `index.mjs` | 插件入口：provider 定义、auth、billing、chat |
| `src/core.mjs` | 常量、Vibe surface 模型表、key 类型判定、请求头清洗 |
| `src/billing.mjs` | subscription / budget 读取，映射成 Magpie 的用量窗口 |
| `src/thinking.mjs` | 把历史思考字段改写成 Mistral 接受的 typed content part |
| `src/proxy.mjs` | 代理解析：选项 / 环境变量 / Windows 系统代理、NO_PROXY 例外匹配 |
| `src/transport.mjs` | 720 s / 300 s 双层看门狗、代理、重试边界 |
| `src/acp/` | ACP 运行时、JSON-RPC、MCP server、OpenAI 映射、子进程配置 |
| `test/` | `node --test` 单元与契约测试 |
| `scripts/` | 真实联网冒烟与双池余额探针 |

## License

MIT，见 [LICENSE](LICENSE)。Mistral、Vibe 等名称与商标归 Mistral AI 所有。

