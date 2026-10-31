// The user's own `claude` CLI driven over its stream-json protocol (no SDK):
//   claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
//          --permission-prompt-tool stdio [--model m] [--permission-mode p] [--effort e] [--resume id]
// stdin and stdout carry one JSON object per line. Besides the conversation messages (user / assistant / system /
// stream_event / result), both sides send control messages:
//   → {type:"control_request", request_id, request:{subtype:"initialize" | "interrupt" | "set_model" | "set_permission_mode", ...}}
//   ← {type:"control_response", response:{subtype:"success" | "error", request_id, response? | error?}}
//   ← {type:"control_request", request_id, request:{subtype:"can_use_tool", tool_name, input, tool_use_id, ...}}
//   → {type:"control_response", response:{subtype:"success", request_id, response:{behavior:"allow", updatedInput} | {behavior:"deny", message, interrupt?}}}
//   ← {type:"control_cancel_request", request_id}   (the CLI no longer waits for that answer)
import type { ChildProcess } from "node:child_process";
import { killTree, spawnBin, type ResolveResult } from "../../util/bin.js";
import { AsyncQueue } from "../../util/queue.js";

export type ClaudeBin = ResolveResult & { ok: true };
export type Json = Record<string, unknown>;

export type ClaudeCliOpts = {
  bin: ClaudeBin;
  cwd: string;
  model: string | null;
  permissionMode: string;
  effort: string | null;
  resume: string | null;
  env?: NodeJS.ProcessEnv;
};

export type PermissionDecision =
  | { behavior: "allow"; updatedInput: Json }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type ToolRequest = { toolName: string; input: Json; toolUseId?: string; signal: AbortSignal };
export type CanUseTool = (req: ToolRequest) => Promise<PermissionDecision>;

/** Session ids and model / mode / effort names become argv: plain tokens only, so nothing can turn into another flag. */
const SAFE_ARG = /^[A-Za-z0-9][A-Za-z0-9._:\[\]\/@+-]{0,199}$/;

export function claudeArgs(o: Pick<ClaudeCliOpts, "model" | "permissionMode" | "effort" | "resume">): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool", "stdio",
    "--setting-sources", "user,project,local",
  ];
  const put = (flag: string, v: string | null | undefined) => {
    if (!v) return;
    if (!SAFE_ARG.test(v)) throw new Error(`Refusing to pass an unexpected value to claude ${flag}: ${JSON.stringify(v).slice(0, 80)}`);
    args.push(flag, v);
  };
  put("--permission-mode", o.permissionMode);
  // claude only takes bypassPermissions when it is allowed at launch; it is not allowed otherwise (a later switch
  // into it restarts the CLI with --resume)
  if (o.permissionMode === "bypassPermissions") args.push("--allow-dangerously-skip-permissions");
  put("--model", o.model);
  put("--effort", o.effort);
  put("--resume", o.resume);
  return args;
}

type Pending = { resolve: (v: Json) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout };

export class ClaudeCli {
  /** Conversation messages (everything that is not a control message) */
  readonly messages = new AsyncQueue<Json>();
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** The answer to initialize (commands, models, account …), null when it failed */
  readonly initialized: Promise<Json | null>;
  private child: ChildProcess;
  private buf = "";
  private seq = 0;
  private pending = new Map<string, Pending>();
  private cancels = new Map<string, AbortController>();
  private stderrTail = "";
  private dead = false;
  private spawnError: Error | null = null;

