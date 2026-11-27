export const DEFAULT_TARGETS = [];

export function enabled(ctx) {
  return Array.isArray(ctx.options?.targets) && ctx.options.targets.some(p => typeof p === 'string' && p.length > 0);
}

function matches(value, pattern) {
  // Deliberately only support exact names and one trailing wildcard.
  if (typeof pattern !== 'string') return false;
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  return value === pattern;
}

export function applies(body, ctx) {
  if (!body || ctx.protocol !== 'responses' || typeof body.model !== 'string') return false;
  const targets = Array.isArray(ctx.options?.targets) ? ctx.options.targets : DEFAULT_TARGETS;
  return targets.some(pattern => matches(body.model, pattern));
}

export function isLocal(ctx) {
  return ctx.origin === 'local' || ctx.origin === 'magpie-key';
}
