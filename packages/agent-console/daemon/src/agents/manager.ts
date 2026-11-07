// AgentManager (§5.7): conversation runtimes, send/queue/steer/interrupt/permissions, idle recycling, restart recovery.
import type { Gateway } from "../ws/gateway.js";
import type { ThreadsStore, ThreadMeta } from "../store/threads.js";
import type { ProjectsStore } from "../store/projects.js";
import type { SettingsStore } from "../store/settings.js";
import type { AttachmentStore } from "../store/attachments.js";
import type { Provider, ProviderSession, SendInput, RespondAnswer, Mode, SlashCommand } from "../providers/types.js";
import { launchFromSettings } from "../providers/launch.js";
import { clampMode } from "../providers/modes.js";
import { guardLegacyMode, upgradeNotice } from "../migrate/autoApprove13.js";
import { autoApproveOption, FULL_AUTO } from "../providers/autoApprove.js";
import { resolveAttachmentRefs } from "../util/attachmentRefs.js";
import { getProvider } from "../providers/registry.js";
import { catalogById, providerCreatable } from "../providers/catalog.js";
import { isProviderEnabled } from "../providers/enabled.js";
import { cachedDetect, cachedModels } from "../providers/infoCache.js";
import { magpieDefaultModel } from "../providers/magpieGateway.js";
import type { ProviderEvent, TimelineEvent } from "../timeline/types.js";
import { Coalescer } from "../timeline/coalescer.js";
import { ApiError } from "../ws/methods.js";
import { log } from "../log.js";
import { tr } from "../util/i18n.js";
import { agentShellReady, bashMissingFor } from "../util/agentShell.js";
import { resolveMentions, withMentions, type Mention, type MentionRef } from "../util/mentions.js";
import {
  codexSlashCommandsFromEntries,
  loadCodexSlashEntries,
} from "../providers/codex/commands.js";

/** A message's own words for its conversation title: leading "> " quote blocks dropped (kept when that is all there is) */
export function titleText(text: string): string {
  const blocks = text.trim().split(/\n{2,}/);
  let i = 0;
  while (i < blocks.length && blocks[i]!.split("\n").every((l) => l === ">" || l.startsWith("> "))) i++;
  const rest = blocks.slice(i).join(" ").trim();
  return (rest || text.trim().replace(/^>\s?/gm, "")).replace(/\s+/g, " ").trim();
}

const SLASH_CACHE_TTL_MS = 10 * 60 * 1000;
/** Idle Agent processes kept warm at most (one per conversation); older idle ones are closed (resumed on the next message) */
export const MAX_WARM_IDLE = 3;

