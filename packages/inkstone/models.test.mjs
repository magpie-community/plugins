// The model catalogue: the live /v1/models set intersected with the public
// metadata, without the decision model and without thinking tiers (the
// platform documents that thinking cannot be turned on or off by request).
import "./nonet.mjs"
import { readFileSync } from "node:fs"
import { expect, test } from "bun:test"
import {
  BOOT_MODELS,
  DEFAULT_CONTEXT,
  DEFAULT_OUTPUT,
  bootModelOf,
  bootModels,
  createCatalog,
  isChatCandidate,
  mergeModel,
  normalizePublic,
  publicRowsOf,
} from "./lib/models.mjs"

const load = (name) => JSON.parse(readFileSync(new URL("./testdata/" + name, import.meta.url), "utf8"))
const META = publicRowsOf(load("public-models.json"))

test("the real public metadata has ten models, one of them a decision model", () => {
  expect(META.length).toBe(10)
  expect(META.filter((m) => m.type === "decision").map((m) => m.id)).toEqual(["intern-decision-4b"])
  // four of the ten are free at the captured prices
  expect(META.filter((m) => m.free).map((m) => m.id).sort()).toEqual([
    "Agents-A1",
    "Atria-Dawn",
    "Sage-A1.5",
    "intern-s2",
  ])
})

test("paid models carry a rate derived from the input price (1000 credits/1M = x1); free ones carry none", () => {
  const rates = Object.fromEntries(META.filter((m) => m.rate).map((m) => [m.id, m.rate]))
  expect(rates).toEqual({
    "deepseek-v4.1-flash-1017": 1,
    "glm-5.3": 8,
    "intern-decision-4b": 0.2,
    "kimi-k2.6": 6.5,
    "minimax-m3": 2.1,
    "qwen3.8-27b": 0.8,
  })
  for (const m of META.filter((m) => m.free)) expect(m.rate).toBeUndefined()
})

test("free and rate reach the merged model", () => {
  const glm = mergeModel({ id: "glm-5.3" }, META.find((m) => m.id === "glm-5.3"))
  expect(glm.rate).toBe(8)
  expect(glm.free).toBeUndefined()

  const sage = mergeModel({ id: "Sage-A1.5" }, META.find((m) => m.id === "Sage-A1.5"))
  expect(sage.free).toBe(true)
  expect(sage.rate).toBeUndefined()
})

test("a model keeps the catalogue's context and capability flags", () => {
  const glm = mergeModel({ id: "glm-5.3" }, META.find((m) => m.id === "glm-5.3"))
  expect(glm.name).toBe("GLM-5.3")
  expect(glm.limit).toEqual({ context: 1048576, output: DEFAULT_OUTPUT })
  expect(glm.reasoning).toBe(true)
  expect(glm.tool_call).toBe(true)
  expect(glm.capabilities.input.image).toBe(false)
  // no variants: the platform publishes no thinking tiers it accepts.
  expect(glm.variants).toBeUndefined()

  const agents = mergeModel({ id: "Agents-A1" }, META.find((m) => m.id === "Agents-A1"))
  expect(agents.limit.context).toBe(262144)
  expect(agents.reasoning).toBe(false)
  expect(agents.tool_call).toBe(true)
  expect(agents.capabilities.input.image).toBe(true)
  expect(agents.modalities.input).toEqual(["text", "image"])
})

test("a model outside the metadata is kept from the live list with safe defaults", () => {
  const m = mergeModel({ id: "brand-new-model", context: 131072, features: ["tools", "reasoning"] }, undefined)
  expect(m.name).toBe("brand-new-model")
  expect(m.limit.context).toBe(131072)
  expect(m.limit.output).toBe(DEFAULT_OUTPUT)
  expect(m.reasoning).toBe(true)
  expect(m.tool_call).toBe(true)
})

test("the decision model is never a chat candidate", () => {
  const decision = META.find((m) => m.id === "intern-decision-4b")
  expect(isChatCandidate({ id: "intern-decision-4b" }, decision)).toBe(false)
  // a model that only speaks Anthropic is not chat
  const anth = { id: "x", type: "chat", protocols: new Set(["anthropic_messages"]) }
  expect(isChatCandidate({ id: "x" }, anth)).toBe(false)
  // no metadata: the live /v1/models data[] is generative by definition
  expect(isChatCandidate({ id: "x" }, undefined)).toBe(true)
})

