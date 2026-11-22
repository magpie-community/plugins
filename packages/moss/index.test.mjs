// The plugin's shape, its config row and the account model list.
import { expect, test } from "bun:test"
import { MossPlugin, _internal } from "./index.mjs"
import { fakeMoss, modelsBody, json } from "./fake.mjs"

test("the package exports one plugin function", async () => {
  const plugin = await MossPlugin()
  expect(typeof plugin.config).toBe("function")
  expect(plugin.auth?.provider).toBe("moss")
  expect(typeof plugin.auth?.loader).toBe("function")
  expect(typeof plugin.auth?.usage).toBe("function")
  expect(plugin.provider?.id).toBe("moss")
  expect(typeof plugin.provider?.models).toBe("function")
})

test("config declares the moss provider with the boot models", async () => {
  const plugin = await MossPlugin()
  const cfg = {}
  await plugin.config(cfg)
  const p = cfg.provider.moss
  expect(p.name).toBe("MOSS")
  expect(p.npm).toBe("@ai-sdk/openai-compatible")
  expect(p.api).toBe("https://api.mosi.cn/v1")
  expect(p.models["nex-n2.6"].capabilities.toolcall).toBe(true)
  expect(p.models["nex-n2.6"].capabilities.input.image).toBe(true)
  // Nex-N2.6 opened a 256K context window (release note + magpie's live row).
  expect(p.models["nex-n2.6"].limit.context).toBe(262144)
  // The time-limited free price is 0/0, so magpie does not bill it, and the
  // row carries free: true so the model picker shows the free badge.
  expect(p.models["nex-n2.6"].cost).toEqual({ input: 0, output: 0 })
  expect(p.models["nex-n2.6"].free).toBe(true)
  // tob-kimi-k3 is a chat model, but its spec is unknown here and it is not
  // not free: no cost line, no made-up context.
  expect(p.models["tob-kimi-k3"]).toBeDefined()
  expect(p.models["tob-kimi-k3"].limit.context).toBe(0)
  expect(p.models["tob-kimi-k3"].cost).toBeUndefined()
  expect(p.models["tob-kimi-k3"].free).toBeUndefined()
})

test("config keeps a provider the user configured", async () => {
  const plugin = await MossPlugin()
  const cfg = { provider: { moss: { name: "My MOSS", api: "https://proxy.example/v1" } } }
  await plugin.config(cfg)
  expect(cfg.provider.moss.name).toBe("My MOSS")
  expect(cfg.provider.moss.api).toBe("https://proxy.example/v1")
})

test("the API-key loader hands the host the base URL and key", async () => {
  const plugin = await MossPlugin()
  const loaded = await plugin.auth.loader(async () => ({ type: "api", key: "sk-test" }))
  expect(loaded.baseURL).toBe("https://api.mosi.cn/v1")
  expect(loaded.apiKey).toBe("sk-test")
  expect((await plugin.auth.loader(async () => ({ type: "oauth" }))).apiKey).toBeUndefined()
})

test("usage probes /v1/models: a refused key marks the account expired", async () => {
  const fake = fakeMoss()
  try {
    const plugin = _internal.createPlugin()
    fake.route("GET /v1/models", () => json({ error: { code: "authentication_error" } }, 401))
    const bad = await plugin.auth.usage(async () => ({ type: "api", key: "sk-dead" }))
    expect(bad.signIn).toBe("expired")
    expect(bad.windows).toEqual([])
    expect(String(bad.error)).toContain("401")

    fake.route("GET /v1/models", () => json(modelsBody()))
    const good = await plugin.auth.usage(async () => ({ type: "api", key: "sk-live" }))
    expect(good.plan).toBe("MOSS API")
    // A key-only account sees models but not credits; the card says so.
    expect(good.error).toContain("browser")
  } finally {
    fake.close()
  }
})

test("usage reports a network failure, not a sign-in state", async () => {
  const plugin = _internal.createPlugin({ fetchImpl: async () => { throw new Error("ECONNREFUSED") } })
  const out = await plugin.auth.usage(async () => ({ type: "api", key: "sk-test" }))
  expect(out.signIn).toBeUndefined()
  expect(String(out.error)).toContain("unreachable")
})

