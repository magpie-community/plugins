// AgentManager (§5.7): conversation runtimes, send/queue/steer/interrupt/permissions, idle recycling, restart recovery.
import type { Gateway } from "../ws/gateway.js";
import type { ThreadsStore, ThreadMeta } from "../store/threads.js";
import type { ProjectsStore } from "../store/projects.js";
import type { SettingsStore } from "../store/settings.js";
import type { AttachmentStore } from "../store/attachments.js";
import type { Provider, ProviderSession, SendInput, RespondAnswer, Mode, SlashCommand } from "../providers/types.js";
import { resolveAttachmentRefs } from "../util/attachmentRefs.js";
import { getProvider } from "../providers/registry.js";
import { catalogById, providerCreatable } from "../providers/catalog.js";
import { isProviderEnabled } from "../providers/enabled.js";
import { cachedDetect, cachedModels } from "../providers/infoCache.js";
import type { ProviderEvent, TimelineEvent } from "../timeline/types.js";
import { Coalescer } from "../timeline/coalescer.js";
import { ApiError } from "../ws/methods.js";
import { log } from "../log.js";
import { tr } from "../util/i18n.js";
import {
  codexSlashCommandsFromEntries,
  loadCodexSlashEntries,
} from "../providers/codex/commands.js";

const SLASH_CACHE_TTL_MS = 10 * 60 * 1000;

type QueuedMessage = { id: string; text: string; attachments: { path: string; mime: string; name?: string }[] };
type PendingRequest = {
  kind: "permission" | "question";
  requestId: string;
  options: { id: string; label: string; kind: string }[];
  resolve: (a: RespondAnswer) => void;
  event: ProviderEvent;
};

type Runtime = {
  threadId: string;
  session: ProviderSession | null;
  status: ThreadMeta["status"];
  currentTurnId: string | null;
  queue: QueuedMessage[];
  pending: Map<string, PendingRequest>;
  allowAlways: Set<string>;
  lastActivity: number;
  coalescer: Coalescer;
  interruptTimer: NodeJS.Timeout | null;
  endedTurnIds: Set<string>; // Turns that already have a turn_ended written (dedupe)
  starting: boolean; // startTurn in progress (session is still null while it is being created)
  commands: SlashCommand[];
  sessionCreating: Promise<ProviderSession> | null;
};

type DeltaType = "assistant_delta" | "reasoning_delta" | "tool_output_delta";
const DELTA_TYPES: DeltaType[] = ["assistant_delta", "reasoning_delta", "tool_output_delta"];
// coalescer key = type + \u0000 + itemId; the three delta types coalesce separately and are pushed with their original type
const deltaKey = (type: DeltaType, itemId: string) => `${type}\u0000${itemId}`;

export type SendBehavior = "queue" | "steer";

export class AgentManager {
  private runtimes = new Map<string, Runtime>();
  private recycleTimer: NodeJS.Timeout | null = null;
  private slashCache = new Map<string, { commands: SlashCommand[]; expires: number }>();

  constructor(
    private gw: Gateway,
    private threads: ThreadsStore,
    private projects: ProjectsStore,
    private settings: SettingsStore,
    private attachments: AttachmentStore,
  ) {}

  /** attachment.path in the frontend's thread.send is really an upload id; resolve it to the file under dataDir/attachments */
  private resolveAttachments(refs: { path: string; mime: string; name?: string }[]) {
    return resolveAttachmentRefs(this.attachments, refs);
  }

  private attachmentLabels(refs: { path: string; mime: string; name?: string }[]) {
    return refs.map((a) => ({ id: a.path, name: (a.name ?? "").trim() || a.path, mime: a.mime }));
  }

