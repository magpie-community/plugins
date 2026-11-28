#!/usr/bin/env python3
"""Aesthetics-OS MCP server（mcp 2.x / MCPServer）。

把已验证的审美状态机（aos.py）与欧拉五透镜（euler_lens.py）暴露为 MCP 工具，
让任何 MCP 客户端（Hermes / Claude Desktop / Cursor / Cline）都能规范调用。

设计：薄封装，复用同一批被测函数，不重写判断逻辑。
  - 裁决/状态类工具：走 aos.build_parser() 构造参数 → 调 cmd_*，捕获输出与退出码。
    verdict/critique/audit 的「拒绝」以结构化 {ok:false, stdout:"⛔…"} 返回，agent 必须处理。
  - 测量类工具：直接调 euler_lens 纯函数，返回结构化指标 dict。
  - KERNEL.md 作为 server instructions 在 initialize 下发（常驻判断上下文）。
  - 品味锚点 / 审判协议 / 欧拉文档作为 resources。

运行：python mcp_server.py        # stdio 传输（默认）
注册：见 references/mcp-server.md
"""
from __future__ import annotations

import contextlib
import io
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
SKILL = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))

import aos                       # noqa: E402
import euler_lens as el          # noqa: E402
import delivery_gate             # noqa: E402
from mcp.server.mcpserver import MCPServer  # noqa: E402

mcp = MCPServer(
    "aesthetics-os",
    description="会拒绝的审美操作系统：命题→证据→拒绝空过→迭代。裁决/状态/测量工具 + 欧拉五透镜。",
    instructions=(SKILL / "KERNEL.md").read_text(encoding="utf-8"),
)


# ────────────────────────── AOS：复用 CLI 解析 + cmd 函数 ──────────────────────────
def _run_aos(project: str, argv: list[str]) -> dict:
    """用 aos 自己的 argparse 构造参数并调用对应 cmd_*，捕获 stdout/stderr/退出码。"""
    root = Path(project).expanduser().resolve()
    full = ["--root", str(root)] + argv
    args = aos.build_parser().parse_args(full)
    root.mkdir(parents=True, exist_ok=True)
    out, err = io.StringIO(), io.StringIO()
    code = 0
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = args.func(args, root)
    except SystemExit as e:  # 防御：cmd_* 实际均 return int
        code = int(e.code or 0)
    return {"ok": code == 0, "exit_code": code,
            "stdout": out.getvalue(), "stderr": err.getvalue()}


@mcp.tool(description="初始化项目审美状态（在 project 目录建 .aos/state.json）。闭环第一步。")
def aos_init(project: str, name: str | None = None) -> dict:
    argv = ["init"] + (["--project", name] if name else [])
    return _run_aos(project, argv)


@mcp.tool(description="写入审美命题。必须合模板『面向[受众]完成[任务]呈现[情绪]通过[形式]』，宽泛词须已映射，否则拒绝。")
def aos_propose(project: str, text: str) -> dict:
    return _run_aos(project, ["propose", text])


@mcp.tool(description="添加一条设计决策（建议 3–5 条）。每条须是可执行的取舍，不是风格形容词。")
def aos_decide(project: str, text: str) -> dict:
    return _run_aos(project, ["decide", text])


@mcp.tool(description="建立品味简报：目的/受众/喜欢/拒绝/标志性动作/非目标(≥2)/参考证据。verdict 会检查简报完整。")
def aos_brief(project: str, purpose: str = "", audience: str = "", like: str = "",
              dislike: str = "", signature: str = "",
              nongoal: list[str] | None = None, evidence: list[str] | None = None) -> dict:
    argv = ["brief"]
    for flag, val in [("--purpose", purpose), ("--audience", audience), ("--like", like),
                      ("--dislike", dislike), ("--signature", signature)]:
        if val:
            argv += [flag, val]
    for ng in (nongoal or []):
        argv += ["--nongoal", ng]
    for ev in (evidence or []):
        argv += ["--evidence", ev]
    return _run_aos(project, argv)


@mcp.tool(description="登记一份真实成品（绑定像素哈希+尺寸），登记即自动生成 13 项形式指纹。没测过等于没看过。")
def aos_evidence(project: str, path: str, surface: str | None = None) -> dict:
    argv = ["evidence", path] + (["--surface", surface] if surface else [])
    return _run_aos(project, argv)


