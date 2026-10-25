import { test, expect } from "bun:test";
import { TokenDancePlugin } from "./index.mjs";
import bootstrap from "./bootstrap.json" with { type: "json" };
import { transportTests } from "../../scripts/relay-tests.mjs";

const opts = { baseURL: "https://tokendance.test/gateway/v1", appURL: "app://magpie-test" };
transportTests(TokenDancePlugin, "tokendance", opts);

test("TokenDance: protocol capabilities, preference and non-chat models", async () => {
  const original = globalThis.fetch;
  try {
    const source = structuredClone(bootstrap);
    source.data.push({ id: "embeddings", supported_protocols: ["openai:embeddings"] });
    source.data.push({ id: "unknown", supported_protocols: ["constructor", "__proto__"] });
    source.data.push({ id: "messages-only", supported_protocols: ["anthropic:messages"] });
    source.data.push({ id: "responses-only", supported_protocols: ["openai:responses"] });
    let sent;
    globalThis.fetch = async (url, init) => { sent = new Request(url, init); return Response.json(source); };
    const plugin = await TokenDancePlugin({}, { ...opts, protocol: "responses" });
    const result = await plugin.provider.models({ models: {} }, { auth: { type: "api", key: "my-token" } });
    expect(sent.url).toBe(opts.baseURL + "/models");
    expect(sent.headers.get("authorization")).toBe("Bearer my-token");
    expect(result.embeddings).toBeUndefined();
    expect(result.unknown).toBeUndefined();
    expect(result["glm-4.7"].api.npm).toBe("@ai-sdk/openai-compatible");
    expect(result["deepseek-v4.1-flash-1017"].api.npm).toBe("@ai-sdk/openai");
    expect(result["messages-only"].api.npm).toBe("@ai-sdk/anthropic");
    expect(result["responses-only"].api.npm).toBe("@ai-sdk/openai");
    expect(result["glm-4.7"].limit.context).toBe(200000);
    expect(result["glm-4.7"].free).toBeUndefined();
    await expect(TokenDancePlugin({}, { protocol: "invented" })).rejects.toThrow("protocol");
  } finally { globalThis.fetch = original; }
});

test("TokenDance: unknown list stays unknown, and only an invalid key expires the sign-in", async () => {
  const original = globalThis.fetch;
  try {
    const plugin = await TokenDancePlugin({}, opts);
    const provider = { models: { existing: {} } }, auth = { auth: { type: "api", key: "my-token" } };
    for (const status of [401, 403, 429, 500]) {
      globalThis.fetch = async () => new Response("upstream error", { status });
      const error = await plugin.provider.models(provider, auth).catch((e) => e);
      expect(error.message).toContain(String(status));
      expect(error.signIn).toBe(status === 401 ? "expired" : undefined);
    }
    for (const body of [{}, { data: [{}] }, { data: [{ id: "missing-protocols" }] }, { data: [{ id: "bad-protocol", supported_protocols: [null] }] }]) {
      globalThis.fetch = async () => Response.json(body);
      await expect(plugin.provider.models(provider, auth)).rejects.toThrow();
    }
    globalThis.fetch = async () => Response.json({ data: [] });
    expect(await plugin.provider.models(provider, auth)).toEqual({});
    expect(provider.models).toEqual({ existing: {} });
  } finally { globalThis.fetch = original; }
});
