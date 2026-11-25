import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../src/hooks.ts";
import { fetchImages } from "../src/tool.ts";
import { materializeToolPayloads, REFERENCE_PREFIX, redactPayloadsEverywhere } from "../src/payload.ts";
import { keyFor } from "../src/store.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "magpie-cam-protocol-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function payload() {
  await onRequest({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "image" }, { type: "input_image", image_url: `data:image/png;base64,${PNG}` }] }], tools: [{ name: "cam_view_image" }] }, {
    protocol: "responses", path: "/responses", origin: "local", agent: "codex", session: "shared", options: { dataDir: root }, report() {},
  });
  return fetchImages({ ids: ["IMG-001"], session: keyFor("codex", "shared") }, { agent: "codex", abort: new AbortController().signal }, { dataDir: root, language: "en" });
}

describe("tool payload protocol adapters", () => {
  test("Chat Completions tool message becomes text and image_url parts", async () => {
    const result = materializeToolPayloads({ messages: [{ role: "tool", content: await payload() }] }, "chat", "codex", keyFor("codex", "shared"), root);
    expect(result.count).toBe(1);
    expect(result.body.messages[0].content[1].image_url.url).toContain("base64," + PNG);
  });

  test("Anthropic tool_result becomes text and native base64 image blocks", async () => {
    const result = materializeToolPayloads({ messages: [{ role: "user", content: [{ type: "tool_result", content: await payload() }] }] }, "anthropic", "codex", keyFor("codex", "shared"), root);
    expect(result.count).toBe(1);
    expect(result.body.messages[0].content[0].content[1].source.data).toBe(PNG);
  });

  test("Codex code-mode input_text output arrays are materialized", async () => {
    const result = materializeToolPayloads({ input: [{ type: "custom_tool_call_output", output: [{ type: "input_text", text: await payload() }] }] }, "responses", "codex", keyFor("codex", "shared"), root);
    expect(result.count).toBe(1);
    expect(result.body.input[0].output[1].type).toBe("input_image");
  });

  test("ordinary text output is untouched", () => {
    const original = { input: [{ type: "function_call_output", output: "plain result" }] };
    const result = materializeToolPayloads(original, "responses", "codex", keyFor("codex", "shared"), root);
    expect(result.count).toBe(0);
    expect(result.body).toEqual(original);
  });

  test("mixed tool-output parts cannot smuggle an encoded payload", async () => {
    const result = materializeToolPayloads({ input: [{ type: "custom_tool_call_output", output: [{ type: "input_text", text: "before" }, { type: "input_text", text: await payload() }] }] }, "responses", "codex", keyFor("codex", "shared"), root);
    expect(result.count).toBe(1);
    expect(JSON.stringify(result.body)).not.toContain(REFERENCE_PREFIX);
    expect(JSON.stringify(result.body)).toContain("split or mixed");
  });

  test("a missing session redacts rather than forwards the payload", async () => {
    const value = await payload();
    const result = materializeToolPayloads({ input: [{ type: "function_call_output", output: value }] }, "responses", "codex", null, root);
    expect(result.count).toBe(1);
    expect(JSON.stringify(result.body)).not.toContain(REFERENCE_PREFIX);
    expect(JSON.stringify(result.body)).toContain("payload removed");
  });

  test("last-resort error handling removes nested payloads", async () => {
    const value = await payload();
    const result = redactPayloadsEverywhere({ input: [{ output: value }, { text: "ordinary" }] });
    expect(result.count).toBe(1);
    expect(JSON.stringify(result.value)).not.toContain(REFERENCE_PREFIX);
    expect(JSON.stringify(result.value)).toContain("processing error");
  });
});

describe("other history protocols", () => {
  test.each([
    ["responses", "codex"],
    ["chat", "codex"],
    ["anthropic", "codex"],
    ["anthropic", "claude"],
    ["chat", "opencode"],
    ["anthropic", "cline"],
    ["responses", "cursor"],
  ])("%s / %s: an omitted original survives the tool round trip at the budget limit", async (protocol, agent) => {
    const original = PNG.padEnd(1024, "A");
    const dataUrl = `data:image/png;base64,${original}`;
    const image = protocol === "responses" ? { type: "input_image", image_url: dataUrl }
      : protocol === "chat" ? { type: "image_url", image_url: { url: dataUrl } }
      : { type: "image", source: { type: "base64", media_type: "image/png", data: original } };
    const user = (text: string, ...attachments: object[]) => ({
      ...(protocol === "responses" ? { type: "message" } : {}),
      role: "user",
      content: [{ type: protocol === "responses" ? "input_text" : "text", text }, ...attachments],
    });
    const history = [user("first", image), user("next")];
    const request = (items: object[]) => ({ tools: [{ name: "cam_view_image" }], [protocol === "responses" ? "input" : "messages"]: items });
    const path = protocol === "responses" ? "/responses" : protocol === "chat" ? "/v1/chat/completions" : "/v1/messages";
    const options = { dataDir: root, maxFetchBytes: 1024 };
    const context = { protocol, path, options, origin: "local", agent, session: protocol };
    const omitted = await onRequest(request(history), context);
    const marker = /\[Magpie CAM session: ([0-9a-f]+)\]/.exec(JSON.stringify(omitted));
    expect(marker).not.toBeNull();
    expect(JSON.stringify(omitted)).not.toContain(original);
    const output = await fetchImages({ session: marker![1], ids: ["IMG-001"] }, { agent, abort: new AbortController().signal }, options);
    const result = protocol === "responses" ? { type: "function_call_output", call_id: "call-1", output }
      : protocol === "chat" ? { role: "tool", tool_call_id: "call-1", content: output }
      : { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: output }] };
    const restored = await onRequest(request([...history, result]), context);
    expect(JSON.stringify(restored)).toContain(original);
    expect(JSON.stringify(restored)).not.toContain(REFERENCE_PREFIX);
    unlinkSync(join(root, "platforms", agent, "images", createHash("sha256").update(original).digest("hex")));
    const recovered = JSON.stringify(await onRequest(request([...history, result]), context));
    expect(recovered.split(original)).toHaveLength(2);
    expect(recovered).not.toContain("original unavailable");
  });

  test("Chat Completions omits an old image", async () => {
    const context = () => ({ protocol: "chat", path: "/v1/chat/completions", origin: "local", agent: "codex", session: "chat-history", options: { dataDir: root, language: "en" }, report() {} });
    const first = { messages: [{ role: "user", content: [{ type: "text", text: "one" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }] }], tools: [{ name: "cam_view_image" }] };
    await onRequest(first, context());
    const second = structuredClone(first);
    second.messages.push({ role: "user", content: [{ type: "text", text: "two" }] });
    const next = await onRequest(second, context());
    expect(JSON.stringify(next)).not.toContain(PNG);
    expect(JSON.stringify(next)).toContain("IMG-001");
  });

  test("Anthropic Messages omits an old image", async () => {
    const context = () => ({ protocol: "anthropic", path: "/v1/messages", origin: "local", agent: "claude", session: "anthropic-history", options: { dataDir: root, language: "en" }, report() {} });
    const first = { messages: [{ role: "user", content: [{ type: "text", text: "one" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }], tools: [{ name: "cam_view_image" }] };
    await onRequest(first, context());
    const second = structuredClone(first);
    second.messages.push({ role: "user", content: [{ type: "text", text: "two" }] });
    const next = await onRequest(second, context());
    expect(JSON.stringify(next)).not.toContain(PNG);
    expect(JSON.stringify(next)).toContain("IMG-001");
  });
});
