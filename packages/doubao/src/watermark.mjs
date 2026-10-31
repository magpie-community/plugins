// 去水印（扩图裁剪法，用户提供的思路）：
//   1) 把已生成的带水印原图作为参考图走图生图，提示词追加"往下扩图四分之一"
//      —— 模型重新演绎画面，原水印随之被清除，而新一轮水印落在底部新增区域
//   2) 下载扩图结果，把底部扩出来的部分裁掉（保留 1/(1+扩图比例)，默认 80%）
//   3) 用裁剪结果覆盖原文件
// 代价：多花一次生成额度；画面边缘会被模型重新演绎。
import { readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generate } from "./client.mjs";
import { downloadImage } from "./download.mjs";
import { cropPngBottom } from "./png.mjs";

/** 解析扩图比例配置（"1/4" / 0.25 / "0.25"），默认 0.25（四分之一）。 */
export function parseExtendFrac(v) {
  if (v === undefined || v === null || v === "") return 0.25;
  const s = String(v).trim();
  if (s.includes("/")) {
    const [a, b] = s.split("/").map(Number);
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) return a / b;
  }
  const n = Number(s);
  if (Number.isFinite(n) && n > 0 && n < 4) return n;
  return 0.25;
}

function describeFrac(frac) {
  const map = { 0.125: "八分之一", 0.2: "五分之一", 0.25: "四分之一", 0.5: "二分之一" };
  const key = Math.round(frac * 1e6) / 1e6;
  return map[key] || `百分之${Math.round(frac * 100)}`;
}

/**
 * 对一张已落盘的生成图执行扩图裁剪去水印，成功后覆盖 file。
 * 返回 { width, height, origHeight, extendFrac }；失败抛错（原文件不被破坏）。
 */
export async function removeWatermarkByExtend(cfg, { file, prompt, ratio, account }) {
  const extendFrac = parseExtendFrac(cfg.watermarkExtend);
  const keepFrac = 1 / (1 + extendFrac);
  // 扩图这步让模型自己决定输出几何（ratio=auto），几何由"往下扩图…"文本指令驱动
  const ext = await generate(cfg, {
    prompt: `${prompt}，往下扩图${describeFrac(extendFrac)}`,
    ratio: "auto",
    refImages: [file],
    account,
  });
  if (!ext.images?.length) throw new Error("扩图未返回图片");

  let dl = null;
  try {
    dl = await downloadImage(ext.images[0].url, tmpdir(), `doubao-extend-${Date.now()}`);
    const png = await readFile(dl.file);
    const cropped = cropPngBottom(png, keepFrac); // 非 PNG 会在此抛错，原文件不受影响
    await writeFile(file, cropped.buffer);
    return { width: cropped.width, height: cropped.height, origHeight: cropped.origHeight, extendFrac };
  } finally {
    if (dl) await rm(dl.file, { force: true });
  }
}
