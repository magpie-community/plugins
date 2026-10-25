import { test, expect } from "bun:test";

export function transportTests(make, id, opts) {
  for (const [protocol, suffix, baseURL] of [
    ["chat", "/chat/completions", opts.baseURL],
    ["responses", "/responses", opts.baseURL],
    ["anthropic", "/messages", opts.anthropicBaseURL ?? opts.baseURL],
    ["anthropic", "/messages/count_tokens", opts.anthropicBaseURL ?? opts.baseURL],
  ]) {
    test(`${id}: ${suffix} keeps body, auth, stream, errors and cancellation`, async () => {
      const original = globalThis.fetch;
      try {
        const plugin = await make({}, opts);
        let auth = { type: "api", key: "account-one" };
        const loader = await plugin.auth.loader(async () => auth);
        const other = await plugin.auth.loader(async () => ({ type: "api", key: "account-two" }));
        expect(loader.baseURL).toBeUndefined();
        const received = [];
        const abort = new AbortController();
        const payload = JSON.stringify({ model: "vendor/a-model", stream: true, tools: [{ name: "read" }] });
        const upstream = new Response("data: one\n\ndata: two\n\n", { status: 429, headers: { "retry-after": "7" } });
        globalThis.fetch = async (req) => { received.push(req); return upstream; };
        const request = new Request(baseURL + suffix + "?beta=true", {
          method: "POST", headers: { authorization: "Bearer gateway", "x-api-key": "gateway", "anthropic-beta": "test-beta", "content-type": "application/json" },
          body: payload, signal: abort.signal,
        });
        const result = await loader.fetch(request);
        expect(result).toBe(upstream);
        expect(result.status).toBe(429);
        expect(result.headers.get("retry-after")).toBe("7");
        expect(await result.text()).toBe("data: one\n\ndata: two\n\n");
        const sent = received[0];
        expect(sent.url).toBe(request.url);
        expect(await sent.clone().text()).toBe(payload);
        expect(sent.redirect).toBe("error");
        expect(sent.headers.get(protocol === "anthropic" ? "x-api-key" : "authorization")).toBe(protocol === "anthropic" ? "account-one" : "Bearer account-one");
        expect(sent.headers.get(protocol === "anthropic" ? "authorization" : "x-api-key")).toBeNull();
        expect(sent.headers.get("anthropic-beta")).toBe("test-beta");
        if (protocol === "anthropic") expect(sent.headers.get("anthropic-version")).toBe("2023-06-01");
        if (opts.appURL) expect(sent.headers.get("x-app-url")).toBe(opts.appURL);
        abort.abort();
        expect(sent.signal.aborted).toBe(true);
        auth = { type: "api", key: "renewed-key" };
        await Promise.all([loader.fetch(baseURL + suffix, { method: "POST", body: payload }), other.fetch(baseURL + suffix, { method: "POST", body: payload })]);
        const header = protocol === "anthropic" ? "x-api-key" : "authorization";
        expect(received[1].headers.get(header)).toContain("renewed-key");
        expect(received[2].headers.get(header)).toContain("account-two");
      } finally { globalThis.fetch = original; }
    });
  }

  test(`${id}: keys never go to an unexpected endpoint`, async () => {
    const plugin = await make({}, opts);
    const loader = await plugin.auth.loader(async () => ({ type: "api", key: "private-key" }));
    for (const url of ["https://elsewhere.invalid/chat/completions", opts.baseURL + "/admin", opts.baseURL + "-other/chat/completions"]) {
      await expect(loader.fetch(url, { method: "POST" })).rejects.toThrow("Unsupported");
    }
    await expect(loader.fetch(opts.baseURL + "/chat/completions", { method: "GET" })).rejects.toThrow("Unsupported");
  });

  test(`${id}: no keyless or OAuth mode; user config stays intact`, async () => {
    const plugin = await make({}, opts);
    expect(plugin.auth.provider).toBe(id);
    expect(plugin.auth.methods.map((m) => m.type)).toEqual(["api"]);
    expect(await plugin.auth.loader(async () => null)).toEqual({});
    await expect(plugin.auth.loader(async () => ({ type: "oauth", access: "not-a-key" }))).rejects.toThrow("API key");
    await expect(plugin.auth.loader(async () => ({ type: "api", key: " " }))).rejects.toThrow("API key");
    const mine = { name: "My choice", models: { chosen: {} } };
    const cfg = { provider: { [id]: mine, zenmux: { name: "OAuth" } } };
    await plugin.config(cfg);
    expect(cfg.provider[id]).toBe(mine);
    expect(cfg.provider.zenmux).toEqual({ name: "OAuth" });
    expect(await plugin.provider.models({ models: mine.models })).toBe(mine.models);
  });
}
