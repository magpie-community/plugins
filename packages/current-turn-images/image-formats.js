import {inflateSync} from 'node:zlib';

const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function boundPngMetadata(type, payload) {
  // Ancillary compressed profiles/text must not bypass the image-size bound.
  let compressed;
  if (type === 'iCCP' || type === 'zTXt') {
    const zero = payload.indexOf(0);
    if (zero < 0 || payload[zero + 1] !== 0) throw new Error('invalid_image');
    compressed = payload.subarray(zero + 2);
  } else if (type === 'iTXt') {
    const zero = payload.indexOf(0);
    if (zero < 0) throw new Error('invalid_image');
    if (payload[zero + 1] === 1) {
      const language = payload.indexOf(0, zero + 3), translated = payload.indexOf(0, language + 1);
      if (language < 0 || translated < 0 || payload[zero + 2] !== 0) throw new Error('invalid_image');
      compressed = payload.subarray(translated + 1);
    }
  }
  if (compressed) {
    try { inflateSync(compressed, {maxOutputLength: 1024 * 1024}); }
    catch (error) { throw new Error(error.code === 'ERR_BUFFER_TOO_LARGE' ? 'metadata_limit' : 'invalid_image'); }
  }
}

export function inspectImage(data) {
  if (data.subarray(0, 8).equals(pngMagic)) {
    let position = 8;
    const metadata = [], chunks = [];
    let width, height, rawBytes, animated = false, end = false, frames = 1, sawIdat = false, firstControl = false, firstFrameInIdat = false;
    while (position + 12 <= data.length) {
      const size = data.readUInt32BE(position);
      if (position + size + 12 > data.length) throw new Error('invalid_image');
      const type = data.toString('ascii', position + 4, position + 8);
      const payload = data.subarray(position + 8, position + 8 + size);
      boundPngMetadata(type, payload);
      if (type === 'IHDR') {
        if (position !== 8 || size !== 13) throw new Error('invalid_image');
        width = payload.readUInt32BE(0); height = payload.readUInt32BE(4);
        const channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[payload[9]] || 4;
        rawBytes = Math.max(width * height * 4, (Math.ceil(width * channels * payload[8] / 8) + 8) * height);
      }
      if (type === 'acTL') {
        if (size !== 8 || !payload.readUInt32BE(0)) throw new Error('invalid_image');
        animated = true; frames = payload.readUInt32BE(0);
      }
      if (type === 'fcTL' && !firstControl) { firstControl = true; firstFrameInIdat = !sawIdat; }
      if (type === 'IDAT') sawIdat = true;
      if (type !== 'IDAT') metadata.push([type, payload.toString('base64')]);
      chunks.push({type, raw: data.subarray(position, position + size + 12)});
      position += size + 12;
      if (type === 'IEND') { end = true; break; }
    }
    if (!end || position !== data.length) throw new Error('invalid_image');
    if (animated && !firstFrameInIdat) frames++;
    return {format: 'png', width, height, frames, rawBytes, animated, metadata, chunks};
  }
  if (data[0] === 255 && data[1] === 216) {
    const metadata = [];
    let position = 2, width, height, sampleLayout, components, progressive = false;
    while (position < data.length) {
      if (data[position++] !== 255) throw new Error('invalid_image');
      while (data[position] === 255) position++;
      const marker = data[position++];
      if (marker === 0xda || marker === 0xd9) break;
      const size = data.readUInt16BE(position);
      if (size < 2 || position + size > data.length) throw new Error('invalid_image');
      const payload = data.subarray(position + 2, position + size);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        if (payload.length < 6) throw new Error('invalid_image');
        height = payload.readUInt16BE(1); width = payload.readUInt16BE(3);
        sampleLayout = payload.toString('base64');
        components = payload[5];
        progressive = [0xc2, 0xca].includes(marker);
      }
      if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) metadata.push([marker, payload.toString('base64')]);
      position += size;
    }
    if (!width || !height) throw new Error('invalid_image');
    return {format: 'jpeg', width, height, frames: 1, rawBytes: width * height * Math.max(4, components * 2), animated: false, metadata, sampleLayout, progressive};
  }
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    if (data.readUInt32LE(4) + 8 !== data.length) throw new Error('invalid_image');
    let position = 12, width, height, animated = false, frames = 0;
    const chunks = [], metadata = [];
    while (position + 8 <= data.length) {
      const type = data.toString('ascii', position, position + 4);
      const size = data.readUInt32LE(position + 4);
      const end = position + 8 + size + (size % 2);
      if (end > data.length) throw new Error('invalid_image');
      const payload = data.subarray(position + 8, position + 8 + size);
      if (type === 'VP8X' && size === 10) {
        width = payload.readUIntLE(4, 3) + 1; height = payload.readUIntLE(7, 3) + 1;
        animated = !!(payload[0] & 2);
      } else if (type === 'VP8L' && size >= 5 && payload[0] === 47) {
        const bits = payload.readUInt32LE(1);
        const w = (bits & 0x3fff) + 1, h = ((bits >>> 14) & 0x3fff) + 1;
        if ((width && width !== w) || (height && height !== h)) throw new Error('invalid_image');
        width ??= w; height ??= h;
      } else if (type === 'VP8 ' && size >= 10 && payload.subarray(3, 6).equals(Buffer.from([157, 1, 42]))) {
        const w = payload.readUInt16LE(6) & 0x3fff, h = payload.readUInt16LE(8) & 0x3fff;
        if ((width && width !== w) || (height && height !== h)) throw new Error('invalid_image');
        width ??= w; height ??= h;
      }
      if (type === 'ANIM' || type === 'ANMF') animated = true;
      if (type === 'ANMF') {
        if (size < 16 || !width || !height || payload.readUIntLE(0, 3) * 2 + payload.readUIntLE(6, 3) + 1 > width
          || payload.readUIntLE(3, 3) * 2 + payload.readUIntLE(9, 3) + 1 > height || payload[15] > 3) throw new Error('invalid_image');
        frames++;
      }
      const raw = data.subarray(position, end);
      chunks.push({type, raw});
      if (!['VP8 ', 'VP8L', 'ALPH'].includes(type)) metadata.push([type, (type === 'ANMF' ? payload.subarray(0, 16) : payload).toString('base64')]);
      position = end;
    }
    if (position !== data.length || !width || !height) throw new Error('invalid_image');
    return {format: 'webp', width, height, frames: frames || 1, animated, metadata, chunks};
  }
  if (['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) {
    if (data.length < 14) throw new Error('invalid_image');
    const width = data.readUInt16LE(6), height = data.readUInt16LE(8);
    let position = 13 + (data[10] & 128 ? 3 * (2 << (data[10] & 7)) : 0), frames = 0, delay = 0, transparent = null;
    const globalPalette = data.subarray(13, position);
    const metadata = [], delays = [], hiddenColors = [];
    function blocks() {
      const start = position;
      for (;;) {
        if (position >= data.length) throw new Error('invalid_image');
        const size = data[position++];
        if (!size) break;
        position += size;
        if (position > data.length) throw new Error('invalid_image');
      }
      return data.subarray(start, position);
    }
    let ended = false;
    while (position < data.length) {
      const tag = data[position++];
      if (tag === 59) { ended = true; break; }
      if (tag === 33) {
        const label = data[position++];
        const payload = blocks();
        if (label === 249) {
          if (payload.length !== 6 || payload[0] !== 4) throw new Error('invalid_image');
          delay = payload.readUInt16LE(2);
          transparent = payload[1] & 1 ? payload[4] : null;
        } else metadata.push([label, payload.toString('base64')]);
      } else if (tag === 44) {
        if (position + 9 > data.length) throw new Error('invalid_image');
        const frameWidth = data.readUInt16LE(position + 4), frameHeight = data.readUInt16LE(position + 6);
        if (data.readUInt16LE(position) + frameWidth > width || data.readUInt16LE(position + 2) + frameHeight > height) throw new Error('invalid_image');
        const flags = data[position + 8]; position += 9;
        let palette = globalPalette;
        if (flags & 128) {
          const size = 3 * (2 << (flags & 7));
          palette = data.subarray(position, position + size); position += size;
        }
        if (position >= data.length || data[position++] > 8) throw new Error('invalid_image');
        blocks(); frames++; delays.push(delay); delay = 0;
        hiddenColors.push(transparent === null ? null : Array.from(palette.subarray(transparent * 3, transparent * 3 + 3)));
        transparent = null;
      } else throw new Error('invalid_image');
    }
    if (!ended || position !== data.length || !frames) throw new Error('invalid_image');
    return {format: 'gif', width, height, frames, animated: frames > 1, metadata, delays, hiddenColors};
  }
  return {format: 'unsupported'};
}

