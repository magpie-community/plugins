import { describe, expect, test, afterEach } from "bun:test"
import { ZgBailianEmbed, _internal } from "./index.mjs"

const { PROVIDER, PUBLIC_BASE, DEFAULT_MODEL, ZG_MODELS, resolveTarget, nativeUrl, nativeToOpenAi, openAiToNative, openAiResToNative, nativeResToOpenAi } = _internal

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
const oaiAnswer = { data: [{ embedding: [0.1, 0.2], index: 0 }], usage: { total_tokens: 3 } }
const natAnswer = { output: { embeddings: [{ embedding: [0.5, 0.6], text_index: 0 }] }, usage: { total_tokens: 3 }, request_id: "r1" }

let restores = []
afterEach(() => { restores.forEach((r) => r()); restores = [] })
const stub = (handler) => { const f = fakeFetch(handler); restores.push(f.restore); return f.calls }
const post = (o, body, url = "https://ws.example.com/compatible-mode/v1/embeddings") =>
  o.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

describe("helpers", () => {
  test("zg's three hardcoded names and the default target", () => {
    expect(PROVIDER).toBe("zg-bailian-embed")
    expect(Object.keys(ZG_MODELS)).toEqual(["qwen3.7-text-embedding", "text-embedding-v4", "qwen3-vl-embedding"])
    expect(DEFAULT_MODEL).toBe("qwen3.7-text-embedding-flash")
  })

  test("resolveTarget: options > sign-in metadata > public default", () => {
    expect(resolveTarget({}, {})).toEqual({ endpoint: PUBLIC_BASE, model: DEFAULT_MODEL, protocol: "openai" })
    expect(resolveTarget({}, auth).endpoint).toBe("https://ws.example.com/compatible-mode/v1")
    expect(resolveTarget({ endpoint: "https://opt.example.com/v1/" }, auth).endpoint).toBe("https://opt.example.com/v1")
    expect(resolveTarget({ model: "text-embedding-v4" }, {}).model).toBe("text-embedding-v4")
    expect(resolveTarget(undefined, undefined).endpoint).toBe(PUBLIC_BASE)
  })

  test("resolveTarget: the old options.upstream bare entry still works, model wins", () => {
    expect(resolveTarget({ upstream: { "qwen3.7-text-embedding": "qwen3.7-text-embedding" } }, {}).model).toBe("qwen3.7-text-embedding")
    expect(resolveTarget({ model: "m-new", upstream: { "qwen3.7-text-embedding": "m-old" } }, {}).model).toBe("m-new")
  })

  test("resolveTarget: protocol auto from the endpoint path, explicit wins", () => {
    expect(resolveTarget({ endpoint: "https://dashscope.aliyuncs.com/api/v1" }, {}).protocol).toBe("dashscope")
    expect(resolveTarget({ endpoint: "https://my.proxy/v1" }, {}).protocol).toBe("openai")
    expect(resolveTarget({ endpoint: PUBLIC_BASE, protocol: "dashscope" }, {}).protocol).toBe("dashscope")
    expect(resolveTarget({ endpoint: "https://dashscope.aliyuncs.com/api/v1", protocol: "openai" }, {}).protocol).toBe("openai")
  })

  test("nativeUrl derives or keeps the native endpoint", () => {
    expect(nativeUrl(PUBLIC_BASE)).toBe("https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding")
    expect(nativeUrl("https://ws.example.com/compatible-mode/v1")).toBe("https://ws.example.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding")
    const full = "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding"
    expect(nativeUrl(full)).toBe(full)
  })

  test("body translation both ways", () => {
    expect(nativeToOpenAi({ model: "m", input: { contents: [{ text: "a" }, { image: "https://x/i.png" }] }, parameters: { dimension: 1024 } }))
      .toEqual({ model: "m", input: ["a", "https://x/i.png"], dimensions: 1024 })
    expect(nativeToOpenAi({ model: "m", input: { texts: ["a", "b"] } })).toEqual({ model: "m", input: ["a", "b"] })
    expect(openAiToNative({ model: "m", input: "hi" })).toEqual({ model: "m", input: { contents: [{ text: "hi" }] } })
    expect(openAiToNative({ model: "m", input: ["a", "b"], dimensions: 1024 }))
      .toEqual({ model: "m", input: { contents: [{ text: "a" }, { text: "b" }] }, parameters: { dimension: 1024 } })
  })

  test("answer translation both ways", () => {
    const n = openAiResToNative(oaiAnswer, "m")
    expect(n.output.embeddings).toEqual([{ embedding: [0.1, 0.2], index: 0, text_index: 0 }])
    expect(n.usage).toEqual({ total_tokens: 3 })
    const o = nativeResToOpenAi(natAnswer, "m")
    expect(o.object).toBe("list")
    expect(o.data).toEqual([{ object: "embedding", index: 0, embedding: [0.5, 0.6] }])
    expect(o.usage).toEqual({ prompt_tokens: 3, total_tokens: 3 })
    expect(nativeResToOpenAi({}, "m").data).toEqual([])
    expect(openAiResToNative({}, "m").output.embeddings).toEqual([])
  })
})