  // Called at startup: running/initializing conversations are recovered as closed (§5.7.6)
  async recoverOnStart(): Promise<void> {
    for (const meta of await this.threads.list()) {
      if (meta.status === "running" || meta.status === "initializing") {
        await this.appendRaw(meta.id, {
          type: "notice",
          level: "warn",
          message: tr("notice.daemonRestart"),
        });
        const events = await this.threads.readEvents(meta.id, 0, 50000);
        // No turn_ended after the last turn_started → append interrupted
        // (Can't use lastTurnStatus: it records the previous turn, not the one that was running)
        // user_message is persisted before turn_started; if the provider never sent turn_started the turn is still open
        let open: string | null = null;
        for (const e of events) {
          if (e.type === "turn_started") open = (e as { turnId?: string }).turnId ?? "unknown";
          else if (e.type === "user_message" && !(e as { steered?: boolean }).steered) open = open ?? "unknown";
          else if (e.type === "turn_ended") open = null;
        }
        if (open !== null) {
          await this.appendRaw(meta.id, { type: "turn_ended", status: "interrupted", ...(open && open !== "unknown" ? { turnId: open } : {}) } as Partial<TimelineEvent> & { type: "turn_ended" });
        }
        // Cancel every unresolved permission request
        const resolved = new Set(
          events.filter((e) => e.type === "permission_resolved").map((e) => (e as { requestId: string }).requestId),
        );
        for (const e of events) {
          if (e.type === "permission_request" && !resolved.has((e as { requestId: string }).requestId)) {
            await this.appendRaw(meta.id, {
              type: "permission_resolved",
              requestId: (e as { requestId: string }).requestId,
              cancelled: true,
            });
          }
        }
        await this.threads.patch(meta.id, { status: "closed", lastTurnStatus: "interrupted" });
      }
    }
    // Idle recycling every minute
    this.recycleTimer = setInterval(() => void this.recycleIdle(), 60_000);
    this.recycleTimer.unref?.();
  }

  /** Close every session; the returned Promise resolves once each close finishes (or fails). Callers add their own timeout. */
  shutdown(): Promise<void> {
    if (this.recycleTimer) clearInterval(this.recycleTimer);
    const all = [...this.runtimes.values()].map((rt) => rt.session?.close().catch(() => {}));
    this.runtimes.clear();
    return Promise.all(all).then(() => {});
  }

  // Idle-exit check (§5.2.7): busy if any runtime is not idle
  anyBusy(): boolean {
    for (const rt of this.runtimes.values()) {
      if (rt.status === "running" || rt.status === "initializing") return true;
    }
    return false;
  }

  runtimeInfo(threadId: string): { status: string; queue: unknown[]; pending: unknown[] } | null {
    const rt = this.runtimes.get(threadId);
    if (!rt) return null;
    return {
      status: rt.status,
      queue: rt.queue,
      pending: [...rt.pending.values()].map((p) => ({
        requestId: p.requestId,
        kind: p.kind,
        options: p.options,
      })),
    };
  }

  private rt(threadId: string): Runtime {
    let r = this.runtimes.get(threadId);
    if (!r) {
      r = {
        threadId,
        session: null,
        status: "idle",
        currentTurnId: null,
        queue: [],
        pending: new Map(),
        allowAlways: new Set(),
        lastActivity: Date.now(),
        coalescer: this.newCoalescer(threadId),
        interruptTimer: null,
        endedTurnIds: new Set(),
        starting: false,
        commands: [],
        sessionCreating: null,
      };
      this.runtimes.set(threadId, r);
    }
    return r;
  }

  private newCoalescer(threadId: string): Coalescer {
    return new Coalescer(60, (key, text) => {
      const i = key.indexOf("\u0000");
      const type = key.slice(0, i) as DeltaType;
      void this.pushEvent(threadId, { type, itemId: key.slice(i + 1), text });
    });
  }

  private flushDeltas(rt: Runtime, itemId: string): void {
    for (const t of DELTA_TYPES) rt.coalescer.flushItem(deltaKey(t, itemId));
  }

