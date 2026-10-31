// TerminalService (§7.5): node-pty first, falling back to a no-PTY mode if it can't be loaded.
// Output goes into a ring buffer (5000 lines / 2MB), coalesced every 16ms and pushed as gateway binary frames to connections subscribed to terminal:<index>.
// Frame format (§5.4): [op:1][index:2 BE][payload]; op 1=output 2=input 3=resize (JSON).
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, chmodSync, constants as fsc, existsSync, statSync } from "node:fs";
import { createRequire as moduleRequire } from "node:module";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { findOnPath } from "../../../lib/pathscan.mjs";
import type { Gateway } from "../ws/gateway.js";
import { log } from "../log.js";
import { tr } from "../util/i18n.js";

type Pty = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  pid: number;
};

type Term = {
  id: string;
  index: number;
  projectId: string;
  cwd: string;
  title: string;
  alive: boolean;
  simple: boolean; // No-PTY fallback
  pty: Pty | null;
  proc: ChildProcessWithoutNullStreams | null;
  buf: string;      // Ring buffer text (≤2MB; attach takes the last 5000 lines)
  pend: string;     // Pending output, coalesced every 16ms
  timer: NodeJS.Timeout | null;
  exited?: boolean;
};

const MAX_TERMS_PER_PROJECT = 8;
const BUF_MAX = 2 * 1024 * 1024;
const SNAP_LINES = 5000;

type ShellEnv = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  find?: (name: string) => string | null;
  isExec?: (file: string) => boolean;
};

