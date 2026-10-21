# @magpie-community/middleware-multi-path-router

Three-dimensional orthogonal multi-path token router for [magpie](https://usemagpie.ai). Routes multi-agent workloads dynamically across **Payload Modality & Scale (X)**, **Cognitive Reasoning Depth & Benchmark Profile (Y)**, and **Economic Scarcity & Quota Arbitrage (Z)** using System One decision discriminators (StartLux-Decision, Jev, or local classifiers) and zero-cost physical constraint gates.

---

## 1. The Core Problem: Why 1D Model Ladders Fail

In modern multi-agent systems (e.g. Claude Code, Codex, OpenClaw, DSH, Hermes), agents invoke models with vastly differing operational characteristics:
- An ultra-fast flash model has millisecond latency for simple syntax checks, but fails on architectural trade-offs.
- A frontier reasoning model achieves high pass rates on complex proofs, but exhausts quotas and induces multi-second latency when assigned routine tool loops.
- A local vision-capable model incurs zero marginal cost for inspection, but lacks deep analytical context.
- A high-context model digests 500k tokens cleanly, but carries significant per-call overhead for short prompts.

These properties cannot be sorted into a simple 1D priority ladder. **They exist in an orthogonal three-dimensional space.**

---

## 2. The 3D Orthogonal Capability Space

```
                 ▲ Y: Cognitive Depth & Benchmark Profile
                 │    (AIME, SWE-bench Verified, LiveCodeBench)
                 │
                 │   [Tier: Frontier Reasoning]
                 │   (Complex architecture, formal proofs, tricky root-causing)
                 │
                 │              [Tier: Balanced Synthesis]
                 │              (Feature code, technical reviews, doc drafting)
                 │
                 │                         [Tier: Fast Reflex]
                 │                         (Tool loops, syntax checks, linting)
                 └──────────────────────────────────────────────────────────► X: Modality & Physical Scale
                /                                                             (Images, 100k+ tokens)
               /
              /   [Tier: Zero-Cost / Off-Peak Arbitrage]
             /    (Local clusters, discounted time-windows)
            ▼ Z: Economic Scarcity & Quota Watermark
```

### Dimension X: Payload Modalities & Physical Constraints
- **Vision & Multimodal Gate**: Pre-flight inspection detects image blocks (`image`, `image_url`, `inline_data`) across Anthropic, OpenAI Chat, Responses, and Gemini protocols. Short-circuits directly to multimodal-capable engines before hitting semantic discriminators, saving decision tokens.
- **Context Length Gate**: Payload character/token estimation intercepts requests exceeding scale thresholds (e.g. $\ge 64\text{k}$ or $100\text{k}$ tokens), routing them to large-window clusters.

### Dimension Y: Cognitive Reasoning Depth & Benchmark Profiles
Workloads are assigned to capability tiers characterized by objective, peer-reviewed public benchmarks:
- **Frontier Reasoning Tier (`tier-frontier-reasoning`)**: Characterized by leading scores on AIME 2024/2025, SWE-bench Verified ($>50\%$), LiveCodeBench, and GPQA Diamond. Reserved for high-leverage architectural designs, formal proofs, and multi-file causal debugging.
- **Balanced Synthesis Tier (`tier-balanced-synthesis`)**: Strong scores on Arena-Hard, Chatbot Arena, and MT-Bench. Standard driver for feature implementation, test creation, and pull request synthesis.
- **Fast Reflex & Tool-Loop Tier (`tier-fast-reflex`)**: Optimized for sub-second TTFT (Time to First Token) and high TPS ($>100\text{ tok/s}$). Handles AST transformations, git commit summaries, and interactive agent inner-loop tool executions.

### Dimension Z: Economic Scarcity & Quota Watermark
- **Metered Commercial Quotas**: Rate-limited or seat-restricted frontier models.
- **Dynamic Time-Window Arbitrage**: Automatically shifts eligible workloads to discounted provider windows (e.g., DeepSeek official peak vs. off-peak hours in CST) or off-peak spot compute.
- **Zero-Cost / High-Concurrency Clusters**: Local vLLM/llama.cpp engines or free-tier community pools.

---

## 3. Architecture & Topology (Sankey Flow)

```
[ Inbound Workload (Agent / IDE / CLI) ]
         │
         ├── [Physical Gate] Has Image Payload? ──────────→ group/tier-multimodal-runtime
         ├── [Physical Gate] Tokens >= 64k?     ──────────→ group/tier-extended-context
         ├── [Schedule Gate] Off-Peak Window Active? ─────→ group/tier-dynamic-value
         │
         └── [Semantic Gate via System One Discriminator]
                 │
                 ├── Intent: Architecture / Deep Reasoning ─→ group/tier-frontier-reasoning
                 ├── Intent: Long Synthesis / Literature  ──→ group/tier-balanced-synthesis
                 └── Intent: None of these (Default)     ──→ group/tier-fast-reflex
```

> **Interactive Visualization**: Open `sankey.html` in any browser for a dark-mode interactive view of the 4-stage pipeline.

---

## 4. The Decision Protocol: StartLux-Decision / Jev System One

Magpie natively interfaces with System One decision discriminators (`/v1/systemone` or OpenRouter `/v1/decisions`), such as **StartLux-Decision 27B-AutoThink**, **Jev**, or custom classifiers:

1. **Natural Language Criteria (`criteria`)**: Rules are declared in natural language, eliminating brittle regexes:
   ```bash
   magpie group rule add smart-router use=group/tier-frontier-reasoning \
     intent="high-level architecture planning, system design, or deep algorithmic reasoning"
   ```
2. **Confidence Thresholding**: The discriminator evaluates the full prompt state and outputs probabilistic confidence scores. If confidence meets threshold ($\ge 0.4$), the route triggers.
3. **Adaptive Reasoning Depth (`effort=auto`)**: The discriminator simultaneously grades cognitive difficulty (`low`, `medium`, `high`, `xhigh`), instructing downstream models to adjust reasoning token budgets dynamically.

---

## 5. Objective Model Onboarding: Zero Rule Drift

When a new foundation model is released, **no routing rules or plugin code need to be modified**:
1. **Benchmark Assessment**: Evaluate the model's published benchmark profile (e.g. SWE-bench Verified, MMMU, TTFT, pricing).
2. **Assign to Capability Tier**: Add the model into its corresponding abstract Magpie group:
   ```bash
   magpie group set tier-frontier-reasoning models+=provider/new-frontier-model
   ```
3. **Instant Generalization**: Inbound workloads are automatically routed to the new model based on objective criteria, with zero downtime and zero configuration drift.

---

## 6. Installation & Configuration

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

## 7. Universal Deployment Recipe with Native Magpie Groups

Follow these steps to instantiate the complete 3D routing cluster on any Magpie instance:

```bash
# 1. Register Decision Discriminator (StartLux-Decision / Jev System One)
magpie provider add typesafe-jev decide=https://api.bamboonode.dev/v1 key=<YOUR_KEY>

# 2. Construct Abstract Capability Tiers
# Frontier Reasoning: Top AIME / SWE-bench models (Order strategy for failover)
magpie group add tier-frontier-reasoning models=<YOUR_FRONTIER_MODELS> routing=order

# Dynamic Value: Off-peak discounted or high-efficiency models
magpie group add tier-dynamic-value models=<YOUR_VALUE_MODELS> routing=order

# Multimodal Runtime: Local GPU or vision-specialized models
magpie group add tier-multimodal-runtime models=<YOUR_VISION_MODELS> routing=order

# Extended Context: 100k+ token window models
magpie group add tier-extended-context models=<YOUR_LONG_CTX_MODELS> routing=smart

# Fast Reflex: Ultra-fast flash / free-pool models for rapid tool turns
magpie group add tier-fast-reflex models=<YOUR_FLASH_MODELS> routing=smart

# 3. Create Root Router Group with Adaptive Semantic Rules
magpie group add smart-router models=group/tier-fast-reflex,group/tier-dynamic-value,group/tier-frontier-reasoning routing=order

# Rule: High-level architectural planning intent
magpie group rule add smart-router use=group/tier-frontier-reasoning \
  intent="high-level architecture planning, system design, or deep algorithmic reasoning"

# Rule: Long-form technical survey intent
magpie group rule add smart-router use=group/tier-extended-context \
  intent="writing survey, in-depth literature review, or long report synthesis"

# Enable dynamic cognitive reasoning effort
magpie group set smart-router effort=auto
```

---

## 8. Testing & Verification

Run the test suite and contract validation:
```bash
bun test packages/multi-path-router
```

---

## 中文设计准则与说明 (Design Guide in Chinese)

### 核心设计哲学：摆脱硬编码与一维阶梯
在传统网关中，模型往往被简单排成“价格”或“厂商”的一维阶梯，但这在现代多 Agent 复杂编排中必然失效。本插件采用 **三维正交坐标系 $(X, Y, Z)$**：
1. **$X$ 轴（物理模态与载荷门闸）**：通过零延迟 AST 解析检测图片与 Token 规模，在请求触达语义判别器前实现物理级硬门闸分流，杜绝不必要的决策 Token 消耗与不可解析异常。
2. **$Y$ 轴（认知深度与公认基准画像）**：摒弃“厂商偏好”或“主观印象”，依照社区公认基准测试对模型分档：
   - **战略推演层 (`tier-frontier-reasoning`)**：基准标杆为 AIME、SWE-bench Verified（$>50\%$）、LiveCodeBench。专供高置信度的系统架构设计与深层次因果排障。
   - **均衡交付层 (`tier-balanced-synthesis`)**：基准标杆为 MT-Bench、Arena-Hard。负责标准特性编码与技术综述撰写。
   - **敏捷反射层 (`tier-fast-reflex`)**：基准标杆为毫秒级 TTFT 与高并发吞吐。专供单步语法纠错、单测循环与 Agent 工具调用心跳，严防昂贵的顶配模型配额被机械短任务刷爆。
3. **$Z$ 轴（成本稀缺度与时段套利）**：
   - 商业限量配额严格受控；
   - 结合北京时间（CST）DeepSeek 官方等商业时段峰谷差异（工作日 12:00-14:00、18:00-09:00 及周末全天），将合规中重度任务动态引向高价值模型，达成几何级 ROI 提升；
   - 本地与免费算力池全天候兜底。

### 新模型无缝接入法则（Zero Configuration Drift）
当未来有新的开源或闭源模型发布时：
- **无需修改插件代码，亦无需重写任何路由规则**；
- 仅需根据新模型的公开 Benchmark 分数与成本属性，将其挂入对应的抽象能力子组（`tier-*`）；
- StartLux-Decision / Jev 判别器将依据任务的自然语言特征，自动将请求分发至包含新模型的子组中，实现配置与逻辑的彻底解耦。
