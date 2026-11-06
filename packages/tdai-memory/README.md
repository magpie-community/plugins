# gateway-tdai-memory

**English** · [中文](#中文)

One long-term memory for every agent magpie connects, kept in your own [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) (TDAI) memory-core and reached directly: no Memory Proxy in between, and switching magpie's upstream model leaves the memory where it is. Community-made and unofficial: not affiliated with Tencent.

```
Claude Code · Codex · OpenCode · Crush · Pi · omp
        │  magpie writes their configs: all point at magpie's gateway
        ▼
magpie gateway ── onRequest:  recall L1 / L2 / L3, put before the turn's user message
        │         onResponse: once the turn ends, save it to L0 (when capture is on)
        │                   ⇅  memory-core /v3/*  (127.0.0.1:8420)
        ▼
any upstream model: switch it freely, the memory stays

Gemini CLI · Cursor · Copilot …  (models not served by magpie)
        └─ the plugin's tools on magpie's MCP server, when on: search · read_scene · remember
```

## What it does

- **Recall, once a turn.** `atomic/search` (L1 memories, with the turn's text as the query), `core/read` (the L3 core) and `scenario/ls` (the L2 scene list) are asked side by side, as TDAI's own Hermes adapter does, and put together as one `<tdai-memory>` block at the start of the turn's user message (after any tool results).
- **Keeps the prompt cache.** Each turn's block is kept for its session and put back in the same place on every later request, so the history an agent sends stays byte for byte the same. Reloading the plugin (an options change, a magpie restart) empties it: the turns before then go without their block, one cache miss. A failed recall is retried after a minute: a turn that runs longer than that gets its block late, the only other time history bytes change.
- **Capture, when you turn it on.** The text replies of a turn's tool loop are collected; once the turn ends (`end_turn`, no tool call waiting) the user's message and the whole answer are written to `conversation/add` once, as session `<agent>:<magpie session>`. The kernel extracts L1 memories from them every few conversations, then L2 scenes and the L3 core.
- **Fails open.** A kernel that is down, slow or refusing costs that request its memory and nothing else; a failed recall is tried again after a minute.
- **Changes nothing else.** `model`, `tools`, `tool_choice` and `stream` stay as they came (magpie doesn't let a hook change them either).
- **Your own agents only.** It serves requests whose origin is `local` or `magpie-key` (the sharing key magpie writes into this computer's agents). Other gateway keys, remote requests and unknown origins are left alone unless `remote` is on, and so are agents not in `agents` and requests that carry no tools (titles, summaries, classifiers).
- **Recalled text stays reference.** Where a memory quotes the block's own tags, they are escaped, so nothing recalled can close the block and read as the user's words.

## Install

Needs magpie 0.1.1273 or later (0.1.2208 or later to serve agents that use magpie's sharing key) and a running memory-core (TDAI's `memory-core` container listens on 8420).

```sh
magpie plugin add @magpie-community/gateway-tdai-memory   # from magpie's plugin catalog
magpie plugin add /path/to/this/folder                     # or from a folder holding this package
```

Then set at least your `userId` in **Plugins › Installed › Options**, `capture` if magpie should save turns, and `tools` for the tools; or:

```sh
magpie plugin options @magpie-community/gateway-tdai-memory '{"userId":"you","capture":true,"tools":true}'
```

A change reloads the plugin. Keys left out take the defaults below.

## Options

| Key | Default | What it does |
|---|---|---|
| `url` | `http://127.0.0.1:8420` | memory-core's address |
| `apiKey` | `local` | the Bearer token memory-core takes (`MEMORY_CORE_GATEWAY_API_KEY`; with that empty, any value passes) |
| `serviceId` | `default` | `x-tdai-service-id` |
| `teamId` · `agentId` · `userId` | `default` · `shared` · `default` | the kernel's scope. One `agentId` for every agent is what makes the memory shared |
| `perAgent` | `false` | `agent_id` becomes each agent's name: every agent keeps a memory of its own |
| `agents` | `claude` `codex` `opencode` `crush` `pi` `omp` | the agents recall and capture serve (magpie's agent ids) |
| `recall` | `true` | put the recall before each turn |
| `capture` | `false` | save each finished turn to L0 |
| `remote` | `false` | serve other gateway keys, remote and unknown origins too: they then read this memory and, with `capture`, add to it |
| `tools` | `false` | give agents the `search`, `read_scene` and `remember` tools (see [Tools](#tools)) |
| `requireTools` | `true` | skip requests that carry no tools |
| `recallLimit` | `5` | L1 memories a recall takes (1–20) |
| `maxInjectChars` | `6000` | the block's limit in characters (500–32000) |
| `includeCwd` | `true` | a captured user message starts with `[agent · cwd]` |
| `gatewayTimeoutMs` | `2500` | how long magpie waits for the hook (100–10000 ms); past it the request goes on without memory |

The switches take `true` or `false`; any other value keeps the default.

## Tools

Off until `tools` is on. magpie then serves them on its MCP server to every agent it connects:

- `search {query, limit?, conversations?}`: L1 memories, and raw L0 conversations with `conversations`
- `read_scene {path}`: one L2 scene, by a path the recalled `<scenes>` list gives
- `remember {content, project?}`: adds it to L0; it can be recalled once the kernel has extracted it

Their names start with the plugin's short name: `gateway-tdai-memory_search` and so on from the catalog; a plugin added from a folder takes the folder's name (e.g. `magpie-tdai-memory_search`). Behind magpie's MCP router an agent sees `<short name>__search`. `magpie plugin` lists them, and `magpie tool <name> --query …` calls one.

Unlike the requests the hook sees, a tool call carries no origin, and magpie serves plugin tools to other computers that hold a gateway key too: with `tools` on, anyone holding one of your gateway keys can read and add to this memory.

## Security

- memory-core with no key takes any Bearer token. Publish its ports on 127.0.0.1 only (`-p 127.0.0.1:8420:8420`), or set `MEMORY_CORE_GATEWAY_API_KEY` and the same value as `apiKey`.
- Capture keeps what you and your agents say in the kernel, and the tools answer gateway-key holders on other computers; both are off until you turn them on.

## Status

Checked end to end with Claude Code through magpie: the recall put before the turn, turns saved to L0, extracted into L1 memories and the L3 core, and found again with the `search` tool. Codex (Responses API), the chat-completions agents, the Gemini shape and the origins other than `local` are covered by unit tests only.

## Tests

```sh
node --test    # or: bun test
```

They run against a fake memory-core: no magpie and no kernel needed.

## License

MIT

---

## 中文

让 magpie 接入的每个 agent 共用一份长期记忆。记忆存放在你自己部署的 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)（TDAI）memory-core 中，插件直接调用内核，不经过 Memory Proxy；magpie 切换上游模型不影响记忆。本插件由社区制作，非官方，与腾讯无隶属关系。

```
Claude Code · Codex · OpenCode · Crush · Pi · omp
        │  配置只由 magpie 写入，都指向 magpie 网关
        ▼
magpie 网关 ── onRequest：召回 L1 / L2 / L3，插到本轮用户消息之前
        │       onResponse：一轮结束后写入 L0（开启 capture 时）
        │                 ⇅  memory-core /v3/*（127.0.0.1:8420）
        ▼
任意上游模型：随意切换，记忆不变

Gemini CLI · Cursor · Copilot …（模型不经 magpie）
        └─ 开启后，magpie MCP 服务上的插件工具：search · read_scene · remember
```

### 功能

- **每轮召回一次**：与 TDAI 自带的 Hermes 适配器相同，并行调用 `atomic/search`（以本轮输入为 query 检索 L1 记忆）、`core/read`（L3 核心）和 `scenario/ls`（L2 场景列表），拼成一个 `<tdai-memory>` 块，放在本轮用户消息的开头（tool_result 之后）。
- **不破坏 prompt cache**：每轮的块按会话缓存，之后每次请求原样插回原位置，agent 发出的历史逐字节不变。插件重载（修改选项、重启 magpie）会清空缓存，此前的轮次不再带块，产生一次 cache miss。召回失败一分钟后会重试：一轮持续超过一分钟时，它的消息会迟到地拿到自己的块，这是历史字节变化的另一处罕见情况。
- **归档需手动开启**：一轮工具循环中的文字回复先攒着，等这一轮结束（`end_turn`，没有待执行的工具调用）才把用户消息和完整回答写一次 `conversation/add`，会话 ID 为 `<agent>:<magpie 会话>`。内核每隔几轮对话抽取一次 L1 记忆，再生成 L2 场景和 L3 核心。
- **失败放行**：内核不可用、超时或拒绝时，只是这次请求不带记忆，请求照常发出；召回失败一分钟后再重试。
- **不改其他字段**：`model`、`tools`、`tool_choice`、`stream` 保持原样（magpie 本身也不允许 hook 修改）。
- **只服务本机自己的 agent**：只处理 origin 为 `local` 或 `magpie-key`（magpie 写进本机 agent 的共享密钥）的请求。其他 gateway key、远程请求和来源不明的请求一律跳过，除非开启 `remote`；不在 `agents` 列表里的 agent，以及不带 tools 的请求（生成标题、摘要、分类器等）同样跳过。
- **召回内容只作参考**：记忆里如果引用了注入块自己的标签，会被转义，召回的内容无法提前闭合注入块、冒充用户的话。

### 安装

需要 magpie 0.1.1273 及以上（要服务使用 magpie 共享密钥的 agent，需要 0.1.2208 及以上），以及一个运行中的 memory-core（TDAI 的 `memory-core` 容器，默认端口 8420）。

```sh
magpie plugin add @magpie-community/gateway-tdai-memory   # 从 magpie 插件库安装
magpie plugin add /path/to/this/folder                     # 或从包含本插件的文件夹安装
```

然后在 **Plugins › Installed › Options** 中至少设置 `userId`；需要保存对话时打开 `capture`，需要工具时打开 `tools`。也可以用命令：

```sh
magpie plugin options @magpie-community/gateway-tdai-memory '{"userId":"you","capture":true,"tools":true}'
```

修改选项后插件会自动重载，未填写的键取下表中的默认值。

### 选项

| 键 | 默认值 | 说明 |
|---|---|---|
| `url` | `http://127.0.0.1:8420` | memory-core 地址 |
| `apiKey` | `local` | memory-core 的 Bearer token（`MEMORY_CORE_GATEWAY_API_KEY`；该值为空时任意值都能通过） |
| `serviceId` | `default` | `x-tdai-service-id` |
| `teamId` · `agentId` · `userId` | `default` · `shared` · `default` | 内核的隔离范围；所有 agent 使用同一个 `agentId`，记忆才是共享的 |
| `perAgent` | `false` | 为 `true` 时 `agent_id` 改为各 agent 的名字，每个 agent 各用一份记忆 |
| `agents` | `claude` `codex` `opencode` `crush` `pi` `omp` | 召回和归档只服务这些 agent（magpie 的 agent ID） |
| `recall` | `true` | 每轮召回并插入记忆 |
| `capture` | `false` | 每轮结束后写入 L0 |
| `remote` | `false` | 同时服务其他 gateway key、远程请求和来源不明的请求：它们将能读取这份记忆，开启 `capture` 时还会写入 |
| `tools` | `false` | 向 agent 提供 `search`、`read_scene`、`remember` 工具（见下文“工具”） |
| `requireTools` | `true` | 跳过不带 tools 的请求 |
| `recallLimit` | `5` | 每次召回的 L1 条数（1–20） |
| `maxInjectChars` | `6000` | 注入块的字符上限（500–32000） |
| `includeCwd` | `true` | 归档的用户消息前加上 `[agent · cwd]` |
| `gatewayTimeoutMs` | `2500` | magpie 等待 hook 的时限（100–10000 ms），超时则请求不带记忆照常发出 |

开关只接受 `true` 或 `false`，其他值一律按默认值处理。

### 工具

开启 `tools` 后才提供。magpie 通过自己的 MCP 服务把它们提供给接入的每个 agent：

- `search {query, limit?, conversations?}`：检索 L1 记忆；`conversations` 为 true 时同时检索 L0 原始对话
- `read_scene {path}`：按召回的 `<scenes>` 列表中的路径读取一个 L2 场景
- `remember {content, project?}`：写入 L0，内核抽取之后才能被召回

工具名以插件短名开头：从插件库安装时为 `gateway-tdai-memory_search` 等；从文件夹安装时取文件夹名（例如 `magpie-tdai-memory_search`）。经 magpie 的 MCP 路由时，agent 看到的是 `<短名>__search`。`magpie plugin` 会列出全部工具，`magpie tool <工具名> --query …` 可以直接调用。

与 hook 处理的请求不同，工具调用不带 origin，而且 magpie 也会把插件工具提供给持有 gateway key 的其他电脑：开启 `tools` 后，持有你任一 gateway key 的人都能检索和写入这份记忆。

### 安全

- 没有设置密钥时，memory-core 接受任意 Bearer token。请只把它的端口发布在 127.0.0.1 上（`-p 127.0.0.1:8420:8420`），或者设置 `MEMORY_CORE_GATEWAY_API_KEY`，并在 `apiKey` 中填入同一个值。
- 归档会把你和 agent 的对话存进内核，工具会响应其他电脑上持有 gateway key 的人；两者默认关闭，需要手动开启。

### 验证情况

已通过 magpie 用 Claude Code 端到端验证：召回插在本轮之前，轮次写入 L0，抽取成 L1 记忆和 L3 核心，并能用 `search` 工具检索到。Codex（Responses API）、chat completions 协议的 agent、Gemini 协议，以及 `local` 以外的 origin 目前只有单元测试覆盖。

### 测试

```sh
node --test    # 或 bun test
```

测试使用模拟的 memory-core，不需要 magpie，也不需要内核。

### 许可

MIT
