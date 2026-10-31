// JSON-RPC over stdio client for `codex app-server` (§7.3.2).
// stdout is parsed line by line: {id,result|error} → response; {id,method} → server request; {method} → notification.
import { spawn, type ChildProcess } from "node:child_process";
import { log } from "../../log.js";
import { killTree, trackTree, type Argv } from "../../util/bin.js";

export class CodexRpcError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

export class CodexProcessExitedError extends CodexRpcError {
  constructor() {
    super("Codex 进程已退出");
  }
}

type ServerRequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

export class CodexRpc {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = "";
  private exited = false;
  onServerRequest?: ServerRequestHandler;
  onNotification?: NotificationHandler;
  onExit?: (code: number | null) => void;

  constructor(
    argv: Argv,
    opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ) {
    this.proc = spawn(argv.cmd, argv.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(argv.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      // Non-Windows: its own process group, so after a close() timeout killTree also ends the commands codex started
      ...(process.platform !== "win32" ? { detached: true } : {}),
    });
    trackTree(this.proc);
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr!.setEncoding("utf8");
    this.proc.stderr!.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4096);
    });
    this.proc.on("error", () => this.failAll());
    this.proc.on("close", (code) => {
      this.exited = true;
      this.failAll();
      this.onExit?.(code);
    });
  }

  private stderrTail = "";

  get stderr(): string {
    return this.stderrTail;
  }

  get isExited(): boolean {
    return this.exited;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        log("warn", "codex rpc: 非 JSON 行", { line: line.slice(0, 200) });
        continue;
      }
      void this.dispatch(msg);
    }
  }

  private async dispatch(msg: Record<string, unknown>): Promise<void> {
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && ("result" in msg || "error" in msg)) {
      const id = Number(msg.id);
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        if (msg.error) {
          const e = msg.error as { code?: number; message?: string };
          p.reject(new CodexRpcError(e.message ?? "RPC error", e.code));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }
    if (hasId && msg.method) {
      // Server request → needs a response
      const id = Number(msg.id);
      try {
        const result = this.onServerRequest
          ? await this.onServerRequest(String(msg.method), (msg.params as Record<string, unknown>) ?? {})
          : undefined;
        this.send({ id, result: result ?? null });
      } catch (e) {
        this.send({ id, error: { code: -32603, message: String((e as Error)?.message ?? e) } });
      }
      return;
    }
    if (!hasId && msg.method) {
      try {
        this.onNotification?.(String(msg.method), (msg.params as Record<string, unknown>) ?? {});
      } catch (e) {
        log("warn", "codex rpc: 通知处理失败", { method: msg.method, err: String(e) });
      }
    }
  }

  private send(obj: Record<string, unknown>): void {
    if (this.exited) return;
    try {
      this.proc.stdin!.write(JSON.stringify(obj) + "\n");
    } catch {}
  }

  request<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 60000): Promise<T> {
    if (this.exited) return Promise.reject(new CodexProcessExitedError());
    const id = this.nextId++;
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRpcError(`请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolvePromise(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  private failAll(): void {
    const err = new CodexProcessExitedError();
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  async close(): Promise<void> {
    try {
      this.proc.stdin?.end();
    } catch {}
    await new Promise<void>((resolvePromise) => {
      const t = setTimeout(() => {
        void killTree(this.proc, { graceMs: 1500 });
        resolvePromise();
      }, 3000);
      this.proc.on("close", () => {
        clearTimeout(t);
        resolvePromise();
      });
      if (this.exited) {
        clearTimeout(t);
        resolvePromise();
      }
    });
  }
}
