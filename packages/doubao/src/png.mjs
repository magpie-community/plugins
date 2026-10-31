// 零依赖 PNG 解码 / 编码 / 裁剪（8-bit，bit depth 固定 8）。
// 解码支持 colorType 0/2/3/4/6，统一输出 RGB；编码输出 colorType 2（RGB）。
// 用途：扫码登录二维码转 ASCII、去水印的扩图裁剪。
import { inflateSync, deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 自带 CRC32（zlib.crc32 在部分 Bun 版本缺失，为兼容 Bun 宿主手动实现）
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

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

/** 把 RGB 像素编码为 PNG（colorType 2，filter 0）。 */
export function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * 裁掉 PNG 底部：保留顶部 keepTopFrac 比例（默认 0.8，对应"往下扩图四分之一"）。
 * 返回 { buffer, width, height, origHeight }；输入非 PNG 时抛错。
 */
export function cropPngBottom(pngBuf, keepTopFrac = 0.8) {
  const img = decodePng(pngBuf);
  const newHeight = Math.max(1, Math.round(img.height * keepTopFrac));
  const data = img.data.subarray(0, newHeight * img.width * 3);
  return {
    buffer: encodePng(img.width, newHeight, data),
    width: img.width,
    height: newHeight,
    origHeight: img.height,
  };
}
