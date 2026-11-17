// 1.3.8 (issue #3): open the project in a local IDE, and reveal a file / folder in the system file manager.
//
// Every launch is argv-array only, never a shell string: spawn(cmd, args) with shell:false (the same no-shell rule as
// execFile; spawn is used because an IDE's GUI process keeps running and must be detached, not waited on).
// The one exception is a Windows .cmd/.bat IDE launcher with no GUI .exe beside it: that goes through cmd.exe with
// bin.ts's argvFor escaping (the same path the Agent CLIs' .cmd shims take), each argument quoted and ^-escaped.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { findOnPath } from "../../../lib/pathscan.mjs";
import { argvFor, type ResolveResult } from "./bin.js";

export type IdeSpec = {
  /** shown in the toast / returned as `ide` */
  name: string;
  /** CLI names on PATH, in order */
  bins: string[];
  /** Windows: GUI exe names that may sit next to (or a few folders above) a .cmd launcher */
  winExe: string[];
  /** Windows: install folders relative to %LOCALAPPDATA% / %ProgramFiles% (exe paths) */
  winDirs: { base: "LOCALAPPDATA" | "ProgramFiles" | "ProgramFiles(x86)"; rel: string }[];
  /** Windows: JetBrains-style versioned folders under %ProgramFiles%\JetBrains (prefix, exe relative to it) */
  winJetBrains?: { prefix: string; exe: string };
  /** macOS: app bundle names tried under /Applications and ~/Applications */
  macApps: string[];
};

/** Detection order (issue #3) */
export const IDES: IdeSpec[] = [
  {
    name: "Cursor", bins: ["cursor"], winExe: ["Cursor.exe"],
    winDirs: [{ base: "LOCALAPPDATA", rel: "Programs\\cursor\\Cursor.exe" }, { base: "ProgramFiles", rel: "cursor\\Cursor.exe" }],
    macApps: ["Cursor"],
  },
  {
    name: "VS Code", bins: ["code"], winExe: ["Code.exe"],
    winDirs: [{ base: "LOCALAPPDATA", rel: "Programs\\Microsoft VS Code\\Code.exe" }, { base: "ProgramFiles", rel: "Microsoft VS Code\\Code.exe" }],
    macApps: ["Visual Studio Code"],
  },
  {
    name: "Windsurf", bins: ["windsurf"], winExe: ["Windsurf.exe"],
    winDirs: [{ base: "LOCALAPPDATA", rel: "Programs\\Windsurf\\Windsurf.exe" }, { base: "ProgramFiles", rel: "Windsurf\\Windsurf.exe" }],
    macApps: ["Windsurf"],
  },
  {
    name: "Zed", bins: ["zed", "zeditor"], winExe: ["Zed.exe", "zed.exe"],
    winDirs: [{ base: "LOCALAPPDATA", rel: "Programs\\Zed\\Zed.exe" }, { base: "ProgramFiles", rel: "Zed\\Zed.exe" }],
    macApps: ["Zed"],
  },
  {
    name: "IntelliJ IDEA", bins: ["idea"], winExe: ["idea64.exe"],
    winDirs: [],
    winJetBrains: { prefix: "IntelliJ IDEA", exe: "bin\\idea64.exe" },
    macApps: ["IntelliJ IDEA", "IntelliJ IDEA Ultimate", "IntelliJ IDEA CE"],
  },
  {
    name: "WebStorm", bins: ["webstorm"], winExe: ["webstorm64.exe"],
    winDirs: [],
    winJetBrains: { prefix: "WebStorm", exe: "bin\\webstorm64.exe" },
    macApps: ["WebStorm"],
  },
  {
    name: "Sublime Text", bins: ["subl"], winExe: ["sublime_text.exe", "subl.exe"],
    winDirs: [{ base: "ProgramFiles", rel: "Sublime Text\\subl.exe" }, { base: "ProgramFiles", rel: "Sublime Text 3\\subl.exe" }],
    macApps: ["Sublime Text"],
  },
];

export type Launch = {
  cmd: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
  /** Windows: hide the console window (only for the cmd.exe launcher; a GUI exe must keep its window shown) */
  hide?: boolean;
};
export type IdeHit = { ide: string; launch: Launch };

export type OsDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  find?: (name: string) => string[];
  exists?: (p: string) => boolean;
  /** folder names inside a folder ([] when unreadable) */
  list?: (dir: string) => string[];
  comspec?: string;
};

function envGet(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const k = Object.keys(env).find((x) => x.toLowerCase() === key.toLowerCase());
  return k ? env[k] : undefined;
}

