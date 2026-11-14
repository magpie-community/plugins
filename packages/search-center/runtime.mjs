import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const MARKERS = ["usage.jsonl", "quotas.json", "providers.json", "plugins.json"];

function detectMagpieHome() {
  if (process.env.MAGPIE_HOME) return path.resolve(process.env.MAGPIE_HOME);
  if (process.env.MAGPIE_CONFIG_DIR) return path.resolve(process.env.MAGPIE_CONFIG_DIR);
  const pkgRoot = path.dirname(fileURLToPath(import.meta.url));
  try {
    const cwd = process.cwd();
    if (cwd !== pkgRoot && MARKERS.some(m => fs.existsSync(path.join(cwd, m)))) return cwd;
  } catch {}
  let dir = pkgRoot;
  for (let i = 0; i < 32; i++) {
    if (MARKERS.some(m => fs.existsSync(path.join(dir, m)))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, "magpie");
  return path.join(os.homedir(), ".config", "magpie");
}

export const DATA = path.resolve(process.env.SEARCH_CENTER_DATA_DIR || path.join(os.homedir(), ".magpie-search-center"));
export const DEFAULT_PORT = 3487;
export const PORT = Number(process.env.SEARCH_CENTER_PORT || DEFAULT_PORT);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("SEARCH_CENTER_PORT must be 1024–65535");

export function pythonCommand() {
  if (process.env.SEARCH_CENTER_PYTHON) return { file: process.env.SEARCH_CENTER_PYTHON, args: [] };
  const local = process.platform === "win32"
    ? path.join(DATA, "venv", "Scripts", "python.exe")
    : path.join(DATA, "venv", "bin", "python");
  if (fs.existsSync(local)) return { file: local, args: [] };
  return process.platform === "win32" ? { file: "py", args: ["-3"] } : { file: "python3", args: [] };
}

export const MAGPIE_HOME = detectMagpieHome();
export const MAGPIE_BIN = process.env.MAGPIE_BIN || "magpie";
