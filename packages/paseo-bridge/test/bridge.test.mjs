import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { onRequest, onResponse } from "../paseo-bridge.hooks.mjs";

const session = "codex-test-session";
const messageId = "opaque.message.id";
const responseId = "opaque.response.id";
const context = { success: true, origin: "local", protocol: "responses", agent: "codex", kind: "", path: "/v1/responses", session };
const message = { id: messageId, type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "PRIVATE_REPLY" }] };
const reply = { object: "response", status: "completed", id: responseId, output: [message] };
const row = {
  agent: "codex", session, responseId, done: true, status: 200,
  provider: "original-provider", served: "vendor/model-2026",
  callerKey: "PRIVATE_KEY", callerName: "PRIVATE_ACCOUNT",
  order: [{ id: "private@account.example", provider: "fallback-provider", who: "PRIVATE_ACCOUNT" }],
  left: [{ id: "secret-seat", provider: "primary-provider", who: "PRIVATE_ACCOUNT" }],
  tries: [
    { id: "secret-seat", model: "primary-model", status: 429, done: true, error: "PRIVATE_ERROR" },
    { id: "secret-seat", model: "primary-model", done: true, fail: "PRIVATE_ERROR" },
    { id: "private@account.example", model: "vendor/model", status: 200, done: true, served: "vendor/model-2026" },
  ],
};
const record = {
  version: 1, provider: "fallback-provider", model: "vendor/model-2026",
  attempts: [
    { route: "primary-provider/primary-model", status: 429, failed: true },
    { route: "primary-provider/primary-model", failed: true },
    { route: "fallback-provider/vendor/model", status: 200, failed: false },
  ],
};
let config, magpie, bridge, index, server, requests, replyTrace, addr;
function recordPath(id = messageId) {
  const hash = createHash("sha256").update(session).update("\0").update(id).digest("hex");
  return join(index, `${hash}.json`);
}

