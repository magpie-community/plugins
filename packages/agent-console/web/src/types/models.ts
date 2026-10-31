// Data models aligned with daemon §5.5 (read-only types on the frontend side).
export type Project = { id: string; name: string; path: string; createdAt: number };

export type Mode = "plan" | "default" | "acceptEdits" | "bypassPermissions" | "ask";
export type ThreadStatus = "initializing" | "idle" | "running" | "error" | "closed";

export type ThreadMeta = {
  id: string; projectId: string; title: string; titleAuto: boolean;
  provider: string; model: string | null; mode: Mode;
  effort: string | null; providerSessionId: string | null;
  status: ThreadStatus;
  pinned: boolean; archived: boolean; createdAt: number; updatedAt: number;
  lastTurnStatus: "completed" | "interrupted" | "failed" | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };
  importedFrom?: { provider: string; sessionId: string };
  seq: number;
  cursorFast?: boolean;
  cursorAutoReview?: boolean;
};

export type Capabilities = {
  resume: boolean; interrupt: boolean; steer: boolean; images: boolean;
  plan: boolean; questions: boolean; cost: boolean;
  effort: string[]; modes: Mode[];
  /** each mode's original name in this Agent (Copilot: Agent / Plan / Allow All, etc.) */
  modeLabels?: Partial<Record<Mode, string>>;
};
export type ThinkingOption = { id: string; label: string };

export type ModelInfo = {
  id: string; name: string; efforts?: string[];
  thinkingOptions?: ThinkingOption[];
  defaultThinking?: string | null;
  isDefault?: boolean;
};

export type ProviderStatus = "verified" | "experimental" | "planned";

export type ProviderInfo = {
  id: string; name: string; available: boolean; enabled?: boolean;
  status?: ProviderStatus;
  /** @deprecated use status === verified */
  ready?: boolean;
  bin?: string; version?: string; reason?: string; installHint?: string;
  capabilities: Capabilities;
  models: ModelInfo[];
};

// sidebar channel events
export type SidebarEvt =
  | { type: "project.upsert"; project: Project }
  | { type: "project.remove"; id: string }
  | { type: "thread.upsert"; thread: ThreadMeta }
  | { type: "thread.remove"; id: string };
