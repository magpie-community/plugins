# output-strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现带 7 样式选择面板和本地计数的独立输出样式插件。

**Architecture:** `applyOutputStyles` 是唯一行为 interface；moejs 与 Bun adapters 共用。catalog 生成页面元数据，JSON 统计通过页面脚本发布。

**Tech Stack:** moejs-compatible JavaScript、Bun hooks、原生 HTML/CSS/JS、Bun test。

**Spec:** `docs/superpowers/specs/2026-11-03-output-strategy-design.md`

## Global Constraints

- 无 npm runtime dependencies、Node API/fetch 不得进入 moejs 文件。
- 全部样式默认关；异常 fail-open；不写请求或响应正文。
- 不改 compress-core 或 OmniRoute；不 commit、不 push、不发布。
- 生成物只有 `page/catalog.js` 与 `page/stats.js`，不手改。

## Review Focus

- 无 assistant/system 的请求也能按协议正确注入，不能改变消息含义。
- media、已注入、空配置和畸形 body 必须原样通过。
- 两个 adapters 不能重复注入；marker 保证幂等。
- 页面保存必须保留未编辑 options 键。
- 遥测进程重启后累计值不能归零，测试不能写真实配置目录。

### Task 1: 核心 catalog 与请求注入

**Files:** `catalog.js`、`apply.js`、`output-strategy.middleware.js`、`test/output-strategy.test.mjs`

**Interface:** `applyOutputStyles(body, options) -> { body, applied, skippedReason, appliedStyles, addedBytes }`。

- [ ] 写 interface 测试：默认关闭、单样式、组合顺序、幂等、media、Chat/Anthropic/Responses、异常输入。
- [ ] 从已核实的上游文本建立 catalog 和 PROVENANCE。
- [ ] 实现注入与 moejs adapter，运行 `bun test test/output-strategy.test.mjs`。

### Task 2: 本地遥测

**Files:** `observability.hooks.js`、`stats-writer.js`、`page-publish.js`、`test/stats.test.mjs`

**Interface:** `record(result)`、`flush(force)`、`snapshot()`、`statsPath()`。

- [ ] 用临时数据目录写失败用例：注入计数、跳过原因、重启合并、无正文。
- [ ] 实现原子写入和页面脚本发布，运行 stats 测试。

### Task 3: 选择面板

**Files:** `page/index.html`、`page/app.js`、`page/style.css`、`scripts/gen-page-catalog.mjs`、`page/catalog.js`、`test/page.test.mjs`

**Interface:** 页面读取 `magpie.options.get()` 和 `globalThis.__OUTPUT_STRATEGY_STATS__`，保存完整 options。

- [ ] 写目录一致性和保存流程测试。
- [ ] 实现 7 开关、统计区和保存反馈；生成页面目录并运行测试。

### Task 4: 集成与发布前验证

**Files:** `package.json`、`output-strategy.test.mjs`、`cases.json`、`README.md`、`PROVENANCE.json`、`LICENSES/`

- [ ] 运行完整 `bun test` 和共享 middleware cases。
- [ ] 用 stub DOM/浏览器检查渲染、开关保存和统计展示。
- [ ] 检查真实数据目录零污染、生成物一致、文件清单与许可证完整；不提交。