  // ---- send ----
  async send(threadId: string, input: { text: string; attachments?: { path: string; mime: string; name?: string }[] }, behavior: SendBehavior = "queue"): Promise<void> {
    const meta = await this.mustThread(threadId);
    if (meta.archived) {
      await this.threads.patch(threadId, { archived: false });
      this.gw.publish("sidebar", { type: "thread.upsert", thread: await this.threads.get(threadId) });
    }
    const rt = this.rt(threadId);
    rt.lastActivity = Date.now();
    const attachmentRefs = input.attachments ?? [];

    // Closed (crash/recycle/restart recovery) → drop the old session; the next message resumes via providerSessionId
    if (meta.status === "closed" && rt.session) {
      try { await rt.session.close(); } catch {}
      rt.session = null;
      rt.commands = [];
    }
    if (!rt.starting && rt.session === null && (rt.status === "running" || rt.status === "initializing" || rt.status === "error")) {
      rt.status = "idle";
    }

    if (rt.status === "running" || rt.starting || rt.status === "initializing") {
      const provider = this.providerOf(meta);
      if (behavior === "steer" && provider?.capabilities.steer && rt.session?.steer && !rt.starting) {
        try {
          const images = await this.resolveAttachments(attachmentRefs);
          await rt.session.steer({ text: input.text, images });
          await this.appendRaw(threadId, {
            type: "user_message",
            text: input.text,
            steered: true,
            attachments: this.attachmentLabels(attachmentRefs),
          });
          return;
        } catch (e) {
          // Steering failed (e.g. the turn hasn't really started yet) → fall back to queueing so the message isn't lost
          log("info", `thread ${threadId} 插话失败，改为排队：${String(e)}`);
        }
      }
      const q: QueuedMessage = { id: "q" + Date.now().toString(36), text: input.text, attachments: attachmentRefs };
      rt.queue.push(q);
      this.gw.publish(`thread:${threadId}`, { type: "queue", queue: rt.queue });
      return;
    }

    await this.startTurn(threadId, input.text, attachmentRefs);
  }

  private async startTurn(threadId: string, text: string, attachmentRefs: { path: string; mime: string; name?: string }[]): Promise<void> {
    const rt = this.rt(threadId);
    rt.starting = true;
    try {
      await this.startTurnInner(threadId, text, attachmentRefs);
    } finally {
      rt.starting = false;
    }
  }

  private async startTurnInner(threadId: string, text: string, attachmentRefs: { path: string; mime: string; name?: string }[]): Promise<void> {
    const meta = await this.mustThread(threadId);
    const rt = this.rt(threadId);
    // Conversations that already ran (have a providerSessionId) ignore "disabled": disabling only blocks new conversations
    const provider = await this.assertProviderUsable(meta.provider, { allowDisabled: !!meta.providerSessionId });

    if (!rt.session) {
      await this.setStatus(threadId, "initializing");
      try {
        await this.createSessionIfNeeded(threadId, { updateStatus: true });
      } catch (e) {
        await this.appendRaw(threadId, { type: "notice", level: "error", message: tr("notice.sessionStartFailed", { detail: String((e as Error)?.message ?? e) }) });
        await this.appendRaw(threadId, { type: "turn_ended", status: "failed", error: String((e as Error)?.message ?? e) } as Partial<TimelineEvent> & { type: "turn_ended" });
        await this.setStatus(threadId, "error");
        throw e;
      }
    }

    // Auto title
    const trimmed = text.trim();
    if (meta.titleAuto && trimmed) {
      await this.threads.patch(threadId, { title: trimmed.slice(0, 40), titleAuto: true });
      this.gw.publish("sidebar", { type: "thread.upsert", thread: await this.threads.get(threadId) });
    }
    await this.appendRaw(threadId, {
      type: "user_message",
      text,
      attachments: this.attachmentLabels(attachmentRefs),
    });
    await this.setStatus(threadId, "running");
    try {
      const images = await this.resolveAttachments(attachmentRefs);
      await rt.session!.send({ text, images });
    } catch (e) {
      // A failed send must not leave the conversation running
      const msg = String((e as Error)?.message ?? e);
      await this.appendRaw(threadId, { type: "notice", level: "error", message: tr("notice.sendFailed", { detail: msg }) });
      await this.appendRaw(threadId, { type: "turn_ended", status: "failed", error: msg } as Partial<TimelineEvent> & { type: "turn_ended" });
      await this.threads.patch(threadId, { lastTurnStatus: "failed" });
      rt.currentTurnId = null;
      await this.setStatus(threadId, "idle");
      throw e;
    }
  }

