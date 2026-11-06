import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {applies, isLocal} from './common.js';

const stores = new Map();
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');

function location(ctx) {
  return ctx.options?.ledgerPath || path.join(os.homedir(), '.config', 'magpie', 'agent-message-compat', 'provenance.json');
}

async function store(ctx) {
  const file = location(ctx);
  const cacheKey = file + '|' + String(ctx.options?.provenanceRevision || '');
  if (!stores.has(cacheKey)) {
    stores.set(cacheKey, (async () => {
      const entries = new Map();
      try {
        const saved = JSON.parse(await readFile(file, 'utf8'));
        for (const entry of saved.entries || []) {
          if (/^[a-f0-9]{64}$/.test(entry.hash)) entries.set(entry.hash, entry.verifiedAt || entry.expires || Date.now());
        }
      } catch (error) {
        if (error.code !== 'ENOENT') ctx.report?.('compat_ledger_read_failed', 0);
      }
      return {file, entries, pending: Promise.resolve()};
    })());
  }
  return stores.get(cacheKey);
}

function remember(s, items) {
  let changed = false;
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.type !== 'function_call' ||
        !['agents', 'collaboration'].includes(item.namespace) ||
        !['spawn_agent', 'followup_task', 'send_message'].includes(item.name) ||
        !Array.isArray(item.encrypted_function_args) || item.encrypted_function_args.length !== 0) continue;
    try {
      const args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments;
      if (typeof args?.message !== 'string' || !args.message.trim()) continue;
      const key = hash(args.message);
      // Store hashes only; no task content, keys, or conversation logs.
      if (!s.entries.has(key)) {
        s.entries.set(key, Date.now()); changed = true;
      }
    } catch { /* An invalid tool argument is not evidence of plaintext. */ }
  }
  return changed;
}

async function save(s, ctx) {
  s.pending = s.pending.catch(() => {}).then(async () => {
    // Keep verified history durable, and merge a verified offline import.
    // A proof that an exact string was plaintext does not expire with time.
    try {
      const disk = JSON.parse(await readFile(s.file, 'utf8'));
      for (const entry of disk.entries || []) {
        if (/^[a-f0-9]{64}$/.test(entry.hash) && !s.entries.has(entry.hash)) {
          s.entries.set(entry.hash, entry.verifiedAt || entry.expires || Date.now());
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const entries = [...s.entries].map(([hash, verifiedAt]) => ({hash, verifiedAt}));
    await mkdir(path.dirname(s.file), {recursive: true});
    const tmp = s.file + '.' + randomUUID() + '.tmp';
    await writeFile(tmp, JSON.stringify({version: 2, entries}), {encoding: 'utf8', mode: 0o600});
    await rename(tmp, s.file);
  }).catch(() => ctx.report?.('compat_ledger_write_failed', 0));
  await s.pending;
}

export async function onResponse(reply, ctx) {
  if (!isLocal(ctx) || ctx.protocol !== 'responses' || ctx.success !== true) return;
  const s = await store(ctx);
  if (remember(s, reply?.output)) await save(s, ctx);
}

export async function onRequest(body, ctx) {
  if (!isLocal(ctx) || ctx.protocol !== 'responses' || !Array.isArray(body?.input)) return;
  const s = await store(ctx);
  if (remember(s, body.input)) await save(s, ctx);
  if (!applies(body, ctx)) return;
  const sealed = body.input.flatMap(item => item?.type === 'agent_message' && Array.isArray(item.content)
    ? item.content.filter(part => part?.type === 'encrypted_content') : []);
  if (!sealed.length) return;
  const limit = Math.max(0, Math.min(Number(ctx.options?.waitForProvenanceMs ?? 800), 1200));
  const deadline = Date.now() + limit;
  const known = part => typeof part.encrypted_content === 'string' && s.entries.has(hash(part.encrypted_content));
  // Response notifications are asynchronous; briefly allow the source to finish.
  while (sealed.some(part => !known(part)) && Date.now() < deadline && !ctx.signal?.aborted) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (ctx.signal?.aborted) return;
  let changed = false;
  const input = body.input.map(item => {
    if (item?.type !== 'agent_message' || !Array.isArray(item.content)) return item;
    const content = item.content.map(part => {
      if (part?.type !== 'encrypted_content' || !known(part)) return part;
      changed = true;
      return {type: 'input_text', text: part.encrypted_content};
    });
    return {...item, content};
  });
  if (changed) return {...body, input};
}
