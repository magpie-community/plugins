# Cursor 自动反馈插件

通过 magpie 网关使用 Cursor 订阅，在同一个 Cursor 原生 Run 内调用另一个模型做反馈，不弹出人工反馈窗口。客户端继续执行文件、终端等外部工具；反馈工具由 provider 插件内部执行。客户端不必安装新的 MCP 服务。

本插件通过 GitHub 分发，尚未发布 npm。Run 续接与官方计费会受模型、套餐和服务端状态影响，不保证无限续接或固定扣费；请以页面显示的官方账单记录为准。

图形界面使用 magpie 原生 `settings` 面板插槽，入口为「设置 → 插件」。不修改主程序，不声明独立页面或供应商菜单入口；兼容性取决于 magpie 保留该原生接口。

## 安装与选择

保留官方 Cursor 插件及其登录，本插件使用同一个 `cursor` provider id 和已有凭据。通过 magpie 的插件优先选择功能切换，避免两个实现同时服务它。

在 magpie「插件」中从 GitHub 安装：

```text
github:louiseliu/magpie-cursor-feedback
```

也可使用终端：

```sh
magpie plugin add github:louiseliu/magpie-cursor-feedback
magpie plugin use github:louiseliu/magpie-cursor-feedback cursor
```

安装后在「设置 → 插件 → Cursor 自动反馈」选择自动反馈模型并保存，在供应商页面确认 Cursor 已登录。首次配置完成前不会打开 Cursor Run。

将 `model` 替换为网关 `/v1/models` 中实际可用的非 Cursor 模型 ID，例如你已登录的 Codex/ChatGPT 模型。这里不预设某个账户有哪款模型。`baseURL` 必须指向实际网关的 API 地址；3425 是当前 magpie 的默认端口。

密钥是 **magpie 网关访问密钥**，不是 Cursor 或 Codex 登录令牌。默认从 **magpie 进程的环境变量** `MAGPIE_FEEDBACK_API_KEY` 读取；桌面启动的 magpie 不一定继承终端里的环境变量。也支持在 `feedback.apiKey` 中明确配置网关密钥，这会以明文保存在插件选项中。没有密钥时不发送 Authorization，是否允许由网关决定。

安装后进入 **设置 → 插件 → Cursor 自动反馈**，直接选择或填写自动反馈模型，修改反馈网关地址、超时和反馈次数上限，然后保存。页面保留其他现有选项和密钥；不显示或复制登录令牌。保存会重启插件宿主，运行中的 Run 会丢失，因此页面检测到活动 Run 时禁止保存，状态不可用时也禁止保存。应在任务之间修改。

Cursor 主模型由客户端的模型选择器决定，也可在「供应商 → Cursor」选择要暴露的模型。插件提供账号可用的非 Max 模型，不强制选择 Opus；要求 Max 的变体从模型列表中移除，请求端的 Max 拦截继续保留。模型目录为支持 thinking 开关的模型增加 `Think` 和 `非 Think` 两个明确选项；它们固定思考开关，推理强度另行选择。Opus 4.6 对应 `claude-opus-4-6@200k-thinking` 与 `claude-opus-4-6@200k-no-thinking`。原有模型 ID 保留。更换主模型或思考模式请开始新任务，不能跨模式复用原 Run。

页面下方每两秒更新本次宿主最近 32 个 Run：实际模型、owner 标识、状态、成功自动反馈次数和成功工具回包续接次数。两类继续执行都属于同一个 owner；反馈决策与回包次数分别显示。宿主退出或快照超过 10 秒时标为过期，不能作为当前运行证据。续接被拒绝会单独提示；状态里的 Run 数不等于官方计费 request 数。插件不会为观察状态额外发起模型生成。

设置面板沿用 magpie 的 sandbox 和 options bridge。运行模块将不含凭据、消息正文或反馈正文的有界状态原子写成 `page/live.js`，页面只加载自身目录的脚本，不开放网络权限或新增监听端口。模型候选项通过配置的反馈网关 `/models` 每 30 秒读取；失败保留旧列表并提示，可手填模型 ID。状态历史不跨宿主重启保留，也不保证记录宿主停止前最后一瞬间的变化。

回退到官方插件：在 Plugins 页为官方 Cursor 插件选择 “Use for Cursor”，或执行：

```sh
magpie plugin use @magpie-community/opencode-cursor-auth cursor
```

## 选项与行为

本插件用于普通 request 计费路径，禁止 Max Mode：目录中要求 Max 的变体会在打开 Run 前被拒绝，上游返回 `Max Mode Required` 时也不会自动切换到 Max 重试。Opus 4.6 测试使用 `cursor/claude-opus-4-6@200k`；`@1m` 是 Max 变体，不可用于这项测试。日志的 `run-opened` 会记录实际模型、`maxMode`、会话与原生 owner 标识。

