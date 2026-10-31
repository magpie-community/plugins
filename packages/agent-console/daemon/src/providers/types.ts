// Provider / ProviderSession interfaces (EXEC §7.1)
import type { ProviderEvent } from "../timeline/types.js";
import type { SlashCommand } from "./slash.js";

export type Mode = "plan" | "default" | "acceptEdits" | "bypassPermissions" | "ask";

export type Capabilities = {
  resume: boolean;
  interrupt: boolean;
  steer: boolean;
  /** The Agent takes images in a prompt (sees them itself). For ACP Agents: what initialize advertised, false until known */
  images: boolean;
  /** false while an ACP Agent's image support is not known yet (before its probe or first session); absent = known */
  imagesKnown?: boolean;
  plan: boolean;
  questions: boolean;
  cost: boolean;
  effort: string[];
  modes: Mode[];
  /** Each mode's name in this Agent (like Paseo, show the Agent's own naming); our default names are used when absent */
  modeLabels?: Partial<Record<Mode, string>>;
};

export type ThinkingOption = { id: string; label: string };

export type ModelInfo = {
  id: string;
  name: string;
  /** @deprecated use thinkingOptions */
  efforts?: string[];
  thinkingOptions?: ThinkingOption[];
  defaultThinking?: string | null;
  isDefault?: boolean;
  /** Parameter name when the level is sent as a model parameter (Cursor: effort / reasoning_effort / reasoning) */
  thinkingParam?: string;
};
export type DetectResult = { available: boolean; bin?: string; version?: string; reason?: string; installHint?: string };
export type HistoryItem = { provider: string; sessionId: string; title: string; updatedAt: number; messageCount: number; imported: boolean };
export type SendInput = { text: string; images: { path: string; mime: string }[] };
export type RespondAnswer = { optionId?: string; answers?: Record<string, string>; cancelled?: boolean };

export interface Provider {
  id: string;
  name: string;
  capabilities: Capabilities;
  detect(): Promise<DetectResult>;
  listModels(): Promise<ModelInfo[]>;
  createSession(o: {
    threadId: string;
    cwd: string;
    model: string | null;
    mode: Mode;
    effort: string | null;
    resumeId: string | null;
    cursorFast?: boolean;
    cursorAutoReview?: boolean;
    launch?: { cmd: string; prefixArgs: string[] };
  }): Promise<ProviderSession>;
  listHistory?(cwd: string): Promise<HistoryItem[]>;
  readHistory?(sessionId: string, cwd: string): Promise<ProviderEvent[]>;
}

export interface ProviderSession {
  events: AsyncIterable<ProviderEvent>;
  send(input: SendInput): Promise<void>;
  steer?(input: SendInput): Promise<void>;
  interrupt(): Promise<void>;
  setModel(model: string | null): Promise<void>;
  setMode(mode: Mode): Promise<void>;
  setEffort(effort: string | null): Promise<void>;
  respond(requestId: string, answer: RespondAnswer): void;
  close(): Promise<void>;
  listCommands(): Promise<SlashCommand[]>;
}

export type { SlashCommand, SlashCommandKind } from "./slash.js";
