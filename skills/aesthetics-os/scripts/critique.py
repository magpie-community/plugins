#!/usr/bin/env python3
"""审美质量判据：把鉴赏家协议工程化。

与 measure.py 的分工：
    measure   测结构（留白/边缘/色相）—— 不判美丑
    critique  判质量（红线/三轴/反射/结论）—— 必须由真实视觉执行

本脚本不“看”图，也绝不伪造审判。它只做四件事：
    prepare   生成结构化审判提示 + JSON schema（交给视觉模型执行）
    register  校验并登记一份视觉返回的审判结果，绑定到成品 sha256
    run       用 Agnes 多模态后端自动执行（需 key）；无 key 则拒绝并输出提示
    gate      供 aos.py verdict 调用：最新成品必须有绑定像素、结论 pass 的审判

红线：没有真实视觉结果，绝不签发质量结论。register 只接受完整结构，
任何一条红线 fail 而结论 pass、或匿名审判，都会被拒绝。
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
CST = timezone(timedelta(hours=8))

RED_LINES = ("CS", "FP", "TX", "AI", "CU", "CM")
RED_LINE_LABELS = {
    "CS": "内容安全", "FP": "多指畸形", "TX": "文字乱码",
    "AI": "塑料感", "CU": "文化禁忌", "CM": "构图失衡",
}
REFLEXES = ("purpose", "system", "material", "specificity", "restraint")
REFLEX_LABELS = {
    "purpose": "目的信号", "system": "系统一致", "material": "材质真实",
    "specificity": "具体性", "restraint": "克制",
}
CONCLUSIONS = ("pass", "revise", "reject")
STATUSES = ("pass", "warn", "fail")


def now() -> str:
    return datetime.now(CST).isoformat(timespec="microseconds")


def die(message: str) -> None:
    print(f"⛔ {message}", file=sys.stderr)
    raise SystemExit(1)


def image_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_taste(root: Path | None = None, override: str | None = None) -> dict:
    """优先级：--taste 指定 > 项目 .aos/taste-profile.json > 技能默认锚点。"""
    candidates = []
    if override:
        candidates.append(Path(override).expanduser())
    if root is not None:
        candidates.append(root / ".aos" / "taste-profile.json")
    candidates.append(SKILL_DIR / "references" / "taste-profile.json")
    for path in candidates:
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8"))
    return {"user_taste_coordinates": {"x": 0, "y": 0, "z": 0}}


def build_prompt(image_path: Path, state: dict | None = None,
                 taste: dict | None = None, json_only: bool = False) -> str:
    taste = taste or load_taste()
    coords = taste.get("user_taste_coordinates") or {}
    brief = (state or {}).get("brief") or {}
    proposal = (state or {}).get("proposal") or {}
    lines = [
        "你是鉴赏家，不是评委。只说你真实看见的，不堆形容词，不假装测到了语义/情绪。",
        f"审判对象：{image_path.name}",
    ]
    if proposal.get("text"):
        lines.append(f"审美命题：{proposal['text']}")
    if brief.get("purpose"):
        lines.append(f"目的：{brief['purpose']}｜受众：{brief.get('audience', '未写')}")
    if brief.get("signature"):
        lines.append(f"标志性动作：{brief['signature']}")
    if brief.get("non_goals"):
        lines.append("非目标：" + "、".join(brief["non_goals"]))
    lines += [
        "",
        "【6 红线】逐条判 pass/warn/fail 并给看见的证据：",
        "  CS 内容安全 / FP 多指畸形 / TX 文字乱码 / AI 塑料感(材质过度平滑) / CU 文化禁忌 / CM 构图失衡(主体贴边/地平线居中切割/头被裁)。",
        "【三轴】给坐标(-3 到 +3)：X 理法↔天机 / Y 饱满↔空灵 / Z 刚↔柔。",
        f"  品味锚点 X{coords.get('x', 0):+d} / Y{coords.get('y', 0):+d} / Z{coords.get('z', 0):+d}；偏离要说明是优点还是硬伤。",
        "【5 反射】每条写：看见的事实→形式机制→感知效果：",
        "  目的信号(第一眼知道是什么/视线先落哪) / 系统一致(是否服从少量规则) / 材质真实(光与纹理有无可信来源) / 具体性(换名字还能套给别的图吗) / 克制(有无多余竞争焦点)。",
        "【结论】pass 可交付 / revise 建议改 / reject 打回；非 pass 必须给一条最优先的具体修改（改哪个机制，不是“更好看”）。",
    ]
    if json_only:
        lines += [
            "",
            "只输出一个 JSON 对象，不要 markdown 围栏、不要解释。结构：",
            json.dumps(SCHEMA_EXAMPLE, ensure_ascii=False, indent=2),
        ]
    else:
        lines.append("用中文，结构化输出。")
    return "\n".join(lines)


SCHEMA_EXAMPLE = {
    "red_lines": {k: {"status": "pass", "evidence": "看见的具体证据"} for k in RED_LINES},
    "three_axis": {"x": 2, "y": 3, "z": 1, "note": "对照锚点的偏离说明"},
    "reflexes": {k: {"observed": "事实", "mechanism": "机制", "effect": "效果"} for k in REFLEXES},
    "conclusion": "pass",
    "priority_fix": "非 pass 时必填：最优先的具体修改",
    "judge": "vision_analyze / agnes-2.5-flash / human",
}


def validate_critique(result: dict) -> list[str]:
    problems: list[str] = []
    if not isinstance(result, dict):
        return["审判结果必须是 JSON 对象"]

    rl = result.get("red_lines") or {}
    for key in RED_LINES:
        item = rl.get(key)
        if not isinstance(item, dict):
            problems.append(f"缺红线 {key}（{RED_LINE_LABELS[key]}）")
            continue
        if item.get("status") not in STATUSES:
            problems.append(f"红线 {key} 状态非法（需 pass/warn/fail）")
        if len(str(item.get("evidence", "")).strip()) < 4:
            problems.append(f"红线 {key} 缺看见的证据")

    ta = result.get("three_axis") or {}
    for axis in ("x", "y", "z"):
        value = ta.get(axis)
        if not isinstance(value, int) or not -3 <= value <= 3:
            problems.append(f"三轴 {axis} 必须是 -3..3 的整数")

    rx = result.get("reflexes") or {}
    for key in REFLEXES:
        item = rx.get(key)
        if not isinstance(item, dict) or len(str(item.get("observed", "")).strip()) < 4:
            problems.append(f"反射 {key}（{REFLEX_LABELS[key]}）缺看见的事实")

    conclusion = result.get("conclusion")
    if conclusion not in CONCLUSIONS:
        problems.append("结论必须是 pass/revise/reject")

    fails = [k for k in RED_LINES if (rl.get(k) or {}).get("status") == "fail"]
    if fails and conclusion == "pass":
        problems.append(f"红线 {'、'.join(fails)} 为 fail 却判 pass：自相矛盾")

    if conclusion in ("revise", "reject") and len(str(result.get("priority_fix", "")).strip()) < 6:
        problems.append("revise/reject 必须给一条具体的优先修改")

    if not str(result.get("judge", "")).strip():
        problems.append("必须声明 judge（谁/什么视觉做的判断）：不接受匿名审判")
    return problems


def taste_deviation(result: dict, taste: dict) -> dict:
    ta = result.get("three_axis") or {}
    coords = taste.get("user_taste_coordinates") or {}
    return {a: int(ta.get(a, 0)) - int(coords.get(a, 0)) for a in ("x", "y", "z")}


def bind_critique(state: dict, image_path: Path, result: dict,
                  taste: dict | None = None) -> dict:
    problems = validate_critique(result)
    if problems:
        raise ValueError("；".join(problems))
    path = Path(image_path).expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"成品不存在：{image_path}")
    taste = taste or load_taste()
    record = {
        "path": str(path),
        "sha256": image_sha256(path),
        "conclusion": result["conclusion"],
        "judge": result.get("judge"),
        "three_axis": result.get("three_axis"),
        "taste_deviation": taste_deviation(result, taste),
        "result": result,
        "at": now(),
    }
    state.setdefault("critiques", []).append(record)
    return record


def critique_for_evidence(state: dict, evidence_record: dict) -> dict | None:
    digest = evidence_record.get("sha256")
    matches = [c for c in state.get("critiques", []) if c.get("sha256") == digest]
    return matches[-1] if matches else None


def critique_gate(state: dict) -> list[str]:
    """verdict --aesthetic pass 的质量门：最新成品必须被真实视觉评过且判 pass。"""
    refusals: list[str] = []
    evidence = state.get("evidence") or []
    if not evidence:
        return refusals
    latest = evidence[-1]
    critique = critique_for_evidence(state, latest)
    if critique is None:
        refusals.append("最新成品没有质量审判（critique）：测过结构≠评过质量，需真实视觉审过")
    elif critique.get("conclusion") != "pass":
        refusals.append(f"最新成品的审判结论是 {critique.get('conclusion')}，不能签审美通过")
    return refusals


# ---------- Agnes 多模态后端（可选自动执行） ----------

def run_agnes(image_path: Path, prompt: str) -> dict:
    key = os.environ.get("HERMES_CUSTOM_AGNES_API_KEY")
    if not key:
        die("没有 HERMES_CUSTOM_AGNES_API_KEY：改用 prepare → vision_analyze → register，不伪造审判。")
    try:
        from PIL import Image
    except ImportError:
        die("需要 Pillow：pip install pillow")
    img = Image.open(image_path).convert("RGB")
    img.thumbnail((1024, 1024))
    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=88)
    b64 = base64.b64encode(buffer.getvalue()).decode("ascii")
    payload = {
        "model": "agnes-2.5-flash",
        "max_tokens": 2000,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
        ]}],
    }
    import urllib.request
    request = urllib.request.Request(
        "https://apihub.agnes-ai.cn/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        data = json.loads(response.read().decode("utf-8"))
    text = data["choices"][0]["message"]["content"].strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.startswith("json"):
            text = text[4:]
    return json.loads(text)


# ---------- CLI ----------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="critique.py", description="审美质量判据（真实视觉执行）")
    parser.add_argument("--root", default=".", help="项目目录")
    sub = parser.add_subparsers(dest="command", required=True)

    prepare = sub.add_parser("prepare", help="生成审判提示（交给视觉模型）")
    prepare.add_argument("image")
    prepare.add_argument("--taste", help="品味锚点 JSON 路径")
    prepare.add_argument("--json-only", action="store_true", help="提示要求只输出 JSON")

    register = sub.add_parser("register", help="校验并登记一份视觉审判结果")
    register.add_argument("image")
    register.add_argument("--file", required=True, help="审判结果 JSON 文件")
    register.add_argument("--taste")

    run = sub.add_parser("run", help="用 Agnes 多模态自动审判（需 key）")
    run.add_argument("image")
    run.add_argument("--taste")

    args = parser.parse_args(argv)
    root = Path(args.root).expanduser().resolve()
    image = Path(args.image).expanduser()
    if not image.is_file():
        die(f"成品不存在：{args.image}")
    state_path = root / ".aos" / "state.json"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.is_file() else {}
    taste = load_taste(root, getattr(args, "taste", None))

    if args.command == "prepare":
        print(build_prompt(image, state, taste, json_only=args.json_only))
        print(f"\n# 成品哈希：{image_sha256(image)}")
        return 0

    if args.command == "register":
        result = json.loads(Path(args.file).expanduser().read_text(encoding="utf-8"))
        try:
            record = bind_critique(state, image, result, taste)
        except ValueError as error:
            die(f"审判结果不合格，拒绝登记：{error}")
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        dev = record["taste_deviation"]
        print(f"✅ 已登记质量审判：{image.name} → {record['conclusion']}（judge: {record['judge']}）")
        print(f"   三轴 X{record['three_axis']['x']:+d} Y{record['three_axis']['y']:+d} Z{record['three_axis']['z']:+d}"
              f"｜相对锚点偏离 X{dev['x']:+d} Y{dev['y']:+d} Z{dev['z']:+d}")
        return 0

    if args.command == "run":
        prompt = build_prompt(image, state, taste, json_only=True)
        result = run_agnes(image, prompt)
        result.setdefault("judge", "agnes-2.5-flash")
        try:
            record = bind_critique(state, image, result, taste)
        except ValueError as error:
            die(f"视觉返回的审判不合格，拒绝登记：{error}")
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"✅ Agnes 审判并登记：{image.name} → {record['conclusion']}")
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())