export function preserveWebpMetadata(originalInfo, optimized) {
  // The Windows encoder cannot copy every metadata type; retain original chunks.
  const replacement = inspectImage(optimized).chunks?.filter(c => c.type === 'VP8L');
  if (replacement?.length !== 1) throw new Error('validation_failed');
  const chunks = [];
  let inserted = false;
  for (const chunk of originalInfo.chunks) {
    if (['VP8 ', 'VP8L', 'ALPH'].includes(chunk.type)) {
      if (!inserted) { chunks.push(replacement[0].raw); inserted = true; }
    } else chunks.push(chunk.raw);
  }
  if (!inserted) throw new Error('validation_failed');
  const header = Buffer.from('RIFF\0\0\0\0WEBP', 'binary');
  header.writeUInt32LE(4 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

export function preservePngMetadata(originalInfo, optimized) {
  // Take only the optimized image stream, not re-encoded iCCP/text metadata.
  const info = inspectImage(optimized);
  if (info.format !== 'png' || !same(originalInfo.metadata.find(c => c[0] === 'IHDR'), info.metadata.find(c => c[0] === 'IHDR'))) throw new Error('validation_failed');
  const replacement = info.chunks.filter(c => c.type === 'IDAT');
  if (!replacement.length) throw new Error('validation_failed');
  const chunks = [];
  let inserted = false;
  for (const chunk of originalInfo.chunks) {
    if (chunk.type === 'IDAT') {
      if (!inserted) { chunks.push(...replacement.map(c => c.raw)); inserted = true; }
    } else chunks.push(chunk.raw);
  }
  if (!inserted) throw new Error('validation_failed');
  return Buffer.concat([pngMagic, ...chunks]);
}

function riff(chunks) {
  const header = Buffer.from('RIFF\0\0\0\0WEBP', 'binary');
  header.writeUInt32LE(4 + chunks.reduce((n, chunk) => n + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

export function webpFrame(chunk) {
  // Optimize frame pixels as a static WebP; the original ANMF control header
  // retains offsets, duration, blending and disposal during reconstruction.
  const payload = chunk.raw.subarray(8, 8 + chunk.raw.readUInt32LE(4));
  const header = payload.subarray(0, 16);
  const width = header.readUIntLE(6, 3) + 1, height = header.readUIntLE(9, 3) + 1;
  const pixels = payload.subarray(16);
  const plain = riff([pixels]);
  const plainInfo = inspectImage(plain);
  if (plainInfo.width !== width || plainInfo.height !== height) throw new Error('validation_failed');
  if (!plainInfo.chunks.some(c => c.type === 'ALPH')) return plain;
  const extended = Buffer.alloc(18); extended.write('VP8X', 0, 'ascii'); extended.writeUInt32LE(10, 4);
  extended[8] = 16; // Preserve alpha, including RGB beneath fully transparent pixels.
  extended.writeUIntLE(width - 1, 12, 3); extended.writeUIntLE(height - 1, 15, 3);
  const body = riff([extended, pixels]);
  const info = inspectImage(body);
  if (info.animated || info.width !== width || info.height !== height) throw new Error('validation_failed');
  return body;
}

export function replaceWebpFrame(original, optimized) {
  const info = inspectImage(optimized);
  const pixels = info.chunks.filter(c => ['VP8L', 'VP8 ', 'ALPH'].includes(c.type)).map(c => c.raw);
  const frameHeader = original.raw.subarray(8, 24);
  const payload = Buffer.concat([frameHeader, ...pixels]);
  const chunk = Buffer.alloc(8); chunk.write('ANMF'); chunk.writeUInt32LE(payload.length, 4);
  return Buffer.concat([chunk, payload, ...(payload.length % 2 ? [Buffer.alloc(1)] : [])]);
}

export function repackWebp(chunks) {
  return riff(chunks);
}

export function sameImageProperties(before, after) {
  return before.format === after.format && before.width === after.width && before.height === after.height
    && before.frames === after.frames && before.animated === after.animated
    && same(before.metadata, after.metadata) && same(before.delays, after.delays)
    && (before.format !== 'jpeg' || (before.sampleLayout === after.sampleLayout && before.progressive === after.progressive))
    && (before.format !== 'gif' || before.hiddenColors.every((color, index) => color === null || same(color, after.hiddenColors[index])));
}
