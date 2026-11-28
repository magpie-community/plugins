#!/usr/bin/env python3
"""交付门禁：宣布完成前的最后一道闸（红线1「未检查绝不通过」的硬化）。

复用 aos 的门禁函数，不重写判断。passed=True 仅当：
  最新验收是已签发的 aesthetic pass + 技术 pass + 形式门全过 + 质量审判门全过 + 有已测证据。

用法（任何 hook / CI / agent 在声称交付前调用）：
  python delivery_gate.py --root <项目目录>          # exit 0=可交付，exit 1=拦截
  python delivery_gate.py --root <项目目录> --json   # 结构化结果
也可作为 MCP 工具 aos_delivery_gate 调用。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import aos                       # noqa: E402
import critique as vcritique     # noqa: E402


def gate(project: str) -> dict:
    root = Path(project).expanduser().resolve()
    state = aos.load(root)
    if not state:
        return {"passed": False, "latest_verdict": None,
                "blockers": ["项目无 .aos 状态：先 aos_init 立项"]}
    verdicts = state.get("verdicts") or []
    latest = verdicts[-1] if verdicts else None
    blockers: list[str] = []
    if not latest:
        blockers.append("尚无验收结论：先 aos_verdict")
    elif latest.get("aesthetic") != "pass":
        blockers.append(f"最新验收审美状态为 {latest.get('aesthetic')}，非 pass")
    elif latest.get("tech") != "pass":
        blockers.append("最新验收技术未 pass")
    # 即使已签 pass 也复核形式门与质量门（防状态被手改）
    for ok, label in aos.gate_report(state):
        if not ok:
            blockers.append(label)
    blockers.extend(vcritique.critique_gate(state))
    measured = [e for e in (state.get("evidence") or []) if e.get("measured")]
    if not measured:
        blockers.append("无任何已测量成品证据：画面未被测量，等于没看过")
    return {"passed": not blockers, "blockers": blockers, "latest_verdict": latest}


def main() -> int:
    import argparse
    import json
    p = argparse.ArgumentParser(prog="delivery_gate.py", description="交付门禁：未过不许声称完成")
    p.add_argument("--root", default=".", help="项目目录")
    p.add_argument("--json", action="store_true", help="输出结构化 JSON")
    a = p.parse_args()
    r = gate(a.root)
    if a.json:
        print(json.dumps(r, ensure_ascii=False, indent=2))
    elif r["passed"]:
        print("✅ 交付门禁通过：最新验收为已签发 aesthetic pass，形式门与质量门全过。")
    else:
        print("⛔ 交付门禁拦截：不许声称完成 / 精致 / 高级。")
        for b in r["blockers"]:
            print(f"   - {b}")
    return 0 if r["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())