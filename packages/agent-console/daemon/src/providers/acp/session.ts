// Persistent ACP session: cursor-agent acp / devin acp and others.
import type { ActiveSession, ClientConnection, ClientContext } from "@agentclientprotocol/sdk";
import { client, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { ChildProcess } from "node:child_process";
import type { ProviderSession, SendInput, RespondAnswer, Mode, SlashCommand } from "../types.js";
import { mapAcpAvailableCommands, sortSlashCommands } from "../slash.js";
import type { ProviderEvent } from "../../timeline/types.js";
import { AsyncQueue } from "../../util/queue.js";
import { resolveFirstBin, type ResolveResult } from "../../util/bin.js";
import { absCwd, acpStreamFromChild, killAcpChild, spawnResolved } from "./spawn.js";
import { registerAcpClientHandlers } from "./clientHandlers.js";
import { mapSessionUpdate, newMapCtx, stopToTurnEnd, type MapCtx } from "./mapUpdate.js";
import { promptCapsFromInitialize, rememberPromptCaps, type AcpPromptCaps } from "./promptCaps.js";
import { buildAcpPrompt } from "./prompt.js";
import { tr } from "../../util/i18n.js";

type AcpSelectValue = { value?: string; name?: string; options?: AcpSelectValue[] };
type AcpConfigOption = { id: string; category?: string | null; type?: string; currentValue?: unknown; options?: AcpSelectValue[] };
import { log } from "../../log.js";

const rid = () => Math.random().toString(36).slice(2, 10);

type AttachableCtx = {
  attachSession(response: { sessionId: string; modes?: unknown }): ActiveSession;
};

export type AcpSessionOpts = {
  threadId: string;
  /** Provider id and display name: the Agent's prompt capabilities are remembered under the id; notices name the Agent */
  providerId?: string;
  providerName?: string;
  cwd: string;
  model: string | null;
  mode: Mode;
  effort: string | null;
  resumeId: string | null;
  binName: string;
  binCandidates: string[];
  acpArgs: string[];
  /** initialize's image answer holds for the start model only (dsh): after a switch, images go by path */
  imagesFollowStartModel?: boolean;
  appVersion: string;
  flavor: "cursor" | "generic";
  modeMap?: Partial<Record<Mode, string>>;
  cursorFast?: boolean;
  cursorAutoReview?: boolean;
  launch?: { cmd: string; prefixArgs: string[] };
};

export class AcpSession implements ProviderSession {
  events: AsyncIterable<ProviderEvent>;
  private q = new AsyncQueue<ProviderEvent>();
  private child: ChildProcess | null = null;
  private conn: ClientConnection | null = null;
  private ctx: ClientContext | null = null;
  private active: ActiveSession | null = null;
  private initErr: Error | null = null;
  private initPromise: Promise<void>;
  private closed = false;
  private turnId: string | null = null;
  private turnNum = 0;
  private running = false;
  private permPending = new Map<string, (a: RespondAnswer) => void>();
  private mapCtx: MapCtx = newMapCtx();
  private modelConfigId: string | null = null;
  private thoughtConfigId: string | null = null;
  private cursorFast = false;
  private cursorAutoReview = false;
  private slashCommands: SlashCommand[] = [];
  private activeTurnId: string | null = null;
  private configOptions: AcpConfigOption[] | null = null;
  // initialize → agentCapabilities.promptCapabilities (ACP baseline until initialize answers: text + resource_link)
  private promptCaps: AcpPromptCaps = { image: false, audio: false, embeddedContext: false };
  private initCaps: AcpPromptCaps = this.promptCaps;
  private startModel: string | null = null;
  private wakePump: (() => void) | null = null;
  // listCommands waits for the first batch of commands (or confirmation there are none), following Paseo's waitForInitialCommands
  private commandsReady!: Promise<void>;
  private settleCommands!: () => void;

  constructor(private o: AcpSessionOpts) {
    this.events = this.q;
    this.startModel = o.model; // the model the process is launched for (argsFor), before any setModel
    this.cursorFast = o.cursorFast ?? false;
    // The shield (auto-accept permission prompts) UI was removed: never auto-approve, so conversations that once turned it on don't keep approving with the toggle hidden
    this.cursorAutoReview = false;
    this.commandsReady = new Promise<void>((r) => (this.settleCommands = r));
    this.initPromise = this.boot();
  }

  private async boot(): Promise<void> {
    const bin = this.o.launch
      ? ({
          ok: true as const,
          cmd: this.o.launch.cmd,
          prefixArgs: this.o.launch.prefixArgs,
          display: this.o.launch.cmd,
          via: "custom",
          binName: "custom",
        } satisfies ResolveResult & { ok: true; binName: string })
      : await resolveFirstBin(this.o.binCandidates?.length ? this.o.binCandidates : [this.o.binName]);
    if (!bin.ok) throw new Error(bin.reason);
    try {
      this.child = spawnResolved(bin, this.o.acpArgs, { cwd: this.o.cwd });
      this.child.stderr?.on("data", (d: Buffer) => {
        const t = d.toString().trim();
        if (t) log("info", `[${this.o.binName} acp] ${t.slice(0, 500)}`);
      });
      this.child.on("error", (e) => this.failInit(e));
      this.child.on("close", (code) => {
        if (!this.closed && code !== 0) {
          this.q.push({ type: "notice", level: "error", message: `${this.o.binName} 进程退出 (${code})` });
        }
      });

      const app = client({ name: "magpie-agent-console" });
      registerAcpClientHandlers(app, {
        push: (ev) => this.q.push(ev),
        waitFor: (id) => this.waitPerm(id),
        autoAcceptPermissions: () => this.cursorAutoReview,
      });
      const stream = acpStreamFromChild(this.child);
      this.conn = app.connect(stream);
      this.ctx = this.conn.agent;
      const initRes = await this.ctx.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        // Cursor: declare support for the parameterized model picker (as Paseo does); only then does it expose levels / Fast as separate config options
        clientCapabilities: this.o.flavor === "cursor" ? { _meta: { parameterizedModelPicker: true } } : {},
        clientInfo: { name: "Agent Console", version: this.o.appVersion },
      });
      this.promptCaps = promptCapsFromInitialize(initRes);
      this.initCaps = this.promptCaps;
      rememberPromptCaps(this.o.providerId, this.promptCaps);

      const cwd = absCwd(this.o.cwd);
      const ctx = this.ctx;
      if (!ctx) throw new Error("ACP 未连接");
      if (this.o.resumeId) {
        const loaded = await ctx.request(methods.agent.session.load, {
          sessionId: this.o.resumeId,
          cwd,
          mcpServers: [],
        });
        this.active = (ctx as unknown as AttachableCtx).attachSession({
          sessionId: this.o.resumeId,
          modes: loaded.modes,
        });
      } else {
        this.active = await ctx.buildSession(cwd).start();
      }
      this.syncModelConfigId();
      this.syncThoughtConfigId();
      await this.applySessionMode(this.o.mode);
      await this.applySessionModel(this.o.model); // Also applies the thinking level
      await this.applyCursorAutoReviewConfig(this.cursorAutoReview);
      this.q.push({ type: "provider_session_id", id: this.active.sessionId });
      const init = (this.active.newSessionResponse as { availableCommands?: { name: string; description: string; input?: { hint?: string } | null }[] })
        ?.availableCommands;
      if (init?.length) this.applyAvailableCommands(init);
      void this.pumpUpdates();
    } catch (e) {
      this.failInit(e);
      throw e;
    }
  }

  private failInit(e: unknown): void {
    this.initErr = e instanceof Error ? e : new Error(String(e));
  }

  private applyAvailableCommands(
    raw: { name: string; description: string; input?: { hint?: string } | null }[],
  ): void {
    this.slashCommands = sortSlashCommands(mapAcpAvailableCommands(raw));
    this.q.push({ type: "slash_commands", commands: this.slashCommands });
    this.settleCommands();
  }

  private async ready(): Promise<void> {
    await this.initPromise.catch(() => {});
    if (this.initErr) throw this.initErr;
    if (!this.active) throw new Error("ACP 会话未就绪");
  }

  /** The config options currently in effect: each set_config_option response returns the latest set (levels change after switching models); otherwise use session/new's */
  private currentConfig(): AcpConfigOption[] {
    return (this.configOptions ?? this.active?.newSessionResponse.configOptions ?? []) as AcpConfigOption[];
  }

  private syncModelConfigId(): void {
    for (const o of this.currentConfig()) {
      if (o.type === "select" && (o.category === "model" || o.id === "model")) {
        this.modelConfigId = o.id;
        return;
      }
    }
    if (this.o.flavor === "cursor") this.modelConfigId = "model";
  }

  // Level options belong to the current model: recompute on every refresh (cleared when switching to a model without levels)
  private syncThoughtConfigId(): void {
    this.thoughtConfigId = null;
    const opts = this.currentConfig().filter((o) => o.type === "select");
    const hit =
      opts.find((o) => o.category === "thought_level") ??
      opts.find((o) => /thought|thinking|effort|reasoning/i.test(o.id ?? ""));
    if (hit) this.thoughtConfigId = hit.id;
  }

  /** set_config_option, then refresh local state from the latest config options it returns */
  private async setOption(configId: string, value: string): Promise<boolean> {
    if (!this.ctx || !this.active) return false;
    try {
      const res = (await this.ctx.request(methods.agent.session.setConfigOption, {
        sessionId: this.active.sessionId,
        configId,
        value,
      })) as { configOptions?: AcpConfigOption[] } | null;
      if (Array.isArray(res?.configOptions)) {
        this.configOptions = res.configOptions;
        this.syncThoughtConfigId();
      }
      return true;
    } catch (e) {
      log("info", `ACP set_config_option(${configId}=${value}): ${String(e)}`);
      return false;
    }
  }

  private async applySessionThought(effort: string | null): Promise<void> {
    if (!effort || !this.thoughtConfigId) return;
    // Don't send a level the current model doesn't support (the level set changes after switching models)
    const opt = this.currentConfig().find((o) => o.id === this.thoughtConfigId);
    const values = (opt?.options ?? []).flatMap((x) => (x.options ? x.options : [x])).map((x) => x.value);
    if (values.length && !values.includes(effort)) return;
    await this.setOption(this.thoughtConfigId, effort);
  }

  /** Mode choices the Agent reports: prefer a category=mode select in configOptions, otherwise ACP modes.availableModes */
  private modeChoices(): { id: string; name: string; configId: string | null }[] {
    const opt = this.currentConfig().find(
      (o) => o.type === "select" && (o.category === "mode" || o.id === "mode"),
    ) as { id: string; options?: { value?: string; name?: string }[] } | undefined;
    if (opt?.options?.length) {
      return opt.options
        .filter((x) => typeof x.value === "string")
        .map((x) => ({ id: x.value!, name: x.name ?? x.value!, configId: opt.id }));
    }
    return (this.active?.modes?.availableModes ?? []).map((m) => ({ id: m.id, name: m.name, configId: null }));
  }

  private resolveAcpModeId(mode: Mode): string | null {
    if (this.o.modeMap) {
      // Find the Agent's real mode via the table; Copilot's mode ids are URLs (…/session-modes#agent), so match on the # suffix
      const want = this.o.modeMap[mode];
      if (!want) return null;
      const hit = this.modeChoices().find(
        (m) => m.id === want || m.id.endsWith(`#${want}`) || m.name.toLowerCase() === want,
      );
      return hit?.id ?? want;
    }
    if (this.o.flavor === "cursor") {
      const map: Partial<Record<Mode, string>> = { default: "agent", plan: "plan", ask: "ask" };
      const want = map[mode] ?? "agent";
      const avail = this.active?.modes?.availableModes ?? [];
      const hit = avail.find((m) => m.id === want || m.name.toLowerCase() === want);
      return hit?.id ?? want;
    }
    return mode === "plan" ? "plan" : "default";
  }

  private async applySessionMode(mode: Mode): Promise<void> {
    if (!this.ctx || !this.active) return;
    // Copilot "Allow All" (as Paseo does): use the agent mode, then turn the allow_all config on; turn it off for other modes
    const hasAllowAll = this.currentConfig().some((o) => o.id === "allow_all");
    if (this.o.modeMap?.[mode] === "allow-all") {
      const agentId = this.modeChoices().find((m) => m.id === "agent" || m.id.endsWith("#agent"));
      if (agentId?.configId) await this.setOption(agentId.configId, agentId.id);
      if (hasAllowAll) await this.setOption("allow_all", "on");
      return;
    }
    if (hasAllowAll && this.o.modeMap) await this.setOption("allow_all", "off");
    const modeId = this.resolveAcpModeId(mode);
    if (!modeId) return; // This Agent has no such mode: don't send anything
    try {
      // Modes offered as a config option (Devin / OpenCode / Copilot) use set_config_option, otherwise set_mode
      const viaConfig = this.modeChoices().find((m) => m.id === modeId)?.configId;
      if (viaConfig) {
        await this.setOption(viaConfig, modeId);
        return;
      }
      await this.ctx.request(methods.agent.session.setMode, {
        sessionId: this.active.sessionId,
        modeId,
      });
    } catch (e) {
      log("info", `ACP setMode(${mode}): ${String(e)}`);
    }
  }

  /**
   * Switch model → refresh level options from the new config options it returns → then apply the level (as Paseo does).
   * Cursor connects with parameterizedModelPicker: only the base model name is sent (grok-4.6); level / Fast are separate config options.
   */
  private async applySessionModel(model: string | null): Promise<void> {
    if (!this.ctx || !this.active) return;
    const value = model && this.o.flavor === "cursor" ? model.replace(/\[.*\]$/u, "") : model;
    if (value) {
      const modelOption = this.currentConfig().find((o) => o.id === (this.modelConfigId ?? "model"));
      const values = (modelOption?.options ?? []).flatMap((x) => x.options ? x.options : [x])
        .map((x) => x.value).filter((x): x is string => typeof x === "string");
      // Old sessions may have saved another Agent's model ID. Skip invalid values and let ACP keep its current model.
      if (!values.length || values.includes(value)) {
        await this.setOption(this.modelConfigId ?? "model", value);
      } else {
        log("info", `忽略 ${this.o.binName} 的无效模型：${value}`);
      }
    }
    if (this.o.flavor === "cursor" && this.cursorFast && this.currentConfig().some((o) => o.id === "fast")) {
      await this.setOption("fast", "true");
    }
    await this.applySessionThought(this.o.effort);
  }

  private async applyCursorAutoReviewConfig(on: boolean): Promise<void> {
    if (this.o.flavor !== "cursor" || !this.ctx || !this.active) return;
    for (const configId of ["auto_review", "autoReview", "smart_auto"]) {
      try {
        await this.ctx.request(methods.agent.session.setConfigOption, {
          sessionId: this.active.sessionId,
          configId,
          type: "boolean",
          value: on,
        });
        return;
      } catch {
        /* try the next configId */
      }
    }
  }

  /** Cursor only: Fast / Auto-review (can be changed while the session is open) */
  async updateCursorOpts(fast: boolean, autoReview: boolean): Promise<void> {
    this.cursorFast = fast;
    void autoReview; // See the constructor: auto-approval is no longer supported
    await this.ready();
    await this.applySessionModel(this.o.model);
    await this.applyCursorAutoReviewConfig(false);
  }

  private waitPerm(requestId: string): Promise<RespondAnswer> {
    return new Promise((resolve) => {
      this.permPending.set(requestId, resolve);
    });
  }

  respond(requestId: string, answer: RespondAnswer): void {
    const r = this.permPending.get(requestId);
    if (r) {
      this.permPending.delete(requestId);
      r(answer);
      this.q.push({
        type: "permission_resolved",
        requestId,
        optionId: answer.optionId,
        cancelled: answer.cancelled,
      });
    }
  }

  async send(input: SendInput): Promise<void> {
    await this.ready();
    if (this.running) throw new Error("当前轮次尚未结束");
    this.turnNum++;
    this.turnId = "u_" + Date.now().toString(36) + "_" + this.turnNum;
    this.mapCtx = newMapCtx();
    this.running = true;
    this.q.push({
      type: "turn_started",
      turnId: this.turnId,
      model: this.o.model,
      mode: this.o.mode,
      effort: this.o.effort,
    });
    const text = input.text.trim();
    const attachments = input.images ?? [];
    if (!text && !attachments.length) {
      this.running = false;
      this.q.push({ type: "turn_ended", turnId: this.turnId, status: "completed" });
      return;
    }
    // An image-only message is still a prompt: images go as image blocks when the Agent takes them, else by file path
    const built = await buildAcpPrompt(text, attachments, this.promptCaps);
    const agent = this.o.providerName ?? this.o.binName;
    if (built.imagesByPath.length && !this.promptCaps.image) {
      const switched = this.o.imagesFollowStartModel && this.initCaps.image && this.o.model !== this.startModel;
      this.q.push({ type: "notice", level: "warn", message: tr(switched ? "notice.acpImageByPathSwitched" : "notice.acpImageByPath", { agent, paths: built.imagesByPath.join(", ") }) });
    }
    for (const w of built.warnings) this.q.push({ type: "notice", level: "warn", message: tr("notice.attachmentIssue", { detail: w }) });
    if (!built.blocks.length) {
      // Every attachment failed to resolve and there was no text: nothing to send
      this.running = false;
      this.q.push({ type: "turn_ended", turnId: this.turnId, status: "completed" });
      return;
    }
    void this.runTurn(built.blocks);
  }

  // Send this turn's prompt; reading updates is the job of the persistent pumpUpdates() (following Paseo: session/update is handled at session level)
  private async runTurn(prompt: Parameters<ActiveSession["prompt"]>[0]): Promise<void> {
    this.activeTurnId = this.turnId;
    this.wakePump?.();
    this.wakePump = null;
    this.active!.prompt(prompt).catch(() => {
      /* failures surface through nextUpdate() and pumpUpdates ends the turn */
    });
  }

  private endTurn(ev: ProviderEvent): void {
    this.q.push(ev);
    this.activeTurnId = null;
    this.running = false;
  }

  /**
   * Read session/update for the whole lifetime of the session.
   * It used to read only during a turn: the available_commands_update an Agent pushes after session/new and before the first message went unread,
   * so the slash menu stayed empty. Now command updates are cached at any time; conversation content becomes timeline events only while a turn is in progress.
   */
  private async pumpUpdates(): Promise<void> {
    const session = this.active;
    if (!session) return;
    while (!this.closed) {
      let msg: Awaited<ReturnType<typeof session.nextUpdate>>;
      try {
        msg = await session.nextUpdate();
      } catch (e) {
        if (this.closed) return;
        const turnId = this.activeTurnId;
        if (turnId) {
          this.endTurn({ type: "turn_ended", turnId, status: "failed", error: String((e as Error)?.message ?? e) });
        }
        // After an error the queue keeps throwing the same error until the next prompt clears it: wait for the next turn before reading again
        await new Promise<void>((r) => (this.wakePump = r));
        continue;
      }
      if (msg.kind === "session_update") {
        const u = msg.update;
        if (u.sessionUpdate === "available_commands_update") {
          this.applyAvailableCommands(u.availableCommands ?? []);
          continue;
        }
        if (!this.activeTurnId) continue; // Other updates outside a turn (e.g. mode change echoes) don't go to the timeline
        for (const ev of mapSessionUpdate(u, this.mapCtx)) this.q.push(ev);
      } else if (this.activeTurnId) {
        this.endTurn(stopToTurnEnd(msg.stopReason, this.activeTurnId));
      }
    }
  }

  async interrupt(): Promise<void> {
    await this.ready();
    if (!this.ctx || !this.active) return;
    try {
      await this.ctx.request(methods.agent.session.cancel, { sessionId: this.active.sessionId });
    } catch (e) {
      log("info", `ACP cancel: ${String(e)}`);
    }
  }

  async setModel(model: string | null): Promise<void> {
    this.o.model = model;
    await this.ready();
    if (this.o.imagesFollowStartModel) {
      // dsh answered initialize for the model it started on; another model may not take image blocks (it refuses the prompt)
      this.promptCaps = model === this.startModel ? this.initCaps : { ...this.initCaps, image: false };
    }
    await this.applySessionModel(model);
  }

  async setMode(mode: Mode): Promise<void> {
    this.o.mode = mode;
    await this.ready();
    await this.applySessionMode(mode);
  }

  async setEffort(effort: string | null): Promise<void> {
    this.o.effort = effort;
    await this.ready();
    await this.applySessionThought(effort);
  }

  async listCommands(): Promise<SlashCommand[]> {
    try {
      await this.ready();
    } catch {
      return [];
    }
    // Commands are pushed asynchronously after session/new: wait at most 10 s for the first batch (Agents that report none return empty after the timeout)
    if (!this.slashCommands.length) {
      await Promise.race([this.commandsReady, new Promise((r) => setTimeout(r, 10000))]);
    }
    return this.slashCommands;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.wakePump?.();
    this.settleCommands();
    for (const r of this.permPending.values()) r({ cancelled: true });
    this.permPending.clear();
    try {
      this.active?.dispose();
    } catch {}
    try {
      this.conn?.close();
    } catch {}
    await killAcpChild(this.child);
    this.child = null;
    this.q.close();
  }
}
