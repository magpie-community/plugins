// Cross-platform executable resolution + process tree termination (ported from lib/bin.mjs).
// Goal: start .cmd-shim CLIs like claude/codex without shell:true.

import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { findOnPath, findNode as findNodeOnPath, isNodeExecutable } from "../../../lib/pathscan.mjs";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const IS_WIN = process.platform === "win32";
const cache = new Map<string, { out: ResolveResult; at: number }>();
const CACHE_MS = 60 * 1000;

export type ResolveResult =
  | {
      ok: true;
      cmd: string;
      prefixArgs: string[];
      display: string;
      via: string;
      /** via === "cmd-shim": a .cmd/.bat that must be started through cmd.exe (spawnBin / argvFor handle escaping) */
      shim?: string;
    }
  | { ok: false; reason: string };

// PATH lookup lives in lib/pathscan.mjs: which / where.exe are no longer used (where's output uses the console code page, which garbles Chinese paths).
function which(name: string): string[] {
  return findOnPath(name);
}

// ---- Windows: escaping when starting a .cmd/.bat through cmd.exe (same rules as cross-spawn) ----
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

export function escapeCmdCommand(cmd: string): string {
  return cmd.replace(CMD_META, "^$1");
}

export function escapeCmdArgument(arg: string, doubleEscape: boolean): string {
  let a = String(arg);
  // First quote per CommandLineToArgvW rules (backslashes + quotes)
  a = a.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\*)$/, "$1$1");
  a = `"${a}"`;
  // Then escape cmd metacharacters; batch files parse arguments again, so escape twice
  a = a.replace(CMD_META, "^$1");
  if (doubleEscape) a = a.replace(CMD_META, "^$1");
  return a;
}

export type Argv = { cmd: string; args: string[]; windowsVerbatimArguments?: boolean };

/** Resolution result + arguments → the command line actually given to spawn. */
export function argvFor(r: ResolveResult & { ok: true }, args: string[]): Argv {
  if (r.via === "cmd-shim" && r.shim) {
    const line = [escapeCmdCommand(r.shim), ...args.map((a) => escapeCmdArgument(a, true))].join(" ");
    return { cmd: r.cmd, args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
  }
  return { cmd: r.cmd, args: [...r.prefixArgs, ...args] };
}

// ---- Safety net: end Agent process trees still alive when the daemon exits ----
const liveTrees = new Set<number>();
let exitHookInstalled = false;

function reapOnExit(): void {
  for (const pid of liveTrees) {
    try {
      if (IS_WIN) execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 3000 });
      else process.kill(-pid, "SIGKILL");
    } catch {}
  }
  liveTrees.clear();
}

/** Register a process to clean up when the daemon exits (on non-Windows it must lead a detached process group). */
export function trackTree(child: ChildProcess): void {
  if (child.pid == null) return;
  const pid = child.pid;
  liveTrees.add(pid);
  child.once("exit", () => liveTrees.delete(pid));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", reapOnExit);
  }
}

/** Start a CLI from a resolution result. On non-Windows it gets its own process group (detached) so killTree can also end grandchildren. */
export function spawnBin(
  r: ResolveResult & { ok: true },
  args: string[],
  opts: SpawnOptions & { group?: boolean } = {},
): ChildProcess {
  const a = argvFor(r, args);
  const { group, ...rest } = opts;
  const child = spawn(a.cmd, a.args, {
    windowsHide: true,
    ...rest,
    ...(a.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    ...(group && !IS_WIN ? { detached: true } : {}),
  });
  if (group) trackTree(child);
  return child;
}

// Find the script/program path a .cmd calls from its text.
export function shimTarget(
  cmdText: string,
  cmdDir: string | null,
  deps: { exists?: (p: string) => boolean; win?: boolean } = {},
): string | null {
  const exists = deps.exists ?? existsSync;
  const P = (deps.win ?? IS_WIN) ? path.win32 : path;
  const cands: string[] = [];
  const re = /"([^"]+?\.(?:js|mjs|cjs|exe|cmd|bat))"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmdText))) cands.push(m[1]);
  const re2 = /(?:%~?dp0%?)?[A-Za-z]:?[\\/\w.@-]*?\.(?:js|mjs|cjs|exe)\b/gi;
  while ((m = re2.exec(cmdText))) cands.push(m[0]);
  const found: string[] = [];
  for (const raw of cands) {
    let p = raw.replace(/%~?dp0%?/gi, "");
    p = p.replace(/%[A-Z_]+%/gi, "");
    p = p.trim().replace(/^[\\/]+/, "");
    if (!p || /%\w+%/.test(p) || !/\.(js|mjs|cjs|exe)$/i.test(p)) continue;
    if (!P.isAbsolute(p)) {
      if (!cmdDir) continue;
      p = P.join(cmdDir, p);
    }
    if (exists(p)) found.push(P.resolve(p));
  }
  // npm shims first write IF EXIST "%dp0%\node.exe" (it really exists when the global dir is the node install dir, e.g. nvm-windows),
  // and only then the real cli.js: the script wins, node.exe itself is not the target
  return (
    found.find((f) => /\.(js|mjs|cjs)$/i.test(f)) ??
    found.find((f) => /\.exe$/i.test(f) && !isNodeExecutable(P.basename(f))) ??
    null
  );
}

