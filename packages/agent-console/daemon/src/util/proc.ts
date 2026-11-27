// Small process/environment helpers: cross-platform pid liveness, PATH completion.
import { delimiter } from "node:path";
import { extraBinDirs } from "../../../lib/pathscan.mjs";
import { processAlive } from "../../../lib/proc.mjs";

type ProcessAliveDeps = {
  platform?: NodeJS.Platform;
  procRoot?: string;
  readFile?: (file: string) => string;
};

/** kill(pid, 0): ESRCH = gone; EPERM = exists but we may not signal it (common on Windows across sessions / elevated processes), counts as alive. */
export function pidAlive(
  pid: number,
  kill: (pid: number, sig: 0) => unknown = (p, s) => process.kill(p, s),
  deps: ProcessAliveDeps = {},
): boolean {
  return processAlive(pid, { ...deps, kill });
}

/** Append nodeDir and common CLI install directories to the end of PATH (deduped; case-insensitive on Windows). Returns the new PATH string. */
export function augmentPath(
  env: NodeJS.ProcessEnv,
  nodeDir: string,
  platform: NodeJS.Platform = process.platform,
  home?: string,
): string {
  const win = platform === "win32";
  const sep = win ? ";" : platform === process.platform ? delimiter : ":";
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const cur = (env[key] ?? "").split(sep).filter(Boolean);
  const norm = (d: string) => (win ? d.replace(/[\\/]+$/, "").toLowerCase() : d.replace(/\/+$/, ""));
  const seen = new Set(cur.map(norm));
  const out = [...cur];
  for (const d of [nodeDir, ...extraBinDirs({ platform, env, home })]) {
    if (!d || seen.has(norm(d))) continue;
    seen.add(norm(d));
    out.push(d);
  }
  return out.join(sep);
}
