import { readAgentState } from './magpie-agent-reader.mjs';
import { parameterChoices } from './model-parameters.mjs';

let kept;
// MagPie's public plugin reads do not expose Agent fields. Read its own web
// handlers on an ephemeral loopback port; keep the key only in this process,
// issue GET /api/state and /api/model-speeds only, then stop the reader. Never rewrite an Agent to
// inspect hypothetical choices.
export function nativeModels() {
  if (kept && Date.now() - kept.at < 30000) return kept.promise;
  const promise = readAgentState().catch(error => { kept = undefined; throw error; });
  kept = { at: Date.now(), promise };
  return promise;
}

export function mergeNativeModels(agent, fallback, native, gatewayModels = [], piRuntime) {
  const settings = native?.find(a => a.id === agent);
  const fields = settings?.fields;
  const options = fields?.find(f => f.key === 'model')?.options;
  if (!options) return { models: fallback, metadata: 'cli', effortOptions: [], warning: '此 Harness 未出现在 MagPie 原生 Agent 字段中；仅列出 CLI 目录，不推测额外参数。' };
  const levels = fields.find(f => f.key === 'effort')?.options || [];
  return { metadata: 'native', wired: Boolean(settings.wired), effortOptions: levels, models: options.filter(o => o.value).map(o => {
    const entry = fallback.find(m => m.id === o.ref || m.id === o.value || (agent === 'codex' && o.served && m.id === `codex/${o.value}`));
    return { ...o, id: o.ref || o.value, value: o.value,
      label: o.label || o.value, provider: o.group || o.value.split('/')[0],
      icons: o.icons?.length ? o.icons : o.icon ? [o.icon] : [],
      efforts: entry?.efforts || [], effortKnown: Boolean(entry),
      ...(agent === 'codex' && o.served && entry ? { gatewayId: entry.id } : {}),
      ...(agent === 'pi' && o.ref && piRuntime !== undefined
        ? { parameterKnown: piRuntime.some(m => m.id === o.ref), parameters: piRuntime.find(m => m.id === o.ref)?.parameters || [] }
        : parameterChoices(agent, o, entry, fields, gatewayModels.find(m => m.id === o.ref))),
    };
  }) };
}

export async function gatewayModels() {
  const address = process.env.MAGPIE_ADDR || '127.0.0.1:3425';
  const base = new URL(address.includes('://') ? address : `http://${address}`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) return [];
  try {
    const response = await fetch(new URL('/v1/models', base), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return [];
    const data = await response.json();
    return (Array.isArray(data.data) ? data.data : []).map(m => ({ id: m.id, reasoning: typeof m.reasoning === 'boolean' ? m.reasoning : undefined, context: Number(m.context_window || m.context_length) || 0 }));
  } catch { return []; }
}
