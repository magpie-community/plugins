// Ports the preview proxy never forwards to (1.2): rewriting Origin for them would get around their own checks.
//   - this daemon's port and the plugin gate's (--gate-port, default 3488)
//   - Magpie's local API / gateway: MAGPIE_ADDR (set for plugin hosts, e.g. 127.0.0.1:3425), plus its defaults 3425 and 3430 (magpie web)
export const MAGPIE_DEFAULT_PORTS = [3425, 3430];
export const GATE_DEFAULT_PORT = 3488;

function portOf(addr: string | undefined): number | null {
  if (!addr) return null;
  const m = /:(\d{1,5})\/?$/.exec(addr.trim());
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

export function previewDeniedPorts(cfg: { port: number; gatePort?: number }, env: Record<string, string | undefined> = process.env): number[] {
  const out = new Set<number>([cfg.port, GATE_DEFAULT_PORT, ...MAGPIE_DEFAULT_PORTS]);
  if (cfg.gatePort) out.add(cfg.gatePort);
  for (const k of ["MAGPIE_ADDR", "MAGPIE_WEB_ADDR", "MAGPIE_URL"]) {
    const p = portOf(env[k]);
    if (p) out.add(p);
  }
  const extra = env.AGENT_CONSOLE_PREVIEW_DENY;
  if (extra) for (const s of extra.split(/[,\s]+/)) { const n = Number(s); if (Number.isInteger(n) && n > 0 && n <= 65535) out.add(n); }
  out.delete(0);
  return [...out];
}
