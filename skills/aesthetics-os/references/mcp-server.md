# MCP 服务器：把审美 OS 变成任何 agent 可调用的接口

`scripts/mcp_server.py` 用官方 `mcp` SDK（2.x，`MCPServer`）把已验证的状态机与欧拉透镜暴露为 MCP 工具。薄封装，复用同一批被测函数，不重写判断逻辑。

## 为什么是混合体，不是纯 MCP

这个 OS 有两层，适合的形式不同：

- **执行/裁决层**（状态机 + 测量 + 会拒绝的门）→ MCP 工具。结构化、可发现、跨客户端；`verdict`/`critique`/`audit` 的拒绝以 `{ok:false, stderr:'⛔…'}` 返回，agent 的工具循环必须处理。
- **判断/品味层**（内核 + 协议 + 反射）→ 常驻上下文。`KERNEL.md` 作为 server `instructions` 在 initialize 下发给客户端；品味锚点/审判协议/欧拉文档作为 resources。Hermes 里再留薄 skill 自动加载 KERNEL，判断层最稳。

强制力排序：**散文 skill < MCP 工具 < 交付门禁/hook**。MCP 让工具规范可调，但 agent 仍「选择」去调；`aos_delivery_gate` 与 `delivery_gate.py` 把「未检查绝不通过」硬化成可拦截的闸。

## 注册

依赖：官方 `mcp` SDK（`pip install mcp`，需 2.x）+ numpy + Pillow。服务器走 stdio 传输。

### Hermes Agent

在 `%LOCALAPPDATA%\hermes\config.yaml` 的 `mcp_servers` 段加：

```yaml
mcp_servers:
  aesthetics-os:
    command: python
    args:
      - C:\Users\Administrator\AppData\Local\hermes\skills\Aesthetics-OS\scripts\mcp_server.py
    enabled: true
```

重启 gateway 后工具以 `mcp__aesthetics-os__<tool>` 出现。

### Claude Desktop

`claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "aesthetics-os": {
      "command": "python",
      "args": ["C:\\Users\\Administrator\\AppData\\Local\\hermes\\skills\\Aesthetics-OS\\scripts\\mcp_server.py"]
    }
  }
}
```

### Cursor

项目 `.cursor/mcp.json` 同上 `mcpServers` 结构。路径换成本机技能目录即可。

## 工具目录（21）

**状态/裁决（14）**：`aos_init` `aos_propose` `aos_decide` `aos_brief` `aos_evidence` `aos_measure` `aos_reject` `aos_checkpoint` `aos_verdict` `aos_status` `aos_audit` `aos_critique` `aos_loop` `aos_delivery_gate`。每个都要 `project`（被设计项目目录，状态存其 `.aos/state.json`）。

**欧拉五透镜（7）**：`euler_hue` `euler_palette` `euler_spectrum` `euler_pc` `euler_gabor` `euler_spiral` `euler_circle`。输入图像绝对路径，返回结构化指标；`pc`/`spiral`/`circle` 可给 render/out 输出叠加图。

**Resources（4）**：`kernel://KERNEL.md`、`taste://taste-profile.json`、`protocol://critique-protocol.md`、`euler://euler-lens.md`。

**Prompt（1）**：`aesthetic_loop` —— 标准闭环编排（立项→设计和谐→生成→测量→真实视觉审判→revise迭代→pass才verdict→audit）。

## 交付门禁与 hook

`aos_delivery_gate(project)` 返回 `{passed, blockers, latest_verdict}`。`passed=true` 仅当最新验收是已签发 aesthetic pass 且技术 pass + 形式门 + 质量审判门全过 + 有已测证据。**宣布完成前必调；passed=false 绝不许声称完成/精致/高级。**

独立脚本同一逻辑，可接任何 hook / CI / 交付前步骤：

```bash
python scripts/delivery_gate.py --root <项目目录>          # exit 0 可交付 / exit 1 拦截
python scripts/delivery_gate.py --root <项目目录> --json   # 结构化
```

Hermes 有 shell hook 机制（首次运行需 `~/.hermes/shell-hooks-allowlist.json` 允许）。把交付前 hook 指向 `delivery_gate.py --root <项目>`，非零退出即拦截交付，是比「agent 自觉调工具」更硬的强制。具体 hook 配置 schema 以 hermes-agent 技能/官方文档为准。

## 验证

```bash
python scripts/test_mcp_server.py   # 真实 MCP 客户端 stdio 端到端，13 断言
```

覆盖：initialize + KERNEL instructions 下发、21 工具/4 资源/1 提示、`euler_hue` R≈0.556 结构化、`euler_palette` triadic 3 色、`aos_init/status`、**空项目 verdict 被拒绝**、合模板 propose、**交付门禁拦截未完成项目**。门禁另经独立双向验证：已通过项目 exit 0、空项目 exit 1。

## 诚实边界

- MCP 工具仍依赖 agent 去调；最硬的可移植强制是交付门禁/hook，平台级「无论如何不许空过」需平台 hook 钉死。
- `critique` 的「看」由客户端的真实视觉执行，服务器只 prepare/register，不自看图、不伪造审判。
- 测量信号（谱/PC/螺线）是结构描述器，裁决仍归 critique；详见 euler-lens.md 的边界。