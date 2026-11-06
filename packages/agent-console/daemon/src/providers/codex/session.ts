// Codex ProviderSession (§7.3.3/7.3.5): codex app-server JSON-RPC session.
import type { LaunchCommand, ProviderSession, SendInput, RespondAnswer, Mode, SlashCommand } from "../types.js";
import { buildCodexInput } from "./input.js";
import { tr } from "../../util/i18n.js";
import type { ProviderEvent } from "../../timeline/types.js";
import { AsyncQueue } from "../../util/queue.js";
import { CodexRpc } from "./rpc.js";
import { argvFor } from "../../util/bin.js";
import { mapNotification, newCodexMapState, type CodexMapState } from "./map.js";
import {
  codexSlashCommandsFromEntries,
  expandCodexSlash,
  loadCodexSlashEntries,
  type CodexSlashEntry,
} from "./commands.js";
import { log } from "../../log.js";
import { launchArgv } from "../launch.js";

const rid = () => Math.random().toString(36).slice(2, 10);

// §7.3.3 permission presets (per the four modes). Note the two shapes differ:
// `sandbox` in thread/start|resume is a kebab-case enum ("read-only"…);
// `sandboxPolicy` in turn/start is an object ({type:"readOnly"}…).
const MODE_PRESETS: Record<Mode, { approvalPolicy: string; sandbox: string; sandboxPolicy: Record<string, unknown> }> = {
  plan: { approvalPolicy: "on-request", sandbox: "read-only", sandboxPolicy: { type: "readOnly" } },
  default: { approvalPolicy: "on-request", sandbox: "read-only", sandboxPolicy: { type: "readOnly" } },
  acceptEdits: { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite" } },
  bypassPermissions: { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } },
  ask: { approvalPolicy: "on-request", sandbox: "read-only", sandboxPolicy: { type: "readOnly" } },
};

type PendingReq = {
  kind: "permission" | "question";
  resolve: (a: RespondAnswer) => void;
};

export class CodexSession implements ProviderSession {
  events: AsyncIterable<ProviderEvent>;
  private q = new AsyncQueue<ProviderEvent>();
  private rpc: CodexRpc | null = null;
  private st: CodexMapState = newCodexMapState();
  private sessionThreadId: string | null = null;
  private pending = new Map<string, PendingReq>();
  private closed = false;
  private started: Promise<void> | null = null;
  private ourTurnId: string | null = null; // The current turn's turnId in the timeline (generated on send)
  /** Codex turn ids whose late started/completed/deltas must be ignored. */
  private staleCodexTurns = new Set<string>();
  private codexSlash: CodexSlashEntry[] | null = null;

  constructor(
    private o: {
      threadId: string;
      cwd: string;
      model: string | null;
      mode: Mode;
      effort: string | null;
      resumeId: string | null;
      binCmd: string;
      binPrefixArgs: string[];
      binVia?: string;
      binShim?: string;
      version: string;
      launch?: LaunchCommand;
    },
  ) {
    this.events = this.q;
  }

  private emit(ev: ProviderEvent): void {
    if (ev.type === "turn_ended") {
      // Late completion for a turn we already interrupted (or superseded): drop it
      if (ev.turnId && this.staleCodexTurns.delete(ev.turnId)) {
        if (this.st.currentTurnId === ev.turnId) this.st.currentTurnId = null;
        return;
      }
      // Remap Codex turn id → our timeline turnId only when it is the active turn.
      // If ourTurnId was already cleared (interrupted) or belongs to another turn, do not emit a
      // stray turn_ended under the raw codex-turn-* id (yetone's probe: turn_ended codex-turn-2).
      if (this.ourTurnId) {
        if (!ev.turnId || ev.turnId === this.st.currentTurnId || ev.turnId === this.ourTurnId) {
          ev.turnId = this.ourTurnId;
        } else {
          // Completion for some other Codex turn while we have an active local turn — ignore
          return;
        }
        this.ourTurnId = null;
        this.st.currentTurnId = null;
      } else {
        // No active local turn — drop provider completions (already ended locally or spurious)
        if (ev.turnId) {
          this.staleCodexTurns.delete(ev.turnId);
          if (this.st.currentTurnId === ev.turnId) this.st.currentTurnId = null;
        }
        return;
      }
    }
    this.q.push(ev);
  }

