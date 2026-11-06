// Windows: find a usable Git Bash for the Agent CLIs (1.3).
//
// On Windows `bash` on PATH is often C:\Windows\System32\bash.exe, the WSL launcher. With no Linux distro that has /bin/bash
// (Docker Desktop only installs "docker-desktop") every agent that runs `bash -c …` fails. Each agent looks for bash its own way
// (see docs in the 1.3 plan): Claude Code reads CLAUDE_CODE_GIT_BASH_PATH, OpenCode OPENCODE_GIT_BASH_PATH, Pi runs
// `where bash.exe`, dsh spawns `bash` through PATH. So one detection here feeds three per-spawn environment changes; no user config
// file is written. Everything is a no-op off Windows.
//
// Pure functions with injected fs/env so the Windows logic is tested on Linux.
import path from "node:path";
import { statSync } from "node:fs";
import { spawn } from "node:child_process";
import { findOnPath } from "../../../lib/pathscan.mjs";

const W = path.win32;

export type Env = Record<string, string | undefined>;
export type BashSource = "manual" | "env" | "git" | "known" | "drive" | "path";
export type BashFound = { path: string; source: BashSource };
export type BashDeps = {
  env?: Env;
  home?: string;
  /** sync existence check for local, well-known paths */
  isFile?: (p: string) => boolean;
  /** async check for other drives (tests); by default they are probed in a separate process, see probeInChild */
  isFileAsync?: (p: string) => Promise<boolean>;
  /** drive letters to try for X:\Git; default C–Z */
  drives?: string[];
  probeTimeoutMs?: number;
};

export const GIT_FOR_WINDOWS_URL = "https://git-scm.com/download/win";

function envGet(env: Env, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(env)) if (k.toLowerCase() === lower) return env[k];
  return undefined;
}

function syncIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function withTimeout(p: Promise<boolean>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(false); });
  });
}

const norm = (p: string) => W.normalize(p).replace(/[\\/]+$/, "").toLowerCase();

/** The WSL launcher (System32 / SysWOW64 / Sysnative bash.exe) or the WindowsApps alias: never a usable bash. */
export function isWslBash(p: string, env: Env = {}): boolean {
  const n = norm(p);
  if (/\\windowsapps\\/.test(n + "\\")) return true;
  if (/^[a-z]:\\windows\\(system32|syswow64|sysnative)\\/.test(n)) return true;
  const root = envGet(env, "SystemRoot") || envGet(env, "windir");
  if (root) {
    const r = norm(root);
    for (const sub of ["system32", "syswow64", "sysnative"]) if (n.startsWith(`${r}\\${sub}\\`)) return true;
  }
  return false;
}

/** Strip quotes/whitespace a user may paste around a path */
export function cleanPath(raw: string): string {
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").trim();
}

export type BashCheck = { ok: true; path: string } | { ok: false; reason: "empty" | "relative" | "notBash" | "wsl" | "missing" };

/** Validate a bash path typed by the user (or found in the environment). */
export function checkBashPath(raw: string | undefined | null, deps: BashDeps = {}): BashCheck {
  const p = cleanPath(String(raw ?? ""));
  if (!p) return { ok: false, reason: "empty" };
  // A drive-letter path only: a UNC path (\\server\share) is checked synchronously and could stall on a dead share
  if (!/^[A-Za-z]:[\\/]/.test(p)) return { ok: false, reason: "relative" };
  const base = W.basename(p).toLowerCase();
  if (base !== "bash.exe" && base !== "sh.exe") return { ok: false, reason: "notBash" };
  const env = deps.env ?? process.env;
  if (isWslBash(p, env)) return { ok: false, reason: "wsl" };
  const full = W.normalize(p);
  if (!(deps.isFile ?? syncIsFile)(full)) return { ok: false, reason: "missing" };
  return { ok: true, path: full };
}

/** Where bash.exe sits for a git.exe directory: …\Git\cmd, …\Git\bin, …\Git\mingw64\bin → …\Git\bin\bash.exe */
export function bashForGitDir(dir: string): string[] {
  const d = W.normalize(dir).replace(/[\\/]+$/, "");
  const base = W.basename(d).toLowerCase();
  const parent = W.dirname(d);
  const out: string[] = [];
  if (base === "bin" || base === "cmd") {
    const pb = W.basename(parent).toLowerCase();
    // …\Git\mingw64\bin, …\Git\usr\bin, …\Git\clangarm64\bin
    if (["mingw64", "mingw32", "clangarm64", "ucrt64", "usr"].includes(pb)) out.push(W.join(W.dirname(parent), "bin", "bash.exe"));
    out.push(W.join(parent, "bin", "bash.exe"));
  }
  out.push(W.join(d, "bash.exe"));
  return [...new Set(out)];
}

/** Well-known install directories, in order */
export function knownBashCandidates(env: Env, home?: string): string[] {
  const out: string[] = [];
  for (const v of ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]) {
    const d = envGet(env, v);
    if (d) out.push(W.join(d, "Git", "bin", "bash.exe"));
  }
  out.push("C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe");
  const local = envGet(env, "LOCALAPPDATA");
  if (local) out.push(W.join(local, "Programs", "Git", "bin", "bash.exe"));
  const scoop = envGet(env, "SCOOP") || (home ? W.join(home, "scoop") : "");
  if (scoop) out.push(W.join(scoop, "apps", "git", "current", "bin", "bash.exe"));
  const seen = new Set<string>();
  return out.filter((p) => (seen.has(norm(p)) ? false : (seen.add(norm(p)), true)));
}

