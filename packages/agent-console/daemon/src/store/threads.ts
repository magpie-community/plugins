// threads/<id>/meta.json + timeline.jsonl: list, read, append, delete (moved to trash)
import { mkdir, rename, readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeJsonAtomic } from "../util/atomic.js";
import { readJsonl, appendJsonl } from "../util/jsonl.js";
import { validId } from "../util/paths.js";
import { ApiError } from "../ws/methods.js";
import { tr } from "../util/i18n.js";
import type { Mode } from "../timeline/types.js";
import type { TimelineEvent } from "../timeline/types.js";

export type ThreadMeta = {
  id: string;
  projectId: string;
  title: string;
  titleAuto: boolean;
  provider: string;
  model: string | null;
  mode: Mode;
  effort: string | null;
  providerSessionId: string | null;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  lastTurnStatus: "completed" | "interrupted" | "failed" | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };
  importedFrom?: { provider: string; sessionId: string };
  seq: number;
  /** Cursor Agent: lightning Fast mode (model parameter fast=true) */
  cursorFast?: boolean;
  /** Cursor Agent: Auto-review, the client auto-approves safe tool permissions */
  cursorAutoReview?: boolean;
};

export type { Mode };

function newId(): string {
  return "t_" + Date.now().toString(36) + randomBytes(3).toString("hex");
}

export class ThreadsStore {
  private dir: string;
  private trashDir: string;
  private metas = new Map<string, ThreadMeta>();
  private loaded = false;
  // Serialize meta writes: concurrent patch/appendEvent would overwrite each other (setStatus/patch/provider_session_id run concurrently in the manager)
  private writeQ: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.writeQ.then(fn, fn);
    this.writeQ = p.catch(() => {});
    return p;
  }
  constructor(dataDir: string) {
    this.dir = join(dataDir, "threads");
    this.trashDir = join(dataDir, "trash", "threads");
  }

  private tdir(id: string): string {
    return join(this.dir, id);
  }
  private metaPath(id: string): string {
    return join(this.tdir(id), "meta.json");
  }
  private timelinePath(id: string): string {
    return join(this.tdir(id), "timeline.jsonl");
  }

  private async loadAll(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let ids: string[] = [];
    try {
      ids = (await readdir(this.dir)).filter((d) => validId(d));
    } catch {
      return;
    }
    for (const id of ids) {
      try {
        const m = JSON.parse(await readFile(this.metaPath(id), "utf8")) as ThreadMeta;
        if (m && typeof m.id === "string") this.metas.set(m.id, m);
      } catch {}
    }
  }

  async list(): Promise<ThreadMeta[]> {
    await this.loadAll();
    return [...this.metas.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<ThreadMeta | null> {
    if (!validId(id)) return null;
    await this.loadAll();
    return this.metas.get(id) ?? null;
  }

  private async saveMeta(meta: ThreadMeta): Promise<void> {
    this.metas.set(meta.id, meta);
    await writeJsonAtomic(this.metaPath(meta.id), meta);
  }

  async create(o: {
    projectId: string;
    provider: string;
    model?: string | null;
    mode?: Mode;
    effort?: string | null;
    title?: string;
    providerSessionId?: string | null;
    importedFrom?: { provider: string; sessionId: string };
  }): Promise<ThreadMeta> {
    const now = Date.now();
    const meta: ThreadMeta = {
      id: newId(),
      projectId: o.projectId,
      title: o.title ?? tr("thread.defaultTitle"),
      titleAuto: o.title == null,
      provider: o.provider,
      model: o.model ?? null,
      mode: o.mode ?? "default",
      effort: o.effort ?? null,
      providerSessionId: o.providerSessionId ?? null,
      status: "idle",
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
      lastTurnStatus: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
      importedFrom: o.importedFrom,
      seq: 0,
    };
    try {
      await mkdir(this.tdir(meta.id), { recursive: true });
    } catch (e) {
      throw new ApiError("io_error", `创建对话目录失败：${(e as Error)?.message ?? e}`);
    }
    await this.saveMeta(meta);
    return meta;
  }

  async patch(id: string, patch: Partial<ThreadMeta>): Promise<ThreadMeta> {
    return this.serial(async () => {
      const meta = await this.get(id);
      if (!meta) throw new ApiError("not_found", "对话不存在");
      if (patch.title !== undefined && patch.titleAuto === undefined) patch = { ...patch, titleAuto: false };
      const next = { ...meta, ...patch, id: meta.id, updatedAt: Date.now() };
      await this.saveMeta(next);
      return next;
    });
  }

  // Append an event: inside the serialized section take meta.seq+1 as seq, write the jsonl and update meta.
  // A passed-in seq is ignored (keeps it strictly increasing); ts/threadId are filled in when missing.
  async appendEvent(id: string, ev: Record<string, unknown> & { type: TimelineEvent["type"] }): Promise<TimelineEvent> {
    return this.serial(async () => {
      const meta = await this.get(id);
      if (!meta) throw new ApiError("not_found", "对话不存在");
      const full = {
        ...ev,
        seq: meta.seq + 1,
        ts: ev.ts ?? Date.now(),
        threadId: id,
      } as TimelineEvent;
      await appendJsonl(this.timelinePath(id), full);
      meta.seq = full.seq;
      meta.updatedAt = Date.now();
      this.metas.set(id, meta);
      await writeJsonAtomic(this.metaPath(id), meta);
      return full;
    });
  }

  async readEvents(id: string, afterSeq = 0, limit = 5000): Promise<TimelineEvent[]> {
    const rows = await readJsonl<TimelineEvent>(this.timelinePath(id));
    const out = rows.filter((e) => typeof e.seq === "number" && e.seq > afterSeq);
    return out.slice(-limit);
  }

  async delete(id: string): Promise<void> {
    const meta = await this.get(id);
    if (!meta) return;
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    await mkdir(this.trashDir, { recursive: true });
    // Windows: an Agent process / file handle just closed may not be released yet, so renaming the directory briefly fails with EPERM/EBUSY → retry with backoff
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(this.tdir(id), join(this.trashDir, `${id}-${stamp}`));
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 8) {
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }
        throw new ApiError("internal", "移入回收目录失败：" + String(e));
      }
    }
    this.metas.delete(id);
  }
}
