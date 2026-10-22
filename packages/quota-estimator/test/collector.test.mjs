import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { getJSON, remoteRows, publish } from "../collector.mjs";

test("远端账号过滤与分页：500条之后的数据也计入，归属不明直接拒绝", async () => {
  const calls = [];
  const q = { provider: "claude", user: "remote@example.test" };
  const read = async (base, endpoint, key) => {
    const url = new URL(endpoint, base); calls.push(url);
    assert.equal(key, "fixture-key");
    assert.equal(url.searchParams.get("account"), q.user);
    return { total: 501, rows: Array.from({ length: url.searchParams.get("offset") === "0" ? 500 : 1 },
      () => ({ provider: q.provider, providerAccount: q.user })) };
  };
  const result = await remoteRows("http://127.0.0.1", "fixture-key", q, read);
  assert.equal(result.rows.length, 501); assert.equal(result.partial, false); assert.equal(calls.length, 2);
  await assert.rejects(remoteRows("http://127.0.0.1", "", q, async () => ({ total: 1, rows: [{}] })), /账号归属/);
});

test("只用GET，不跟随携带密钥的重定向，也不在错误里回显密钥或响应", async t => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, auth: req.headers.authorization });
    res.writeHead(302, { Location: "http://127.0.0.1:1/leak" }); res.end("SECRET-BODY");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(getJSON(`http://127.0.0.1:${server.address().port}`, "/v1/magpie/quotas/cards", "secret-test-key"),
    error => error.message === "只读接口返回 HTTP 302");
  assert.deepEqual(seen, [{ method: "GET", auth: "Bearer secret-test-key" }]);
  assert.throws(() => getJSON("http://127.0.0.1", "/v1/magpie/quotas/refresh"), /不允许/);
});

test("端到端：本地与远端分别推算；匿名快照不带密钥、邮箱、请求或会话", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "quota-estimator-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, "config"); await mkdir(configDir);
  const now = Date.parse("2026-10-21T09:00:00Z");
  const q = { provider: "codex", user: "local@example.test", readAt: "2026-10-21T09:00:00Z",
    balance: "1000 credits", windows: [{ name: "7 days", used: 20, resetsAt: "2026-10-27T09:00:00Z" }] };
  const r = { t: "2026-10-21T08:00:00Z", provider: "codex", providerAccount: q.user,
    model: "gpt-test", in: 100, out: 100, status: 200, rid: "PRIVATE-REQUEST", session: "PRIVATE-SESSION" };
  const remote = { ...q, provider: "claude", user: "remote@example.test", windows: [
    { name: "5 hours", used: 50, resetsAt: "2026-10-21T10:00:00Z" },
    { name: "7 days", used: 25, resetsAt: "2026-10-27T09:00:00Z" }] };
  const localClaude = { ...remote, user: "local-claude@example.test" };
  const files = {
    "quotas.json": { account: { quota: q }, claude: { quota: localClaude } }, "quota-history.json": {},
    "providers.json": { providers: [{ preset: "remote-magpie", responses: "http://127.0.0.1:13425/v1", key: "PRIVATE-KEY" }] },
  };
  for (const [name, value] of Object.entries(files)) await writeFile(path.join(configDir, name), JSON.stringify(value));
  await writeFile(path.join(configDir, "usage.jsonl"), [r,
    { ...r, provider: "claude", providerAccount: localClaude.user, rid: "LOCAL-CLAUDE" },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  const catalogFile = path.join(dir, "models.json");
  await writeFile(catalogFile, JSON.stringify({ openai: { models: { "gpt-test": { cost: { input: 2, output: 10 } } } } }));
  const get = async (base, endpoint, key) => {
    assert.equal(base, "http://127.0.0.1:13425"); assert.equal(key, "PRIVATE-KEY");
    if (endpoint.includes("/cards")) return { data: [remote] };
    if (endpoint.includes("/history")) return { data: [] };
    return { total: 1, rows: [{ ...r, provider: "claude", providerAccount: remote.user }] };
  };
  const before = await Promise.all(Object.keys(files).map(name => readFile(path.join(configDir, name), "utf8")));
  const output = path.join(dir, "page/snapshot.js");
  const snapshot = await publish({ configDir, claudeDir: path.join(dir, "claude"), catalogFile, output, now, getJSON: get });
  assert.equal(snapshot.cards.length, 6);
  assert.equal(snapshot.cards[1].tokens, 1000);
  assert.equal(snapshot.cards[2].tokens, 400);
  assert.equal(snapshot.cards[3].tokens, 800);
  assert.match(snapshot.cards[2].title, /本机 Claude/);
  assert.equal(snapshot.cards[4].tokens, 400);
  assert.equal(snapshot.cards[5].tokens, 800);
  assert.match(snapshot.cards[4].title, /Remote magpie/);
  const text = await readFile(output, "utf8");
  for (const secret of [q.user, localClaude.user, remote.user, "PRIVATE-KEY", "PRIVATE-REQUEST", "PRIVATE-SESSION", "providerAccount"]) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.deepEqual(await Promise.all(Object.keys(files).map(name => readFile(path.join(configDir, name), "utf8"))), before);
});

test("远端403不使用其他身份或接口兜底", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "quota-estimator-denied-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "providers.json"), JSON.stringify({ providers: [
    { preset: "remote-magpie", responses: "http://127.0.0.1/v1", key: "key" },
  ] }));
  const endpoints = [];
  const snapshot = await publish({ configDir: dir, claudeDir: path.join(dir, "claude"), catalogFile: path.join(dir, "missing"), output: path.join(dir, "snapshot.js"),
    getJSON: async (base, ep) => { endpoints.push(ep); throw new Error("只读接口返回 HTTP 403"); } });
  assert.deepEqual(endpoints, ["/v1/magpie/quotas/cards"]);
  assert.match(snapshot.cards.at(-1).reason, /403/);
});

