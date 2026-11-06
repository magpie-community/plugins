# Changelog

本文件记录 fovea 的对外变化。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化版本。

## [0.2.5] — 2026-11-05

### Added

- 支持 Gemini 请求（`contents` 字段）：thought 与 thoughtSignature、functionCall 不动；functionResponse 保留 id / name / 键，其中的长字符串被裁；图片换成注记；文档与视频载荷不动。此前 Gemini 请求完全原样放行，装了也不省。

### Fixed

- `saccade: "auto"` 不再把 Claude Code 的 `<system-reminder>`（token 预算、工具指引）当成用户的新问题。它与任务没有共同词，旧规则判成换话题、整段历史折叠。
- Responses 请求的首个答案是 `custom_tool_call` / `computer_call` / `local_shell_call` 时，任务豁免范围算错，整条历史一条都不裁。
- Chat 旧版 functions API 的 `role: "function"` 消息此前完全没被处理，那正是最占钱的工具输出。

### Changed

- 新增 `fovea.protocols.test.mjs`：四种协议各自的形状与边界（Anthropic Messages、OpenAI Responses、Chat Completions、Gemini），12 条用例。

## [0.2.4] — 2026-11-05

### Fixed

- `state_marker` 只在 agent 自己写状态的位置生效：assistant 消息（Chat、Anthropic，或 Responses 的 message 项）中以标记开头的文本或文本块。工具结果、用户消息、嵌套的 tool_result 块、文本中间出现同样字样都不再算状态块——此前一条读到该字样的 Chat 工具结果或用户消息会永久免裁，并让任务原文失去保护（plugins#756）。
- 文件头注释与 README 不再说"带 `[fovea:` 标记的内容不再二次裁剪"（0.2.3 已去掉这一判断）。

## [0.2.3] — 2026-11-05

### Fixed

- `cut()` 不再以正文里出现 `[fovea:` 为依据跳过裁剪：不可信的工具输出或用户消息可以伪造这一字面串，使整块旧内容永久免裁。幂等性改由既有的 `head + tail + 80` 长度闸门保证；已裁内容在后续请求中仍逐字节稳定。新增 cases 与单元测试覆盖伪造标记及二次裁剪。

## [0.2.2] — 2026-11-04

### Fixed

- `saccade: "auto"` 的话题判定改用与任务豁免同一口径的「任务」：首条回答之前的前导 user 消息中的最后一条。Codex 形状下首条 user 是 AGENTS.md，旧规则拿它比对，于是同一任务的跟进被判成换话题、任务与工具输出整段折叠；反过来，真换题但碰巧与 AGENTS.md 同词时又不折叠。两向各有用例。

### Changed

- `live-benchmark.mjs` 不再随包发布（它会改写运行中 magpie 的插件选项），只留在仓库里。
- README 快速上手不再预设 `saccade: "auto"`，改为说明默认 `off` 适合带缓存的长工具循环，`auto` 的取舍写在旁边。

## [0.2.1] — 2026-11-03

### Fixed

- 旧图片换成注记时保留块的 `cache_control`——那是供应商缓存的一个断点，静默丢掉会少一个命中位（两模式均保留，有用例）。
- 任务豁免从「第一条 user 消息」改为「首条回答之前的整段前导」：Codex 形状下 AGENTS.md 与 environment_context 在任务之前，旧规则保护的是 AGENTS.md、裁的是真任务；新规则在首条 assistant 回复 / 工具调用 / reasoning 处截止。

## [0.2.0] — 2026-11-02

fovea 首个版本。前身是本仓的 `context-slim` 草稿（PR #467，已关闭），在[独立开发仓 webkubor/fovea](https://github.com/webkubor/fovea) 成型后回到这里；与该仓同源同版。

### Added

- `cut_step`：裁剪边界按块移动，块内已裁前缀逐字节稳定，供应商 prompt cache 可连续命中；不足一块不动。附连续两轮与跨块边界的回归测试。
- `saccade`（`off` / `auto` / `always`）：最新问题与首条任务词面重叠趋近零时，旧上下文折叠为一行 `[fovea: prior topic not carried]`；「继续」类短跟进不触发。
- `state_marker`：agent 自带结构化状态块的契约——带标记的消息在两种模式下都完整，且原始任务消息随之可裁。
- `protect` 正则在折叠模式下同样生效。
- Responses API `function_call_output` 的数组 `output` 与字符串形式对称处理，`call_id` 永不动。
- 证据体系：`benchmark.mjs`（同一请求前后对照、共同前缀占比、已裁前缀逐字稳定）、`live-benchmark.mjs`（同模型 ABBA 受控实测，退出恢复插件选项）、插件内证据页（零权限、不联网、不保存正文）。
- `keep_recent_tokens` 预算窗口；品牌资产（logo 双色 / banner）；`bun test` 27 例离线全绿。

### Changed

- 更名 `context-slim` → `fovea`，标记从 `[context-slim: …]` 改为 `[fovea: …]`；名字即机制——中央凹看得清、周边视野只剩轮廓，saccade 是视线跳向新目标。

### Fixed

- 早期草稿中 `cut_step` 把不足一块的历史量化到 0、从不裁剪的问题。
- `keep_recent_tokens` 走窗停在溢出消息上、恰好保护了预算本应放弃的巨型消息的问题（评审 §1 修复过程中发现）。
- 旧版 `isImage` 把 document 块当图片换成注记的问题；代理对在头尾两端的劈开问题。

## [0.1.0] — 2026-10-28

- 初版：旧工具输出与长文本留头尾，旧图换注记，消息条数/顺序/id/配对不变。
