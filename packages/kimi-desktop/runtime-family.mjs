import crypto from 'node:crypto';

// Explicit running-backend metadata wins over any leftover configuration file.
// Older runners without that field retain the legacy path only when there is
// no converted file or V2 ownership that would make the backend ambiguous.
export function kernelFamily(runner, { hasConverted = false, hasPoolOwnership = false } = {}) {
  const type = runner?.kernel?.agentKernel;
  if (type === 'kimi-code-v2') return 'v2';
  if (type === 'kimi-code') return 'legacy';
  if (type !== undefined || hasConverted || hasPoolOwnership) return 'unknown';
  return 'legacy';
}

export function runnerGeneration(runner) {
  return crypto.createHash('sha256').update(JSON.stringify([runner?.daemonGeneration, runner?.control?.endpoint?.url,
    runner?.control?.endpoint?.startedAt, runner?.control?.endpoint?.pid])).digest('hex');
}
