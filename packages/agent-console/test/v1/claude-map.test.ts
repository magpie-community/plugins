import { describe, it, expect } from "vitest";
import { mapSdkMessage, newMapState } from "../../daemon/src/providers/claude/map.js";
/** A claude stream-json message */
type Msg = Record<string, unknown>;

const cwd = "D:/proj";

const sys = (o: Record<string, unknown>) => ({ type: "system", ...o }) as Msg;
const stream = (event: Record<string, unknown>) => ({ type: "stream_event", event }) as Msg;
const assistant = (content: unknown[], id = "msg_1") =>
  ({ type: "assistant", message: { id, content } }) as Msg;
const user = (content: unknown[]) => ({ type: "user", message: { role: "user", content } }) as Msg;
const result = (o: Record<string, unknown>) => ({ type: "result", ...o }) as Msg;

describe("claude map: stream-json messages → unified events", () => {
  it("system init → provider_session_id", () => {
    const st = newMapState();
    const evs = mapSdkMessage(sys({ subtype: "init", session_id: "abc-123", model: "sonnet" }), st, cwd);
    expect(evs).toEqual([{ type: "provider_session_id", id: "abc-123" }]);
  });

  it("stream_event text_delta → assistant_delta with <message.id>:t<ordinal>", () => {
    const st = newMapState();
    mapSdkMessage(stream({ type: "message_start", message: { id: "msg_9" } }), st, cwd);
    mapSdkMessage(stream({ type: "content_block_start", index: 0, content_block: { type: "text" } }), st, cwd);
    const evs = mapSdkMessage(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } }), st, cwd);
    expect(evs).toEqual([{ type: "assistant_delta", itemId: "msg_9:t0", text: "你好" }]);
  });

  it("stream_event thinking_delta → reasoning_delta (thinking and text numbered separately)", () => {
    const st = newMapState();
    mapSdkMessage(stream({ type: "message_start", message: { id: "msg_9" } }), st, cwd);
    // thinking block index=0, text block index=1 (interleaved by the SDK) → delta itemIds should be k0/t0 respectively
    mapSdkMessage(stream({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }), st, cwd);
    mapSdkMessage(stream({ type: "content_block_start", index: 1, content_block: { type: "text" } }), st, cwd);
    const evs = mapSdkMessage(stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想想" } }), st, cwd);
    expect(evs).toEqual([{ type: "reasoning_delta", itemId: "msg_9:k0", text: "想想" }]);
    const evs2 = mapSdkMessage(stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "回" } }), st, cwd);
    expect(evs2).toEqual([{ type: "assistant_delta", itemId: "msg_9:t0", text: "回" }]);
  });

  it("delta and complete assistant event itemIds align (renumbered indexes don't render twice)", () => {
    const st = newMapState();
    mapSdkMessage(stream({ type: "message_start", message: { id: "msg_7" } }), st, cwd);
    mapSdkMessage(stream({ type: "content_block_start", index: 0, content_block: { type: "text" } }), st, cwd);
    mapSdkMessage(stream({ type: "content_block_start", index: 1, content_block: { type: "text" } }), st, cwd);
    const d0 = mapSdkMessage(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "长文" } }), st, cwd);
    const d1 = mapSdkMessage(stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "收到" } }), st, cwd);
    // The complete message content has only one text block (renumbered to index 0) → should it overwrite t1? No — by ordinal within type:
    // the complete message's only text → t0; the text delta at index 1 → t1.
    // Real case: when the SDK assistant event's content matches the streamed blocks, they align one to one;
    // if the content was aggregated differently, the last assistant_message at least overwrites the first block of the same type.
    const full = mapSdkMessage(assistant([{ type: "text", text: "收到" }], "msg_7"), st, cwd);
    expect((d0[0] as { itemId: string }).itemId).toBe("msg_7:t0");
    expect((d1[0] as { itemId: string }).itemId).toBe("msg_7:t1");
    expect((full[0] as { itemId: string }).itemId).toBe("msg_7:t0");
  });

  it("assistant text/thinking → assistant_message/reasoning; tool_use → tool_call running + TodoWrite→todo", () => {
    const st = newMapState();
    const evs = mapSdkMessage(
      assistant([
        { type: "text", text: "我来看看" },
        { type: "thinking", thinking: "先读文件" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "src/index.ts" } },
        { type: "tool_use", id: "toolu_2", name: "TodoWrite", input: { todos: [{ content: "改代码", status: "in_progress" }] } },
      ], "msg_2"),
      st,
      cwd,
    );
    const types = evs.map((e) => e.type);
    expect(types).toEqual(["assistant_message", "reasoning", "tool_call", "tool_call", "todo"]);
    expect((evs[0] as { itemId: string }).itemId).toBe("msg_2:t0");
    expect((evs[2] as { itemId: string; status: string; kind: string }).status).toBe("running");
    expect((evs[2] as { kind: string }).kind).toBe("read");
    expect((evs[4] as { items: { text: string }[] }).items[0].text).toBe("改代码");
  });

  it("Edit tool_use → detail carries diff hunks", () => {
    const st = newMapState();
    const evs = mapSdkMessage(
      assistant([
        { type: "tool_use", id: "toolu_3", name: "Edit", input: { file_path: "a.ts", old_string: "x=1", new_string: "x=2" } },
      ]),
      st,
      cwd,
    );
    const tc = evs[0] as { kind: string; detail: { hunks?: unknown[]; added: number; removed: number } };
    expect(tc.kind).toBe("edit");
    expect(tc.detail.hunks?.length).toBeGreaterThan(0);
    expect(tc.detail.added).toBe(1);
    expect(tc.detail.removed).toBe(1);
  });

  it("user tool_result → tool_call ok/failed (truncated at 20KB)", () => {
    const st = newMapState();
    const big = "x".repeat(30 * 1024);
    const evs = mapSdkMessage(
      user([
        { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "done" }] },
        { type: "tool_result", tool_use_id: "toolu_2", content: big, is_error: true },
      ]),
      st,
      cwd,
    );
    expect(evs.length).toBe(2);
    expect((evs[0] as { itemId: string; status: string }).itemId).toBe("toolu_1");
    expect((evs[0] as { status: string }).status).toBe("ok");
    expect((evs[1] as { status: string }).status).toBe("failed");
    expect(((evs[1] as { output?: string }).output ?? "").length).toBe(20 * 1024);
  });

  it("result → usage + turn_ended completed", () => {
    const st = newMapState();
    const evs = mapSdkMessage(
      result({ subtype: "success", total_cost_usd: 0.05, duration_ms: 4200, is_error: false, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 } }),
      st,
      cwd,
    );
    const usage = evs.find((e) => e.type === "usage") as { inputTokens: number; costUsd: number };
    const end = evs.find((e) => e.type === "turn_ended") as { status: string; durationMs: number };
    expect(usage.inputTokens).toBe(100);
    expect(usage.costUsd).toBe(0.05);
    expect(end.status).toBe("completed");
    expect(end.durationMs).toBe(4200);
  });

  it("result is_error → turn_ended failed", () => {
    const st = newMapState();
    const evs = mapSdkMessage(result({ subtype: "error_max_turns", is_error: true, result: "超过轮次" }), st, cwd);
    const end = evs.find((e) => e.type === "turn_ended") as { status: string; error?: string };
    expect(end.status).toBe("failed");
    expect(end.error).toBe("超过轮次");
  });

  it("result after interrupt → interrupted (sawInterrupt or a subtype containing interrupt)", () => {
    const st = newMapState();
    st.sawInterrupt = true;
    const evs = mapSdkMessage(result({ subtype: "success", is_error: false }), st, cwd);
    const end = evs.find((e) => e.type === "turn_ended") as { status: string };
    expect(end.status).toBe("interrupted");
    expect(st.sawInterrupt).toBe(false);

    const st2 = newMapState();
    const evs2 = mapSdkMessage(result({ subtype: "error_interrupted", is_error: true }), st2, cwd);
    const end2 = evs2.find((e) => e.type === "turn_ended") as { status: string };
    expect(end2.status).toBe("interrupted");
  });
});
