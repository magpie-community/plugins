#!/usr/bin/env python3
"""验证 Skill 文本文件的 UTF-8 编码与常见乱码。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


TEXT_SUFFIXES = {".md", ".yaml", ".yml", ".json", ".py", ".ps1"}
MOJIBAKE_MARKERS = (
    "\ufffd",
    "\u9422\u3124\u7c2c",
    "\u7039\uff04\u7de8",
    "\u951b",
    "\u9286",
    "\u9225",
)


def inspect_file(path: Path, root: Path) -> list[str]:
    errors: list[str] = []
    relative = path.relative_to(root)
    raw = path.read_bytes()

    if relative.as_posix() == "SKILL.md" and raw.startswith(b"\xef\xbb\xbf"):
        errors.append("SKILL.md 含 UTF-8 BOM，会破坏首字节 frontmatter 识别")

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        return [f"不是严格 UTF-8：{error}"]

    if relative.as_posix() == "SKILL.md":
        # CRLF 与 LF 都要认：Windows 上复制/编辑出来的 SKILL.md 是 CRLF，
        # 只匹配 "---\n" 会把合格文件误判为缺少 frontmatter。
        first_line = text.lstrip("\ufeff").split("\n", 1)[0].rstrip("\r")
        if first_line != "---":
            errors.append("SKILL.md 必须从 YAML frontmatter 的 --- 开始")

    found = [marker for marker in MOJIBAKE_MARKERS if marker in text]
    if found:
        escaped = ", ".join(repr(marker) for marker in found)
        errors.append(f"发现常见乱码标记：{escaped}")

    if path.suffix.lower() == ".json":
        try:
            json.loads(text)
        except json.JSONDecodeError as error:
            errors.append(f"JSON 解析失败：{error}")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="验证 Skill 文本文件采用严格 UTF-8 且没有常见乱码")
    parser.add_argument("skill_dir", type=Path, help="Skill 目录")
    args = parser.parse_args()

    root = args.skill_dir.resolve()
    if not (root / "SKILL.md").is_file():
        print(f"失败：{root} 中没有 SKILL.md", file=sys.stderr)
        return 2

    failures: list[tuple[Path, str]] = []
    checked = 0
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        if ".plugin-eval" in path.parts:
            continue
        checked += 1
        for message in inspect_file(path, root):
            failures.append((path.relative_to(root), message))

    if failures:
        print(f"编码验证失败：{len(failures)} 项", file=sys.stderr)
        for path, message in failures:
            print(f"- {path}: {message}", file=sys.stderr)
        return 1

    print(f"编码验证通过：{checked} 个文本文件均为严格 UTF-8，SKILL.md 无 BOM，未发现常见乱码")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