  // ---- event pump ----
  private async pumpEvents(threadId: string, session: ProviderSession): Promise<void> {
    const rt = this.rt(threadId);
    let ended = false;
    try {
      for await (const ev of session.events) {
        await this.onProviderEvent(threadId, ev);
        if (ev.type === "turn_started") ended = false; // A new turn started: reset (queued messages reuse the same session event stream)
        if (ev.type === "turn_ended") ended = true;
      }
    } catch (e) {
      log("warn", `thread ${threadId} 事件流异常：${String(e)}`);
    }
    if (!ended && this.rt(threadId).session === session) {
      // Session exited unexpectedly: append failed
      await this.onProviderEvent(threadId, {
        type: "turn_ended",
        turnId: rt.currentTurnId ?? "unknown",
        status: "failed",
        error: tr("turn.agentExit"),
      });
      rt.session = null;
      await this.setStatus(threadId, "closed");
    }
  }

  private async onProviderEvent(threadId: string, ev: ProviderEvent): Promise<void> {
    const rt = this.rt(threadId);
    rt.lastActivity = Date.now();

    if (ev.type === "provider_session_id") {
      await this.threads.patch(threadId, { providerSessionId: ev.id });
      return;
    }
    if (ev.type === "slash_commands") {
      rt.commands = ev.commands;
      const meta = await this.mustThread(threadId);
      const proj = await this.projects.get(meta.projectId);
      if (proj) this.putSlashCache(meta.provider, proj.path, ev.commands);
      this.gw.publish(`thread:${threadId}`, { type: "commands", commands: ev.commands });
      return;
    }
    if (ev.type === "turn_started") {
      rt.currentTurnId = ev.turnId;
      await this.appendRaw(threadId, ev);
      return;
    }
    if (ev.type === "assistant_delta" || ev.type === "reasoning_delta" || ev.type === "tool_output_delta") {
      // Goes through the coalescer, not persisted
      rt.coalescer.push(deltaKey(ev.type, ev.itemId), ev.text);
      return;
    }
    // Before persisting a complete event, flush that itemId's pending deltas first (keeps ordering)
    const evItemId = (ev as { itemId?: unknown }).itemId;
    if (typeof evItemId === "string") this.flushDeltas(rt, evItemId);
    if (ev.type === "assistant_message" || ev.type === "reasoning") {
      await this.appendRaw(threadId, ev);
      return;
    }
    if (ev.type === "usage") {
      const meta = await this.mustThread(threadId);
      const u = meta.usage;
      await this.threads.patch(threadId, {
        usage: {
          inputTokens: u.inputTokens + ev.inputTokens,
          outputTokens: u.outputTokens + ev.outputTokens,
          cacheReadTokens: u.cacheReadTokens + ev.cacheReadTokens,
          costUsd: u.costUsd + ev.costUsd,
        },
      });
      await this.pushEvent(threadId, ev); // Pushing without persisting would also work; persisted so it can be reviewed later
      return;
    }
    if (ev.type === "permission_request" || ev.type === "question") {
      const options = ev.type === "permission_request" ? ev.options : [];
      const pending: PendingRequest = {
        kind: ev.type === "permission_request" ? "permission" : "question",
        requestId: ev.requestId,
        options,
        resolve: () => {},
        event: ev,
      };
      // allowAlways hit → approve directly
      const toolName = (ev as { detail?: { toolName?: string } }).detail?.toolName;
      if (toolName && rt.allowAlways.has(toolName)) {
        rt.session?.respond(ev.requestId, { optionId: "accept" });
        return;
      }
      rt.pending.set(ev.requestId, pending);
      await this.appendRaw(threadId, ev);
      return;
    }
    if (ev.type === "permission_resolved" || ev.type === "question_answered") {
      // The manager already persisted it (respond / interrupt) → drop the provider's echo to avoid duplicates
      if (!rt.pending.delete(ev.requestId)) return;
      await this.appendRaw(threadId, ev);
      return;
    }
    if (ev.type === "turn_ended") {
      // End a turn only once (drop a late one from the provider after the interrupt fallback already ended it)
      if (ev.turnId && ev.turnId !== "unknown" && rt.endedTurnIds.has(ev.turnId)) return;
      if (rt.interruptTimer) {
        clearTimeout(rt.interruptTimer);
        rt.interruptTimer = null;
      }
      if (ev.turnId && ev.turnId !== "unknown") rt.endedTurnIds.add(ev.turnId);
      rt.coalescer.dispose();
      rt.coalescer = this.newCoalescer(threadId);
      await this.appendRaw(threadId, ev);
      await this.threads.patch(threadId, { lastTurnStatus: ev.status });
      rt.currentTurnId = null;
      // After a failure/crash the session is dead (mock /exit) → clear it
      if (ev.status === "failed" && rt.session && !this.alive(rt.session)) rt.session = null;
      await this.setStatus(threadId, "idle");
      // Next queued message
      const next = rt.queue.shift();
      if (next) {
        this.gw.publish(`thread:${threadId}`, { type: "queue", queue: rt.queue });
        // A queued message that fails to start is only logged; it must not break the event pump (startTurn already wrote notice/turn_ended)
        await this.startTurn(threadId, next.text, next.attachments).catch((e) => {
          log("warn", `thread ${threadId} 排队消息启动失败：${String(e)}`);
        });
      }
      return;
    }
    // Everything else: persist + push
    await this.appendRaw(threadId, ev);
  }

