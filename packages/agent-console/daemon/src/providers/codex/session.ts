// Codex ProviderSession (§7.3.3/7.3.5): codex app-server JSON-RPC session.
import type { ProviderSession, SendInput, RespondAnswer, Mode, SlashCommand } from "../types.js";
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
  private interruptWanted = false;
  private ourTurnId: string | null = null; // The current turn's turnId in the timeline (generated on send)
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
    },
  ) {
    this.events = this.q;
  }

  private emit(ev: ProviderEvent): void {
    if (ev.type === "turn_ended") {
      // A late completion for the previous turn (already ended by the interrupt fallback): drop it so it doesn't end the new turn
      if (ev.turnId && this.staleCodexTurns.delete(ev.turnId)) return;
      // turn_started uses our own turnId, so the end must use the same one,
      // otherwise the manager's per-turn dedupe breaks (interrupt fallback + late completion would end the next turn)
      if (this.ourTurnId) ev.turnId = this.ourTurnId;
      this.ourTurnId = null;
      this.st.currentTurnId = null;
      this.interruptWanted = false;
    }
    this.q.push(ev);
  }

  private async start(): Promise<void> {
    if (this.started) return this.started;
    const attempt = (async () => {
      const rpc = new CodexRpc(
        argvFor(
          { ok: true, cmd: this.o.binCmd, prefixArgs: this.o.binPrefixArgs, display: this.o.binCmd, via: this.o.binVia ?? "path", shim: this.o.binShim },
          ["app-server"],
        ),
        { cwd: this.o.cwd },
      );
      this.rpc = rpc;
      rpc.onNotification = (m, p) => {
        for (const ev of mapNotification(m, p, this.st)) this.emit(ev);
        if (this.interruptWanted && this.st.currentTurnId) void this.interrupt();
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
    if (this.closed) throw new Error("会话已关闭");
    await this.start();
    const rpc = this.rpc!;
    const preset = MODE_PRESETS[this.o.mode];
    const entries = this.codexSlash ?? (await loadCodexSlashEntries(this.o.cwd));
    this.codexSlash = entries;
    const wireText = expandCodexSlash(input.text, entries);
    const { items, warnings } = await buildCodexInput(wireText, input.images ?? []);
    this.interruptWanted = false;
    const turnId = "u_" + Date.now().toString(36) + "_" + rid();
    // A new turn started before the previous one completed (interrupt fallback) → remember its Codex turnId
    if (this.ourTurnId && this.st.currentTurnId) this.staleCodexTurns.add(this.st.currentTurnId);
    this.ourTurnId = turnId;
    this.st.currentTurnId = null; // Filled in by this turn's turn/started, so we never interrupt/steer with the previous turn's id
    this.emit({
      type: "turn_started",
      turnId,
      model: this.o.model,
      mode: this.o.mode,
      effort: this.o.effort,
    });
    for (const w of warnings) this.emit({ type: "notice", level: "warn", message: tr("notice.attachmentIssue", { detail: w }) });
    try {
      await rpc.request("turn/start", {
        threadId: this.sessionThreadId ?? undefined,
        input: items,
        model: this.o.model,
        effort: this.o.effort,
        approvalPolicy: preset.approvalPolicy,
        sandboxPolicy: preset.sandboxPolicy,
      });
    } catch (e) {
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
    if (!this.rpc || !this.st.currentTurnId) throw new Error("当前轮次还没开始，无法插话");
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
    if (!this.rpc) return;
    if (!this.st.currentTurnId) {
      // turn/started hasn't arrived yet: remember it and send the interrupt as soon as the turnId is known
      this.interruptWanted = true;
      return;
    }
    this.interruptWanted = false;
    try {
      await this.rpc.request(
        "turn/interrupt",
        { threadId: this.threadId(), turnId: this.st.currentTurnId },
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
          title: `运行 ${command.slice(0, 80)}`,
          kind: "tool",
          detail: { command, cwd: params.cwd, reason: params.reason, approvalId: params.approvalId, itemId: params.itemId },
          options: [
            { id: "accept", label: "允许", kind: "allow_once" },
            { id: "acceptForSession", label: "本对话都允许", kind: "allow_always" },
            { id: "decline", label: "拒绝", kind: "reject_once" },
          ],
        });
        const a = await this.waitFor(requestId);
        if (a.cancelled) return { decision: "cancel" };
        const opt = a.optionId === "acceptForSession" ? "acceptForSession" : a.optionId === "decline" ? "decline" : "accept";
        return { decision: opt };
      }
      case "item/fileChange/requestApproval": {
        const changes = Array.isArray(params.changes) ? params.changes : [];
        const requestId = "perm_" + rid();
        this.emit({
          type: "permission_request",
          requestId,
          title: "修改文件",
          kind: "tool",
          detail: { changes, approvalId: params.approvalId, itemId: params.itemId, reason: params.reason },
          options: [
            { id: "accept", label: "允许", kind: "allow_once" },
            { id: "acceptForSession", label: "本对话都允许", kind: "allow_always" },
            { id: "decline", label: "拒绝", kind: "reject_once" },
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
