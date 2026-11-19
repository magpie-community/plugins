#!/usr/bin/env python3
"""aesthetics-OS 核心：把审美判断变成带状态、会拒绝的接口。

设计前提：散文可以被忽略，状态机不能。三条红线里最难守的是第一条
「未检查绝不通过」——所以本工具把「通过」钉死在一组可验证事实上：
简报完整、成品真实存在且被登记、技术验收已通过、被拒两次后必须出现新证据。
缺任何一项，`verdict --aesthetic pass` 直接拒绝执行，不写记录。

状态存放在被设计项目自己的 `.aos/state.json`，不放在技能目录：
品味是项目的记忆，不是工具的配置。

用法：
    python aos.py init [--project 名称]
    python aos.py propose "面向…完成…呈现…通过…"
    python aos.py decide "一个决策"          # 3–5 条
    python aos.py brief --purpose … --audience … --signature … \
                         --nongoal … --nongoal … --evidence 参考.png
    python aos.py evidence 成品.png --surface desktop
    python aos.py reject --direction "方向A" --mechanism "只换了字体和颜色"
    python aos.py checkpoint
    python aos.py verdict --tech pass --aesthetic pass --reason "…"
    python aos.py status | audit
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import measure as vmeasure  # noqa: E402  （同目录模块）
import critique as vcritique  # noqa: E402  （质量判据：真实视觉执行）

CST = timezone(timedelta(hours=8))
STATE_DIR = ".aos"
STATE_FILE = "state.json"

# 宽泛形容词：出现即必须映射到参数，否则拒绝写入命题
VAGUE_WORDS = (
    "高级感", "高级", "现代", "大气", "干净", "简约", "极简", "科技感",
    "人工智能感", "未来感", "氛围感", "国际范", "有质感", "精致",
)
PROPOSAL_MARKERS = ("面向", "完成", "呈现", "通过")
MIN_REASON_CHARS = 20


# ---------- 基础设施 ----------

def now() -> str:
    return datetime.now(CST).isoformat(timespec="microseconds")


def state_path(root: Path) -> Path:
    return root / STATE_DIR / STATE_FILE


def load(root: Path) -> dict | None:
    path = state_path(root)
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def save(root: Path, state: dict) -> None:
    path = state_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(
        json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(tmp, path)


def die(message: str) -> None:
    print(f"⛔ {message}", file=sys.stderr)
    raise SystemExit(1)


def require_state(root: Path) -> dict:
    state = load(root)
    if state is None:
        die("这里还没有审美状态。先运行：aos.py init")
    return state


# ---------- 媒体尺寸（不依赖第三方库）----------

def parse_media(path: Path) -> tuple[int, int, str]:
    """返回 (宽, 高, 格式)。无法解析尺寸时返回 (0, 0, 格式)。"""
    head = path.read_bytes()[:262144]
    if head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR":
        return int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big"), "png"
    if head[:3] == b"GIF":
        return int.from_bytes(head[6:8], "little"), int.from_bytes(head[8:10], "little"), "gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        chunk = head[12:16]
        if chunk == b"VP8X":
            return (
                1 + int.from_bytes(head[24:27], "little"),
                1 + int.from_bytes(head[27:30], "little"),
                "webp",
            )
        if chunk == b"VP8 ":
            return (
                int.from_bytes(head[26:28], "little") & 0x3FFF,
                int.from_bytes(head[28:30], "little") & 0x3FFF,
                "webp",
            )
        return 0, 0, "webp"
    if head[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(head):
            if head[i] != 0xFF:
                i += 1
                continue
            marker = head[i + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB):
                return (
                    int.from_bytes(head[i + 7:i + 9], "big"),
                    int.from_bytes(head[i + 5:i + 7], "big"),
                    "jpeg",
                )
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            length = int.from_bytes(head[i + 2:i + 4], "big")
            i += 2 + length if length >= 2 else 3
        return 0, 0, "jpeg"
    if head[:4] == b"%PDF":
        match = re.search(rb"/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)", head)
        if match:
            return (
                int(float(match.group(3)) - float(match.group(1))),
                int(float(match.group(4)) - float(match.group(2))),
                "pdf",
            )
        return 0, 0, "pdf"
    return 0, 0, path.suffix.lstrip(".").lower() or "unknown"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


# ---------- 命题检查 ----------

def check_proposal(text: str) -> list[str]:
    problems: list[str] = []
    missing = [m for m in PROPOSAL_MARKERS if m not in text]
    if missing:
        problems.append(
            "命题缺模板要素：" + "、".join(missing)
            + "（应写成：面向[受众]完成[任务]时呈现[情绪]，通过[形式]表达）"
        )
    for word in VAGUE_WORDS:
        for match in re.finditer(re.escape(word), text):
            tail = text[match.end():match.end() + 40]
            if not re.match(r"\s*=", tail):
                problems.append(
                    f"宽泛词「{word}」没有映射到参数（写成 {word}=参数1+参数2）"
                )
                break
    return problems


# ---------- 命令 ----------

def cmd_init(args: argparse.Namespace, root: Path) -> int:
    if load(root) is not None:
        print("已存在审美状态，未覆盖。")
        return 0
    state = {
        "version": 1,
        "project": args.project or root.name,
        "created_at": now(),
        "proposal": None,
        "brief": None,
        "evidence": [],
        "rejections": [],
        "verdicts": [],
    }
    save(root, state)
    print(f"✅ 已初始化：{state_path(root).relative_to(root)}（项目：{state['project']}）")
    return 0


def cmd_propose(args: argparse.Namespace, root: Path) -> int:
    state = require_state(root)
    problems = check_proposal(args.text)
    if problems:
        for problem in problems:
            print(f"⛔ {problem}", file=sys.stderr)
        print("未被接受的命题不会写入状态。", file=sys.stderr)
        return 1
    state["proposal"] = {"text": args.text.strip(), "at": now()}
    save(root, state)
    print(f"✅ 命题已记录：{args.text.strip()}")
    return 0


def cmd_decide(args: argparse.Namespace, root: Path) -> int:
    state = require_state(root)
    brief = state.get("brief") or {}
    decisions = brief.get("decisions", [])
    if len(decisions) >= 5:
        die("决策已满 5 条。删除冗余决策比继续添加更有效。")
    text = args.text.strip()
    if len(text) < 8:
        die("决策太短，不足以判断后果。写清它改变了哪个可见量。")
    decisions.append(text)
    brief["decisions"] = decisions
    state["brief"] = brief
    save(root, state)
    print(f"✅ 决策 {len(decisions)}/5：{text}")
    return 0


def cmd_brief(args: argparse.Namespace, root: Path) -> int:
    state = require_state(root)
    brief = state.get("brief") or {}
    evidence_refs: list[str] = []
    for item in args.evidence or []:
        path = Path(item).expanduser()
        if not path.is_file():
            die(f"参考证据不存在：{item}。形容词不是证据，文件才是。")
        evidence_refs.append(str(path.resolve()))
    if not evidence_refs and not brief.get("evidence_refs"):
        die("至少给一份可检查的参考证据（--evidence 图片/截图/URL 本地文件）。")

    for field, value in (
        ("purpose", args.purpose), ("audience", args.audience),
        ("signature", args.signature), ("dislike", args.dislike),
    ):
        if value:
            brief[field] = value.strip()
    if args.like:
        brief["like"] = args.like.strip()
    if evidence_refs:
        brief["evidence_refs"] = evidence_refs
    if args.nongoal:
        brief["non_goals"] = [item.strip() for item in args.nongoal if item.strip()]
    brief["at"] = now()
    state["brief"] = brief
    save(root, state)

    missing: list[str] = []
    for label, key, need in (
        ("目的", "purpose", 1), ("受众", "audience", 1), ("拒绝的机制", "dislike", 1),
        ("标志性动作", "signature", 1), ("参考证据", "evidence_refs", 1), ("非目标", "non_goals", 2),
    ):
        value = brief.get(key)
        if isinstance(value, list):
            if len(value) < need:
                missing.append(f"{label}（还差 {need - len(value)} 项）")
        elif not value:
            missing.append(label)
    decisions = len(brief.get("decisions", []))
    if decisions < 3:
        missing.append(f"决策（{decisions}/3，用 decide 添加）")

    if missing:
        print("当前简报还不完整：" + "、".join(missing))
        return 0
    print("✅ 品味简报完整，可以进入方向检查点。")
    return 0


def cmd_evidence(args: argparse.Namespace, root: Path) -> int:
    state = require_state(root)
    path = Path(args.path).expanduser()
    if not path.is_file():
        die(f"成品不存在：{args.path}。没渲染出来的东西不能算验收证据。")
    if path.stat().st_size == 0:
        die(f"成品是空文件：{args.path}")
    width, height, fmt = parse_media(path)
    record = {
        "path": str(path.resolve()),
        "sha256": sha256(path),
        "w": width, "h": height, "format": fmt,
        "surface": args.surface or "unspecified",
        "at": now(),
    }
    try:
        record["metrics"] = vmeasure.fingerprint(path)
        record["measured"] = True
    except Exception as error:  # noqa: BLE001 - 测量失败不阻断登记，但要留痕
        record["measured"] = False
        record["measure_error"] = str(error)
    state.setdefault("evidence", []).append(record)
    save(root, state)
    dims = f"{width}×{height}" if width else "尺寸未知"
    print(f"✅ 已登记成品 #{len(state['evidence'])}：{path.name}（{fmt} {dims}，{record['surface']}）")
    if record["measured"]:
        m = record["metrics"]
        print(
            f"   形式指纹：留白 {m['flat_area']:.0%}｜边缘密度 {m['edge_density']:.0%}"
            f"｜色相族 {m['hue_families']}｜熵 {m['entropy']:.2f}"
        )
    else:
        print(f"   ⚠️  未测量画面：{record['measure_error']}")
    if not width:
        print("   注意：读不出尺寸，验收时必须自己确认格式与尺寸。")
    return 0


def cmd_measure(args: argparse.Namespace, root: Path) -> int:
    path = Path(args.path).expanduser()
    try:
        metrics = vmeasure.fingerprint(path)
    except Exception as error:  # noqa: BLE001
        die(f"测量失败：{error}")

    print(f"{path.name}  {metrics['pixels']}")
    print("─" * 46)
    for key, value in metrics.items():
        if key == "pixels":
            continue
        print(f"  {key:18s} {value}")

    state = load(root)
    if state is not None:
        state.setdefault("measurements", []).append(
            {"path": str(path.resolve()), "sha256": sha256(path), "metrics": metrics, "at": now()}
        )
        save(root, state)
        print(f"   已写入项目测量记录（共 {len(state['measurements'])} 次）")

    if not args.compare:
        return 0

    other_path = Path(args.compare).expanduser()
    try:
        other = vmeasure.fingerprint(other_path)
    except Exception as error:  # noqa: BLE001
        die(f"对比失败：{error}")

    print(f"\n对比 → {other_path.name}")
    print(f"{'指标':18s}{'A':>10s}{'B':>10s}{'Δ':>10s}")
    print("─" * 48)
    for key, left, right, delta, relative in vmeasure.compare(metrics, other):
        flag = "  ← 变化" if relative > vmeasure.REPAINT_TOLERANCE else ""
        print(f"{key:18s}{left:>10.4f}{right:>10.4f}{delta:>+10.4f}{flag}")
    repaint, reason = vmeasure.looks_like_repaint(metrics, other)
    print("─" * 48)
    print(f"{'⛔ 疑似只换皮：' if repaint else '✅ 画面确有变化：'}{reason}")
    return 0


def cmd_reject(args: argparse.Namespace, root: Path) -> int:
    state = require_state(root)
    if not args.mechanism or len(args.mechanism.strip()) < 6:
        die("必须写清失败的形式机制（不是“不好看”，而是哪个机制没成立）。")
    state.setdefault("rejections", []).append(
        {"direction": args.direction.strip(), "mechanism": args.mechanism.strip(), "at": now()}
    )
    save(root, state)
    count = len(state["rejections"])
    print(f"✅ 已记录被拒方向 #{count}")
    if count >= 2:
        print("   两个方向被拒：下一个方向必须先有新证据，不能只换皮。")
    return 0


def gate_report(state: dict) -> list[tuple[bool, str]]:
    gates: list[tuple[bool, str]] = []
    proposal = state.get("proposal") or {}
    gates.append((bool(proposal), "审美命题" if proposal else "审美命题（用 propose 写一句）"))

    brief = state.get("brief") or {}
    needed = {
        "purpose": "目的", "audience": "受众", "dislike": "拒绝的机制", "signature": "标志性动作",
    }
    brief_missing = [label for key, label in needed.items() if not brief.get(key)]
    if len(brief.get("decisions") or []) < 3:
        brief_missing.append(f"决策 {len(brief.get('decisions') or [])}/3")
    if len(brief.get("non_goals") or []) < 2:
        brief_missing.append("非目标 <2")
    if not brief.get("evidence_refs"):
        brief_missing.append("参考证据")
    gates.append((not brief_missing, "品味简报" if not brief_missing else f"品味简报缺 {'、'.join(brief_missing)}"))

    evidence = state.get("evidence") or []
    gates.append((len(evidence) >= 2, f"成品证据 {len(evidence)} 份（需 ≥2，覆盖不同断点或状态）"))
    widths = {item["w"] for item in evidence if item.get("w")}
    gates.append((len(widths) >= 2 or not widths, f"尺寸覆盖 {len(widths)} 种宽度"))

    rejections = state.get("rejections") or []
    if len(rejections) >= 2:
        last_reject = rejections[-1]["at"]
        fresh = [e for e in evidence if e["at"] > last_reject]
        gates.append((bool(fresh), "两次被拒后是否有新证据" if fresh else "两次被拒后没有新证据（只换皮）"))
    return gates


def cmd_checkpoint(args: argparse.Namespace, root: Path) -> int:
    state = require_state(root)
    gates = gate_report(state)
    print("方向检查点")
    print("─" * 46)
    for ok, label in gates:
        print(f"{'✅' if ok else '⛔'} {label}")
    ready = all(ok for ok, _ in gates)
    print("─" * 46)
    print("可以进入完整实现。" if ready else "未通过：先补齐上面的缺口，不要投入完整实现预算。")
    return 0 if ready else 1


def cmd_verdict(args: argparse.Namespace, root: Path) -> int:
    state = require_state(root)
    aesthetic = args.aesthetic
    reason = (args.reason or "").strip()

    if aesthetic == "pass":
        refusals: list[str] = []
        for ok, label in gate_report(state):
            if not ok:
                refusals.append(label)
        measured = [item for item in (state.get("evidence") or []) if item.get("measured")]
        if not measured:
            refusals.append("没有任何可测量的成品证据：画面未被测量，等于没看过")
        refusals.extend(vcritique.critique_gate(state))
        rejections = state.get("rejections") or []
        all_evidence = state.get("evidence") or []
        if rejections and len(all_evidence) >= 2:
            last_reject = rejections[-1]["at"]
            after = [e for e in all_evidence if e["at"] > last_reject and e.get("metrics")]
            before = [e for e in all_evidence if e["at"] <= last_reject and e.get("metrics")]
            if after and before:
                same, why = vmeasure.looks_like_repaint(before[-1]["metrics"], after[-1]["metrics"])
                if same:
                    refusals.append(
                        f"被拒后提交的成品与之前几乎相同（{why}）：这是换皮，不是新方向"
                    )
        if args.tech != "pass":
            refusals.append(f"技术验收不是 pass（当前 {args.tech}）")
        if len(reason) < MIN_REASON_CHARS:
            refusals.append(f"审美结论理由不足 {MIN_REASON_CHARS} 字（现在 {len(reason)} 字）")
        if refusals:
            print("⛔ 拒绝签发「审美通过」：", file=sys.stderr)
            for item in refusals:
                print(f"   - {item}", file=sys.stderr)
            print(
                "未签发任何结论。只能说「技术通过，审美暂定」。", file=sys.stderr
            )
            return 1

    record = {
        "tech": args.tech, "aesthetic": aesthetic, "reason": reason,
        "evidence_n": len(state.get("evidence") or []), "at": now(),
    }
    state.setdefault("verdicts", []).append(record)
    save(root, state)

    print("验收结论")
    print("─" * 46)
    print(f"技术状态：{args.tech}")
    print(f"审美状态：{aesthetic}")
    print(f"证据：{record['evidence_n']} 份成品｜被拒方向 {len(state.get('rejections') or [])} 个")
    if aesthetic == "pass":
        print(f"最强决定与最大弱点：{reason}")
    else:
        print(f"理由：{reason or '（未写）'}")
    return 0


def cmd_status(args: argparse.Namespace, root: Path) -> int:
    state = require_state(root)
    proposal = state.get("proposal") or {}
    brief = state.get("brief") or {}
    print(f"项目：{state['project']}    状态文件：{state_path(root).relative_to(root)}")
    print("─" * 46)
    print(f"命题：{proposal.get('text', '——')}")
    print(f"决策：{len(brief.get('decisions') or [])} 条｜非目标：{len(brief.get('non_goals') or [])} 条")
    print(f"成品证据：{len(state.get('evidence') or [])} 份｜被拒方向：{len(state.get('rejections') or [])} 个")
    verdicts = state.get("verdicts") or []
    if verdicts:
        last = verdicts[-1]
        print(f"最近结论：技术 {last['tech']}／审美 {last['aesthetic']}（{last['at']}）")
    else:
        print("最近结论：尚未验收")
    measured = [item for item in (state.get("evidence") or []) if item.get("measured")]
    if measured:
        m = measured[-1]["metrics"]
        print(
            f"最近指纹：留白 {m['flat_area']:.0%}｜边缘密度 {m['edge_density']:.0%}"
            f"｜色相族 {m['hue_families']}｜重心 ({m['centroid_x']:.2f}, {m['centroid_y']:.2f})"
        )
    critiques = state.get("critiques") or []
    if critiques:
        last = critiques[-1]
        ta = last.get("three_axis") or {}
        print(
            f"最近审判：{last['conclusion']}（judge: {last.get('judge')}）"
            f"｜三轴 X{ta.get('x', 0):+d} Y{ta.get('y', 0):+d} Z{ta.get('z', 0):+d}"
        )
    else:
        print("最近审判：尚未做质量审判（critique）")
    rounds = state.get("rounds") or []
    if rounds:
        print(f"迭代轮次：{len(rounds)} 轮")
    return 0


def cmd_audit(args: argparse.Namespace, root: Path) -> int:
    state = require_state(root)
    problems: list[str] = []
    warnings: list[str] = []
    verdicts = state.get("verdicts") or []
    evidence = state.get("evidence") or []
    rejections = state.get("rejections") or []
    measured = [item for item in evidence if item.get("measured")]

    for index, verdict in enumerate(verdicts, 1):
        if verdict["aesthetic"] == "pass" and verdict.get("evidence_n", 0) == 0:
            problems.append(f"第 {index} 次验收声称通过，但零份成品证据")
        if verdict["aesthetic"] == "pass" and len(verdict.get("reason", "")) < MIN_REASON_CHARS:
            problems.append(f"第 {index} 次验收通过，但理由不足 {MIN_REASON_CHARS} 字")
        if verdict["aesthetic"] == "pass" and verdict.get("tech") != "pass":
            problems.append(f"第 {index} 次验收技术未通过却签了审美通过")

    passes = sum(1 for v in verdicts if v["aesthetic"] == "pass")
    if passes >= 3 and not rejections:
        warnings.append(f"{passes} 次验收全部通过、零次被拒：疑似空过，需要一次独立复核")
    if evidence and (state.get("brief") or {}).get("at"):
        brief_at = datetime.fromisoformat((state.get("brief") or {}).get("at"))
        quick = [
            e for e in evidence
            if (datetime.fromisoformat(e["at"]) - brief_at).total_seconds() < 60
        ]
        if quick:
            warnings.append(f"{len(quick)} 份成品在简报后 60 秒内登记：疑似未真正检查")
    proposal = state.get("proposal") or {}
    if proposal:
        for issue in check_proposal(proposal["text"]):
            problems.append(issue)

    # 有成品但一张都没测量：等于「看过」这件事没有证据
    if evidence and not measured:
        problems.append(f"{len(evidence)} 份成品全部未测量：没有可比较的形式指纹")

    # 质量审判一致性：签了审美通过，最新成品却没有 pass 的审判
    if evidence and any(v["aesthetic"] == "pass" for v in verdicts):
        latest_critique = vcritique.critique_for_evidence(state, evidence[-1])
        if latest_critique is None:
            problems.append("签了审美通过，但最新成品没有质量审判（critique）：测过结构≠评过质量")
        elif latest_critique.get("conclusion") != "pass":
            problems.append(
                f"签了审美通过，但最新成品审判结论是 {latest_critique.get('conclusion')}"
            )

    # 换皮检测：最后一次被拒之后提交的成品，与之前几乎相同
    if rejections and len(evidence) >= 2:
        last_reject = rejections[-1]["at"]
        after = [e for e in evidence if e["at"] > last_reject and e.get("metrics")]
        before = [e for e in evidence if e["at"] <= last_reject and e.get("metrics")]
        if after and before:
            same, why = vmeasure.looks_like_repaint(before[-1]["metrics"], after[-1]["metrics"])
            if same:
                problems.append(f"被拒后提交的成品与之前几乎相同（{why}）：只换皮")

    # 决策声明的数值与实测矛盾（启发式，仅对「留白 N%」这类可测声明生效）
    for decision in (state.get("brief") or {}).get("decisions") or []:
        match = re.search(r"留白[^0-9]{0,10}(\d{2,3})\s*%", decision)
        if match and measured:
            target = int(match.group(1)) / 100
            actual = measured[-1]["metrics"]["flat_area"]
            lower_bound = any(word in decision for word in ("不低于", "至少", "≥", "以上"))
            if lower_bound:
                if actual < target - 0.05:
                    warnings.append(
                        f"决策写「{decision}」，实测平坦区域 {actual:.0%}，低于下界 {target:.0%}"
                    )
            elif abs(actual - target) > 0.15:
                warnings.append(
                    f"决策写「{decision}」，实测平坦区域 {actual:.0%}，差 {abs(actual - target):.0%}"
                )
    if not verdicts and (state.get("brief") or {}).get("at"):
        age = datetime.now(CST) - datetime.fromisoformat(state["brief"]["at"])
        if age.days >= 7:
            warnings.append(f"简报建立 {age.days} 天仍未验收")

    print("审美审计")
    print("─" * 46)
    if problems:
        for item in problems:
            print(f"⛔ {item}")
    if warnings:
        for item in warnings:
            print(f"⚠️  {item}")
    if not problems and not warnings:
        print("✅ 未发现空过、空证据或只换皮迹象")
        return 0
    return 1 if problems else 0


# ---------- 入口 ----------

def cmd_critique(args: argparse.Namespace, root: Path) -> int:
    argv = ["--root", str(root), args.action, args.image]
    if args.taste:
        argv += ["--taste", args.taste]
    if args.action == "register":
        if not args.file:
            die("register 需要 --file 指向视觉审判结果 JSON。")
        argv += ["--file", args.file]
    if args.action == "prepare" and args.json_only:
        argv += ["--json-only"]
    return vcritique.main(argv)


def cmd_loop(args: argparse.Namespace, root: Path) -> int:
    state = require_state(root)
    path = Path(args.image).expanduser()
    if not path.is_file():
        die(f"成品不存在：{args.image}。没渲染出来的东西不能算迭代。")
    digest = sha256(path)
    rounds = state.setdefault("rounds", [])
    metrics = None
    changed = None
    try:
        metrics = vmeasure.fingerprint(path)
        if rounds and rounds[-1].get("metrics"):
            same, _ = vmeasure.looks_like_repaint(rounds[-1]["metrics"], metrics)
            changed = not same
    except Exception:  # noqa: BLE001
        pass
    rounds.append({
        "n": len(rounds) + 1, "path": str(path.resolve()), "sha256": digest,
        "fix": (args.fix or "").strip(), "metrics": metrics,
        "changed_from_prev": changed, "at": now(),
    })
    save(root, state)
    print(f"✅ 迭代轮次 #{len(rounds)} 已记录：{path.name}")
    if args.fix:
        print(f"   本轮改动：{args.fix}")
    if changed is False:
        print("   ⛔ 与上一轮指纹几乎相同：这一轮没有真正改动（换皮）")
    elif changed:
        print("   画面确有变化")
    critique = vcritique.critique_for_evidence(state, {"sha256": digest})
    if critique:
        print(f"   本轮质量审判：{critique['conclusion']}（judge: {critique.get('judge')}）")
    else:
        print("   本轮尚无质量审判：critique register 后才算评过质量")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="aos.py", description="aesthetics-OS 核心：带状态、会拒绝的审美判断接口"
    )
    parser.add_argument("--root", default=".", help="项目目录（默认当前目录）")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="初始化项目审美状态")
    init.add_argument("--project", help="项目名（默认目录名）")
    init.set_defaults(func=cmd_init)

    propose = sub.add_parser("propose", help="写入审美命题（必须合模板且宽泛词已映射）")
    propose.add_argument("text")
    propose.set_defaults(func=cmd_propose)

    decide = sub.add_parser("decide", help="添加一条决策（3–5 条）")
    decide.add_argument("text")
    decide.set_defaults(func=cmd_decide)

    brief = sub.add_parser("brief", help="建立品味简报")
    brief.add_argument("--purpose"); brief.add_argument("--audience")
    brief.add_argument("--like"); brief.add_argument("--dislike")
    brief.add_argument("--signature"); brief.add_argument("--nongoal", action="append")
    brief.add_argument("--evidence", action="append")
    brief.set_defaults(func=cmd_brief)

    evidence = sub.add_parser("evidence", help="登记一份真实成品（含哈希与尺寸）")
    evidence.add_argument("path")
    evidence.add_argument("--surface", help="desktop / mobile / state / export")
    evidence.set_defaults(func=cmd_evidence)

    measure_cmd = sub.add_parser("measure", help="测量画面形式指纹，可与另一张对比")
    measure_cmd.add_argument("path")
    measure_cmd.add_argument("--compare", help="与之对比的另一张成品")
    measure_cmd.set_defaults(func=cmd_measure)

    reject = sub.add_parser("reject", help="记录被拒方向与失败机制")
    reject.add_argument("--direction", required=True)
    reject.add_argument("--mechanism", required=True)
    reject.set_defaults(func=cmd_reject)

    checkpoint = sub.add_parser("checkpoint", help="方向检查点")
    checkpoint.set_defaults(func=cmd_checkpoint)

    verdict = sub.add_parser("verdict", help="签发验收结论（通过需要证据）")
    verdict.add_argument("--tech", required=True, choices=("pass", "fail"))
    verdict.add_argument("--aesthetic", required=True, choices=("pass", "hold", "revise"))
    verdict.add_argument("--reason", default="")
    verdict.set_defaults(func=cmd_verdict)

    status = sub.add_parser("status", help="查看项目审美状态")
    status.set_defaults(func=cmd_status)

    audit = sub.add_parser("audit", help="审计是否空过、空证据或只换皮")
    audit.set_defaults(func=cmd_audit)

    critique_cmd = sub.add_parser("critique", help="质量审判：prepare 提示 / register 登记 / run 自动")
    critique_cmd.add_argument("action", choices=("prepare", "register", "run"))
    critique_cmd.add_argument("image")
    critique_cmd.add_argument("--file", help="register 用：视觉审判结果 JSON")
    critique_cmd.add_argument("--taste", help="品味锚点 JSON 路径")
    critique_cmd.add_argument("--json-only", action="store_true", help="prepare 要求只输出 JSON")
    critique_cmd.set_defaults(func=cmd_critique)

    loop_cmd = sub.add_parser("loop", help="记录一轮生成→测量→审判迭代，并检测是否真改动")
    loop_cmd.add_argument("image")
    loop_cmd.add_argument("--fix", help="本轮相对上一轮改了什么机制")
    loop_cmd.set_defaults(func=cmd_loop)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = Path(args.root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    return args.func(args, root)


if __name__ == "__main__":
    raise SystemExit(main())