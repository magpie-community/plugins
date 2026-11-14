// 零依赖 PNG 解码（8-bit，输出 RGB）。用途：扫码登录二维码转终端 ASCII。
// 仅解码，不写 PNG —— 生成图按响应字节原样落盘，不做任何重新编码。
import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 解码 PNG 为 RGB。返回 { width, height, data: Buffer(RGB interleaved) }。
 * 仅支持 8-bit、非隔行；不满足时抛错。
 */
export function decodePng(buf) {
  if (!buf || buf.length < 57 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("不是 PNG 文件");
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  let palette = null;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`不支持的 PNG 位深 ${bitDepth}（仅支持 8）`);
  if (interlace) throw new Error("不支持隔行扫描（Adam7）的 PNG");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的 PNG 颜色类型 ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= channels ? prev[x - channels] : 0;
      let val = rowIn[x];
      if (filter === 1) val += left;
      else if (filter === 2) val += up;
      else if (filter === 3) val += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        val += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      row[x] = val & 0xff;
    }
  }

  // 统一转 RGB
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < width * height; i++, j += 3) {
    const p = i * channels;
    let r = 0;
    let g = 0;
    let b = 0;
    if (colorType === 0) {
      r = g = b = pixels[p];
    } else if (colorType === 2 || colorType === 6) {
      r = pixels[p];
      g = pixels[p + 1];
      b = pixels[p + 2];
    } else if (colorType === 4) {
      r = g = b = pixels[p];
    } else if (colorType === 3) {
      const idx = pixels[p] * 3;
      r = palette[idx];
      g = palette[idx + 1];
      b = palette[idx + 2];
    }
    rgb[j] = r;
    rgb[j + 1] = g;
    rgb[j + 2] = b;
  }
  return { width, height, data: rgb };
}
