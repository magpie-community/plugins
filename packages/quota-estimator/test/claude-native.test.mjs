import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readClaudeNative, mergeClaudeRows } from "../claude-native.mjs";
import { publish } from "../collector.mjs";
import { priceRecord, pricesFrom } from "../estimate.mjs";

const user = "native@example.test", org = "11111111-2222-4333-8444-555555555555";
const now = Date.parse("2026-10-21T09:00:00Z");
const since = now - 8 * 86400000;
const prices = pricesFrom({ anthropic: { models: { "claude-test": { cost: { input: 4, output: 20, cache_read: .4, cache_write: 5 } } } } });
const markers = (sessionId = "session-one", email = user, organizationUuid = org, timestamp = "2026-10-21T07:00:00Z") => [
  { type: "attachment", sessionId, timestamp,
    attachment: { type: "session_context", context: { userEmail: `The user's email address is ${email}. Use it only to identify the user.` } } },
  { type: "attachment", sessionId, timestamp, attachment: { type: "credential_org", organizationUuid } },
];
const response = (extra = {}, usage = {}) => ({ type: "assistant", sessionId: "session-one", timestamp: "2026-10-21T08:00:00Z",
  requestId: "req_native-one", message: { id: "msg_native-one", model: "claude-test", role: "assistant", content: [{ type: "text", text: "PRIVATE-CONVERSATION" }],
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 400, cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_1h_input_tokens: 60, ephemeral_5m_input_tokens: 40 }, ...usage } }, ...extra });
const lines = entries => entries.map(x => JSON.stringify(x)).join("\n") + "\n";

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "quota-native-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const claudeDir = path.join(dir, "claude"), project = path.join(claudeDir, "projects", "fixture");
  await mkdir(project, { recursive: true });
  await writeFile(`${claudeDir}.json`, JSON.stringify({ oauthAccount: {
    accountUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", organizationUuid: org, emailAddress: user,
  } }));
  const file = path.join(project, "session.jsonl");
  return { dir, claudeDir, project, file, options: { claudeDir, since, until: now } };
}

test("原生邮箱与凭据组织双重核对；流式块、fork 和子代理副本只计一次", async t => {
  const f = await fixture(t);
  const initial = response({}, { output_tokens: 10 });
  await writeFile(f.file, lines([...markers(), initial, response()]));
  await mkdir(path.join(f.project, "subagents"));
  await writeFile(path.join(f.project, "subagents", "agent.jsonl"), lines([...markers(), response()]));
  const before = await readFile(f.file, "utf8");
  const result = await readClaudeNative(f.options);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].out, 50);
  assert.equal(result.rows[0].providerAccount, user);
  assert.equal(result.rows[0].cache_write, 100);
  assert.equal(result.rows[0].cache_write_1h, 60);
  assert.equal(priceRecord(result.rows[0], prices), .00224);
  assert.match(result.note, /已核对/);
  assert.deepEqual(await readClaudeNative(f.options), result);
  assert.equal(await readFile(f.file, "utf8"), before);
});

test("同目录的无身份会话、其他账号与组织、切换前的记录均不归给当前账号", async t => {
  const f = await fixture(t);
  const rows = [response({ sessionId: "unknown" }), ...markers("other-email", "other@example.test"),
    response({ sessionId: "other-email", requestId: "req_other" }),
    ...markers("other-org", user, "99999999-2222-4333-8444-555555555555"),
    response({ sessionId: "other-org", requestId: "req_org" }),
    response({ timestamp: "2026-10-21T06:00:00Z" }), ...markers(), response(),
    ...markers("session-one", "other@example.test", org, "2026-10-21T08:01:00Z"),
    response({ requestId: "req_after-switch", timestamp: "2026-10-21T08:02:00Z" }),
    { type: "user", sessionId: "unknown", timestamp: "2026-10-21T07:00:00Z", message: markers()[0] }];
  await writeFile(f.file, lines(rows));
  const result = await readClaudeNative(f.options);
  assert.deepEqual(result.rows.map(r => r.rid), ["req_native-one"]);
  assert.equal(result.partial, true);
  const profile = JSON.parse(await readFile(`${f.claudeDir}.json`, "utf8"));
  profile.oauthAccount.emailAddress = "other@example.test";
  await writeFile(`${f.claudeDir}.json`, JSON.stringify(profile));
  const changed = await readClaudeNative(f.options);
  assert.ok(!changed.rows.some(r => r.rid === "req_native-one"));
});