  private alive(_s: ProviderSession): boolean {
    return true; // mock /exit closes the queue; end of the event stream is handled separately
  }

  // ---- respond (permission/question answers) ----
  async respond(threadId: string, requestId: string, answer: RespondAnswer): Promise<void> {
    const rt = this.rt(threadId);
    const pending = rt.pending.get(requestId);
    if (!pending) throw new ApiError("not_found", "授权/提问不存在或已回应");
    if (pending.kind === "permission" && answer.optionId) {
      const valid = pending.options.some((o) => o.id === answer.optionId);
      if (!valid) throw new ApiError("bad_params", `optionId 非法：${answer.optionId}`);
    }
    rt.pending.delete(requestId);
    if (pending.kind === "permission") {
      await this.appendRaw(threadId, {
        type: "permission_resolved",
        requestId,
        optionId: answer.optionId,
        cancelled: answer.cancelled,
      });
      const opt = pending.options.find((o) => o.id === answer.optionId);
      if (opt?.kind === "allow_always") {
        const toolName = (pending.event as { detail?: { toolName?: string } }).detail?.toolName;
        if (toolName) rt.allowAlways.add(toolName);
      }
    } else {
      await this.appendRaw(threadId, {
        type: "question_answered",
        requestId,
        answers: answer.answers ?? {},
      });
    }
    rt.session?.respond(requestId, answer);
  }

  // ---- interrupt ----
  async interrupt(threadId: string): Promise<void> {
    const rt = this.rt(threadId);
    if (!rt.session || rt.status !== "running") return;
    // Invalidate all pending requests
    for (const [id, p] of rt.pending) {
      await this.appendRaw(threadId, { type: "permission_resolved", requestId: id, cancelled: true });
      p.resolve({ cancelled: true });
    }
    rt.pending.clear();
    await rt.session.interrupt();
    const turnId = rt.currentTurnId;
    // No turn_ended within 1 second → append interrupted
    // Use the normal turn_ended path: clear currentTurnId, write lastTurnStatus, continue the queue
    rt.interruptTimer = setTimeout(() => {
      rt.interruptTimer = null;
      if (rt.currentTurnId === turnId && turnId) {
        void this.onProviderEvent(threadId, { type: "turn_ended", turnId, status: "interrupted" }).catch((e) => {
          log("warn", `thread ${threadId} 打断兜底失败：${String(e)}`);
        });
      }
    }, 1000);
  }

