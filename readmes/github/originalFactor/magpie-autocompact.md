# Magpie 自动上下文压缩

这是一个原生 **Magpie Provider 插件**。通过 `config` 注册供应商和模型，通过 `auth.loader().fetch` 直接处理上游请求，在供应商的消息数或轮数达到配置阈值时压缩历史。它运行在 Magpie 的 Bun 插件宿主内，**不需要另起 HTTP 转发服务，也没有额外监听端口**。

支持客户端每次发送完整历史，以及 Responses 的 `previous_response_id`、`conversation` 服务端会话。客户端仍然调用 Magpie，压缩请求和压缩过程不会作为模型回答发送给客户端。

## 安装与使用

在项目目录运行：

```sh
magpie plugin add "$PWD"
```

安装后，在 Magpie 图形界面选择 **供应商 → 添加供应商 → 来自插件 → 自动压缩 · 自定义供应商**，按原生登录表单依次填写：

| 字段 | 填写方式 |
| --- | --- |
| 名称 | 该上游的显示名称 |
| Base URL | Responses API 根地址，例如 `https://api.example.com/v1`；不要带 `/responses` |
| API Key | 密码框输入，由 Magpie 凭据库保存 |
| 模型 ID | 逗号分隔；留空时使用当前密钥从上游 `/models` 获取 |
| 自动上下文压缩设置 | 使用默认值，或展开自定义阈值和压缩方式 |

默认限制为 80 条消息、40 个 user 轮、80 次服务端会话请求，保留最近 4 轮；使用 Responses 原生压缩，不支持时退回安全文本打包。自定义设置可调整这些阈值，并选择原生压缩或文本打包；消息数、轮数和服务端请求数可填 `0` 关闭对应限制，但消息数与轮数至少启用一个。服务端请求数启用时至少为 2。

**交互使用 Magpie 自己的逐项输入流程**，包括密码框、选择按钮和错误校验；插件接口不能把这些字段插入内置“自定义供应商”的同屏表单。此入口无需手写 JSON。表单只接入 Responses 兼容上游，客户端仍可通过 Magpie 使用 Chat 等协议。

填写后在模型选择器中选择 `autocompact/<模型 ID>`。名称显示在原生账号列表中，供应商行统一显示“自动压缩 · 自定义供应商”。通过“添加另一个账号”可以继续添加其他上游；每个账号保存自己的地址、模型和压缩策略。同名且同 Base URL 的重新登录会更新原有账号；要区分同一上游的多个密钥，请填写不同名称。Magpie 的原生模型与账号选择、代理及路由设置继续生效。服务端会话应固定到兼容的账号。

终端也使用同一套表单：

```sh
magpie plugin login autocompact
magpie models
```

上游设置保存在 Magpie 账号的 `metadata.autocompact` 中，表单输入的 API Key 单独保存在账号凭据字段，不写入插件选项或会话状态。重新登录可以更新该账号的配置。安装修改后的本地版本，在 Magpie“插件”中关闭再打开以重载；已有显式 `provider` 配置继续使用下述兼容方式。

如果之前已经设置过固定供应商 JSON，要切换到表单模式，先在插件选项中将 `provider` 改为 `null`，或运行：

```sh
magpie plugin options magpie-autocompact '{"provider":null}'
```

切换后通过新入口添加账号，并在客户端重新选择 `autocompact/<模型 ID>`；旧配置使用的供应商 ID 不会继续注册。

### 多供应商与配置中的 API Key

显式配置支持顶层 `providers` 对象，以供应商 ID 为键。每个供应商有独立的地址、模型、密钥及压缩策略：

```json
{
  "providers": {
    "compact-a": {
      "name": "供应商 A",
      "baseURL": "https://upstream-a.example/v1",
      "key": "your-provider-a-key",
      "models": ["model-a"],
      "maxMessages": 80,
      "maxTurns": 40,
      "mode": "responses"
    },
    "compact-b": {
      "name": "供应商 B",
      "baseURL": "https://upstream-b.example/v1",
      "key": "your-provider-b-key",
      "models": ["model-b"],
      "maxMessages": 40,
      "mode": "pack"
    }
  }
}
```