test("网关请求ID与响应ID去重，远端记录不会借原生日志被重归属成本机", () => {
  const native = [
    { rid: "req_same", response_id: "msg_one" }, { rid: "req_two", response_id: "msg_same" },
    { rid: "req_remote", response_id: "msg_remote" }, { rid: "req_new", response_id: "msg_new" },
  ];
  const gateway = [{ provider: "claude", rid: "req_same" }, { provider: "claude", response_id: "msg_same" },
    { provider: "remote-magpie", rid: "req_remote" }];
  assert.deepEqual(mergeClaudeRows(gateway, native), [...gateway, native[3]]);
});

test("增量读取等待半行完成；原文件截断重写后不保留旧请求", async t => {
  const f = await fixture(t);
  await writeFile(f.file, lines([...markers(), response()]));
  assert.equal((await readClaudeNative(f.options)).rows.length, 1);
  const next = JSON.stringify(response({ requestId: "req_next", message: { ...response().message, id: "msg_next" } }));
  await appendFile(f.file, next.slice(0, 30));
  assert.equal((await readClaudeNative(f.options)).rows.length, 1);
  await appendFile(f.file, next.slice(30) + "\n");
  assert.equal((await readClaudeNative(f.options)).rows.length, 2);
  await writeFile(f.file, lines(markers()));
  assert.equal((await readClaudeNative(f.options)).rows.length, 0);
});

test("身份格式异常清除旧归属，异常用量和冲突请求不传播；非标准价格留空", async t => {
  const f = await fixture(t);
  const malformed = markers()[0]; malformed.attachment.context.userEmail = {}; malformed.timestamp = "2026-10-21T08:01:00Z";
  await writeFile(f.file, lines([...markers(), response({}, { input_tokens: -1 }),
    response(), response({}, { cache_read_input_tokens: 999 }),
    malformed, response({ requestId: "req_after-bad-identity", timestamp: "2026-10-21T08:02:00Z" })]));
  const result = await readClaudeNative(f.options);
  assert.equal(result.rows.length, 0);
  assert.equal(result.partial, true);
  await writeFile(f.file, lines([...markers(), response({}, { speed: "fast" })]));
  const fast = await readClaudeNative(f.options);
  assert.equal(fast.rows.length, 1);
  assert.equal(priceRecord(fast.rows[0], prices), null);
});

test("发布两个窗口的原生Token与美元，匿名页面不泄露身份、正文或请求ID", async t => {
  const f = await fixture(t);
  await writeFile(f.file, lines([...markers(), response()]));
  const quota = { provider: "claude", readAt: "2026-10-21T09:00:00Z", windows: [
    { name: "5 hours", used: 25, resetsAt: "2026-10-21T10:00:00Z" },
    { name: "7 days", used: 50, resetsAt: "2026-10-27T09:00:00Z" },
  ] };
  for (const [name, value] of Object.entries({ "quotas.json": { [`claude/${user}`]: { quota } },
    "quota-history.json": {}, "providers.json": { providers: [] } })) {
    await writeFile(path.join(f.dir, name), JSON.stringify(value));
  }
  await writeFile(path.join(f.dir, "usage.jsonl"), "");
  const catalogFile = path.join(f.dir, "models.json");
  await writeFile(catalogFile, JSON.stringify({ anthropic: { models: { "claude-test": { cost: { input: 4, output: 20, cache_read: .4, cache_write: 5 } } } } }));
  const output = path.join(f.dir, "snapshot.js");
  const snapshot = await publish({ configDir: f.dir, claudeDir: f.claudeDir, catalogFile, output, now });
  const [five, week] = snapshot.cards.filter(c => c.title.includes("Claude"));
  assert.equal(five.tokens, 2600); assert.equal(week.tokens, 1300);
  assert.equal(five.cost, .00896); assert.equal(week.cost, .00448);
  assert.equal(five.nativeCalls, 1); assert.match(five.nativeNote, /已核对/);
  const text = await readFile(output, "utf8");
  for (const secret of [user, org, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "PRIVATE-CONVERSATION", "req_native-one", "msg_native-one", "session-one"]) assert.ok(!text.includes(secret), secret);
  await writeFile(path.join(f.dir, "quotas.json"), JSON.stringify({ "claude/another@example.test": { quota } }));
  const mismatch = await publish({ configDir: f.dir, claudeDir: f.claudeDir, catalogFile, output, now });
  const other = mismatch.cards.filter(c => c.title.includes("Claude"));
  assert.ok(other.every(c => c.tokens === null));
  assert.match(other[0].nativeNote, /账号不同/);
});