test("Claude 缓存缺少身份不影响 Codex，半行或 null 日志不打断采集", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "quota-estimator-identity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const q = { provider: "codex", user: "fixture@example.test", readAt: "2026-10-21T09:00:00Z",
    windows: [{ name: "7 days", used: 20, resetsAt: "2026-10-27T09:00:00Z" }] };
  await writeFile(path.join(dir, "quotas.json"), JSON.stringify({ codex: { quota: q }, claude: { quota: { provider: "claude" } } }));
  await writeFile(path.join(dir, "quota-history.json"), "{}");
  await writeFile(path.join(dir, "providers.json"), '{"providers":[]}');
  await writeFile(path.join(dir, "usage.jsonl"), JSON.stringify({ provider: "codex", providerAccount: q.user,
    t: "2026-10-21T08:00:00Z", in: 100, out: 100, status: 200 }) + '\nnull\n{"t":');
  const snapshot = await publish({ configDir: dir, claudeDir: path.join(dir, "claude"), catalogFile: path.join(dir, "missing"),
    output: path.join(dir, "snapshot.js"), now: Date.parse(q.readAt) });
  assert.equal(snapshot.cards.length, 6);
  assert.equal(snapshot.cards[1].tokens, 1000);
  assert.equal(snapshot.cards[1].partial, true);
  assert.match(snapshot.cards[2].title, /本机 Claude/);
  assert.match(snapshot.cards[2].reason, /身份/);
});

test("本机账号从 Magpie 缓存键读取，冲突身份不用于估算", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "quota-estimator-cache-key-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const user = "fixture@example.test";
  const quota = { provider: "claude", readAt: "2026-10-21T09:00:00Z", windows: [
    { name: "5 hours", used: 50, resetsAt: "2026-10-21T10:00:00Z" },
    { name: "7 days", used: 25, resetsAt: "2026-10-27T09:00:00Z" },
  ] };
  const file = path.join(dir, "quotas.json");
  await writeFile(file, JSON.stringify({ [`claude/${user}`]: { quota } }));
  await writeFile(path.join(dir, "quota-history.json"), "{}");
  await writeFile(path.join(dir, "providers.json"), '{"providers":[]}');
  await writeFile(path.join(dir, "usage.jsonl"), JSON.stringify({ provider: "claude", providerAccount: user,
    t: "2026-10-21T08:00:00Z", in: 100, out: 100, status: 200 }));
  const options = { configDir: dir, claudeDir: path.join(dir, "claude"), catalogFile: path.join(dir, "missing"),
    output: path.join(dir, "snapshot.js"), now: Date.parse(quota.readAt) };
  const snapshot = await publish(options);
  assert.equal(snapshot.cards[2].tokens, 400);
  assert.equal(snapshot.cards[3].tokens, 800);
  assert.ok(!(await readFile(options.output, "utf8")).includes(user));
  await writeFile(file, JSON.stringify({ [`claude/${user}`]: { quota: { ...quota, user: "other@example.test" } } }));
  const conflicting = await publish(options);
  assert.equal(conflicting.cards[2].tokens, null);
  assert.match(conflicting.cards[2].reason, /不一致/);
});
