import { afterAll, describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { CodexRpc, CodexProcessExitedError } from "../../daemon/src/providers/codex/rpc.js";
import { mapNotification, newCodexMapState } from "../../daemon/src/providers/codex/map.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Simulated app-server: echoes each JSON-RPC line as {id,result:{echo:params}};
// on method:"emit" → sends the notifications/server requests in params.lines;
// the echo server request is answered with {id, result:{ok:true}}.
const fakeServer = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === "emit") {
      for (const l of m.params.lines) process.stdout.write(JSON.stringify(l) + "\\n");
      process.stdout.write(JSON.stringify({ id: m.id, result: { ok: true } }) + "\\n");
    } else if (m.method === "serverRequest") {
      // reply to the client + send a server request; once the client answers {id:999,result}, send a notification
      process.stdout.write(JSON.stringify({ id: m.id, result: { ok: true } }) + "\\n");
      process.stdout.write(JSON.stringify({ id: 999, method: "item/commandExecution/requestApproval", params: { command: "npm test", itemId: "i1" } }) + "\\n");
    } else if (m.id === 999 && m.result !== undefined) {
      process.stdout.write(JSON.stringify({ method: "approval/replied", params: m.result }) + "\\n");
    } else if (m.id !== undefined && m.method) {
      process.stdout.write(JSON.stringify({ id: m.id, result: { echo: m.method } }) + "\\n");
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

// All cases share one temporary script, deleted afterwards
const dir = mkdtempSync(join(tmpdir(), "rpc-"));
const script = join(dir, "server.mjs");
writeFileSync(script, fakeServer);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeRpc(): { rpc: CodexRpc; notifications: { m: string; p: Record<string, unknown> }[] } {
  const rpc = new CodexRpc({ cmd: process.execPath, args: [script] });
  const notifications: { m: string; p: Record<string, unknown> }[] = [];
  rpc.onNotification = (m, p) => notifications.push({ m, p });
  rpc.onServerRequest = async () => ({ decision: "accept" });
  return { rpc, notifications };
}

describe("CodexRpc", () => {
  it("request → result", async () => {
    const { rpc } = makeRpc();
    const res = await rpc.request<{ echo: string }>("turn/start", { x: 1 });
    expect(res.echo).toBe("turn/start");
    await rpc.close();
  });

  it("notification → onNotification", async () => {
    const { rpc, notifications } = makeRpc();
    await rpc.request("emit", {
      lines: [
        { method: "turn/started", params: { turn: { id: "t1" } } },
        { method: "item/agentMessage/delta", params: { itemId: "i1", delta: "hi" } },
      ],
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(notifications.map((n) => n.m)).toEqual(["turn/started", "item/agentMessage/delta"]);
    await rpc.close();
  });

  it("server request → onServerRequest answer", async () => {
    const { rpc, notifications } = makeRpc();
    await rpc.request("serverRequest", {});
    await new Promise((r) => setTimeout(r, 200));
    expect(notifications.some((n) => n.m === "approval/replied" && (n.p as { decision?: string }).decision === "accept")).toBe(true);
    await rpc.close();
  });

  it("process exit → pending requests reject", async () => {
    const { rpc } = makeRpc();
    const p = rpc.request("turn/start", {});
    await rpc.close();
    await expect(rpc.request("x")).rejects.toBeInstanceOf(CodexProcessExitedError);
    await p.catch(() => {});
  });
});

describe("codex map", () => {
  it("turn/started + deltas + completed", () => {
    const st = newCodexMapState();
    let evs = mapNotification("turn/started", { turn: { id: "t1" } }, st);
    expect(st.currentTurnId).toBe("t1");
    evs = mapNotification("item/agentMessage/delta", { itemId: "m1", delta: "你好" }, st);
    expect(evs).toEqual([{ type: "assistant_delta", itemId: "m1", text: "你好" }]);
    evs = mapNotification("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "想" }, st);
    expect(evs).toEqual([{ type: "reasoning_delta", itemId: "r1", text: "想" }]);
  });

  it("item/started commandExecution → tool_call running; completed → ok", () => {
    const st = newCodexMapState();
    let evs = mapNotification("item/started", { item: { type: "commandExecution", id: "c1", command: "npm test" } }, st);
    expect(evs[0]).toMatchObject({ type: "tool_call", itemId: "c1", kind: "bash", status: "running" });
    evs = mapNotification("item/completed", { item: { type: "commandExecution", id: "c1", command: "npm test", exitCode: 0, aggregatedOutput: "ok", durationMs: 500 } }, st);
    expect(evs[0]).toMatchObject({ status: "ok", output: "ok", exitCode: 0 });
  });

  it("fileChange → edit tool_call + filesChanged count", () => {
    const st = newCodexMapState();
    mapNotification("item/started", { item: { type: "fileChange", id: "f1", changes: [{ path: "a.ts" }, { path: "b.ts" }] } }, st);
    mapNotification("item/completed", { item: { type: "fileChange", id: "f1", changes: [{ path: "a.ts" }, { path: "b.ts" }], status: "completed" } }, st);
    expect(st.filesChanged).toBe(2);
    const evs = mapNotification("turn/completed", { turn: { id: "t1", status: "completed", durationMs: 100 } }, st);
    const end = evs.find((e) => e.type === "turn_ended") as { filesChanged?: number; status: string };
    expect(end.status).toBe("completed");
    expect(end.filesChanged).toBe(2);
  });

  it("turn/plan/updated → todo", () => {
    const st = newCodexMapState();
    const evs = mapNotification("turn/plan/updated", { plan: [{ step: "改代码", status: "inProgress" }, { step: "测试", status: "pending" }] }, st);
    expect(evs[0]).toMatchObject({ type: "todo" });
    const items = (evs[0] as { items: { text: string; status: string }[] }).items;
    expect(items[0]).toEqual({ text: "改代码", status: "in_progress" });
    expect(items[1].status).toBe("pending");
  });

  it("turn/completed interrupted/failed", () => {
    const st = newCodexMapState();
    let evs = mapNotification("turn/completed", { turn: { id: "t1", status: "interrupted" } }, st);
    expect((evs[0] as { status: string }).status).toBe("interrupted");
    evs = mapNotification("turn/completed", { turn: { id: "t2", status: "failed", error: { message: "网关地区不支持" } } }, st);
    const end = evs[0] as { status: string; error?: string };
    expect(end.status).toBe("failed");
    expect(end.error).toBe("网关地区不支持");
  });

  it("thread/tokenUsage/updated → usage", () => {
    const st = newCodexMapState();
    const evs = mapNotification("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 } } }, st);
    expect(evs[0]).toMatchObject({ type: "usage", inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 });
  });
});
