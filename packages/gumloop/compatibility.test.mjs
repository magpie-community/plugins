import { describe, expect, test } from "bun:test"
import { _internal } from "./index.mjs"
import { MODEL_ROUTES, Store, fetchPrices, wireModel } from "./gumloop.mjs"
import * as legacy from "./opencode.mjs"
import modern, { fieldsOf } from "./opencode2.mjs"

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const auth = { type: "api", key: "mock-key-AAAAAAAAAAAAAAAA", metadata: { userId: "mock-user-1234" } }
const option = (value) => ({ value, status: "active", metadata: { capabilities: ["functions"] } })

describe("current Gumloop catalog", () => {
  test("catalog refresh keeps wire routes and charges every supported catalog name", async () => {
    const sent = []
    const p = _internal.createPlugin({ fetchImpl: async (url, init) => {
      if (url.includes("api.gumloop.com")) return json({ model_groups: [{ options: Object.keys(MODEL_ROUTES).map(option) }] })
      if (url.includes("openrouter.ai")) return json({}, 503)
      sent.push(JSON.parse(init.body).model)
      return json({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 } })
    } })
    const models = await p.provider.models({ models: {} }, { auth })
    expect(Object.keys(models)).toHaveLength(8)
    expect(models["minimax-m3"]).toBeUndefined()
    const cfg = {}
    await p.config(cfg)
    expect(cfg.provider.gumloop.models["minimax-m3"]).toBeUndefined()
    const loaded = await p.auth.loader(async () => auth)
    for (const id of Object.keys(models)) {
      expect(models[id].cost.input).toBeGreaterThanOrEqual(0)
      await (await loaded.fetch(`${loaded.baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: id, messages: [{role:"user",content:"hi"}] }) })).text()
      expect(sent.at(-1)).toBe(MODEL_ROUTES[id])
    }
    const quota = await p.auth.usage(async () => auth)
    expect(quota.windows[1].display).toBe("8 credits · 8 calls")
  })

  test("new models get priced even within the catalog price TTL", async () => {
    let id = "gpt-6-sol"
    let reads = 0
    const p = _internal.createPlugin({ fetchImpl: async (url) => {
      if (url.includes("api.gumloop.com")) return json({model_groups:[{options:[option(id)]}]})
      reads++
      return json({data:[{id:"openai/gpt-future",pricing:{prompt:"0.000001",completion:"0.000002"}}]})
    } })
    await p.provider.models({models:{}}, {auth})
    id = "gpt-future"
    const models = await p.provider.models({models:{}}, {auth})
    expect(models[id].cost).toMatchObject({input:1,output:2})
    expect(reads).toBe(2)
    await p.provider.models({models:{}}, {auth})
    expect(reads).toBe(2)
  })

  test("unknown prices stay visibly unpriced", async () => {
    const p = _internal.createPlugin({fetchImpl: async url => url.includes("api.gumloop.com") ?
      json({model_groups:[{options:[option("unknown-model")]}]}) : url.includes("openrouter.ai") ?
      json({data:[]}) : json({usage:{prompt_tokens:20,completion_tokens:4}})})
    await p.provider.models({models:{}},{auth})
    const loaded = await p.auth.loader(async()=>auth)
    await (await loaded.fetch(`${loaded.baseURL}/chat/completions`,{method:"POST",body:JSON.stringify({model:"unknown-model"})})).text()
    expect((await p.auth.usage(async()=>auth)).windows[1].display).toContain("1 unpriced")
  })
})

describe("provider prices", () => {
  test("Fireworks uses its standard endpoint, not spot or another host", async () => {
    const pricing = (prompt) => ({prompt,completion:"0.0000044"})
    const table = await fetchPrices(async url => url.endsWith("/endpoints") ? json({data:{endpoints:[
      {provider_name:"Fireworks",tag:"fireworks/spot",pricing:pricing("0.00000098")},
      {provider_name:"Wafer",tag:"wafer",pricing:pricing("0.0000000699")},
      {provider_name:"Fireworks",tag:"fireworks",pricing:pricing("0.0000014")},
    ]}}) : json({data:[{id:"z-ai/glm-5.3",pricing:pricing("0.0000000699")}]}), ["glm-5.3"])
    expect(table["glm-5.3"].p.slice(0,2)).toEqual([1.4,4.4])
  })
  test("missing provider endpoints leave route fallback intact", async () => {
    const table = await fetchPrices(async url => url.endsWith("/endpoints") ? json({},503) :
      json({data:[{id:"z-ai/glm-5.3",pricing:{prompt:"0.0000000699",completion:"0.0000014"}}]}),["glm-5.3"])
    expect(table["glm-5.3"]).toBeUndefined()
    const store = new Store()
    store.setPrices(table)
    expect(store.price("glm-5.3").p.slice(0,2)).toEqual([1.4,4.4])
    expect(store.price("glm-5.3")).toEqual(store.price(wireModel("glm-5.3")))
  })
  test("Muse Wonder maps to OpenRouter's unversioned ID", async () => {
    const table = await fetchPrices(async()=>json({data:[{id:"meta/muse-wonder",pricing:{prompt:"0.000004",completion:"0.00002"}}]}),["muse-wonder-1.0"])
    expect(table["muse-wonder-1.0"].p.slice(0,2)).toEqual([4,20])
  })
})

describe("request and host compatibility", () => {
  test("source errors and reader cancellation report unbilled stops exactly once", async () => {
    for (const mode of ["error", "cancel"]) {
      let source
      const calls = []
      const stream = new ReadableStream({start(c) {
        source = c
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
      }})
      const ac = new AbortController()
      const tapped = _internal.tapUsage(stream, true, ac.signal, (...args)=>calls.push(args))
      const reader = tapped.getReader()
      await reader.read()
      if (mode === "error") {
        source.error(new Error("connection reset"))
        await expect(reader.read()).rejects.toThrow("connection reset")
      } else await reader.cancel()
      await new Promise(resolve=>setTimeout(resolve,0))
      ac.abort()
      expect(calls).toEqual([[undefined,true]])
    }
  })
  test("Muse and MiniMax Flash get a nonempty system prompt only when needed", () => {
    for (const model of ["meta/muse-spark-1.3","meta/muse-wonder-1.0","minimax/minimax-m3.1-flash"]) {
      const normalize = messages => _internal.normalize({model,messages},{cache1h:true}).messages
      expect(normalize([{role:"user",content:"hi"}])[0]).toEqual({role:"system",content:"You are a helpful assistant."})
      expect(normalize([{role:"system",content:" "},{role:"user",content:"hi"}])).toHaveLength(2)
      const existing = [{role:"system",content:"Custom instruction"},{role:"user",content:"hi"}]
      expect(normalize(existing)).toEqual(existing)
      const blocks = [{role:"system",content:[{type:"text",text:"Custom"}]}]
      expect(normalize(blocks)).toEqual(blocks)
    }
    expect(_internal.normalize({model:"gpt-6-sol",messages:[]},{cache1h:true}).messages).toEqual([])
  })
  test("OpenCode entrypoints expose plugins and keep optional fields optional", async () => {
    expect(Object.keys(legacy)).toEqual(["GumloopPlugin"])
    expect(modern.id).toBe("@magpie-community/opencode-gumloop-auth")
    expect(typeof modern.setup).toBe("function")
    const p = await legacy.GumloopPlugin()
    const fields = fieldsOf(p.auth.methods[0].prompts)
    expect(fields.filter(f=>f.required).map(f=>f.key)).toEqual(["key","userId"])
  })
})
