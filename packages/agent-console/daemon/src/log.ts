// Simple logging: writes dataDir/logs/daemon-YYYY-MM-DD.log (kept 7 days) and to the console.
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

let logDir = "";
let today = "";
let logFile = "";

function fileName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `daemon-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`;
}

export function initLog(dataDir: string): void {
  logDir = join(dataDir, "logs");
  mkdirSync(logDir, { recursive: true });
  // Keep 7 days
  try {
    const keep = new Set<string>();
    const now = new Date();
    for (let i = 0; i < 7; i++) {
      keep.add(fileName(new Date(now.getTime() - i * 86400000)));
    }
    for (const f of readdirSync(logDir)) {
      if (/^daemon-\d{4}-\d{2}-\d{2}\.log$/.test(f) && !keep.has(f)) {
        rmSync(join(logDir, f), { force: true });
      }
    }
  } catch {}
}

export function log(level: "info" | "warn" | "error", msg: string, extra?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${extra !== undefined ? " " + safeJson(extra) : ""}`;
  try {
    const d = new Date();
    const name = fileName(d);
    if (name !== today && logDir) {
      today = name;
      logFile = join(logDir, name);
    }
    if (logFile) appendFileSync(logFile, line + "\n", "utf8");
  } catch {}
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(`[agent-console] ${msg}`, extra !== undefined ? extra : "");
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