/** Windows: a .cmd launcher (VS Code's bin\code.cmd, Cursor's resources\app\bin\cursor.cmd) → the GUI exe it wraps */
function exeNearShim(shim: string, exes: string[], exists: (p: string) => boolean): string | null {
  const P = path.win32;
  let dir = P.dirname(shim);
  for (let up = 0; up < 4; up++) {
    for (const exe of exes) {
      const f = P.join(dir, exe);
      if (exists(f)) return f;
    }
    const parent = P.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** How to start `spec` on `dir` on this machine, or null if it isn't installed */
export function ideLaunchFor(spec: IdeSpec, dir: string, deps: OsDeps = {}): Launch | null {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const find = deps.find ?? ((n: string) => findOnPath(n, { platform, env }) as string[]);
  const win = platform === "win32";
  for (const bin of spec.bins) {
    const hit = find(bin)[0];
    if (!hit) continue;
    if (!win) return { cmd: hit, args: [dir] };
    const ext = path.win32.extname(hit).toLowerCase();
    if (ext === ".exe" || ext === ".com") return { cmd: hit, args: [dir] };
    if (ext === ".cmd" || ext === ".bat") {
      const exe = exeNearShim(hit, spec.winExe, exists);
      if (exe) return { cmd: exe, args: [dir] };
      // no GUI exe beside it: cmd.exe /d /s /c with every argument quoted and ^-escaped (bin.ts argvFor)
      const r: ResolveResult & { ok: true } = {
        ok: true, cmd: deps.comspec ?? envGet(env, "ComSpec") ?? "cmd.exe", prefixArgs: [], display: hit, via: "cmd-shim", shim: hit,
      };
      return { ...argvFor(r, [dir]), hide: true };
    }
    // .ps1 or anything else: skip it, the install folders below may still have the exe
  }
  if (win) {
    for (const d of spec.winDirs) {
      const base = envGet(env, d.base);
      if (!base) continue;
      const f = path.win32.join(base, d.rel);
      if (exists(f)) return { cmd: f, args: [dir] };
    }
    if (spec.winJetBrains) {
      const list = deps.list ?? ((p: string) => { try { return readdirSync(p); } catch { return []; } });
      for (const key of ["ProgramFiles", "ProgramFiles(x86)"]) {
        const base = envGet(env, key);
        if (!base) continue;
        const jb = path.win32.join(base, "JetBrains");
        const names = list(jb).filter((n) => n.startsWith(spec.winJetBrains!.prefix)).sort().reverse();
        for (const n of names) {
          const f = path.win32.join(jb, n, spec.winJetBrains.exe);
          if (exists(f)) return { cmd: f, args: [dir] };
        }
      }
    }
  }
  if (platform === "darwin") {
    const home = deps.home ?? homedir();
    for (const app of spec.macApps) {
      for (const root of ["/Applications", path.posix.join(home, "Applications")]) {
        const bundle = path.posix.join(root, `${app}.app`);
        if (exists(bundle)) return { cmd: "open", args: ["-a", bundle, dir] };
      }
    }
  }
  return null;
}

/** The first installed IDE in IDES order */
export function detectIde(dir: string, deps: OsDeps = {}): IdeHit | null {
  for (const spec of IDES) {
    const launch = ideLaunchFor(spec, dir, deps);
    if (launch) return { ide: spec.name, launch };
  }
  return null;
}

/** File manager command for a target inside the project: a file is selected in its folder, a folder is opened */
export function revealLaunch(platform: NodeJS.Platform, target: string, isDir: boolean): Launch {
  if (platform === "win32") {
    const p = path.win32.normalize(target);
    // explorer.exe parses /select,"<path>" itself (Node would quote the whole "/select,<path>" token); a Windows
    // path can't contain a double quote, so the quoting can't be broken out of
    return isDir ? { cmd: "explorer.exe", args: [p] } : { cmd: "explorer.exe", args: [`/select,"${p}"`], windowsVerbatimArguments: true };
  }
  if (platform === "darwin") return isDir ? { cmd: "open", args: [target] } : { cmd: "open", args: ["-R", target] };
  return { cmd: "xdg-open", args: [isDir ? target : path.posix.dirname(target)] };
}

export type SpawnLike = (cmd: string, args: string[], opts: SpawnOptions) => Pick<ChildProcess, "once" | "unref">;

/**
 * Start a detached process. ok once it has spawned and either exited 0 or is still running after `graceMs`;
 * a spawn error (not installed) or a quick non-zero exit is a failure. `ignoreExit`: explorer.exe exits 1 on success.
 */
export function launchDetached(
  l: Launch,
  opts: { spawn?: SpawnLike; graceMs?: number; ignoreExit?: boolean } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const run = opts.spawn ?? (spawn as unknown as SpawnLike);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: { ok: true } | { ok: false; reason: string }) => { if (!settled) { settled = true; resolve(v); } };
    let child: Pick<ChildProcess, "once" | "unref">;
    try {
      child = run(l.cmd, l.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: !!l.hide,
        shell: false,
        ...(l.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (e) {
      done({ ok: false, reason: String((e as Error)?.message ?? e) });
      return;
    }
    child.once("error", (e: Error) => done({ ok: false, reason: e.message }));
    child.once("exit", (code: number | null) => {
      if (opts.ignoreExit || code === 0) done({ ok: true });
      else done({ ok: false, reason: `exit ${code}` });
    });
    child.once("spawn", () => {
      setTimeout(() => done({ ok: true }), opts.graceMs ?? 1500).unref?.();
    });
    child.unref();
  });
}
