import { test, expect } from "bun:test";
import { ZenMuxAPIPlugin } from "./index.mjs";
import bootstrap from "./bootstrap.json" with { type: "json" };
import { transportTests } from "../../scripts/relay-tests.mjs";

const opts = { baseURL: "https://zenmux.test/api/v1", anthropicBaseURL: "https://zenmux.test/api/anthropic/v1", catalogURL: "https://catalog.test/models" };
transportTests(ZenMuxAPIPlugin, "zenmux-api", opts);

test("ZenMux: models.dev's actual metadata keeps vendor IDs and three native protocols", async () => {
  const original = globalThis.fetch;
  try {
    const plugin = await ZenMuxAPIPlugin({}, opts);
    let sent;
    globalThis.fetch = async (url, init) => { sent = new Request(url, init); return Response.json({ zenmux: bootstrap }); };
    const result = await plugin.provider.models({ models: {} }, { auth: { type: "api", key: "secret" } });
    expect(sent.url).toBe(opts.catalogURL);
    expect(sent.headers.get("authorization")).toBeNull();
    expect(new Set(Object.values(result).map((m) => m.api.npm)).size).toBe(3);
    const claude = result["anthropic/claude-sonnet-4.5"];
    expect(claude.api.url).toBe(opts.anthropicBaseURL);
    expect(claude.limit.context).toBe(1000000);
    expect(claude.cost.input).toBe(3);
    expect(claude.capabilities.input.image).toBe(true);
    expect(claude.variants.high).toEqual({ reasoningEffort: "high" });
    expect(result["openai/gpt-5.2"].api.id).toBe("openai/gpt-5.2");
    const malicious = structuredClone(bootstrap);
    malicious.models["openai/gpt-5.2"].provider.api = "https://elsewhere.invalid/v1";
    malicious.models.media = { modalities: { output: ["image"] } };
    globalThis.fetch = async () => Response.json({ zenmux: malicious });
    const fresh = await ZenMuxAPIPlugin({}, opts);
    const checked = await fresh.provider.models({ models: {} }, { auth: { type: "api", key: "secret" } });
    expect(checked["openai/gpt-5.2"].api.url).toBe(opts.baseURL);
    expect(checked.media).toBeUndefined();
  } finally { globalThis.fetch = original; }
});

test("ZenMux: failed or malformed catalogs throw for the host to retain its last list", async () => {
  const original = globalThis.fetch;
  try {
    const plugin = await ZenMuxAPIPlugin({}, opts);
    const p = { models: { existing: {} } }, a = { auth: { type: "api", key: "secret" } };
    for (const answer of [new Response("down", { status: 503 }), Response.json({}), Response.json({ zenmux: { models: [] } }), Response.json({ zenmux: { models: { invalid: "metadata" } } }), new Response("invalid JSON")]) {
      globalThis.fetch = async () => answer;
      await expect(plugin.provider.models(p, a)).rejects.toThrow();
      expect(p.models).toEqual({ existing: {} });
    }
    globalThis.fetch = async () => Response.json({ zenmux: { models: {} } });
    expect(await plugin.provider.models(p, a)).toEqual({});
  } finally { globalThis.fetch = original; }
});

test("ZenMux: concurrent accounts share public discovery without sharing mutable models", async () => {
  const original = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => { calls++; await Bun.sleep(5); return Response.json({ zenmux: bootstrap }); };
    const plugin = await ZenMuxAPIPlugin({}, opts);
    const results = await Promise.all(["one", "two"].map((key) => plugin.provider.models({ models: {} }, { auth: { type: "api", key } })));
    expect(calls).toBe(1);
    results[0]["openai/gpt-5.2"].name = "one account's edit";
    expect(results[1]["openai/gpt-5.2"].name).toBe("GPT-5.2");
    const later = await plugin.provider.models({ models: {} }, { auth: { type: "api", key: "three" } });
    expect(later["openai/gpt-5.2"].name).toBe("GPT-5.2");
    expect(calls).toBe(1);
  } finally { globalThis.fetch = original; }
});