| 选项 | 默认值 | 行为 |
| --- | --- | --- |
| `feedback.model` | 必填 | 反馈模型的网关 ID，不能路由回 Cursor；反馈请求不带工具。 |
| `feedback.baseURL` | `http://127.0.0.1:3425/v1` | OpenAI Chat Completions API 根地址。 |
| `feedback.apiKeyEnv` | `MAGPIE_FEEDBACK_API_KEY` | 读取网关密钥的环境变量名。 |
| `feedback.apiKey` | 未设置 | 显式密钥，优先于环境变量。 |
| `feedback.timeoutSeconds` | `60` | 每次反馈请求最多等待的秒数，1–120。超时不自动重试。 |
| `feedback.maxRounds` | `64` | 每个 Run 最多请求多少次反馈；达到后要求主模型总结并停止。 |
| `maxRunSeconds` | `0` | 0 取消插件本地的绝对寿命限制；正数设置上限，最多 86400 秒。 |
| `toolWaitSeconds` | `1800` | 等待客户端工具结果的最长时间，保留有限的空闲期限。 |
| `allowRebuild` | `false` | 会话丢失或历史不兼容时，默认返回 409，不静默新开 Run。设为 true 才允许用客户端历史重新建立原生 Run。 |

插件注入 `automatic_feedback(summary)` 和调用指令，提示主模型在准备结束或需要下一步决策时调用。反馈模型看到原始任务、最近用户输入、最近消息、当前摘要及最近四次反馈；它不直接访问磁盘，也不会自行执行客户端工具。主模型仍可能不遵循工具调用指令：若 Cursor 已发送终止消息，插件不会假装还能续接这个已结束的 Run。

客户端明确关闭/指定工具（`tool_choice`），或请求固定输出格式（`response_format`）时，不注入额外工具或指令，按原请求执行；自动反馈只用于允许自动选择工具的请求。

也兼容客户端已有的 `interactive_feedback` 以及常见的 `mcp__mcp-feedback-enhanced__interactive_feedback` / `mcp_feedback_enhanced_interactive_feedback` 名称：这些调用在同一 Run 中由模型回答，不交给客户端启动弹窗。若客户端把 MCP 服务器改成了其他名字，应使用新注入的 `automatic_feedback`。这里复用原项目的工具反馈机制，不启动或控制它的 Python/Web UI。

反馈结果只有 `continue`、`complete`、`needs_user`。它不能替用户授权；完成、缺少信息或预算耗尽后要求主模型停止，反复调用会报错。反馈失败、取消、协议错误或不确定的结果写入均不会由插件自动重放。

已有的每 5 秒 Run 心跳和每 3 秒未完成工具心跳继续使用。没有本地绝对寿命限制仍不代表无限运行：Cursor 服务端断线、客户端取消/压缩/改写历史、上下文满、插件重启，以及保留内存与并发上限都会影响续接。保留现有 8 个 Run/账号、32 个 Run/进程及 blob/输出内存限制。只有同一宿主、账号、会话标识、模型/工具/控制参数和兼容历史才能原地续接。

**不要把本插件放在会自动换模型、账号或 provider 的路由组后面来验证省 request。** 插件会把失败转为 409，减少网关自动重试，但不能控制客户端主动重试、重新发送用户回合或调用另一条路由。新用户回合本来就会打开新 Run。

DeepSeek Harness 在工具结果后追加的固定格式时间快照属于当前步骤。插件先校验原工具批次和历史，再把时间原文作为标注清楚的上下文附在该批次的工具结果中，通过原连接回传；客户端历史保持原样，下一步仍校验完整历史。日志 `time-context-resumed` 记录原 owner。重复回传不会重复写入；原 owner 丢失时按 `allowRebuild: false` 拒绝，不把时钟通知当成新的用户任务。真正的新用户回合仍按新请求处理。

## 单 Agent 执行

插件在请求边界移除 DeepSeek Harness 的 `subagent`、`subagent_fork`、`workflow` 和 `send_message` 工具，防止创建、委派或重新启动子 Agent；显式强制调用这些工具会在开 Run 前被拒绝。读写文件、终端、目标管理和停止已有子 Agent 的工具保留。主模型收到单 Agent 执行指令，不应通过终端或嵌套模型客户端绕过限制。该策略只作用于本插件，不要求修改 Harness，也不替其他供应商禁用子 Agent。

已有子 Agent 不会被追溯取消。加载此变更需要新插件宿主；任务进行中不要重启宿主或切换原 Run 的工具列表。

## DeepSeek Harness 上下文压缩

