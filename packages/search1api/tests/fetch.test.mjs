import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Search1APIPlugin } from "../index.mjs";
import { discover, refreshToken } from "../src/oauth.ts";
import { context } from "./helpers.mjs";

const baseUrl = "https://search1api.invalid";
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

// Every fetch is replaced, including unexpected URLs: no real API or OAuth
// service can be reached, and all credentials and auth files are synthetic.
async function stub(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), "search1api-fetch-test-"));
  const authPath = join(directory, "plugin-auth.json");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.SEARCH1API_API_KEY;
  delete process.env.SEARCH1API_API_KEY;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), ...init };
    calls.push(call);
    assert.equal(new URL(call.url).origin, baseUrl);
    return handler(call, calls.length);
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.SEARCH1API_API_KEY;
    else process.env.SEARCH1API_API_KEY = originalKey;
    await rm(directory, { recursive: true, force: true });
  });
  const save = (auth) => writeFile(authPath, JSON.stringify({ search1api: auth }), { mode: 0o600 });
  const input = {
    directory,
    client: { auth: { set: async ({ path, body }) => {
      assert.equal(path.id, "search1api");
      await save(body);
    } } },
  };
  return { calls, input, save, read: async () => JSON.parse(await readFile(authPath, "utf8")) };
}

const oauth = () => ({
  type: "oauth", access: "fixture-access", refresh: "fixture-refresh",
  expires: Date.now() + 3600_000, clientId: "fixture-client",
  issuer: baseUrl, tokenEndpoint: `${baseUrl}/token`,
});

test("fetch stub: all six tools preserve wire bodies, defaults and complete JSON responses", async (t) => {
  const payload = {
    query: "fixture", intent: { sources: ["github"], time_range: "week" },
    results: [{ source: "github", relevance: 0.9, published_date: "2026-10-23", metadata: { stars: 0 } }],
    errors: [], extra: { retained: true },
  };
  const f = await stub(t, () => json(payload));
  const plugin = await Search1APIPlugin(f.input, { baseUrl, apiKey: "fixture-key" });
  const cases = [
    ["search", { query: "  research  ", searchService: "grokipedia", maxResults: 3, crawlResults: 2, page: 4, includeSites: ["example.com"], excludeSites: ["other.example"], timeRange: "week" },
      { query: "research", search_service: "grokipedia", max_results: 3, crawl_results: 2, page: 4, include_sites: ["example.com"], exclude_sites: ["other.example"], time_range: "week" }],
    ["search", { query: "default" }, { query: "default", search_service: "google", max_results: 10, crawl_results: 0 }],
    ["news", { query: "default" }, { query: "default", search_service: "bing", max_results: 10, crawl_results: 0 }],
    ["news", { query: "news", searchService: "reuters", crawlResults: 3, maxResults: 4, timeRange: "day", excludeSites: ["example.com"] },
      { query: "news", search_service: "reuters", crawl_results: 3, max_results: 4, time_range: "day", exclude_sites: ["example.com"] }],
    ["ask", { query: "research" }, { query: "research" }],
    ["crawl", { url: "https://example.com/path" }, { url: "https://example.com/path" }],
    ["sitemap", { url: "https://example.com" }, { url: "https://example.com" }],
    ["trending", { service: "github", maxResults: 4 }, { search_service: "github", max_results: 4 }],
    ["trending", { service: "hackernews" }, { search_service: "hackernews", max_results: 10 }],
  ];
  for (const [name, args, body] of cases) {
    assert.deepEqual(JSON.parse(await plugin.tool[name].execute(args, context())), payload);
    const call = f.calls.at(-1);
    assert.equal(call.url, `${baseUrl}/${name}`);
    assert.equal(call.method, "POST");
    assert.equal(call.headers.Authorization, "Bearer fixture-key");
    assert.equal(call.headers["Content-Type"], "application/json");
    assert.equal(call.redirect, "error");
    assert.deepEqual(JSON.parse(call.body), body);
  }
  assert.equal(f.calls.length, cases.length);
  const cfg = {};
  await plugin.config(cfg);
  assert.deepEqual(cfg.provider, { search1api: { name: "Search1API", models: {} } });
  assert.equal(plugin.auth.single, true);
  assert.deepEqual(plugin.auth.methods.map((m) => m.type), ["oauth", "api"]);
});

