import { randomUUID } from 'node:crypto';
const pending = new Map();
const TTL = 15 * 60 * 1000;
const efforts = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const modelPattern = /^minimax-code(?:-global)?\/MiniMax-M3\.1-Flash(?:-Preview)?$/i;
const prefix = '<magpie-minimax-effort:';
const markerPattern = /\n?<magpie-minimax-effort:([0-9a-f-]{36})>\n?/g;
function prune() {
  const now = Date.now();
  for (const [id, value] of pending) if (now - value.time > TTL) pending.delete(id);
}
// Magpie's early gateway hook; not an OpenCode chat.params hook.
export function onRequest(body, ctx) {
  if (!modelPattern.test(body.model ?? '')) return body;
  const effort = ctx.protocol === 'responses' ? body.reasoning?.effort
    : ctx.protocol === 'chat' || ctx.path?.endsWith('/chat/completions') ? body.reasoning_effort
    : body.output_config?.effort;
  if (!efforts.has(effort)) return body;
  if (ctx.protocol === 'anthropic' || ctx.path?.endsWith('/messages')) {
    const { thinking: _thinking, ...rest } = body;
    return { ...rest, output_config: { ...body.output_config, effort } };
  }
  const responses = ctx.protocol === 'responses';
  if (!responses && !ctx.path?.endsWith('/chat/completions')) return body;
  if (responses && body.instructions != null && typeof body.instructions !== 'string') return body;
  if (!responses && !Array.isArray(body.messages)) return body;
  prune();
  if (pending.size >= 4096) throw new Error('MiniMax effort bridge capacity reached');
  const id = randomUUID();
  const marker = `${prefix}${id}>`;
  pending.set(id, { effort, model: body.model.split('/').slice(1).join('/'), time: Date.now() });
  if (responses) return { ...body, instructions: (body.instructions ? body.instructions + '\n' : '') + marker };
  return { ...body, messages: [{ role: 'system', content: marker }, ...body.messages] };
}
// Called immediately before the subscription request is signed/sent.
export function restoreEffort(body) {
  if (typeof body !== 'string') return body;
  if (!body.includes('magpie-minimax-effort:')) {
    let native;
    try { native = JSON.parse(body); } catch { return body; }
    if (/^MiniMax-M3\.1-Flash(?:-Preview)?$/i.test(native.model ?? '') && efforts.has(native.output_config?.effort) && Object.hasOwn(native, 'thinking')) {
      delete native.thinking;
      return JSON.stringify(native);
    }
    return body;
  }
  const value = JSON.parse(body);
  let effort;
  const clean = (text) => typeof text !== 'string' ? text : text.replace(markerPattern, (_, id) => {
    const entry = pending.get(id);
    if (!entry || Date.now() - entry.time > TTL || entry.model.toLowerCase() !== String(value.model).toLowerCase()) {
      throw new Error('MiniMax effort context missing or expired; retry the request');
    }
    if (effort && effort !== entry.effort) throw new Error('Conflicting MiniMax effort contexts');
    effort = entry.effort;
    return '';
  });
  if (typeof value.system === 'string') {
    value.system = clean(value.system);
    if (!value.system) delete value.system;
  } else if (Array.isArray(value.system)) {
    value.system = value.system.map(block => block.type === 'text' ? { ...block, text: clean(block.text) } : block)
      .filter(block => block.type !== 'text' || block.text !== '');
    if (!value.system.length) delete value.system;
  }
  if (!effort) return body;
  // Keep entries for retries, with a bounded lifetime. Never infer from budget.
  delete value.thinking;
  value.output_config = { ...value.output_config, effort };
  const result = JSON.stringify(value);
  if (result.includes(prefix)) throw new Error('MiniMax effort marker was not fully removed');
  return result;
}