编辑 `examples/multi-provider-options.json` 后运行：

```sh
magpie plugin options magpie-autocompact "$(cat examples/multi-provider-options.json)"
magpie models
```

提供 `key` 后无需 `plugin login`。插件加载时使用 Magpie 的 `client.auth.set` 为该供应商建立或更新默认 API 账号，请求始终使用配置中的 key。更新 key 并重新设置插件选项即可轮换凭据。`apiKey` 是 `key` 的别名；两者同时填写时必须一致。旧的单供应商 `provider` 对象也支持这两个字段。

`models` 可以省略：插件启动时会使用该供应商的 `baseURL`、`key`（或 `apiKey`）及 `headers` 请求 `GET /models`，从 OpenAI 格式的 `data[].id` 注册模型。若未在配置中提供 key，则在 Magpie 读取已登录账号的模型时使用该账号凭据获取。显式填写 `models` 时完全使用手动列表；空数组或空对象仍视为配置错误。

自动获取的列表在本次插件宿主生命周期内按账号密钥缓存；重启宿主或重新应用插件选项后重新获取。获取请求限时 8 秒，不跟随重定向。失败时保留供应商注册、报告获取错误，后续模型刷新可重试；也可以手动填写 `models`。

客户端分别选择 `compact-a/model-a`、`compact-b/model-b`。各供应商的 key、压缩阈值、上游地址和会话状态互相隔离。某个供应商省略 key 时，可运行 `magpie plugin login <供应商 ID>`，通过 Magpie 保存其登录凭据。

`providers` 与非空的 `provider` 不能同时设置；从单供应商切换时，请替换整个插件选项对象。当前支持最多 64 个显式供应商，每个通过独立的标准 Provider 导出注册；`enabled:false` 可禁用其中一个，空 `providers:{}` 不注册任何供应商。默认无显式配置时仍使用图形化表单。删除或禁用配置只停止注册，不删除 Magpie 已保存的账号和历史会话。

直接填写的 key 会保存在插件选项中，并同步至 Magpie 的默认账号凭据；拥有插件选项读取权限的人可以看到它。压缩策略和会话状态不保存该字段。若需要仅由 Magpie 凭据库管理 key，省略此字段并使用登录流程。

### 显式配置与高级选项

需要自定义供应商 ID、模型能力、请求头或摘要服务时，可以使用 `examples/provider-options.json`。设置显式 `provider` 后，该安装实例使用固定配置和原来的 API Key 登录方式。例如：

```json
{
  "provider": {
    "id": "limited-compact",
    "name": "受限供应商 · 自动压缩",
    "baseURL": "https://your-upstream.example/v1",
    "models": ["your-model-id"],
    "maxMessages": 80,
    "maxTurns": 40,
    "keepTurns": 4,
    "mode": "responses",
    "maxRequests": 80,
    "timeoutMs": 120000
  }
}
```

`baseURL` 填 API 根地址，不要加末尾的 `/responses`。设置选项并登录：

```sh
magpie plugin options magpie-autocompact "$(cat examples/provider-options.json)"
magpie plugin login limited-compact
magpie models
```

登录时输入该上游的 API Key，由 Magpie 保存。正常请求和内部原生压缩请求使用实际选中的账号凭据，不需要在插件选项中重复配置密钥。

在客户端或 Magpie 的 Agent 设置里选择 `limited-compact/your-model-id`。客户端继续使用原来的 Magpie 地址；Magpie 自己负责转换客户端协议，上游 Provider 使用 Responses。显式配置模式下先配置再登录；未配置 `provider` 时默认注册带原生表单的 `autocompact` 供应商。

单个 `provider` 配置注册一个 Provider；`providers` 配置可以注册多个。表单模式可在 `autocompact` 下添加多个上游账号，模型可以有多个。使用新的供应商 ID；已有同名供应商时 Magpie 可能给插件供应商加 `-plugin` 后缀，实际名称以 `magpie models` 为准。原来的供应商配置仍可独立使用。顶层 `providers` 现在表示多个原生 Provider 的显式配置，不兼容旧 Middleware / Hook 的策略映射；`gatewayTimeoutMs` 等旧选项已移除。

