import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseThread, projectThread } from "../lib/parser.mjs";
const at = "2026-03-30T15:07:33.890Z";
const usage = {
  model: "claude-opus-4-6",
  timestamp: at,
  inputTokens: 1,
  outputTokens: 189,
  cacheCreationInputTokens: 661,
  cacheReadInputTokens: 40653,
};
const message = (id = 1, patch = {}) => ({
  role: "assistant",
  messageId: id,
  state: { type: "complete" },
  usage: { ...usage, ...patch },
});
const thread = (messages = [message()], events = []) => ({
  id: "T-test",
  messages,
  usageLedger: { events },
});
const event = (patch = {}) => ({
  model: usage.model,
  timestamp: at,
  toMessageId: 1,
  // Real Amp ledger events carry input/output only.
  tokens: { input: 1, output: 189 },
  ...patch,
});

test("real redacted Amp metadata maps cache separately and ignores credits", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("fixtures/amp-local.json", import.meta.url)),
  );
  const { records } = parseThread(fixture);
  assert.ok(records.length > 0);
  const r = records[0];
  const u = fixture.messages[0].usage;
  assert.equal(r.in, u.inputTokens);
  assert.equal(r.out, u.outputTokens);
  assert.equal(r.cache_read, u.cacheReadInputTokens);
  assert.equal(r.cache_write, u.cacheCreationInputTokens);
  assert.equal(r.cost, undefined);
  assert.equal(r.agent, "amp");
});
test("partial ledger and messages count each call once", () => {
  const t = thread([message(), message(2, { outputTokens: 200 })], [event()]);
  const r = parseThread(t).records;
  assert.equal(r.length, 2);
  assert.deepEqual(
    r.map((x) => x.out),
    [189, 200],
  );
});
test("message ID match wins over token mismatch and remains stable as ledger appears", () => {
  const a = parseThread(thread()).records[0];
  const b = parseThread(
    thread([message()], [event({ tokens: { input: 2, output: 190 } })]),
  ).records[0];
  assert.equal(a.rid, b.rid);
  assert.equal(b.out, 190);
});
test("ledger missing timestamp uses matching message timestamp", () => {
  assert.equal(
    parseThread(thread([message()], [event({ timestamp: undefined })]))
      .records[0].t,
    at,
  );
});
test("never uses file mtime or synthetic thread dates", () => {
  const t = {
    ...thread([message(1, { timestamp: undefined })]),
    created: Date.now(),
  };
  assert.equal(parseThread(t).records.length, 0);
  assert.equal(parseThread(t).issues.missingTimestamp, 1);
});
test("a call without a time takes the moment its turn was sent", () => {
  const bare = (id) => message(id, { timestamp: undefined });
  const t = thread([
    bare(1),
    { role: "user", sentAt: Date.parse(at) },
    bare(2),
    { role: "user" },
    bare(3),
  ]);
  const r = parseThread(t);
  assert.deepEqual(
    r.records.map((x) => x.t),
    [at, at],
  );
  assert.equal(r.issues.missingTimestamp, 1);
  const raw = {
    ...t,
    messages: [{ role: "user", meta: { sentAt: Date.parse(at) } }, bare(2)],
  };
  assert.equal(parseThread(projectThread(raw)).records[0].t, at);
});
test("identical token counts at different times are distinct calls", () => {
  const t = thread(
    [message(2, { timestamp: "2026-03-31T15:07:33.890Z" })],
    [event({ id: "e1", operationType: "title-generation" })],
  );
  assert.equal(parseThread(t).records.length, 2);
});
test("equal ledger events are told apart by their own IDs, or held without one", () => {
  const search = (id) => event({ id, operationType: "codebase-search" });
  const r = parseThread(thread([], [search("e1"), search("e2"), search()]));
  assert.equal(r.records.length, 2);
  assert.notEqual(r.records[0].rid, r.records[1].rid);
  assert.equal(r.issues.missingIdentity, 1);
});
test("a matched ledger event keeps the message's cache tokens", () => {
  for (const events of [[event()], [event({ toMessageId: undefined })]]) {
    const r = parseThread(thread([message()], events)).records;
    assert.equal(r.length, 1);
    assert.equal(r[0].cache_read, 40653);
    assert.equal(r[0].cache_write, 661);
  }
});
test("a subagent's calls are counted in its own thread only", () => {
  const r = parseThread(
    thread(
      [],
      [
        event({
          id: "e1",
          operationType: "subagent",
          subagentThreadID: "T-sub",
        }),
      ],
    ),
  );
  assert.equal(r.records.length, 0);
  assert.equal(r.issues.subagentThread, 1);
});
test("unfinished, fresh, invalid and zero usage do not reach the ledger", () => {
  const t = thread([
    { ...message(), state: { type: "streaming" } },
    message(2, { timestamp: new Date().toISOString() }),
    message(3, { inputTokens: -1 }),
    message(4, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    }),
  ]);
  const r = parseThread(t);
  assert.equal(r.records.length, 0);
  assert.deepEqual(r.issues, { invalidUsage: 1, unfinished: 1, settling: 1 });
});
test("conflicting repeated message IDs are held, even with three copies", () => {
  const r = parseThread(
    thread([
      message(),
      message(1, { inputTokens: 2 }),
      message(1, { inputTokens: 3 }),
    ]),
  );
  assert.equal(r.records.length, 0);
  assert.ok(r.issues.conflictingIdentity);
});
test("projection excludes prompts, paths, identities and credits", () => {
  const t = thread(
    [
      {
        ...message(),
        content: [{ text: "private" }],
        usage: { ...usage, credits: 9 },
      },
    ],
    [event({ secret: "private" })],
  );
  t.title = "private";
  t.env = { path: "private" };
  const s = JSON.stringify(projectThread(t));
  assert.ok(!s.includes("private"));
  assert.ok(!s.includes("credits"));
});
test("search and subagent ledger calls sharing a message boundary stay distinct", () => {
  const r = parseThread(
    thread(
      [message()],
      [
        event({ operationType: "inference" }),
        event({
          id: "e2",
          operationType: "codebase-search",
          model: "gemini-3-flash-preview",
          tokens: { input: 0, output: 415 },
          timestamp: "2026-03-30T15:07:40Z",
        }),
        event({
          id: "e3",
          operationType: "subagent",
          tokens: { input: 40, output: 497 },
          timestamp: "2026-03-30T15:08:00Z",
        }),
      ],
    ),
  );
  assert.equal(r.records.length, 3);
  assert.equal(r.issues.conflictingIdentity, undefined);
  assert.equal(new Set(r.records.map((x) => x.rid)).size, 3);
});
