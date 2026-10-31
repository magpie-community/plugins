// Claude ProviderSession (§7.2.2/7.2.4/7.2.5/7.2.6): persistent query, streaming, permissions, interrupt, hot switching.
import { query, type Query, type Options, type SDKUserMessage, type PermissionResult, type EffortLevel, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderSession, SendInput, RespondAnswer, Mode, SlashCommand } from "../types.js";
import type { ProviderEvent } from "../../timeline/types.js";
import { AsyncQueue } from "../../util/queue.js";
import { callInfo } from "../../agents/kinds.js";
import { editDetail } from "../../agents/diff.js";
import { mapSdkMessage, newMapState, type MapState } from "./map.js";
import { log } from "../../log.js";
import { buildClaudeContent } from "./content.js";
import { tr } from "../../util/i18n.js";
import { classifyClaudeSlashCommand, sortSlashCommands } from "../slash.js";

const EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const rid = () => Math.random().toString(36).slice(2, 10);

type PendingReq = {
  kind: "permission" | "question";
  resolve: (r: RespondAnswer) => void;
};

export type ClaudeSessionOpts = {
  threadId: string;
  cwd: string;
  model: string | null;
  mode: Mode;
  effort: string | null;
  resumeId: string | null;
  binCmd: string; // The claude executable (resolveBin's cmd)
  binPrefixArgs: string[]; // = [cli.js] in the shim case of node cli.js
  binVia?: string; // resolveBin's via: for cmd-shim / ps1 the SDK can't launch this file directly
  onModeChange?: (mode: Mode) => void; // Callback when a plan is approved → default (the manager updates meta)
};

/** resolveBin result → pathToClaudeCodeExecutable for the SDK.
 *  - shim-js (node + cli.js): give cli.js to the SDK, which launches it with node;
 *  - executable (native claude / claude.exe): pass it directly;
 *  - cmd-shim / ps1 (.cmd / .ps1 wrappers on Windows): Node can't spawn them directly, so let the SDK find claude itself. */
export function claudeExecutable(o: Pick<ClaudeSessionOpts, "binCmd" | "binPrefixArgs" | "binVia">): { path: string; node: boolean } | null {
  if (!o.binCmd) return null;
  if (o.binVia === "cmd-shim" || o.binVia === "ps1") return null;
  const last = o.binPrefixArgs[o.binPrefixArgs.length - 1];
  if (last && /\.(c|m)?js$/i.test(last)) return { path: last, node: true };
  if (o.binPrefixArgs.length) return null;
  return { path: o.binCmd, node: false };
}

export class ClaudeSession implements ProviderSession {
  events: AsyncIterable<ProviderEvent>;
  private q = new AsyncQueue<ProviderEvent>();
  private input = new AsyncQueue<SDKUserMessage>();
  private query: Query | null = null;
  private abort = new AbortController();
  private sessionId: string | null;
  private turnId: string | null = null;
  private turnNum = 0;
  private st: MapState = newMapState();
  private pending = new Map<string, PendingReq>();
  private needsRestart = false;
  private restarting: Promise<void> | null = null;
  private closed = false;
  private stderrTail = "";
  private pumpDone: Promise<void> | null = null;

  constructor(private o: ClaudeSessionOpts) {
    this.sessionId = o.resumeId;
    this.events = this.q;
  }

  // The query is only started before the first send (a failed detection should be reported quickly)
  private ensureQuery(): Query {
    if (this.query && !this.needsRestart) return this.query;
    this.abort = new AbortController();
    this.st = newMapState();
    const options: Options = {
      cwd: this.o.cwd,
      model: this.o.model ?? undefined,
      permissionMode: this.o.mode as PermissionMode,
      canUseTool: (toolName, input, opts) => this.canUseTool(toolName, input, opts),
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      abortController: this.abort,
      ...(this.sessionId ? { resume: this.sessionId } : {}),
      stderr: (d: string) => {
        this.stderrTail = (this.stderrTail + d).slice(-4096);
      },
    };
    const exe = claudeExecutable(this.o);
    if (exe) {
      options.pathToClaudeCodeExecutable = exe.path;
      if (exe.node) options.executable = "node";
    }
    if (this.o.effort && EFFORTS.includes(this.o.effort as EffortLevel)) {
      options.effort = this.o.effort as EffortLevel;
    }
    const q = query({ prompt: this.input as AsyncIterable<SDKUserMessage>, options });
    this.query = q;
    this.needsRestart = false;
    this.pumpDone = this.pump(q);
    return q;
  }