## 阈值与压缩方式

| 选项 | 含义 |
| --- | --- |
| `maxMessages` | 本次有效上下文的消息 / Responses input item 数上限；包含工具调用及结果 |
| `maxTurns` | user 轮数上限；工具结果不作为新的 user 轮 |
| `keepTurns` | 希望保留的最近 user 轮数，默认 4；必要时缩小到能满足阈值的范围 |
| `maxRequests` | 服务端链 / conversation 的成功请求计数阈值；超限尝试重置链 |
| `mode` | `pack`（显式配置省略时默认）、`summary` 或 `responses`（表单默认） |
| `timeoutMs` | 包含等待会话锁、压缩和响应读取的请求总超时，默认 120000 ms |
| `stateDir` | 持久状态目录；默认 `$XDG_STATE_HOME/magpie-autocompact/<id>`，未设 XDG 时用 `~/.local/state/…` |
| `headers` | 可选的上游项目等固定请求头；Authorization 始终由当前登录账号提供 |

`maxMessages`、`maxTurns` 至少配置一个。两者同时配置时都要满足；系统 / developer 指令、原生 compaction 和工具 item 也占消息数。阈值应比供应商的硬限制低一些，预留当前工具循环和内部压缩的空间。尚未结束的工具调用不会被从结果中拆开；如果当前轮自身就超限，或无法找到安全的历史切点，请求按原样发送，由上游报告限制。

- **`pack`**：把可打包的旧历史序列化到保留的第一条 user 消息中，减少消息 / 轮数，不调用模型。它保留文本数据，**不会减少 token 数**。
- **`summary`**：调用指定的 Chat Completions 模型生成续聊摘要，再合并到保留的 user 消息中。摘要 API 错误、超时、截断、空摘要或摘要过长时退回 `pack`。
- **`responses`**：向当前登录账号的同一 Responses 端点发送历史前缀和 `{"type":"compaction_trigger"}`，使用返回的加密 compaction item 开新链。会补回历史中的系统 / developer 指令、动态工具声明和配置更新。上游不支持、返回无效结果或超时时退回安全的文本打包。

原生模式按用户提供的 `responses-suggestion.md` 所述显式触发，**不使用 `/responses/compact`**。需要你的供应商和模型实际支持 `compaction_trigger` 及其加密结果；这里的集成测试使用模拟上游，没有对任何真实付费供应商作兼容性承诺。已有不透明 / 多模态历史无法安全转成文本时，打包回退不会强行丢弃它们。

摘要模式示例，把下面字段放进 `provider`：

```json
{
  "mode": "summary",
  "summary": {
    "url": "https://summary.example/v1/chat/completions",
    "model": "small-model",
    "apiKeyEnv": "SUMMARY_API_KEY",
    "timeoutMs": 25000,
    "maxTokens": 2048,
    "maxInputChars": 200000
  }
}
```

摘要使用独立的凭据环境变量，不会把推理账号的密钥发送给摘要服务。确保变量存在于启动 Magpie 的环境中。原生模式可通过 `responses.timeoutMs`（默认 25000）和 `responses.maxInputChars`（默认 2000000）单独限制压缩调用；内部超时给实际推理保留回退时间。

模型还可以用对象配置别名及能力，沿用 Magpie / OpenCode 模型声明：

```json
{
  "models": {
    "coder": {
      "id": "actual-upstream-model-id",
      "name": "代码模型",
      "tool_call": true,
      "limit": { "context": 128000, "output": 16384 }
    }
  }
}
```

此时选择 `<provider-id>/coder`，原生压缩与推理都使用实际的上游模型 ID。

## 服务端会话

**`previous_response_id`**：当 Provider 收到该字段时，根据持久化响应快照取得有效历史。达到阈值后将压缩内容和当前输入发到新链，客户端继续拿到实际的新响应 ID。快照按响应 ID 保存，允许同一父响应分叉；JSON / SSE 中回显原先的 parent。未知或不属于当前账号的响应 ID 返回 409，避免把缺失历史当作空会话。

