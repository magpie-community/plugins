// Cross-platform executable lookup in PATH (shared by the plugin host index.mjs and the daemon; esbuild bundles it into dist for the daemon).
//
// which / where.exe are no longer used:
// - some minimal Linux systems have no which;
// - where.exe writes in the console code page (CP936 on Chinese Windows), so a Chinese user name or path is garbled when decoded as UTF-8,
//   existsSync fails and the CLI "can't be found".
// Windows searches in PATHEXT order (.COM;.EXE;.BAT;.CMD), with .ps1 last; extensionless npm sh shims are never returned.
// Besides PATH, add a set of common install directories: GUI apps launched from the macOS Dock/Finder only get launchd's minimal PATH
// (Magpie adds the login shell's PATH itself; this is the fallback): Homebrew, npm global, Volta, Claude's native install, etc.
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function defaultExists(file, platform) {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function envGet(env, name) {
  if (env[name] !== undefined) return env[name];
  // Windows environment variable names are case-insensitive (Path / PATH)
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) if (key.toLowerCase() === lower) return env[key];
  return undefined;
}

/** Common install directories that aren't necessarily in a GUI process's PATH (candidates only; callers check whether they exist). */
export function extraBinDirs({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs = [];
  if (platform === "win32") {
    const appData = envGet(env, "APPDATA");
    const localAppData = envGet(env, "LOCALAPPDATA");
    const programFiles = envGet(env, "ProgramFiles") || "C:\\Program Files";
    const nvmSymlink = envGet(env, "NVM_SYMLINK");
    if (home) dirs.push(p.join(home, ".local", "bin"));
    if (appData) dirs.push(p.join(appData, "npm"));
    if (nvmSymlink) dirs.push(nvmSymlink);
    dirs.push(p.join(programFiles, "nodejs"));
    if (localAppData) dirs.push(p.join(localAppData, "Programs", "nodejs"));
    if (home) {
      dirs.push(p.join(home, ".volta", "bin"));
      dirs.push(p.join(home, ".bun", "bin"));
    }
    return dirs;
  }
  if (home) {
    dirs.push(p.join(home, ".local", "bin"));
    dirs.push(p.join(home, ".npm-global", "bin"));
    dirs.push(p.join(home, ".volta", "bin"));
    dirs.push(p.join(home, ".bun", "bin"));
    dirs.push(p.join(home, ".claude", "local"));
  }
  if (platform === "darwin") dirs.push("/opt/homebrew/bin");
  dirs.push("/usr/local/bin", "/usr/bin", "/bin");
  return dirs;
}

/** PATH's directories followed by extraBinDirs; deduped (case-insensitive on Windows). */
export function searchDirs({ platform = process.platform, env = process.env, home = homedir(), extra = true } = {}) {
  const sep = platform === "win32" ? ";" : ":";
  const raw = String(envGet(env, "PATH") ?? "")
    .split(sep)
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  const all = extra ? [...raw, ...extraBinDirs({ platform, env, home })] : raw;
  const seen = new Set();
  const out = [];
  for (const d of all) {
    const key = platform === "win32" ? d.toLowerCase().replace(/[\\/]+$/, "") : d.replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

function windowsExts(env) {
  const list = String(envGet(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith("."));
  if (!list.includes(".ps1")) list.push(".ps1");
  return list;
}

/**
 * Return the full paths of every hit, in order (PATH first, then extraBinDirs).
 * @param {string} name command name (may include an extension on Windows)
 */
export function findOnPath(
  name,
  { platform = process.platform, env = process.env, home = homedir(), extra = true, exists } = {},
) {
  if (!name) return [];
  const p = platform === "win32" ? path.win32 : path.posix;
  const check = exists ?? ((file) => defaultExists(file, platform));
  // Already a path: check it directly
  if (name.includes("/") || (platform === "win32" && name.includes("\\"))) {
    return check(name) ? [name] : [];
  }
  let names = [name];
  if (platform === "win32") {
    const exts = windowsExts(env);
    const ext = p.extname(name).toLowerCase();
    names = ext && exts.includes(ext) ? [name] : exts.map((e) => name + e);
  }
  const hits = [];
  for (const dir of searchDirs({ platform, env, home, extra })) {
    for (const n of names) {
      const file = p.join(dir, n);
      if (check(file) && !hits.includes(file)) hits.push(file);
    }
  }
  return hits;
}

/** The resolved node executable, or null if not found (the plugin host is Bun, so process.execPath can't serve as node). */
export function findNode(opts = {}) {
  return findOnPath("node", opts).find((file) => isNodeExecutable(file)) ?? null;
}

/** Whether process.execPath itself is node (rather than Bun / Electron etc.). */
export function isNodeExecutable(file) {
  return /^node(\.exe)?$/i.test(String(file || "").split(/[\\/]/).pop() ?? "");
}

export const NODE_MISSING_MESSAGE =
  "找不到 Node.js（需要 20 或更高版本）。请安装 Node.js（https://nodejs.org）后完全退出并重新打开 Magpie。" +
  " / Node.js 20+ was not found on PATH. Install it, then quit and reopen Magpie.";
export const NODE_TOO_OLD_MESSAGE =
  "Node.js 版本太旧，需要 20 或更高版本。升级后完全退出并重新打开 Magpie。" +
  " / Node.js 20+ is required. Upgrade it, then quit and reopen Magpie.";

/**
 * For the plugin host: return the real node path (the host itself is Bun). If none is found, throw an error with a userMessage,
 * which the gate's 503 page displays; the daemon is no longer silently run on Bun.
 */
export function requireNode({ execPath = process.execPath, find = findNode } = {}) {
  if (isNodeExecutable(execPath)) return execPath;
  const hit = find();
  if (hit) return hit;
  const error = new Error("node not found on PATH");
  error.code = "ENODE";
  error.userMessage = NODE_MISSING_MESSAGE;
  throw error;
}