@mcp.tool(description="测量画面形式指纹；给 compare 则与另一张对比判是否只换皮（红线2的数值证据）。")
def aos_measure(project: str, path: str, compare: str | None = None) -> dict:
    argv = ["measure", path] + (["--compare", compare] if compare else [])
    return _run_aos(project, argv)


@mcp.tool(description="记录一个被拒方向及其失败机制。两次被拒后须先建新证据/检查点，不许换皮。")
def aos_reject(project: str, direction: str, mechanism: str) -> dict:
    return _run_aos(project, ["reject", "--direction", direction, "--mechanism", mechanism])


@mcp.tool(description="建立方向检查点（概念距离足够大的新方向），换皮拦截后重启判断用。")
def aos_checkpoint(project: str) -> dict:
    return _run_aos(project, ["checkpoint"])


@mcp.tool(description="签发验收结论。tech=pass/fail，aesthetic=pass/hold/revise。aesthetic=pass 需≥2份已测证据+最新成品绑定哈希的pass审判+理由≥20字，否则拒绝签发（返回 ok:false）。未过只能说『技术通过，审美暂定』。")
def aos_verdict(project: str, tech: str, aesthetic: str, reason: str = "") -> dict:
    return _run_aos(project, ["verdict", "--tech", tech, "--aesthetic", aesthetic, "--reason", reason])


@mcp.tool(description="查看项目审美状态：命题/简报/决策/证据/审判/轮次/结论。跨会话接续判断。")
def aos_status(project: str) -> dict:
    return _run_aos(project, ["status"])


@mcp.tool(description="审计自身诚信：连续通过零被拒、简报后60秒内登记成品、零证据签通过、签通过却无审判、只换皮，都会被标出。")
def aos_audit(project: str) -> dict:
    return _run_aos(project, ["audit"])


@mcp.tool(description="质量审判（真实视觉执行，脚本不自看图）。action=prepare 生成结构化审判提示；register 登记视觉审判JSON(逐项校验,红线fail却pass/匿名审判直接拒绝)；run 自动后端。image 为成品路径，register 需 file=审判JSON。")
def aos_critique(project: str, action: str, image: str, file: str | None = None,
                 taste: str | None = None, json_only: bool = False) -> dict:
    argv = ["critique", action, image]
    if file:
        argv += ["--file", file]
    if taste:
        argv += ["--taste", taste]
    if json_only:
        argv += ["--json-only"]
    return _run_aos(project, argv)


@mcp.tool(description="记录一轮『生成→测量→审判』迭代，并检测相对上一轮是否真改动（指纹几乎相同=疑似换皮）。fix 说明本轮改了什么机制。")
def aos_loop(project: str, image: str, fix: str | None = None) -> dict:
    argv = ["loop", image] + (["--fix", fix] if fix else [])
    return _run_aos(project, argv)


@mcp.tool(description="交付门禁（宣布完成前必调，红线1硬化）：仅当最新验收为已签发 aesthetic pass 且技术pass+形式门+质量审判门全过+有已测证据，才 passed=true。passed=false 时绝不许声称完成/精致/高级，blockers 列出缺什么。")
def aos_delivery_gate(project: str) -> dict:
    return delivery_gate.gate(project)


# ────────────────────────── 欧拉五透镜：纯函数 → 结构化指标 ──────────────────────────
@mcp.tool(description="色相相位和谐分析：色相环=单位圆，返回 resultant R(集中度)/主色相/彩度/和谐类型。水墨无彩色会如实标注。")
def euler_hue(image: str) -> dict:
    return el.hue_phases(Path(image).expanduser())


@mcp.tool(description="欧拉相位旋转 e^(iΔθ) 生成和谐调色板。scheme: mono/analogous/complementary/split/triadic/tetradic。返回各色的相位差/色相/hex，可写进生成 prompt。")
def euler_palette(base_hue: float, scheme: str = "triadic", sat: float = 0.55, val: float = 0.82) -> dict:
    return {"base_hue": base_hue, "scheme": scheme, "sat": sat, "val": val,
            "colors": el.harmony_palette(base_hue, scheme, sat, val)}


