#!/usr/bin/env python3
"""技能结构自检：参考篇四段式、交叉引用、路由覆盖、引号与换行一致性。

用法：
    python scripts/lint_skill.py [skill_dir]

退出码 0 表示全部通过；1 表示有失败项（逐条打印）；2 表示目录不对。

为什么需要它：SKILL.md 写明「理论只有转化为观察反射、取舍顺序或红线才进入
行动」。这句话如果不检查，新增的参考篇会退回纯百科，本技能自己就会违规。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# 每篇参考都必须具备的动作出口三节，加上入场声明
REQUIRED_SECTIONS = ("使用边界", "直觉化规则", "误用警报", "操作转译")

# 协议类文件不是参考篇：它们自带门槛结构，豁免四段式
PROTOCOL_EXEMPT = {
    "web-aesthetic-protocol.md": "协议：自带四道门槛与完成门槛",
    "product-aesthetic-os.md": "协议：自带通用质量门槛与品味审阅协议",
}

# 不参与参考篇检查的文件（内核与索引不是模块）
NON_REFERENCE = {"SKILL.md", "README.md", "README.en.md", "KERNEL.md"}

LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)#]+?)\)")
H2_RE = re.compile(r"^## (.+)$", re.M)
FENCE_RE = re.compile(r"```.*?```", re.S)


def check_frontmatter(skill_md: Path, errors: list[str]) -> None:
    text = skill_md.read_text(encoding="utf-8")
    first = text.lstrip("\ufeff").split("\n", 1)[0].rstrip("\r")
    if first != "---":
        errors.append("SKILL.md: 首行必须是 YAML frontmatter 的 ---")
        return
    block = text.split("\n---", 1)[0]
    for field in ("name:", "description:"):
        if not re.search(rf"^{field}", block, re.M):
            errors.append(f"SKILL.md: frontmatter 缺 {field[:-1]}")
    desc = re.search(r"^description:(.*)$", block, re.M)
    if desc and len(desc.group(1).strip()) > 120:
        errors.append(
            f"SKILL.md: description 过长（{len(desc.group(1).strip())} 字），"
            "索引与触发匹配字段应只写何时用，运维说明放正文"
        )


def check_links(root: Path, errors: list[str]) -> int:
    checked = 0
    for path in sorted(root.rglob("*.md")):
        for match in LINK_RE.finditer(path.read_text(encoding="utf-8")):
            target = match.group(2).strip()
            if target.startswith(("http://", "https://", "mailto:")):
                continue
            checked += 1
            if not (root / target).exists():
                errors.append(f"{path.relative_to(root)}: 坏链 → {target}")
    return checked


def check_references(root: Path, skill_text: str, errors: list[str]) -> tuple[int, int]:
    refs = [p for p in sorted(root.glob("*.md")) if p.name not in NON_REFERENCE]
    passed = 0
    for path in refs:
        if path.name in PROTOCOL_EXEMPT:
            continue
        text = path.read_text(encoding="utf-8")
        headings = {h.strip() for h in H2_RE.findall(text)}
        missing = [s for s in REQUIRED_SECTIONS if s not in headings]
        if missing:
            errors.append(f"{path.name}: 缺小节 {'、'.join(missing)}")
            continue
        if path.name not in skill_text:
            errors.append(f"{path.name}: 未被 SKILL.md 路由（agent 不会知道何时读它）")
            continue
        passed += 1
    return passed, len(refs)


def check_typography(root: Path, errors: list[str]) -> int:
    files = 0
    for path in sorted(root.rglob("*.md")):
        raw = path.read_bytes()
        if b"\r\n" in raw:
            errors.append(f"{path.relative_to(root)}: 含 CRLF，仓库统一 LF")
        text = raw.decode("utf-8")
        body = FENCE_RE.sub("", text)
        if '"' in body:
            errors.append(
                f"{path.relative_to(root)}: 代码块外有 {body.count(chr(34))} 个直引号，"
                "中文正文统一用 “ ”"
            )
        files += 1
    return files


def _strip_ordinal(text: str) -> str:
    return re.sub(r"^[一二三四五六七八九十]+、", "", text.strip())


def check_toc(root: Path, errors: list[str]) -> int:
    """有目录的文件，目录条目与实际二级小节必须互相覆盖。"""
    checked = 0
    for path in sorted(root.rglob("*.md")):
        lines = path.read_text(encoding="utf-8").split("\n")
        try:
            start = next(i for i, line in enumerate(lines) if line.strip() == "## 目录")
        except StopIteration:
            continue
        entries, cursor = [], start + 1
        while cursor < len(lines) and not lines[cursor].startswith("- "):
            if lines[cursor].startswith("## "):
                break
            cursor += 1
        while cursor < len(lines) and lines[cursor].startswith("- "):
            entries.append(lines[cursor][2:].strip())
            cursor += 1
        headings = [
            _strip_ordinal(h)
            for h in H2_RE.findall("\n".join(lines))
            if h.strip() not in {"目录", "使用边界"}
        ]
        missing_in_toc = [h for h in headings if not any(e in h or h in e for e in entries)]
        dead_entries = [e for e in entries if not any(e in h or h in e for h in headings)]
        for item in missing_in_toc:
            errors.append(f"{path.relative_to(root)}: 小节“{item}”未列入目录")
        for item in dead_entries:
            errors.append(f"{path.relative_to(root)}: 目录条目“{item}”没有对应小节")
        checked += 1
    return checked


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    skill_md = root / "SKILL.md"
    if not skill_md.is_file():
        print(f"失败：{root} 中没有 SKILL.md", file=sys.stderr)
        return 2

    errors: list[str] = []
    check_frontmatter(skill_md, errors)
    links = check_links(root, errors)
    passed, total = check_references(root, skill_md.read_text(encoding="utf-8"), errors)
    md_files = check_typography(root, errors)
    tocs = check_toc(root, errors)

    if errors:
        print(f"技能自检失败：{len(errors)} 项", file=sys.stderr)
        for message in errors:
            print(f"  - {message}", file=sys.stderr)
        return 1

    exempt = "、".join(f"{k}（{v}）" for k, v in PROTOCOL_EXEMPT.items())
    print(
        f"技能自检通过：{passed}/{total} 篇参考具备四段式，"
        f"{links} 条相对链接可解析，{tocs} 个目录与实际小节一致，"
        f"{md_files} 个 Markdown 文件引号与换行合规"
    )
    print(f"豁免：{exempt}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())