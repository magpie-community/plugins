// settings.json: defaults per EXEC §5.6; unknown fields are preserved on read.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../util/atomic.js";

export type Settings = {
  defaultProvider: string;
  defaultMode: "plan" | "default" | "acceptEdits" | "bypassPermissions" | "ask";
  sendKey: "enter" | "ctrlEnter";
  runningSend: "queue" | "steer";
  showThinking: boolean;
  theme: "auto" | "light" | "dark";
  idleCloseMinutes: number;
  collapsedProjects: string[];
  panel: { open: boolean; tab: string; width: number };
  sidebarWidth: number;
  lastProjectId: string | null;
  lastThreadId: string | null;
  recentDirs?: string[];
  v1Migrated?: boolean;
  /** false = turned off by the user in settings; absent means on */
  providerEnabled?: Record<string, boolean>;
  /** Advanced: override how a Provider is launched (executable + args array, no shell) */
  providerCommand?: Record<string, { executable?: string; args?: string[] }>;
  [k: string]: unknown;
};

export const DEFAULT_SETTINGS: Settings = {
  defaultProvider: "claude",
  defaultMode: "default",
  sendKey: "enter",
  runningSend: "queue",
  showThinking: true,
  theme: "auto",
  idleCloseMinutes: 30,
  collapsedProjects: [],
  panel: { open: false, tab: "changes", width: 440 },
  sidebarWidth: 248,
  lastProjectId: null,
  lastThreadId: null,
  recentDirs: [],
};

export const IDLE_CLOSE_MIN = 5;
export const IDLE_CLOSE_MAX = 240;

const mode = z.enum(["plan", "default", "acceptEdits", "bypassPermissions", "ask"]);
const id = z.string().min(1).max(200);
/** B18: what settings.set accepts. Every key the UI writes is listed; anything else or a wrong type is refused. */
export const settingsPatchSchema = z
  .object({
    defaultProvider: z.string().min(1).max(64),
    defaultMode: mode,
    sendKey: z.enum(["enter", "ctrlEnter"]),
    runningSend: z.enum(["queue", "steer"]),
    showThinking: z.boolean(),
    // auto = follow the host: Magpie's light/dark inside Magpie, the OS outside it
    theme: z.enum(["auto", "light", "dark"]),
    idleCloseMinutes: z.number().int().min(IDLE_CLOSE_MIN).max(IDLE_CLOSE_MAX),
    collapsedProjects: z.array(id).max(1000),
    panel: z.object({ open: z.boolean(), tab: z.string().max(40), width: z.number().min(0).max(5000) }).partial(),
    sidebarWidth: z.number().min(0).max(5000),
    lastProjectId: id.nullable(),
    lastThreadId: id.nullable(),
    recentDirs: z.array(z.string().max(4096)).max(50),
    providerEnabled: z.record(z.string().max(64), z.boolean()),
    providerCommand: z.record(
      z.string().max(64),
      z.object({ executable: z.string().max(4096).optional(), args: z.array(z.string().max(4096)).max(64).optional() }).strict(),
    ),
    v1Migrated: z.boolean(),
  })
  .partial()
  .strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** Validate a patch from the page; returns the parsed patch or a readable error. */
export function parseSettingsPatch(patch: unknown): { ok: true; patch: SettingsPatch } | { ok: false; error: string } {
  const r = settingsPatchSchema.safeParse(patch);
  if (r.success) return { ok: true, patch: r.data };
  return {
    ok: false,
    error: r.error.issues.map((i) => `${i.path.join(".") || "(patch)"}: ${i.message}`).join("; "),
  };
}

/** Values in settings.json that have the wrong type (hand edits, older builds) fall back to the default; unknown keys are kept. */
export function sanitizeStored(raw: Record<string, unknown>): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const shape = settingsPatchSchema.shape as Record<string, z.ZodType>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const field = shape[k];
    if (field && k !== "idleCloseMinutes" && !field.safeParse(v).success) continue;
    if (k === "idleCloseMinutes") {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      out[k] = Math.min(IDLE_CLOSE_MAX, Math.max(IDLE_CLOSE_MIN, Math.round(n)));
      continue;
    }
    out[k] = v;
  }
  return out;
}

export class SettingsStore {
  private file: string;
  private cache: Settings | null = null;
  private writing: Promise<void> = Promise.resolve();
  constructor(dataDir: string) {
    this.file = join(dataDir, "settings.json");
  }
  async get(): Promise<Settings> {
    if (this.cache) return this.cache;
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(await readFile(this.file, "utf8"));
    } catch {}
    raw = sanitizeStored(raw);
    this.cache = { ...DEFAULT_SETTINGS, ...raw, panel: { ...DEFAULT_SETTINGS.panel, ...(raw.panel as object | undefined) } };
    return this.cache;
  }
  async set(patch: Partial<Settings>): Promise<Settings> {
    const cur = await this.get();
    const next = { ...cur, ...patch, panel: { ...cur.panel, ...(patch.panel as object | undefined) } };
    this.cache = next;
    const snap = next;
    this.writing = this.writing.then(() => writeJsonAtomic(this.file, snap));
    await this.writing;
    return next;
  }
}
