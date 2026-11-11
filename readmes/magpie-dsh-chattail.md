<h1 align="center">🩹 Magpie DSH ChatTail</h1>

<p align="center">
  在 Magpie 网关层动态修复 MiniMax 等 Chat 上游 SSE 流截断缺失 <code>finish_reason</code> 的核心缺陷，彻底消除 DeepSeek Harness (DSH) 报 <code>Stream ended without finish_reason</code> 错误。
</p>

<p align="center">
  <a href="https://usemagpie.ai/"><img alt="Magpie Middleware" src="https://img.shields.io/badge/Magpie-Gateway_Middleware-111827?style=flat-square" /></a>
  <a href="https://github.com/yetone/magpie/issues/5289"><img alt="Issue Fix" src="https://img.shields.io/badge/Fix-Issue_%235289-008080?style=flat-square" /></a>
  <a href="https://github.com/deepseek-ai"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/Agent-DeepSeek_Harness-0284C7?style=flat-square" /></a>
  <a href="https://nodejs.org/"><img alt="Node / Bun" src="https://img.shields.io/badge/Runtime-moejs%20%2F%20Bun-3776AB?style=flat-square" /></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" /></a>
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="README_EN.md">English</a>
</p>

> [!IMPORTANT]
> **本插件专门解决当前版本 Magpie 接入 DeepSeek Harness (DSH) 时报 `Stream ended without finish_reason` 导致连续重试 5 次并最终丢失轮次的关键故障（对应 Magpie Issue [#5289](https://github.com/yetone/magpie/issues/5289)）。**
> 
> DSH 内部深度集成了 `pi-ai` 严格的 `openai-completions` 流解析器，要求流中必须包含有效的 `finish_reason` 终结帧，否则视为网络传输致命错误并抛出 `Stream ended without finish_reason`。在超长上下文与多工具调用的复杂场景下（如 MiniMax-M3.1-Flash 接 48 工具、360k–440k tokens），上游 Chat 接口在完整生成完工具调用参数后常直接切断 HTTP 连接，不吐出任何终止帧；而 Magpie 内置的 `chatTail` 补帧门控（`saysItsEnd`）仅放行了 Gemini 与 CommandCode，MiniMax 的截断被原样透传。本中间件在网关层实时监测 SSE 事件流，智能检测工具参数合法闭合与尾部帧，自动补齐 `finish_reason`，确保 DSH 100% 成功接管工具调用。

---

## 为什么需要它

| 对比维度 | 原生 Magpie + DeepSeek Harness | 启用 magpie-dsh-chattail |
| --- | --- | --- |
| **面向问题** | 上游 Chat 流生成完工具参数后静默断开，缺少 `finish_reason`，DSH 判定为传输崩溃并连续重试 5 次失败（Issue [#5289](https://github.com/yetone/magpie/issues/5289)） | 自动在流尾部或工具参数闭合帧智能注入 `finish_reason`，彻底解决断流报错 |
| **处理方法** | 只能降级模型、关停工具或苦等 Magpie 官方重构内部 `saysItsEnd` 门控 | 在轻量级微内核（moejs）微秒级拦截 SSE 事件，基于参数语法完整度与 Token 统计无感补帧 |
| **达到效果** | 单一会话内高频触发 `Stream ended without finish_reason`，Agent 丢失对话轮次 | 工具调用 100% 顺畅流转并执行，日志无报错，恢复平滑长上下文 Agentic 体验 |
| **运行时开销** | 无 | 单次事件处理耗时 **< 1 µs**，非终结帧原样直通零序列化开销，零网络往返延迟 |
| **交互控制** | 无法干预 | 提供 Magpie GUI 可视化选项面板，支持自定义目标模型列表与补帧模式 |

---

## 安装与启用

### 方式一：Magpie 客户端 GUI 安装（本地目录加载）

1. 打开 **Magpie 桌面应用**，进入左侧边栏的 **插件 (Plugins)**。
2. 切换至 **已安装 (Installed) → 添加插件 (Add Plugin)**。
3. 选择本插件所在的本地目录 `magpie-dsh-chattail`，点击添加并启用。

### 方式二：使用 Magpie CLI 安装

```bash
# 本地路径直接安装
/Applications/magpie.app/Contents/MacOS/magpie plugin add "/Users/midaxia/Documents/Projects/Codex Projects/magpie-addons/magpie-dsh-chattail"

# 或上架后通过 GitHub 规范安装
magpie plugin add github:MDX-Tom/magpie-dsh-chattail
```

---

## 配置选项

本插件支持直接在 **Magpie GUI 插件选项** 中进行可视化调整，无需修改任何代码文件。

### 1. 在 Magpie GUI 中修改

1. 进入 **插件 (Plugins) → 已安装 (Installed)**。
2. 找到 **DSH ChatTail Repair (`magpie-dsh-chattail`)**。
3. 点击右侧的 **选项 (Options)** 按钮。
4. 在弹出的 JSON 编辑框中按需配置（保存即刻在下一次请求生效）：

```json
{
  "enabled": true,
  "applyTo": ["minimax", "minimax-cn", "MiniMax"],
  "defaultFinishReason": "auto",
  "repairOnToolComplete": true,
  "repairUsageChunk": true,
  "repairEmptyDelta": true,
  "forceNonStream": false
}
```

### 2. 通过 Magpie CLI 修改

```bash
# 调整目标模型过滤列表
/Applications/magpie.app/Contents/MacOS/magpie plugin options magpie-dsh-chattail '{"applyTo": ["minimax", "minimax-cn", "qwen"]}'

# 暂时关闭插件
/Applications/magpie.app/Contents/MacOS/magpie plugin off magpie-dsh-chattail

# 恢复默认选项
/Applications/magpie.app/Contents/MacOS/magpie plugin options magpie-dsh-chattail off
```

### 参数详细说明

| 参数项 | 类型 | 默认值 | 作用说明 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | 是否启用本中间件。设为 `false` 则完全透传所有数据。 |
| `applyTo` | `string[]` | `["minimax", "minimax-cn", "MiniMax"]` | 目标模型名称过滤列表（不区分大小写，包含匹配）。 |
| `defaultFinishReason` | `string` | `"auto"` | 补帧使用的 finish_reason。`"auto"` 会在有工具调用时填 `"tool_calls"`，无工具时填 `"stop"`。也可显式指定。 |
| `repairOnToolComplete` | `boolean` | `true` | **核心策略**：当检测到工具调用的 JSON 参数刚好拼装完整闭合时，立即在当前帧注入 `finish_reason: "tool_calls"`。即使上游随后立刻掐断连接，DSH 也已持有终结标识。 |
| `repairUsageChunk` | `boolean` | `true` | 修复上游发出的仅带 `usage` 但不带 `finish_reason` 的末尾统计帧（补充 `choices[0].finish_reason`）。 |
| `repairEmptyDelta` | `boolean` | `true` | 修复上游发出的空增量帧（`{ delta: {} }`）缺失 `finish_reason` 的情形。 |
| `forceNonStream` | `boolean` | `false` | （可选备用）若设为 `true`，强制将上游请求转为非流式整段接收，彻底规避任何网络流式中断。 |

---

## 核心机制与原理剖析

### 1. DSH 的崩溃触发链
DSH（基于 `pi-ai` 引擎）解析 SSE 时的源码逻辑：
```typescript
const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
if (!choice) continue;
if (choice.finish_reason) { hasFinishReason = true; }
...
if ((compat.supportsFinishReason && !hasFinishReason) || output.stopReason === "pending")
    throw new Error("Stream ended without finish_reason");
```
当 MiniMax 等上游在长上下文中发送完最后一个工具参数后，直接断开 TCP 连接，既没有发送带 `finish_reason` 的 chunk，也没有发送 `data: [DONE]`。DSH 到达流末尾发现 `hasFinishReason === false`，直接抛错并判为不可恢复的运输层故障。

### 2. Magpie 内核的盲区
Magpie 自身在 `internal/gateway/gateway.go` 中虽然有补帧逻辑（`sniff.tail.finish()`），但前置门控 `saysItsEnd` 仅将 `geminiCompat` 和 `commandCodeHost` 视作合规断流，导致 MiniMax 等 Chat 上游被排除在外，流被原样关闭并不产生任何日志（记录为 200 / 错误空）。

### 3. 本插件的三重防御
1. **即时闭合修复 (`repairOnToolComplete`)**：追踪所有工具参数的 buffer 拼装，当检测到最后一个 `}` 且能被 `JSON.parse` 成功解析时，直接将 `finish_reason: "tool_calls"` 附在当前帧中随流输出。即使连接紧接着断开，DSH 也早已安全接收到完成标记。
2. **末尾统计帧修复 (`repairUsageChunk`)**：将 `{ usage: {...}, choices: [] }` 展开并安全填入 `finish_reason`。
3. **空增量尾帧修复 (`repairEmptyDelta`)**：拦截无有效内容的空帧并完成收尾。

---

## 本地验证与测试

本插件内置了严谨的单元测试套件，测试覆盖了参数闭合注入、Token 统计帧修复、模型匹配、配置开关及非流式修复：

```bash
cd magpie-dsh-chattail
npm test
```

测试执行结果：
```text
▶ magpie-dsh-chattail middleware
  ✔ Scenario 1: Tool call argument JSON completion (MiniMax cut repair)
  ✔ Scenario 2: Trailing usage chunk repair
  ✔ Scenario 3: Empty delta terminal chunk repair
  ✔ Scenario 4: Already complete stream & options bypass
  ✔ Scenario 5: onRequest and onProvider hooks
  ✔ Scenario 6: onResponse whole JSON repair
✔ magpie-dsh-chattail middleware (3.0ms)
ℹ tests 10, pass 10, fail 0
```

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
