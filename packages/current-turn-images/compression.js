import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, readFile, unlink, rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {visitImages} from './filter.js';
import {inspectImage, preserveWebpMetadata, preservePngMetadata, sameImageProperties, webpFrame, replaceWebpFrame, repackWebp} from './image-formats.js';

const root = fileURLToPath(new URL('./bin/', import.meta.url));
const tools = {png: 'oxipng.exe', jpeg: 'jpegtran.exe', gif: 'gifsicle.exe', webp: 'cwebp.exe'};
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));
const verified = new Map();
let active = 0;

async function executable(name) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('tool_unavailable');
  const path = join(root, name);
  if (!verified.has(name)) verified.set(name, (async () => {
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    const bytes = await readFile(path);
    if (manifest.files[name] !== createHash('sha256').update(bytes).digest('hex')) throw new Error('tool_integrity');
    // jpegtran also loads its bundled decoder DLL.
    if (name === 'jpegtran.exe') {
      const dll = await readFile(join(root, 'jpeg62.dll'));
      if (manifest.files['jpeg62.dll'] !== createHash('sha256').update(dll).digest('hex')) throw new Error('tool_integrity');
    }
    return path;
  })());
  return verified.get(name);
}

async function run(name, args, input, limit, timeout, signal) {
  const path = await executable(name);
  if (signal?.aborted) throw new Error('aborted');
  return new Promise((resolve, reject) => {
    const environment = {};
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) environment[key] = process.env[key];
    // Native image tools do not need agent environment variables or credentials.
    const child = spawn(path, args, {windowsHide: true, shell: false, cwd: root, env: environment, stdio: ['pipe', 'pipe', 'pipe']});
    const chunks = [];
    let size = 0, errorBytes = 0, failure;
    const fail = reason => { failure ??= reason; child.kill(); };
    const abort = () => fail('aborted');
    const timer = setTimeout(() => fail('timeout'), timeout);
    signal?.addEventListener('abort', abort, {once: true});
    child.stdout.on('data', chunk => { size += chunk.length; if (size > limit) fail('output_limit'); else chunks.push(chunk); });
    child.stderr.on('data', chunk => { errorBytes += chunk.length; if (errorBytes > 65536) fail('output_limit'); });
    child.on('error', () => { failure ??= 'tool_unavailable'; });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      // JPEG/GIF warnings can signal repaired or truncated image data.
      if (failure || code !== 0 || (errorBytes && ['jpegtran.exe', 'gifsicle.exe', 'gifdiff.exe'].includes(name))) reject(new Error(failure || 'codec_failed'));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input ?? undefined);
  });
}

async function temporaryImages(before, after, operation) {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-lossless-'));
  const first = join(directory, 'input.image'), second = join(directory, 'output.image');
  try {
    await writeFile(first, before, {mode: 0o600});
    if (after) await writeFile(second, after, {mode: 0o600});
    return await operation(first, second);
  } finally {
    // Only the two exact files we created are removed, never a recursive path.
    await unlink(first).catch(() => {}); await unlink(second).catch(() => {});
    await rmdir(directory).catch(() => {});
  }
}

function reference(part) {
  if (part.source?.type === 'base64') return {data: part.source.data, mime: part.source.media_type, path: ['source', 'data']};
  for (const key of ['inlineData', 'inline_data']) if (part[key]) return {data: part[key].data, mime: part[key].mimeType || part[key].mime_type, path: [key, 'data']};
  if (part.type === 'image' && part.data) return {data: part.data, mime: part.mimeType || part.mime_type, path: ['data']};
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
  if (typeof url === 'string') {
    const match = /^(data:(image\/[^;,]+)(?:;[^,]*)?;base64,)([\s\S]*)$/i.exec(url);
    if (match) return {data: match[3], mime: match[2], prefix: match[1], path: typeof part.image_url === 'string' ? ['image_url'] : ['image_url', 'url']};
  }
  return null;
}

function replace(value, path, next) {
  if (!path.length) return next;
  const [key, ...remaining] = path;
  const copy = Array.isArray(value) ? value.slice() : {...value};
  copy[key] = replace(value[key], remaining, next);
  return copy;
}

function limits(options = {}) {
  const number = (name, fallback, low, high) => Number.isFinite(options[name]) ? Math.min(high, Math.max(low, options[name])) : fallback;
  return {enabled: options.enabled !== false, maxInputBytes: number('maxInputBytes', 8 * 1024 ** 2, 1024, 32 * 1024 ** 2),
    maxRawBytes: number('maxRawBytes', 64 * 1024 ** 2, 1024, 128 * 1024 ** 2),
    maxMilliseconds: number('maxMilliseconds', 2500, 50, 6000), toolMilliseconds: number('toolMilliseconds', 1000, 25, 3000)};
}

