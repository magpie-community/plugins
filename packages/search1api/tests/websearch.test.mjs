import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Search1APIPlugin } from "../index.mjs";

const baseUrl = "https://search1api.invalid";

// Every fetch is replaced: no real API is reached and every credential is synthetic.
async function stub(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), "search1api-websearch-test-"));
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.SEARCH1API_API_KEY;
  delete process.env.SEARCH1API_API_KEY;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), ...init, body: JSON.parse(init.body) };
    calls.push(call);
    assert.equal(new URL(call.url).origin, baseUrl);
    return handler(call);
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.SEARCH1API_API_KEY;
    else process.env.SEARCH1API_API_KEY = originalKey;
    await rm(directory, { recursive: true, force: true });
  });
  const save = (auth) => writeFile(join(directory, "plugin-auth.json"), JSON.stringify({ search1api: auth }), { mode: 0o600 });
  return { calls, save, input: { directory, client: { auth: { set: async () => {} } } } };
}

const found = () => new Response(JSON.stringify({
  results: [
    { title: "Bun 1.3", link: "https://bun.com/blog/bun-v1.3", snippet: "Bun 1.3 adds", published_date: "2025-10-10" },
    { title: "No date", link: "https://example.com/a", snippet: "text" },
    { title: "No link", snippet: "dropped" },
    null,
  ],
}));

const ctx = (auth) => ({ abort: new AbortController().signal, ...(auth && { getAuth: async () => auth }) });

test("web search is one entry that signs in as the plugin's own Search1API provider", async (t) => {
  const f = await stub(t, found);
  const plugin = await Search1APIPlugin(f.input, { baseUrl });
  assert.deepEqual(Object.keys(plugin.search), ["search1api"]);
  const entry = plugin.search.search1api;
  assert.equal(entry.name, "Search1API");
  assert.equal(entry.auth, plugin.auth.provider);
  assert.equal(entry.keysURL, undefined);
});

test("web search asks /search with the account magpie chose and maps its pages", async (t) => {
  const f = await stub(t, found);
  const plugin = await Search1APIPlugin(f.input, { baseUrl });
  const pages = await plugin.search.search1api.execute({ query: "  bun 1.3  ", count: 6, key: "" }, ctx({ type: "api", key: "account-key" }));
  assert.deepEqual(pages, [
    { title: "Bun 1.3", url: "https://bun.com/blog/bun-v1.3", text: "Bun 1.3 adds", age: "2025-10-10" },
    { title: "No date", url: "https://example.com/a", text: "text", age: "" },
  ]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `${baseUrl}/search`);
  assert.equal(f.calls[0].headers.Authorization, "Bearer account-key");
  assert.deepEqual(f.calls[0].body, { query: "bun 1.3", search_service: "google", max_results: 6, crawl_results: 0 });

  await plugin.search.search1api.execute({ query: "q" }, ctx({ type: "oauth", access: "oauth-access", refresh: "r", expires: Date.now() + 3600_000 }));
  assert.equal(f.calls[1].headers.Authorization, "Bearer oauth-access");
  assert.equal(f.calls[1].body.max_results, 10);
  await plugin.search.search1api.execute({ query: "q", count: 500 }, ctx({ type: "api", key: "k" }));
  assert.equal(f.calls[2].body.max_results, 50);
});

test("an option key wins over the account; without getAuth the saved sign-in is used", async (t) => {
  const f = await stub(t, found);
  const keyed = await Search1APIPlugin(f.input, { baseUrl, apiKey: "option-key" });
  await keyed.search.search1api.execute({ query: "q" }, ctx({ type: "api", key: "account-key" }));
  assert.equal(f.calls[0].headers.Authorization, "Bearer option-key");

  await f.save({ type: "api", key: "saved-key" });
  const plain = await Search1APIPlugin(f.input, { baseUrl });
  await plain.search.search1api.execute({ query: "q" }, ctx());
  assert.equal(f.calls[1].headers.Authorization, "Bearer saved-key");
});

test("a refusal keeps its status and Retry-After for magpie, never the body", async (t) => {
  let status = 429;
  const f = await stub(t, () => new Response(JSON.stringify({ error: "fixture-secret-must-not-leak" }), { status, headers: { "Retry-After": "30" } }));
  const plugin = await Search1APIPlugin(f.input, { baseUrl });
  for (status of [401, 402, 429, 500]) {
    await assert.rejects(plugin.search.search1api.execute({ query: "q" }, ctx({ type: "api", key: "k" })), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.retryAfter, "30");
      assert.doesNotMatch(error.message, /fixture-secret/);
      return true;
    });
  }
  await assert.rejects(plugin.search.search1api.execute({ query: "  " }, ctx({ type: "api", key: "k" })), /query is required/);
  assert.equal(f.calls.length, 4);
});
