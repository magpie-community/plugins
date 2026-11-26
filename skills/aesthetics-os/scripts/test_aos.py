#!/usr/bin/env python3
"""aesthetics-OS 核心的回归测试：重点验证「该拒绝时真的拒绝」。

需要 Pillow（真实解码画面）：pip install pillow
用法：python scripts/test_aos.py
退出码 0 表示全部断言通过。
"""

from __future__ import annotations

import json
import random
import subprocess
import sys
import tempfile
from pathlib import Path

AOS = Path(__file__).with_name("aos.py")
PASS, FAIL = "✅", "⛔"
results: list[tuple[bool, str]] = []

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    print("需要 Pillow：pip install pillow", file=sys.stderr)
    raise SystemExit(2)


def run(project: Path, *args: str) -> tuple[int, str]:
    proc = subprocess.run(
        [sys.executable, str(AOS), "--root", str(project), *args],
        capture_output=True, text=True, encoding="utf-8",
    )
    return proc.returncode, proc.stdout + proc.stderr


def check(condition: bool, message: str) -> None:
    results.append((condition, message))
    print(f"{PASS if condition else FAIL} {message}")


def calm_image(path: Path, size: tuple[int, int] = (1200, 800), shift: float = 0.0) -> None:
    img = Image.new("RGB", size, (242, 236, 224))
    draw = ImageDraw.Draw(img)
    x0 = int(size[0] * (0.62 + shift))
    y0 = int(size[1] * 0.55)
    draw.ellipse([x0, y0, x0 + 90, y0 + 130], fill=(28, 26, 24))
    img.save(path)


def busy_image(path: Path, size: tuple[int, int] = (480, 1024), seed: int = 7) -> None:
    random.seed(seed)
    img = Image.new("RGB", size)
    pixels = [
        (random.randrange(256), random.randrange(256), random.randrange(256))
        for _ in range(size[0] * size[1])
    ]
    img.putdata(pixels)
    img.save(path)


def grab(text: str, key: str) -> float:
    for line in text.splitlines():
        if line.strip().startswith(key):
            return float(line.split()[-1])
    return float("nan")


def make_critique(conclusion: str = "pass", fail_line: str | None = None,
                  anonymous: bool = False, incomplete: bool = False) -> dict:
    rl = {k: {"status": "pass", "evidence": "看见的具体证据说明"}
          for k in ("CS", "FP", "TX", "AI", "CU", "CM")}
    if fail_line:
        rl[fail_line]["status"] = "fail"
    result = {
        "red_lines": rl,
        "three_axis": {"x": 2, "y": 3, "z": 1, "note": "对照锚点"},
        "reflexes": {k: {"observed": "看见的事实", "mechanism": "机制", "effect": "效果"}
                     for k in ("purpose", "system", "material", "specificity", "restraint")},
        "conclusion": conclusion,
        "priority_fix": "把主体提到左侧三分位" if conclusion != "pass" else "",
        "judge": "test-fixture",
    }
    if anonymous:
        del result["judge"]
    if incomplete:
        del result["red_lines"]["CS"]
    return result