// Which node to use when the shim points at a .js: the daemon itself runs on node, so prefer that one; otherwise node from PATH
function findNode(): string {
  if (isNodeExecutable(process.execPath)) return process.execPath;
  return findNodeOnPath() ?? "node";
}

export async function resolveBin(name: string): Promise<ResolveResult> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.out;
  const out = await resolveBinUncached(name);
  cache.set(name, { out, at: Date.now() });
  return out;
}

export type ResolvedBin = ResolveResult & { ok: true; binName: string };

/** Try several executable names from the catalog in order and return the first hit. */
export async function resolveFirstBin(names: string[]): Promise<ResolvedBin | ResolveResult> {
  const uniq = [...new Set(names.filter(Boolean))];
  for (const binName of uniq) {
    const r = await resolveBin(binName);
    if (r.ok) return { ...r, binName };
  }
  const label = uniq[0] ?? "cli";
  return { ok: false, reason: `PATH 里找不到 ${uniq.length > 1 ? uniq.join(" 或 ") : label}` };
}

export function clearBinCache(name?: string): void {
  if (name) cache.delete(name);
  else cache.clear();
}

export type ResolveDeps = {
  platform?: NodeJS.Platform;
  find?: (name: string) => string[];
  readText?: (file: string) => Promise<string>;
  exists?: (file: string) => boolean;
  node?: () => string;
  comspec?: string;
};

function resolveBinUncached(name: string): Promise<ResolveResult> {
  return resolveBinWith(name);
}

/** Implementation of resolveBin with injectable dependencies (tests simulate a Windows PATH / shims). */
export async function resolveBinWith(name: string, deps: ResolveDeps = {}): Promise<ResolveResult> {
  const platform = deps.platform ?? process.platform;
  const win = platform === "win32";
  const P = win ? path.win32 : path.posix;
  const exists = deps.exists ?? existsSync;
  const hits = (deps.find ?? which)(name);
  if (!hits.length) return { ok: false, reason: `PATH 里找不到 ${name}` };
  // Take the first hit in PATH order (same as typing the command in a terminal; within one directory on Windows, PATHEXT order)
  const first = hits[0];
  if (!win) return { ok: true, cmd: first, prefixArgs: [], display: first, via: "path" };

  const ext = P.extname(first).toLowerCase();
  if (ext === ".exe" || ext === ".com") return { ok: true, cmd: first, prefixArgs: [], display: first, via: "exe" };
  if (ext === ".ps1") {
    return {
      ok: true,
      cmd: "powershell.exe",
      prefixArgs: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", first],
      display: first,
      via: "ps1",
    };
  }
  // .cmd / .bat
  const dir = P.dirname(first);
  if (name.toLowerCase() === "npx") {
    const node = P.join(dir, "node.exe");
    const cli = P.join(dir, "node_modules", "npm", "bin", "npx-cli.js");
    if (exists(node) && exists(cli))
      return { ok: true, cmd: node, prefixArgs: [cli], display: `${node} ${cli}`, via: "npx-shim" };
  }
  const text = await (deps.readText ?? ((f: string) => readFile(f, "utf8")))(first).catch(() => "");
  const target = shimTarget(text, dir, { exists, win: true });
  if (target && /\.(js|mjs|cjs)$/i.test(target)) {
    const node = (deps.node ?? findNode)();
    return { ok: true, cmd: node, prefixArgs: [target], display: `${node} ${target}`, via: "shim-js" };
  }
  if (target && /\.exe$/i.test(target)) {
    return { ok: true, cmd: target, prefixArgs: [], display: target, via: "shim-exe" };
  }
  // PowerShell / other .cmd wrappers: start through cmd.exe (e.g. cursor-agent); escaping happens in argvFor
  const comspec = deps.comspec ?? (process.env.ComSpec || "cmd.exe");
  return { ok: true, cmd: comspec, prefixArgs: [], display: first, via: "cmd-shim", shim: first };
}

// Windows: taskkill /T kills the whole tree; elsewhere: detached process group, kill(-pid).
export function killTree(child: ChildProcess | null | undefined, { graceMs = 3000 } = {}): Promise<void> {
  if (!child || child.pid == null) return Promise.resolve();
  const pid = child.pid;
  if (IS_WIN) {
    return new Promise((resolvePromise) => {
      const tk = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      tk.on("error", () => {
        try {
          child.kill();
        } catch {}
        resolvePromise();
      });
      tk.on("close", () => resolvePromise());
      setTimeout(resolvePromise, graceMs + 2000);
    });
  }
  return new Promise((resolvePromise) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolvePromise();
      }
    };
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
    // A child that has already exited won't emit close again: no need to wait out graceMs
    if (child.exitCode !== null || child.signalCode !== null) {
      finish();
      return;
    }
    const t = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
      finish();
    }, graceMs);
    t.unref?.();
    child.on("close", () => {
      clearTimeout(t);
      finish();
    });
  });
}