  constructor(private o: ClaudeCliOpts, private canUseTool: CanUseTool) {
    const args = claudeArgs(o);
    this.child = spawnBin(o.bin, args, {
      cwd: o.cwd,
      env: { ...(o.env ?? process.env), NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      group: true,
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (d: string) => this.onData(d));
    this.child.stderr?.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-4096);
    });
    this.child.stdin?.on("error", () => {}); // EPIPE after the CLI exits: reported through exited
    this.exited = new Promise((resolve) => {
      this.child.on("error", (e) => {
        this.spawnError = e;
        this.finish();
        resolve({ code: null, signal: null });
      });
      this.child.on("close", (code, signal) => {
        this.finish();
        resolve({ code, signal });
      });
    });
    this.initialized = this.request({ subtype: "initialize" }, 60000).catch(() => null);
  }

  get stderr(): string {
    return this.stderrTail;
  }

  get failure(): Error | null {
    return this.spawnError;
  }

  get alive(): boolean {
    return !this.dead;
  }

  private finish(): void {
    if (this.dead) return;
    this.dead = true;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error("claude exited"));
    }
    this.pending.clear();
    for (const [, c] of this.cancels) c.abort();
    this.cancels.clear();
    this.messages.close();
  }

  private onData(d: string): void {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m: Json;
      try {
        m = JSON.parse(line);
      } catch {
        continue; // a stray non-JSON line (warnings some versions print) is not part of the protocol
      }
      if (m && typeof m === "object") this.onMessage(m);
    }
  }

  private onMessage(m: Json): void {
    if (m.type === "control_response") {
      const r = (m.response ?? {}) as Json;
      const id = String(r.request_id ?? "");
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      if (r.subtype === "success") p.resolve((r.response ?? {}) as Json);
      else p.reject(new Error(String(r.error ?? "control request failed")));
      return;
    }
    if (m.type === "control_request") {
      void this.onControlRequest(String(m.request_id ?? ""), (m.request ?? {}) as Json);
      return;
    }
    if (m.type === "control_cancel_request") {
      const id = String(m.request_id ?? "");
      this.cancels.get(id)?.abort();
      this.cancels.delete(id);
      return;
    }
    if (m.type === "keep_alive") return;
    this.messages.push(m);
  }

  private async onControlRequest(id: string, req: Json): Promise<void> {
    if (req.subtype !== "can_use_tool") {
      // hooks, in-process MCP servers, elicitation …: none are registered, so say so instead of leaving the CLI waiting
      this.write({ type: "control_response", response: { subtype: "error", request_id: id, error: `Unsupported control request: ${String(req.subtype)}` } });
      return;
    }
    const ac = new AbortController();
    this.cancels.set(id, ac);
    try {
      const decision = await this.canUseTool({
        toolName: String(req.tool_name ?? ""),
        input: (req.input && typeof req.input === "object" ? req.input : {}) as Json,
        toolUseId: typeof req.tool_use_id === "string" ? req.tool_use_id : undefined,
        signal: ac.signal,
      });
      if (ac.signal.aborted && !this.cancels.has(id)) return; // cancelled by the CLI: it no longer reads this answer
      this.write({ type: "control_response", response: { subtype: "success", request_id: id, response: decision } });
    } catch (e) {
      this.write({ type: "control_response", response: { subtype: "error", request_id: id, error: String((e as Error)?.message ?? e) } });
    } finally {
      this.cancels.delete(id);
    }
  }

  private write(o: Json): boolean {
    if (this.dead || !this.child.stdin || this.child.stdin.destroyed) return false;
    try {
      this.child.stdin.write(JSON.stringify(o) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /** Send one control request and wait for its answer */
  request(request: Json, timeoutMs = 10000): Promise<Json> {
    if (this.dead) return Promise.reject(new Error("claude is not running"));
    const id = `ac_${++this.seq}_${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<Json>((resolve, reject) => {
      const p: Pending = { resolve, reject };
      p.timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`claude did not answer ${String(request.subtype)} in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, p);
      if (!this.write({ type: "control_request", request_id: id, request })) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        reject(new Error("claude is not running"));
      }
    });
  }

  /** One user message into the conversation */
  sendUser(content: unknown[], sessionId: string | null): boolean {
    return this.write({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: sessionId ?? "" });
  }

  interrupt(): Promise<Json> {
    return this.request({ subtype: "interrupt" }, 5000);
  }

  setModel(model: string | null): Promise<Json> {
    return this.request(model ? { subtype: "set_model", model } : { subtype: "set_model" });
  }

  setPermissionMode(mode: string): Promise<Json> {
    return this.request({ subtype: "set_permission_mode", mode });
  }

  /** End stdin (the CLI finishes and exits), then end the process tree if it lingers */
  async close(graceMs = 2000): Promise<void> {
    try {
      this.child.stdin?.end();
    } catch {}
    const done = await Promise.race([this.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), graceMs))]);
    if (!done) await killTree(this.child, { graceMs: 500 });
    this.finish();
  }
}
