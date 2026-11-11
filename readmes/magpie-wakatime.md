# magpie-wakatime

把本机 Magpie 网关记录的 AI 请求用量同步成 WakaTime heartbeats。插件跑在 Magpie 自带的 Bun 插件宿主里，从本机用量接口读取统计，通过请求钩子识别项目和分支，不改写 agent 配置或请求内容。

## 安装

```
magpie plugin add <本目录路径>
```

安装、开关、更新插件都会让 Magpie 重启插件宿主，所以本地文件夹插件总是按当前代码加载。首次添加插件时 Magpie 会下载 Bun，之后所有插件共用它。

## 登录

在应用里打开 插件 → 添加插件，填入本目录路径，然后在 `wakatime` 那一行填入 WakaTime API key（在 [wakatime.com/settings/api-key](https://wakatime.com/settings/api-key) 生成）。终端里等价的做法：

```
magpie plugin login wakatime
```

key 由 Magpie 存到配置目录下的 `plugin-auth.json`，插件只读取这份文件。不登录时也可以改用下面的环境变量或 `.wakatime.cfg`。

这个供应商只用来接收 key，没有模型，不会出现在 agent 的模型列表里；插件也不通过它转发任何请求。

## 配置

用 `magpie plugin options <name> '<json>'` 设置，全部可选：

- `gatewayUrl`：默认 `http://127.0.0.1:3425`。只接受本机回环地址，端口可改。
- `authAccount`：绑定 `plugin-auth.json` 中的 WakaTime 账号 ID，例如 `wakatime` 或 `wakatime#xxxxxx`。默认仅在只有一个可用账号时自动选择。
- `apiKeyEnv`：默认 `WAKATIME_API_KEY`。插件读取这个环境变量的值作为 WakaTime 写入密钥。
- `project`：默认 `Magpie`。无法识别真实项目时使用的归档名。
- `projectByAgent`：按 agent id 强制覆盖项目标签，优先于自动识别，例如 `{"codex":"Work"}`。
- `excludeAgents`：排除某些 agent，用于避开已由其他 WakaTime 集成采集的部分。
- `languageByDirectory`：按工作目录显式指定语言，例如 `{"/path/to/MyApp":"Swift"}`。只接受绝对目录和扩展名表支持的语言名；最长匹配优先，适用于非 Git 项目、混合仓库或自动识别不合适的目录。目录规则先于文件识别。

写入密钥按顺序取：登录时填写的 key、`apiKeyEnv` 指定的环境变量、`WAKATIME_HOME`（默认用户目录）下 `.wakatime.cfg` 的 `[settings] api_key`。插件只读这些来源，不修改它们。缺少密钥时只记录状态，不开始采集，也不确定首次启用时间。

[Magpie 的多账号机制](https://usemagpie.ai/docs/plugins#accounts)可能把更换后的密钥保存为新的 `wakatime#…` 账号。存在多个可用账号且未绑定时，`status.credentials` 显示 `key-account-ambiguous` 并暂停采集和上传；请用 `magpie plugin options magpie-wakatime '{"authAccount":"wakatime#xxxxxx"}'` 绑定新账号（替换为实际 ID，并保留已有选项）。绑定账号被删除或密钥为空时显示 `key-account-missing`，不会切换到其他账号或密钥来源。每次同步都会重新读取绑定账号的密钥，密钥更新后会恢复上传。

## 会发送什么

每条有实际 token 消耗的请求记录生成一个 heartbeat：

- `entity` 是发起这次请求的 agent 名（例如 `codex`，取不到时用 `magpie`），`type` 是 `app`，`category` 是 `ai coding`，`is_write` 为 `false`。WakaTime 的应用/实体维度因此会把各个 agent 分开。
- `time` 用请求发生时间。`project` 优先使用 `projectByAgent`，其次使用请求工作目录对应的 Git 仓库名，非 Git 目录使用目录名，最后回退到 `project`。Git worktree 使用原仓库名；`branch` 是请求发生时的分支名，无法识别或处于 detached HEAD 时省略。
- `language` 由请求工作目录下 Git 已跟踪及未跟踪但未被忽略的文件名推断，取文件数最多的编程语言（例如 `TypeScript`）；配置了 `languageByDirectory` 时使用最长匹配的目录语言。Pods、Carthage、`.build`、DerivedData 等依赖和构建目录、生成文件以及 `Package.swift` 不参与统计；头文件不能单独判断 C、C++ 或 Objective-C，因此不参与投票。平票或无法推断时省略该字段，WakaTime 会把它归入 `Other`。识别结果按目录缓存：识别成功 60 秒、无结果 10 秒、扫描失败 5 秒，过期后由下一次请求刷新。
- `ai_input_tokens` = `in + cache_write`（未命中缓存的输入加缓存写入），`ai_cached_input_tokens` = `cache_read`（为 0 时省略），`ai_output_tokens` = `out`。WakaTime 按未命中缓存的输入、缓存输入、输出三项分别计价，所以缓存读取单独上报。`reasoning` 是 `out` 的内部拆分，不重复相加。
- `ai_session` 是本机随机盐加 agent/session 的 HMAC 摘要，同一会话稳定、跨机器不可还原。
- `user_agent` 携带模型名称、版本和 `effort` 推理强度，优先使用实际响应模型 `served`，缺失时使用 `model`。格式沿用 [WakaTime CLI](https://github.com/wakatime/wakatime-cli/blob/develop/pkg/ai/ai.go)，例如 `gpt/5.4-high`。DeepSeek 的无版本别名也保留模型身份，例如 `deepseek-flash` 配合 `max` 上报为 `deepseek/flash-max`；`deepseek-r1` 上报为 `deepseek/r1`，只有家族名时使用 `deepseek/unknown`，不推断具体发布版本。其他无法解析版本的名称只发送通用标识。推理强度在模型解析后追加，同一批次的模型信息逐条保留，WakaTime 是否识别及如何展示取决于其服务端支持。
- 请求头 `X-Machine-Name` 携带经过 URL 编码的本机主机名，`Timezone` 携带系统 IANA 时区。User-Agent 同时包含系统名、内核版本和架构，Windows 使用 WakaTime CLI 的 `windows` 标识。

项目识别使用 [Magpie 异步请求钩子](https://usemagpie.ai/docs/plugins#asynchronous-gateway-hooks)提供的 `cwd`，通过客户端响应 `response_id` 精确关联用量，处理宿主标记为 `local` 或 `magpie-key` 的本机请求。旧版宿主、缺少工作目录、通过命名网关密钥转发的请求，或未收到完成通知时，使用配置的项目标签并省略分支和语言。已有历史记录不会按当前工作目录、分支或语言补填。Git 命令只读且有超时；Git 不可用时使用工作目录名。语言推断只读取 Git 已跟踪及未被忽略的未跟踪文件名，不读取文件内容；非 Git 目录可用 `languageByDirectory` 指定语言。

这些是后台 AI 请求的活动时间点，只能说明当时有请求，不能证明你在键盘前；时长由 WakaTime 按自己的规则计算。

## 不会发送什么

账号名、邮箱、密钥、提示词、对话正文、工具结果、完整文件路径、供应商配置名、上游地址、费用和错误正文都不会离开本机。项目名、分支名、语言名、机器名、系统信息、时区和 agent 名会发送给 WakaTime。本地状态库保存归一化统计、摘要、队列和项目/分支/语言快照，不保存工作目录、原始响应 ID 或对话内容。

## 与现有 WakaTime 采集的重复

WakaTime CLI 自己会从 Claude、Codex、Cursor 等会话文件采集 AI 活动，和本插件有重叠，服务端不保证跨来源自动去重。两种用法：

1. 保留现有采集，用 `excludeAgents` 排除重叠的 agent；
2. 在既有 WakaTime 配置里设 `sync_ai_disabled=true`，把 AI 用量交给本插件，代价是失去既有集成的文件级 AI 信息。

插件不会自动改这个全局设置，人工编辑活动仍由原编辑器插件负责。

## 状态与预览

在插件目录下运行：

```
bun src/sync.mjs status  [--directory <Magpie 配置目录>]
bun src/sync.mjs preview [--directory <Magpie 配置目录>] [--limit 5]
bun src/sync.mjs language [--cwd <工作目录>]
```

发布到 npm 后，同名的 `magpie-wakatime` 命令等价。

`status` 显示队列数量、扫描进度、最后确认时间和错误类别；`preview` 打印脱敏后的待发送映射，不访问 WakaTime。状态库在 `<Magpie 配置目录>/magpie-wakatime/state.sqlite`。

`language` 只按当前目录的文件规则显示语言、来源、候选计数和未识别原因，默认使用当前工作目录；它不读取插件选项，因此不包含 `languageByDirectory` 覆盖，也不写入状态库或上传。要检查实际队列中的语言，使用 `preview`。

单条记录的时间或 token 数据无效时跳过该条，继续采集。`status.lastInvalidRow` 保留最近一次异常的日期、分页偏移、加盐摘要 ID 和错误类别，不保存原始内容；记录修正后可在后续复查中重新采集。整页响应格式错误仍会停止并保留游标，等待接口恢复。

## 采集范围与限制

- 只读本机网关的 `through` 记录，不采集直连（direct）、其他机器或导入（reported）的记录。
- 首次启用时间之后才开始采集，不自动回灌安装前的历史；停机后逐日补读，并每 10 分钟复查前两天，更早的补录不保证。
- 待发送队列上限 100,000 条，达到上限停止推进扫描进度并显示积压。已发送和永久拒绝记录保留用于去重，不计入此上限。
- 上传走 WakaTime 的 `heartbeats.bulk`，每批 25 条；网络错误、429、5xx 按 5 秒到 5 分钟退避，`401/403` 停止发送等你修密钥。
- 被 WakaTime 永久拒绝（4xx）的条目进入隔离状态，不阻塞后续记录；待发送记录在再次扫描时更新 token、模型和项目/分支信息，已发送记录的事后修正只记为差异，不重发整条统计。
- 仅适用于本机个人网关。多人共用同一个网关时不能直接当多人统计使用。

## 卸载

```
magpie plugin rm <name>
```

卸载或禁用后上传任务退出，本地队列保留，重新启用会继续处理。已经上传到 WakaTime 的 heartbeat 不会随卸载删除。

## 开发

```
bun test
```
