// claude stream-json messages (and ~/.claude/projects jsonl lines) → ProviderEvent (§7.2.3). Ported from normalize in lib/agents/claude.mjs.
import type { ProviderEvent } from "../../timeline/types.js";
import { callInfo, todoItems } from "../../agents/kinds.js";
import { editDetail } from "../../agents/diff.js";
import { tr } from "../../util/i18n.js";

const MAX_OUTPUT = 20 * 1024;
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;
const clean = (s: string): string => String(s ?? "").replace(ANSI_RE, "");

export type MapState = {
  blocks: Map<number, string>; // content_block_start index → block type
  msgId: string; // Current streaming message.id
  // Streaming block index → unified itemId (msgId:type:ordinal within type).
  // claude's content_block index interleaves thinking/text, while the content array of the assistant event
  // may be renumbered (when thinking is split into another message, text goes back to 0) — a bare index would make
  // the delta and complete event itemIds diverge and the frontend render two duplicate replies. Align both sides by type + ordinal within type.
  itemIdByBlock: Map<number, string>;
  typeSeq: Map<string, number>; // Count of each block type in the current message (delta side)
  sawInterrupt: boolean; // After interrupt() the next result counts as interrupted
};

export function newMapState(): MapState {
  return { blocks: new Map(), msgId: "", itemIdByBlock: new Map(), typeSeq: new Map(), sawInterrupt: false };
}

// Block type → short code and channel for itemIds; thinking/reasoning are one kind, text another; tool_use uses the tool id and doesn't go through here
const blockKind = (t: string): string =>
  t === "thinking" || t === "redacted_thinking" ? "k" : t === "text" ? "t" : "x";