  private async start(): Promise<void> {
    if (this.started) return this.started;
    const attempt = (async () => {
      const rpc = new CodexRpc(
        argvFor(
          { ok: true, cmd: this.o.binCmd, prefixArgs: this.o.binPrefixArgs, display: this.o.binCmd, via: this.o.binVia ?? "path", shim: this.o.binShim },
          launchArgv(["app-server"], this.o.launch),
        ),
        { cwd: this.o.cwd },
      );
      this.rpc = rpc;
      rpc.onNotification = (m, p) => {
        const turnFromParams = (): string | null => {
          const turn = (p as { turn?: { id?: string } })?.turn;
          if (typeof turn?.id === "string") return turn.id;
          if (typeof (p as { turnId?: string }).turnId === "string") return (p as { turnId: string }).turnId;
          return null;
        };
        const tid = turnFromParams();
        // Any notification for a stale Codex turn (started / completed / deltas if tagged) is ignored
        if (tid && this.staleCodexTurns.has(tid)) {
          if (m === "turn/completed") this.staleCodexTurns.delete(tid);
          return;
        }
        for (const ev of mapNotification(m, p, this.st)) this.emit(ev);
      };
      rpc.onServerRequest = (m, p) => this.onServerRequest(m, p);
      rpc.onExit = () => {
        for (const [, p] of this.pending) p.resolve({ cancelled: true });
        this.pending.clear();
        if (!this.closed) this.q.close();
      };
      await rpc.request("initialize", {
        clientInfo: { name: "agent-console", title: "Agent Console", version: this.o.version },
        capabilities: { experimentalApi: true },
      });
      rpc.notify("initialized", {});
      const preset = MODE_PRESETS[this.o.mode];
      let threadId: string;
      if (this.o.resumeId) {
        const res = (await rpc.request("thread/resume", {
          threadId: this.o.resumeId,
          cwd: this.o.cwd,
          model: this.o.model,
          approvalPolicy: preset.approvalPolicy,
          sandbox: preset.sandbox,
        })) as { thread?: { id?: string } };
        threadId = res.thread?.id ?? this.o.resumeId;
      } else {
        const res = (await rpc.request("thread/start", {
          cwd: this.o.cwd,
          model: this.o.model,
          approvalPolicy: preset.approvalPolicy,
          sandbox: preset.sandbox,
        })) as { thread?: { id?: string } };
        threadId = res.thread?.id ?? "";
      }
      if (threadId) {
        this.sessionThreadId = threadId;
        this.emit({ type: "provider_session_id", id: threadId });
      }
    })();
    // Don't cache a failed start: clear it so the next send starts app-server again
    this.started = attempt.catch((e) => {
      if (this.started === guarded) {
        this.started = null;
        const rpc = this.rpc;
        this.rpc = null;
        if (rpc) {
          rpc.onExit = () => {};
          void Promise.resolve(rpc.close()).catch(() => {});
        }
      }
      throw e;
    });
    const guarded = this.started;
    return this.started;
  }

