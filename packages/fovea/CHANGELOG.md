# Changelog

本文件记录 fovea 的对外变化。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化版本。

## [0.2.0] — 2026-11-02

首个独立仓版本。前身是 magpie-community/plugins 中的 `context-slim` 草稿（PR #467，已关闭并迁移至此），yetone 的评审直接塑造了本版的缓存边界、document 与代理对处理。

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
