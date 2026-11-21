import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Search1APIPlugin } from "../index.mjs";
import { restedUntil } from "../src/pool.ts";
import { context } from "./helpers.mjs";

const baseUrl = "https://search1api.invalid";

const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers });
const ok = () => json({ results: [{ title: "Example", link: "https://example.com/" }] });
const refused = (status, retryAfter) =>
  json({ error: "fixture-secret-must-not-leak" }, status,
    retryAfter === undefined ? {} : { "Retry-After": String(retryAfter) });
const api = (key) => ({ type: "api", key });
const oauth = (access, refresh, expires) => ({
  type: "oauth", access, refresh, expires,
  clientId: "fixture-client", tokenEndpoint: baseUrl + "/token", issuer: baseUrl,
});

// Every fetch is replaced: no real API or OAuth service is reached and no
// credential is real. Only the token endpoint answers a refresh.
async function stub(t, reply) {
  const directory = await mkdtemp(join(tmpdir(), "search1api-accounts-test-"));
  const authPath = join(directory, "plugin-auth.json");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.SEARCH1API_API_KEY;
  delete process.env.SEARCH1API_API_KEY;
  const calls = [];
  const refreshes = [];
  const writes = [];
  const state = { rejectRefresh: false };
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    assert.equal(target.origin, baseUrl);
    if (target.pathname === "/token") {
      const form = new URLSearchParams(init.body);
      refreshes.push(form.get("refresh_token"));
      if (state.rejectRefresh)
        return json({ error: "invalid_grant", private: "must-not-appear" }, 400);
      const issued = "refreshed-" + refreshes.length;
      return json({ access_token: issued, refresh_token: "rotated-" + refreshes.length, expires_in: 3600 });
    }
    const call = {
      path: target.pathname,
      token: String(init.headers.Authorization ?? "").replace("Bearer ", ""),
      body: JSON.parse(init.body),
      signal: init.signal,
    };
    calls.push(call);
    return reply(call, calls.length);
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.SEARCH1API_API_KEY;
    else process.env.SEARCH1API_API_KEY = originalKey;
    await rm(directory, { recursive: true, force: true });
  });
  const readAll = async () => {
    try {
      return JSON.parse(await readFile(authPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  };
  const saveAll = (accounts) =>
    writeFile(authPath, JSON.stringify(accounts), { mode: 0o600 });
  const input = {
    directory,
    client: {
      auth: {
        set: async ({ path, body }) => {
          const all = await readAll();
          all[path.id] = body;
          await writeFile(authPath, JSON.stringify(all), { mode: 0o600 });
          writes.push(path.id);
          return { data: true };
        },
      },
    },
  };
  return { calls, refreshes, writes, state, input, authPath, saveAll, readAll };
}

test("every saved account is read: primary first, then slot names in order", async (t) => {
  const f = await stub(t, (call) =>
    call.token === "key-b" ? ok() : refused(401));
  await f.saveAll({
    "search1api#b": api("key-b"),
    search1api: api("key-a"),
    "search1api#a": api("key-c"),
  });
  const plugin = await Search1APIPlugin(f.input, { baseUrl });
  await plugin.tool.search.execute({ query: "q" }, context());
  assert.deepEqual(f.calls.map((call) => call.token), ["key-a", "key-c", "key-b"]);
});

test("a refused account rests and the next call starts with the remaining one", async (t) => {
  const f = await stub(t, (call) =>
    call.token === "key-a" ? refused(401) : ok());
  await f.saveAll({ "search1api#b": api("key-b"), search1api: api("key-a") });
  const plugin = await Search1APIPlugin(f.input, { baseUrl });
  await plugin.tool.search.execute({ query: "q" }, context());
  assert.deepEqual(f.calls.map((call) => call.token), ["key-a", "key-b"]);
  await plugin.tool.search.execute({ query: "q" }, context());
  assert.deepEqual(f.calls.map((call) => call.token), ["key-a", "key-b", "key-b"]);
});

test("a signed-in slot without a primary account is usable", async (t) => {
  const f = await stub(t, () => ok());
  await f.saveAll({ "search1api#only": api("only-key") });
  const plugin = await Search1APIPlugin(f.input, { baseUrl });
  await plugin.tool.search.execute({ query: "q" }, context());
  assert.equal(f.calls.at(-1).token, "only-key");
});

test("comma-separated keys are trimmed, deduplicated and keep their precedence", async (t) => {
  const f = await stub(t, (call) =>
    ["env-a", "step-a"].includes(call.token) ? refused(429, 60) : ok());
  await f.saveAll({ search1api: api("saved-key") });
  process.env.SEARCH1API_API_KEY = " env-a , step-b , env-a";
  const fromEnv = await Search1APIPlugin(f.input, { baseUrl });
  await fromEnv.tool.search.execute({ query: "q" }, context());
  assert.deepEqual(f.calls.map((call) => call.token), ["env-a", "step-b"]);
  f.calls.length = 0;
  const fromOption = await Search1APIPlugin(f.input, {
    baseUrl,
    apiKey: " step-a ,, step-b , step-a, ",
  });
  await fromOption.tool.search.execute({ query: "q" }, context());
  assert.deepEqual(f.calls.map((call) => call.token), ["step-a", "step-b"]);
  assert.ok(f.calls.every((call) => call.token !== "saved-key"));
});

test("rotate spreads requests; order always starts with the first account", async (t) => {
  const f = await stub(t, () => ok());
  await f.saveAll({ search1api: api("key-a"), "search1api#b": api("key-b") });
  const rotate = await Search1APIPlugin(f.input, { baseUrl, keyPick: "rotate" });
  for (let i = 0; i < 4; i++)
    await rotate.tool.search.execute({ query: "q" }, context());
  assert.deepEqual(f.calls.map((call) => call.token),
    ["key-a", "key-b", "key-a", "key-b"]);
  f.calls.length = 0;
  const order = await Search1APIPlugin(f.input, { baseUrl });
  for (let i = 0; i < 3; i++)
    await order.tool.search.execute({ query: "q" }, context());
  assert.deepEqual(f.calls.map((call) => call.token),
    ["key-a", "key-a", "key-a"]);
});

test("402, 403 and 429 rest the refusing account and the next one serves", async (t) => {
  for (const status of [402, 403, 429]) {
    const f = await stub(t, (call) =>
      call.token === "primary" ? refused(status, 60) : ok());
    await f.saveAll({ search1api: api("primary"), "search1api#b": api("backup") });
    const plugin = await Search1APIPlugin(f.input, { baseUrl });
    await plugin.tool.search.execute({ query: "q" }, context());
    assert.deepEqual(f.calls.map((call) => call.token), ["primary", "backup"], String(status));
    await plugin.tool.search.execute({ query: "q" }, context());
    assert.deepEqual(f.calls.map((call) => call.token),
      ["primary", "backup", "backup"], String(status));
  }
});

test("Retry-After seconds, HTTP dates and defaults bound the rest", () => {
  const now = 1_000_000;
  assert.equal(restedUntil(429, undefined, now), now + 60_000);
  assert.equal(restedUntil(401, undefined, now), now + 600_000);
  assert.equal(restedUntil(402, undefined, now), now + 600_000);
  assert.equal(restedUntil(403, undefined, now), now + 600_000);
  assert.equal(restedUntil(429, "30", now), now + 30_000);
  assert.equal(restedUntil(429, "0", now), now + 1_000);
  assert.equal(restedUntil(429, "7200", now), now + 3_600_000);
  assert.equal(restedUntil(429, "soon", now), now + 60_000);
  assert.equal(restedUntil(429, new Date(now + 120_000).toUTCString(), now), now + 120_000);
  assert.equal(restedUntil(429, new Date(now - 120_000).toUTCString(), now), now + 1_000);
});

test("a rested account is tried again once its Retry-After has passed", async (t) => {
  let recovered = false;
  const f = await stub(t, (call) =>
    call.token === "key-a" && !recovered ? refused(429, 1) : ok());
  await f.saveAll({ search1api: api("key-a"), "search1api#b": api("key-b") });
  const plugin = await Search1APIPlugin(f.input, { baseUrl });
  await plugin.tool.search.execute({ query: "q" }, context());
  assert.deepEqual(f.calls.map((call) => call.token), ["key-a", "key-b"]);
  await plugin.tool.search.execute({ query: "q" }, context());
  assert.deepEqual(f.calls.map((call) => call.token), ["key-a", "key-b", "key-b"]);
  recovered = true;
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  await plugin.tool.search.execute({ query: "q" }, context());
  assert.deepEqual(f.calls.map((call) => call.token),
    ["key-a", "key-b", "key-b", "key-a"]);
});

test("server errors, invalid JSON, network failures and aborts never rest or switch", async (t) => {
  let mode = "server";
  const f = await stub(t, (call) => {
    if (mode === "server") return refused(500);
    if (mode === "json") return new Response("fixture-private-content");
    if (mode === "network") throw new TypeError("fixture offline");
    if (mode === "abort")
      return new Promise((resolve, reject) => {
        call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true });
      });
    return ok();
  });
  await f.saveAll({ search1api: api("key-a"), "search1api#b": api("key-b") });
  const plugin = await Search1APIPlugin(f.input, { baseUrl });
  for (mode of ["server", "json", "network"]) {
    f.calls.length = 0;
    await assert.rejects(plugin.tool.search.execute({ query: "q" }, context()));
    assert.equal(f.calls.length, 1, mode);
  }
  f.calls.length = 0;
  mode = "abort";
  const controller = new AbortController();
  const call = plugin.tool.search.execute({ query: "q" }, context(controller.signal));
  const rejected = assert.rejects(call, /fixture cancellation/);
  while (!f.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort(new Error("fixture cancellation"));
  await rejected;
  assert.equal(f.calls.length, 1);
  mode = "ok";
  await plugin.tool.search.execute({ query: "q" }, context());
  assert.equal(f.calls.at(-1).token, "key-a");
});

test("a secondary OAuth account refreshes into its own slot only", async (t) => {
  const f = await stub(t, (call) =>
    call.token === "primary-key" ? refused(401) : ok());
  await f.saveAll({
    search1api: api("primary-key"),
    "search1api#b": oauth("stale-access", "stale-refresh", Date.now() - 1),
  });
  const plugin = await Search1APIPlugin(f.input, { baseUrl });
  await plugin.tool.search.execute({ query: "q" }, context());
  assert.deepEqual(f.writes, ["search1api#b"]);
  const all = await f.readAll();
  assert.deepEqual(all.search1api, { type: "api", key: "primary-key" });
  assert.equal(all["search1api#b"].access, "refreshed-1");
  assert.equal(all["search1api#b"].refresh, "rotated-1");
  assert.equal(f.calls.at(-1).token, "refreshed-1");
});

test("Magpie's auth.refresh writes back the slot whose session it was given", async (t) => {
  const f = await stub(t, () => ok());
  await f.saveAll({
    search1api: api("primary-key"),
    "search1api#b": oauth("stale-access", "stale-refresh", Date.now() - 1),
  });
  const plugin = await Search1APIPlugin(f.input, { baseUrl });
  const next = await plugin.auth.refresh(oauth("stale-access", "stale-refresh", Date.now() - 1));
  assert.equal(next.access, "refreshed-1");
  assert.deepEqual(f.writes, ["search1api#b"]);
  const all = await f.readAll();
  assert.deepEqual(all.search1api, { type: "api", key: "primary-key" });
  assert.equal(all["search1api#b"].access, "refreshed-1");
});

test("a revoked refresh rests that account and the next one serves the call", async (t) => {
  const f = await stub(t, (call) =>
    call.token === "primary-key" ? refused(401) : ok());
  f.state.rejectRefresh = true;
  await f.saveAll({
    search1api: api("primary-key"),
    "search1api#b": oauth("stale-access", "stale-refresh", Date.now() - 1),
    "search1api#c": api("key-c"),
  });
  const plugin = await Search1APIPlugin(f.input, { baseUrl });
  await plugin.tool.search.execute({ query: "q" }, context());
  assert.deepEqual(f.calls.map((call) => call.token), ["primary-key", "key-c"]);
  assert.deepEqual(f.writes, []);
  const all = await f.readAll();
  assert.equal(all["search1api#b"].access, "stale-access");
});

test("when every account is refused the safe error carries no credential", async (t) => {
  const f = await stub(t, () => refused(401));
  await f.saveAll({ search1api: api("key-a"), "search1api#b": api("key-b") });
  const plugin = await Search1APIPlugin(f.input, { baseUrl });
  await assert.rejects(
    plugin.tool.search.execute({ query: "q" }, context()),
    (error) => {
      assert.equal(error.status, 401);
      assert.match(error.message, /failed \(401\)/);
      assert.doesNotMatch(error.message, /key-a|key-b|fixture-secret/);
      return true;
    },
  );
  assert.equal(f.calls.length, 2);
  f.calls.length = 0;
  await assert.rejects(plugin.tool.search.execute({ query: "q" }, context()));
  assert.equal(f.calls.length, 2, "resting accounts are still tried as a last resort");
  assert.equal(f.calls.at(0).token, "key-a");
});

test("feedback that every credential refuses is answered, not thrown", async (t) => {
  const f = await stub(t, () => refused(401));
  await f.saveAll({ search1api: api("key-a"), "search1api#b": api("key-b") });
  const plugin = await Search1APIPlugin(f.input, { baseUrl });
  const text = await plugin.tool.send_feedback.execute({ message: "Missing capability" }, context());
  assert.match(text, /not recorded: .*\(401\)/);
  assert.doesNotMatch(text, /key-a|key-b|fixture-secret/);
  assert.equal(f.calls.length, 2);
});

test("web search uses every plugin credential without getAuth and only magpie's account with it", async (t) => {
  const f = await stub(t, (call) => {
    if (call.token === "key-a") return refused(429, 60);
    if (call.token === "magpie-key") return refused(401);
    return ok();
  });
  const plugin = await Search1APIPlugin(f.input, { baseUrl, apiKey: "key-a,key-b" });
  const pages = await plugin.search.search1api.execute(
    { query: "q" }, { abort: new AbortController().signal });
  assert.deepEqual(f.calls.map((call) => call.token), ["key-a", "key-b"]);
  assert.deepEqual(pages, [{ title: "Example", url: "https://example.com/", text: "", age: "" }]);
  f.calls.length = 0;
  await assert.rejects(
    plugin.search.search1api.execute({ query: "q" },
      { abort: new AbortController().signal, getAuth: async () => api("magpie-key") }),
    (error) => error.status === 401 && error.retryAfter === undefined,
  );
  assert.deepEqual(f.calls.map((call) => call.token), ["magpie-key"]);
});

test("keyPick is validated at startup and accounts are no longer single", async (t) => {
  const f = await stub(t, () => ok());
  for (const keyPick of ["random", "", "Order", 1])
    await assert.rejects(Search1APIPlugin(f.input, { baseUrl, keyPick }), /keyPick/);
  for (const keyPick of ["order", "rotate"])
    await Search1APIPlugin(f.input, { baseUrl, keyPick });
  const plugin = await Search1APIPlugin(f.input, { baseUrl });
  assert.equal(plugin.auth.provider, "search1api");
  assert.equal("single" in plugin.auth, false);
  assert.deepEqual(plugin.auth.methods.map((method) => method.type), ["oauth", "api"]);
});