  async send(input: SendInput): Promise<void> {
    if (this.closed) throw new Error(tr("codex.closed"));
    await this.start();
    const rpc = this.rpc!;
    const preset = MODE_PRESETS[this.o.mode];
    const entries = this.codexSlash ?? (await loadCodexSlashEntries(this.o.cwd));
    this.codexSlash = entries;
    const wireText = expandCodexSlash(input.text, entries);
    const { items, warnings } = await buildCodexInput(wireText, input.images ?? []);
    const turnId = "u_" + Date.now().toString(36) + "_" + rid();
    // A new turn started before the previous one completed → mark previous Codex id stale
    if (this.ourTurnId && this.st.currentTurnId) this.staleCodexTurns.add(this.st.currentTurnId);
    this.ourTurnId = turnId;
    this.st.currentTurnId = null; // Filled from THIS turn's turn/start response only
    this.emit({
      type: "turn_started",
      turnId,
      model: this.o.model,
      mode: this.o.mode,
      effort: this.o.effort,
    });
    for (const w of warnings) this.emit({ type: "notice", level: "warn", message: tr("notice.attachmentIssue", { detail: w }) });
    try {
      const res = (await rpc.request("turn/start", {
        threadId: this.sessionThreadId ?? undefined,
        input: items,
        model: this.o.model,
        effort: this.o.effort,
        approvalPolicy: preset.approvalPolicy,
        sandboxPolicy: preset.sandboxPolicy,
      })) as { turn?: { id?: string } };
      const codexTurnId = typeof res?.turn?.id === "string" ? res.turn.id : null;
      if (!codexTurnId) return;
      // If Stop ran while turn/start was in flight, interrupt() already ended locally and cleared
      // ourTurnId (or a newer send replaced it). Either way ourTurnId !== turnId — no separate
      // cancelled-turns set is needed (each half of the old OR was redundant with the other).
      const wasCancelled = this.ourTurnId !== turnId;
      if (wasCancelled) {
        this.staleCodexTurns.add(codexTurnId);
        try {
          await rpc.request(
            "turn/interrupt",
            { threadId: this.threadId(), turnId: codexTurnId },
            5000,
          );
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          if (!/idle|not running|no.*turn/i.test(msg)) log("warn", "codex interrupt 失败", { err: msg });
        }
        return;
      }
      this.st.currentTurnId = codexTurnId;
    } catch (e) {
      // turn/start failed after a local interrupt/supersede: do not emit a second turn_ended
      if (this.ourTurnId !== turnId) return;
      this.emit({
        type: "turn_ended",
        turnId,
        status: "failed",
        error: String((e as Error)?.message ?? e),
      });
    }
  }

  async steer(input: SendInput): Promise<void> {
    // No Codex turnId yet (turn/started hasn't arrived) → throw; the manager queues instead so the message isn't lost
    if (!this.rpc || !this.st.currentTurnId) throw new Error(tr("codex.noTurnSteer"));
    const { items, warnings } = await buildCodexInput(input.text, input.images ?? []);
    for (const w of warnings) this.emit({ type: "notice", level: "warn", message: tr("notice.attachmentIssue", { detail: w }) });
    try {
      await this.rpc.request("turn/steer", {
        threadId: this.threadId(),
        expectedTurnId: this.st.currentTurnId,
        input: items,
      });
    } catch (e) {
      log("warn", "codex steer 失败", { err: String(e) });
    }
  }

  async interrupt(): Promise<void> {
    for (const [, p] of this.pending) p.resolve({ cancelled: true });
    this.pending.clear();
    const localTurn = this.ourTurnId;
    const codexTurn = this.st.currentTurnId;
    if (!this.rpc) {
      if (localTurn) this.emit({ type: "turn_ended", turnId: localTurn, status: "interrupted" });
      return;
    }
    // No codexTurn yet (turn/start still in flight): end locally below so ourTurnId clears;
    // the in-flight turn/start response handler then sees ourTurnId !== turnId and interrupts.
    if (codexTurn) {
      this.staleCodexTurns.add(codexTurn);
      try {
        await this.rpc.request(
          "turn/interrupt",
          { threadId: this.threadId(), turnId: codexTurn },
          5000,
        );
      } catch (e) {
        // "Already idle"-type errors count as success
        const msg = String((e as Error)?.message ?? e);
        if (!/idle|not running|no.*turn/i.test(msg)) {
          log("warn", "codex interrupt 失败", { err: msg });
        }
      }
    }
    // End the local turn immediately (Devin/ACP-class): manager 1s fallback alone left UI idle while
    // ourTurnId stayed set, so a quick next send raced a late turn/completed onto the new turn.
    if (localTurn && this.ourTurnId === localTurn) {
      this.emit({ type: "turn_ended", turnId: localTurn, status: "interrupted" });
    }
  }

