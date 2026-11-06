// Per-spawn shell environment for the Agent CLIs (1.3, Windows only). See gitBash.ts for why.
// refreshAgentShell() runs at daemon start and whenever Settings → Bash path changes; spawnBin / CodexRpc merge withAgentShell()
// into the child's environment. The integrated terminal is left with the user's own environment.
import { homedir } from "node:os";
import { bashEnv, findGitBash, type BashCheck, type BashDeps, type BashFound } from "./gitBash.js";
import { log } from "../log.js";

export type AgentShellStatus = {
  /** Only Windows needs any of this */
  needed: boolean;
  found: BashFound | null;
  /** The manual setting was set but unusable (then detection ran anyway) */
  manualError?: Exclude<BashCheck, { ok: true }>["reason"];
  manual: string;
};

let status: AgentShellStatus = { needed: process.platform === "win32", found: null, manual: "" };
let isFileDep: ((p: string) => boolean) | undefined;
let ready: Promise<void> = Promise.resolve();
let generation = 0;

/** Agents that run their shell tool through bash on Windows (Codex, Cursor, Copilot, Devin and OpenCode default to PowerShell) */
export const BASH_AGENTS = new Set(["claude", "pi", "dsh"]);

export function refreshAgentShell(
  manual: string | undefined,
  o: { platform?: NodeJS.Platform; deps?: BashDeps } = {},
): Promise<void> {
  const platform = o.platform ?? process.platform;
  const my = ++generation;
  const m = typeof manual === "string" ? manual : "";
  if (platform !== "win32") {
    status = { needed: false, found: null, manual: m };
    ready = Promise.resolve();
    return ready;
  }
  const env = o.deps?.env ?? process.env;
  ready = findGitBash(m, { home: homedir(), ...o.deps, env })
    .then(({ found, manualError }) => {
      if (my !== generation) return;
      status = { needed: true, found, manual: m, ...(manualError && !manualError.ok ? { manualError: manualError.reason } : {}) };
      isFileDep = o.deps?.isFile;
      if (found) log("info", `Git Bash: ${found.path} (${found.source})`);
      else log("warn", "Git Bash not found; agents that need bash (Claude Code, Pi, dsh) will show a hint");
    })
    .catch((e) => {
      log("warn", "Git Bash detection failed", { err: String(e) });
    });
  return ready;
}

/** Wait (bounded) for the current detection; the first spawn after start or a settings change uses its result. */
export function agentShellReady(ms = 3000): Promise<void> {
  return Promise.race([ready, new Promise<void>((r) => setTimeout(r, ms).unref?.())]);
}

export function agentShellStatus(): AgentShellStatus {
  return status;
}

/** True when this agent needs bash on this machine and none was found */
export function bashMissingFor(providerId: string): boolean {
  return status.needed && !status.found && BASH_AGENTS.has(providerId);
}

/** The child's environment with the shell overrides merged in (unchanged off Windows or when nothing was found). */
export function withAgentShell<T extends Record<string, string | undefined>>(env: T): T {
  if (!status.needed || !status.found) return env;
  const overrides = bashEnv(status.found, env, isFileDep);
  const out: Record<string, string | undefined> = { ...env };
  for (const [k, v] of Object.entries(overrides)) {
    // PATH may be spelled Path on Windows: replace whichever key the base uses
    const same = Object.keys(out).find((x) => x.toUpperCase() === k.toUpperCase() && x !== k);
    if (same && k.toUpperCase() === "PATH") delete out[same];
    out[k] = v;
  }
  return out as T;
}