before(async () => {
  config = await mkdtemp(join(tmpdir(), "paseo-bridge-unit-"));
  process.env.XDG_CONFIG_HOME = config;
  magpie = join(config, "magpie");
  bridge = join(magpie, "paseo-bridge");
  index = join(bridge, "v1");
  await mkdir(magpie, { mode: 0o700 });
  server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    replyTrace(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  addr = `127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(config, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(bridge, { recursive: true, force: true });
  process.env.MAGPIE_ADDR = addr;
  requests = [];
  useTrace();
});

function useTrace(routes = [row]) {
  replyTrace = (response) => response.end(JSON.stringify({ object: "trace", routes }));
}

test("publishes only the exact completed route and redacts trace fields", async () => {
  assert.equal(onRequest({ model: "same" }, context), undefined);
  useTrace([
    { ...row, titleLink: { scope: "PRIVATE_DIGEST", prompt: "PRIVATE_DIGEST" } },
    { ...row, session: "other-session", served: "other-model" },
    { ...row, responseId: "other-response", served: "other-model" },
    { ...row, responseId: undefined },
  ]);
  await onResponse(reply, { ...context, request: { input: "PRIVATE_REQUEST" } });
  assert.deepEqual(requests, [{ url: "/v1/magpie/trace", authorization: undefined }]);
  const bytes = await readFile(recordPath(), "utf8");
  assert.deepEqual(JSON.parse(bytes), record);
  assert.doesNotMatch(bytes, /PRIVATE_|secret-seat|private@account|opaque\.|codex-test-session/);
  assert.equal((await lstat(recordPath())).mode & 0o777, 0o600);
  assert.equal((await lstat(recordPath())).nlink, 1);
  assert.equal((await lstat(bridge)).mode & 0o777, 0o700);
  assert.equal((await lstat(index)).mode & 0o777, 0o700);
});

test("skips non-Codex, subagent, unnamed and untrusted hook contexts", async () => {
  const invalid = [
    { agent: "claude" }, { kind: "subagent" }, { kind: undefined }, { origin: "remote" },
    { origin: "gateway-key" }, { origin: undefined }, { protocol: "chat" },
    { session: "" }, { session: "unsafe\0session" }, { success: false }, { path: "/v1/responses/compact" },
  ];
  for (const override of invalid) await onResponse(reply, { ...context, ...override });
  assert.deepEqual(requests, []);
});

test("skips tool rounds, commentary, incomplete replies and ambiguous output", async () => {
  for (const variant of [
    { status: "incomplete" }, { id: undefined }, { output: [{ ...message, phase: "commentary" }] },
    { output: [message, { type: "function_call" }] }, { output: [{ ...message, id: undefined }] },
    { output: [message, message] }, { output: [message, { ...message, id: "second" }] },
    { output: [{ ...message, role: "user" }] }, { output: [{ ...message, status: "incomplete" }] },
  ]) await onResponse({ ...reply, ...variant }, context);
  assert.deepEqual(requests, []);
  await onResponse({ ...reply, output: [{ ...message, id: "commentary", phase: "commentary" }, { ...message, phase: undefined }] }, context);
  assert.deepEqual(JSON.parse(await readFile(recordPath(), "utf8")), record);
});

test("requires exactly one successful main trace and a resolvable winning seat", async () => {
  for (const routes of [
    [{ ...row, responseId: undefined }], [{ ...row, done: false }], [{ ...row, status: 500 }],
    [{ ...row, canceled: true }], [{ ...row, error: "PRIVATE_ERROR" }], [{ ...row, kind: "thread_title" }],
    [{ ...row, kind: "collab_spawn" }], [{ ...row, agent: "claude" }], [{ ...row, parentSession: "parent" }],
    [row, { ...row, done: false }], [{ ...row, order: [] }],
    [{ ...row, order: [...row.order, { ...row.order[0], provider: "has-conflicting-provider" }] }],
    [{ ...row, order: [{ ...row.order[0], provider: "sk-key-fixture" }] }],
    [{ ...row, order: [{ ...row.order[0], provider: "user@account.example" }] }],
    [{ ...row, served: "sk-key-fixture", tries: row.tries.map((attempt) => ({ ...attempt, served: undefined })) }],
  ]) {
    useTrace(routes);
    await onResponse(reply, context);
  }
  await assert.rejects(lstat(index), { code: "ENOENT" });
});

test("does not follow unsafe dirs, files or hard links", async () => {
  const outside = await mkdtemp(join(config, "outside-"));
  await symlink(outside, bridge);
  await onResponse(reply, context);
  assert.deepEqual(await readdir(outside), []);

  await rm(bridge);
  await mkdir(index, { recursive: true, mode: 0o700 });
  await chmod(bridge, 0o755);
  await onResponse(reply, context);
  assert.deepEqual(await readdir(index), []);
  await chmod(bridge, 0o700);
  const external = join(outside, "outside.json");
  await writeFile(external, "unchanged", { mode: 0o600 });
  await symlink(external, recordPath());
  await onResponse(reply, context);
  assert.equal((await lstat(recordPath())).isSymbolicLink(), true);
  await rm(recordPath());
  await link(external, recordPath());
  await onResponse(reply, context);
  assert.equal((await lstat(recordPath())).nlink, 2);
  assert.equal(await readFile(external, "utf8"), "unchanged");
});

test("deduplicates concurrent notifications and suppresses conflicting metadata", async () => {
  await Promise.all(Array.from({ length: 12 }, () => onResponse(reply, context)));
  const original = await lstat(recordPath());
  await onResponse(reply, context);
  assert.equal((await lstat(recordPath())).mtimeMs, original.mtimeMs);
  assert.deepEqual(await readdir(index), [recordPath().split("/").at(-1)]);
  useTrace([{ ...row, served: "another-model", tries: row.tries.map((attempt) => ({ ...attempt, served: undefined })) }]);
  await onResponse(reply, context);
  assert.deepEqual(JSON.parse(await readFile(recordPath(), "utf8")), {});
  useTrace();
  await onResponse(reply, context);
  assert.deepEqual(JSON.parse(await readFile(recordPath(), "utf8")), {});
});

test("expires private records lazily and bounds each cleanup", async () => {
  await mkdir(index, { recursive: true, mode: 0o700 });
  await chmod(bridge, 0o700);
  const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await Promise.all(Array.from({ length: 34 }, async (_, id) => {
    const path = recordPath(`old-${id}`);
    await writeFile(path, "{}", { mode: 0o600 });
    await utimes(path, expired, expired);
  }));
  await writeFile(join(index, "unrelated-file"), "leave", { mode: 0o600 });
  await onResponse(reply, context);
  assert.equal((await readdir(index)).length, 4);
  await onResponse(reply, context);
  assert.deepEqual((await readdir(index)).sort(), [recordPath().split("/").at(-1), "unrelated-file"]);
});

test("stops admitting new keys at capacity until entries expire", async () => {
  await mkdir(index, { recursive: true, mode: 0o700 });
  await chmod(bridge, 0o700);
  for (let id = 0; id < 4096; id++) {
    await writeFile(recordPath(`retained-${id}`), "{}", { mode: 0o600 });
  }
  await onResponse(reply, context);
  await assert.rejects(lstat(recordPath()), { code: "ENOENT" });
  assert.equal((await readdir(index)).length, 4096);
  const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(recordPath("retained-0"), expired, expired);
  await onResponse(reply, context);
  assert.deepEqual(JSON.parse(await readFile(recordPath(), "utf8")), record);
  assert.equal((await readdir(index)).length, 4096);
});

test("query is loopback-only, redirect-free, bounded and abortable", async () => {
  process.env.MAGPIE_ADDR = "example.com:443";
  await onResponse(reply, context);
  assert.deepEqual(requests, []);
  process.env.MAGPIE_ADDR = addr;
  replyTrace = (response) => response.writeHead(307, { location: `http://${addr}/redirected` }).end();
  await onResponse(reply, context);
  assert.equal(requests.length, 1);
  replyTrace = (response) => response.end(Buffer.alloc(4 * 1024 * 1024 + 1));
  await onResponse(reply, context);
  replyTrace = () => {};
  await onResponse(reply, { ...context, signal: AbortSignal.timeout(40) });
  await assert.rejects(lstat(index), { code: "ENOENT" });
});