test("the catalogue intersects the key's list with the metadata and drops the decision model", async () => {
  const live = [
    { id: "glm-5.3" },
    { id: "Agents-A1" },
    { id: "intern-decision-4b" },
    { id: "brand-new-model" },
  ]
  const catalog = createCatalog({
    fetchLive: async () => live,
    fetchMeta: async () => META,
  })
  const rows = await catalog.forKey("sk-test")
  expect(rows.map((r) => r.id)).toEqual(["glm-5.3", "Agents-A1", "brand-new-model"])
})

test("a live read that fails keeps the last successful list for that key", async () => {
  let fail = false
  const catalog = createCatalog({
    fetchLive: async () => {
      if (fail) throw new Error("HTTP 500")
      return [{ id: "glm-5.3" }]
    },
    fetchMeta: async () => META,
  })
  expect((await catalog.forKey("k")).map((r) => r.id)).toEqual(["glm-5.3"])
  fail = true
  expect((await catalog.forKey("k")).map((r) => r.id)).toEqual(["glm-5.3"])
})

test("an empty answer is cached briefly and gives no models, not the bootstrap set", async () => {
  const catalog = createCatalog({
    fetchLive: async () => [],
    fetchMeta: async () => META,
  })
  expect(await catalog.forKey("k")).toEqual([])
  expect(await catalog.forKey("k")).toEqual([])
})

test("the bootstrap list is non-empty, every entry has a usable limit and its price tier", () => {
  const boot = bootModels()
  expect(Object.keys(boot).length).toBeGreaterThan(0)
  expect(Object.keys(boot)).toEqual(Object.keys(BOOT_MODELS))
  for (const [id, m] of Object.entries(boot)) {
    expect(m.limit.context).toBeGreaterThan(0)
    expect(m.limit.output).toBe(DEFAULT_OUTPUT)
    expect(m.variants).toBeUndefined()
    if (BOOT_MODELS[id].free) {
      expect(m.free).toBe(true)
      expect(m.rate).toBeUndefined()
    } else {
      expect(m.free).toBeUndefined()
      expect(m.rate).toBeGreaterThan(0)
    }
  }
})

test("the bootstrap list agrees with the captured catalogue on every id it shares", () => {
  const byId = new Map(META.map((m) => [m.id, m]))
  for (const [id, boot] of Object.entries(BOOT_MODELS)) {
    const meta = byId.get(id)
    expect(meta).toBeDefined()
    // free/rate must not contradict the live prices: a bootstrap entry claiming
    // free for a priced model would show a "free" badge on a paid model.
    expect(Boolean(boot.free)).toBe(Boolean(meta.free))
    if (!boot.free) expect(boot.rate).toBe(meta.rate)
  }
})

test("a metadata row without prices is not marked free", () => {
  const bare = normalizePublic({ id: "no-prices", display_name: "No Prices" })
  expect(bare.id).toBe("no-prices")
  expect(bare.free).toBeUndefined()
  expect(bare.rate).toBeUndefined()
  // a zero price on both sides is free
  const free = normalizePublic({ id: "zero", input_uncached_price: 0, output_price: 0 })
  expect(free.free).toBe(true)
  // a zero input but a priced output is not free
  const outOnly = normalizePublic({ id: "out", input_uncached_price: 0, output_price: 5 })
  expect(outOnly.free).toBe(false)
  // an empty string, junk or a negative number is a missing price, not 0
  expect(normalizePublic({ id: "dirty", input_uncached_price: "", output_price: "" }).free).toBeUndefined()
  expect(normalizePublic({ id: "dirty2", input_uncached_price: -5, output_price: 0 }).free).toBeUndefined()
  expect(normalizePublic({ id: "dirty3", input_uncached_price: "n/a", output_price: 0 }).free).toBeUndefined()
  // junk rows do not throw
  expect(normalizePublic(null)).toBeNull()
  expect(normalizePublic({})).toBeNull()
  expect(normalizePublic({ id: 42 })).toBeNull()
})

test("mergeModel survives two empty sides", () => {
  expect(mergeModel(null, null)).toBeNull()
  expect(mergeModel({}, {})).toBeNull()
  expect(bootModelOf("no-such-model")).toBeNull()
})
