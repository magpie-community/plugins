// settings.json: defaults per EXEC §5.6; unknown fields are preserved on read.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../util/atomic.js";

export type Settings = {
  defaultProvider: string;
  defaultMode: "plan" | "default" | "acceptEdits" | "bypassPermissions" | "ask";
  defaultEffort: string | null;
  sendKey: "enter" | "ctrlEnter";
  runningSend: "queue" | "steer";
  showThinking: boolean;
  density: "comfortable" | "compact";
  theme: "auto" | "light" | "dark";
  idleCloseMinutes: number;
  idleExitMinutes: number;
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
  defaultEffort: null,
  sendKey: "enter",
  runningSend: "queue",
  showThinking: true,
  density: "comfortable",
  theme: "auto",
  idleCloseMinutes: 30,
  idleExitMinutes: 60,
  collapsedProjects: [],
  panel: { open: false, tab: "changes", width: 440 },
  sidebarWidth: 248,
  lastProjectId: null,
  lastThreadId: null,
  recentDirs: [],
};

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
