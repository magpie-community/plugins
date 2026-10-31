// Codex app-server notifications → ProviderEvent (§7.3.4). Method and field names follow the generated schema.
import type { ProviderEvent } from "../../timeline/types.js";
import { tr } from "../../util/i18n.js";

const MAX_OUTPUT = 20 * 1024;
const trunc = (s: string, n = 80): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export type CodexMapState = {
  currentTurnId: string | null;
  filesChanged: number;
  diffText: string;
  fileChangesByItemId: Map<string, unknown[]>;
  /** Raw reasoning text streamed per item (DeepSeek and others send no summary): saved when the item completes (B15) */
  reasoningRaw: Map<string, string>;
};

export function newCodexMapState(): CodexMapState {
  return { currentTurnId: null, filesChanged: 0, diffText: "", fileChangesByItemId: new Map(), reasoningRaw: new Map() };
}

// One server notification → 0..n unified events. Server requests (approvals) don't go through here.
export function mapNotification(method: string, params: Rec, st: CodexMapState): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  const turnId = str(params.turnId);

  switch (method) {
    case "turn/started": {
      const turn = rec(params.turn);
      const tid = str(turn.id);
      if (tid) st.currentTurnId = tid;
      st.filesChanged = 0;
      st.diffText = "";
      st.fileChangesByItemId.clear();
      st.reasoningRaw.clear();
      break;
    }
    case "item/agentMessage/delta": {
      const itemId = str(params.itemId) ?? "";
      const delta = str(params.delta) ?? "";
      if (itemId && delta) out.push({ type: "assistant_delta", itemId, text: delta });
      break;
    }
    case "item/plan/delta": {
      // Incremental plan stream: wait for the plan item in item/completed to send the full plan
      break;
    }
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      const itemId = str(params.itemId) ?? "";
      const delta = str(params.delta) ?? "";
      if (itemId && delta) {
        if (method === "item/reasoning/textDelta") st.reasoningRaw.set(itemId, (st.reasoningRaw.get(itemId) ?? "") + delta);
        out.push({ type: "reasoning_delta", itemId, text: delta });
      }
      break;
    }
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "command/exec/outputDelta": {
      const itemId = str(params.itemId) ?? "";
      const delta = str(params.delta) ?? "";
      if (itemId && delta) out.push({ type: "tool_output_delta", itemId, text: delta });
      break;
    }
    case "item/started": {
      const item = rec(params.item);
      const type = str(item.type) ?? "";
      const itemId = str(item.id) ?? "";
      if (type === "commandExecution") {
        const cmd = str(item.command) ?? "";
        out.push({
          type: "tool_call", itemId, kind: "bash",
          title: tr("tool.run", { x: trunc(cmd) }), status: "running",
          detail: { command: cmd, cwd: str(item.cwd) },
        });
      } else if (type === "fileChange") {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        if (itemId) st.fileChangesByItemId.set(itemId, changes);
        out.push({
          type: "tool_call", itemId, kind: "edit",
          title: tr("tool.editFiles", { n: changes.length }), status: "running",
          detail: { changes },
        });
      } else if (type === "mcpToolCall" || type === "dynamicToolCall") {
        const tool = str(item.tool) ?? str(item.name) ?? "";
        const server = str(item.server) ?? "";
        out.push({
          type: "tool_call", itemId, kind: "mcp",
          title: `${server || "mcp"} · ${tool}`, status: "running",
        });
      } else if (type === "webSearch") {
        out.push({
          type: "tool_call", itemId, kind: "web",
          title: tr("tool.webSearch", { x: trunc(str(item.query) ?? "", 40) }), status: "running",
        });
      }
      // agentMessage/reasoning/userMessage/plan etc.: wait for a delta or completed
      break;
    }
    case "item/completed": {
      const item = rec(params.item);
      const type = str(item.type) ?? "";
      const itemId = str(item.id) ?? "";
      if (type === "agentMessage") {
        const text = str(item.text) ?? "";
        if (text) out.push({ type: "assistant_message", itemId, text });
      } else if (type === "reasoning") {
        const summary = Array.isArray(item.summary) ? item.summary : [];
        const content = Array.isArray(item.content) ? item.content : [];
        const strings = (a: unknown[]) => a.filter((s): s is string => typeof s === "string").join("\n");
        // The summary when there is one, else the raw reasoning (on the item, or as streamed)
        const text = strings(summary) || strings(content) || st.reasoningRaw.get(itemId) || "";
        st.reasoningRaw.delete(itemId);
        if (text) out.push({ type: "reasoning", itemId, text });
      } else if (type === "commandExecution") {
        const cmd = str(item.command) ?? "";
        const exitCode = typeof item.exitCode === "number" ? item.exitCode : undefined;
        const output = str(item.aggregatedOutput) ?? "";
        out.push({
          type: "tool_call", itemId, kind: "bash",
          title: tr("tool.run", { x: trunc(cmd) }),
          status: exitCode === 0 ? "ok" : "failed",
          output: output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) : output,
          exitCode,
          durationMs: typeof item.durationMs === "number" ? item.durationMs : undefined,
        });
      } else if (type === "fileChange") {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        if (itemId) st.fileChangesByItemId.set(itemId, changes);
        const istatus = str(item.status);
        st.filesChanged += changes.length;
        out.push({
          type: "tool_call", itemId, kind: "edit",
          title: tr("tool.editFiles", { n: changes.length }),
          status: istatus === "failed" ? "failed" : "ok",
          detail: { changes },
        });
      } else if (type === "mcpToolCall" || type === "dynamicToolCall") {
        const tool = str(item.tool) ?? str(item.name) ?? "";
        const server = str(item.server) ?? "";
        const istatus = str(item.status);
        const err = str(item.error);
        out.push({
          type: "tool_call", itemId, kind: "mcp",
          title: `${server || "mcp"} · ${tool}`,
          status: istatus === "failed" || err ? "failed" : "ok",
          output: err ?? undefined,
        });
      } else if (type === "webSearch") {
        out.push({
          type: "tool_call", itemId, kind: "web",
          title: tr("tool.webSearch", { x: trunc(str(item.query) ?? "", 40) }), status: "ok",
        });
      } else if (type === "plan") {
        const text = str(item.text) ?? "";
        if (text) out.push({ type: "plan", itemId, markdown: text });
      }
      break;
    }
    case "turn/plan/updated": {
      const steps = Array.isArray(params.plan) ? params.plan : [];
      const items = steps.map((s) => {
        const step = rec(s);
        const status = str(step.status) ?? "pending";
        return {
          text: str(step.step) ?? "",
          status: status === "completed" ? "done" : status === "inProgress" || status === "in_progress" ? "in_progress" : "pending",
        };
      });
      if (items.length) out.push({ type: "todo", items });
      break;
    }
    case "turn/diff/updated": {
      const diff = str(params.diff) ?? "";
      if (diff) st.diffText = diff;
      break;
    }
    case "thread/tokenUsage/updated": {
      const usage = rec(params.tokenUsage);
      const last = rec(usage.last) || usage;
      const input = typeof last.inputTokens === "number" ? last.inputTokens : 0;
      const output = typeof last.outputTokens === "number" ? last.outputTokens : 0;
      const cached = typeof last.cachedInputTokens === "number" ? last.cachedInputTokens : 0;
      out.push({
        type: "usage",
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cached,
        costUsd: 0,
      });
      break;
    }
    case "turn/completed": {
      const turn = rec(params.turn);
      const status = str(turn.status) ?? "completed";
      const error = rec(turn.error);
      out.push({
        type: "turn_ended",
        turnId: str(turn.id) ?? turnId ?? st.currentTurnId ?? "",
        status: status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed",
        durationMs: typeof turn.durationMs === "number" ? turn.durationMs : undefined,
        error: str(error.message),
        filesChanged: st.filesChanged || undefined,
      });
      break;
    }
    case "error": {
      const msg = str(params.message) ?? tr("codex.error");
      out.push({ type: "notice", level: "error", message: msg });
      break;
    }
    default:
      break;
  }
  return out;
}
