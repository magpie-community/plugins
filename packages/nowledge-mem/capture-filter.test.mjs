// Run with node --test or bun test. No network, credentials or live Mem writes.
// Scenario provenance and gateway-only limits: CAPTURE_FILTER.md.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { onRequest, onResponse, reset } from "./nowledge-mem.hooks.mjs";
import { resolveOptions, sha256 } from "./mem.mjs";
import { open, close, notice } from "./conversation.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/cindy-context.json", import.meta.url), "utf8"));
const mixedFixture = JSON.parse(readFileSync(new URL("./fixtures/cindy-scheduled-handoff.json", import.meta.url), "utf8"));
const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });
const reply = (content = "Complete final answer") => ({ choices: [{ finish_reason: "stop", message: assistant(content) }] });
const body = (messages) => ({ model: "fixture-model", stream: true, messages });
const human = { captureFilter: "human", captureCindy: true };
let writes, calls, savedFetch;
beforeEach(() => {
    reset();
    writes = []; calls = [];
    savedFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        if (url.pathname === "/threads/import") {
            writes.push(JSON.parse(init.body));
            return Response.json({ success: true, failed_count: 0, results: [{ success: true }] });
        }
        if (url.pathname === "/memories/search")
            return Response.json([{ memory: { id: "fixture-memory", title: "Past decision", content: "Remembered context" }, similarity_score: 0.9 }]);
        if (url.pathname === "/context/bundle")
            return Response.json({ rendered_markdown: "Fixture owner profile" });
        throw new Error("Unexpected test route");
    };
});
afterEach(() => { globalThis.fetch = savedFetch; reset(); });
function context(options = {}, extra = {}) {
    return {
        protocol: "chat", origin: "local", agent: "cindy", session: "fixture-session", cwd: "/fixture/项目",
        options: { serverUrl: "https://mem.invalid", apiKey: "fixture-key", recall: false, capture: true, ...options },
        state: {}, signal: new AbortController().signal, success: true, report() {}, ...extra,
    };
}
async function capture(request, response = reply(), options = {}, extra = {}) {
    const ctx = context(options, extra);
    const accepted = await onRequest(request, ctx);
    ctx.request = accepted ?? request;
    await onResponse(response, ctx);
    return ctx;
}
const contents = () => writes.at(-1)?.messages.map((m) => m.content);
function freeze(value) {
    if (value && typeof value === "object") {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

// The first three cases are regression witnesses: they must fail on 0.1.1.
test("capture options default off and reject invalid enum/boolean values", () => {
    const defaults = resolveOptions({}, {});
    assert.equal(defaults.captureFilter, "off");
    assert.equal(defaults.captureCindy, false);
    for (const value of ["auto", "Human", "", null, true, 1, {}])
        assert.throws(() => resolveOptions({ captureFilter: value }, {}), /invalid/);
    for (const value of ["true", 1, null])
        assert.throws(() => resolveOptions({ captureCindy: value }, {}), /invalid/);
});
test("human mode excludes tools but retains commentary attached to a tool call", async () => {
    const request = body([
        user("Please inspect the file"),
        { ...assistant("I will inspect the relevant section."), tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call-1", content: "TOOL-ONLY-NOISE" },
    ]);
    await capture(freeze(request), freeze(reply()), { ...human, captureTools: false });
    assert.deepEqual(contents(), ["Please inspect the file", "I will inspect the relevant section.", "Complete final answer"]);
});
test("Cindy stacked notes do not become dialogue or the Thread title (#200)", async () => {
    const request = body([user([fixture.side, fixture.language, fixture.client, fixture.writable, fixture.handoff, "Inspect the capture filter"].join("\n\n"))]);
    const original = structuredClone(request);
    await capture(request, reply(), human);
    assert.deepEqual(contents(), ["Inspect the capture filter", "Complete final answer"]);
    assert.equal(writes[0].title, "Inspect the capture filter");
    assert.deepEqual(request, original);
});

for (const name of ["side", "channel", "client", "language", "writable", "referenceDirectories", "handoff", "rebuild", "fork"]) {
    test(`Cindy recognizes complete ${name} prefix with CRLF`, async () => {
        await capture(body([user(fixture[name].replaceAll("\n", "\r\n") + "\r\n\r\n    indented code\n      remains")]), reply(), human);
        assert.equal(contents()[0], "    indented code\n      remains");
    });
}
test("Cindy group keeps speaker attribution without transport identifiers", async () => {
    await capture(body([user(fixture.group + "\n" + fixture.language + "\n请检查计算公式")]), reply(), human);
    const message = writes[0].messages[0];
    assert.equal(message.content, "发言人「Fixture Guest」：\n请检查计算公式");
    assert.deepEqual(message.metadata.cindy_origin, { channel: "wechat", chat_kind: "group", chat_name: "Fixture Group", sender_name: "Fixture Guest", sender_is_owner: false });
    assert.doesNotMatch(JSON.stringify(writes[0]), /synthetic-group|synthetic-sender|chat_id|user_id/);
});
test("Cindy ownership-only private sender is not attributed to the owner", async () => {
    const prefix = "[渠道说明] 系统追加，不是用户消息。本条来自微信私聊 (chat_id: synthetic-chat)，发言人不是主人。";
    await capture(body([user(prefix + "\nI prefer a different editor")]), reply(), human);
    assert.equal(contents()[0], "发言人（非主人）：\nI prefer a different editor");
    assert.equal(writes[0].messages[0].metadata.cindy_origin.sender_is_owner, false);
});
test("only recognized Cindy + explicit opt-in cleans host notes", async () => {
    const text = fixture.language + "\nKeep the original";
    for (const [options, agent] of [
        [{}, "cindy"], [{ captureFilter: "human" }, "cindy"],
        [{ captureFilter: "off", captureCindy: true }, "cindy"],
        [human, "pi"], [human, "omp"], [human, ""],
    ]) {
        reset(); writes.length = 0;
        await capture(body([user(text)]), reply(), options, { agent });
        assert.equal(contents()[0], text);
    }
});
test("quoted, fenced, incomplete and unknown Cindy-looking notes remain unchanged", async () => {
    const examples = [
        "> " + fixture.language,
        "```text\n" + fixture.client + "\n```",
        "Explain this example:\n" + fixture.language,
        fixture.language.slice(0, -5),
        "[UI language] New unknown template\nUser content",
        fixture.handoff.replace("== End of handoff note; the user's new message follows ==", ""),
        "<cindy-extra-writable-directories>\nnot closed",
        fixture.side + " not a line boundary",
        "[Session fork · internal context]\n```\n== End of fork note; the user's new message follows ==\n```\nStill incomplete",
    ];
    await capture(body(examples.map(user)), reply(), human);
    assert.deepEqual(contents().slice(0, -1), examples);
});
test("scheduled and partner handoff examples stay intact when source boundaries are unknown", async () => {
    for (const text of [mixedFixture.scheduled, mixedFixture.handoff, fixture.language + "\n" + mixedFixture.scheduled, fixture.language + "\n" + mixedFixture.handoff]) {
        reset(); writes.length = 0;
        await capture(body([user(text)]), reply(), human);
        assert.equal(contents()[0], text);
        assert.equal(writes[0].messages[0].role, "user"); // The transport role is not proof of authorship.
        assert.equal(writes[0].messages[0].metadata.cindy_origin, undefined);
    }
    assert.ok(mixedFixture.handoff.includes(mixedFixture.constraint));
    assert.ok(mixedFixture.handoff.includes(mixedFixture.objective));
});
test("mixed-source examples keep legacy message IDs across filter settings", async () => {
    const text = fixture.language + "\n" + mixedFixture.handoff;
    const ids = [];
    for (const options of [{}, { captureFilter: "human" }, human]) {
        reset(); writes.length = 0;
        await capture(body([user(text)]), reply(), options);
        const payload = writes[0];
        assert.equal(payload.messages[0].content, text);
        ids.push(payload.messages[0].metadata.external_id);
        assert.equal(ids.at(-1), `magpie:${sha256(payload.thread_id, "0", "user", text.trim()).slice(0, 24)}`);
    }
    assert.deepEqual(ids, [ids[0], ids[0], ids[0]]);
});
test("mentions, quotes, fenced examples and incomplete mixed wrappers do not trigger removal", async () => {
    const examples = [
        "Please explain [Task delivery] and keep all task constraints.",
        "> " + mixedFixture.handoff.replaceAll("\n", "\n> "),
        "```text\n" + mixedFixture.scheduled + "\n```",
        "[Task delivery]\nIncomplete example: retain this task.",
        fixture.language + "\n[Task delivery]\nA user-pasted example with a constraint.",
    ];
    await capture(body(examples.map(user)), reply(), human);
    assert.deepEqual(contents().slice(0, -1), examples);
});
test("assistant quotes of host notes are never cleaned", async () => {
    await capture(body([user("Explain the template")]), reply(fixture.language), human);
    assert.equal(contents()[1], fixture.language);
});
test("a notes-only exchange is skipped, not an assistant-only Thread", async () => {
    const reports = [];
    await capture(body([user(fixture.language)]), reply(), human, { report: (...args) => reports.push(args) });
    assert.equal(writes.length, 0);
    assert.equal(reports.at(-1)?.[0], "skipped");
});
test("filter keeps complete long CJK text and attachment captions, not image bytes", async () => {
    const long = "中文完整记录🙂".repeat(4000);
    const request = body([user([{ type: "text", text: fixture.language + "\n" + long }, { type: "image_url", image_url: { url: "data:image/png;base64,fixture" } }, { type: "text", text: "图：设备铭牌" }])]);
    await capture(request, reply("完整答复"), human);
    assert.equal(contents()[0], long + "\n图：设备铭牌");
    assert.doesNotMatch(JSON.stringify(writes[0]), /base64|\[image\]/);
});
test("multiple text parts keep indentation after host-prefix removal", async () => {
    await capture(body([user([{ type: "text", text: fixture.language }, { type: "text", text: "    first\n      second" }])]), reply(), human);
    assert.equal(contents()[0], "    first\n      second");
});
test("repeated real messages retain distinct occurrence IDs and replay is idempotent", async () => {
    const request = body([user(fixture.language + "\nAgain"), assistant("Previous reply"), user(fixture.language + "\nAgain")]);
    await capture(structuredClone(request), reply(), human);
    const first = structuredClone(writes[0]);
    assert.notEqual(first.messages[0].metadata.external_id, first.messages[2].metadata.external_id);
    await capture(structuredClone(request), reply(), human);
    assert.equal(writes.length, 1);
    const next = body([...request.messages, assistant("Complete final answer"), user("New turn")]);
    await capture(next, reply("Next answer"), human);
    assert.equal(writes[1].thread_id, first.thread_id);
    assert.deepEqual(writes[1].messages.slice(0, 4), first.messages);
    assert.equal(writes[1].title, first.title);
});
test("filter preserves Space and Agent provenance", async () => {
    await capture(body([user(fixture.language + "\nDo the work")]), reply(), { ...human, spaceId: "fixture-space", agentId: "fixture-profile", hostAgentId: "fixture-host" });
    assert.equal(writes[0].space_id, "fixture-space");
    assert.equal(writes[0].metadata.agent, "cindy");
    assert.equal(writes[0].metadata.agent_id, "fixture-profile");
    assert.equal(writes[0].metadata.host_agent_id, "fixture-host");
    assert.equal(writes[0].metadata.cwd, sha256("/fixture/项目"));
});
test("no native metadata: preserve inherited side-chat history and internal-looking user text", async () => {
    await capture(body([user("Parent request"), assistant("Parent reply"), user(fixture.side + "\nNew question"), user("Continue the plan. This is an internal summary.")]), reply(), human);
    assert.deepEqual(contents(), ["Parent request", "Parent reply", "New question", "Continue the plan. This is an internal summary.", "Complete final answer"]);
});
test("human mode never bypasses the original credential guard, including removed content", async () => {
    for (const request of [
        body([user(fixture.handoff.replace("Synthetic history index", "api_key=not-a-real-key") + "\nSafe question")]),
        body([user("Question"), { ...assistant("Working"), tool_calls: [{ id: "s", type: "function", function: { name: "read", arguments: '{"token":"not-a-real-key"}' } }] }, { role: "tool", tool_call_id: "s", content: "safe" }]),
    ]) {
        await capture(request, reply(), human);
        assert.equal(writes.length, 0);
    }
});
test("unsettled tools and incomplete output remain ineligible before filtering", async () => {
    const pending = body([user("Do work"), { ...assistant("Working"), tool_calls: [{ id: "p", type: "function", function: { name: "read", arguments: "{}" } }] }]);
    await capture(pending, reply(), human);
    await capture(body([user("Question")]), { choices: [{ finish_reason: "length", message: assistant("Partial") }] }, human);
    assert.equal(writes.length, 0);
});
test("capture remains opt-in and never broadens the source allowlist", async () => {
    for (const origin of ["gateway-key", "remote", undefined])
        await capture(body([user("Question")]), reply(), human, { origin });
    await capture(body([user("Question")]), reply(), { ...human, capture: false });
    assert.equal(writes.length, 0);
    await capture(body([user("Question")]), reply(), human, { origin: "magpie-key" });
    assert.equal(writes.length, 1);
});
test("read-side recall, tools and live replies are unaffected by capture filtering (#161)", async () => {
    const make = () => ({ ...body([user(fixture.language + "\nQuestion")]), tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }] });
    const originalReply = freeze(reply());
    const off = await capture(make(), originalReply, { recall: true });
    const expected = structuredClone(off.request);
    reset();
    const filtered = await capture(make(), originalReply, { ...human, recall: true });
    assert.deepEqual(filtered.request, expected);
    assert.equal(contents()[0], "Question");
    assert.doesNotMatch(JSON.stringify(writes.at(-1)), /Remembered context|Fixture owner profile/);
});
test("large captures retain the existing UTF-8 size guard (#756, #698)", async () => {
    await capture(body([user("中".repeat(180000))]), reply(), human);
    assert.equal(writes.length, 0);
    await capture(body([user("z".repeat(490000))]), reply(), human);
    assert.equal(contents()[0].length, 490000);
});
test("a failed import is not acknowledged as a successful filtered replay (#459)", async () => {
    const original = globalThis.fetch;
    let fail = true;
    globalThis.fetch = async (url, init) => fail && url.pathname === "/threads/import" ? Response.json({ success: false, failed_count: 1 }) : original(url, init);
    const request = () => body([user(fixture.language + "\nKeep this")]);
    await capture(request(), reply(), human);
    assert.equal(writes.length, 0);
    fail = false;
    await capture(request(), reply(), human);
    assert.equal(writes.length, 1);
});

for (const protocol of ["responses", "anthropic", "gemini"]) {
    test(`human ${protocol} capture keeps final text, not thinking or tool results (#544 / #182)`, async () => {
        const prompt = fixture.language + "\nQuestion";
        const request = protocol === "responses" ? { model: "m", input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }] }
            : protocol === "anthropic" ? { model: "m", messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] }
            : { contents: [{ role: "user", parts: [{ text: prompt }] }] };
        const response = protocol === "responses" ? { status: "completed", output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "THINKING" }] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "Final part one" }, { type: "output_text", text: "Final part two" }] }] }
            : protocol === "anthropic" ? { role: "assistant", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "THINKING" }, { type: "text", text: "Final part one" }, { type: "text", text: "Final part two" }] }
            : { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ thought: true, text: "THINKING" }, { text: "Final part one" }, { text: "Final part two" }] } }] };
        await capture(freeze(request), freeze(response), human, { protocol });
        assert.deepEqual(contents(), ["Question", "Final part one\nFinal part two"]);
    });
}