async function optimize(data, info, options, deadline, signal) {
  const timeout = () => Math.max(1, Math.min(options.toolMilliseconds, deadline - Date.now()));
  if (Date.now() >= deadline) throw new Error('budget_exhausted');
  const limit = Math.min(options.maxInputBytes * 2, data.length * 2 + 65536);
  let output;
  if (info.format === 'png') {
    output = await run(tools.png, ['-o', '2', '--nx', '--interlace', 'keep', '--threads', '1', '--max-raw-size', String(options.maxRawBytes), '--quiet', '--stdout', '-'], data, limit, timeout(), signal);
    output = preservePngMetadata(info, output);
  }
  else if (info.format === 'jpeg') output = await run(tools.jpeg, ['-copy', 'all', '-optimize', '-maxmemory', '64m', ...(info.progressive ? ['-progressive'] : [])], data, limit, timeout(), signal);
  else if (info.format === 'gif') {
    output = await run(tools.gif, ['--careful', '-O3'], data, limit, timeout(), signal);
    if (!sameImageProperties(info, inspectImage(output))) throw new Error('validation_failed');
    await temporaryImages(data, output, async (first, second) => {
      const diff = await run('gifdiff.exe', [first, second], null, 65536, timeout(), signal);
      if (diff.length) throw new Error('validation_failed');
    });
  } else if (info.format === 'webp') {
    if (info.animated) {
      const chunks = [];
      for (const chunk of info.chunks) {
        if (chunk.type !== 'ANMF' || Date.now() >= deadline) { chunks.push(chunk.raw); continue; }
        const originalFrame = webpFrame(chunk);
        try {
          const next = await optimize(originalFrame, inspectImage(originalFrame), options, deadline, signal);
          const rebuilt = replaceWebpFrame(chunk, next);
          chunks.push(rebuilt.length < chunk.raw.length ? rebuilt : chunk.raw);
        } catch { chunks.push(chunk.raw); }
      }
      output = repackWebp(chunks);
    } else {
      output = await temporaryImages(data, null, first => run(tools.webp, ['-quiet', '-lossless', '-exact', '-m', '4', '-metadata', 'all', first, '-o', '-'], null, limit, timeout(), signal));
      output = preserveWebpMetadata(info, output);
    }
  }
  if (!output || !sameImageProperties(info, inspectImage(output))) throw new Error('validation_failed');
  return output;
}

export async function compressRequest(body, protocol, options, signal) {
  const config = limits(options);
  const items = [];
  const key = protocol === 'responses' ? 'input' : protocol === 'gemini' ? 'contents' : ['chat', 'anthropic'].includes(protocol) ? 'messages' : null;
  if (key && Array.isArray(body?.[key])) body[key].forEach((message, messageIndex) => visitImages(message, protocol, (part, path) => items.push({part, path: [key, messageIndex, ...path], messageIndex})));
  const deadline = Date.now() + config.maxMilliseconds;
  const details = [];
  let outgoing = body;
  for (const item of items) {
    const detail = {messageIndex: item.messageIndex, path: item.path.slice(2), format: null, status: 'kept', reason: null};
    details.push(detail);
    if (!config.enabled) { detail.reason = 'disabled'; continue; }
    if (signal?.aborted) { detail.reason = 'aborted'; continue; }
    if (Date.now() >= deadline) { detail.reason = 'budget_exhausted'; continue; }
    const ref = reference(item.part);
    if (!ref || typeof ref.data !== 'string') { detail.reason = 'external_reference'; continue; }
    if (ref.data.length > config.maxInputBytes * 4 / 3 + 128) { detail.reason = 'input_limit'; continue; }
    const base64 = ref.data.replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) { detail.reason = 'invalid_base64'; continue; }
    const data = Buffer.from(base64, 'base64');
    if (data.toString('base64').replace(/=+$/, '') !== base64.replace(/=+$/, '')) { detail.reason = 'invalid_base64'; continue; }
    if (data.length > config.maxInputBytes) { detail.reason = 'input_limit'; continue; }
    detail.bytesBefore = data.length;
    try {
      const info = inspectImage(data);
      detail.format = info.format;
      if (info.format === 'unsupported') { detail.reason = 'unsupported_format'; continue; }
      if (info.format === 'png' && info.metadata.some(c => ['caBX', 'iDOT'].includes(c[0]))) { detail.reason = 'protected_metadata'; continue; }
      if (!info.width || !info.height || (info.rawBytes || info.width * info.height * 4) * info.frames > config.maxRawBytes) { detail.reason = 'raw_limit'; continue; }
      if (active >= 2) { detail.reason = 'busy'; continue; }
      active++;
      let output;
      try { output = await optimize(data, info, config, deadline, signal); } finally { active--; }
      if (output.length >= data.length) { detail.reason = 'not_smaller'; continue; }
      const next = replace(item.part, ref.path, (ref.prefix || '') + output.toString('base64'));
      if (jsonBytes(next) >= jsonBytes(item.part)) { detail.reason = 'not_smaller'; continue; }
      outgoing = replace(outgoing, item.path, next);
      detail.status = 'compressed'; detail.bytesAfter = output.length;
      detail.savedFileBytes = data.length - output.length;
      detail.savedJsonBytes = jsonBytes(item.part) - jsonBytes(next);
    } catch (error) {
      const known = ['invalid_image', 'metadata_limit', 'validation_failed', 'tool_unavailable', 'tool_integrity', 'aborted', 'timeout', 'output_limit', 'codec_failed', 'budget_exhausted'];
      detail.reason = known.includes(error.message) ? error.message : 'invalid_image';
    }
  }
  return {body: outgoing, details, compressedImages: details.filter(d => d.status === 'compressed').length,
    savedFileBytes: details.reduce((n, d) => n + (d.savedFileBytes || 0), 0), savedRequestBytes: jsonBytes(body) - jsonBytes(outgoing)};
}