type QueuedMessage = { id: string; text: string; attachments: { path: string; mime: string; name?: string }[]; mentions?: Mention[]; clientId?: string };
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
  /** Text streamed as deltas only (ACP Agents): saved per segment as assistant_message / reasoning (B1) */
  pendingText: Map<string, { type: "assistant" | "reasoning"; itemId: string; text: string }>;
  deltasOnly: boolean;
  /** 1.3: the "Git Bash not found" hint was already shown in this conversation during this daemon run */
  bashHinted?: boolean;
  /**
   * When the thread is on「默认」(meta.model null), the Magpie / agent default id last pushed into the live session.
   * Used to adopt a Magpie default-model change on the next turn without interrupting a running one.
   */
  syncedDefaultModel?: string | null;
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

  /** Mentions from the Files panel → absolute paths inside the project; a path that can't be used gets a notice */
  private async resolveMentionRefs(threadId: string, projectId: string, refs: MentionRef[] | undefined): Promise<Mention[]> {
    if (!refs?.length) return [];
    const proj = await this.projects.get(projectId);
    if (!proj) return [];
    const { mentions, warnings } = await resolveMentions(proj.path, refs);
    if (warnings.length) {
      await this.appendRaw(threadId, { type: "notice", level: "warn", message: tr("notice.mentionSkipped", { paths: warnings.join(", ") }) });
    }
    return mentions;
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

  /** Drop a queued message that hasn't been sent yet (the × on the composer's queue list) */
  removeQueued(threadId: string, queueId: string): boolean {
    const rt = this.runtimes.get(threadId);
    if (!rt) return false;
    const before = rt.queue.length;
    rt.queue = rt.queue.filter((q) => q.id !== queueId);
    if (rt.queue.length === before) return false;
    this.gw.publish(`thread:${threadId}`, { type: "queue", queue: rt.queue });
    return true;
  }

  runtimeInfo(threadId: string): { status: string; starting: boolean; queue: unknown[]; pending: unknown[] } | null {
    const rt = this.runtimes.get(threadId);
    if (!rt) return null;
    return {
      status: rt.status,
      // true while startTurn runs (until session.send has returned): a "steer" sent then is queued instead
      starting: rt.starting,
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
        pendingText: new Map(),
        deltasOnly: false,
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
  /** clientId: the page's id for its optimistic bubble; it rides on the user_message event so the page can swap the
   *  bubble for the real one without a duplicate or a jump */
  async send(threadId: string, input: { text: string; attachments?: { path: string; mime: string; name?: string }[]; mentions?: MentionRef[]; clientId?: string }, behavior: SendBehavior = "queue"): Promise<"started" | "steered" | "queued"> {
    const meta = await this.mustThread(threadId);
    const mentions = await this.resolveMentionRefs(threadId, meta.projectId, input.mentions);
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
          await rt.session.steer({ text: withMentions(input.text, mentions), images, mentions });
          await this.appendRaw(threadId, {
            type: "user_message",
            text: input.text,
            steered: true,
            attachments: this.attachmentLabels(attachmentRefs),
            ...(mentions.length ? { mentions } : {}),
            ...(input.clientId ? { clientId: input.clientId } : {}),
          });
          return "steered";
        } catch (e) {
          // Steering failed (e.g. the turn hasn't really started yet) → fall back to queueing so the message isn't lost
          log("info", `thread ${threadId} 插话失败，改为排队：${String(e)}`);
        }
      }
      const q: QueuedMessage = { id: "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: input.text, attachments: attachmentRefs, ...(mentions.length ? { mentions } : {}), ...(input.clientId ? { clientId: input.clientId } : {}) };
      rt.queue.push(q);
      this.gw.publish(`thread:${threadId}`, { type: "queue", queue: rt.queue });
      return "queued";
    }

    await this.startTurn(threadId, input.text, attachmentRefs, mentions, input.clientId);
    return "started";
  }

  private async startTurn(threadId: string, text: string, attachmentRefs: { path: string; mime: string; name?: string }[], mentions: Mention[] = [], clientId?: string): Promise<void> {
    const rt = this.rt(threadId);
    rt.starting = true;
    try {
      await this.startTurnInner(threadId, text, attachmentRefs, mentions, clientId);
    } finally {
      rt.starting = false;
    }
  }

  private async startTurnInner(threadId: string, text: string, attachmentRefs: { path: string; mime: string; name?: string }[], mentions: Mention[], clientId?: string): Promise<void> {
    const meta = await this.mustThread(threadId);
    const rt = this.rt(threadId);
    // Conversations that already ran (have a providerSessionId) ignore "disabled": disabling only blocks new conversations
    const allowDisabled = !!meta.providerSessionId;
    // Cheap checks only (no CLI started) before the message is accepted: a bad Agent id or a disabled one is refused outright
    this.assertProviderAllowed(meta.provider, await this.settings.get(), { allowDisabled });

    // 1.3: the user's message is persisted and pushed FIRST. It used to wait for detection (a CLI "--version" on a cold
    // cache) and the Agent start (spawn + ACP initialize/session/new), which on Windows takes seconds, so the bubble came late.
    await this.appendRaw(threadId, {
      type: "user_message",
      text,
      attachments: this.attachmentLabels(attachmentRefs),
      ...(mentions.length ? { mentions } : {}),
      ...(clientId ? { clientId } : {}),
    });
    // Auto title (1.3: without the leading "> " quote blocks that "添加到对话" puts in front of the message)
    const trimmed = titleText(text);
    if (meta.titleAuto && trimmed) {
      await this.threads.patch(threadId, { title: trimmed.slice(0, 40), titleAuto: true });
      this.gw.publish("sidebar", { type: "thread.upsert", thread: await this.threads.get(threadId) });
    }

    if (!rt.session) {
      await this.setStatus(threadId, "initializing");
      try {
        await this.assertProviderUsable(meta.provider, { allowDisabled });
        await this.createSessionIfNeeded(threadId, { updateStatus: true });
      } catch (e) {
        await this.appendRaw(threadId, { type: "notice", level: "error", message: tr("notice.sessionStartFailed", { detail: String((e as Error)?.message ?? e) }) });
        await this.appendRaw(threadId, { type: "turn_ended", status: "failed", error: String((e as Error)?.message ?? e) } as Partial<TimelineEvent> & { type: "turn_ended" });
        await this.threads.patch(threadId, { lastTurnStatus: "failed" });
        await this.setStatus(threadId, "error");
        throw e;
      }
    }
    // A live session needs no detection: the Agent is running (the 60 s detect cache used to re-run "--version" on later sends)
    //「默认」threads: adopt Magpie's latest default before this turn (session is still idle here)
    await this.syncDefaultModelIfNeeded(threadId, meta, rt);

    // Windows without Git Bash: say so before the agent's first command fails on the WSL launcher
    await agentShellReady();
    if (!rt.bashHinted && bashMissingFor(meta.provider)) {
      rt.bashHinted = true;
      await this.appendRaw(threadId, { type: "notice", level: "warn", code: "bash_missing", message: tr("notice.bashMissing") });
    }
    await this.setStatus(threadId, "running");
    try {
      const images = await this.resolveAttachments(attachmentRefs);
      const payload = { text: withMentions(text, mentions), images, mentions };
      // No string-matching retry for 当前轮次尚未结束: ACP/Claude/Codex now clear the in-flight turn on
      // interrupt (and ACP ties discard to each prompt() promise), so the guard should not fire after Stop.
      await rt.session!.send(payload);
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
      // Goes through the coalescer, not persisted; Agents that never send the complete message get it saved from the deltas
      if (rt.deltasOnly && ev.type !== "tool_output_delta") {
        const key = `${ev.type === "assistant_delta" ? "assistant" : "reasoning"}\0${ev.itemId}`;
        const prior = rt.pendingText.get(key);
        rt.pendingText.set(key, { type: ev.type === "assistant_delta" ? "assistant" : "reasoning", itemId: ev.itemId, text: (prior?.text ?? "") + ev.text });
      }
      rt.coalescer.push(deltaKey(ev.type, ev.itemId), ev.text);
      return;
    }
    // Before persisting a complete event, flush that itemId's pending deltas first (keeps ordering)
    const evItemId = (ev as { itemId?: unknown }).itemId;
    if (typeof evItemId === "string") this.flushDeltas(rt, evItemId);
    // Another item starts (tool call, plan, permission …) or the turn ends: the text streamed so far is complete, save it first
    if (rt.pendingText.size && ev.type !== "usage" && ev.type !== "assistant_message" && ev.type !== "reasoning") {
      await this.persistPendingText(threadId, rt);
    }
    if (ev.type === "assistant_message" || ev.type === "reasoning") {
      rt.pendingText.delete(`${ev.type === "assistant_message" ? "assistant" : "reasoning"}\0${ev.itemId}`);
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
      if (ev.type === "permission_request") {
        // 1.3 全部自动同意: the daemon answers "allow once" itself; no card (the tool call still shows in the timeline)
        const meta = await this.threads.get(threadId);
        const auto = meta ? autoApproveOption(meta.mode, meta.provider, ev) : null;
        if (auto) {
          // #727 review: every auto-approval leaves a trace. The request (title, command / path / diff, options) and its
          // answer are persisted like a card the user answered, both marked auto, before the Agent is told to go on.
          log("info", `thread ${threadId} 自动同意 ${ev.title.slice(0, 80)} → ${auto.id}`);
          await this.appendRaw(threadId, { ...ev, auto: true });
          await this.appendRaw(threadId, { type: "permission_resolved", requestId: ev.requestId, optionId: auto.id, auto: true });
          rt.session?.respond(ev.requestId, { optionId: auto.id });
          return;
        }
      }
      // allowAlways hit → approve directly (with this request's own allow option, not a guessed id)
      const toolName = (ev as { detail?: { toolName?: string } }).detail?.toolName;
      if (toolName && rt.allowAlways.has(toolName)) {
        const allow = options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind === "allow_always");
        rt.session?.respond(ev.requestId, { optionId: allow?.id ?? "accept" });
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
      // A request the Agent left open when its turn ended (Cursor: the model stream died with "[canceled] http/2 stream
      // closed", the request was never answered or withdrawn) can no longer be answered: cancel it before the turn end
      // is written. Otherwise it stays in rt.pending, threads.get hands it to the page, and the top bar says 等待授权
      // with no card to click (the card itself shows 已取消 because the thread is idle).
      await this.cancelPending(threadId, rt, { tellSession: true });
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
      if (!next) void this.recycleIdle().catch(() => {});
      if (next) {
        this.gw.publish(`thread:${threadId}`, { type: "queue", queue: rt.queue });
        // A queued message that fails to start is only logged; it must not break the event pump (startTurn already wrote notice/turn_ended)
        await this.startTurn(threadId, next.text, next.attachments, next.mentions ?? [], next.clientId).catch((e) => {
          log("warn", `thread ${threadId} 排队消息启动失败：${String(e)}`);
        });
      }
      return;
    }
    // Everything else: persist + push
    await this.appendRaw(threadId, ev);
  }

  private async persistPendingText(threadId: string, rt: Runtime): Promise<void> {
    const pending = [...rt.pendingText.values()];
    rt.pendingText.clear();
    for (const p of pending) {
      if (!p.text) continue;
      this.flushDeltas(rt, p.itemId);
      await this.appendRaw(threadId, { type: p.type === "assistant" ? "assistant_message" : "reasoning", itemId: p.itemId, text: p.text });
    }
  }

  private alive(_s: ProviderSession): boolean {
    return true; // mock /exit closes the queue; end of the event stream is handled separately
  }

  // ---- respond (permission/question answers) ----
  async respond(threadId: string, requestId: string, answer: RespondAnswer): Promise<void> {
    const rt = this.rt(threadId);
    const pending = rt.pending.get(requestId);
    if (!pending) throw new ApiError("not_found", tr("err.requestGone"));
    if (pending.kind === "permission" && answer.optionId) {
      const valid = pending.options.some((o) => o.id === answer.optionId);
      if (!valid) throw new ApiError("bad_params", tr("err.badOption", { id: String(answer.optionId) }));
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

  /** Answer every waiting tool approval with its allow-once option (full-auto just turned on). Returns how many. */
  private async autoApprovePending(threadId: string, providerId: string, mode: Mode): Promise<number> {
    const rt = this.rt(threadId);
    let n = 0;
    for (const p of [...rt.pending.values()]) {
      if (p.kind !== "permission") continue;
      const ev = p.event as { kind?: string };
      const opt = autoApproveOption(mode, providerId, { kind: ev.kind, options: p.options });
      if (!opt) continue;
      rt.pending.delete(p.requestId);
      await this.appendRaw(threadId, { type: "permission_resolved", requestId: p.requestId, optionId: opt.id, auto: true });
      rt.session?.respond(p.requestId, { optionId: opt.id });
      n++;
    }
    return n;
  }

  /** Cancel every open permission/question: persisted as permission_resolved{cancelled} (the page marks the card
   *  已取消 and stops waiting). tellSession: also answer the provider's own waiter (an Agent that ended its turn without
   *  withdrawing the request would otherwise keep a dangling promise); its echo is dropped because rt.pending is empty. */
  private async cancelPending(threadId: string, rt: Runtime, opts: { tellSession: boolean }): Promise<void> {
    if (!rt.pending.size) return;
    const open = [...rt.pending.values()];
    rt.pending.clear();
    for (const p of open) {
      await this.appendRaw(threadId, { type: "permission_resolved", requestId: p.requestId, cancelled: true });
      p.resolve({ cancelled: true });
      if (opts.tellSession) {
        try { rt.session?.respond(p.requestId, { cancelled: true }); } catch { /* the session may be gone */ }
      }
    }
  }

  // ---- interrupt ----
  async interrupt(threadId: string): Promise<void> {
    const rt = this.rt(threadId);
    if (!rt.session || rt.status !== "running") return;
    // Invalidate all pending requests
    await this.cancelPending(threadId, rt, { tellSession: false });
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
    // Thread stays on「默认」when model is null; the live session still gets the resolved default id
    // so switching back to Default (and Magpie default changes) take effect on the next turn.
    const sessionModel = model ?? await this.resolveDefaultSessionModel(meta.provider);
    await this.threads.patch(threadId, { model, effort });
    const rt = this.rt(threadId);
    let applied: boolean | void = true;
    if (rt.session) {
      // Only an explicit user pick may bypass ACP's session/new model validation.
      if (model !== null) applied = await rt.session.setModel(sessionModel, { force: true });
      else applied = await rt.session.setModel(sessionModel);
    }
    // 1.3.6: a default the session skipped (ACP validation) is not "synced" — the next idle send retries it
    rt.syncedDefaultModel = model ? undefined : applied === false ? undefined : sessionModel;
    this.gw.publish("sidebar", { type: "thread.upsert", thread: await this.threads.get(threadId) });
  }

  /**
   * Default model id to push into a live session while the thread is on「默认」.
   * dsh must use its own ACP model ids from cachedModels (never raw applied.json "magpie/…" strings).
   */
  private async resolveDefaultSessionModel(providerId: string): Promise<string | null> {
    if (providerId === "dsh") {
      const provider = getProvider(providerId);
      if (!provider) return null;
      const settings = await this.settings.get();
      const launch = launchFromSettings(settings, providerId);
      const available = await cachedModels(provider, launch).catch(() => []);
      const magpie = available.filter((m) => /magpie/i.test(m.id));
      return (magpie.find((m) => m.isDefault) ?? magpie[0] ?? available.find((m) => m.isDefault))?.id ?? null;
    }
    return magpieDefaultModel(providerId);
  }

  /**
   * Thread on「默认」+ idle live session: if Magpie's applied default changed since we last synced,
   * push the new id into the session (never interrupts a running turn — caller only invokes while idle/before send).
   */
  private async syncDefaultModelIfNeeded(threadId: string, meta: ThreadMeta, rt: Runtime): Promise<void> {
    if (meta.model) return; // explicit model pick — leave it alone
    if (!rt.session) return;
    // Only skip a turn that is already running / initializing. rt.starting is true for the whole
    // startTurnInner (including this sync-before-send), so it must not block adoption of a new Magpie default.
    if (rt.status === "running" || rt.status === "initializing") return;
    const current = await this.resolveDefaultSessionModel(meta.provider);
    if (current === (rt.syncedDefaultModel ?? null)) return;
    try {
      const applied = await rt.session.setModel(current);
      // 1.3.6: ACP may skip a Magpie default that isn't in the session's model options (no blind
      // set_config_option). Don't record it as synced then, or later idle sends never retry it.
      if (applied !== false) rt.syncedDefaultModel = current;
    } catch (e) {
      log("warn", `thread ${threadId} sync default model failed：${String(e)}`);
    }
  }

  async setMode(threadId: string, mode: Mode): Promise<void> {
    const meta = await this.threads.patch(threadId, { mode });
    const rt = this.rt(threadId);
    // 1.3: turning 全部自动同意 on also approves the cards already waiting (the user was stuck exactly there)
    if (mode === FULL_AUTO) await this.autoApprovePending(threadId, meta.provider, mode);
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
    if (meta.provider !== "cursor") throw new ApiError("bad_params", tr("err.cursorOnly"));
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
    if (!meta) throw new ApiError("not_found", tr("err.threadMissing"));
    const rt = this.rt(threadId);
    if (rt.status === "running" || rt.status === "initializing" || rt.starting) {
      throw new ApiError("busy", tr("err.busySwitch"));
    }
    const events = await this.threads.readEvents(threadId, 0, 5000);
    // 1.3: the user's message is now saved before the Agent starts, so a first message whose Agent never started
    // (no session id, no turn, no reply) does not lock the conversation to that Agent
    const neverRan = !meta.providerSessionId && !events.some((e) => e.type === "turn_started" || e.type === "assistant_message" || e.type === "tool_call");
    if (events.some((e) => e.type === "user_message") && !neverRan) {
      throw new ApiError("bad_params", tr("err.hasMessages"));
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
    // 1.3 (#727 review 3): same guard as threads.create for a pre-1.3 default of 全部放行
    const guard = await guardLegacyMode(this.settings, providerId, clampMode(p.capabilities.modes, meta.mode));
    await this.threads.patch(threadId, {
      provider: providerId,
      model: null,
      mode: guard.mode,
      effort: null,
      providerSessionId: null,
      status: "idle",
    });
    if (guard.notice) await this.appendRaw(threadId, upgradeNotice());
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
    if (!proj) throw new ApiError("not_found", tr("err.projectMissing"));
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
      model = await this.resolveDefaultSessionModel("dsh");
    }
    //「默认」: pass the resolved Magpie / agent default into the session so a live process doesn't stick on an old spawn-time default
    const sessionModel = model ?? await this.resolveDefaultSessionModel(meta.provider);
    if (opts.updateStatus) await this.setStatus(threadId, "initializing");
    const settings = await this.settings.get();
    const launch = launchFromSettings(settings, meta.provider);
    rt.deltasOnly = !!provider.capabilities.deltasOnly;
    // The agent's environment gets the Git Bash found at start / after a settings change (Windows)
    await agentShellReady();
    rt.session = await provider.createSession({
      threadId,
      cwd: proj.path,
      model: sessionModel,
      mode: clampMode(provider.capabilities.modes, meta.mode),
      effort: meta.effort,
      resumeId: meta.providerSessionId,
      cursorFast: meta.cursorFast,
      cursorAutoReview: meta.cursorAutoReview,
      launch,
    });
    rt.syncedDefaultModel = model ? undefined : sessionModel;
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
    if (!meta) throw new ApiError("not_found", tr("err.threadMissing"));
    return meta;
  }

  private providerOf(meta: ThreadMeta): Provider | undefined {
    return getProvider(meta.provider);
  }

  /** The checks that start nothing: a known Agent, enabled (unless allowDisabled), not a planned one */
  private assertProviderAllowed(providerId: string, s: Awaited<ReturnType<SettingsStore["get"]>>, opts: { allowDisabled?: boolean } = {}): Provider {
    const p = getProvider(providerId);
    if (!p) throw new ApiError("bad_params", tr("provider.unknown", { id: providerId }));
    if (!opts.allowDisabled && !isProviderEnabled(s, providerId)) {
      throw new ApiError("bad_params", tr("provider.disabledNamed", { name: p.name }));
    }
    const entry = catalogById(providerId);
    if (entry && !providerCreatable(entry.status)) {
      throw new ApiError("bad_params", tr("provider.plannedNamed", { name: p.name }));
    }
    return p;
  }

  private async assertProviderUsable(providerId: string, opts: { allowDisabled?: boolean } = {}): Promise<Provider> {
    const s = await this.settings.get();
    const p = this.assertProviderAllowed(providerId, s, opts);
    const det = await cachedDetect(p, launchFromSettings(s, providerId));
    if (!det.available) throw new ApiError("bad_params", det.reason ?? tr("provider.unavailable", { name: p.name }));
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

  /** B17: idle Agent processes are closed after idleCloseMinutes, and at most MAX_WARM_IDLE of them stay warm
   *  (least recently used go first). A running turn, one starting, or one waiting on an approval is never touched. */
  private recycling = false;
  async recycleIdle(): Promise<void> {
    if (this.recycling) return;
    this.recycling = true;
    try {
      const s = await this.settings.get();
      const minutes = Number(s.idleCloseMinutes);
      const limit = (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60_000;
      const idle = [...this.runtimes.values()]
        .filter((rt) => rt.session && rt.status === "idle" && !rt.starting && !rt.sessionCreating && rt.pending.size === 0 && rt.queue.length === 0)
        .sort((a, b) => b.lastActivity - a.lastActivity);
      const now = Date.now();
      for (const [i, rt] of idle.entries()) {
        const expired = now - rt.lastActivity > limit;
        if (!expired && i < MAX_WARM_IDLE) continue;
        log("info", `idle cleanup: closing thread ${rt.threadId} (${expired ? "idle timeout" : "over the warm limit"})`);
        try {
          await this.close(rt.threadId);
        } catch (e) {
          // The conversation may have been deleted meanwhile: just forget its runtime
          log("info", `idle cleanup: thread ${rt.threadId}: ${String((e as Error)?.message ?? e)}`);
          this.runtimes.delete(rt.threadId);
        }
      }
    } finally {
      this.recycling = false;
    }
  }
}