@mcp.tool(description="径向功率谱斜率 α（纹理平衡信号）。诚实边界：大留白会混淆全局谱，须与构图合看，不可单独裁决自然度。")
def euler_spectrum(image: str) -> dict:
    info = el.spectrum(Path(image).expanduser())
    curve = info.pop("curve", [])
    info["curve_points"] = len(curve)
    return info


@mcp.tool(description="相位一致性 PC：光照不变的结构特征密度/集中度。给 render 输出结构热图叠加路径。")
def euler_pc(image: str, render: str | None = None) -> dict:
    p = Path(image).expanduser()
    info = el.phase_congruency(p)
    if render:
        info["rendered"] = str(el.render_pc(p, Path(render).expanduser()))
    return info


@mcp.tool(description="Gabor 方向谱：方向熵(越低越塑料)+各向异性。材质真实红线的频域硬证据：平滑渐变塑料感 vs 自然笔意。")
def euler_gabor(image: str) -> dict:
    return el.gabor_orientation(Path(image).expanduser())


@mcp.tool(description="黄金螺线/φ网格构图几何：PC权重重心 vs φ黄金点。参照非裁决——水墨计白当黑未必遵循西方螺线，低对齐≠差。给 render 输出叠加图。")
def euler_spiral(image: str, render: str | None = None) -> dict:
    p = Path(image).expanduser()
    info = el.spiral_analysis(p)
    if render:
        info["rendered"] = str(el.render_spiral(p, Path(render).expanduser()))
    return info


@mcp.tool(description="渲染色相单位圆可视化（色相环+主色相锚点+合成向量），输出到 out 路径。")
def euler_circle(image: str, out: str) -> dict:
    return {"rendered": str(el.render_hue_circle(Path(image).expanduser(), Path(out).expanduser()))}


# ────────────────────────── Resources：判断层文档 ──────────────────────────
@mcp.resource("kernel://KERNEL.md", name="KERNEL", mime_type="text/markdown",
              description="常驻内核：反射/三红线/接口/模块路由（约1100字）。")
def _kernel() -> str:
    return (SKILL / "KERNEL.md").read_text(encoding="utf-8")


@mcp.resource("taste://taste-profile.json", name="taste-profile", mime_type="application/json",
              description="品味锚点（默认 X+2/Y+3/Z+1），项目可覆盖。")
def _taste() -> str:
    return (SKILL / "references" / "taste-profile.json").read_text(encoding="utf-8")


@mcp.resource("protocol://critique-protocol.md", name="critique-protocol", mime_type="text/markdown",
              description="鉴赏家审判协议：6红线+三轴+5反射+结论+端到端闭环。")
def _protocol() -> str:
    return (SKILL / "references" / "critique-protocol.md").read_text(encoding="utf-8")


@mcp.resource("euler://euler-lens.md", name="euler-lens", mime_type="text/markdown",
              description="欧拉→美学迁移：五透镜数学结构 + 诚实边界。")
def _euler_doc() -> str:
    return (SKILL / "references" / "euler-lens.md").read_text(encoding="utf-8")


# ────────────────────────── Prompt：闭环编排 ──────────────────────────
@mcp.prompt(description="标准审美闭环编排：给方向后自主执行，不逐轮问用户。")
def aesthetic_loop() -> str:
    return (
        "按 Aesthetics-OS 标准闭环执行（自主连续，不逐轮确认）：\n"
        "1. aos_init 立项 → aos_propose 写命题(合模板) → aos_decide ×3 → aos_brief 建简报(非目标≥2+参考证据)。\n"
        "2. euler_palette 设计和谐调色板，写进生成 prompt。\n"
        "3. 生成成品（用你的生图工具）。\n"
        "4. aos_evidence 登记(即测量) → aos_critique prepare 取审判提示 → 用真实视觉(vision)看画面填审判JSON → aos_critique register 登记。\n"
        "5. 审判 revise：按 priority_fix 改 → aos_loop 记录本轮 → 重新生成，回到 4。审判对照命题意图，不是整体观感。\n"
        "6. 审判 pass 且证据≥2份不同断点：aos_verdict --tech pass --aesthetic pass --reason(≥20字)。\n"
        "7. aos_audit 自审诚信。红线：未检查绝不通过；两次被拒绝不换皮；宽泛科技词绝不套模板。\n"
        "测过结构≠评过质量。没看实际成品，不许说好看。"
    )


if __name__ == "__main__":
    mcp.run(transport="stdio")