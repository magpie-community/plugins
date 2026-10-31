// Claude ProviderSession (§7.2.2/7.2.4/7.2.5/7.2.6): the user's own `claude` CLI over stream-json (./cli.ts),
// one process per conversation, streaming, permissions, interrupt, hot switching. No SDK.
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
import { ClaudeCli, type ClaudeBin, type PermissionDecision, type ToolRequest } from "./cli.js";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODES = ["plan", "default", "acceptEdits", "bypassPermissions"];
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
  /** The user's claude, as resolveBin found it (a .cmd / .ps1 shim is started through cmd.exe / PowerShell by spawnBin) */
  bin: ClaudeBin;
  /** Environment for the CLI (tests point it at a stand-in); process.env when absent */
  env?: NodeJS.ProcessEnv;
  onModeChange?: (mode: Mode) => void; // Callback when a plan is approved → default (the manager updates meta)
};

export class ClaudeSession implements ProviderSession {
  events: AsyncIterable<ProviderEvent>;
  private q = new AsyncQueue<ProviderEvent>();
  private cli: ClaudeCli | null = null;
  private sessionId: string | null;
  private turnId: string | null = null;
  private turnNum = 0;
  private st: MapState = newMapState();
  private pending = new Map<string, PendingReq>();
  private needsRestart = false;
  private restarting: Promise<void> | null = null;
  private closed = false;
  private stopping = new WeakSet<ClaudeCli>();
  private pumpDone: Promise<void> | null = null;
  /** Mode the running CLI was started with (bypassPermissions has to be allowed at launch) */
  private launchedMode: string | null = null;

  constructor(private o: ClaudeSessionOpts) {
    this.sessionId = o.resumeId;
    this.events = this.q;
  }

  // The CLI is only started before the first send (or a command list request)
  private ensureCli(): ClaudeCli {
    if (this.cli && !this.needsRestart) return this.cli;
    this.st = newMapState();
    const effort = this.o.effort && EFFORTS.includes(this.o.effort) ? this.o.effort : null;
    const cli = new ClaudeCli(
      {
        bin: this.o.bin,
        cwd: this.o.cwd,
        model: this.o.model,
        permissionMode: MODES.includes(this.o.mode) ? this.o.mode : "default",
        effort,
        resume: this.sessionId,
        env: this.o.env,
      },
      (req) => this.canUseTool(req),
    );
    this.cli = cli;
    this.launchedMode = this.o.mode;
    this.needsRestart = false;
    this.pumpDone = this.pump(cli);
    return cli;
  }

  private async pump(cli: ClaudeCli): Promise<void> {
    for await (const m of cli.messages) {
      for (const ev of mapSdkMessage(m, this.st, this.o.cwd)) this.emit(ev);
    }
    const exit = await cli.exited;
    // A CLI this session stopped on purpose (restart / close) is not a crash
    if (this.closed || this.stopping.has(cli)) return;
    const detail = cli.failure
      ? tr("claude.startFailed", { detail: String(cli.failure.message) })
      : tr("claude.exited", { code: String(exit.code ?? exit.signal ?? "?") });
    const tail = cli.stderr.trim().slice(-400);
    this.emit({ type: "notice", level: "error", message: tail ? `${detail} — stderr: ${tail}` : detail });
    if (this.turnId) this.emit({ type: "turn_ended", turnId: this.turnId, status: "failed", error: detail });
    this.turnId = null;
    // The event stream ended: an old CLI that restart() replaced must not close the event queue
    if (this.cli === cli) {
      this.needsRestart = true; // Rebuild with --resume on the next send
      this.q.close();
    }
  }

  private emit(ev: ProviderEvent): void {
    if (ev.type === "turn_ended" && !ev.turnId) ev.turnId = this.turnId ?? "unknown";
    if (ev.type === "turn_ended") this.turnId = null;
    if (ev.type === "provider_session_id" && ev.id) this.sessionId = ev.id;
    this.q.push(ev);
  }

  async send(input: SendInput): Promise<void> {
    if (this.closed) throw new Error(tr("claude.closed"));
    if (this.needsRestart) await this.restart();
    const cli = this.ensureCli();
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
    if (!cli.sendUser(built.blocks, this.sessionId)) throw new Error(tr("claude.notRunning"));
  }