describe("config", () => {
  test("declares all three zg names with ONE API id: the target", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    const cfg = {}
    await plugin.config(cfg)
    const p = cfg.provider[PROVIDER]
    expect(p.npm).toBe("@ai-sdk/openai-compatible")
    expect(p.api).toBe(PUBLIC_BASE)
    expect(Object.keys(p.models)).toEqual(Object.keys(ZG_MODELS))
    for (const m of Object.values(p.models)) expect(m.id).toBe(DEFAULT_MODEL)
    expect(p.models["qwen3-vl-embedding"].modalities.input).toEqual(["text", "image"])
  })

  test("options.model retargets every name at once", async () => {
    const plugin = await ZgBailianEmbed({}, { model: "text-embedding-v4" })
    const cfg = {}
    await plugin.config(cfg)
    for (const m of Object.values(cfg.provider[PROVIDER].models)) expect(m.id).toBe("text-embedding-v4")
  })

  test("keeps a provider the user configured", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    const cfg = { provider: { [PROVIDER]: { name: "Mine" } } }
    await plugin.config(cfg)
    expect(cfg.provider[PROVIDER].name).toBe("Mine")
  })
})

describe("auth", () => {
  test("one api method: just the key", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    expect(plugin.auth.provider).toBe(PROVIDER)
    expect(plugin.auth.methods).toEqual([{ type: "api", label: "API key / 密钥", placeholder: "sk-…" }])
  })

  test("loader without a sign-in gives nothing", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    expect(await plugin.auth.loader(async () => undefined)).toEqual({})
    expect(await plugin.auth.loader(async () => ({ type: "oauth" }))).toEqual({})
  })

  test("loader uses the account's legacy base URL and signs each request", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    const o = await plugin.auth.loader(getAuth)
    expect(o.baseURL).toBe("https://ws.example.com/compatible-mode/v1")
    const calls = stub(() => jsonRes(oaiAnswer))
    await post(o, { model: "qwen3.7-text-embedding-flash", input: "hi" })
    expect(calls[0].init.headers.get("authorization")).toBe("Bearer sk-test")
  })
})

describe("the funnel: every zg name goes to the one target", () => {
  test("bare, v4 and vl names are all renamed to the target", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    const o = await plugin.auth.loader(getAuth)
    const calls = stub(() => jsonRes(oaiAnswer))
    for (const name of Object.keys(ZG_MODELS)) {
      await post(o, { model: name, input: "hi" })
    }
    for (const c of calls) expect(JSON.parse(c.init.body).model).toBe(DEFAULT_MODEL)
  })

  test("options.model drives the rename too", async () => {
    const plugin = await ZgBailianEmbed({}, { model: "text-embedding-v4" })
    const o = await plugin.auth.loader(getAuth)
    const calls = stub(() => jsonRes(oaiAnswer))
    await post(o, { model: "qwen3.7-text-embedding", input: "hi" })
    expect(JSON.parse(calls[0].init.body).model).toBe("text-embedding-v4")
  })

  test("OpenAI ARRAY batch input (what zg sends) passes through, not mistranslated", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    const o = await plugin.auth.loader(getAuth)
    const calls = stub(() => jsonRes({ data: [{ embedding: [0.1], index: 0 }, { embedding: [0.2], index: 1 }] }))
    const res = await post(o, { model: "qwen3.7-text-embedding", input: ["a", "b"] })
    expect(JSON.parse(calls[0].init.body)).toEqual({ model: DEFAULT_MODEL, input: ["a", "b"] })
    expect((await res.json()).data.length).toBe(2)
  })

  test("a non-zg model name is left alone", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    const o = await plugin.auth.loader(getAuth)
    const calls = stub(() => jsonRes(oaiAnswer))
    await post(o, { model: "some-other-model", input: "hi" })
    expect(JSON.parse(calls[0].init.body).model).toBe("some-other-model")
  })
})

