import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {applies, enabled, isLocal} from './common.js';

const stores = new Map();
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const bounded = (value, fallback, max) => Number.isFinite(Number(value)) ? Math.max(1, Math.min(Math.floor(Number(value)), max)) : fallback;

function prune(s) {
  const now = Date.now();
  s.entries = new Map([...s.entries].filter(([, at]) => at >= now - s.days * 86400000 && at <= now)
    .sort((a, b) => a[1] - b[1]).slice(-s.cap));
}

async function read(s, ctx) {
  let raw;
  try { raw = await readFile(s.file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let saved;
  try {
    saved = JSON.parse(raw);
    if (!saved || !Array.isArray(saved.entries)) throw new Error('Invalid ledger');
  } catch {
    ctx.report?.('invalid', 0);
    await rename(s.file, s.file + '.corrupt.' + randomUUID());
    return;
  }
  for (const entry of saved.entries) {
    const at = entry?.verifiedAt ?? entry?.expires;
    if (/^[a-f0-9]{64}$/.test(entry?.hash) && typeof at === 'number' && Number.isFinite(at)) {
      s.entries.set(entry.hash, Math.max(s.entries.get(entry.hash) || 0, at));
    }
  }
}

async function store(ctx) {
  const file = ctx.options?.ledgerPath || path.join(os.homedir(), '.config', 'magpie', 'agent-message-compat', 'provenance.json');
  const cap = bounded(ctx.options?.ledgerMaxEntries ?? 2048, 2048, 10000);
  const days = bounded(ctx.options?.ledgerMaxAgeDays ?? 30, 30, 365);
  const key = JSON.stringify([file, cap, days, ctx.options?.provenanceRevision]);
  if (!stores.has(key)) {
    const loading = (async () => {
      const s = {file, cap, days, entries: new Map(), pending: Promise.resolve()};
      await read(s, ctx); prune(s); return s;
    })();
    stores.set(key, loading);
    loading.catch(() => stores.delete(key));
  }
  return stores.get(key);
}

function remember(s, items) {
  prune(s);
  let changed = false;
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.type !== 'function_call' || !['agents', 'collaboration'].includes(item.namespace) ||
        !['spawn_agent', 'followup_task', 'send_message'].includes(item.name) ||
        !Array.isArray(item.encrypted_function_args) || item.encrypted_function_args.length !== 0) continue;
    try {
      const args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments;
      if (typeof args?.message !== 'string' || !args.message.trim()) continue;
      const key = hash(args.message);
      if (!s.entries.has(key)) {
        s.entries.set(key, Date.now()); changed = true;
      }
    } catch { /* Invalid arguments provide no evidence. */ }
  }
  return changed;
}

async function save(s, ctx) {
  s.pending = s.pending.catch(() => {}).then(async () => {
    await read(s, ctx); prune(s);
    const entries = [...s.entries].map(([hash, verifiedAt]) => ({hash, verifiedAt}));
    await mkdir(path.dirname(s.file), {recursive: true});
    const tmp = s.file + '.' + randomUUID() + '.tmp';
    await writeFile(tmp, JSON.stringify({version: 2, entries}), {encoding: 'utf8', mode: 0o600});
    await rename(tmp, s.file);
  });
  await s.pending;
}

export async function onResponse(reply, ctx) {
  if (!enabled(ctx) || !isLocal(ctx) || ctx.protocol !== 'responses' || ctx.success !== true) return;
  try {
    const s = await store(ctx);
    if (remember(s, reply?.output)) await save(s, ctx);
  } catch { ctx.report?.('unavailable', 0); }
}

export async function onRequest(body, ctx) {
  if (!enabled(ctx) || !isLocal(ctx) || ctx.protocol !== 'responses' || !Array.isArray(body?.input)) return;
  try {
    const s = await store(ctx);
    if (remember(s, body.input)) await save(s, ctx);
    if (!applies(body, ctx) || ctx.signal?.aborted) return;
    prune(s);
    const known = p => typeof p.encrypted_content === 'string' && s.entries.has(hash(p.encrypted_content));
    let changed = false;
    const input = body.input.map(item => {
      if (item?.type !== 'agent_message' || 'encrypted_content' in item || !Array.isArray(item.content) || !item.content.length) return item;
      if (!item.content.some(p => p?.type === 'encrypted_content') || item.content.some(p => !p ||
          !(p.type === 'encrypted_content' && known(p) || !('encrypted_content' in Object(p)) &&
            (p.type === 'input_text' && typeof p.text === 'string' || p.type === 'input_image' && typeof p.image_url === 'string')))) return item;
      changed = true;
      return {...item, content: item.content.map(p => p.type === 'encrypted_content' ? {type: 'input_text', text: p.encrypted_content} : p)};
    });
    if (changed) return {...body, input};
  } catch { ctx.report?.('unavailable', 0); }
}
