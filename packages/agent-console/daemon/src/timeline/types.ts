// Unified event types (REQUIREMENTS §6). seq/ts/threadId are filled in by the manager.
export type Mode = "plan" | "default" | "acceptEdits" | "bypassPermissions" | "ask";

export type ToolKind =
  | "read" | "edit" | "write" | "bash" | "search" | "glob"
  | "web" | "task" | "mcp" | "todo" | "other";

export type AttachmentRef = { id: string; name: string; mime: string };

export type PermissionOption = { id: string; label: string; kind: "allow_once" | "allow_always" | "reject_once" };

export type TimelineEvent =
  | { seq: number; ts: number; threadId: string; turnId?: string; type: "user_message"; text: string; attachments?: AttachmentRef[]; steered?: boolean }
  | { seq: number; ts: number; threadId: string; turnId: string; type: "turn_started"; model: string | null; mode: string; effort: string | null }
  | { seq: number; ts: number; threadId: string; turnId?: string; type: "assistant_delta" | "reasoning_delta" | "tool_output_delta"; itemId: string; text: string }
  | { seq: number; ts: number; threadId: string; turnId?: string; type: "assistant_message" | "reasoning"; itemId: string; text: string }
  | { seq: number; ts: number; threadId: string; turnId?: string; type: "tool_call"; itemId: string; kind: ToolKind; title: string; status: "running" | "ok" | "failed"; input?: unknown; detail?: unknown; output?: string; exitCode?: number; durationMs?: number }
  | { seq: number; ts: number; threadId: string; turnId?: string; type: "plan"; itemId: string; markdown: string; entries?: { step: string; status: string }[] }
  | { seq: number; ts: number; threadId: string; turnId?: string; type: "todo"; items: { text: string; status: string }[] }
  | { seq: number; ts: number; threadId: string; turnId?: string; type: "permission_request"; requestId: string; title: string; kind: string; detail?: unknown; options: { id: string; label: string; kind: string }[] }
  | { seq: number; ts: number; threadId: string; turnId?: string; type: "permission_resolved"; requestId: string; optionId?: string; cancelled?: boolean }
  | { seq: number; ts: number; threadId: string; turnId?: string; type: "question"; requestId: string; questions: unknown[] }
  | { seq: number; ts: number; threadId: string; turnId?: string; type: "question_answered"; requestId: string; answers: Record<string, string> }
  | { seq: number; ts: number; threadId: string; turnId?: string; type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number; contextWindow?: number }
  | { seq: number; ts: number; threadId: string; turnId?: string; type: "notice"; level: "info" | "warn" | "error"; message: string }
  | { seq: number; ts: number; threadId: string; turnId: string; type: "turn_ended"; status: "completed" | "interrupted" | "failed"; durationMs?: number; error?: string; filesChanged?: number }
  | { seq: number; ts: number; threadId: string; turnId?: string; type: "status"; status: string };

// Provider-side events: no seq/ts/threadId (filled in by the manager), plus the internal provider_session_id event
// user_message only appears when importing history (in the normal message flow the manager writes user_message itself)
export type ProviderEvent =
  | { type: "provider_session_id"; id: string }
  | { type: "user_message"; text: string; steered?: boolean }
  | { type: "turn_started"; turnId: string; model: string | null; mode: string; effort: string | null }
  | { type: "assistant_delta" | "reasoning_delta" | "tool_output_delta"; itemId: string; text: string }
  | { type: "assistant_message" | "reasoning"; itemId: string; text: string }
  | { type: "tool_call"; itemId: string; kind: string; title: string; status: "running" | "ok" | "failed"; input?: unknown; detail?: unknown; output?: string; exitCode?: number; durationMs?: number }
  | { type: "plan"; itemId: string; markdown: string; entries?: { step: string; status: string }[] }
  | { type: "todo"; items: { text: string; status: string }[] }
  | { type: "permission_request"; requestId: string; title: string; kind: string; detail?: unknown; options: { id: string; label: string; kind: string }[] }
  | { type: "permission_resolved"; requestId: string; optionId?: string; cancelled?: boolean }
  | { type: "question"; requestId: string; questions: unknown[] }
  | { type: "question_answered"; requestId: string; answers: Record<string, string> }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number; contextWindow?: number }
  | { type: "notice"; level: "info" | "warn" | "error"; message: string }
  | { type: "turn_ended"; turnId: string; status: "completed" | "interrupted" | "failed"; durationMs?: number; error?: string; filesChanged?: number }
  | { type: "slash_commands"; commands: { name: string; description: string; argumentHint?: string; kind: "command" | "skill" }[] };
