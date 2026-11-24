import { describe, expect, test, afterEach } from "bun:test"
import { ZgBailianEmbed, _internal } from "./index.mjs"

const { PROVIDER, PUBLIC_BASE, BRIDGES, resolveBase, nativeVlUrl, toNativeVl, fromNativeVl } = _internal

const auth = { type: "api", key: "sk-test", metadata: { endpoint: "custom", baseURL: "https://ws.example.com/compatible-mode/v1" } }
const getAuth = async () => auth

// records what the plugin's fetch sends, answers with a canned response
function fakeFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    return handler(input, init)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}
const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

let restores = []
afterEach(() => { restores.forEach((r) => r()); restores = [] })
const stub = (handler) => { const f = fakeFetch(handler); restores.push(f.restore); return f.calls }

describe("helpers", () => {
  test("bridges are zg's three hardcoded names", () => {
    expect(PROVIDER).toBe("zg-bailian-embed")
    expect(Object.keys(BRIDGES)).toEqual(["qwen3.7-text-embedding", "text-embedding-v4", "qwen3-vl-embedding"])
    expect(BRIDGES["qwen3.7-text-embedding"].id).toBe("qwen3.7-text-embedding-flash")
  })

  test("resolveBase: options > sign-in metadata > public default", () => {
    expect(resolveBase({}, {})).toBe(PUBLIC_BASE)
    expect(resolveBase({}, auth)).toBe("https://ws.example.com/compatible-mode/v1")
    expect(resolveBase({ endpoint: "https://opt.example.com/v1/" }, auth)).toBe("https://opt.example.com/v1")
    expect(resolveBase(undefined, undefined)).toBe(PUBLIC_BASE)
  })

  test("nativeVlUrl derives the native endpoint from the base", () => {
    expect(nativeVlUrl(PUBLIC_BASE)).toBe("https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding")
    expect(nativeVlUrl("https://ws.example.com/compatible-mode/v1")).toBe("https://ws.example.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding")
  })

  test("toNativeVl: string and array input, dimensions", () => {
    expect(toNativeVl({ model: "qwen3-vl-embedding", input: "hi" })).toEqual({
      model: "qwen3-vl-embedding", input: { contents: [{ text: "hi" }] },
    })
    expect(toNativeVl({ model: "qwen3-vl-embedding", input: ["a", "b"], dimensions: 1024 })).toEqual({
      model: "qwen3-vl-embedding", input: { contents: [{ text: "a" }, { text: "b" }] }, parameters: { dimension: 1024 },
    })
  })

  test("fromNativeVl: rows, index fallback, usage", () => {
    const r = fromNativeVl({
      output: { embeddings: [{ embedding: [0.1, 0.2], text_index: 0 }, { embedding: [0.3], index: 1 }] },
      usage: { total_tokens: 7 },
    }, "qwen3-vl-embedding")
    expect(r.object).toBe("list")
    expect(r.data).toEqual([
      { object: "embedding", index: 0, embedding: [0.1, 0.2] },
      { object: "embedding", index: 1, embedding: [0.3] },
    ])
    expect(r.usage).toEqual({ prompt_tokens: 7, total_tokens: 7 })
    expect(fromNativeVl({}, "m").data).toEqual([])
  })
})

describe("config", () => {
  test("declares the provider with the three bridges, API id flash", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    const cfg = {}
    await plugin.config(cfg)
    const p = cfg.provider[PROVIDER]
    expect(p.npm).toBe("@ai-sdk/openai-compatible")
    expect(p.api).toBe(PUBLIC_BASE)
    expect(Object.keys(p.models)).toEqual(Object.keys(BRIDGES))
    expect(p.models["qwen3.7-text-embedding"].id).toBe("qwen3.7-text-embedding-flash")
    expect(p.models["qwen3-vl-embedding"].modalities.input).toEqual(["text", "image"])
  })

  test("keeps a provider the user configured", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    const cfg = { provider: { [PROVIDER]: { name: "Mine" } } }
    await plugin.config(cfg)
    expect(cfg.provider[PROVIDER].name).toBe("Mine")
  })

  test("options.upstream overrides the API id", async () => {
    const plugin = await ZgBailianEmbed({}, { upstream: { "qwen3.7-text-embedding": "qwen3.7-text-embedding" } })
    const cfg = {}
    await plugin.config(cfg)
    expect(cfg.provider[PROVIDER].models["qwen3.7-text-embedding"].id).toBe("qwen3.7-text-embedding")
  })
})

