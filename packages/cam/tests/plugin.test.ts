import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../src/hooks.ts";
import { fetchImages } from "../src/tool.ts";
import { PAYLOAD_PREFIX, REFERENCE_PREFIX } from "../src/payload.ts";
import { getPolicy, getSession, keyFor, type SessionPolicy } from "../src/store.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_2 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const dataUrl = (data = PNG) => `data:image/png;base64,${data}`;
const options = () => ({ dataDir: root, language: "en", auto: true, maxFetchBytes: 1024 * 1024 });
const ctx = () => ({ protocol: "responses", path: "/backend-api/codex/responses", origin: "local", agent: "codex", session: "thread-test", model: "test/model", options: options(), state: {}, report() {} });
const user = (text: string, images: string[] = []) => ({ type: "message", role: "user", content: [{ type: "input_text", text }, ...images.map((image_url) => ({ type: "input_image", image_url }))] });
const body = (input: any[]) => ({ model: "test/model", stream: true, tools: [{ type: "function", name: "cam_view_image" }], input });
const texts = (value: unknown): string => JSON.stringify(value);
let root: string;

function savePolicy(root: string, key: string, policy: SessionPolicy) {
  mkdirSync(join(root, "policies"), { recursive: true });
  writeFileSync(join(root, "policies", `${key}.json`), JSON.stringify(policy));
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "magpie-cam-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("Responses history management", () => {
  test("records request outcomes separately from the attachment index", async () => {
    const key = keyFor("codex", "thread-test");
    const request = body([user("first", [dataUrl()]), user("second")]);
    await onRequest({ ...request, tools: [] }, ctx());
    expect(getSession(root, key)?.lastRequest).toMatchObject({ omitted: 0, restored: 0, reasons: ["tool-unavailable"] });
    const rewritten = await onRequest(request, ctx());
    expect(getSession(root, key)?.lastRequest).toMatchObject({ omitted: 1, restored: 0, reasons: [] });
    expect(getSession(root, key)?.lastRequest).toMatchObject({
      originalBytes: Buffer.byteLength(JSON.stringify(request)),
      rewrittenBytes: Buffer.byteLength(JSON.stringify(rewritten)),
    });
    await onRequest(request, { ...ctx(), options: { ...options(), auto: false } });
    await onRequest(request, ctx());
    expect(getSession(root, key)?.recentRequests?.map((entry) => entry.omitted)).toEqual([1, 0, 1]);
  });

  test("an Agent override keeps old originals inline without disabling another Agent", async () => {
    const request = body([user("first", [dataUrl()]), user("second")]);
    const context = { ...ctx(), options: { ...options(), agentAuto: { codex: false } } };
    expect(await onRequest(request, context)).toBeUndefined();
    expect(texts(await onRequest(request, { ...context, agent: "opencode" }))).toContain("IMG-001");
  });

  test("a unified host policy takes precedence over a future-dated legacy file", async () => {
    const key = keyFor("codex", "thread-test");
    savePolicy(root, key, { auto: true, pinnedContentIds: [], updatedAt: "2099-01-01T00:00:00.000Z", overridesLegacyNative: true });
    const context = { ...ctx(), options: { ...options(), sessionPolicies: { [key]: { version: 2, auto: false, pinnedContentIds: [] } } } };
    expect(await onRequest(body([user("first", [dataUrl()]), user("second")]), context)).toBeUndefined();
  });

  test("does not omit an image whose cached bytes no longer match its index", async () => {
    const first = user("first", [dataUrl()]);
    await onRequest(body([first]), ctx());
    const digest = createHash("sha256").update(PNG).digest("hex");
    writeFileSync(join(root, "platforms", "codex", "images", digest), PNG_2);
    expect(await onRequest(body([first, user("second")]), ctx())).toBeUndefined();
    const result = await fetchImages({ session: keyFor("codex", "thread-test"), ids: ["IMG-001"] }, { agent: "codex", abort: new AbortController().signal }, options());
    expect(result.startsWith(REFERENCE_PREFIX)).toBeFalse();
  });

  test("does not omit when the tool cannot resolve persisted session metadata", async () => {
    mkdirSync(join(root, "sessions", `${keyFor("codex", "thread-test")}.json`), { recursive: true });
    expect(await onRequest(body([user("first", [dataUrl()]), user("second")]), ctx())).toBeUndefined();
  });

  test("restores a missing cached original before omitting it", async () => {
    const first = user("first", [dataUrl()]);
    await onRequest(body([first]), ctx());
    const digest = createHash("sha256").update(PNG).digest("hex");
    unlinkSync(join(root, "platforms", "codex", "images", digest));
    const next = await onRequest(body([first, user("second")]), ctx());
    expect(texts(next)).not.toContain(dataUrl());
    const answer = await fetchImages({ session: keyFor("codex", "thread-test"), ids: ["IMG-001"] }, { agent: "codex", abort: new AbortController().signal }, options());
    expect(answer.startsWith(REFERENCE_PREFIX)).toBeTrue();
  });

  test("keeps originals in the request when the session index cannot be saved", async () => {
    const key = keyFor("codex", "thread-test");
    mkdirSync(join(root, "platforms", "codex", "sessions", `${key}.json.tmp`), { recursive: true });
    expect(await onRequest(body([user("first", [dataUrl()]), user("second")]), ctx())).toBeUndefined();
  });

  test("skipping an oversized image leaves the budget available for the next image", async () => {
    const large = PNG.replace(/=$/, "A".repeat(1024) + "=");
    await onRequest(body([user("first", [dataUrl(large), dataUrl(PNG_2)])]), ctx());
    const answer = await fetchImages({ session: keyFor("codex", "thread-test"), ids: ["IMG-001", "IMG-002"] }, { agent: "codex", abort: new AbortController().signal }, { ...options(), maxFetchBytes: 1024 });
    expect(answer.startsWith(REFERENCE_PREFIX)).toBeTrue();
    expect(answer).toContain("IMG-001 exceeds the fetch size budget");
    expect(answer).toContain(createHash("sha256").update(PNG_2).digest("hex"));
  });

  test("keeps an original inline if even a single-image fetch would exceed the budget", async () => {
    const large = PNG.replace(/=$/, "A".repeat(1024) + "=");
    const context = ctx();
    context.options.maxFetchBytes = 1024;
    expect(await onRequest(body([user("first", [dataUrl(large)]), user("next")]), context)).toBeUndefined();
  });

  test("an image-only prompt advances the user turn", async () => {
    const imageOnly = { type: "message", role: "user", content: [{ type: "input_image", image_url: dataUrl(PNG_2) }] };
    const next = await onRequest(body([user("first", [dataUrl()]), imageOnly]), ctx());
    expect(next).toBeDefined();
    expect(texts(next)).not.toContain(dataUrl());
    expect(texts(next)).toContain(dataUrl(PNG_2));
  });

  test("an oversized invalid id does not invalidate a valid image in the same result", async () => {
    const first = user("first", [dataUrl()]);
    await onRequest(body([first]), ctx());
    const output = await fetchImages({ session: keyFor("codex", "thread-test"), ids: ["IMG-001", "x".repeat(17_000), `IMG-${"1".repeat(17_000)}`] }, { agent: "codex", abort: new AbortController().signal }, options());
    const next = await onRequest(body([first, { type: "function_call_output", call_id: "call-1", output }]), ctx());
    expect(next.input.at(-1).output).toContainEqual({ type: "input_image", image_url: dataUrl() });
  });

  test("indexes new images and omits them only after a later user turn", async () => {
    const first = body([user("first", [dataUrl()])]);
    expect(await onRequest(first, ctx())).toBeUndefined();
    const second = body([user("first", [dataUrl()]), user("second", [dataUrl(PNG_2)])]);
    const next = await onRequest(second, ctx());
    expect(next).toBeDefined();
    expect(texts(next)).not.toContain(dataUrl());
    expect(texts(next)).toContain(dataUrl(PNG_2));
    expect(texts(next)).toContain("IMG-001");
    expect(texts(next)).toContain(`[Magpie CAM session: ${keyFor("codex", "thread-test")}]`);
    const replaced = next.input.flatMap((item: any) => item.content ?? []).some((part: any) => part.type === "input_text" && part.text.includes("[Image IMG-001 omitted"));
    expect(replaced).toBeTrue();
  });

  test("pause keeps old images while continuing to index them", async () => {
    await onRequest(body([user("first", [dataUrl()])]), ctx());
    savePolicy(root, keyFor("codex", "thread-test"), { auto: false, pinnedContentIds: [] });
    const next = await onRequest(body([user("first", [dataUrl()]), user("second")]), ctx());
    expect(next).toBeUndefined();
    expect(getPolicy(root, keyFor("codex", "thread-test")).auto).toBeFalse();
  });

  test("native Magpie options can pause a session without a policy file", async () => {
    await onRequest(body([user("first", [dataUrl()])]), ctx());
    const paused = ctx();
    paused.options = { ...options(), sessionPolicies: { [keyFor("codex", "thread-test")]: { auto: false, pinnedContentIds: [] } } };
    expect(await onRequest(body([user("first", [dataUrl()]), user("second")]), paused)).toBeUndefined();
  });

  test("pinned content stays inline while another old image is omitted", async () => {
    await onRequest(body([user("first", [dataUrl(), dataUrl(PNG_2)])]), ctx());
    const pinnedContentIds = [createHash("sha256").update(PNG).digest("hex")];
    savePolicy(root, keyFor("codex", "thread-test"), { auto: true, pinnedContentIds });
    const next = await onRequest(body([user("first", [dataUrl(), dataUrl(PNG_2)]), user("second")]), ctx());
    expect(texts(next)).toContain(dataUrl());
    expect(texts(next)).not.toContain(dataUrl(PNG_2));
  });

  test("keeps history inline when the fetch tool is not declared", async () => {
    await onRequest(body([user("first", [dataUrl()])]), ctx());
    const withoutTool = body([user("first", [dataUrl()]), user("second")]);
    withoutTool.tools = [];
    expect(await onRequest(withoutTool, ctx())).toBeUndefined();
  });

  test("keeps history inline when the client has no stable session id", async () => {
    const anonymous = () => { const context = ctx(); delete context.session; return context; };
    await onRequest(body([user("first", [dataUrl()])]), anonymous());
    expect(await onRequest(body([user("first", [dataUrl()]), user("second")]), anonymous())).toBeUndefined();
  });

  test("does not mistake Codex's built-in view_image for CAM", async () => {
    await onRequest(body([user("first", [dataUrl()])]), ctx());
    const builtIn = body([user("first", [dataUrl()]), user("second")]);
    builtIn.tools = [{ type: "function", name: "view_image" }];
    expect(await onRequest(builtIn, ctx())).toBeUndefined();
  });

  test("keeps original images when Codex Lite does not declare CAM", async () => {
    await onRequest(body([user("first", [dataUrl()])]), ctx());
    const lite = body([user("first", [dataUrl()]), user("second")]);
    lite.tools = [];
    lite.input.unshift({ type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: [{ name: "unrelated" }] }] });
    expect(await onRequest(lite, ctx())).toBeUndefined();
  });

  test("supports a CAM declaration nested in additional_tools", async () => {
    const lite = body([user("first", [dataUrl()]), user("second")]);
    lite.tools = [];
    lite.input.unshift({ type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: [{ name: "cam_view_image" }] }] });
    const next = await onRequest(lite, ctx());
    expect(next).toBeDefined();
    expect(texts(next)).not.toContain(dataUrl());
    expect(texts(next)).toContain("cam_view_image");
  });

  test("Codex exec retains originals until a session-bound V2 result is restored", async () => {
    const request = body([user("first", [dataUrl()]), user("second")]);
    request.tools = [];
    request.input.unshift({ type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }] });
    const compatible = { ...ctx(), options: { ...options(), codexMode: "compatible" } };
    const before = await onRequest(request, compatible);
    const preferred = await onRequest(request, ctx());
    expect(texts(preferred)).toContain("IMG-001 omitted");
    expect(texts(preferred)).not.toContain(dataUrl());
    expect(preferred.tools).toEqual(request.tools);
    expect(getSession(root, keyFor("codex", "thread-test"))?.lastRequest?.rewrittenBytes).toBe(Buffer.byteLength(JSON.stringify(preferred)));
    const session = keyFor("codex", "thread-test");
    const textOnly = { ...request, input: [request.input[0], user("Recover an indexed image")] };
    expect(texts(await onRequest(textOnly, compatible))).toContain(`[Magpie CAM session: ${session}]`);
    expect(await onRequest(textOnly, { ...compatible, session: "unindexed" })).toBeUndefined();
    expect(texts(before)).toContain(dataUrl());
    expect(texts(before)).toContain(`[Magpie CAM session: ${session}]`);
    expect(before.tools).toEqual(request.tools);
    expect(before.input[1]).toEqual(request.input[0]);
    const result = await fetchImages({ session, ids: ["IMG-001"] }, { agent: "codex", abort: new AbortController().signal }, options());
    const withResult = {
      ...request,
      input: [...request.input, { type: "custom_tool_call_output", output: [
        { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
        { type: "input_text", text: result },
      ] }],
    };
    const after = await onRequest(withResult, compatible);
    expect(after.input.at(-1).output).toContainEqual({ type: "input_image", image_url: dataUrl() });
    expect(texts(after)).toContain("IMG-001 omitted");
    expect(texts(after)).not.toContain(REFERENCE_PREFIX);
    expect(getSession(root, session)?.lastRequest).toMatchObject({ omitted: 1, restored: 1 });
    const normalized = structuredClone(withResult);
    const toolOutput = normalized.input.at(-1)!;
    toolOutput.type = "function_call_output";
    expect((await onRequest(normalized, ctx())).input.at(-1).output).toContainEqual({ type: "input_image", image_url: dataUrl() });
    toolOutput.output = toolOutput.output.map((part: { text: string }) => part.text).join("\n");
    expect((await onRequest(normalized, ctx())).input.at(-1).output).toContainEqual({ type: "input_image", image_url: dataUrl() });
    const wrong = await onRequest(withResult, { ...compatible, session: "other-thread" });
    expect(texts(wrong)).toContain(dataUrl());
    expect(texts(wrong)).not.toContain("IMG-001 omitted");
    const failed = await onRequest(withResult, { ...ctx(), session: "other-thread" });
    expect(texts(failed)).toContain(dataUrl());
    expect(texts(failed)).not.toContain("IMG-001 omitted");
  });

  test("only annotates generated text, including when omission occurs", async () => {
    const original = "What does cam_view_image do with IMG-123?";
    const request = body([user(original, [dataUrl()]), user("second")]);
    request.tools = [{ type: "function", name: "CAM-magpie_cam_view_image" }];
    expect(await onRequest({ ...request, input: [user(original)] }, ctx())).toBeUndefined();
    const next = await onRequest(request, ctx());
    expect(next.input.find((item: any) => item.role === "user").content[0].text).toBe(original);
    expect(texts(next)).toContain("call CAM-magpie_cam_view_image");
  });

  test("uses the tool name exposed by an MCP hub in its instructions", async () => {
    await onRequest(body([user("first", [dataUrl()])]), ctx());
    const hub = body([user("first", [dataUrl()]), user("second")]);
    hub.tools = [{ type: "function", name: "CAM-magpie_cam_view_image" }];
    const next = await onRequest(hub, ctx());
    expect(texts(next)).toContain("call CAM-magpie_cam_view_image");
    expect(texts(next)).toContain(`[Magpie CAM session: ${keyFor("codex", "thread-test")}]`);
  });

  test("remote requests are ignored by default", async () => {
    const context = { ...ctx(), origin: "remote" };
    expect(await onRequest(body([user("first", [dataUrl()])]), context)).toBeUndefined();
  });
});

