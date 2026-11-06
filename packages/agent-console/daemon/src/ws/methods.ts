// Method registry: zod-validated params → call the service → return. P0-5 skeleton; filled in from P1 on.
import { z } from "zod";
import type { Gateway, ConnCtx } from "./gateway.js";
import type { Config } from "../config.js";
import type { SettingsStore, Settings } from "../store/settings.js";
import { parseSettingsPatch } from "../store/settings.js";
import type { ProjectsStore } from "../store/projects.js";
import type { ThreadsStore } from "../store/threads.js";
import { listProviders, getProvider } from "../providers/registry.js";
import { PROVIDER_CATALOG, catalogById, providerCreatable } from "../providers/catalog.js";
import { isProviderEnabled } from "../providers/enabled.js";
import type { SlashCommand } from "../providers/types.js";
import { GitService } from "../git/service.js";
import { FileService } from "../files/service.js";
import type { TerminalService } from "../terminal/service.js";
import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, win32 as win32Path } from "node:path";
import { execFile } from "node:child_process";
import { pickFolder } from "../util/pickFolder.js";
import { clearBinCache } from "../util/bin.js";
import { cachedDetect, cachedModels, clearProviderCache } from "../providers/infoCache.js";
import { launchFromSettings } from "../providers/launch.js";
import { clampMode } from "../providers/modes.js";
import { endLegacyDefault, guardLegacyMode, upgradeNotice } from "../migrate/autoApprove13.js";
import { setAppLocale, tr, intlLocale } from "../util/i18n.js";
import { MAX_MENTIONS } from "../util/mentions.js";
import { openExternal } from "../util/openExternal.js";
import { agentShellStatus, refreshAgentShell } from "../util/agentShell.js";
import { checkBashPath, GIT_FOR_WINDOWS_URL } from "../util/gitBash.js";
import { PreviewError, type PreviewProxy } from "../preview/proxy.js";
import { checkPreviewUrl, MAX_PREVIEW_URL } from "../preview/url.js";
import { previewHost } from "../preview/host.js";

const threadModeSchema = z.enum(["plan", "default", "acceptEdits", "bypassPermissions", "ask"]);

export type Services = {
  cfg: Config;
  settings: SettingsStore;
  gateway: Gateway;
  projects: ProjectsStore;
  threads: ThreadsStore;
  git: GitService;
  files: FileService;
  terminals: TerminalService;
  /** 1.2 preview proxy (absent in some tests) */
  preview?: PreviewProxy;
  // AgentManager provides runtime info once wired in at P1-4; may be empty (no session started)
  runtime?: (threadId: string) => { status: string; queue: unknown[]; pending: unknown[] } | null;
  manager?: {
    send(threadId: string, input: { text: string; attachments?: { path: string; mime: string; name?: string }[]; mentions?: { rel: string; isDir?: boolean }[]; clientId?: string }, behavior?: "queue" | "steer"): Promise<"started" | "steered" | "queued" | void>;
    interrupt(threadId: string): Promise<void>;
    respond(threadId: string, requestId: string, answer: { optionId?: string; answers?: Record<string, string>; cancelled?: boolean }): Promise<void>;
    setModel(threadId: string, model: string | null): Promise<void>;
    setMode(threadId: string, mode: "plan" | "default" | "acceptEdits" | "bypassPermissions" | "ask"): Promise<void>;
    setEffort(threadId: string, effort: string | null): Promise<void>;
    setCursorOpts(threadId: string, patch: { cursorFast?: boolean; cursorAutoReview?: boolean }): Promise<void>;
    setProvider(threadId: string, providerId: string): Promise<void>;
    close(threadId: string): Promise<void>;
    deleteThread(threadId: string): Promise<void>;
    listCommands(threadId: string, opts?: { load?: boolean }): Promise<SlashCommand[]>;
    removeQueued(threadId: string, queueId: string): boolean;
  };
};

