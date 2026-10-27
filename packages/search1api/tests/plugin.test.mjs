import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { Search1APIPlugin } from "../index.mjs";
import { fixture, context } from "./helpers.mjs";

test("all six tools forward arguments to the API and preserve result metadata", async (t) => {
  const f = await fixture(t);
  const plugin = await Search1APIPlugin(f.input, {
    apiKey: "test-option-key",
    baseUrl: f.baseUrl,
  });
  assert.deepEqual(Object.keys(plugin.tool), [
    "search",
    "news",
    "ask",
    "crawl",
    "sitemap",
    "trending",
  ]);
  const cases = [
    [
      "search",
      {
        query: "Bun",
        searchService: "grokipedia",
        page: 2,
        timeRange: "week",
        maxResults: 3,
        includeSites: ["example.com"],
        crawlResults: 0,
      },
      {
        query: "Bun",
        search_service: "grokipedia",
        page: 2,
        time_range: "week",
        max_results: 3,
        include_sites: ["example.com"],
        crawl_results: 0,
      },
    ],
    [
      "news",
      {
        query: "Bun",
        searchService: "reuters",
        timeRange: "day",
        excludeSites: ["example.com"],
      },
      {
        query: "Bun",
        search_service: "reuters",
        max_results: 10,
        crawl_results: 0,
        time_range: "day",
        exclude_sites: ["example.com"],
      },
    ],
    ["ask", { query: "Bun this week" }, { query: "Bun this week" }],
    ["crawl", { url: "https://example.com" }, { url: "https://example.com" }],
    ["sitemap", { url: "https://example.com" }, { url: "https://example.com" }],
    [
      "trending",
      { service: "github", maxResults: 4 },
      { search_service: "github", max_results: 4 },
    ],
  ];
  for (const [name, args, body] of cases) {
    const output = JSON.parse(await plugin.tool[name].execute(args, context()));
    const request = f.calls.at(-1);
    assert.equal(request.path, `/${name}`);
    assert.equal(request.headers.authorization, "Bearer test-option-key");
    assert.deepEqual(JSON.parse(request.raw), body);
    assert.deepEqual(output.results[0].metadata, { stars: 0 });
    assert.equal(output.results[0].relevance, 0.9);
    assert.deepEqual(output.errors, []);
  }
  assert.deepEqual(Object.keys(plugin.tool.ask.args.properties), ["query"]);
  await assert.rejects(plugin.tool.search.execute({ query: " " }, context()));
  await assert.rejects(plugin.tool.ask.execute({ query: "x".repeat(501) }, context()));
  await assert.rejects(plugin.tool.search.execute({ query: "test", searchService: "sogou" }, context()));
  await plugin.tool.search.execute({ query: "default search" }, context());
  assert.deepEqual(JSON.parse(f.calls.at(-1).raw), {
    query: "default search",
    max_results: 10,
    search_service: "google",
    crawl_results: 0,
  });
  await plugin.tool.news.execute({ query: "default news" }, context());
  assert.deepEqual(JSON.parse(f.calls.at(-1).raw), {
    query: "default news",
    max_results: 10,
    search_service: "bing",
    crawl_results: 0,
  });
});

test("API key precedence and missing credentials leave plugin installation usable", async (t) => {
  const f = await fixture(t);
  const original = process.env.SEARCH1API_API_KEY;
  t.after(() => {
    if (original === undefined) delete process.env.SEARCH1API_API_KEY;
    else process.env.SEARCH1API_API_KEY = original;
  });
  delete process.env.SEARCH1API_API_KEY;
  const plugin = await Search1APIPlugin(f.input, { baseUrl: f.baseUrl });
  await assert.rejects(
    plugin.tool.search.execute({ query: "test" }, context()),
    /magpie plugin login search1api/,
  );
  await f.save({ type: "api", key: "test-native-key" });
  await plugin.tool.search.execute({ query: "test" }, context());
  assert.equal(f.calls.at(-1).headers.authorization, "Bearer test-native-key");
  process.env.SEARCH1API_API_KEY = "test-env-key";
  await plugin.tool.search.execute({ query: "test" }, context());
  assert.equal(f.calls.at(-1).headers.authorization, "Bearer test-env-key");
  const override = await Search1APIPlugin(f.input, {
    baseUrl: f.baseUrl,
    apiKey: "test-option-key",
  });
  await override.tool.search.execute({ query: "test" }, context());
  assert.equal(f.calls.at(-1).headers.authorization, "Bearer test-option-key");
});