  private threadId(): string | undefined {
    return this.sessionThreadId ?? undefined;
  }

  // ---- server requests (§7.3.5 approvals) ----
  private async onServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const command = String(params.command ?? "");
        const requestId = "perm_" + rid();
        this.emit({
          type: "permission_request",
          requestId,
          title: tr("tool.run", { x: command.slice(0, 80) }),
          kind: "tool",
          detail: { command, cwd: params.cwd, reason: params.reason, approvalId: params.approvalId, itemId: params.itemId },
          options: [
            { id: "accept", label: tr("perm.allow"), kind: "allow_once" },
            { id: "acceptForSession", label: tr("perm.allowSession"), kind: "allow_always" },
            { id: "decline", label: tr("perm.deny"), kind: "reject_once" },
          ],
        });
        const a = await this.waitFor(requestId);
        if (a.cancelled) return { decision: "cancel" };
        const opt = a.optionId === "acceptForSession" ? "acceptForSession" : a.optionId === "decline" ? "decline" : "accept";
        return { decision: opt };
      }
      case "item/fileChange/requestApproval": {
        const itemId = typeof params.itemId === "string" ? params.itemId : "";
        const changes = Array.isArray(params.changes) && params.changes.length
          ? params.changes
          : (itemId ? this.st.fileChangesByItemId.get(itemId) ?? [] : []);
        const requestId = "perm_" + rid();
        this.emit({
          type: "permission_request",
          requestId,
          title: tr("perm.editFiles"),
          kind: "tool",
          detail: { changes, approvalId: params.approvalId, itemId: params.itemId, reason: params.reason },
          options: [
            { id: "accept", label: tr("perm.allow"), kind: "allow_once" },
            { id: "acceptForSession", label: tr("perm.allowSession"), kind: "allow_always" },
            { id: "decline", label: tr("perm.deny"), kind: "reject_once" },
          ],
        });
        const a = await this.waitFor(requestId);
        if (a.cancelled) return { decision: "cancel" };
        const opt = a.optionId === "acceptForSession" ? "acceptForSession" : a.optionId === "decline" ? "decline" : "accept";
        return { decision: opt };
      }
      case "item/tool/requestUserInput": {
        const requestId = "q_" + rid();
        this.emit({
          type: "question",
          requestId,
          questions: (params.questions as unknown[]) ?? [],
        });
        const a = await this.waitFor(requestId);
        if (a.cancelled) return { answers: {} };
        // schema: { answers: { <questionId>: { answers: [..] } } }
        const raw = a.answers ?? {};
        const shaped: Record<string, { answers: string[] }> = {};
        for (const [k, v] of Object.entries(raw)) shaped[k] = { answers: [v] };
        return { answers: shaped };
      }
      default:
        throw new Error(`未识别的服务端请求 ${method}`);
    }
  }

  private waitFor(requestId: string): Promise<RespondAnswer> {
    return new Promise((resolve) => {
      this.pending.set(requestId, { kind: "permission", resolve });
    });
  }

  respond(requestId: string, answer: RespondAnswer): void {
    const p = this.pending.get(requestId);
    if (p) {
      this.pending.delete(requestId);
      p.resolve(answer);
      // Writing back resolved events is the manager's job (permission_resolved/question_answered)
    }
  }

  async setModel(model: string | null): Promise<void> {
    this.o.model = model; // Takes effect on the next turn/start
  }
  async setMode(mode: Mode): Promise<void> {
    this.o.mode = mode; // Takes effect on the next turn/start
  }
  async setEffort(effort: string | null): Promise<void> {
    this.o.effort = effort; // Takes effect on the next turn/start
  }

  async listCommands(): Promise<SlashCommand[]> {
    try {
      const entries = this.codexSlash ?? (await loadCodexSlashEntries(this.o.cwd));
      this.codexSlash = entries;
      return codexSlashCommandsFromEntries(entries);
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [, p] of this.pending) p.resolve({ cancelled: true });
    this.pending.clear();
    if (this.rpc) await this.rpc.close();
    this.q.close();
  }
}
