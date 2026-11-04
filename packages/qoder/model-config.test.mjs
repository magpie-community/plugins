// The model_config a chat sends (plugins#638, square-235): Qoder CN billed
// DeepSeek-Flash (dfmodel) as Auto while the plugin sent the model's listing
// entry whole, with its minimal_version, strategies, prices and
// thinking_config. Qoder's own client (CN CLI 1.1.81, desktop 0.4.3) sends
// only the fields below, in this order. The listings are the real bytes
// Qoder (testdata/listing.json) and Qoder CN (testdata/cn-listing-free-view.json)
// answered.
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { QoderAuthPlugin, QoderCNAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => { globalThis.fetch = real })

const CLIENT_KEYS = ["key", "display_name", "model", "format", "is_vl", "is_reasoning", "api_key", "url", "source", "max_input_tokens"]
const read = (f) => JSON.parse(readFileSync(new URL(`./testdata/${f}`, import.meta.url), "utf8"))
// The CN listing was read on a free account, which has every paid model off
// (enable false); the reporter's paid account has them on, so they are
// turned on here and nothing else is changed.
const paid = (listing) => Object.fromEntries(Object.entries(listing).map(([s, v]) => [s, Array.isArray(v) ? v.map((e) => ({ ...e, enable: true })) : v]))