  // ---- setModel / setMode / setEffort ----
  async setModel(threadId: string, model: string | null): Promise<void> {
    const meta = await this.mustThread(threadId);
    let effort = meta.effort;
    const p = getProvider(meta.provider);
    if (p) {
      const models = await cachedModels(p);
      const row = models.find((m) => (model ? m.id === model : m.isDefault)) ?? models[0];
      const opts = row?.thinkingOptions ?? [];
      if (effort && opts.length && !opts.some((o) => o.id === effort)) {
        effort = null;
        await this.appendRaw(threadId, {
          type: "notice",
          level: "info",
          message: tr("notice.effortResetOnModel"),
        });
      }
    }
    await this.threads.patch(threadId, { model, effort });
    const rt = this.rt(threadId);
    if (rt.session) await rt.session.setModel(model);
    this.gw.publish("sidebar", { type: "thread.upsert", thread: await this.threads.get(threadId) });
  }
  async setMode(threadId: string, mode: Mode): Promise<void> {
    await this.threads.patch(threadId, { mode });
    const rt = this.rt(threadId);
    if (rt.session) await rt.session.setMode(mode);
    this.gw.publish("sidebar", { type: "thread.upsert", thread: await this.threads.get(threadId) });
  }
  async setEffort(threadId: string, effort: string | null): Promise<void> {
    const meta = await this.mustThread(threadId);
    await this.threads.patch(threadId, { effort });
    const rt = this.rt(threadId);
    if (rt.session) await rt.session.setEffort(effort);
    if (meta.provider === "claude" && (rt.status === "running" || rt.status === "initializing")) {
      await this.appendRaw(threadId, {
        type: "notice",
        level: "info",
        message: tr("notice.effortNextTurn"),
      });
    }
    this.gw.publish("sidebar", { type: "thread.upsert", thread: await this.threads.get(threadId) });
  }

  async setCursorOpts(
    threadId: string,
    patch: { cursorFast?: boolean; cursorAutoReview?: boolean },
  ): Promise<void> {
    const meta = await this.mustThread(threadId);
    if (meta.provider !== "cursor") throw new ApiError("bad_params", "仅 Cursor 对话支持该选项");
    const next = await this.threads.patch(threadId, patch);
    const rt = this.rt(threadId);
    const sess = rt.session as { updateCursorOpts?(f: boolean, a: boolean): Promise<void> } | null;
    if (sess?.updateCursorOpts) {
      await sess.updateCursorOpts(!!next.cursorFast, !!next.cursorAutoReview);
    }
    this.gw.publish("sidebar", { type: "thread.upsert", thread: next });
  }

  /** The Agent can be switched only before any user message and while not running */
  async setProvider(threadId: string, providerId: string): Promise<void> {
    await this.mustThread(threadId);
    const meta = await this.threads.get(threadId);
    if (!meta) throw new ApiError("not_found", "对话不存在");
    const rt = this.rt(threadId);
    if (rt.status === "running" || rt.status === "initializing" || rt.starting) {
      throw new ApiError("busy", "对话运行中，不能更换 Agent");
    }
    const events = await this.threads.readEvents(threadId, 0, 5000);
    if (events.some((e) => e.type === "user_message")) {
      throw new ApiError("bad_params", "已有消息，不能更换 Agent");
    }
    const p = await this.assertProviderUsable(providerId);
    if (rt.session) {
      try {
        await rt.session.close();
      } catch {}
      rt.session = null;
      rt.commands = [];
    }
    rt.status = "idle";
    await this.threads.patch(threadId, {
      provider: providerId,
      model: null,
      mode: p.capabilities.modes.includes(meta.mode) ? meta.mode : (p.capabilities.modes[0] ?? "default"),
      effort: null,
      providerSessionId: null,
      status: "idle",
    });
    this.gw.publish("sidebar", { type: "thread.upsert", thread: await this.threads.get(threadId) });
  }

  async close(threadId: string): Promise<void> {
    const rt = this.rt(threadId);
    if (rt.session) {
      try {
        await rt.session.close();
      } catch {}
      rt.session = null;
      rt.commands = [];
    }
    await this.setStatus(threadId, "closed");
  }

