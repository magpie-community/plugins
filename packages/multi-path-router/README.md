# @magpie-community/middleware-multi-path-router

Three-dimensional orthogonal multi-path token router for [magpie](https://usemagpie.ai). Routes multi-agent workloads dynamically across **Payload Modality & Scale (X)**, **Cognitive Reasoning Depth & Benchmark Profile (Y)**, and **Economic Scarcity & Quota Arbitrage (Z)** using System One decision discriminators (StartLux-Decision, Jev, or local classifiers) and zero-cost physical constraint gates.

---

## 1. The Core Problem: Why 1D Model Ladders Fail

In modern multi-agent systems (e.g. Claude Code, Codex, OpenClaw, DSH, Hermes), agents invoke models with vastly differing operational characteristics:
- An ultra-fast flash model has millisecond latency for simple syntax checks, but fails on architectural trade-offs or corrupts tool arguments.
- A frontier reasoning model achieves high pass rates on complex proofs, but exhausts scarce quotas and induces multi-second latency when assigned routine inner-loop tool turns.
- A local vision-capable model incurs zero marginal cost for visual inspection, but lacks deep analytical context.
- A high-context model digests 500k tokens cleanly, but carries significant per-call overhead for short prompts, while models with nominal $128\text{k}/1\text{M}$ windows suffer catastrophic attention decay ("Lost-in-the-Middle") beyond $32\text{k}$.

These properties cannot be sorted into a simple 1D priority ladder. **They exist in an orthogonal three-dimensional space.**

---

## 2. The 3D Orthogonal Capability Space

```
                 ▲ Y: Cognitive Depth & 2026 Benchmark Profile
                 │    (SWE-bench Verified >65%, Multi-SWE-bench, GPQA Diamond, LCB Rolling)
                 │
                 │   [Tier: Frontier Reasoning]
                 │   (Complex architecture, formal proofs, tricky multi-file root-causing)
                 │
                 │              [Tier: Balanced Synthesis]
                 │              (Feature code, technical reviews, doc drafting, IFEval >85%)
                 │
                 │                         [Tier: Fast Reflex & Tool Loops]
                 │                         (TTFT <300ms, TPS >120, BFCL Tool-Call Accuracy >85%)
                 └──────────────────────────────────────────────────────────► X: Modality & Physical Scale
                /                                                             (Images via MMMU-Pro,
               /                                                               Effective Context via RULER)
              /   [Tier: Zero-Cost / Off-Peak Arbitrage]
             /    (Local clusters, discounted time-windows)
            ▼ Z: Economic Scarcity & Quota Watermark
```

---

## 3. Objective 2026 Benchmark Coordinates: Overcoming Metric Saturation

To prevent benchmark saturation (e.g., MT-Bench distillation inflation, AIME 2024 post-training contamination, nominal context illusions), the router classifies capability tiers strictly by **contamination-resistant, peer-reviewed benchmarks**:

| Capability Tier | Architectural Purpose | Objective Admission Benchmark (2026 Standards) | Core Evaluation & Anti-Saturation Mechanism |
| :--- | :--- | :--- | :--- |
| **`tier-frontier-reasoning`** | Strategic planning, system architecture, formal verification, multi-file causal debugging | • **SWE-bench Verified ($>65\%$)**<br>• **Multi-SWE-bench** (Polyglot: C++/Rust/Go)<br>• **GPQA Diamond ($>65\%$)** / **HLE (Humanity's Last Exam)**<br>• **LiveCodeBench (Rolling Window)** / **ARC-AGI** | Rigorous evaluation of multi-file causal tracking, PhD-level scientific reasoning, and dynamic algorithm synthesis against data contamination. |
| **`tier-balanced-synthesis`** | Standard feature implementation, PR synthesis, technical survey drafting | • **Arena-Hard-Auto v2.0**<br>• **IFEval (Instruction Following, $>85\%$)**<br>• **Aider Polyglot Benchmark** | Replaces saturated MT-Bench. Guarantees strict negative constraint following, clean AST diff generation, and high ROI for daily engineering. |
| **`tier-extended-context`** | Multi-file whole-repo comprehension, literature synthesis, full trace analysis | • **RULER** (Effective context $\ge 128\text{k}$, $\ge 80\%$ baseline retention)<br>• **LongBench v2** / **NoCha**<br>• **Michelangelo** (Repo-level multi-hop NIAH) | Punctures vendor "nominal context window" illusions. Mandates genuine cross-file multi-hop retrieval and reasoning without attention collapse. |
| **`tier-multimodal-runtime`** | Architecture diagram reverse engineering, UI verification, screenshot debugging | • **MMMU-Pro** (Vision-dependent, no text-guessing)<br>• **ChartQA / DocVQA** (High-res topology & chart parsing)<br>• **ScreenSpot / OSWorld** (GUI grounding) | Enforces precise visual coordinate localization, complex schematic comprehension, and multimodal tool-use reliability. |
| **`tier-fast-reflex`** | Sub-second test cycles, git commit summaries, interactive agent inner-loop tool calls | • **Physical Gates**: TTFT $<300\text{ms}$, TPS $>120\text{ tok/s}$<br>• **Quality Floor**: **BFCL (Berkeley Function Calling Leaderboard)** AST accuracy $>85\%$ | **Dual-Gate constraint**: Speed alone is insufficient. Strictly enforces zero-hallucination JSON schema following and tool argument parsing during rapid loops. |

---

## 4. Architectural Rules & Cognitive Escalation

### A. The 2D Escalation Policy (`effort=auto` $\times$ Tier Escalation)
When Magpie pairs with a System One decision discriminator (e.g. StartLux-Decision 27B-AutoThink, Jev, or local classifiers), it queries both scenario intent and cognitive difficulty (`low`, `medium`, `high`, `xhigh`).

To resolve the trade-off between reasoning token budgets and model tiers, this router enforces the **Tier Escalation Policy**:
- **Within-Tier Modulation (`low`, `medium`, `high`)**: When a task lands in `tier-balanced-synthesis`, the discriminator modulates the downstream reasoning budget dynamically (e.g. adjusting `reasoning_effort` or thinking token caps).
- **Cross-Tier Escalation (`xhigh`)**: If the discriminator grades a problem as `xhigh` (delicate race condition, distributed consensus design, non-trivial formal proof), the request **automatically escalates to `tier-frontier-reasoning`**, overriding default scenario boundaries.

### B. Effective Context Gating (Rejecting Nominal Limits)
When evaluating the context scale gate (`tokens >= 64k` or `100k`):
- The router intercepts payload sizes before execution.
- Only models that pass **RULER $\ge 128\text{k}$ with $\ge 80\%$ baseline performance** are eligible for admission into `tier-extended-context`. Models with nominal $128\text{k}$ windows that decay past $32\text{k}$ are relegated to the balanced tier.

### C. Zero-Cost Physical Short-Circuit
Before invoking semantic discriminators:
1. **Modality Gate**: Inbound payloads are scanned for visual blocks (`image`, `image_url`, `inlineData`). Image-bearing turns short-circuit directly to `tier-multimodal-runtime`, saving discriminator tokens and preventing text-only models from throwing parsing errors.
2. **Time-Window Arbitrage (Z-Axis)**: During off-peak windows (e.g. DeepSeek CST off-peak: weekdays 12-14, 18-09, and full weekends), eligible heavy workloads dynamically route to discounted high-performance models (Reasoner / V3) for massive cost savings.

---

## 5. Architecture & Topology (Sankey Flow)

```
[ Inbound Workload (Agent / IDE / CLI) ]
         │
         ├── [Physical Gate] Has Image Payload? ──────────→ group/tier-multimodal-runtime
         ├── [Physical Gate] Tokens >= 64k (Effective)? ──→ group/tier-extended-context
         ├── [Schedule Gate] Off-Peak Window Active? ─────→ group/tier-dynamic-value
         │
         └── [Semantic Gate via System One Discriminator]
                 │
                 ├── Effort == 'xhigh' OR Intent: Architecture ─→ group/tier-frontier-reasoning
                 ├── Intent: Long Synthesis / Literature ───────→ group/tier-balanced-synthesis
                 └── Intent: None of these (Default) ──────────→ group/tier-fast-reflex
```

> **Interactive Visualization**: Open `sankey.html` in any browser for a dark-mode interactive view of the 4-stage pipeline.

---

## 6. Zero Configuration Drift: Onboarding New Foundation Models

When a new foundation model is released, **no routing rules or middleware code need to be modified**:
1. **Inspect Benchmark Profile**: Look up its scores on SWE-bench Verified, Multi-SWE-bench, RULER, MMMU-Pro, or BFCL.
2. **Assign to Capability Group**: Add the model to the matching Magpie group:
   ```bash
   magpie group set tier-frontier-reasoning models+=provider/new-frontier-model
   ```
3. **Instant Production Generalization**: The router immediately routes matching workloads to the new model based on objective criteria, with zero downtime.

---

## 7. Installation & Configuration

### Installation
Install via Magpie's **Plugins › Discover**, or via CLI:
```bash
magpie plugin add @magpie-community/middleware-multi-path-router
```

### Options Configuration
Set options via Web UI (**Plugins › Installed › Options**) or CLI:
```bash
magpie plugin options multi-path-router '{
  "schedule": {
    "cst_deepseek_offpeak": true,
    "offpeak_mapping": {
      "smart-router": "group/tier-dynamic-value"
    }
  },
  "constraints": {
    "vision": "group/tier-multimodal-runtime",
    "tokens_gte": {
      "threshold": 64000,
      "target": "group/tier-extended-context"
    }
  },
  "mapping": {
    "smart-router": "group/tier-fast-reflex"
  }
}'
```

### Options Specification

| Option | Type | Description |
|---|---|---|
| `constraints.vision` | `string` | Target model/group for requests carrying image payloads. |
| `constraints.tokens_gte` | `object` | `{ threshold, target }`: routes requests exceeding estimated context token count. |
| `schedule.cst_deepseek_offpeak` | `boolean` | Activates time-window price arbitrage (Mon-Fri 12-14, 18-09, and weekends CST). |
| `schedule.offpeak_mapping` | `object` | Model/group mapping applied dynamically during off-peak windows. |
| `mapping` | `object` | Baseline routing map applied when no constraint or off-peak rule triggers. |
| `keep_upstream_name` | `boolean` | When `true`, replies retain upstream physical model names; when `false` (default), replies preserve client-requested alias (e.g. `smart-router`). |

---

## 8. Universal Deployment Recipe with Native Magpie Groups

Follow these steps to instantiate the complete 3D routing cluster on any Magpie instance:

```bash
# 1. Register Decision Discriminator (StartLux-Decision / Jev System One)
magpie provider add typesafe-jev decide=https://api.bamboonode.dev/v1 key=<YOUR_KEY>

# 2. Construct Abstract Capability Tiers (Aligned with 2026 Benchmarks)
# Frontier Reasoning: Top SWE-bench Verified (>65%) & Multi-SWE-bench models (Order strategy for failover)
magpie group add tier-frontier-reasoning models=<YOUR_FRONTIER_MODELS> routing=order

# Dynamic Value: Off-peak discounted or high-efficiency models (DeepSeek Reasoner / V3)
magpie group add tier-dynamic-value models=<YOUR_VALUE_MODELS> routing=order

# Multimodal Runtime: MMMU-Pro / ScreenSpot capable vision models
magpie group add tier-multimodal-runtime models=<YOUR_VISION_MODELS> routing=order

# Extended Context: RULER >= 128k effective context models
magpie group add tier-extended-context models=<YOUR_LONG_CTX_MODELS> routing=smart

# Fast Reflex: TTFT <300ms, TPS >120, BFCL >85% models for rapid tool turns
magpie group add tier-fast-reflex models=<YOUR_FLASH_MODELS> routing=smart

# 3. Create Root Router Group with Adaptive Semantic Rules
magpie group add smart-router models=group/tier-fast-reflex,group/tier-dynamic-value,group/tier-frontier-reasoning routing=order

# Rule: High-level architectural planning intent
magpie group rule add smart-router use=group/tier-frontier-reasoning \
  intent="high-level architecture planning, system design, or deep algorithmic reasoning"

# Rule: Long-form technical survey intent
magpie group rule add smart-router use=group/tier-extended-context \
  intent="writing survey, in-depth literature review, or long report synthesis"

# Enable dynamic cognitive reasoning effort & escalation
magpie group set smart-router effort=auto
```

---

## 9. Testing & Verification

Run the test suite and contract validation:
```bash
bun test packages/multi-path-router
```

---

## 中文设计准则与说明 (2026 修订版)

### 核心设计哲学：摆脱硬编码与指标通胀
在传统网关中，模型选型容易陷入“厂商宣传”、“价格一维阶梯”或“已饱和刷榜基准”的误区。本插件采用 **三维正交坐标系 $(X, Y, Z)$** 并全面对齐抗污染（Contamination-resistant）评测标尺：

1. **$X$ 轴（物理模态与有效载荷门闸）**：
   - **多模态准入标尺**：以 **MMMU-Pro**（过滤文本可盲猜题目）、**ChartQA / DocVQA** 与 **ScreenSpot** 为准，确保具备真实的架构拓扑逆向与 GUI 视觉诊断能力；
   - **长上下文准入标尺**：坚决戳穿厂商“标称上下文”泡沫，以 **RULER**（$\ge 128\text{k}$ 深度下准确率保留 $\ge 80\%$）、**LongBench v2** 与 **Michelangelo** 为准，杜绝“中间迷失（Lost-in-the-Middle）”。
2. **$Y$ 轴（认知深度与抗过拟合基准画像）**：
   - **战略推演层 (`tier-frontier-reasoning`)**：以 **SWE-bench Verified（$>65\%$）**、**Multi-SWE-bench**（多语言大型工程）、**GPQA Diamond（$>65\%$）**、**HLE (Humanity's Last Exam)** 及动态滚动的 **LiveCodeBench** 为硬门槛。专供高置信度的系统协议架构、形式化验证与跨模块深层因果排障；
   - **均衡交付层 (`tier-balanced-synthesis`)**：彻底剔除已严重饱和失效的 MT-Bench，升级至 **Arena-Hard-Auto v2.0**、**IFEval（严格指令遵循率 $>85\%$）** 与 **Aider Polyglot**，保障日常功能代码与 PR 产出的高质量与格式严谨性；
   - **敏捷反射层 (`tier-fast-reflex`)**：实行“物理延迟 + 结构化精度”双门控——以 **TTFT（$<300\text{ms}$）**、**TPS（$>120\text{ tok/s}$）** 结合 **BFCL（Berkeley Function Calling Leaderboard 工具调用准确率 $>85\%$）** 为硬指标，杜绝 Agent 在高频工具循环中发生 JSON 格式损坏或参数幻觉。
3. **$Z$ 轴（成本稀缺度与时段套利）**：
   - 商业限量配额严格受控；
   - 结合北京时间（CST）DeepSeek 官方等商业时段峰谷差异（工作日 12:00-14:00、18:00-09:00 及周末全天），将合规中重度任务动态引向高价值模型，达成几何级 ROI 提升；
   - 本地与免费算力池全天候兜底。

### 跨层升舱法则（Tier Escalation Policy）
针对 StartLux-Decision / Jev 判别器输出的 `effort=auto`（`low/medium/high/xhigh`）：
- **同层调节**：`low/medium/high` 仅在当前分层内部动态增减下游模型的思考 Token 预算；
- **跨层升舱**：当判别器判定任务难度为 `xhigh`（微妙竞态条件、分布式共识设计、高难度证明）时，**无条件触发跨层升舱，直通 `tier-frontier-reasoning`**，实现认知深度与算力消耗的最严密闭环。