function isExecFile(file: string): boolean {
  try {
    accessSync(file, fsc.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Default shell: Windows pwsh → powershell → cmd; elsewhere $SHELL (if it exists) → macOS zsh → bash → sh. */
export function pickShell(o: ShellEnv = {}): string {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const find = o.find ?? ((n: string) => findOnPath(n, { platform, env })[0] ?? null);
  const isExec = o.isExec ?? isExecFile;
  if (platform === "win32") {
    for (const s of ["pwsh", "powershell"]) {
      const hit = find(s);
      if (hit) return hit;
    }
    const sysRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows";
    const ps = `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    if (isExec(ps)) return ps;
    return env.ComSpec || env.COMSPEC || "cmd.exe";
  }
  if (env.SHELL && env.SHELL.startsWith("/") && isExec(env.SHELL)) return env.SHELL;
  const order = platform === "darwin" ? ["/bin/zsh", "/bin/bash", "/bin/sh"] : ["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/bin/sh"];
  for (const s of order) if (isExec(s)) return s;
  return "/bin/sh";
}

/** Shell arguments without a PTY: powershell needs -Command - since it doesn't read a stdin prompt; cmd uses /Q; POSIX uses interactive -i. */
export function simpleShellArgs(shell: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    if (/(^|[\\/])cmd(\.exe)?$/i.test(shell)) return ["/Q"];
    return ["-NoLogo"];
  }
  return ["-i"];
}

/** node-pty's macOS prebuilds start children through spawn-helper; npm unpacking sometimes drops its executable bit → posix_spawnp failed. */
function fixSpawnHelper(): void {
  if (process.platform !== "darwin") return;
  try {
    const req = moduleRequire(import.meta.url);
    const root = dirname(req.resolve("node-pty/package.json"));
    for (const sub of [`prebuilds/darwin-${process.arch}`, "build/Release"]) {
      const f = join(root, sub, "spawn-helper");
      if (existsSync(f) && !isExecFile(f)) {
        chmodSync(f, 0o755);
        log("info", "已修复 node-pty spawn-helper 的可执行位", { file: f });
      }
    }
  } catch {}
}

function conptyInfo(): { backend: "conpty"; buildNumber: number } {
  const build = Number(release().split(".")[2]);
  return { backend: "conpty", buildNumber: Number.isFinite(build) ? build : 0 };
}

let nextIndex = 1;
const rid = () => "t_" + Math.random().toString(36).slice(2, 10);

export class TerminalService {
  private terms = new Map<string, Term>();
  private byIndex = new Map<number, Term>();
  private ptyLib: typeof import("node-pty") | null | undefined;

  constructor(private gw: Gateway) {
    gw.onTerminalInput = (conn, index, op, payload) => this.onInput(conn, index, op, payload);
  }

  private async loadPty(): Promise<typeof import("node-pty") | null> {
    if (this.ptyLib !== undefined) return this.ptyLib;
    try {
      fixSpawnHelper();
      this.ptyLib = await import("node-pty");
    } catch (e) {
      log("warn", "node-pty 加载失败，终端退化无 PTY 方案", { err: String(e) });
      this.ptyLib = null;
    }
    return this.ptyLib;
  }

  list(projectId?: string) {
    return [...this.terms.values()]
      .filter((t) => !projectId || t.projectId === projectId)
      .map((t) => ({ id: t.id, index: t.index, projectId: t.projectId, title: t.title, alive: t.alive, simple: t.simple }));
  }

  get count(): number {
    return [...this.terms.values()].filter((t) => t.alive).length;
  }

  async create(projectId: string, cwd: string, cols: number, rows: number): Promise<{ id: string; index: number; simple: boolean } | { error: string }> {
    const alive = [...this.terms.values()].filter((t) => t.projectId === projectId && t.alive);
    if (alive.length >= MAX_TERMS_PER_PROJECT) return { error: tr("term.max", { n: MAX_TERMS_PER_PROJECT }) };
    const shell = pickShell();
    const term: Term = {
      id: rid(), index: nextIndex++, projectId, cwd, title: tr("term.title", { n: alive.length + 1 }),
      alive: true, simple: false, pty: null, proc: null, buf: "", pend: "", timer: null,
    };
    const pty = await this.loadPty();
    if (pty) {
      try {
        const p = pty.spawn(shell, [], {
          name: "xterm-256color", cols: Math.max(20, cols), rows: Math.max(5, rows), cwd, env: process.env,
        });
        term.pty = { write: (d) => p.write(d), resize: (c, r) => p.resize(c, r), kill: () => p.kill(), onData: (cb) => p.onData(cb), onExit: (cb) => p.onExit(cb), pid: p.pid };
        term.pty.onData((d) => this.onData(term, d));
        term.pty.onExit(() => this.onExit(term));
      } catch (e) {
        log("warn", "pty.spawn 失败，退化无 PTY 方案", { err: String(e) });
      }
    }
    if (!term.pty) {
      // No-PTY mode
      term.simple = true;
      const args = simpleShellArgs(shell);
      // Non-Windows: detached, its own process group, so closing the terminal kill(-pgid)s the commands running in the shell too
      const proc = spawn(shell, args, {
        cwd, stdio: "pipe", windowsHide: true, env: process.env,
        detached: process.platform !== "win32",
      });
      term.proc = proc;
      // StringDecoder: no garbling when a multibyte character (e.g. Chinese) is split across two chunks
      const outDec = new StringDecoder("utf8");
      const errDec = new StringDecoder("utf8");
      proc.stdout.on("data", (d: Buffer) => this.onData(term, outDec.write(d)));
      proc.stderr.on("data", (d: Buffer) => this.onData(term, errDec.write(d)));
      proc.on("exit", () => this.onExit(term));
      proc.on("error", () => this.onExit(term));
    }
    this.terms.set(term.id, term);
    this.byIndex.set(term.index, term);
    return { id: term.id, index: term.index, simple: term.simple };
  }

  attach(id: string): {
    index?: number;
    snapshot?: string;
    simple?: boolean;
    windowsPty?: { backend: "conpty"; buildNumber: number };
    error?: string;
  } {
    const t = this.terms.get(id);
    if (!t) return { error: tr("err.terminalMissing") };
    // Last 5000 lines
    const lines = t.buf.split("\n");
    const snapshot = lines.length > SNAP_LINES ? lines.slice(-SNAP_LINES).join("\n") : t.buf;
    // On Windows node-pty uses ConPTY: tell xterm.js so it handles line reflow the ConPTY way
    const windowsPty = process.platform === "win32" && t.pty ? conptyInfo() : undefined;
    return { index: t.index, snapshot, simple: t.simple, ...(windowsPty ? { windowsPty } : {}) };
  }

  indexOf(id: string): number | null {
    return this.terms.get(id)?.index ?? null;
  }

  resize(id: string, cols: number, rows: number): { ok: boolean } {
    const t = this.terms.get(id);
    if (!t || !t.alive) return { ok: false };
    t.pty?.resize(Math.max(20, cols), Math.max(5, rows));
    return { ok: true };
  }

  kill(id: string): { ok: boolean } {
    const t = this.terms.get(id);
    if (!t) return { ok: false };
    this.killTerm(t);
    return { ok: true };
  }

  killAll(): void {
    // Called before the daemon exits: kill synchronously so the process trees are gone before exit
    for (const t of this.terms.values()) this.killTerm(t, true);
  }

  // ---- internals ----
  // Killing only the shell would orphan the npm run dev etc. it started → on Windows taskkill /T kills the whole tree
  private killTree(pid: number | undefined, sync: boolean, group: boolean): void {
    if (!pid) return;
    if (process.platform !== "win32") {
      // The no-PTY shell leads a detached process group; a PTY shell leads its session, and pty.kill() sends SIGHUP, which the shell forwards to its jobs
      if (group) {
        try { process.kill(-pid, "SIGTERM"); } catch {}
        const t = setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, 1500);
        t.unref?.();
      }
      return;
    }
    const args = ["/pid", String(pid), "/T", "/F"];
    try {
      if (sync) execFileSync("taskkill", args, { windowsHide: true, stdio: "ignore", timeout: 5000 });
      else spawn("taskkill", args, { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    } catch {}
  }

  private killTerm(t: Term, sync = false): void {
    t.alive = false;
    this.killTree(t.pty?.pid ?? t.proc?.pid, sync, !t.pty && !!t.proc);
    if (t.timer) { clearTimeout(t.timer); t.timer = null; }
    try { t.pty?.kill(); } catch {}
    try { t.proc?.kill(); } catch {}
    this.terms.delete(t.id);
    this.byIndex.delete(t.index);
  }

  private onExit(t: Term): void {
    if (t.timer) {
      // Flush the last batch of output first, then send exit
      clearTimeout(t.timer);
      t.timer = null;
      if (t.pend) {
        this.gw.publishTerminal(t.index, Buffer.from(t.pend, "utf8"));
        t.pend = "";
      }
    }
    if (t.exited) return; // exit and error may both fire: send only once
    t.exited = true;
    t.alive = false;
    this.terms.delete(t.id);
    this.byIndex.delete(t.index);
    this.gw.publish("terminals", { type: "terminal.exit", id: t.id, index: t.index });
  }

  private onData(t: Term, d: string): void {
    t.buf += d;
    if (t.buf.length > BUF_MAX) t.buf = t.buf.slice(-BUF_MAX / 2);
    t.pend += d;
    if (!t.timer) {
      t.timer = setTimeout(() => {
        t.timer = null;
        if (t.pend) {
          this.gw.publishTerminal(t.index, Buffer.from(t.pend, "utf8"));
          t.pend = "";
        }
      }, 16);
    }
  }

  // Input frames: op 2=input, 3=resize
  private onInput(conn: { subs: Set<string> }, index: number, op: number, payload: Buffer): void {
    const t = this.byIndex.get(index);
    if (!t || !t.alive) return;
    if (!conn.subs.has(`terminal:${index}`)) return; // Only connections that attached may write
    if (op === 2) {
      const s = payload.toString("utf8");
      if (t.pty) t.pty.write(s);
      else t.proc?.stdin.write(s);
    } else if (op === 3) {
      try {
        const { cols, rows } = JSON.parse(payload.toString("utf8")) as { cols?: number; rows?: number };
        if (cols && rows) this.resize(t.id, cols, rows);
      } catch {}
    }
  }
}