**Magpie 本身也会处理 previous ID。** 在实测的 Magpie 0.1.4695 中，已知 ID 会在进入插件前展开成完整历史，并移除 `previous_response_id`，Provider 此时按完整历史压缩。这条路径已做真实网关集成测试，客户端可以按 ID 续聊，但响应中的 parent 字段遵循 Magpie 的行为，可能为 null；插件无法恢复宿主没有传下来的原始字段。`maxRequests` 只对真正到达 Provider 的服务端链生效，Magpie 已展开的请求使用 `maxMessages` / `maxTurns`。示例同时配置这两个阈值，避免依赖请求计数。

**`conversation`**：Provider 从实际上游分页读取会话历史。达到阈值后创建影子 conversation，写入压缩后的保留历史，再发送当前输入；持久化映射将客户端原 ID 指向新会话。客户端的 conversation ID 在响应和 SSE 中保持不变。原会话的映射在推理成功后才提交，失败不会提前切换到缺少当前输入的影子会话。

会话管理路由如果由宿主送达 Provider 的 `fetch`，会使用同一映射；插件不会给 Magpie 新增 HTTP 路由。客户端的 conversation ID 应是该上游已有的会话 ID。上游的 `/conversations` 和 `/conversations/:id/items` 需要可用；历史列表展示的是压缩后的实际上下文，不是完整原始审计记录。

Provider 在返回成功 JSON / 发送终止 SSE 事件前完成状态落盘。流中断后，可以用已记录的 response ID 从上游恢复；如果请求可能已执行，但尚未取得 ID，会话返回 409，防止自动重复执行。`background:true` 暂不支持；`store:false` 且没有 conversation 的请求不保存可继续的响应链。

状态按供应商、上游端点和实际账号凭据 / 项目头隔离，不把客户端自报的 session 当作身份。目录权限 0700，记录与锁数据库为 0600，JSON 原子写入并 fsync。每个会话使用 SQLite 事务锁，在插件重载时允许新旧 Bun 宿主共享目录，进程退出会释放锁。使用本机文件系统；不要在活跃会话期间清理 `.locks` 文件。

状态含对话内容、摘要和加密上下文，不保存明文 API Key。当前不自动过期清理，应把目录保留到相关会话不再需要；改变上游或密钥后，旧响应链不跨账号恢复。原生加密内容不能在不同账号或不兼容模型之间迁移，使用这类会话时应在 Magpie 中将路由保持在同一兼容模型 / 账号。

## 开发与验证

```sh
npm test
npm run test:integration
npm pack --dry-run
```

单元测试使用 Node 22.13+ 的内置 SQLite；生产由 Magpie 的 Bun 使用内置 `bun:sqlite`，无 npm 运行时依赖、无构建步骤。集成测试使用已安装的 `magpie`，在临时 HOME / XDG 目录中安装、配置和登录插件，实际启动 Magpie + Bun，并连接本地模拟上游；不会修改正在使用的 Magpie 配置。

覆盖多个显式供应商及配置 key、密钥轮换、供应商顺序变更、启动时自动获取模型及失败重试、原生表单注册与验证、自动获取模型、凭据保存及账号配置隔离、完整历史压缩、工具调用边界、摘要回退、原生配置补回、账号隔离、响应分叉、previous ID、conversation 映射、JSON / SSE、流取消与恢复、跨进程锁和宿主重启。测试证明协议和状态管理行为；摘要质量及真实上游是否按预期重置轮数，需要以实际供应商验证。

主要文件：`autocompact.provider.js`（Provider 注册与登录）、`lib/session-transport.js`（Fetch 请求 / SSE / 会话控制）、`lib/session-store.js`（持久化与跨进程锁）、`lib/session-compaction.js`（三种压缩方式）、`lib/core.js`（计数与安全切点）。`responses-suggestion.md` 保留为用户提供的设计参考。

MIT License。