  private async restart(): Promise<void> {
    if (this.restarting) return this.restarting;
    this.restarting = (async () => {
      const old = this.cli;
      this.cli = null;
      if (old) {
        this.stopping.add(old);
        await old.close().catch(() => {});
      }
      if (this.pumpDone) await this.pumpDone.catch(() => {});
      try {
        this.ensureCli();
      } finally {
        this.restarting = null;
      }
    })();
    return this.restarting;
  }

  // ---- permissions (§7.2.4) ----
  private canUseTool(req: ToolRequest): Promise<PermissionDecision> {
    const { toolName, input, signal } = req;
    const requestId = "perm_" + rid();
    const opts = { toolUseID: req.toolUseId };

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
    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(requestId, { kind: "permission", resolve: (a) => resolve(this.toPermissionDecision(a, input)) });
      signal.addEventListener("abort", () => {
        if (this.pending.delete(requestId)) {
          this.emit({ type: "permission_resolved", requestId, cancelled: true });
          resolve({ behavior: "deny", message: "已取消", interrupt: true });
        }
      }, { once: true });
    });
  }

  private toPermissionDecision(a: RespondAnswer, input: Record<string, unknown>): PermissionDecision {
    if (a.cancelled || a.optionId === "deny") {
      return { behavior: "deny", message: "用户拒绝了此操作", ...(a.cancelled ? { interrupt: true } : {}) };
    }
    return { behavior: "allow", updatedInput: input };
  }

  private async handlePlanMode(requestId: string, input: Record<string, unknown>, signal: AbortSignal, toolUseID?: string): Promise<PermissionDecision> {
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
      await this.cli?.setPermissionMode("default");
      this.o.mode = "default";
      this.o.onModeChange?.("default");
    } catch (e) {
      log("warn", "setPermissionMode(default) 失败", { err: String(e) });
    }
    return { behavior: "allow", updatedInput: input };
  }

  private async handleQuestion(requestId: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionDecision> {
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
    const cli = this.cli;
    if (!cli || !cli.alive) return;
    try {
      await cli.interrupt();
    } catch (e) {
      // No answer: stop this CLI; the next send starts it again with --resume
      log("warn", "claude interrupt failed", { err: String(e) });
      this.stopping.add(cli);
      this.needsRestart = true;
      void cli.close(500);
      if (this.turnId) this.emit({ type: "turn_ended", turnId: this.turnId, status: "interrupted" });
    }
  }

  async setModel(model: string | null): Promise<void> {
    this.o.model = model;
    if (!this.cli?.alive) return;
    try {
      await this.cli.setModel(model);
    } catch (e) {
      log("warn", "claude set_model failed", { err: String(e) });
      this.needsRestart = true;
    }
  }

  async setMode(mode: Mode): Promise<void> {
    this.o.mode = mode;
    if (!this.cli?.alive) return;
    // bypassPermissions is only accepted by a CLI started with it allowed: restart into it (--resume keeps the context)
    if (mode === "bypassPermissions" && this.launchedMode !== "bypassPermissions") {
      this.needsRestart = true;
      return;
    }
    try {
      await this.cli.setPermissionMode(mode);
    } catch (e) {
      log("warn", "claude set_permission_mode failed", { err: String(e) });
      this.needsRestart = true;
    }
  }

  async setEffort(effort: string | null): Promise<void> {
    this.o.effort = effort;
    // --effort is a launch flag → restart (continued via --resume)
    this.needsRestart = true;
  }

  async listCommands(): Promise<SlashCommand[]> {
    try {
      const init = await this.ensureCli().initialized;
      const commands = Array.isArray(init?.commands) ? (init!.commands as { name?: string; description?: string; argumentHint?: string }[]) : [];
      const map = new Map<string, SlashCommand>();
      for (const cmd of commands) {
        if (cmd?.name && !map.has(cmd.name)) {
          map.set(cmd.name, {
            name: cmd.name,
            description: cmd.description ?? "",
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
    const cli = this.cli;
    if (cli) {
      this.stopping.add(cli);
      await cli.close().catch(() => {});
    }
    if (this.pumpDone) {
      await Promise.race([this.pumpDone.catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    }
    this.q.close();
  }
}
