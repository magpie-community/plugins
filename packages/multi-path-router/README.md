# @magpie-community/middleware-multi-path-router

Adaptive scenario-based & time-aware multi-path token router for [magpie](https://usemagpie.ai). Routes heterogeneous agent workloads by business scenarios (strategic planning vs reflex execution), physical payload constraints (multimodal vision & long context), and **CST time-window price arbitrage (DeepSeek official off-peak discounts)**.

## Architecture & Flow (Sankey Topology)

```
[ Workload Input (DSH / OpenClaw / Claude Code) ]
       │
       ├── Modality Gate (Images present) ───→ Vision Tier       ──→ Local GPU / Vision VL
       ├── Scale Gate (Tokens >= 64k)    ───→ Long Context Tier  ──→ 500k Context Cluster
       ├── CST Off-Peak Window (Arbitrage) ──→ Dynamic Value Tier ──→ DeepSeek Reasoner / V3 (夯+快+便宜)
       ├── Strategic Planning Intent     ───→ Strategic Tier     ──→ Frontier Cloud Models
       └── Reflex & Tool Loops (Default) ───→ Operational Tier   ──→ Ultra-fast Flash Pool
```

> Open `sankey.html` in your browser for the full interactive dark-mode topology diagram.

---

## First Principles & Core Mechanisms

1. **Business Scenario Decoupling**: Rather than hard-coding hardware or specific provider names, workloads are categorized into strategic reasoning, operational tool execution, and physical constraint handling.
2. **CST Time-Window Arbitrage (DeepSeek 夯+快+便宜)**:
   - **Peak Windows (峰值计价)**: Monday – Friday `09:00 - 12:00` and `14:00 - 18:00` (CST). Requests use standard baseline tiers.
   - **Off-Peak Windows (峰谷特惠)**:
     - Monday – Friday `12:00 - 14:00` (Lunch window, 2 hours)
     - Monday – Friday `18:00 - 09:00` (Evening & overnight, 15 hours)
     - Saturday & Sunday full day (`48 hours`)
   During off-peak windows, heavy reasoning and large code refactoring tasks automatically route to **DeepSeek (Reasoner / V3 / Coder)**, unlocking maximum reasoning performance and throughput at official discounted prices.
3. **Transparent Model Naming**: Replies preserve the model name requested by the agent (e.g. `smart-router`), ensuring tools like Claude Code and OpenClaw correctly calibrate context windows.

---

## Installation & Setup

Install via Magpie's **Plugins › Discover**, or via CLI:

```bash
magpie plugin add @magpie-community/middleware-multi-path-router
```

### Options Configuration

Configure options via Magpie Web UI (**Plugins › Installed › Options**) or CLI:

```bash
magpie plugin options multi-path-router '{
  "schedule": {
    "cst_deepseek_offpeak": true,
    "offpeak_mapping": {
      "smart-router": "deepseek/deepseek-reasoner",
      "tier-dynamic-value": "deepseek/deepseek-chat"
    }
  },
  "constraints": {
    "vision": "local-qwen/Qwen3.8-27B",
    "tokens_gte": {
      "threshold": 64000,
      "target": "grok/grok-4.7"
    }
  },
  "mapping": {
    "smart-router": "deepseek/deepseek-chat"
  }
}'
```

### Options Reference

| Option | Type | Description |
|---|---|---|
| `schedule.cst_deepseek_offpeak` | `boolean` | Enable CST (UTC+8) peak/off-peak schedule recognition (default: `true`). |
| `schedule.offpeak_mapping` | `object` | Model mapping applied only during off-peak hours (Mon-Fri 12-14, 18-09, and weekends). |
| `constraints.vision` | `string` | Target model for requests containing images. |
| `constraints.tokens_gte` | `object` | `{ threshold, target }`: routes requests exceeding estimated tokens. |
| `mapping` | `object` | Fallback model mapping applied during peak hours or unhandled routes. |
| `keep_upstream_name` | `boolean` | When `true`, replies keep upstream model names instead of restoring the requested alias. |

---

## Deployment Recipe with Magpie Native Groups

To build an end-to-end multi-path routing cluster on any Magpie instance:

```bash
# 1. Register Decision Model (StartLux-Decision / System One)
magpie provider add typesafe-jev decide=https://api.bamboonode.dev/v1 key=<KEY>

# 2. Build Capability Subgroups
magpie group add tier-strategic models=cliproxy/gpt-6.1-sol,cliproxy/claude-opus-5-5 routing=order
magpie group add tier-dynamic-value models=deepseek/deepseek-reasoner,deepseek/deepseek-chat routing=order
magpie group add tier-operational models=opencode-go/mimo-v2.6-flash,deepseek/deepseek-chat routing=smart

# 3. Create Root Router Group
magpie group add smart-router models=group/tier-operational,group/tier-dynamic-value,group/tier-strategic routing=order
magpie group rule add smart-router use=group/tier-strategic intent="high-level architecture planning, system design, or formal proof"
```

---

## Testing

Run unit tests and verification contract:

```bash
bun test packages/multi-path-router
```

中文：面向多 Agent 体系的时段感知与业务场景自适应路由。结合业务意图（战略规划/敏捷执行）与物理硬门闸（视觉/超长上下文），并在北京时间（CST）DeepSeek 官方峰谷特惠时段（工作日 12-14 午休、18-09 夜间及周末全天）自动把任务引向 DeepSeek 系列（夯+快+便宜），最大化算力与成本收益比。