describe("tool image round trip", () => {
  async function prepareHistory() {
    await onRequest(body([user("first", [dataUrl()])]), ctx());
    return body([user("first", [dataUrl()]), user("second")]);
  }

  test("emits a short session-bound reference without the image bytes", async () => {
    const original = PNG.padEnd(64 * 1024, "A");
    await onRequest(body([user("first", [dataUrl(original)])]), ctx());
    const session = keyFor("codex", "thread-test");
    const value = await fetchImages({ ids: ["IMG-001"], session }, { agent: "codex", abort: new AbortController().signal }, options());
    expect(value.startsWith(REFERENCE_PREFIX)).toBeTrue();
    expect(value.length).toBeLessThan(1024);
    expect(value).not.toContain(original);
  });

  test("a missing cached original leaves other references in the batch usable", async () => {
    const first = user("first", [dataUrl(), dataUrl(PNG_2)]);
    await onRequest(body([first]), ctx());
    const value = await fetchImages({ ids: ["IMG-001", "IMG-002"], session: keyFor("codex", "thread-test") }, { agent: "codex", abort: new AbortController().signal }, options());
    unlinkSync(join(root, "platforms", "codex", "images", createHash("sha256").update(PNG).digest("hex")));
    const request = body([user("first", [dataUrl(PNG_2)]), user("continue"), { type: "function_call_output", call_id: "call-1", output: value }]);
    const next = await onRequest(request, ctx());
    const output = next.input.at(-1).output;
    expect(output).not.toContainEqual({ type: "input_image", image_url: dataUrl() });
    expect(output).toContainEqual({ type: "input_image", image_url: dataUrl(PNG_2) });
    expect(texts(output)).toContain("IMG-001");
    expect(next.input[0]).toEqual(request.input[0]);
    expect(getSession(root, keyFor("codex", "thread-test"))?.lastRequest).toMatchObject({
      omitted: 0, restored: 1, failedResults: 1, reasons: ["restore-unavailable"],
    });
  });

  test("drops a flattened mixed CAM result and preserves originals in Codex savings mode", async () => {
    const history = await prepareHistory();
    const output = await fetchImages({ session: keyFor("codex", "thread-test"), ids: ["IMG-001"] }, { agent: "codex", abort: new AbortController().signal }, options());
    history.tools = [];
    history.input.unshift({ type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }] });
    history.input.push({ type: "custom_tool_call_output", output: "Script completed\nWall time 0.0 seconds\nOutput:\nDiagnostics\n" + output });
    const next = await onRequest(history, ctx());
    expect(texts(next)).not.toContain(REFERENCE_PREFIX);
    expect(texts(next)).toContain(dataUrl());
    expect(getSession(root, keyFor("codex", "thread-test"))?.lastRequest).toMatchObject({
      omitted: 0, restored: 0, failedResults: 1, reasons: ["restore-unavailable"],
    });
  });

  test("restores a V2 image from request history when the file disappeared after the tool call", async () => {
    const history = await prepareHistory();
    const output = await fetchImages({ ids: ["IMG-001"], session: keyFor("codex", "thread-test") }, { agent: "codex", abort: new AbortController().signal }, options());
    unlinkSync(join(root, "platforms", "codex", "images", createHash("sha256").update(PNG).digest("hex")));
    history.input.push({ type: "function_call_output", call_id: "call-1", output });
    const next = await onRequest(history, ctx());
    expect(next.input.at(-1).output).toContainEqual({ type: "input_image", image_url: dataUrl() });
    expect(texts(next)).not.toContain("original unavailable");
  });

  test("materializes this turn and removes the fetched copy next turn", async () => {
    const history = await prepareHistory();
    const payload = await fetchImages({ ids: ["IMG-001"], session: keyFor("codex", "thread-test") }, { agent: "codex", abort: new AbortController().signal }, options());
    expect(payload.startsWith(REFERENCE_PREFIX)).toBeTrue();
    const withTool = structuredClone(history);
    withTool.input.push({ type: "function_call_output", call_id: "call-1", output: payload });
    const current = await onRequest(withTool, ctx());
    const output = current.input.at(-1).output;
    expect(Array.isArray(output)).toBeTrue();
    expect(output.some((part: any) => part.type === "input_image" && part.image_url === dataUrl())).toBeTrue();
    expect(output[0].text).toContain("fetched original");
    expect(getSession(root, keyFor("codex", "thread-test"))?.lastRequest).toMatchObject({ restored: 1, failedResults: 0 });

    const repeated = await onRequest(withTool, ctx());
    expect(texts(repeated.input.at(-1).output)).toContain(dataUrl());

    const later = structuredClone(withTool);
    later.input.push(user("third"));
    const omitted = await onRequest(later, ctx());
    const laterOutput = omitted.input.at(-2).output;
    expect(texts(laterOutput)).not.toContain(dataUrl());
    expect(texts(laterOutput)).toContain("fetched original");
    expect(texts(laterOutput)).toContain("only in that turn");
    const paused = await onRequest(later, { ...ctx(), options: { ...options(), agentAuto: { codex: false } } });
    expect(paused.input.at(-2).output).toContainEqual({ type: "input_image", image_url: dataUrl() });
  });

  test("replays a legacy V1 payload and rejects changed bytes", async () => {
    const history = await prepareHistory();
    const legacy = (data: string) => PAYLOAD_PREFIX + JSON.stringify({ version: 1, content: [{ type: "image", id: "IMG-001", data, mimeType: "image/png" }] });
    const request = (data: string) => ({ ...history, input: [...history.input, { type: "function_call_output", call_id: "call-1", output: legacy(data) }] });
    const restored = await onRequest(request(PNG), ctx());
    expect(restored.input.at(-1).output).toContainEqual({ type: "input_image", image_url: dataUrl() });
    const next = await onRequest(request(PNG_2), ctx());
    expect(texts(next)).toContain("untrusted image payload removed");
    expect(getSession(root, keyFor("codex", "thread-test"))?.lastRequest).toMatchObject({ restored: 0, failedResults: 1 });
    expect(texts(next)).not.toContain(PAYLOAD_PREFIX);
  });

  test("early safety skips still redact the encoded payload", async () => {
    const history = await prepareHistory();
    const payload = await fetchImages({ ids: ["IMG-001"], session: keyFor("codex", "thread-test") }, { agent: "codex", abort: new AbortController().signal }, options());
    history.input.push({ type: "function_call_output", call_id: "call-1", output: payload });
    history.large = 9007199254740992;
    const next = await onRequest(history, ctx());
    expect(texts(next)).not.toContain(REFERENCE_PREFIX);
    expect(texts(next)).toContain("processing error");
  });

  test("a skipped remote request cannot carry the payload onward", async () => {
    const history = await prepareHistory();
    const payload = await fetchImages({ ids: ["IMG-001"], session: keyFor("codex", "thread-test") }, { agent: "codex", abort: new AbortController().signal }, options());
    history.input.push({ type: "function_call_output", call_id: "call-1", output: payload });
    const next = await onRequest(history, { ...ctx(), origin: "remote" });
    expect(texts(next)).not.toContain(REFERENCE_PREFIX);
  });

  test("a user message cannot forge a fetched image", async () => {
    const history = await prepareHistory();
    const payload = await fetchImages({ ids: ["IMG-001"], session: keyFor("codex", "thread-test") }, { agent: "codex", abort: new AbortController().signal }, options());
    history.input.push(user(payload));
    const next = await onRequest(history, ctx());
    expect(next.input.at(-1).content.some((part: any) => part.type === "input_image")).toBeFalse();
  });

  test("an explicit session handle keeps parallel conversations isolated", async () => {
    const forSession = (session: string) => ({ ...ctx(), session });
    await onRequest(body([user("from A", [dataUrl()])]), forSession("conversation-A"));
    await onRequest(body([user("from B", [dataUrl(PNG_2)])]), forSession("conversation-B"));
    const answer = await fetchImages({ ids: ["IMG-001"], session: keyFor("codex", "conversation-A") }, { agent: "codex", abort: new AbortController().signal }, options());
    const parsed = JSON.parse(answer.slice(REFERENCE_PREFIX.length));
    expect(parsed.content).toEqual([{ type: "image_ref", id: "IMG-001", contentId: createHash("sha256").update(PNG).digest("hex") }]);
    const request = body([user("continue"), { type: "function_call_output", call_id: "call-1", output: answer }]);
    const wrongSession = await onRequest(request, forSession("conversation-B"));
    expect(texts(wrongSession)).toContain("untrusted image payload removed");
    expect(texts(wrongSession)).not.toContain("data:image/");
  });

  test("refuses to guess a session when the handle is absent", async () => {
    await prepareHistory();
    const answer = await fetchImages({ ids: ["IMG-001"] }, { agent: "codex", abort: new AbortController().signal }, options());
    expect(answer).toContain("Pass the session value");
  });

  test("returns an actionable error for unknown ids", async () => {
    await prepareHistory();
    const answer = await fetchImages({ ids: ["IMG-999"], session: keyFor("codex", "thread-test") }, { agent: "codex", abort: new AbortController().signal }, options());
    expect(answer).toContain("not in this conversation");
  });
});
