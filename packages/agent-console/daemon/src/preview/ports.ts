// Ports the preview proxy never forwards to (1.2): rewriting Origin for them would get around their own checks.
//   - this daemon's port and the plugin gate's (--gate-port, default 3488)
//   - Magpie's local API / gateway and magpie web: their defaults 3425 and 3430, MAGPIE_ADDR / MAGPIE_WEB_ADDR / MAGPIE_URL
//     where set, and (#582) the port saved in Magpie's own settings.json (Settings → gateway port, settings.Port), read
//     again on every preview.open: older Magpie builds don't tell plugin hosts MAGPIE_ADDR, and the user can move the
//     gateway while the daemon runs.
// Magpie keeps settings.json in its config folder (internal/appdir.Config): the "data" folder beside a portable magpie,
// else $XDG_CONFIG_HOME/magpie, else ~/.config/magpie, on Windows, macOS and Linux alike. A portable folder is found
// from where this package is installed (<config>/plugins/node_modules/…) and from the daemon's working folder
// (<config>/plugin-work). The proxy also refuses a target that answers like a Magpie gateway (proxy.ts), whatever its port.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MAGPIE_DEFAULT_PORTS = [3425, 3430];
export const GATE_DEFAULT_PORT = 3488;

function portOf(addr: string | undefined): number | null {
  if (!addr) return null;
  const m = /:(\d{1,5})\/?$/.exec(addr.trim());
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

/** <config> of a Magpie whose plugins folder holds this path (…/<config>/plugins/node_modules/…), or null */
export function magpieDirFromInstall(p: string): string | null {
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/plugins/node_modules/");
  if (i <= 0) return null;
  return p.slice(0, i);
}

/** Magpie config folders that may hold its settings.json, most specific first (duplicates removed) */
export function magpieConfigDirs(
  env: Record<string, string | undefined> = process.env,
  where: { self?: string; cwd?: string; home?: string; platform?: NodeJS.Platform } = {},
): string[] {
  const out: string[] = [];
  const add = (d: string | null | undefined) => { if (d && isAbsolute(d) && !out.includes(d)) out.push(d); };
  let self = where.self;
  if (self === undefined) { try { self = fileURLToPath(import.meta.url); } catch { self = ""; } }
  add(magpieDirFromInstall(self));
  const cwd = where.cwd ?? (env === process.env ? process.cwd() : "");
  if (cwd && basename(cwd) === "plugin-work") add(dirname(cwd));
  const x = env.XDG_CONFIG_HOME;
  if (x && isAbsolute(x)) add(join(x, "magpie"));
  const platform = where.platform ?? process.platform;
  const home = where.home ?? (env === process.env ? homedir() : platform === "win32" ? env.USERPROFILE : env.HOME);
  if (home) add(join(home, ".config", "magpie"));
  return out;
}

/** The gateway port saved in a Magpie settings.json (settings.Port; 0 or out of range = the default 3425), or null */
export function savedGatewayPort(file: string, read: (f: string) => string = (f) => readFileSync(f, "utf8")): number | null {
  let raw: string;
  try {
    raw = read(file);
  } catch {
    return null;
  }
  try {
    const s = JSON.parse(raw) as { port?: unknown };
    const p = typeof s?.port === "number" ? s.port : 0;
    return Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : MAGPIE_DEFAULT_PORTS[0]!;
  } catch {
    return null;
  }
}

export function previewDeniedPorts(
  cfg: { port: number; gatePort?: number },
  env: Record<string, string | undefined> = process.env,
  opts: { configDirs?: string[]; read?: (f: string) => string } = {},
): number[] {
  const out = new Set<number>([cfg.port, GATE_DEFAULT_PORT, ...MAGPIE_DEFAULT_PORTS]);
  if (cfg.gatePort) out.add(cfg.gatePort);
  for (const k of ["MAGPIE_ADDR", "MAGPIE_WEB_ADDR", "MAGPIE_URL"]) {
    const p = portOf(env[k]);
    if (p) out.add(p);
  }
  for (const d of opts.configDirs ?? magpieConfigDirs(env)) {
    const p = savedGatewayPort(join(d, "settings.json"), opts.read);
    if (p) out.add(p);
  }
  const extra = env.AGENT_CONSOLE_PREVIEW_DENY;
  if (extra) for (const s of extra.split(/[,\s]+/)) { const n = Number(s); if (Number.isInteger(n) && n > 0 && n <= 65535) out.add(n); }
  out.delete(0);
  return [...out];
}