export function driveBashCandidates(drives: string[]): string[] {
  const out: string[] = [];
  for (const raw of drives) {
    const L = raw.replace(/[:\\/]/g, "").toUpperCase();
    if (!/^[A-Z]$/.test(L)) continue;
    out.push(`${L}:\\Git\\bin\\bash.exe`, `${L}:\\Program Files\\Git\\bin\\bash.exe`);
  }
  return out;
}

const ALL_DRIVES = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("");

/**
 * Find Git Bash (Windows). Order: manual setting → an existing CLAUDE_CODE_GIT_BASH_PATH / OPENCODE_GIT_BASH_PATH that is valid →
 * next to git.exe on PATH → Program Files / Program Files (x86) / LocalAppData\Programs / scoop → X:\Git on other drives → a
 * bash.exe on PATH that is not the WSL launcher. System32 / WindowsApps bash is always skipped.
 */
export async function findGitBash(manual: string | undefined, deps: BashDeps = {}): Promise<{ found: BashFound | null; manualError?: BashCheck }> {
  const env = deps.env ?? process.env;
  const isFile = deps.isFile ?? syncIsFile;
  const ok = (p: string) => !isWslBash(p, env) && isFile(p);
  let manualError: BashCheck | undefined;
  if (manual && cleanPath(manual)) {
    const c = checkBashPath(manual, { ...deps, env });
    if (c.ok) return { found: { path: c.path, source: "manual" } };
    manualError = c;
  }
  for (const v of ["CLAUDE_CODE_GIT_BASH_PATH", "OPENCODE_GIT_BASH_PATH"]) {
    const c = checkBashPath(envGet(env, v), { ...deps, env });
    if (c.ok) return { found: { path: c.path, source: "env" }, manualError };
  }
  for (const git of findOnPath("git.exe", { platform: "win32", env, extra: false, exists: isFile })) {
    for (const b of bashForGitDir(W.dirname(git))) if (ok(b)) return { found: { path: b, source: "git" }, manualError };
  }
  for (const b of knownBashCandidates(env, deps.home)) if (ok(b)) return { found: { path: b, source: "known" }, manualError };
  const drives = driveBashCandidates(deps.drives ?? ALL_DRIVES);
  const ms = deps.probeTimeoutMs ?? 1500;
  const list = drives.filter((p) => !isWslBash(p, env));
  const hit = deps.isFileAsync
    ? await Promise.all(list.map((p) => withTimeout(deps.isFileAsync!(p), ms))).then((h) => list[h.indexOf(true)] ?? null)
    : await probeInChild(list, ms);
  if (hit) return { found: { path: hit, source: "drive" }, manualError };
  for (const b of findOnPath("bash.exe", { platform: "win32", env, extra: false, exists: isFile })) {
    if (!isWslBash(b, env)) return { found: { path: b, source: "path" }, manualError };
  }
  return { found: null, manualError };
}

/**
 * Stat the drive candidates in a short-lived child Node process, killed after `ms`. A stat on a disconnected network drive can
 * block for tens of seconds, and in-process it would hold the daemon's libuv threadpool (every other fs call) that long.
 * Resolves to the first candidate (in list order) that is a file, or null.
 */
export function probeInChild(paths: string[], ms: number): Promise<string | null> {
  if (!paths.length) return Promise.resolve(null);
  const script =
    "const fs=require('fs');const p=JSON.parse(process.argv[1]);" +
    "p.forEach((x,i)=>fs.stat(x,(e,s)=>{if(!e&&s.isFile())process.stdout.write(i+'\\n')}));";
  return new Promise((resolve) => {
    const hits = new Set<number>();
    let out = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      const first = [...hits].sort((a, b) => a - b)[0];
      resolve(first === undefined ? null : paths[first] ?? null);
    };
    const child = spawn(process.execPath, ["-e", script, JSON.stringify(paths)], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const timer = setTimeout(finish, ms);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      out += d;
      for (const line of out.split("\n").slice(0, -1)) if (/^\d+$/.test(line)) hits.add(Number(line));
      out = out.slice(out.lastIndexOf("\n") + 1);
      // the first candidate is a hit: nothing earlier can win, stop waiting
      if (hits.has(0)) finish();
    });
    child.on("error", finish);
    child.on("close", finish);
  });
}

/** The directory to put first on PATH so a PATH lookup of `bash` returns this one (…\Git\usr\bin → …\Git\bin when it exists). */
export function bashPathDir(bash: string, isFile: (p: string) => boolean = syncIsFile): string {
  const dir = W.dirname(W.normalize(bash));
  if (/\\usr\\bin$/i.test(dir)) {
    const top = W.join(W.dirname(W.dirname(dir)), "bin");
    if (isFile(W.join(top, "bash.exe"))) return top;
  }
  return dir;
}

/**
 * Environment changes for an Agent spawn: CLAUDE_CODE_GIT_BASH_PATH and OPENCODE_GIT_BASH_PATH, and the bash directory first on PATH
 * when a PATH lookup would otherwise return something else (System32\bash.exe → WSL). Nothing when no bash was found.
 */
export function bashEnv(found: BashFound | null, env: Env, isFile: (p: string) => boolean = syncIsFile): Record<string, string> {
  if (!found) return {};
  const out: Record<string, string> = {
    CLAUDE_CODE_GIT_BASH_PATH: found.path,
    OPENCODE_GIT_BASH_PATH: found.path,
  };
  const dir = bashPathDir(found.path, isFile);
  const first = findOnPath("bash.exe", { platform: "win32", env, extra: false, exists: isFile })[0];
  if (!first || norm(first) !== norm(W.join(dir, "bash.exe"))) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const rest = String(env[key] ?? "").split(";").filter((d) => d && norm(d.replace(/^"(.*)"$/, "$1")) !== norm(dir));
    out[key] = [dir, ...rest].join(";");
  }
  return out;
}