  private async pump(q: Query): Promise<void> {
    try {
      for await (const m of q) {
        for (const ev of mapSdkMessage(m, this.st, this.o.cwd)) this.emit(ev);
      }
    } catch (e) {
      // An end caused by abort is not a crash
      if (!this.abort.signal.aborted && !this.closed) {
        this.emit({ type: "notice", level: "error", message: "Claude 会话异常：" + this.errText(e) });
      }
    }
    // The event stream ended. An old query that restart() deliberately replaced (this.query is no longer it) must not close the event queue,
    // otherwise every event of the new query is dropped and the next turn stays running forever.
    if (!this.closed && this.query === q) {
      this.needsRestart = true; // Rebuild with resume on the next send
      this.q.close();
    }
  }

  private emit(ev: ProviderEvent): void {
    if (ev.type === "turn_ended" && !ev.turnId) ev.turnId = this.turnId ?? "unknown";
    if (ev.type === "provider_session_id" && ev.id) this.sessionId = ev.id;
    this.q.push(ev);
  }

  private errText(e: unknown): string {
    const base = String((e as Error)?.message ?? e);
    return this.stderrTail ? `${base}；stderr: ${this.stderrTail.slice(-400)}` : base;
  }

  async send(input: SendInput): Promise<void> {
    if (this.closed) throw new Error("会话已关闭");
    if (this.needsRestart) await this.restart();
    const q = this.ensureQuery();
    this.turnNum++;
    this.turnId = "u_" + Date.now().toString(36) + "_" + this.turnNum;
    this.st.sawInterrupt = false; // A new turn clears the old interrupt flag
    this.emit({
      type: "turn_started",
      turnId: this.turnId,
      model: this.o.model,
      mode: this.o.mode,
      effort: this.o.effort,
    });
    const built = await buildClaudeContent(input.text, input.images ?? []);
    for (const w of built.warnings) this.emit({ type: "notice", level: "warn", message: tr("notice.attachmentIssue", { detail: w }) });
    const content = built.blocks as unknown as SDKUserMessage["message"]["content"];
    this.input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? "",
    });
    void q; // Messages flow into the running query through input
  }

  private async restart(): Promise<void> {
    if (this.restarting) return this.restarting;
    this.restarting = (async () => {
      // Close the old query (drop the reference first so the old pump knows on exit that this was a deliberate restart)
      this.query = null;
      try {
        this.input.close();
        this.abort.abort();
      } catch {}
      if (this.pumpDone) await this.pumpDone.catch(() => {});
      // New input queue (the old one may already be closed)
      this.input = new AsyncQueue<SDKUserMessage>();
      try {
        this.ensureQuery();
      } finally {
        this.restarting = null;
      }
    })();
    return this.restarting;
  }

  // ---- permissions (§7.2.4) ----
  private canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; toolUseID?: string },
  ): Promise<PermissionResult | null> {
    const requestId = "perm_" + rid();
    const { signal } = opts;

    if (toolName === "ExitPlanMode") {
      return this.handlePlanMode(requestId, input, signal, opts.toolUseID);
    }
    if (toolName === "AskUserQuestion" && Array.isArray(input.questions)) {
      return this.handleQuestion(requestId, input, signal);
    }

    const info = callInfo(toolName, { ...input, _exists: true }, this.o.cwd);
    let detail: Record<string, unknown> = { ...(info.detail as Record<string, unknown>), toolName };
    if (info.kind === "edit" && (input.old_string !== undefined || Array.isArray(input.edits))) {
      detail = { ...editDetail({ path: info.detail.path as string, old: input.old_string, new: input.new_string, edits: input.edits }), toolName };
    }
    this.emit({
      type: "permission_request",
      requestId,
      title: info.title,
      kind: "tool",
      detail,
      options: [
        { id: "allow", label: "允许", kind: "allow_once" },
        { id: "allow_always", label: "本对话都允许", kind: "allow_always" },
        { id: "deny", label: "拒绝", kind: "reject_once" },
      ],
    });
    return new Promise<PermissionResult | null>((resolve) => {
      this.pending.set(requestId, { kind: "permission", resolve: (a) => resolve(this.toPermissionResult(a, input)) });
      signal.addEventListener("abort", () => {
        if (this.pending.delete(requestId)) {
          this.emit({ type: "permission_resolved", requestId, cancelled: true });
          resolve({ behavior: "deny", message: "已取消", interrupt: true });
        }
      }, { once: true });
    });
  }

  private toPermissionResult(a: RespondAnswer, input: Record<string, unknown>): PermissionResult {
    if (a.cancelled || a.optionId === "deny") {
      return { behavior: "deny", message: "用户拒绝了此操作", ...(a.cancelled ? { interrupt: true } : {}) };
    }
    return { behavior: "allow", updatedInput: input };
  }

  private async handlePlanMode(requestId: string, input: Record<string, unknown>, signal: AbortSignal, toolUseID?: string): Promise<PermissionResult | null> {
    const planText = typeof input.plan === "string" ? input.plan : "";
    if (planText) {
      this.emit({ type: "plan", itemId: toolUseID ?? requestId, markdown: planText });
    }
    this.emit({
      type: "permission_request",
      requestId,
      title: "Agent 提交了计划",
      kind: "plan",
      detail: { plan: planText },
      options: [
        { id: "implement", label: "实施", kind: "allow_once" },
        { id: "reject", label: "拒绝", kind: "reject_once" },
      ],
    });
    const answer = await new Promise<RespondAnswer>((resolve) => {
      this.pending.set(requestId, { kind: "permission", resolve: (a) => resolve(a as RespondAnswer) });
      signal.addEventListener("abort", () => {
        if (this.pending.delete(requestId)) {
          this.emit({ type: "permission_resolved", requestId, cancelled: true });
          resolve({ cancelled: true });
        }
      }, { once: true });
    });
    if (answer.cancelled || answer.optionId === "reject") {
      return { behavior: "deny", message: "用户拒绝了计划，请根据反馈修改", ...(answer.cancelled ? { interrupt: true } : {}) };
    }
    // implement: switch back to default mode
    try {
      await this.query?.setPermissionMode("default");
      this.o.mode = "default";
      this.o.onModeChange?.("default");
    } catch (e) {
      log("warn", "setPermissionMode(default) 失败", { err: String(e) });
    }
    return { behavior: "allow", updatedInput: input };
  }

  private async handleQuestion(requestId: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult | null> {
    this.emit({ type: "question", requestId, questions: input.questions as unknown[] });
    const answer = await new Promise<RespondAnswer>((resolve) => {
      this.pending.set(requestId, { kind: "question", resolve: (a) => resolve(a as RespondAnswer) });
      signal.addEventListener("abort", () => {
        if (this.pending.delete(requestId)) {
          this.emit({ type: "permission_resolved", requestId, cancelled: true });
          resolve({ cancelled: true });
        }
      }, { once: true });
    });
    if (answer.cancelled) {
      return { behavior: "deny", message: "用户取消了提问", interrupt: true };
    }
    // answers are keyed by the question text (Claude's AskUserQuestion schema keys answers by question text)
    const questions = (input.questions as { question?: string; header?: string }[]) ?? [];
    const normalized: Record<string, string> = {};
    for (const ques of questions) {
      const text = ques.question;
      if (!text) continue;
      const v = answer.answers?.[text] ?? (ques.header ? answer.answers?.[ques.header] : undefined);
      if (v) normalized[text] = v;
    }
    return { behavior: "allow", updatedInput: { ...input, answers: normalized } };
  }

  respond(requestId: string, answer: RespondAnswer): void {
    const p = this.pending.get(requestId);
    if (p) {
      this.pending.delete(requestId);
      p.resolve(answer);
    }
  }

  async interrupt(): Promise<void> {
    this.st.sawInterrupt = true;
    // Cancel every pending permission/question
    for (const [id, p] of this.pending) {
      this.emit({ type: "permission_resolved", requestId: id, cancelled: true });
      p.resolve({ cancelled: true });
    }
    this.pending.clear();
    try {
      const q = this.query;
      if (q) {
        await Promise.race([
          q.interrupt(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("interrupt 超时")), 3000)),
        ]);
      }
    } catch (e) {
      log("warn", "interrupt 失败", { err: String(e) });
      this.needsRestart = true;
    }
  }

  async setModel(model: string | null): Promise<void> {
    this.o.model = model;
    try {
      await this.query?.setModel(model ?? undefined);
    } catch (e) {
      log("warn", "setModel 失败", { err: String(e) });
    }
  }

  async setMode(mode: Mode): Promise<void> {
    this.o.mode = mode;
    try {
      await this.query?.setPermissionMode(mode as PermissionMode);
    } catch (e) {
      log("warn", "setPermissionMode 失败", { err: String(e) });
    }
  }

  async setEffort(effort: string | null): Promise<void> {
    this.o.effort = effort;
    // SDK Options.effort only applies when the query is created → rebuild (continued via resume)
    this.needsRestart = true;
  }

  async listCommands(): Promise<SlashCommand[]> {
    try {
      const q = this.ensureQuery();
      const commands = await q.supportedCommands();
      const map = new Map<string, SlashCommand>();
      for (const cmd of commands) {
        if (!map.has(cmd.name)) {
          map.set(cmd.name, {
            name: cmd.name,
            description: cmd.description,
            argumentHint: cmd.argumentHint,
            kind: classifyClaudeSlashCommand(cmd.name),
          });
        }
      }
      return sortSlashCommands([...map.values()]);
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [, p] of this.pending) p.resolve({ cancelled: true });
    this.pending.clear();
    this.input.close();
    try {
      this.abort.abort();
    } catch {}
    if (this.pumpDone) {
      await Promise.race([this.pumpDone.catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    }
    this.q.close();
  }
}