test("provider.models keeps the previous list when the network fails or MOSS answers non-2xx", async () => {
  // The host-fallback contract: a broken read returns the previous rows
  // (return, not throw), so a transient outage never empties the picker.
  const plugin = _internal.createPlugin({ fetchImpl: async () => { throw new Error("ECONNREFUSED") } })
  const previous = { models: { "nex-n2.6": { id: "nex-n2.6" } } }
  expect(await plugin.provider.models(previous, { auth: { type: "api", key: "sk-test" } })).toBe(previous.models)

  const fake = fakeMoss()
  try {
    fake.route("GET /v1/models", () => json({ message: "boom" }, 500))
    expect(await plugin.provider.models(previous, { auth: { type: "api", key: "sk-test" } })).toBe(previous.models)
  } finally {
    fake.close()
  }
})

test("provider.models replaces the boot rows with the account's own chat list", async () => {
  const fake = fakeMoss()
  try {
    const plugin = _internal.createPlugin()
    // The live list carries every capability (TTS, transcription, VL…);
    // only the chat families are listed, and moss-vl-1.0 (a /v1/responses
    // vision model, not a chat endpoint) stays out.
    fake.route("GET /v1/models", () => json(modelsBody(["nex-n2.6", "moss-vl-1.0", "moss-tts-1.5-flash", "tob-kimi-k3"])))
    const rows = await plugin.provider.models({ models: {} }, { auth: { type: "api", key: "sk-test" } })
    expect(Object.keys(rows)).toEqual(["nex-n2.6", "tob-kimi-k3"])
    expect(rows["nex-n2.6"].capabilities.input.image).toBe(true)
  } finally {
    fake.close()
  }
})

test("provider.models throws on a malformed answer, so the host keeps the previous list as a fallback", async () => {
  const fake = fakeMoss()
  try {
    const plugin = _internal.createPlugin()
    fake.route("GET /v1/models", () => json({ object: "list", data: [{ nope: true }] }))
    await expect(plugin.provider.models({ models: { "nex-n2.6": { id: "nex-n2.6" } } }, { auth: { type: "api", key: "sk-test" } })).rejects.toThrow(
      "MOSS sent no model list",
    )
  } finally {
    fake.close()
  }
})

test("provider.models marks the account expired when MOSS refuses the key", async () => {
  const fake = fakeMoss()
  try {
    const plugin = _internal.createPlugin()
    fake.route("GET /v1/models", () => json({}, 403))
    await expect(plugin.provider.models({ models: {} }, { auth: { type: "api", key: "sk-dead" } })).rejects.toThrow("403")
  } finally {
    fake.close()
  }
})

test("provider.models refreshes for a browser sign-in (oauth) account too", async () => {
  // A browser sign-in keeps its API key at the top level (auth.apiKey), and
  // the live list refresh must work from that shape, not only from an "api"
  // method entry.
  const fake = fakeMoss()
  try {
    const plugin = _internal.createPlugin()
    fake.route("GET /v1/models", () => json(modelsBody(["nex-n2.6", "nex-n2.6-2026-11-05"])))
    const rows = await plugin.provider.models(
      { models: {} },
      { auth: { type: "oauth", apiKey: "sk-browser", consoleToken: "tok" } },
    )
    expect(Object.keys(rows)).toEqual(["nex-n2.6", "nex-n2.6-2026-11-05"])
    expect(rows["nex-n2.6"].free).toBe(true)
  } finally {
    fake.close()
  }
})

test("provider.models keeps the boot rows when the account has no API key", async () => {
  // A browser sign-in with key creation off has no key: no request is made,
  // and the bootstrap rows stay.
  let asked = false
  const plugin = _internal.createPlugin({
    fetchImpl: async () => {
      asked = true
      throw new Error("must not fetch")
    },
  })
  const rows = await plugin.provider.models({ models: { "nex-n2.6": { id: "nex-n2.6" } } }, { auth: { type: "oauth" } })
  expect(asked).toBe(false)
  expect(Object.keys(rows)).toEqual(["nex-n2.6"])
})

test("provider.models marks a browser sign-in expired when MOSS refuses its key", async () => {
  const fake = fakeMoss()
  try {
    const plugin = _internal.createPlugin()
    fake.route("GET /v1/models", () => json({}, 403))
    await expect(
      plugin.provider.models({ models: {} }, { auth: { type: "oauth", apiKey: "sk-dead" } }),
    ).rejects.toThrow("403")
  } finally {
    fake.close()
  }
})
