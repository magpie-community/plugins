// Legacy data migration (§10.1): runs once when the daemon starts.
// Old: sessions/<id>/{meta.json,events.jsonl} + projects in settings.json →
// New: projects.json + threads/<id>/{meta.json,timeline.jsonl}. Old files are read-only and copied to trash/legacy-<ts>/ as a backup.
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SettingsStore } from "../store/settings.js";
import type { ProjectsStore } from "../store/projects.js";
import type { ThreadsStore, ThreadMeta } from "../store/threads.js";
import type { Mode, TimelineEvent } from "../timeline/types.js";
import { appendJsonl } from "../util/jsonl.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { validId } from "../util/paths.js";
import { log } from "../log.js";

type OldMeta = {
  id: string; agent: string; cwd: string; model: string; permission: string;
  title: string; titleAuto: boolean; pinned: boolean; cliSessionId: string | null;
  created: number; updated: number; lastStatus?: string; totalCost?: number; totalUsage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | null;
};
type OldEvt = Record<string, unknown> & { type: string; seq?: number; ts?: number };

const SKIP_TITLE = /^\/(slow|deny|error|long|codex)/;
const MODE_MAP: Record<string, Mode> = {
  plan: "plan", default: "default", acceptEdits: "acceptEdits", bypassPermissions: "bypassPermissions",
  auto: "acceptEdits", full: "bypassPermissions",
};
const belongsTo = (cwd: string, parent: string) => {
  const c = cwd.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  const p = parent.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  return c === p || c.startsWith(p + "/");
};

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export async function migrateLegacy(dataDir: string, stores: {
  settings: SettingsStore; projects: ProjectsStore; threads: ThreadsStore;
}): Promise<{ migrated: number; skipped: boolean }> {
  const settings = await stores.settings.get();
  if (settings.v1Migrated) return { migrated: 0, skipped: true };
  const oldDir = join(dataDir, "sessions");
  const oldSettingsPath = join(dataDir, "settings.json");
  if (!existsSync(oldDir) && !existsSync(oldSettingsPath)) {
    await stores.settings.set({ v1Migrated: true });
    return { migrated: 0, skipped: true };
  }

  // 1. Backup
  const backup = join(dataDir, "trash", `legacy-${stamp()}`);
  await mkdir(backup, { recursive: true });
  if (existsSync(oldDir)) await cp(oldDir, join(backup, "sessions"), { recursive: true }).catch(() => {});
  if (existsSync(oldSettingsPath)) await cp(oldSettingsPath, join(backup, "settings.json")).catch(() => {});

  // Read the old settings (read the file directly; SettingsStore already loaded the same path, the fields coexist without conflict)
  const oldSettings = existsSync(oldSettingsPath)
    ? (JSON.parse(await readFile(oldSettingsPath, "utf8").catch(() => "{}")) as Record<string, unknown>)
    : {};

  // 2. Projects: old settings.projects → projects.json; orphan cwds are added per the adoptOrphans rule
  const projectIdByPath = new Map<string, string>();
  const lc = (p: string) => p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  for (const p of (oldSettings.projects as { name?: string; path?: string }[] | undefined) ?? []) {
    if (!p?.path) continue;
    try {
      const proj = await stores.projects.create(p.path, p.name);
      projectIdByPath.set(lc(proj.path), proj.id);
    } catch (e) {
      log("warn", "迁移：建项目失败", { path: p.path, err: String(e) });
    }
  }

  // Old session list
  let sessionIds: string[] = [];
  try {
    sessionIds = (await readdir(oldDir)).filter((d) => validId(d) && existsSync(join(oldDir, d, "meta.json")));
  } catch {}
  const metas: OldMeta[] = [];
  for (const id of sessionIds) {
    try {
      const m = JSON.parse(await readFile(join(oldDir, id, "meta.json"), "utf8")) as OldMeta;
      if (m?.cwd) metas.push(m);
    } catch {}
  }
  // Orphan cwd → add a project (subdirectories fold into their parent)
  const extraDirs: string[] = [];
  const projPaths = [...projectIdByPath.keys()];
  for (const m of metas) {
    const covered = projPaths.some((pp) => belongsTo(m.cwd, pp)) || extraDirs.some((d) => belongsTo(m.cwd, d));
    if (covered) continue;
    for (let i = extraDirs.length - 1; i >= 0; i--) if (belongsTo(extraDirs[i], m.cwd)) extraDirs.splice(i, 1);
    extraDirs.push(m.cwd);
  }
  for (const d of extraDirs) {
    if (!existsSync(d)) continue; // Skip directories that no longer exist (same as the old adoptOrphans)
    try {
      const name = d.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? d;
      const proj = await stores.projects.create(d, name);
      projectIdByPath.set(lc(proj.path), proj.id);
      projPaths.push(lc(proj.path));
    } catch (e) {
      log("warn", "迁移：补建孤儿项目失败", { path: d, err: String(e) });
    }
  }

  const projectOf = (cwd: string): string | null => {
    const l = lc(cwd);
    // Take the longest match (a subdirectory joins the most specific project)
    let best: string | null = null;
    for (const [pp, id] of projectIdByPath) {
      if (belongsTo(l, pp) && (best == null || pp.length > best.length)) best = pp;
    }
    return best ? projectIdByPath.get(best)! : null;
  };

  // 3. Sessions
  let migrated = 0;
  const threadsDir = join(dataDir, "threads");
  for (const m of metas) {
    try {
      const projectId = projectOf(m.cwd);
      if (!projectId) { log("warn", "迁移：无项目可归，跳过", { id: m.id, cwd: m.cwd }); continue; }
      const testTitle = SKIP_TITLE.test(m.title ?? "") || m.title === "默认剧本演示";
      const provider = m.agent === "claude" || m.agent === "codex" ? m.agent : "mock";
      const archived = testTitle || (m.agent !== "claude" && m.agent !== "codex");
      const now = Date.now();
      const meta: ThreadMeta = {
        id: `t_${m.id.replace(/^s?_?/, "")}`.slice(0, 80),
        projectId,
        title: m.title || "旧对话",
        titleAuto: false,
        provider,
        model: m.model || null,
        mode: MODE_MAP[m.permission] ?? "default",
        effort: null,
        providerSessionId: m.cliSessionId || null,
        status: "closed",
        pinned: !!m.pinned,
        archived,
        createdAt: m.created || now,
        updatedAt: m.updated || now,
        lastTurnStatus: m.lastStatus === "ok" ? "completed" : m.lastStatus === "error" ? "failed" : null,
        usage: {
          inputTokens: m.totalUsage?.inputTokens ?? 0,
          outputTokens: m.totalUsage?.outputTokens ?? 0,
          cacheReadTokens: m.totalUsage?.cacheReadTokens ?? 0,
          costUsd: m.totalCost ?? 0,
        },
        importedFrom: m.cliSessionId ? { provider, sessionId: m.cliSessionId } : undefined,
        seq: 0,
      };
      const tdir = join(threadsDir, meta.id);
      if (existsSync(tdir)) meta.id = `t_${m.id}_v1`.slice(0, 80);
      await mkdir(join(threadsDir, meta.id), { recursive: true });

      // Event mapping
      const oldEvts = (await readFile(join(oldDir, m.id, "events.jsonl"), "utf8").catch(() => ""))
        .split("\n").filter((l) => l.trim())
        .map((l) => { try { return JSON.parse(l) as OldEvt; } catch { return null; } })
        .filter((x): x is OldEvt => !!x);
      const lines: TimelineEvent[] = [];
      const openTools = new Map<string, { kind: string; title: string; input?: unknown; detail?: unknown }>();
      let seq = 0;
      const push = (ev: Record<string, unknown> & { type: TimelineEvent["type"] }) => {
        seq++;
        lines.push({ ...ev, seq, ts: Date.now(), threadId: meta.id } as TimelineEvent);
      };
      for (const e of oldEvts) {
        switch (e.type) {
          case "user": push({ type: "user_message", text: String(e.text ?? "") }); break;
          case "text": push({ type: "assistant_message", itemId: `lg_${seq}`, text: String(e.text ?? "") }); break;
          case "thinking": push({ type: "reasoning", itemId: `lg_${seq}`, text: String(e.text ?? "") }); break;
          case "tool.call": {
            const key = String(e.itemId ?? e.callId ?? `c${seq}`);
            openTools.set(key, { kind: String(e.kind ?? "other"), title: String(e.title ?? e.kind ?? "工具"), input: e.input, detail: e.detail });
            push({ type: "tool_call", itemId: key, kind: "other", title: String(e.title ?? "工具"), status: "running", input: e.input, detail: e.detail });
            break;
          }
          case "tool.result": {
            const key = String(e.itemId ?? e.callId ?? `c${seq}`);
            const open = openTools.get(key);
            openTools.delete(key);
            push({
              type: "tool_call", itemId: key,
              kind: (open?.kind ?? "other") as import("../timeline/types.js").ToolKind,
              title: open?.title ?? "工具",
              status: e.ok === false || e.error ? "failed" : "ok",
              output: typeof e.output === "string" ? e.output.slice(0, 20000) : undefined,
              detail: open?.detail,
            } as Record<string, unknown> & { type: "tool_call" });
            break;
          }
          case "todo": {
            const items = (e.items as { text?: string; status?: string }[] | undefined) ?? [];
            push({ type: "todo", items: items.map((i) => ({ text: String(i.text ?? ""), status: i.status === "done" ? "done" : i.status === "in_progress" ? "in_progress" : "todo" })) });
            break;
          }
          case "permission.denied": push({ type: "notice", level: "warn", message: `已拒绝：${String(e.title ?? e.kind ?? "")}` }); break;
          case "permission.request": case "permission.resolved": break; // Old permission cards are stale; don't recreate them
          case "notice": push({ type: "notice", level: (e.level as "info" | "warn" | "error") ?? "info", message: String(e.message ?? "") }); break;
          case "run.end": {
            const u = e.usage as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined;
            if (u) push({ type: "usage", turnId: `lg_t${seq}`, inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, cacheReadTokens: u.cacheReadTokens ?? 0, costUsd: (e.costUsd as number) ?? 0 });
            push({ type: "turn_ended", turnId: `lg_t${seq}`, status: e.status === "error" ? "failed" : e.status === "interrupted" ? "interrupted" : "completed", durationMs: (e.ms as number) ?? undefined, error: e.error as string | undefined });
            break;
          }
          case "run.start": break;
          case "init": break;
          default: break;
        }
      }
      // Unclosed tool.call → mark failed
      for (const [key, o] of openTools) {
        seq++;
        lines.push({ type: "tool_call", itemId: key, kind: "other", title: o.title, status: "failed", seq, ts: Date.now(), threadId: meta.id } as TimelineEvent);
      }
      for (const ev of lines) await appendJsonl(join(threadsDir, meta.id, "timeline.jsonl"), ev);
      meta.seq = seq;
      await writeJsonAtomic(join(threadsDir, meta.id, "meta.json"), meta);
      migrated++;
    } catch (e) {
      log("warn", "迁移：会话失败", { id: m.id, err: String(e) });
    }
  }

  // 4. Merge settings (UI preference fields only)
  const patch: Record<string, unknown> = { v1Migrated: true };
  if (typeof oldSettings.theme === "string") patch.theme = oldSettings.theme;
  if (typeof oldSettings.sendKey === "string") patch.sendKey = oldSettings.sendKey;
  if (typeof oldSettings.showThinking === "boolean") patch.showThinking = oldSettings.showThinking;
  if (typeof oldSettings.defaultAgent === "string") patch.defaultProvider = oldSettings.defaultAgent === "claude" || oldSettings.defaultAgent === "codex" ? oldSettings.defaultAgent : "claude";
  if (typeof oldSettings.defaultPermission === "string") patch.defaultMode = MODE_MAP[oldSettings.defaultPermission] ?? "default";
  await stores.settings.set(patch);

  log("info", `旧数据迁移完成：${migrated} 个会话、${projectIdByPath.size} 个项目，备份在 ${backup}`);
  return { migrated, skipped: false };
}