  /** Slash commands: no session by default; only with load:true do we create a session for providers that need one to list them */
  async listCommands(threadId: string, opts?: { load?: boolean }): Promise<SlashCommand[]> {
    let meta: ThreadMeta;
    try {
      meta = await this.mustThread(threadId);
    } catch {
      return [];
    }
    const rt = this.rt(threadId);
    const proj = await this.projects.get(meta.projectId);
    if (!proj) return [];

    if (meta.provider === "codex") {
      try {
        const commands = codexSlashCommandsFromEntries(await loadCodexSlashEntries(proj.path));
        rt.commands = commands;
        this.putSlashCache(meta.provider, proj.path, commands);
        return commands;
      } catch {
        return this.getSlashCache(meta.provider, proj.path) ?? rt.commands;
      }
    }

    if (rt.session) {
      try {
        const commands = await rt.session.listCommands();
        rt.commands = commands;
        this.putSlashCache(meta.provider, proj.path, commands);
        return commands;
      } catch {
        return rt.commands.length ? rt.commands : (this.getSlashCache(meta.provider, proj.path) ?? []);
      }
    }

    const cached = this.getSlashCache(meta.provider, proj.path);
    if (cached) {
      rt.commands = cached;
      return cached;
    }

    if (!opts?.load) return [];

    try {
      const session = await this.createSessionIfNeeded(threadId, { updateStatus: false });
      const commands = await session.listCommands();
      rt.commands = commands;
      this.putSlashCache(meta.provider, proj.path, commands);
      return commands;
    } catch {
      return [];
    }
  }

  private slashCacheKey(provider: string, projectPath: string): string {
    return `${provider}\u0000${projectPath}`;
  }

  private getSlashCache(provider: string, projectPath: string): SlashCommand[] | null {
    const hit = this.slashCache.get(this.slashCacheKey(provider, projectPath));
    if (!hit) return null;
    if (Date.now() > hit.expires) {
      this.slashCache.delete(this.slashCacheKey(provider, projectPath));
      return null;
    }
    return hit.commands;
  }

  private putSlashCache(provider: string, projectPath: string, commands: SlashCommand[]): void {
    // Don't cache an empty list: commands often arrive late (async push), and a cached empty result would keep the menu empty for the TTL
    if (!commands.length) return;
    this.slashCache.set(this.slashCacheKey(provider, projectPath), {
      commands,
      expires: Date.now() + SLASH_CACHE_TTL_MS,
    });
  }

  private async createSessionIfNeeded(
    threadId: string,
    opts: { updateStatus: boolean },
  ): Promise<ProviderSession> {
    const rt = this.rt(threadId);
    if (rt.session) return rt.session;
    if (rt.sessionCreating) return rt.sessionCreating;

    const creating = this.createSessionInner(threadId, opts);
    rt.sessionCreating = creating;
    try {
      return await creating;
    } finally {
      if (rt.sessionCreating === creating) rt.sessionCreating = null;
    }
  }

  private async createSessionInner(
    threadId: string,
    opts: { updateStatus: boolean },
  ): Promise<ProviderSession> {
    const meta = await this.mustThread(threadId);
    const rt = this.rt(threadId);
    if (rt.session) return rt.session;
    const provider = await this.assertProviderUsable(meta.provider, { allowDisabled: !!meta.providerSessionId });
    const proj = await this.projects.get(meta.projectId);
    if (!proj) throw new ApiError("not_found", "项目不存在");
    let model = meta.model;
    // DSH model IDs come from ACP; old conversations may still hold a model ID from another Agent.
    // Clear that stale value so it isn't sent to the wrong Magpie provider route.
    if (meta.provider === "dsh" && model) {
      // Use the cache: listModels spawns a dsh ACP probe process, too wasteful to do for every new session
      const available = await cachedModels(provider).catch(() => []);
      if (available.length && !available.some((m) => m.id === model)) {
        // Prefer DSH's Magpie-routed model so it doesn't fall back to DeepSeek's official model without an API key.
        model = available.find((m) => /magpie/i.test(m.id))?.id ?? available.find((m) => m.isDefault)?.id ?? null;
        await this.threads.patch(threadId, { model });
        this.gw.publish("sidebar", { type: "thread.upsert", thread: await this.threads.get(threadId) });
      }
    } else if (meta.provider === "dsh" && !model) {
      // No model picked: start dsh on the route a new conversation would use (its ACP takes images only for the route it starts on)
      const available = await cachedModels(provider).catch(() => []);
      const magpie = available.filter((m) => /magpie/i.test(m.id));
      model = (magpie.find((m) => m.isDefault) ?? magpie[0] ?? available.find((m) => m.isDefault))?.id ?? null;
    }
    if (opts.updateStatus) await this.setStatus(threadId, "initializing");
    const settings = await this.settings.get();
    const custom = settings.providerCommand?.[meta.provider];
    const launch =
      custom?.executable?.trim()
        ? { cmd: custom.executable.trim(), prefixArgs: custom.args ?? [] }
        : undefined;
    rt.session = await provider.createSession({
      threadId,
      cwd: proj.path,
      model,
      mode: meta.mode,
      effort: meta.effort,
      resumeId: meta.providerSessionId,
      cursorFast: meta.cursorFast,
      cursorAutoReview: meta.cursorAutoReview,
      launch,
    });
    void this.pumpEvents(threadId, rt.session);
    return rt.session;
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.close(threadId);
    this.runtimes.delete(threadId);
    await this.threads.delete(threadId);
  }