def register_critique(project: Path, image: Path, result: dict) -> tuple[int, str]:
    file = project / "critique_tmp.json"
    file.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return run(project, "critique", "register", str(image), "--file", str(file))


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        project = Path(tmp) / "demo"
        project.mkdir()
        ref = project / "参考.png"
        calm = project / "成品-calm.png"
        busy = project / "成品-busy.png"
        calm2 = project / "成品-calm-v2.png"
        copy_of_busy = project / "成品-新方向.png"
        calm_image(ref, shift=-0.02)
        calm_image(calm)
        busy_image(busy)
        calm_image(calm2, shift=-0.22)
        copy_of_busy.write_bytes(busy.read_bytes())

        code, out = run(project, "init", "--project", "回归测试")
        check(code == 0 and "已初始化" in out, "init 建立状态")

        code, out = run(project, "verdict", "--tech", "pass", "--aesthetic", "pass",
                        "--reason", "看起来挺好的，整体舒服，没什么大问题，就这样交付吧")
        check(code == 1 and "拒绝签发" in out, "空状态直接被拒绝签发审美通过")

        code, out = run(project, "propose", "要很高级、很现代")
        check(code == 1 and "模板要素" in out, "缺模板要素的命题被拒绝")

        code, out = run(project, "propose",
                        "面向财务负责人完成月度对账时呈现可托付的克制，通过精确数字的层级差表达，高级=对比度+密度+材料")
        check(code == 0, "合模板且宽泛词已映射的命题被接受")

        code, out = run(project, "propose",
                        "面向财务负责人完成月度对账时呈现可托付的克制，通过精确数字的层级差表达，要高级")
        check(code == 1 and "宽泛词" in out, "未映射参数的「高级」被拒绝")

        for text in ("留白占比不低于 45%，作为观看呼吸", "强调色只用于待核实状态", "动效只表达状态迁移"):
            run(project, "decide", text)

        code, out = run(project, "brief", "--purpose", "让财务快速定位差异",
                        "--audience", "财务负责人", "--dislike", "渐变光带与装饰性插画",
                        "--signature", "唯一一处朱砂红标记待核实", "--nongoal", "不做科技感暗色",
                        "--nongoal", "不加网格与扫描线")
        check(code == 1 and "参考证据" in out, "没有参考证据的简报被拒绝")

        code, out = run(project, "brief", "--purpose", "让财务快速定位差异",
                        "--audience", "财务负责人", "--dislike", "渐变光带与装饰性插画",
                        "--signature", "唯一一处朱砂红标记待核实", "--nongoal", "不做科技感暗色",
                        "--nongoal", "不加网格与扫描线", "--evidence", str(ref))
        check(code == 0 and "简报完整" in out, "补齐证据与决策后简报完整")

        code, out = run(project, "evidence", str(project / "不存在.png"))
        check(code == 1 and "不存在" in out, "不存在的成品不能登记")

        code, out = run(project, "evidence", str(calm), "--surface", "desktop")
        check(code == 0 and "形式指纹" in out, "登记成品时自动测量并打印指纹")

        code, out = run(project, "checkpoint")
        check(code == 1, "只有一份成品时检查点不通过（需 ≥2 且覆盖两种宽度）")

        code, out = run(project, "verdict", "--tech", "pass", "--aesthetic", "pass",
                        "--reason", "差异行提前后视线落点正确，但状态色与品牌色对比不足，需再检查移动端")
        check(code == 1, "证据不足时仍然拒绝签发")

        code, out = run(project, "evidence", str(busy), "--surface", "mobile")
        check(code == 0, "第二份成品登记成功")

        # 质量门：测过结构但没做质量审判 → 拒绝
        code, out = run(project, "verdict", "--tech", "pass", "--aesthetic", "pass",
                        "--reason", "差异行提前后视线落点正确，但状态色与品牌色对比不足，需再检查移动端")
        check(code == 1 and "没有质量审判" in out, "测过结构但未做质量审判，拒绝签发（测过≠评过）")

        # 审判登记的结构校验
        code, out = register_critique(project, busy, make_critique(incomplete=True))
        check(code == 1 and "缺红线" in out, "缺红线的审判被拒绝登记")
        code, out = register_critique(project, busy, make_critique(fail_line="CM"))
        check(code == 1 and "自相矛盾" in out, "红线 fail 却判 pass 的审判被拒绝登记")
        code, out = register_critique(project, busy, make_critique(anonymous=True))
        check(code == 1 and "匿名" in out, "匿名审判被拒绝登记")

        # revise 审判挡住通过
        code, out = register_critique(project, busy, make_critique(conclusion="revise"))
        check(code == 0, "revise 审判可登记")
        code, out = run(project, "verdict", "--tech", "pass", "--aesthetic", "pass",
                        "--reason", "差异行提前后视线落点正确，但状态色与品牌色对比不足，需再检查移动端")
        check(code == 1 and "revise" in out, "最新成品审判为 revise 时拒绝签通过")

        # pass 审判放行
        code, out = register_critique(project, busy, make_critique(conclusion="pass"))
        check(code == 0 and "pass" in out, "pass 审判登记成功")

        code, calm_out = run(project, "measure", str(calm))
        code, busy_out = run(project, "measure", str(busy))
        calm_flat, busy_flat = grab(calm_out, "flat_area"), grab(busy_out, "flat_area")
        calm_edge, busy_edge = grab(calm_out, "edge_density"), grab(busy_out, "edge_density")
        check(calm_flat > busy_flat + 0.3, f"极简图留白高于噪点图（{calm_flat:.2f} vs {busy_flat:.2f}）")
        check(busy_edge > calm_edge + 0.2, f"噪点图边缘密度高于极简图（{busy_edge:.2f} vs {calm_edge:.2f}）")

        code, out = run(project, "measure", str(busy), "--compare", str(busy))
        check("疑似只换皮" in out, "同一张图自比被判定为只换皮")
        code, out = run(project, "measure", str(busy), "--compare", str(calm))
        check("画面确有变化" in out, "两张不同图被判定为确有变化")

        code, out = run(project, "checkpoint")
        check(code == 0 and "可以进入完整实现" in out, "两份断点证据齐备后检查点通过")

        code, out = run(project, "verdict", "--tech", "fail", "--aesthetic", "pass",
                        "--reason", "差异行提前后视线落点正确，但状态色与品牌色对比不足，需再检查移动端")
        check(code == 1 and "技术验收不是 pass" in out, "技术未通过时不得签审美通过")

        code, out = run(project, "verdict", "--tech", "pass", "--aesthetic", "pass",
                        "--reason", "差异行提前后视线落点正确，但状态色与品牌色对比不足，需再检查移动端")
        check(code == 0 and "审美状态：pass" in out, "条件齐备（含质量审判）后签发出审美通过")

        run(project, "reject", "--direction", "方向A-深色玻璃卡", "--mechanism", "只换了材质，层级与重力没变")
        code, out = run(project, "reject", "--direction", "方向B-编辑极简", "--mechanism", "间距收紧但仍靠装饰建立焦点")
        check("两个方向被拒" in out, "第二次被拒后提示必须换证据")

        code, out = run(project, "verdict", "--tech", "pass", "--aesthetic", "pass",
                        "--reason", "这次真的不一样了，因为我把差异行提到了第一层，删掉了渐变光带")
        check(code == 1 and "新证据" in out, "两次被拒后没有新证据，拒绝签发")

        code, out = run(project, "evidence", str(copy_of_busy), "--surface", "desktop")
        check(code == 0, "同内容副本可以登记（登记层不做价值判断）")
        code, out = run(project, "verdict", "--tech", "pass", "--aesthetic", "pass",
                        "--reason", "这次真的不一样了，因为我把差异行提到了第一层，删掉了渐变光带")
        check(code == 1 and "换皮" in out, "指纹未变的新证据被判定为换皮并拒绝签发")

        code, out = run(project, "evidence", str(calm2), "--surface", "desktop")
        check(code == 0, "真正改动后的成品登记成功")
        register_critique(project, calm2, make_critique(conclusion="pass"))
        code, out = run(project, "verdict", "--tech", "pass", "--aesthetic", "pass",
                        "--reason", "主体转移到左侧三分位，留白结构改变，差异行的重力关系成立")
        check(code == 0 and "审美状态：pass" in out, "画面确有变化且评过质量后允许签发通过")

        # 迭代闭环
        code, out = run(project, "loop", str(calm2), "--fix", "主体左移，留白结构改变")
        check(code == 0 and "迭代轮次" in out, "loop 记录迭代轮次")

        code, out = run(project, "audit")
        check("审美审计" in out, "audit 可运行并给出报告")

        state_file = project / ".aos" / "state.json"
        state = json.loads(state_file.read_text(encoding="utf-8"))
        state["verdicts"].append({"tech": "pass", "aesthetic": "pass",
                                  "reason": "好", "evidence_n": 0, "at": "2026-01-01T00:00:00+08:00"})
        state_file.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        code, out = run(project, "audit")
        check(code == 1 and "零份成品证据" in out, "审计抓出伪造的零证据通过")

    failed = [m for ok, m in results if not ok]
    print("\n" + "─" * 52)
    print(f"断言 {len(results) - len(failed)}/{len(results)} 通过")
    if failed:
        for item in failed:
            print(f"  未通过：{item}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())