test("expired OAuth sessions refresh once across concurrent plugin instances and survive reload", async (t) => {
  const f = await fixture(t);
  await f.save({ ...f.oauth(), expires: Date.now() - 1 });
  const a = await Search1APIPlugin(f.input, { baseUrl: f.baseUrl });
  const b = await Search1APIPlugin(f.input, { baseUrl: f.baseUrl });
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? a : b).tool.search.execute({ query: "test" }, context()),
    ),
  );
  assert.equal(f.state.refreshes, 1);
  assert.equal((await f.readAuth()).search1api.refresh, "test-refresh-1");
  const reload = await Search1APIPlugin(f.input, { baseUrl: f.baseUrl });
  await reload.tool.search.execute({ query: "test" }, context());
  assert.equal(f.state.refreshes, 1);
  assert.equal(f.calls.at(-1).headers.authorization, "Bearer test-access-1");
});

test("a 401 renews an OAuth session once; API keys are not renewed or retried", async (t) => {
  const f = await fixture(t);
  await f.save(f.oauth());
  f.state.rejectAccess = true;
  const plugin = await Search1APIPlugin(f.input, { baseUrl: f.baseUrl });
  await plugin.tool.search.execute({ query: "test" }, context());
  assert.equal(f.state.refreshes, 1);
  assert.equal(f.calls.filter((c) => c.path === "/search").length, 2);
  const keyPlugin = await Search1APIPlugin(f.input, {
    baseUrl: f.baseUrl,
    apiKey: "test-access-0",
  });
  await assert.rejects(
    keyPlugin.tool.search.execute({ query: "test" }, context()),
  );
  assert.equal(f.state.refreshes, 1);
  assert.equal(f.calls.filter((c) => c.path === "/search").length, 3);
});

test("revoked refresh tokens surface a safe sign-in error and do not alter other accounts", async (t) => {
  const f = await fixture(t);
  const auth = { ...f.oauth(), expires: Date.now() - 1 };
  await writeFile(
    f.authPath,
    JSON.stringify({
      other: { type: "api", key: "test-other-key" },
      search1api: auth,
    }),
  );
  f.state.rejectRefresh = true;
  const plugin = await Search1APIPlugin(f.input, { baseUrl: f.baseUrl });
  await assert.rejects(
    plugin.tool.search.execute({ query: "test" }, context()),
    (error) => {
      assert.match(error.message, /Sign in again/);
      assert.doesNotMatch(error.message, /must-not-appear/);
      return true;
    },
  );
  assert.equal((await f.readAuth()).other.key, "test-other-key");
});

test("logout during refresh wins and no old session is resurrected", async (t) => {
  const f = await fixture(t);
  await f.save({ ...f.oauth(), expires: Date.now() - 1 });
  f.state.refreshDelay = 100;
  const plugin = await Search1APIPlugin(f.input, { baseUrl: f.baseUrl });
  const call = plugin.tool.search.execute({ query: "test" }, context());
  while (!f.calls.some((c) => c.path === "/token"))
    await new Promise((r) => setTimeout(r, 5));
  await writeFile(f.authPath, "{}");
  await assert.rejects(call, /Sign in/);
  assert.deepEqual(await f.readAuth(), {});
});

test("already aborted calls make no upstream request; corrupt auth is never overwritten", async (t) => {
  const f = await fixture(t);
  const plugin = await Search1APIPlugin(f.input, {
    baseUrl: f.baseUrl,
    apiKey: "test-key",
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    plugin.tool.search.execute({ query: "test" }, context(controller.signal)),
  );
  assert.equal(f.calls.length, 0);
  await writeFile(f.authPath, "broken auth");
  const native = await Search1APIPlugin(f.input, { baseUrl: f.baseUrl });
  await assert.rejects(
    native.tool.search.execute({ query: "test" }, context()),
    /cannot be read/,
  );
  assert.equal(await readFile(f.authPath, "utf8"), "broken auth");
});