async function chatOn(create, listing, model, extra = {}) {
  const sent = []
  globalThis.fetch = async (url, init) => {
    if (new URL(String(url)).pathname.endsWith("/model/list")) return Response.json(listing)
    if (String(url).includes("agent_chat_generation")) {
      sent.push(JSON.parse(_internal.decodeBody(init.body)))
      const chunk = { model: "auto", choices: [{ delta: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
      return new Response(`data: ${JSON.stringify({ body: JSON.stringify(chunk) })}\n\ndata: ${JSON.stringify({ body: "[DONE]" })}\n\n`, { headers: { "content-type": "text/event-stream" } })
    }
    throw new Error(`unexpected upstream ${url}`)
  }
  const auth = { type: "oauth", access: "t", refresh: "r", expires: Date.now() + 3600000, uid: "u", machineId: "m" }
  const hooks = await create({ client: { auth: { set: async () => {} } } })
  const loader = await hooks.auth.loader(async () => auth)
  const res = await loader.fetch("https://test.invalid/chat/completions", { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra }) })
  return { res, sent }
}

for (const [site, create, file] of [["qoder", QoderAuthPlugin, "listing.json"], ["qoder-cn", QoderCNAuthPlugin, "cn-listing-free-view.json"]]) {
  for (const key of ["dfmodel", "kmodel_latest"]) {
    test(`${site}: ${key}'s model_config is the client's, not the listing entry`, async () => {
      const listing = paid(read(file))
      const entry = Object.values(listing).flat().find((e) => e?.key === key)
      expect(entry).toBeTruthy()
      const { res, sent } = await chatOn(create, listing, key)
      expect(res.status).toBe(200)
      const mc = sent.at(-1).model_config
      expect(Object.keys(mc)).toEqual(CLIENT_KEYS)
      expect(mc).toMatchObject({ key, display_name: entry.display_name, model: "", api_key: "", url: "", format: entry.format, source: entry.source, max_input_tokens: entry.max_input_tokens, is_vl: !!entry.is_vl })
      for (const k of ["minimal_version", "strategies", "price_factor", "thinking_config", "context_config", "enable", "is_default"]) expect(mc).not.toHaveProperty(k)
    })
  }
}

test("dfmodel's listing entries carry a minimal_version, which no client sends", () => {
  for (const file of ["listing.json", "cn-listing-free-view.json"]) {
    const df = Object.values(read(file)).flat().filter((e) => e?.key === "dfmodel")
    expect(df.length).toBeGreaterThan(0)
    expect(df.every((e) => e.minimal_version)).toBe(true)
  }
})

test("is_reasoning is sent off when the request turns thinking off", async () => {
  const listing = read("cn-listing-free-view.json")
  const thinker = listing.chat.find((e) => e.enable && e.is_reasoning && e.thinking_config?.disabled)
  expect(thinker).toBeTruthy()
  const { sent } = await chatOn(QoderCNAuthPlugin, listing, thinker.key, { reasoning_effort: "none" })
  expect(sent.at(-1).model_config.is_reasoning).toBe(false)
  const on = await chatOn(QoderCNAuthPlugin, listing, thinker.key, { reasoning_effort: "high" })
  expect(on.sent.at(-1).model_config.is_reasoning).toBe(true)
})

test("a model with no key of its own is refused, never sent as Auto", () => {
  const listing = read("cn-listing-free-view.json")
  const df = listing.chat.find((e) => e.key === "dfmodel")
  const chat = { model: "dfmodel", messages: [{ role: "user", content: "hi" }] }
  for (const config of [{ ...df, key: "" }, { ...df, key: "auto" }, { ...df, key: "kmodel_latest" }]) {
    const m = { ..._internal.modelInfo(df), config }
    expect(() => _internal.qoderBody(chat, m)).toThrow(/no Qoder model key/)
  }
  expect(_internal.qoderBody(chat, _internal.modelInfo(df)).model_config.key).toBe("dfmodel")
})

test("a model the listing doesn't have is answered 400, with nothing sent", async () => {
  const { res, sent } = await chatOn(QoderCNAuthPlugin, read("cn-listing-free-view.json"), "Deepseek-Flash")
  expect(res.status).toBe(400)
  expect(sent).toHaveLength(0)
})

// The business record names the model (plugins#692, chansee97; #638 again
// after 0.2.54): qodercli 1.1.82 sends business.model_key beside the
// product, version, type, id, name, begin_at and stage, and Qoder books the
// call from it. Without it Qoder and Qoder CN billed every model as Auto.
for (const [site, create, file] of [["qoder", QoderAuthPlugin, "listing.json"], ["qoder-cn", QoderCNAuthPlugin, "cn-listing-free-view.json"]]) {
  for (const key of ["dfmodel", "kmodel_latest"]) {
    test(`${site}: business.model_key is ${key}, the model the request names`, async () => {
      const { res, sent } = await chatOn(create, paid(read(file)), key)
      expect(res.status).toBe(200)
      const b = sent.at(-1).business
      expect(b.model_key).toBe(key)
      expect(b.model_key).toBe(sent.at(-1).model_config.key)
      expect(Object.keys(b)).toEqual(expect.arrayContaining(["product", "version", "type", "id", "name", "begin_at", "stage"]))
    })
  }
}

test("one task's calls on two models each name their own model", () => {
  const listing = read("cn-listing-free-view.json")
  const chat = { messages: [{ role: "user", content: "hi" }] }
  const task = _internal.taskOf("s", chat)
  const a = _internal.qoderBody({ ...chat, model: "dfmodel" }, _internal.modelInfo(listing.chat.find((e) => e.key === "dfmodel")), "s", task)
  const b = _internal.qoderBody({ ...chat, model: "kmodel_latest" }, _internal.modelInfo(listing.chat.find((e) => e.key === "kmodel_latest")), "s", task)
  expect(a.business.id).toBe(b.business.id)
  expect([a.business.model_key, b.business.model_key]).toEqual(["dfmodel", "kmodel_latest"])
})

test("QwenWork's record stays as its own client builds it, with no model_key", () => {
  const listing = read("cn-listing-free-view.json")
  const df = _internal.modelInfo(listing.chat.find((e) => e.key === "dfmodel"))
  const chat = { model: "dfmodel", messages: [{ role: "user", content: "hi" }] }
  expect(_internal.qoderBody(chat, df, "", undefined, _internal.SITES.qwenwork).business).not.toHaveProperty("model_key")
  expect(_internal.qoderBody(chat, df, "", undefined, _internal.SITES.qoder).business.model_key).toBe("dfmodel")
})
