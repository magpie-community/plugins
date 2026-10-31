// 图片下载落盘。按魔数识别真实格式，content-type 兜底。
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { USER_AGENT, DoubaoError } from "./http.mjs";

/** 文件大小（字节），失败返回 0。 */
export async function fileSize(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

const EXT_BY_CONTENT_TYPE = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function sniffExt(buf, contentType) {
  if (buf.length > 8) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
    if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
    if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "gif";
  }
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  return EXT_BY_CONTENT_TYPE[ct] || "png";
}

/** 下载一张图到 outDir，返回 { file, bytes }。 */
export async function downloadImage(url, outDir, baseName) {
  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Referer: "https://www.doubao.com/" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) throw new DoubaoError(`图片下载失败 (${resp.status}): ${url.slice(0, 120)}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new DoubaoError(`图片下载为空: ${url.slice(0, 120)}`);
  const ext = sniffExt(buf, resp.headers.get("content-type"));
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `${baseName}.${ext}`);
  await writeFile(file, buf);
  return { file, bytes: buf.length };
}

/** yyyymmddHHMMSS 时间戳，用于文件名。 */
export function fileStamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}