export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function wrap<T extends z.ZodType>(schema: T, fn: (p: z.infer<T>, ctx: ConnCtx) => unknown) {
  return (params: unknown, ctx: ConnCtx) => {
    const r = schema.safeParse(params ?? {});
    if (!r.success) {
      throw new ApiError("bad_params", tr("err.badParams", { detail: r.error.issues.map((i) => i.message).join("; ") }));
    }
    return fn(r.data, ctx);
  };
}

export function registerMethods(gw: Gateway, svc: Services): void {
  const zEmpty = z.object({}).passthrough().optional();

  // Magpie's language changed while the page is open (1.2): daemon-made text (notices, tool titles) follows it
  gw.method("app.setLocale", wrap(z.object({ lang: z.string().max(32) }), (p) => {
    setAppLocale(p.lang);
    return true;
  }));

  gw.method("app.info", wrap(zEmpty, () => ({
    version: svc.cfg.version,
    dataDir: svc.cfg.dataDir,
    pid: process.pid,
    port: svc.cfg.port,
  })));

  // 1.3: Git Bash for the agents (Windows). status: what the agents get now; check: validate a path typed in Settings
  gw.method("shell.status", wrap(zEmpty, async () => {
    const st = agentShellStatus();
    return { ...st, platform: process.platform, downloadUrl: GIT_FOR_WINDOWS_URL };
  }));
  gw.method("shell.check", wrap(z.object({ path: z.string().max(1024) }), (p) => {
    if (process.platform !== "win32") return { ok: false, reason: "notWindows" };
    return checkBashPath(p.path);
  }));

  gw.method("app.shutdown", wrap(zEmpty, () => {
    setTimeout(() => process.exit(0), 100);
    return { ok: true };
  }));

  // 1.2: open an http(s) link in the system browser (the sandboxed page can't open popups)
  gw.method("app.openExternal", wrap(z.object({ url: z.string().min(1).max(MAX_PREVIEW_URL) }), async (p) => openExternal(p.url)));

  // 1.2 preview: a local-only reverse proxy for a loopback dev URL (see preview/proxy.ts for the limits)
  gw.method("preview.open", wrap(
    z.object({ url: z.string().min(1).max(MAX_PREVIEW_URL), threadId: z.string().max(200).optional() }),
    async (p) => {
      if (!svc.preview) throw new ApiError("unavailable", tr("err.previewUnavailable"));
      let r;
      try {
        r = await svc.preview.open(p.url);
      } catch (e) {
        if (e instanceof PreviewError) {
          throw new ApiError(e.code === "denied_port" ? "preview_denied" : "preview_url", tr(e.code === "denied_port" ? "err.previewDenied" : "err.previewUrl"));
        }
        throw e;
      }
      if (p.threadId) {
        const meta = await svc.threads.get(p.threadId);
        if (meta && meta.previewUrl !== r.url) {
          const next = await svc.threads.patch(p.threadId, { previewUrl: r.url });
          gw.publish("sidebar", { type: "thread.upsert", thread: next });
        }
      }
      // The daemon's real OS (the UA can't carry it, #582): the page refuses Apple WebKit on Darwin < 25 before any
      // *.localhost name is looked up, and releases this listener
      return { ...r, host: previewHost() };
    },
  ));

  gw.method("preview.release", wrap(z.object({ url: z.string().min(1).max(MAX_PREVIEW_URL) }), (p) => ({
    ok: svc.preview?.release(p.url) ?? false,
  })));

  gw.method("settings.get", wrap(zEmpty, () => svc.settings.get()));

  gw.method("settings.set", wrap(z.object({ patch: z.record(z.string(), z.unknown()) }), async (p) => {
    const checked = parseSettingsPatch(p.patch);
    if (!checked.ok) throw new ApiError("bad_params", `Invalid setting: ${checked.error}`);
    const before = await svc.settings.get();
    const next = await svc.settings.set(checked.patch as Partial<Settings>);
    // 1.3: a default permission mode picked after the upgrade is the user's 1.3 choice (ends the 1.2 全部放行 guard)
    if ("defaultMode" in checked.patch) await endLegacyDefault(svc.settings);
    // 1.3: Settings → Bash path (Windows) re-runs Git Bash detection for the next agent start
    if ("bashPath" in checked.patch && (before.bashPath ?? "") !== (next.bashPath ?? "")) {
      await refreshAgentShell(typeof next.bashPath === "string" ? next.bashPath : "");
    }
    // A changed launch command only invalidates that Agent's detection / model cache (B2: toggling never wipes the rest)
    for (const id of Object.keys(checked.patch.providerCommand ?? {})) {
      if (JSON.stringify(before.providerCommand?.[id] ?? null) !== JSON.stringify(next.providerCommand?.[id] ?? null)) {
        clearProviderCache(id);
      }
    }
    return next;
  }));

  gw.method("sub.add", wrap(
    z.object({ ch: z.string().min(1).max(120), afterSeq: z.number().int().nonnegative().optional() }),
    async (p, ctx) => {
      svc.gateway.subscribe(ctx.conn, p.ch);
      // The thread:<id> channel replays persisted events after afterSeq (late subscribers / reconnects lose nothing)
      const m = /^thread:(.+)$/.exec(p.ch);
      if (m && p.afterSeq != null) {
        const events = await svc.threads.readEvents(m[1], p.afterSeq, 5000).catch(() => []);
        for (const ev of events) ctx.conn.send({ t: "evt", ch: p.ch, d: { type: "event", event: ev } });
      }
      return { ok: true };
    }
  ));

  gw.method("sub.remove", wrap(z.object({ ch: z.string().min(1).max(120) }), (p, ctx) => {
    svc.gateway.unsubscribe(ctx.conn, p.ch);
    return { ok: true };
  }));

  // ---- providers.list (§6): detection + model list + capabilities ----
  // detect/listModels in parallel; 8s total per provider (listModels may start a temporary process).
  // refresh+provider: clear/reload only that Agent (model picker ↻ inside < Claude Code); refresh alone: all.
  gw.method("providers.list", wrap(
    z.object({ refresh: z.boolean().optional(), provider: z.string().optional() }).passthrough().optional(),
    async (p) => {
      if (p?.refresh) {
        if (p.provider) {
          clearBinCache(p.provider);
          clearProviderCache(p.provider);
        } else {
          clearBinCache();
          clearProviderCache();
        }
      }
      const settings = await svc.settings.get();
      const rows = await Promise.all(
        listProviders().map(async (p) => {
          const entry = catalogById(p.id);
          const enabled = isProviderEnabled(settings, p.id);
          const launch = launchFromSettings(settings, p.id);
          // Disabled / not-integrated ones are neither detected nor asked for models (saves seconds of CLI startup)
          const skip = !enabled || entry?.status === "planned";
          const det: import("../providers/types.js").DetectResult = skip
            ? { available: false, reason: !enabled ? tr("provider.disabled") : tr("provider.planned") }
            : await cachedDetect(p, launch);
          const models = !skip && det.available ? await cachedModels(p, launch) : [];
          return {
            id: p.id,
            name: p.name,
            available: det.available,
            enabled,
            status: entry?.status ?? "verified",
            ready: entry?.status === "verified",
            bin: det.bin,
            version: det.version,
            reason: !enabled ? tr("provider.disabled") : det.reason,
            installHint: det.installHint,
            capabilities: p.capabilities,
            models,
          };
        }),
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = PROVIDER_CATALOG.map((e) => byId.get(e.id)).filter(Boolean) as typeof rows;
      for (const r of rows) {
        if (!PROVIDER_CATALOG.some((e) => e.id === r.id)) ordered.push(r);
      }
      return ordered;
    }
  ));

  // ---- projects.* ----
  gw.method("projects.list", wrap(zEmpty, () => svc.projects.list()));

  gw.method("projects.create", wrap(
    z.object({ path: z.string().min(1), name: z.string().optional() }),
    async (p) => {
      const proj = await svc.projects.create(p.path, p.name);
      // Record recent directories (deduped, case-insensitive, at most 12)
      const s = await svc.settings.get();
      const dirs = (s.recentDirs ?? []).filter((d) => d.toLowerCase() !== p.path.toLowerCase());
      await svc.settings.set({ recentDirs: [p.path, ...dirs].slice(0, 12) });
      gw.publish("sidebar", { type: "project.upsert", project: proj });
      return proj;
    }
  ));

  gw.method("projects.rename", wrap(z.object({ id: z.string(), name: z.string() }), async (p) => {
    const proj = await svc.projects.rename(p.id, p.name);
    gw.publish("sidebar", { type: "project.upsert", project: proj });
    return proj;
  }));

  gw.method("projects.remove", wrap(z.object({ id: z.string() }), async (p) => {
    const proj = await svc.projects.get(p.id);
    if (!proj) throw new ApiError("not_found", tr("err.projectMissing"));
    // Move all of the project's conversations to the trash
    for (const t of await svc.threads.list()) {
      if (t.projectId === p.id) {
        await svc.threads.delete(t.id);
        gw.publish("sidebar", { type: "thread.remove", id: t.id });
      }
    }
    await svc.projects.remove(p.id);
    gw.publish("sidebar", { type: "project.remove", id: p.id });
    return { ok: true };
  }));

  gw.method("projects.open", wrap(z.object({ id: z.string() }), async (p) => {
    const proj = await svc.projects.get(p.id);
    if (!proj) throw new ApiError("not_found", tr("err.projectMissing"));
    if (!existsSync(proj.path)) throw new ApiError("bad_path", tr("err.dirMissing"));
    const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    // explorer.exe doesn't understand forward-slash paths (it opens "Documents"); a missing xdg-open must not make the daemon throw either
    const target = process.platform === "win32" ? win32Path.normalize(proj.path) : proj.path;
    execFile(cmd, [target], { windowsHide: true }, () => {}).on("error", () => {});
    return { ok: true };
  }));

  // ---- fs.* ----
  gw.method("fs.check", wrap(z.object({ path: z.string().min(1) }), (p) => {
    let exists = false;
    let isDir = false;
    try {
      exists = existsSync(p.path);
      isDir = exists && statSync(p.path).isDirectory();
    } catch {}
    return { exists, isDir };
  }));

  gw.method("fs.recentDirs", wrap(zEmpty, async () => {
    const s = await svc.settings.get();
    return (s.recentDirs ?? []).slice(0, 12);
  }));

  // fs.pickFolder: show the native folder picker (the daemon runs locally): Windows PowerShell, macOS osascript,
  // Linux zenity/kdialog; with none, report unavailable and the frontend falls back to typing.
  gw.method("fs.pickFolder", wrap(z.object({ initial: z.string().optional() }).passthrough().optional(), (p) =>
    pickFolder(p?.initial),
  ));

  // ---- threads.* ----
  gw.method("threads.list", wrap(zEmpty, () => svc.threads.list()));

  gw.method("threads.create", wrap(
    z.object({
      projectId: z.string().min(1),
      provider: z.string().min(1),
      model: z.string().nullable().optional(),
      mode: threadModeSchema.optional(),
      effort: z.string().nullable().optional(),
      title: z.string().optional(),
      providerSessionId: z.string().nullable().optional(),
      importedFrom: z.object({ provider: z.string(), sessionId: z.string() }).optional(),
    }),
    async (p) => {
      const proj = await svc.projects.get(p.projectId);
      if (!proj) throw new ApiError("not_found", tr("err.projectMissing"));
      if (!existsSync(proj.path)) throw new ApiError("bad_path", tr("err.projectDirGone"));
      // New conversations must use an enabled Agent (except imported sessions, which already ran)
      if (!p.providerSessionId && !isProviderEnabled(await svc.settings.get(), p.provider)) {
        throw new ApiError("bad_params", tr("provider.disabledNamed", { name: catalogById(p.provider)?.name ?? p.provider }));
      }
      const cat = catalogById(p.provider);
      if (!p.providerSessionId && cat && !providerCreatable(cat.status)) {
        throw new ApiError("bad_params", tr("provider.plannedNamed", { name: cat.name }));
      }
      // B8: the default permission mode is mapped onto this Agent's own modes (same rule as thread.setProvider)
      const provider = getProvider(p.provider);
      // 1.3 (#727 review 3): a pre-1.3 default of 全部放行 stays 每次询问 for Agents it did nothing for in 1.2 (told once)
      const guard = await guardLegacyMode(svc.settings, p.provider, clampMode(provider?.capabilities.modes ?? [], p.mode));
      const mode = guard.mode;
      const meta = await svc.threads.create({ ...p, mode });
      if (guard.notice) await svc.threads.appendEvent(meta.id, upgradeNotice());
      gw.publish("sidebar", { type: "thread.upsert", thread: meta });
      return meta;
    }
  ));

  gw.method("threads.get", wrap(
    z.object({ id: z.string(), afterSeq: z.number().int().nonnegative().optional() }),
    async (p) => {
      const meta = await svc.threads.get(p.id);
      if (!meta) throw new ApiError("not_found", tr("err.threadMissing"));
      const events = await svc.threads.readEvents(p.id, p.afterSeq ?? 0, 5000);
      const rt = svc.runtime?.(p.id) ?? null;
      return {
        meta,
        events,
        queue: rt?.queue ?? [],
        pending: rt?.pending ?? [],
        runtimeStatus: rt?.status ?? meta.status,
      };
    }
  ));

  gw.method("threads.update", wrap(
    z.object({
      id: z.string(),
      title: z.string().optional(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
      previewUrl: z.string().max(MAX_PREVIEW_URL).nullable().optional(),
    }),
    async (p) => {
      const meta = await svc.threads.get(p.id);
      if (!meta) throw new ApiError("not_found", tr("err.threadMissing"));
      const patch: Record<string, unknown> = {};
      if (p.title !== undefined) {
        patch.title = p.title.trim() || meta.title;
        patch.titleAuto = false; // Once renamed by hand, never auto-overwrite
      }
      if (p.pinned !== undefined) patch.pinned = p.pinned;
      if (p.archived !== undefined) patch.archived = p.archived;
      if (p.previewUrl !== undefined) {
        // Only a loopback URL is remembered (normalized); null clears it
        if (p.previewUrl === null) patch.previewUrl = null;
        else {
          const c = checkPreviewUrl(p.previewUrl);
          if (!c.ok) throw new ApiError("bad_params", tr("err.previewUrl"));
          patch.previewUrl = c.target.href;
        }
      }
      const next = await svc.threads.patch(p.id, patch);
      gw.publish("sidebar", { type: "thread.upsert", thread: next });
      return next;
    }
  ));

  gw.method("threads.delete", wrap(z.object({ id: z.string() }), async (p) => {
    const meta = await svc.threads.get(p.id);
    if (!meta) throw new ApiError("not_found", tr("err.threadMissing"));
    if (svc.manager) await svc.manager.deleteThread(p.id);
    else await svc.threads.delete(p.id);
    gw.publish("sidebar", { type: "thread.remove", id: p.id });
    return { ok: true };
  }));

  // ---- git.* (§5.8) ----
  const projectPath = async (projectId: string): Promise<string> => {
    const proj = await svc.projects.get(projectId);
    if (!proj) throw new ApiError("not_found", tr("err.projectMissing"));
    if (!existsSync(proj.path)) throw new ApiError("bad_path", tr("err.projectDirGone"));
    return proj.path;
  };

  gw.method("git.status", wrap(z.object({ projectId: z.string() }), async (p) =>
    svc.git.status(await projectPath(p.projectId))
  ));

  gw.method("git.diff", wrap(z.object({ projectId: z.string(), path: z.string() }), async (p) =>
    svc.git.diff(await projectPath(p.projectId), p.path)
  ));

  gw.method("git.discard", wrap(z.object({ projectId: z.string(), path: z.string() }), async (p) =>
    svc.git.discard(await projectPath(p.projectId), p.path, svc.cfg.dataDir)
  ));

  // ---- files.* (§5.9) ----
  gw.method("files.tree", wrap(z.object({ projectId: z.string(), dir: z.string().default(".") }), async (p) =>
    svc.files.tree(await projectPath(p.projectId), p.dir)
  ));

  gw.method("files.read", wrap(z.object({ projectId: z.string(), path: z.string() }), async (p) =>
    svc.files.read(await projectPath(p.projectId), p.path)
  ));

  // ---- history.* (§7.6) ----
  gw.method("history.list", wrap(z.object({ projectId: z.string() }), async (p) => {
    const proj = await svc.projects.get(p.projectId);
    if (!proj) throw new ApiError("not_found", tr("err.projectMissing"));
    const imported = new Set(
      (await svc.threads.list())
        .filter((t) => t.projectId === p.projectId && t.providerSessionId)
        .map((t) => t.providerSessionId),
    );
    const out: unknown[] = [];
    for (const provider of listProviders()) {
      if (!provider.listHistory) continue;
      const items = await provider.listHistory(proj.path).catch(() => []);
      for (const i of items) out.push({ ...i, imported: imported.has(i.sessionId) });
    }
    return out;
  }));

  gw.method("history.import", wrap(
    z.object({
      projectId: z.string(),
      items: z.array(z.object({ provider: z.string(), sessionId: z.string(), title: z.string().optional() })).min(1).max(20),
    }),
    async (p) => {
      const proj = await svc.projects.get(p.projectId);
      if (!proj) throw new ApiError("not_found", tr("err.projectMissing"));
      const metas = [];
      for (const item of p.items) {
        const provider = getProvider(item.provider);
        if (!provider?.readHistory) continue;
        // Idempotent: reuse if the same providerSessionId was already imported
        const existing = (await svc.threads.list()).find(
          (t) => t.projectId === p.projectId && t.provider === item.provider && t.providerSessionId === item.sessionId,
        );
        if (existing) { metas.push(existing); continue; }
        const meta = await svc.threads.create({
          projectId: p.projectId,
          provider: item.provider,
          title: item.title,
          providerSessionId: item.sessionId,
          importedFrom: { provider: item.provider, sessionId: item.sessionId },
        });
        const events = await provider.readHistory(item.sessionId, proj.path).catch(() => []);
        for (const ev of events) {
          await svc.threads.appendEvent(meta.id, ev as Parameters<typeof svc.threads.appendEvent>[1]);
        }
        await svc.threads.patch(meta.id, { status: "closed" });
        gw.publish("sidebar", { type: "thread.upsert", thread: await svc.threads.get(meta.id) });
        metas.push(await svc.threads.get(meta.id));
      }
      return metas;
    }
  ));

  // ---- terminal.* (§7.5) ----
  gw.method("terminal.list", wrap(z.object({ projectId: z.string().optional() }).passthrough().optional(), (p) =>
    svc.terminals.list(p?.projectId)
  ));

  gw.method("terminal.create", wrap(
    z.object({ projectId: z.string(), cols: z.number().int().min(20).max(500).default(80), rows: z.number().int().min(5).max(200).default(24) }),
    async (p) => {
      const path = await projectPath(p.projectId);
      const r = await svc.terminals.create(p.projectId, path, p.cols, p.rows);
      if ("error" in r) throw new ApiError("bad_params", r.error);
      return r;
    }
  ));

  gw.method("terminal.attach", wrap(z.object({ id: z.string() }), async (p, ctx) => {
    const r = svc.terminals.attach(p.id);
    if (r.error || r.index == null) throw new ApiError("not_found", r.error ?? tr("err.terminalMissing"));
    // attach also subscribes to the terminal:<index> channel (input frames are gated on that subscription too)
    svc.gateway.subscribe(ctx.conn, `terminal:${r.index}`);
    return r;
  }));

  gw.method("terminal.resize", wrap(z.object({ id: z.string(), cols: z.number().int(), rows: z.number().int() }), (p) =>
    svc.terminals.resize(p.id, p.cols, p.rows)
  ));

  gw.method("terminal.kill", wrap(z.object({ id: z.string() }), (p) => svc.terminals.kill(p.id)));

  // ---- thread.* (runtime operations, need the manager) ----
  const needManager = () => {
    if (!svc.manager) throw new ApiError("unavailable", tr("err.noManager"));
    return svc.manager;
  };

  gw.method("thread.send", wrap(
    z.object({
      id: z.string(),
      text: z.string(),
      attachments: z.array(z.object({ path: z.string(), mime: z.string(), name: z.string().optional() })).optional(),
      // 1.2: paths dragged from the Files panel, relative to the project (the daemon resolves and checks them)
      mentions: z.array(z.object({ rel: z.string().min(1).max(4096), isDir: z.boolean().optional() })).max(MAX_MENTIONS).optional(),
      behavior: z.enum(["queue", "steer"]).optional(),
      // 1.3: the page's id for its optimistic bubble, echoed on the user_message event (dedupe, no jump)
      clientId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    }),
    async (p) => {
      // delivered tells the composer what happened: a steer an Agent can't take is queued (B7)
      const delivered = await needManager().send(p.id, { text: p.text, attachments: p.attachments, mentions: p.mentions, clientId: p.clientId }, p.behavior ?? "queue");
      return { ok: true, delivered: delivered ?? "started" };
    }
  ));

  // The composer's queue list has a remove button; it used to call a method that didn't exist
  gw.method("thread.queueRemove", wrap(z.object({ id: z.string(), queueId: z.string() }), async (p) => {
    return { ok: needManager().removeQueued(p.id, p.queueId) };
  }));

  gw.method("thread.interrupt", wrap(z.object({ id: z.string() }), async (p) => {
    await needManager().interrupt(p.id);
    return { ok: true };
  }));

  gw.method("thread.respond", wrap(
    z.object({
      id: z.string(),
      requestId: z.string(),
      optionId: z.string().optional(),
      answers: z.record(z.string(), z.string()).optional(),
      cancelled: z.boolean().optional(),
    }),
    async (p) => {
      await needManager().respond(p.id, p.requestId, { optionId: p.optionId, answers: p.answers, cancelled: p.cancelled });
      return { ok: true };
    }
  ));

  gw.method("thread.setModel", wrap(z.object({ id: z.string(), model: z.string().nullable() }), async (p) => {
    await needManager().setModel(p.id, p.model);
    return { ok: true };
  }));

  gw.method("thread.setMode", wrap(z.object({ id: z.string(), mode: threadModeSchema }), async (p) => {
    await needManager().setMode(p.id, p.mode);
    return { ok: true };
  }));

  gw.method("thread.setEffort", wrap(z.object({ id: z.string(), effort: z.string().nullable() }), async (p) => {
    await needManager().setEffort(p.id, p.effort);
    return { ok: true };
  }));

  gw.method("thread.commands", wrap(z.object({ id: z.string(), load: z.boolean().optional() }), async (p) => {
    const commands = await needManager().listCommands(p.id, { load: p.load });
    return { commands };
  }));

  gw.method("thread.setCursorOpts", wrap(
    z.object({
      id: z.string(),
      cursorFast: z.boolean().optional(),
      cursorAutoReview: z.boolean().optional(),
    }),
    async (p) => {
      await needManager().setCursorOpts(p.id, {
        cursorFast: p.cursorFast,
        cursorAutoReview: p.cursorAutoReview,
      });
      return { ok: true };
    },
  ));

  gw.method("thread.setProvider", wrap(z.object({ id: z.string(), provider: z.string().min(1) }), async (p) => {
    await needManager().setProvider(p.id, p.provider);
    return { ok: true };
  }));

  gw.method("thread.close", wrap(z.object({ id: z.string() }), async (p) => {
    await needManager().close(p.id);
    return { ok: true };
  }));

  // ---- thread.exportMarkdown (P2-7): persisted events → Markdown text ----
  gw.method("thread.exportMarkdown", wrap(z.object({ id: z.string() }), async (p) => {
    const meta = await svc.threads.get(p.id);
    if (!meta) throw new ApiError("not_found", tr("err.threadMissing"));
    const events = await svc.threads.readEvents(p.id, 0, 20000);
    const L: string[] = [];
    L.push(`# ${meta.title}`, "");
    L.push(`> ${meta.provider} · ${meta.model ?? tr("export.defaultModel")} · ${meta.mode} · ${new Date(meta.createdAt).toLocaleString(intlLocale())}`, "");
    for (const e of events) {
      switch (e.type) {
        case "user_message": {
          const refs = e.mentions?.length ? "\n\n" + e.mentions.map((m) => `- \`${m.path}${m.isDir ? "/" : ""}\``).join("\n") : "";
          L.push(`**${tr("export.me")}**${e.steered ? tr("export.steered") : ""}:\n\n${e.text}${refs}`, "");
          break;
        }
        case "assistant_message": L.push(e.text, ""); break;
        case "reasoning": L.push(`<details><summary>${tr("export.reasoning")}</summary>\n\n${e.text}\n</details>`, ""); break;
        case "tool_call": {
          const icon = e.status === "ok" ? "✓" : e.status === "failed" ? "✗" : "…";
          L.push(`- \`${e.kind}\` ${icon} ${e.title}${e.output ? `\n  \`\`\`\n  ${e.output.slice(0, 2000)}\n  \`\`\`` : ""}`);
          break;
        }
        case "plan": L.push(`### ${tr("export.plan")}\n\n` + e.markdown, ""); break;
        case "todo": L.push(`### ${tr("export.todo")}\n\n` + e.items.map((i) => `- [${i.status === "done" || i.status === "completed" ? "x" : " "}] ${i.text}`).join("\n"), ""); break;
        case "notice": L.push(`_${e.message}_`, ""); break;
        case "turn_ended": L.push(`— ${e.status}${e.durationMs ? ` · ${Math.round(e.durationMs / 1000)}s` : ""}${e.error ? ` · ${e.error}` : ""} —`, ""); break;
        default: break;
      }
    }
    const markdown = L.join("\n");
    const safe = meta.title.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "thread";
    const filename = `${safe}.md`;
    // ~/Downloads when it can be used, else <data>/exports (B21); the file is revealed with execFile (no shell)
    let dir = join(homedir(), "Downloads");
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      dir = join(svc.cfg.dataDir, "exports");
      await mkdir(dir, { recursive: true });
    }
    let dest = join(dir, filename);
    if (existsSync(dest)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      dest = join(dir, `${safe}-${stamp}.md`);
    }
    await writeFile(dest, markdown, "utf8");
    revealInFileManager(dest);
    return { markdown, filename, path: dest };
  }));
}

function revealInFileManager(filePath: string): void {
  if (process.platform === "win32") {
    execFile("explorer.exe", ["/select," + win32Path.normalize(filePath)], { windowsHide: true }, () => {}).on("error", () => {});
    return;
  }
  if (process.platform === "darwin") {
    execFile("open", ["-R", filePath], () => {}).on("error", () => {});
    return;
  }
  execFile("xdg-open", [dirname(filePath)], () => {}).on("error", () => {});
}
