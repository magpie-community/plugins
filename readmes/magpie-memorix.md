# magpie-memorix

Magpie 网关插件：让 **memorix** 的项目记忆自动注入每个 agent 请求，并在回复结束后把这一轮沉淀回 memorix。跨会话、跨 IDE 一次配置，全部生效。

```
IDE / Agent ──▶ magpie gateway ──▶ 上游模型
                    │
                    ├─ onRequest  ──▶ memorix_project_context（读）
                    └─ onResponse ──▶ memorix_store（写）
```

## 安装

前置条件：

1. Node.js ≥ 22.18.0（memorix 的硬要求；插件本身跑在 magpie 的 Bun 里）。
2. memorix HTTP 服务在跑：`memorix serve-http --port 3211`（或 `memorix background start`）。
3. 请求的 `cwd` 位于一个 git 仓库内（memorix 用 git 项目身份定位记忆；否则插件只会报告 `unbound` 并放行）。

```bash
node bin/selftest.mjs              # 体检：可达性 / 工具 / 读 / --store 写
magpie plugin add magpie-memorix   # 从 npm 安装（或 github:linjicong/magpie-memorix）
magpie plugin options memorix '{"endpoint":"http://127.0.0.1:3211"}'
```

## 行为

**读（onRequest）**
- 定位项目根：`projectRoot` 配置 > `ctx.cwd` > **从请求正文里识别**（`Current working directory:` / `CWD:` / `Primary working directory:` / `<environment_context>` / `<env>`）。magpie 的 `ctx.cwd` 由它自己从 agent 正文解析；像 DSH 这种不在正文里写目录的 agent 会得到空 cwd，所以插件自己再扫一遍。
- 用 `ctx.query` 调 `memorix_project_context`（`format: "prompt"`、`refresh: "auto"`）。
- 裁剪到 `contextTokens`（约 3 字符/token）后包成 `<memorix-context>` 块，追加到**本轮用户消息尾部**；system 前缀不动，上游 prompt cache 不受影响。
- 同一会话里每个用户轮次拿到的块会被记住并在后续请求中**原样回放**；同一条消息重复发送（工具循环）直接回放，不再请求 memorix。

**写（onResponse）**
- 从已完成回复里蒸馏：`entityName`、`type`（gotcha / decision / problem-solution / what-changed / how-it-works）、`title`、`narrative`、`facts`、`filesModified`（只保留真实存在于工作区的路径）、`topicKey`、`progress`。
- `topicKey = magpie:<session>:<query hash>`：同一轮重发/重试走 memorix 的 upsert，不会堆重复记录。
- 显著性门控：有真实文件改动 / 代码块 / 决策-根因-踩坑信号才写；闲聊、过短回复、子 agent、含密钥的轮次一律跳过；每会话有写入上限。

**失败一律放行**：memorix 没起、超时、项目未绑定、工具缺失、响应格式不认识 → 请求按原样路由，`ctx.report` 记录原因，绝不阻塞或改坏请求。

## 配置项

通过 `magpie plugin options memorix '<json>'`（GUI 里是插件的 Options 按钮），全部有默认值：

| key | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `endpoint` | `http://127.0.0.1:3211` | memorix HTTP 基址 |
| `gatewayTimeoutMs` | `8000` | magpie 给 hook 的预算（100–30000；默认值 1000 太短） |
| `timeoutMs` | `6000` | 单次 MCP 调用上限 |
| `inject` / `capture` | `true` | 读 / 写 各自开关 |
| `contextTokens` | `800` | 注入块 token 预算 |
| `position` | `"tail-user"` | 或 `"system"`（后者会失去前缀缓存收益） |
| `projectRoot` | `""` | 空 = 由 cwd 自动定位 git 根 |
| `skipSubagents` | `true` | 子 agent 请求不读不写 |
| `replayTurns` | `true` | 回放历史轮次的块（建议保持开） |
| `allowRemote` | `false` | 非 localhost 来源是否也注入/写入 |
| `minReplyChars` | `120` | 无文件时的最短回复门槛 |
| `maxStoresPerSession` | `10` | 每会话写入上限（0 = 不限） |
| `memoryDetails` | `0` | 额外把 Top N 记忆的**正文**注入（0 = 关；1–5）。多一次 search + detail 往返 |
| `memoryDetailChars` | `1000` | 正文摘要的字符上限 |
| `memoryDetailsSearch` | `true` | 正文只取 brief 里列的条目时，用一次有界搜索补更早的记录 |
| `recallCacheMs` | `60000` | brief 缓存时长（0 = 每次重新取） |
| `agent` | `""` | 传给 memorix 的 agent 提示（空 = 按 `ctx.agent` 映射） |

## 诊断

**“感觉插件没生效”的三个已知原因，按出现概率排查：**

1. **改过插件源码/选项后没重启 magpie 应用**。`magpie plugin off/on` 不总是让网关重新读 hook 清单；旧版本 app 启动时就把清单固定了。重启 magpie 应用即可。
2. **对话历史里引用过 `<memorix-context>` 块**（早期版本的 bug，v0.1.0 已修）：只要某条历史回复里引用/复述过这个块，那之后整个会话都会被误判“已注入”而跳过。已改为只检查本轮用户消息本身。
3. **agent 没在正文里声明工作目录且 cwd 为空** → `unbound`。插件会从请求正文里找 `CWD:` / `working directory:` / `<environment_context>`；都没有时用 `projectRoot` 配置显式指定。

进一步定位：

- 设 `MAGPIE_MEMORIX_DEBUG=1` 后重启 magpie，插件会把每次决策写到 stderr（注入字节数、回放、跳过原因、写回类型）。
- magpie 插件页会显示 hook 每次的 `report` 码：`ready`（注入成功）/ `empty` / `unbound` / `unavailable`（memorix 没起或超时）/ `invalid` / `skipped`。
- 快速自检：`node bin/selftest.mjs`（memorix 侧）+ 一条带 `Current working directory: <repo>` 的最小请求问“项目版本号是什么”。

## 已知边界

- 注入的 brief 是 memorix 的 `prompt` 格式：**默认只给标题与引用**。打开 `memoryDetails` 后插件会替 agent 展开正文（`memorix_detail` 需要 `force: true` + `purpose`，因为 memorix 限制“brief 已列出的记录再展开”）。
- 正文取哪些条目仍由 memorix 的检索/排序决定：brief 里没列、搜索也没命中的旧记忆，网关切不到；这类细节只能靠 agent 自己的 memorix MCP 工具。
- `memorix_project_context` 只按 git 项目建 brief；路径非 ASCII（中文目录）没法放进 `Mcp-Project-Root` 头，插件会报 `unbound` 而不是乱码。

## 开发

```bash
npm test          # 56 个用例，全部 fixture + 本地假 memorix，不依赖网络
npm run selftest  # 对真实 memorix 服务做端到端体检
```

约定：源码是纯 ESM JavaScript（magpie 用 Bun 直接跑，测试用 `node --test`）；不引入运行时依赖；hook 不抛异常、不重试写操作、只改消息字段。
