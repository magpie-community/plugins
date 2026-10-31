// Native folder picker: Windows uses PowerShell FolderBrowserDialog (pickFolderWin.ts),
// macOS osascript's choose folder, Linux zenity / kdialog when present; with none, report unavailable and the frontend falls back to typing.
// Everything starts processes directly via execFile, no shell; the initial directory is passed only as an argument or an escaped AppleScript string.
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { findOnPath } from "../../../lib/pathscan.mjs";
import { pickFolderWindows } from "./pickFolderWin.js";

export type PickResult = { available: boolean; path: string | null };
const TIMEOUT = 10 * 60 * 1000; // The user may keep the dialog open for a while

/** AppleScript string literal: only backslashes and double quotes need escaping. */
export function appleScriptString(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function isDir(p: string | undefined): p is string {
  try {
    return !!p && existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Command-line arguments (for testability). Returns null when the platform has no picker. */
export function pickFolderCommand(
  platform: NodeJS.Platform,
  initial: string | undefined,
  find: (name: string) => string | null = (n) => findOnPath(n)[0] ?? null,
  env: NodeJS.ProcessEnv = process.env,
): { cmd: string; args: string[] } | null {
  const init = isDir(initial) ? initial : undefined;
  if (platform === "darwin") {
    const prompt = appleScriptString("选择项目文件夹 / Choose a project folder");
    const loc = init ? ` default location (POSIX file ${appleScriptString(init)})` : "";
    return { cmd: "/usr/bin/osascript", args: ["-e", `POSIX path of (choose folder with prompt ${prompt}${loc})`] };
  }
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    // No graphical session (magpie web on a server): no window can open, so the frontend asks for a typed path
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
    const zenity = find("zenity");
    if (zenity) {
      const args = ["--file-selection", "--directory", "--title=选择项目文件夹 / Choose a project folder"];
      if (init) args.push(`--filename=${init.endsWith("/") ? init : init + "/"}`);
      return { cmd: zenity, args };
    }
    const kdialog = find("kdialog");
    if (kdialog) return { cmd: kdialog, args: ["--getexistingdirectory", init ?? env.HOME ?? "/"] };
  }
  return null;
}

export function pickFolder(initial?: string): Promise<PickResult> {
  if (process.platform === "win32") return pickFolderWindows(initial);
  const c = pickFolderCommand(process.platform, initial);
  if (!c) return Promise.resolve({ available: false, path: null });
  return new Promise((resolvePromise) => {
    execFile(c.cmd, c.args, { timeout: TIMEOUT, encoding: "utf8" }, (e, stdout) => {
      // Cancel: osascript / zenity / kdialog all exit non-zero
      if (e) return resolvePromise({ available: true, path: null });
      let p = String(stdout ?? "").replace(/\r?\n$/, "").trim();
      // osascript's POSIX path ends with / (except for the root)
      if (p.length > 1) p = p.replace(/\/+$/, "");
      resolvePromise({ available: true, path: p || null });
    }).on("error", () => resolvePromise({ available: false, path: null }));
  });
}