test("fetch stub: invalid arguments are refused before any request", async (t) => {
  const f = await stub(t, () => { throw new Error("must not fetch"); });
  const plugin = await Search1APIPlugin(f.input, { baseUrl, apiKey: "fixture-key" });
  const cases = [
    ["search", {}], ["search", { query: " " }], ["search", { query: 4 }],
    ["search", { query: "test", maxResults: 0 }], ["search", { query: "test", maxResults: 51 }],
    ["search", { query: "test", maxResults: 1.5 }], ["search", { query: "test", page: 101 }],
    ["search", { query: "test", crawlResults: -1 }], ["search", { query: "test", timeRange: "hour" }],
    ["search", { query: "test", includeSites: [3] }], ["search", { query: "test", excludeSites: "x" }],
    ["search", { query: "test", searchService: "sogou" }], ["news", { query: "test", searchService: "github" }],
    ["ask", { query: "x".repeat(501) }], ["ask", { query: "test", maxResults: 3 }],
    ["crawl", { url: "not a url" }], ["sitemap", { url: null }],
    ["trending", { service: "reddit" }], ["search", []],
  ];
  for (const [name, args] of cases) await assert.rejects(plugin.tool[name].execute(args, context()));
  assert.equal(f.calls.length, 0);
});

test("fetch stub: OAuth 401 refreshes and persists once, while a second 401 stops", async (t) => {
  let toolCalls = 0;
  const f = await stub(t, (call) => {
    if (call.url.endsWith("/token")) {
      assert.deepEqual(Object.fromEntries(new URLSearchParams(call.body)), {
        grant_type: "refresh_token", refresh_token: "fixture-refresh", client_id: "fixture-client",
      });
      return json({ access_token: "fixture-new", refresh_token: "fixture-rotated", expires_in: 3600 });
    }
    toolCalls++;
    assert.equal(call.headers.Authorization, `Bearer ${toolCalls === 1 ? "fixture-access" : "fixture-new"}`);
    return json({ private: "never expose this" }, 401);
  });
  await f.save(oauth());
  const plugin = await Search1APIPlugin(f.input, { baseUrl });
  await assert.rejects(plugin.tool.search.execute({ query: "test" }, context()), /failed \(401\)/);
  assert.equal(toolCalls, 2);
  assert.equal(f.calls.length, 3);
  assert.equal((await f.read()).search1api.refresh, "fixture-rotated");
});

test("fetch stub: API errors are safe and never retried, including API-key 401", async (t) => {
  let status = 401;
  const f = await stub(t, () => json({ error: "fixture-secret-must-not-leak" }, status));
  const plugin = await Search1APIPlugin(f.input, { baseUrl, apiKey: "fixture-key" });
  for (status of [400, 401, 402, 429, 500]) {
    const before = f.calls.length;
    await assert.rejects(plugin.tool.ask.execute({ query: "test" }, context()), (error) => {
      assert.match(error.message, new RegExp(String(status)));
      assert.doesNotMatch(error.message, /fixture-secret/);
      return true;
    });
    assert.equal(f.calls.length, before + 1);
  }
});

test("fetch stub: cancellation reaches an in-flight request and prevents refresh/retry", async (t) => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const f = await stub(t, (call) => new Promise((resolve, reject) => {
    entered();
    call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true });
  }));
  await f.save(oauth());
  const plugin = await Search1APIPlugin(f.input, { baseUrl });
  const controller = new AbortController();
  const call = plugin.tool.search.execute({ query: "test" }, context(controller.signal));
  const rejected = assert.rejects(call, /fixture cancellation/);
  await started;
  controller.abort(new Error("fixture cancellation"));
  await rejected;
  assert.equal(f.calls.length, 1);
  await assert.rejects(plugin.tool.search.execute({ query: "test" }, context(controller.signal)));
  assert.equal(f.calls.length, 1);
});

test("fetch stub: invalid JSON is reported without echoing response content", async (t) => {
  const f = await stub(t, () => new Response("fixture-private-content"));
  const plugin = await Search1APIPlugin(f.input, { baseUrl, apiKey: "fixture-key" });
  await assert.rejects(plugin.tool.search.execute({ query: "test" }, context()), /returned invalid JSON for search/);
  assert.equal(f.calls.length, 1);
});

test("fetch stub: OAuth discovery validates issuer, endpoints and PKCE before sign-in", async (t) => {
  let change = {};
  const f = await stub(t, (call) => call.url.endsWith("oauth-protected-resource")
    ? json({ authorization_servers: [baseUrl] })
    : json({ issuer: baseUrl, authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`, registration_endpoint: `${baseUrl}/register`,
      code_challenge_methods_supported: ["S256"], ...change }));
  assert.equal((await discover(baseUrl)).issuer, baseUrl);
  for (change of [
    { issuer: "https://other.invalid" },
    { token_endpoint: "https://other.invalid/token" },
    { registration_endpoint: "http://search1api.invalid/register" },
    { code_challenge_methods_supported: ["plain"] },
  ]) await assert.rejects(discover(baseUrl));
  const before = f.calls.length;
  await assert.rejects(refreshToken({ ...oauth(), tokenEndpoint: "https://other.invalid/token" }));
  assert.equal(f.calls.length, before);
});