工具结果、自动反馈和原生压缩在同一个 Cursor Run 与连接中继续。插件读取 Cursor 检查点的真实 `used_tokens/max_tokens`；达到 80% 且反馈决策为 `continue` 时，在现有连接排入 `SummarizeAction` 和带原工具定义的 `ResumeAction`。反馈要求主模型暂时结束当前阶段，Cursor 压缩完成后自动继续任务。`complete` 与 `needs_user` 不触发压缩。没有用量检查点时，不凭客户端历史长度假定原生上下文已满；Cursor 自身的自动压缩仍可运行。

日志中的 `compaction-queued`、`compaction-completed` 使用同一个 owner。失败或未确认压缩完成就终止时返回错误，不自动重建。原生压缩不调用 Harness 的摘要模型。DeepSeek Harness 标准模式保持 `compaction-basic.config.auto: false`、关闭独立工具结果裁剪，并保持 `allowRebuild: false`，避免客户端改写原历史。手动 Harness 压缩检查点仍被拒绝，原 Run 保留给原历史续接。

2026-11-12 的原生实测：一个 Run、一次连接绑定，压缩前后两次工具回传、两次反馈（continue → complete），压缩后工具执行成功。官方用量为一条事件、`requestsCosts=2`，与同模型不压缩对照一致。这是本次观测，不把同一个 Run 或网络连接等同于所有套餐永久固定计费。

## 观察是否复用

插件宿主日志包含 `run-opened`（新 Run 的原因）和 `decision`（反馈模型、轮次和动作），不写密钥或反馈正文。插件直接返回的响应头包括：

- `X-Magpie-Cursor-Continuity`：是否使用原生 Run，或因为什么拒绝续接。
- `X-Magpie-Cursor-Runs-Opened`：这次客户端调用新开的 Run 数；工具结果续接通常为 0。
- `X-Magpie-Cursor-Rebuild-Reason`：允许重建时的原因。

magpie 的协议转换不保证把这些自定义头传给最终客户端；以宿主日志和 Cursor 用量记录交叉核对，不能只看聊天 ID。

异常结束还会记录 `run-ended`，包含 owner、状态、错误原因和存活毫秒数，用于区分上游断线与本地保留期限。已结束的上游 Run 不会因为调大本地期限而恢复。

## Cursor 官方 request 用量

每个更新后创建的 Run 在打开上游连接前，先读取 Cursor 官方 `GetAggregatedUsageEvents` 的当日累计 request 值作为账户基线。基线最多等待 5 秒；失败不会阻止任务，但开始前用量标为未知。后台保留原账户与代理上下文，读取同一统计区间的累计值和 `GetFilteredUsageEvents`，每 15 秒核对，任务结束后最多继续 10 分钟。

页面区分账户前后差值（含其他并发任务和 token 折算）与本任务按次扣费：后者用实际发送给 Cursor 的 conversation ID、Run 开始时间和官方 usageEventId 匹配，只合计明确为 `isTokenBasedCall=false` 的 `requestsCosts`。每次以完整快照替换，不把轮询结果累加；同一条记录金额更新会反映在页面。首次入账时的反馈次数和扣费值也被保留，用于比较后续变化。包含 token 计费时明确标识，不能用于按次扣费验证。

没有匹配记录显示待确认。字段缺失、读取失败、分页重叠或超出 1000 条上限等不完整结果不会当成零；保留上次成功读取值并标注时间与错误。结束后读到的值仍可能被官方延迟入账修正，因此页面不宣称最终结算或保证未来不增加。已有任务无法补出开始前快照，记录与 Run 状态一样仅保留本次宿主的最近 32 个任务。所有后台账单请求只读，不创建模型 Run。

## 验证

在仓库根目录使用 Bun 1.4.2 运行：

```sh
bun test .
```

所有测试只用合成凭据和本机模拟服务，拒绝访问外网。包含HTTP/2 / HTTP/1.1 原生协议、内部反馈、外部工具、并行混合调用、重复请求、流式输出、超过旧 15 分钟期限的时钟模拟、失去会话时拒绝重建，以及反馈失败与取消。时钟模拟不是 16 分钟的真实 Cursor 连通性试验。

上游 `native-e2e` 的后台 checkpoint 测试原本假定 checkpoint 已随工具回包到达，在当前机器稳定失败；本副本改为等待 checkpoint 到达并由测试明确释放后续 blob，避免用延时猜测网络顺序。

`vendor/` 固定于 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的提交 `f0bd94c4e2df122e9652c827b5e3a47523e01ae3`（MIT）。只调整了运行时注入、独立会话池、可选寿命限制、内部反馈及测试夹具；原生鉴权、模型发现、传输和 usage 编码沿用其实现。本插件不修改 magpie 主程序、内置迁移版本或其他已安装插件。