describe("auth", () => {
  test("one api method with endpoint prompts", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    expect(plugin.auth.provider).toBe(PROVIDER)
    const m = plugin.auth.methods[0]
    expect(m.type).toBe("api")
    expect(m.prompts[0].type).toBe("select")
    expect(m.prompts[1].when).toEqual({ key: "endpoint", op: "eq", value: "custom" })
    expect(m.prompts[1].validate("https://ws.example.com/compatible-mode/v1")).toBeUndefined()
    expect(typeof m.prompts[1].validate("http://insecure")).toBe("string")
  })

  test("loader without a sign-in gives nothing", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    expect(await plugin.auth.loader(async () => undefined)).toEqual({})
    expect(await plugin.auth.loader(async () => ({ type: "oauth" }))).toEqual({})
  })

  test("loader sends the account's base URL and signs each request", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    const o = await plugin.auth.loader(getAuth)
    expect(o.baseURL).toBe("https://ws.example.com/compatible-mode/v1")
    const calls = stub(() => jsonRes({ data: [{ embedding: [0.1], index: 0 }] }))
    await o.fetch("https://ws.example.com/compatible-mode/v1/embeddings", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3.7-text-embedding-flash", input: "hi" }),
    })
    expect(calls[0].init.headers.get("authorization")).toBe("Bearer sk-test")
  })

  test("fetch renames a bare name a future host might send", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    const o = await plugin.auth.loader(getAuth)
    const calls = stub(() => jsonRes({ data: [] }))
    await o.fetch("https://ws.example.com/compatible-mode/v1/embeddings", {
      method: "POST", body: JSON.stringify({ model: "qwen3.7-text-embedding", input: "hi" }),
    })
    expect(JSON.parse(calls[0].init.body).model).toBe("qwen3.7-text-embedding-flash")
  })

  test("options.upstream also drives the fetch rename", async () => {
    const plugin = await ZgBailianEmbed({}, { upstream: { "qwen3.7-text-embedding": "qwen3.7-text-embedding" } })
    const o = await plugin.auth.loader(getAuth)
    const calls = stub(() => jsonRes({ data: [] }))
    await o.fetch("https://ws.example.com/compatible-mode/v1/embeddings", {
      method: "POST", body: JSON.stringify({ model: "qwen3.7-text-embedding", input: "hi" }),
    })
    expect(JSON.parse(calls[0].init.body).model).toBe("qwen3.7-text-embedding")
  })
})

describe("vl bridge", () => {
  test("OpenAI-shaped body is translated to the native API and back", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    const o = await plugin.auth.loader(getAuth)
    const calls = stub(() => jsonRes({
      output: { embeddings: [{ embedding: [0.5, 0.6], text_index: 0 }] },
      usage: { total_tokens: 3 },
    }))
    const res = await o.fetch("https://ws.example.com/compatible-mode/v1/embeddings", {
      method: "POST", body: JSON.stringify({ model: "qwen3-vl-embedding", input: "hi", dimensions: 2560 }),
    })
    expect(calls[0].url).toBe("https://ws.example.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding")
    expect(JSON.parse(calls[0].init.body)).toEqual({
      model: "qwen3-vl-embedding", input: { contents: [{ text: "hi" }] }, parameters: { dimension: 2560 },
    })
    const out = await res.json()
    expect(out.data[0].embedding).toEqual([0.5, 0.6])
    expect(out.usage.total_tokens).toBe(3)
  })

  test("native body (what zg sends) passes through untouched", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    const o = await plugin.auth.loader(getAuth)
    const native = { model: "qwen3-vl-embedding", input: { contents: [{ text: "hi" }, { image: "https://example.com/a.png" }] }, parameters: { dimension: 2560 } }
    const calls = stub(() => jsonRes({ output: { embeddings: [] }, usage: { total_tokens: 0 }, request_id: "r1" }))
    const res = await o.fetch("https://ws.example.com/compatible-mode/v1/embeddings", {
      method: "POST", body: JSON.stringify(native),
    })
    expect(calls[0].url).toBe("https://ws.example.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding")
    expect(JSON.parse(calls[0].init.body)).toEqual(native)
    expect((await res.json()).request_id).toBe("r1")
  })

  test("a native error keeps its status and speaks OpenAI's error shape", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    const o = await plugin.auth.loader(getAuth)
    stub(() => jsonRes({ code: "InvalidApiKey", message: "Invalid API-key provided." }, 401))
    const res = await o.fetch("https://ws.example.com/compatible-mode/v1/embeddings", {
      method: "POST", body: JSON.stringify({ model: "qwen3-vl-embedding", input: "hi" }),
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe("InvalidApiKey")
  })
})