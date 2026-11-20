#!/usr/bin/env python3
"""视觉证据测量：给出与画面内容无关的形式指纹。

为什么需要：`aos.py verdict` 原本只能证明「成品存在」，不能证明「看过」。
本模块把成品变成一组可比较的数值，让「看过」变成「测过」，
并让「只换皮」第一次可以被数值抓住——两张图指纹几乎相同，就是换皮。

指标都是无参考（no-reference）的形式量，不判断美丑，只描述结构：

    flat_area          与主色调接近的平坦区域占比 —— 留白/同底代理指标
    edge_density       强边缘像素占比 —— 拥挤/安静
    edge_mean          平均梯度强度 —— 细节密度
    contrast_range     p95−p5 明度跨度 —— 明暗张力
    entropy            明度直方图熵 —— 视觉信息量
    hue_concentration  最主色相族占比 —— 是否「只有一处重音」
    hue_families       达到 6% 的色相族数量 —— 色彩是否平均撒开
    sat_mean           平均饱和度
    dark_share         明度 <0.25 的占比
    light_share        明度 >0.75 的占比
    centroid_x/y       边缘能量重心（0–1）—— 视觉重力位置
    quadrant_*         四宫格边缘能量分布

明确做不到：文字面积、可读性、语义、情绪。这些仍要人看，不要假装测到了。

用法：
    python measure.py 图.png
    python measure.py 图.png --compare 另一张.png
    python measure.py 图.png --json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - 环境缺少 Pillow 时的明确失败
    Image = None

LONG_SIDE = 384
HUE_BINS = 12
FLAT_TOL = 0.04
EDGE_TOL = 0.08
CHROMA_TOL = 0.15

# 指标方向说明：None 表示无好坏方向，只作比较
DIRECTION = {
    "flat_area": None, "edge_density": None, "edge_mean": None,
    "contrast_range": None, "entropy": None, "hue_concentration": None,
    "hue_families": None, "sat_mean": None, "dark_share": None,
    "light_share": None, "centroid_x": None, "centroid_y": None,
    "quadrant_tl": None, "quadrant_tr": None, "quadrant_bl": None, "quadrant_br": None,
}

# 判定「换皮」的容差：任一指标超差即认为画面确实变了
REPAINT_TOLERANCE = 0.03


def _load(path: Path) -> tuple[int, int, list[tuple[int, int, int]]]:
    if Image is None:
        raise RuntimeError("需要 Pillow 解码图像：pip install pillow")
    with Image.open(path) as img:
        width, height = img.size
        rgb = img.convert("RGB")
        scale = max(1, round(max(width, height) / LONG_SIDE))
        if scale > 1:
            rgb = rgb.resize((max(1, width // scale), max(1, height // scale)), Image.BOX)
        data = rgb.tobytes()
    return width, height, data


def fingerprint(path: str | Path) -> dict:
    """返回形式指纹。路径不可读或无法解码时抛异常，不做静默兜底。"""
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"成品不存在：{path}")
    width, height, pixels = _load(path)
    if not pixels:
        raise ValueError(f"图像没有像素：{path}")

    scale = max(1, round(max(width, height) / LONG_SIDE))
    w = max(1, width // scale)
    h = max(1, len(pixels) // 3 // w)
    n = len(pixels) // 3

    lum = [0.0] * n
    hist = [0] * 256
    color_bins: dict[tuple[int, int, int], int] = {}
    hue_counts = [0] * HUE_BINS
    chromatic = 0
    sat_sum = 0.0
    dark = light = 0

    for index in range(n):
        base = index * 3
        r, g, b = pixels[base], pixels[base + 1], pixels[base + 2]
        rf, gf, bf = r / 255.0, g / 255.0, b / 255.0
        value = 0.2126 * rf + 0.7152 * gf + 0.0722 * bf
        lum[index] = value
        hist[min(255, int(value * 255))] += 1
        if value < 0.25:
            dark += 1
        elif value > 0.75:
            light += 1
        key = (r >> 3, g >> 3, b >> 3)
        color_bins[key] = color_bins.get(key, 0) + 1

        high, low = max(rf, gf, bf), min(rf, gf, bf)
        delta = high - low
        sat = 0.0 if high <= 0 else delta / high
        sat_sum += sat
        if sat > CHROMA_TOL and 0.10 < value < 0.95:
            chromatic += 1
            if delta == 0:
                hue = 0.0
            elif high == rf:
                hue = ((gf - bf) / delta) % 6
            elif high == gf:
                hue = (bf - rf) / delta + 2
            else:
                hue = (rf - gf) / delta + 4
            hue_counts[int(hue * HUE_BINS / 6) % HUE_BINS] += 1

    ordered = sorted(lum)
    def pct(q: float) -> float:
        return ordered[min(n - 1, max(0, int(q * (n - 1))))]

    mean_lum = sum(lum) / n
    entropy = 0.0
    for count in hist:
        if count:
            share = count / n
            entropy -= share * math.log2(share)

    modal_key, modal_count = max(color_bins.items(), key=lambda item: item[1])
    modal_rgb = tuple((value << 3) + 4 for value in modal_key)
    flat = 0
    for index in range(n):
        base = index * 3
        r, g, b = pixels[base], pixels[base + 1], pixels[base + 2]
        if (abs(r - modal_rgb[0]) <= FLAT_TOL * 255 + 4
                and abs(g - modal_rgb[1]) <= FLAT_TOL * 255 + 4
                and abs(b - modal_rgb[2]) <= FLAT_TOL * 255 + 4):
            flat += 1

    # 边缘：中心差分，边界像素按复制处理
    edges = 0
    edge_sum = 0.0
    moments = [0.0, 0.0]
    quad = [0.0, 0.0, 0.0, 0.0]
    for y in range(h):
        row = y * w
        for x in range(w):
            index = row + x
            left = lum[index - 1] if x > 0 else lum[index]
            right = lum[index + 1] if x < w - 1 else lum[index]
            up = lum[index - w] if y > 0 else lum[index]
            down = lum[index + w] if y < h - 1 and index + w < n else lum[index]
            magnitude = math.hypot(right - left, down - up) / 2
            edge_sum += magnitude
            if magnitude > EDGE_TOL:
                edges += 1
            moments[0] += magnitude * (x + 0.5) / w
            moments[1] += magnitude * (y + 0.5) / h
            quad[(0 if y < h / 2 else 2) + (0 if x < w / 2 else 1)] += magnitude

    weight = moments[0] + moments[1]
    if weight <= 0:
        centroid_x = centroid_y = 0.5
    else:
        centroid_x = moments[0] / (edge_sum or 1)
        centroid_y = moments[1] / (edge_sum or 1)
    quad_total = sum(quad) or 1.0

    chroma_total = chromatic or 1
    hue_shares = [count / chroma_total for count in hue_counts]
    hue_families = sum(1 for share in hue_shares if share >= 0.06)

    metrics = {
        "flat_area": round(flat / n, 4),
        "edge_density": round(edges / n, 4),
        "edge_mean": round(edge_sum / n, 4),
        "mean_lum": round(mean_lum, 4),
        "contrast_range": round(pct(0.95) - pct(0.05), 4),
        "entropy": round(entropy, 4),
        "hue_concentration": round(max(hue_shares), 4),
        "hue_families": hue_families,
        "sat_mean": round(sat_sum / n, 4),
        "chroma_share": round(chromatic / n, 4),
        "dark_share": round(dark / n, 4),
        "light_share": round(light / n, 4),
        "centroid_x": round(centroid_x, 4),
        "centroid_y": round(centroid_y, 4),
        "quadrant_tl": round(quad[0] / quad_total, 4),
        "quadrant_tr": round(quad[1] / quad_total, 4),
        "quadrant_bl": round(quad[2] / quad_total, 4),
        "quadrant_br": round(quad[3] / quad_total, 4),
        "aspect": round(width / height, 4),
        "pixels": f"{width}×{height}",
    }
    return metrics


def compare(a: dict, b: dict) -> list[tuple[str, float, float, float, float]]:
    """返回 (指标, A, B, 差, 相对差)。相对差用于判断是否只是换皮。"""
    rows = []
    for key in a:
        if key in ("pixels", "aspect", "hue_families"):
            continue
        left, right = float(a[key]), float(b[key])
        delta = right - left
        base = max(abs(left), abs(right), 1e-6)
        rows.append((key, left, right, round(delta, 4), round(abs(delta) / base, 4)))
    return rows


def looks_like_repaint(a: dict, b: dict) -> tuple[bool, str]:
    """两张图是否几乎相同（只换皮）。"""
    rows = compare(a, b)
    changed = [row for row in rows if row[4] > REPAINT_TOLERANCE]
    if a.get("aspect") and b.get("aspect") and abs(a["aspect"] - b["aspect"]) > 0.05:
        changed.append(("aspect", a["aspect"], b["aspect"], 0.0, 1.0))
    if changed:
        return False, "、".join(row[0] for row in changed[:4])
    return True, "所有形式指标差异均 <3%"


def _print(metrics: dict, title: str) -> None:
    print(f"{title}  {metrics['pixels']}")
    print("─" * 52)
    for key, value in metrics.items():
        if key == "pixels":
            continue
        print(f"  {key:18s} {value}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="视觉证据测量：形式指纹")
    parser.add_argument("image")
    parser.add_argument("--compare", help="与之对比的另一张成品")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args(argv)

    try:
        metrics = fingerprint(args.image)
    except Exception as error:  # noqa: BLE001 - 统一转成可读错误
        print(f"⛔ 测量失败：{error}", file=sys.stderr)
        return 1

    if args.json and not args.compare:
        print(json.dumps(metrics, ensure_ascii=False, indent=2))
        return 0

    _print(metrics, Path(args.image).name)
    if not args.compare:
        return 0

    try:
        other = fingerprint(args.compare)
    except Exception as error:  # noqa: BLE001
        print(f"⛔ 对比失败：{error}", file=sys.stderr)
        return 1

    rows = compare(metrics, other)
    print(f"\n对比 → {Path(args.compare).name}")
    print(f"{'指标':18s}{'A':>10s}{'B':>10s}{'Δ':>10s}")
    print("─" * 48)
    for key, left, right, delta, relative in rows:
        flag = "  ← 变化" if relative > REPAINT_TOLERANCE else ""
        print(f"{key:18s}{left:>10.4f}{right:>10.4f}{delta:>+10.4f}{flag}")
    repaint, reason = looks_like_repaint(metrics, other)
    print("─" * 48)
    print(f"{'⛔ 疑似只换皮：' if repaint else '✅ 画面确有变化：'}{reason}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())