  // ---- internals ----
  private async mustThread(threadId: string): Promise<ThreadMeta> {
    const meta = await this.threads.get(threadId);
    if (!meta) throw new ApiError("not_found", "对话不存在");
    return meta;
  }

  private providerOf(meta: ThreadMeta): Provider | undefined {
    return getProvider(meta.provider);
  }

  private async assertProviderUsable(providerId: string, opts: { allowDisabled?: boolean } = {}): Promise<Provider> {
    const p = getProvider(providerId);
    if (!p) throw new ApiError("bad_params", `未知 Agent：${providerId}`);
    const s = await this.settings.get();
    if (!opts.allowDisabled && !isProviderEnabled(s, providerId)) {
      throw new ApiError("bad_params", `${p.name} 已在设置中禁用`);
    }
    const entry = catalogById(providerId);
    if (entry && !providerCreatable(entry.status)) {
      throw new ApiError("bad_params", `${p.name} 尚未接入，暂不能新建对话`);
    }
    const det = await cachedDetect(p);
    if (!det.available) throw new ApiError("bad_params", det.reason ?? `${p.name} 未安装或不可用`);
    return p;
  }

  private async setStatus(threadId: string, status: ThreadMeta["status"]): Promise<void> {
    const rt = this.rt(threadId);
    rt.status = status;
    const meta = await this.threads.patch(threadId, { status });
    this.gw.publish("sidebar", { type: "thread.upsert", thread: meta });
    this.gw.publish(`thread:${threadId}`, { type: "status", status }); // Frontend running state / timer / send button
  }

  // Append an event: seq is assigned in the store's serialized section, persisted, then pushed to thread:<id>
  private async appendRaw(threadId: string, ev: Record<string, unknown> & { type: TimelineEvent["type"] }): Promise<void> {
    const full = await this.threads.appendEvent(threadId, { ...ev, ts: Date.now() });
    this.gw.publish(`thread:${threadId}`, { type: "event", event: full });
  }

  // Push without persisting (for coalescer deltas; usage is already accumulated above).
  // Unpersisted events take no seq: seq=-1 so the frontend dedupes only by persisted seq,
  // otherwise deltas would push the client's maxSeq up and the following persisted events would be dropped by mistake.
  private async pushEvent(threadId: string, ev: Record<string, unknown> & { type: TimelineEvent["type"] }): Promise<void> {
    const full = { ...ev, seq: -1, ts: Date.now(), threadId } as TimelineEvent;
    this.gw.publish(`thread:${threadId}`, { type: "event", event: full });
  }

  private async recycleIdle(): Promise<void> {
    const s = await this.settings.get();
    const limit = (s.idleCloseMinutes ?? 30) * 60_000;
    for (const rt of this.runtimes.values()) {
      if (rt.status === "idle" && rt.pending.size === 0 && Date.now() - rt.lastActivity > limit) {
        log("info", `空闲回收 thread ${rt.threadId}`);
        await this.close(rt.threadId);
      }
    }
  }
}