describe("protocol auto-adaptation", () => {
  test("native caller (zg's vl body) -> OpenAI upstream: translated there, native shape back", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    const o = await plugin.auth.loader(getAuth)
    const calls = stub(() => jsonRes(oaiAnswer))
    const res = await post(o, { model: "qwen3-vl-embedding", input: { contents: [{ text: "hi" }] }, parameters: { dimension: 1024 } })
    expect(calls[0].url).toBe("https://ws.example.com/compatible-mode/v1/embeddings")
    expect(JSON.parse(calls[0].init.body)).toEqual({ model: DEFAULT_MODEL, input: ["hi"], dimensions: 1024 })
    const out = await res.json()
    expect(out.output.embeddings[0].embedding).toEqual([0.1, 0.2])
    expect(out.usage.total_tokens).toBe(3)
  })

  test("OpenAI caller -> native upstream (endpoint /api/v1): translated there, OpenAI shape back", async () => {
    const plugin = await ZgBailianEmbed({}, { endpoint: "https://dashscope.aliyuncs.com/api/v1", model: "qwen3-vl-embedding" })
    const o = await plugin.auth.loader(getAuth)
    const calls = stub(() => jsonRes(natAnswer))
    const res = await post(o, { model: "qwen3-vl-embedding", input: "hi", dimensions: 2560 }, "https://dashscope.aliyuncs.com/api/v1/embeddings")
    expect(calls[0].url).toBe("https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding")
    expect(JSON.parse(calls[0].init.body)).toEqual({
      model: "qwen3-vl-embedding", input: { contents: [{ text: "hi" }] }, parameters: { dimension: 2560 },
    })
    const out = await res.json()
    expect(out.object).toBe("list")
    expect(out.data[0].embedding).toEqual([0.5, 0.6])
  })

  test("native caller -> native upstream: body passes through untouched", async () => {
    const plugin = await ZgBailianEmbed({}, { endpoint: "https://dashscope.aliyuncs.com/api/v1", model: "qwen3-vl-embedding" })
    const o = await plugin.auth.loader(getAuth)
    const native = { model: "qwen3-vl-embedding", input: { contents: [{ text: "hi" }, { image: "https://example.com/a.png" }] }, parameters: { dimension: 2560 } }
    const calls = stub(() => jsonRes(natAnswer))
    const res = await post(o, native, "https://dashscope.aliyuncs.com/api/v1/embeddings")
    expect(JSON.parse(calls[0].init.body)).toEqual(native)
    expect((await res.json()).request_id).toBe("r1")
  })

  test("an upstream refusal keeps its status and speaks the caller's error shape", async () => {
    const plugin = await ZgBailianEmbed({}, {})
    const o = await plugin.auth.loader(getAuth)
    stub(() => jsonRes({ error: { message: "Invalid API-key provided.", code: "InvalidApiKey" } }, 401))
    const oai = await post(o, { model: "qwen3.7-text-embedding", input: "hi" })
    expect(oai.status).toBe(401)
    expect((await oai.json()).error.code).toBe("InvalidApiKey")

    const plugin2 = await ZgBailianEmbed({}, {})
    const o2 = await plugin2.auth.loader(getAuth)
    const nat = await post(o2, { model: "qwen3-vl-embedding", input: { contents: [{ text: "hi" }] } })
    expect(nat.status).toBe(401)
    expect((await nat.json()).code).toBe("InvalidApiKey")
  })
})