function itemIdFor(st: MapState, blockIdx: number, blkType: string): string {
  const k = blockKind(blkType);
  const n = st.typeSeq.get(k) ?? 0;
  st.typeSeq.set(k, n + 1);
  const id = `${st.msgId}:${k}${n}`;
  st.itemIdByBlock.set(blockIdx, id);
  return id;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// One stream-json message → 0..n unified events
/** total_cost_usd is Claude Code's estimate at Anthropic's prices. For another vendor's model behind a gateway (DeepSeek through
 *  magpie, say) it is meaningless, so it is only kept when every model the turn used is a Claude model (B14). */
export function costIsReal(modelUsage: unknown): boolean {
  if (!modelUsage || typeof modelUsage !== "object") return true;
  const names = Object.keys(modelUsage as Record<string, unknown>);
  return names.every((n) => /claude|opus|sonnet|haiku/i.test(n));
}

export function mapSdkMessage(m: unknown, st: MapState, cwd: string): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  if (!m || typeof m !== "object") return out;
  const r = m as unknown as Rec;

  if (r.type === "system") {
    if (r.subtype === "init") {
      const sid = str(r.session_id) ?? "";
      if (sid) out.push({ type: "provider_session_id", id: sid });
    }
    // compact_boundary / status / api_retry etc. → lightweight notices
    if (r.subtype === "api_retry") {
      out.push({ type: "notice", level: "warn", message: tr("notice.apiRetry", { n: String(r.attempt ?? "?") }) });
    }
    if (r.subtype === "compact_boundary") {
      out.push({ type: "notice", level: "info", message: tr("notice.compacted") });
    }
    return out;
  }

  if (r.type === "stream_event") {
    const e = rec(r.event);
    if (e.type === "message_start") {
      const mid = str(rec(e.message).id);
      if (mid) st.msgId = mid;
      st.blocks.clear();
      st.itemIdByBlock.clear();
      st.typeSeq.clear();
      return out;
    }
    if (e.type === "content_block_start") {
      const idx = typeof e.index === "number" ? e.index : 0;
      const bt = str(rec(e.content_block).type) ?? "";
      st.blocks.set(idx, bt);
      itemIdFor(st, idx, bt); // Register index → unified itemId
      return out;
    }
    if (e.type === "content_block_delta") {
      const idx = typeof e.index === "number" ? e.index : 0;
      const d = rec(e.delta);
      // Fallback when a delta arrives before its start: infer and register from the delta type
      const itemId = st.itemIdByBlock.get(idx) ?? itemIdFor(st, idx, d.type === "thinking_delta" ? "thinking" : "text");
      if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
        out.push({ type: "assistant_delta", itemId, text: d.text });
      } else if (d.type === "thinking_delta") {
        const t = str(d.thinking) ?? str(d.text);
        if (t) out.push({ type: "reasoning_delta", itemId, text: t });
      }
      // Ignore input_json_delta: wait for the complete tool_use in the assistant message
    }
    return out;
  }

  if (r.type === "assistant") {
    const mid = str(rec(r.message).id) ?? st.msgId ?? "";
    const content = rec(r.message).content;
    const parts = Array.isArray(content) ? content : [];
    // Same rule as the streaming side: build itemIds from type + ordinal within type so they overwrite the matching deltas
    const seqs = new Map<string, number>();
    parts.forEach((p) => {
      const blk = rec(p);
      const t = str(blk.type) ?? "";
      const k = blockKind(t);
      const n = seqs.get(k) ?? 0;
      seqs.set(k, n + 1);
      const itemId = `${mid}:${k}${n}`;
      if (blk.type === "text" && typeof blk.text === "string" && blk.text) {
        out.push({ type: "assistant_message", itemId, text: blk.text });
      } else if (blk.type === "thinking" || blk.type === "redacted_thinking") {
        const t2 = str(blk.thinking) ?? str(blk.text);
        if (t2) out.push({ type: "reasoning", itemId, text: t2 });
      } else if (blk.type === "tool_use") {
        out.push(...mapToolUse(blk, cwd));
      }
    });
    return out;
  }

  if (r.type === "user") {
    const content = rec(r.message).content;
    const parts = Array.isArray(content) ? content : [];
    for (const p of parts) {
      const blk = rec(p);
      if (blk.type === "tool_result") {
        const output = clean(contentText(blk.content));
        out.push({
          type: "tool_call",
          itemId: str(blk.tool_use_id) ?? "",
          kind: "other",
          title: "",
          status: blk.is_error ? "failed" : "ok",
          output: output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) : output,
        });
      }
    }
    return out;
  }

  if (r.type === "result") {
    const usage = rec(r.usage);
    const num = (k: string): number => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
    out.push({
      type: "usage",
      inputTokens: num("input_tokens"),
      outputTokens: num("output_tokens"),
      cacheReadTokens: num("cache_read_input_tokens"),
      costUsd: typeof r.total_cost_usd === "number" && costIsReal(r.modelUsage) ? r.total_cost_usd : 0,
    });
    const subtype = str(r.subtype) ?? "";
    const interrupted = st.sawInterrupt || /interrupt/i.test(subtype);
    const isError = r.is_error === true;
    out.push({
      type: "turn_ended",
      turnId: "", // The session fills in the current turnId
      status: interrupted ? "interrupted" : isError ? "failed" : "completed",
      durationMs: typeof r.duration_ms === "number" ? r.duration_ms : undefined,
      error: isError && !interrupted ? str(r.result) ?? subtype : undefined,
      filesChanged: typeof r.num_turns === "number" ? undefined : undefined,
    });
    st.sawInterrupt = false;
    return out;
  }
  return out;
}

function mapToolUse(blk: Rec, cwd: string): ProviderEvent[] {
  const input = rec(blk.input);
  const name = str(blk.name) ?? "tool";
  const id = str(blk.id) ?? "";
  const info = callInfo(name, { ...input, _exists: true }, cwd);
  let detail: unknown = info.detail;
  if (info.kind === "edit" && (input.old_string !== undefined || Array.isArray(input.edits))) {
    detail = editDetail({ path: (info.detail as Rec).path as string, old: input.old_string, new: input.new_string, edits: input.edits });
  }
  if (info.kind === "write" && typeof input.content === "string") {
    const lines = input.content.split("\n");
    detail = { path: (info.detail as Rec).path, lines: lines.slice(0, 200), totalLines: lines.length };
  }
  const out: ProviderEvent[] = [
    {
      type: "tool_call",
      itemId: id,
      kind: info.kind,
      title: info.title,
      status: "running",
      input,
      detail,
    },
  ];
  if (name === "TodoWrite") {
    out.push({ type: "todo", items: todoItems((input.todos as { content?: string; status?: string }[]) ?? []) });
  }
  return out;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => str(rec(p).text) ?? "").join("");
  return "";
}