test("OMP wire projection matches #782's dialogue oracle for information present on the wire", async () => {
    const oracle = JSON.parse(readFileSync(new URL("./fixtures/dialogue-projection.json", import.meta.url), "utf8"));
    // Native attribution/custom records do not exist here. A literal slash command
    // is retained; an expanded skill cannot be reconstructed by this gateway.
    const request = body([
        { role: "system", content: "INTERNAL system instructions" },
        user("Synthetic human question"),
        { ...assistant("I will check the change"), tool_calls: [{ id: "oracle-read", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "oracle-read", content: "INTERNAL tool output" },
        { ...assistant("Synthetic assistant answer"), reasoning_content: "INTERNAL thinking" },
        user("/skill:review fixture"),
        user([{ type: "text", text: "Look at these" }, { type: "image_url", image_url: { url: "data:image/png;base64,INTERNAL" } }, { type: "file", file: { file_data: "INTERNAL", filename: "fixture.txt" } }]),
    ]);
    await capture(freeze(request), freeze(reply("I reviewed the attachments")), { captureFilter: "human" }, { agent: "omp" });
    assert.deepEqual(writes[0].messages.map(({ role, content }) => ({ role, content })), oracle.messages);
    assert.doesNotMatch(JSON.stringify(writes[0]), /INTERNAL|\[image\]|\[file\]/);
});
test("default-off capture retains the legacy tool result and whitespace policy", async () => {
    const request = body([user("  Question  "), { ...assistant("  Working  "), tool_calls: [{ id: "legacy", type: "function", function: { name: "read", arguments: "{}" } }] }, { role: "tool", tool_call_id: "legacy", content: "  Result  " }]);
    await capture(request, reply("  Done  "));
    assert.deepEqual(contents(), ["Question", "Working", "Result", "Done"]);
    reset(); writes.length = 0;
    await capture(request, reply("  Done  "), { captureTools: false });
    assert.deepEqual(contents(), ["Question", "Done"]);
});
test("human mode excludes tool results even when legacy captureTools is true", async () => {
    const request = body([user("Question"), { ...assistant("Working"), tool_calls: [{ id: "t", type: "function", function: { name: "read", arguments: "{}" } }] }, { role: "tool", tool_call_id: "t", content: "NOISE" }]);
    await capture(request, reply(), { captureFilter: "human", captureTools: true });
    assert.deepEqual(contents(), ["Question", "Working", "Complete final answer"]);
});
test("Cindy current and legacy mobile notes are opt-in complete templates", async () => {
    const current = fixture.client.replace("另一台电脑", "手机") + fixture.mobilePreference;
    const legacy = "[客户端说明] 以下为系统每轮自动追加的环境说明,不是用户发来的消息;回复时不要把它当作用户的请求,也不要引用、复述或据此臆测用户意图。本轮请求来自手机客户端(小屏、远程查看被控电脑上的文件)。" + fixture.mobilePreference;
    await capture(body([user(current + "\n  First"), user(legacy + "\n  Second")]), reply(), human);
    assert.deepEqual(contents(), ["  First", "  Second", "Complete final answer"]);
});
test("Cindy stripping stops at unknown text instead of scanning later paragraphs", async () => {
    const rest = "[Unknown host note]\nDo not remove this\n" + fixture.language + "\nQuestion";
    await capture(body([user(fixture.client + "\n" + rest)]), reply(), human);
    assert.equal(contents()[0], rest);
});
test("oversized Cindy wrapper is retained rather than partially stripped", async () => {
    const wrapper = "[Session handoff · internal context]\n" + "x".repeat(66000) + "\n== End of handoff note; the user's new message follows ==\nQuestion";
    const grant = "<cindy-extra-writable-directories>\n" + "中".repeat(66000) + "\n</cindy-extra-writable-directories>\nQuestion";
    await capture(body([user(wrapper), user(grant)]), reply(), human);
    assert.deepEqual(contents(), [wrapper, grant, "Complete final answer"]);
});
test("Cindy stacked prefix work is bounded and the unprocessed suffix survives", async () => {
    const text = (fixture.language + "\n").repeat(33) + "Question";
    await capture(body([user(text)]), reply(), human);
    assert.equal(contents()[0], fixture.language + "\nQuestion");
});
test("a standalone removed note does not renumber retained occurrences", async () => {
    const request = body([user(fixture.language), user("Real task")]);
    await capture(request, reply(), human);
    const saved = writes[0];
    assert.equal(saved.title, "Real task");
    assert.equal(saved.messages[0].metadata.external_id, `magpie:${sha256(saved.thread_id, "1", "user", "Real task").slice(0, 24)}`);
});
for (const protocol of ["chat", "responses", "anthropic", "gemini"]) {
    test(`${protocol} message IDs survive filtering and Cindy option changes`, async () => {
        const raw = `${fixture.language}\nQuestion  `;
        const request = protocol === "chat" ? body([user(raw)])
            : protocol === "responses" ? { input: [user(raw)] }
            : protocol === "anthropic" ? { messages: [user(raw)] }
            : { contents: [{ role: "user", parts: [{ text: raw }] }] };
        const response = protocol === "chat" ? reply("  Done  ")
            : protocol === "responses" ? { status: "completed", output: [{ type: "message", ...assistant("  Done  ") }] }
            : protocol === "anthropic" ? { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "  Done  " }] }
            : { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "  Done  " }] } }] };
        for (const options of [{}, { captureFilter: "human" }, human, { captureFilter: "off", captureCindy: true }]) {
            reset(); // Allow an identical projection to be observed again.
            await capture(structuredClone(request), structuredClone(response), options, { protocol });
        }
        assert.equal(writes.length, 4);
        const ids = writes.map(({ messages }) => messages.map(({ metadata }) => metadata.external_id));
        assert.deepEqual(ids[1], ids[0]);
        assert.deepEqual(ids[2], ids[0]);
        assert.deepEqual(ids[3], ids[0]);
        assert.equal(ids[0][0], `magpie:${sha256(writes[0].thread_id, "0", "user", raw.trim()).slice(0, 24)}`);
        assert.equal(ids[0][1], `magpie:${sha256(writes[0].thread_id, "1", "assistant", "Done").slice(0, 24)}`);
        assert.notEqual(writes[2].messages[0].content, writes[0].messages[0].content);
    });
}
test("native-only OMP information is not guessed from user wording or missing wire metadata", async () => {
    const text = "INTERNAL continuation\nExpanded SKILL.md text supplied to the model";
    await capture(body([user(text)]), reply(), { captureFilter: "human" }, { agent: "omp" });
    assert.equal(contents()[0], text);
});
for (const protocol of ["anthropic", "gemini", "responses"]) {
    test(`${protocol} settled tools keep commentary and final answers without tool output`, async () => {
        const request = protocol === "anthropic" ? { messages: [user("Question"), { role: "assistant", content: [{ type: "text", text: "Working" }, { type: "tool_use", id: "c", name: "read", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "TOOL NOISE" }] }] }
            : protocol === "gemini" ? { contents: [{ role: "user", parts: [{ text: "Question" }] }, { role: "model", parts: [{ text: "Working" }, { functionCall: { id: "c", name: "read", args: {} } }] }, { role: "user", parts: [{ functionResponse: { id: "c", name: "read", response: { text: "TOOL NOISE" } } }] }] }
            : { input: [user("Question"), { type: "message", ...assistant("Working") }, { type: "function_call", name: "read", call_id: "c", arguments: "{}" }, { type: "function_call_output", call_id: "c", output: "TOOL NOISE" }] };
        const response = protocol === "anthropic" ? { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] }
            : protocol === "gemini" ? { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "Done" }] } }] }
            : { status: "completed", output: [{ type: "message", ...assistant("Done") }] };
        await capture(freeze(request), freeze(response), { captureFilter: "human" }, { protocol });
        assert.deepEqual(contents(), ["Question", "Working", "Done"]);
    });
}

test("published manifest includes the filter runtime and backward-compatible defaults", async () => {
    const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    const { version } = await import("./mem.mjs");
    assert.equal(pkg.version, version);
    assert.equal(pkg.magpie.options.captureFilter, "off");
    assert.equal(pkg.magpie.options.captureCindy, false);
    assert.ok(pkg.files.includes("capture-filter.mjs"));
    assert.ok(pkg.files.includes("CAPTURE_FILTER.md"));
});
