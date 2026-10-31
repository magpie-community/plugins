import type * as schema from "@agentclientprotocol/sdk";
import type { ProviderEvent } from "../../timeline/types.js";
import type { ToolKind } from "../../timeline/types.js";

const rid = () => Math.random().toString(36).slice(2, 8);

function mapToolKind(k: schema.ToolKind | null | undefined): ToolKind {
  switch (k) {
    case "read":
    case "edit":
    case "search":
      return k;
    case "execute":
      return "bash";
    case "fetch":
      return "web";
    default:
      return "other";
  }
}

function mapToolStatus(s: schema.ToolCallStatus | null | undefined): "running" | "ok" | "failed" {
  if (s === "completed") return "ok";
  if (s === "failed") return "failed";
  return "running";
}

function textFromContent(content: schema.ContentBlock): string {
  if (content.type === "text") return content.text;
  return "";
}

/** seg: text segment number, bumped when a tool call / plan comes between two runs of text, so the text before and
 *  after a tool call are separate items (live and persisted alike: the manager saves each segment when the next item starts). */
export type MapCtx = { itemPrefix: string; messageIds: Map<string, string>; seg: number; lastWasText: boolean };

export function newMapCtx(): MapCtx {
  return { itemPrefix: "a" + rid() + "_", messageIds: new Map(), seg: 0, lastWasText: false };
}

function endTextSegment(ctx: MapCtx): void {
  if (ctx.lastWasText) {
    ctx.seg++;
    ctx.lastWasText = false;
  }
}

export function mapSessionUpdate(update: schema.SessionUpdate, ctx: MapCtx): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  const mid = "messageId" in update && update.messageId ? String(update.messageId) : null;

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textFromContent(update.content);
      if (!text) break;
      const itemId = `${ctx.itemPrefix}${mid ?? "msg"}_${ctx.seg}`;
      if (mid) ctx.messageIds.set(mid, itemId);
      ctx.lastWasText = true;
      out.push({ type: "assistant_delta", itemId, text });
      break;
    }
    case "agent_thought_chunk": {
      const text = textFromContent(update.content);
      if (!text) break;
      const itemId = `${ctx.itemPrefix}t_${mid ?? "think"}_${ctx.seg}`;
      ctx.lastWasText = true;
      out.push({ type: "reasoning_delta", itemId, text });
      break;
    }
    case "tool_call":
      endTextSegment(ctx);
      out.push({
        type: "tool_call",
        itemId: ctx.itemPrefix + update.toolCallId,
        kind: mapToolKind(update.kind),
        title: update.title,
        status: mapToolStatus(update.status),
        input: update.rawInput,
      });
      break;
    case "tool_call_update":
      endTextSegment(ctx);
      out.push({
        type: "tool_call",
        itemId: ctx.itemPrefix + update.toolCallId,
        kind: mapToolKind(update.kind),
        title: update.title ?? update.name ?? "",
        status: mapToolStatus(update.status),
        input: update.rawInput,
        output: typeof update.rawOutput === "string" ? update.rawOutput : undefined,
      });
      break;
    case "plan":
      endTextSegment(ctx);
      out.push({
        type: "plan",
        itemId: ctx.itemPrefix + "plan",
        markdown: update.entries.map((e) => `- ${e.content}`).join("\n"),
        entries: update.entries.map((e) => ({ step: e.content, status: e.status ?? "" })),
      });
      break;
    case "notice":
      out.push({
        type: "notice",
        level: update.severity === "error" ? "error" : update.severity === "warning" ? "warn" : "info",
        message: update.description ? `${update.title}: ${update.description}` : update.title,
      });
      break;
    case "usage_update":
      out.push({
        type: "usage",
        inputTokens: update.used,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: typeof update.cost?.amount === "number" ? update.cost.amount : 0,
        contextWindow: update.size,
      });
      break;
    default:
      break;
  }
  return out;
}

export function stopToTurnEnd(stopReason: schema.StopReason, turnId: string, err?: string): ProviderEvent {
  if (stopReason === "cancelled") {
    return { type: "turn_ended", turnId, status: "interrupted" };
  }
  if (stopReason === "refusal" || stopReason === "max_tokens") {
    return { type: "turn_ended", turnId, status: "failed", error: err ?? stopReason };
  }
  return { type: "turn_ended", turnId, status: "completed" };
}
