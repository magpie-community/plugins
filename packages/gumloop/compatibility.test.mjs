import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GumloopPlugin, _internal } from "./index.mjs"
import { MODEL_ROUTES, Store, fetchPrices, wireModel } from "./gumloop.mjs"
import * as legacy from "./opencode.mjs"
import modern, { fieldsOf } from "./opencode2.mjs"

const json = (body, status = 200, headers = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
const auth = { type: "api", key: "mock-key-AAAAAAAAAAAAAAAA", metadata: { userId: "mock-user-1234" } }
const option = (value) => ({ value, status: "active", metadata: { capabilities: ["functions"] } })

const dirs = []
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "gumloop-compat-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

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
  test("source errors and reader cancellation propagate upstream and report unbilled stops without an abort signal", async () => {
    for (const withSignal of [false, true]) {
      for (const mode of ["error", "cancel"]) {
        let source
        let upstreamCancelled = false
        const calls = []
        const stream = new ReadableStream({
          start(c) {
            source = c
            c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
          },
          cancel() {
            upstreamCancelled = true
          },
        })
        const ac = new AbortController()
        const tapped = _internal.tapUsage(stream, true, withSignal ? ac.signal : undefined, (...args) => calls.push(args))
        const reader = tapped.getReader()
        await reader.read()
        if (mode === "error") {
          source.error(new Error("connection reset"))
          await expect(reader.read()).rejects.toThrow("connection reset")
        } else {
          await reader.cancel()
        }
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (mode === "cancel") expect(upstreamCancelled).toBe(true)
        // Must already be recorded before any abort signal fires
        expect(calls).toEqual([[undefined, true]])
        if (withSignal) {
          ac.abort()
          expect(calls).toEqual([[undefined, true]])
        }
      }
    }
  })

  test("Muse and MiniMax Flash get a nonempty system prompt only when needed and respect developer role", () => {
    for (const model of ["meta/muse-spark-1.3", "meta/muse-wonder-1.0", "minimax/minimax-m3.1-flash"]) {
      const normalize = (messages) => _internal.normalize({ model, messages }, { cache1h: true }).messages
      expect(normalize([{ role: "user", content: "hi" }])[0]).toEqual({ role: "system", content: "You are a helpful assistant." })
      const fromBlank = normalize([{ role: "system", content: " " }, { role: "user", content: "hi" }])
      expect(fromBlank).toEqual([
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "hi" },
      ])
      const existing = [{ role: "system", content: "Custom instruction" }, { role: "user", content: "hi" }]
      expect(normalize([...existing])).toEqual(existing)
      const dev = [{ role: "developer", content: "Follow repo rules" }, { role: "user", content: "hi" }]
      expect(normalize([...dev])).toEqual(dev)
      const blankDev = normalize([{ role: "developer", content: "   " }, { role: "user", content: "hi" }])
      expect(blankDev).toEqual([
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "hi" },
      ])
      const blocks = [{ role: "system", content: [{ type: "text", text: "Custom" }] }]
      expect(normalize([...blocks])).toEqual(blocks)
    }
    expect(_internal.normalize({ model: "gpt-6-sol", messages: [] }, { cache1h: true }).messages).toEqual([])
    expect(_internal.normalize({ model: "gpt-6-sol", reasoning_effort: "none" }).reasoning).toEqual({ effort: "none" })
  })

  test("OpenCode directory is never written to unless running in magpie", async () => {
    const projectDir = tempDir()
    const p1 = _internal.createPlugin({
      directory: projectDir,
      options: { balance: 7000 },
      fetchImpl: async (url) =>
        url.includes("/models") ? json({ model_groups: [{ options: [option("gpt-6-sol")] }] }) : json({ usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    })
    const card = await p1.auth.usage(async () => auth)
    expect(card.balance).toBe("7000 credits")
    const loaded = await p1.auth.loader(async () => auth)
    await (await loaded.fetch(`${loaded.baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-6-sol", messages: [] }) })).text()
    expect(existsSync(join(projectDir, "gumloop-ledger.json"))).toBe(false)

    const p2 = await GumloopPlugin({ directory: projectDir }, { balance: 7000 })
    await p2.auth.loader(async () => auth)
    expect(existsSync(join(projectDir, "gumloop-ledger.json"))).toBe(false)

    const magpieDir = tempDir()
    const p3 = await GumloopPlugin({ directory: magpieDir, magpie: {} }, { balance: 7000 })
    await p3.auth.loader(async () => auth)
    expect(existsSync(join(magpieDir, "gumloop-ledger.json"))).toBe(true)
  })

  test("corrupt or truncated ledger is never overwritten or re-anchored", async () => {
    const dir = tempDir()
    const file = join(dir, "gumloop-ledger.json")
    let t = 1_800_000_000_000
    const make = () =>
      _internal.createPlugin({
        directory: dir,
        magpie: true,
        now: () => t,
        options: { balance: 7000 },
        fetchImpl: async (url) =>
          url.includes("api.gumloop.com")
            ? json({ model_groups: [{ options: [option("gpt-6-sol")] }] })
            : url.includes("openrouter.ai")
              ? json({ data: [] })
              : json({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } }),
      })
    const p1 = make()
    const l1 = await p1.auth.loader(async () => auth)
    await (await l1.fetch(`${l1.baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-6-sol", messages: [] }) })).text()
    expect((await p1.auth.usage(async () => auth)).balance).toBe("6999 credits")

    // Truncate the ledger on disk to 40 bytes (corrupt JSON)
    truncateSync(file, 40)
    const truncatedBytes = readFileSync(file, "utf8")
    expect(truncatedBytes.length).toBe(40)

    t += 60_000
    // In the same process, the last good in-memory copy is kept and disk is not overwritten
    await (await l1.fetch(`${l1.baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-6-sol", messages: [] }) })).text()
    expect(readFileSync(file, "utf8")).toBe(truncatedBytes)
    expect((await p1.auth.usage(async () => auth)).balance).toBe("6999 credits")

    // In a new process reading the truncated file, neither calibrate nor charge overwrites it
    const p2 = make()
    const l2 = await p2.auth.loader(async () => auth)
    await (await l2.fetch(`${l2.baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-6-sol", messages: [] }) })).text()
    expect(readFileSync(file, "utf8")).toBe(truncatedBytes)
  })

  test("unrelated 403s, upstream 400s and rate-limit 429s do not expire the key or zero the balance", async () => {
    let chatResp = json({ error: { message: "You are not authorized to use claude-opus-5-5 on your current plan" } }, 403)
    const p = _internal.createPlugin({
      options: { balance: 5000 },
      fetchImpl: async (url) => {
        if (url.includes("api.gumloop.com/api/v1/models")) return json({ model_groups: [{ options: [option("gpt-6-sol")] }] })
        if (url.includes("openrouter.ai")) return json({ data: [] })
        return chatResp
      },
    })
    const loaded = await p.auth.loader(async () => auth)

    // Plan 403 keeps status 403 and does not mark sign-in expired
    const rPlan = await loaded.fetch(`${loaded.baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "claude-opus-5-5", messages: [] }) })
    expect(rPlan.status).toBe(403)
    expect(rPlan.headers.get("x-magpie-sign-in")).toBe("kept")

    // Upstream Anthropic 400 credit error passes through as 400 and keeps balance intact
    chatResp = json({ error: { message: "anthropic: Your credit balance is too low to access the Anthropic API." } }, 400)
    const rUp = await loaded.fetch(`${loaded.baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }) })
    expect(rUp.status).toBe(400)
    expect((await p.auth.usage(async () => auth)).balance).toBe("5000 credits")

    // Rate-limit 429 with tier_limit passes through and keeps balance intact
    chatResp = json({ error: { code: "tier_limit", message: "Rate limit reached for tier_limit" } }, 429)
    const rRate = await loaded.fetch(`${loaded.baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-6-sol", messages: [] }) })
    expect(rRate.status).toBe(429)
    expect((await p.auth.usage(async () => auth)).balance).toBe("5000 credits")

    // Upstream OpenRouter-style 402 passes through as 402 and keeps balance intact
    chatResp = json({ error: { code: 402, message: "Insufficient credits" } }, 402)
    const r402 = await loaded.fetch(`${loaded.baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-6-sol", messages: [] }) })
    expect(r402.status).toBe(402)
    expect((await p.auth.usage(async () => auth)).balance).toBe("5000 credits")

    // Assumed credit_limit_exceeded 403 becomes 429 naming HTTP 403 and zeroes estimate
    chatResp = json({ error: { code: "credit_limit_exceeded", message: "You have reached your credit limit." } }, 403)
    const rCred = await loaded.fetch(`${loaded.baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-6-sol", messages: [] }) })
    expect(rCred.status).toBe(429)
    expect(await rCred.text()).toContain("from HTTP 403")
    expect((await p.auth.usage(async () => auth)).balance).toBe("0 credits")
  })

  test("per-account aliases stay isolated across accounts", async () => {
    const authA = { type: "api", key: "mock-key-AAAAAAAAAAAAAAAA", metadata: { userId: "user-A" } }
    const authB = { type: "api", key: "mock-key-BBBBBBBBBBBBBBBB", metadata: { userId: "user-B" } }
    const sent = []
    const p = _internal.createPlugin({
      fetchImpl: async (url, init) => {
        const h = new Headers(init?.headers)
        if (url.includes("api.gumloop.com/api/v1/models")) {
          const uid = h.get("x-auth-key")
          return json({ model_groups: [{ options: [option(uid === "user-A" ? "vendorA/foo" : "vendorB/foo")] }] })
        }
        if (url.includes("openrouter.ai")) return json({ data: [] })
        const body = JSON.parse(init.body)
        sent.push({ uid: h.get("x-auth-key"), model: body.model })
        return json({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })
      },
    })
    await p.provider.models({ models: {} }, { auth: authA })
    await p.provider.models({ models: {} }, { auth: authB })
    const loadA = await p.auth.loader(async () => authA)
    const loadB = await p.auth.loader(async () => authB)
    await (await loadA.fetch(`${loadA.baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "foo", messages: [] }) })).text()
    await (await loadB.fetch(`${loadB.baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "foo", messages: [] }) })).text()
    expect(sent).toEqual([
      { uid: "user-A", model: "vendorA/foo" },
      { uid: "user-B", model: "vendorB/foo" },
    ])
  })

  test("streams with application/octet-stream are charged and oversized JSON replies count as unbilled", async () => {
    let mode = "octet"
    const p = _internal.createPlugin({
      fetchImpl: async (url) => {
        if (url.includes("api.gumloop.com")) return json({ model_groups: [{ options: [option("gpt-6-sol")] }] })
        if (url.includes("openrouter.ai")) return json({ data: [] })
        if (mode === "octet") {
          return new Response('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n', {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          })
        }
        return new Response(`{"padding":"${"x".repeat(4_100_000)}","usage":{"prompt_tokens":10,"completion_tokens":5}}`, {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    })
    const loaded = await p.auth.loader(async () => auth)
    await (await loaded.fetch(`${loaded.baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-6-sol", stream: true, messages: [] }) })).text()
    let quota = await p.auth.usage(async () => auth)
    expect(quota.windows[1].display).toBe("1 credits · 1 calls")

    mode = "huge-json"
    await (await loaded.fetch(`${loaded.baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-6-sol", messages: [] }) })).text()
    quota = await p.auth.usage(async () => auth)
    expect(quota.windows[1].display).toContain("1 stopped without usage")
  })

  test("OpenRouter failures back off instead of refetching on every usage read", async () => {
    let orCalls = 0
    let t = 1_800_000_000_000
    const p = _internal.createPlugin({
      now: () => t,
      fetchImpl: async (url) => {
        if (url.includes("api.gumloop.com")) return json({ model_groups: [{ options: [option("gpt-6-sol")] }] })
        if (url.includes("openrouter.ai")) {
          orCalls++
          return json({}, 503)
        }
        return json({})
      },
    })
    for (let i = 0; i < 5; i++) await p.auth.usage(async () => auth)
    expect(orCalls).toBe(1)
    t += 6 * 60 * 1000
    await p.auth.usage(async () => auth)
    expect(orCalls).toBe(2)
  })

  test("late anchor after more than 500 calls still counts every call made since the anchor timestamp", () => {
    let t = 100
    const s = new Store(undefined, () => t)
    for (let i = 1; i <= 600; i++) {
      t = i
      s.change("u", (a) => Store.spend(a, 1, i))
    }
    expect(s.anchor("u", 1000, "login:50", 50)).toBe(true)
    expect(s.remaining("u")).toBe(450)
  })

  test("OpenCode entrypoints expose plugins and keep optional fields optional", async () => {
    expect(Object.keys(legacy)).toEqual(["GumloopPlugin"])
    expect(modern.id).toBe("@magpie-community/opencode-gumloop-auth")
    expect(typeof modern.setup).toBe("function")
    const p = await legacy.GumloopPlugin()
    const fields = fieldsOf(p.auth.methods[0].prompts)
    expect(fields.filter((f) => f.required).map((f) => f.key)).toEqual(["key", "userId"])
  })
})
