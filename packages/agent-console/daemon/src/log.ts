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

// The console is a pipe to the plugin host. When the host is killed hard, the reader is gone and a write fails with EPIPE
// (asynchronously, as an 'error' event on the stream): without a listener that becomes an uncaughtException. Once that happens
// the console is dropped and only the log file is written.
let consoleGone = false;
let guarded = false;
function guardConsole(): void {
  if (guarded) return;
  guarded = true;
  for (const stream of [process.stdout, process.stderr]) {
    // EPIPE, EIO, ERR_STREAM_DESTROYED…: any write error means the reader is gone; logging must never take the daemon down
    stream?.on?.("error", () => { consoleGone = true; });
  }
}
export function consoleClosed(): boolean {
  return consoleGone;
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
  guardConsole();
  if (consoleGone) return;
  const stream = level === "info" ? process.stdout : process.stderr;
  if (stream?.destroyed || stream?.writableEnded) { consoleGone = true; return; }
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  try {
    fn(`[agent-console] ${msg}`, extra !== undefined ? extra : "");
  } catch {
    consoleGone = true;
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
