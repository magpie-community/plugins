# Hindsight Memory

[English](#english) · [中文](#中文) · Apache-2.0

## English

Hindsight Memory is an asynchronous [Magpie](https://github.com/yetone/magpie) gateway hook for [Hindsight](https://github.com/vectorize-io/hindsight). It recalls relevant memories before inference and attaches them to the current user message. When enabled, it submits the final user/assistant turn for retention. Gateway writes are **off by default**.

### Install and open

Open **Plugins → Hindsight Memory** in Magpie. For a source checkout:

```sh
magpie plugin add /path/to/plugins/packages/hindsight
```

Use an existing Hindsight bank. The default is `hermes` on `http://127.0.0.1:8888`. The workbench requires Magpie's plugin-page and local-service bridge. The Windows integration test uses Magpie 0.1.4572 and Bun 1.4.5. The package requires Bun 1.3.8 or newer.

### Choose what happens for each agent

| Mode | Behavior |
| --- | --- |
| Automatic | A supported native integration remains responsible for the actions it already performs. A confirmed disabled native action can be handled by the gateway. Agents with insufficient evidence wait for a choice. |
| Manual | Set recall and capture separately for each agent. New agents default to gateway off. Each action can still use automatic selection. |
| Legacy | Existing options containing `agents` use the same exact allow-list until you save a new mode. An explicitly empty legacy list retains the old Hermes/DSH name exclusions. |

The four per-action choices are automatic, gateway, native, and gateway off. Explicit gateway selection displays a conflict when an active native integration is detected. The global gateway capture switch must also be enabled for a gateway write. Switching from a legacy list to manual mode preselects the currently discovered legacy choices for review before saving.

Gateway agents inherit the default shared bank unless you select an existing bank for a specific agent. Both gateway actions then use that override. Native integrations keep their own bank settings. The workbench verifies new selections and never creates a bank. Activity can be filtered by agent and bank.

The workbench combines Magpie usage and the local applied-agent list, known local configuration directories, agents observed by the hook, saved choices, and manually added IDs. Native detection reads supported integration wiring for Hermes, DSH, Claude Code, Codex, OpenCode and Pi. Per-project, per-profile, custom, or unrecognized installations can remain unverified. Native tool and retrieval counts are bounded samples of locally available Hindsight Coding Agents logs. Gateway counts come from the hook. Bank totals are shared-bank totals.

Example explicit policy:

```json
{
  "hindsight_api": "http://127.0.0.1:8888",
  "bank": "hermes",
  "agent_mode": "manual",
  "agent_policies": {
    "claude": { "recall": "gateway", "capture": "off" },
    "dsh": { "recall": "native", "capture": "native" }
  },
  "capture": false
}
```

### Connection and advanced options

| Option | Default | Meaning |
| --- | --- | --- |
| `hindsight_api` | `http://127.0.0.1:8888` | Service root URL. The plugin appends API paths. |
| `bank` | `hermes` | Existing bank ID used for gateway recall and capture. |
| `agent_policies.<id>.bank` | Inherit | Optional existing bank for an individual agent in automatic or manual mode. |
| `recall_max_tokens` | `1024` | Per-query Hindsight budget. Range 1–16384. |
| `injection_max_bytes` | `16384` | Total UTF-8 bytes newly appended by the hook per request, including history replay. Range 1024–131072. |
| `gatewayTimeoutMs` | `5000` | Host hook limit. Recall keeps a 200 ms margin and is capped at 8000 ms. At or below 200 ms it is skipped. |
| `recall_tags` | `[]` | Optional strict match on any selected tag. Gateway captures receive the same tags. Untagged entries do not match when tags are set. |
| `allowRemote` | `false` | Permit a non-loopback Hindsight URL. |
| `allowInsecureHttp` | `false` | Also required for non-loopback plain HTTP. |
| `port` | `3482` | Local workbench service port. The launcher can recover from a port conflict. |

“Check connection” uses saved options. “Test current form” uses the draft without saving. The check reads health, the exact bank entry and bank statistics. It does not perform recall or retain. The gateway configuration indicator confirms a revision only after the hook sees a matching real request.

### Runtime, data and failure behavior

- Supports the Chat Completions, Anthropic Messages, OpenAI Responses and Gemini request formats. The hook handles the host's `local` and `magpie-key` origins.
- The latest query is capped at 8192 UTF-8 bytes. Same-turn recalls are shared when the request has a stable identity. Concurrent callers can cancel their own wait independently. A tool-only continuation without a cached result moves on without repeating the query.
- New blocks use a whole-request allowance. Older blocks are replayed when they fit. The in-memory cache is also byte-bounded. A timeout or connection failure leaves inference available. Repeated failures trigger a short cooldown.
- Capture submits a final user/assistant turn asynchronously. Tool-only and unsuccessful responses are skipped. A stable operation ID suppresses duplicate submissions on servers that support it. The workbench displays **submitted** and **completed** separately. An unacknowledged write is checked by operation ID where possible. The plugin never blindly requeues a retain after an uncertain outcome.
- The host's response observer is best effort. A host shutdown before the callback or submission can lose a capture. When both turn and reply IDs are unavailable, the plugin reports the skip.
- Activity contains bounded local counts, timestamps, status codes, Agent IDs and pending operation identifiers. Prompts, responses, memory text and credentials are excluded from the statistics. The SQLite file is in the local cache at `magpie/hindsight/activity.sqlite`; set `MAGPIE_HINDSIGHT_STATE_DIR` to override the directory. Rollups are kept for about 31 days. The UI can fall back to in-process samples when storage is unavailable.
- An enabled remote API receives user query text and, when capture is enabled, the final assistant reply. The plugin does not add Hindsight authentication headers. Recalled text is passed as untrusted historical context.

## 中文

Hindsight Memory 是 Magpie 的异步网关插件。它在模型回答前从 Hindsight 召回相关记忆，并附到当前用户消息。有需要时可将完整用户轮次提交给 Hindsight。**网关写入默认关闭。**

### 安装与打开

在 Magpie 打开 **插件 → Hindsight Memory**。从源码检出安装时，运行上方的 `magpie plugin add` 命令。默认连接本机 8888 端口上已有的 `hermes` 记忆库。工作台依赖 Magpie 插件页面和本地服务桥接。Windows 集成验证使用 Magpie 0.1.4572 和 Bun 1.4.5。

### Agent 如何选择

| 模式 | 行为 |
| --- | --- |
| 自动识别 | 检测到原生启用的动作交给原生。确认原生关闭的动作可以交给网关。状态证据不足时显示「待确认」。 |
| 手动选择 | 分别设定召回和写入。新发现的 Agent 默认关闭网关处理，单个动作可以设回自动。 |
| 兼容旧名单 | 已保存的 `agents` 名单按原规则生效。显式空名单沿用旧版 Hermes / DSH 排除规则，直到保存新模式。 |

每项可选「自动」「网关处理」「交给原生」「关闭网关」。手动选网关时，如果检测到原生动作已经启用，界面会标出冲突。网关写入还需要打开总开关。将旧名单转为手动时，工作台会预选已识别的旧策略供核对，再由用户保存。

默认所有网关 Agent 继承共享库 `hermes`。自动或手动模式下，可以在 Agent 行选择已有的独立库，网关召回与写入一起使用它。已有库由 Hindsight 提供，保存前验证新选择。原生集成保留自己的库配置。活动页支持按 Agent 和记忆库筛选。

Agent 列表来自 Magpie 用量、已应用的本机配置、已知配置目录、实际网关请求、已有策略和手动补录。原生检测覆盖可识别的 Hermes、DSH、Claude Code、Codex、OpenCode 和 Pi 接入。个别 profile、项目级覆盖和自定义接入可能显示待确认。原生日志样本、网关活动和共享库总量各自有独立的统计口径。

### 连接与运行状态

- **检查连接**使用已保存的设置。**测试当前表单**可在保存前检查 API、数据库状态和目标记忆库。检查只读健康状态、记忆库目录和统计。
- **网关配置**以实际请求看到的配置版本为准。刚保存且还没有匹配请求时，显示等待生效。
- `recall_max_tokens` 是单次 Hindsight 检索预算。总注入上限 `injection_max_bytes` 按 UTF-8 字节计入当前轮和重放的历史记忆。同轮工具续接尽量复用同一份记忆。
- 远端 Hindsight 需要显式允许。远端明文 HTTP 需要额外开启。召回会发送最多 8192 字节的用户查询。开启写入会发送该轮的最终回答。
- 可选标签为空时召回整个 bank 的相关记忆。填写时按任一标签严格匹配，网关采集也会加上这些标签。
- 采集显示「已提交」「处理中」「已入库」等状态。网关响应回调为尽力交付，宿主提前退出时可能少一次采集。没有稳定轮次和回复标识时会报告跳过。
- 24 小时、7 天和 30 天统计保存在本机缓存。统计不记录对话或记忆正文。工作台端口冲突时，从启动页的「工作台打不开」恢复。

### Development / 开发验证

```sh
npm test
npm run check
bun test test/observability.test.mjs
```

The Node test suite uses fixtures and skips the Bun-only SQLite test. The Bun command verifies persistence and async operation completion. Gateway integration tests use a separate Magpie instance with a synthetic provider and Hindsight service. They do not evaluate real-model answer quality.

Node 测试使用模拟数据，SQLite 验证由 Bun 单独运行。网关集成使用隔离的 Magpie 实例和模拟服务，生产模型的召回质量需要单独评估。

### AI disclosure / AI 参与声明

This plugin was developed with AI assistance. Review the settings, data handling, and test scope before using it with sensitive conversations.

本项目在 AI 协助下开发。处理敏感对话前，请核对设置、数据传输范围和验证覆盖。

[Apache-2.0](LICENSE) · © 2024-2026 Sam-Dancing™
