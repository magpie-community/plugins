// A Claude Cursor hides from an account is in the usable list (cursor-agent
// models) and not in the picker. The full catalog (AvailableModels with
// scope 3) has it: those models are listed as the picker's are, once for each
// context size ("claude-opus-5-5@300k", "@1m"), thinking a parameter, the
// efforts the account is served, the 1m size in Max Mode. The picker's own
// models, and any id of the usable list that is not Anthropic's, stay as they
// are; an id saved from an earlier list still runs. Nothing reaches Cursor.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { usable, request } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
let n = 0
const tok = () => "tok-catalog-" + ++n

const en = (...vs) => ({ enumParameter: { values: vs.map((value) => ({ value })) } })
const bool = { booleanParameter: { values: [{ value: "false" }, { value: "true" }] } }

// a catalog model as scope 3 gives it: its variants without legacySlug, the
// ids in the model's legacySlugs. slug(thinking, effort, fast) is Cursor's id.
function model(name, title, { thinks, contexts, efforts = [], fast, slug, limit, limitMax, defaults = {}, only = [] }) {
  const defs = [
    ...(thinks ? [{ id: "thinking", parameterType: bool }] : []),
    { id: "context", parameterType: en(...contexts) },
    ...(efforts.length ? [{ id: "effort", parameterType: en(...efforts) }] : []),
    ...(fast ? [{ id: "fast", parameterType: bool }] : []),
  ]
  const variants = []
  const slugs = []
  for (const t of thinks ? [false, true] : [undefined])
    for (const context of contexts)
      for (const effort of efforts.length ? efforts : [undefined])
        for (const f of fast ? [false, true] : [undefined]) {
          const parameterValues = Object.entries({ thinking: t, context, effort, fast: f }).filter(([, x]) => x !== undefined).map(([id, x]) => ({ id, value: String(x) }))
          const id = slug(t, effort, f)
          if (!slugs.includes(id)) slugs.push(id)
          const maxOnly = context !== contexts[0]
          const d = (defaults.thinking === undefined || defaults.thinking === t) && (defaults.effort ?? efforts[0]) === effort && !f
          variants.push({ parameterValues, ...(maxOnly ? { isMaxMode: true } : {}), ...(d && context === contexts[0] ? { isDefaultNonMaxConfig: true } : {}), ...(d && context === contexts.at(-1) ? { isDefaultMaxConfig: true } : {}), ...(only.includes(id) ? { served: true } : {}) })
        }
  return { name, clientDisplayName: title, legacySlugs: slugs, contextTokenLimit: limit, contextTokenLimitForMaxMode: limitMax, parameterDefinitions: defs, variants, vendor: { id: "MODEL_VENDOR_ID_ANTHROPIC" } }
}

const OPUS55 = model("claude-opus-5-5", "Claude Opus 5.5", { contexts: ["300k", "1m"], efforts: ["low", "medium", "high"], fast: true, limit: 300000, limitMax: 1000000, defaults: { effort: "medium" }, slug: (t, e, f) => `claude-opus-5-5-${e}${f ? "-fast" : ""}` })
const OPUS48 = model("claude-opus-4-8", "Claude Opus 4.8", { thinks: true, contexts: ["300k", "1m"], efforts: ["low", "medium", "high"], fast: true, limit: 300000, limitMax: 1000000, defaults: { thinking: true, effort: "medium" }, slug: (t, e, f) => `claude-opus-4-8-${t ? "thinking-" : ""}${e}${f ? "-fast" : ""}` })
// the account is served Sonnet 4.6 at medium only; its picker limit is 1M
const SONNET46 = model("claude-sonnet-4-6", "Claude Sonnet 4.6", { thinks: true, contexts: ["200k", "1m"], efforts: ["low", "medium", "high"], limit: 1000000, limitMax: 1000000, defaults: { thinking: true, effort: "medium" }, slug: (t, e) => `claude-4.6-sonnet-${e}${t ? "-thinking" : ""}` })
// 200K only: nothing to add
const SONNET4 = model("claude-sonnet-4", "Claude Sonnet 4", { thinks: true, contexts: ["200k"], limit: 200000, limitMax: 200000, slug: (t) => `claude-4-sonnet${t ? "-thinking" : ""}` })
// Haiku 4.5 is live and in the catalog, and not the account's
const HAIKU45 = model("claude-haiku-4-5", "Claude Haiku 4.5", { contexts: ["200k"], limit: 200000, limitMax: 200000, slug: () => "claude-haiku-4-5" })
const OLD = { ...model("claude-3-opus", "Claude 3 Opus", { contexts: ["200k"], limit: 200000, limitMax: 200000, slug: () => "claude-3-opus" }), isHidden: true }

const PICKER = [{ name: "composer-2.5", clientDisplayName: "Composer 2.5", contextTokenLimit: 200000, supportsNonMaxMode: true, variants: [{ parameterValues: [], isDefaultNonMaxConfig: true, legacySlug: "composer-2.5" }] }]
const CATALOG = [
  { name: "default", clientDisplayName: "Auto" },
  { ...PICKER[0], variants: [{ parameterValues: [], isDefaultNonMaxConfig: true }] },
  OPUS55, OPUS48, SONNET46, SONNET4, HAIKU45, OLD,
]

const u = (modelId, displayName = modelId, o = {}) => ({ modelId, displayModelId: modelId, displayName, maxMode: false, ...o })
// Cursor names them as "Claude Opus 4.8 1M Medium Thinking Fast"
const word = { low: "Low", medium: "Medium", high: "High" }
const named = (title, m) => m.legacySlugs.map((id) => {
  const effort = Object.keys(word).find((e) => id.includes("-" + e))
  const name = [title, "1M", word[effort], /thinking/.test(id) && "Thinking", id.endsWith("-fast") && "Fast"].filter(Boolean).join(" ")
  return u(id, name, { maxMode: id.endsWith("-fast") })
})
const USABLE = [
  u("composer-2.5", "Composer 2.5"),
  ...named("Claude Opus 5.5", OPUS55),
  ...named("Claude Opus 4.8", OPUS48),
  u("claude-4.6-sonnet-medium", "Claude Sonnet 4.6 1M"), u("claude-4.6-sonnet-medium-thinking", "Claude Sonnet 4.6 1M Thinking"),
  u("claude-4-sonnet", "Claude Sonnet 4"), u("claude-4-sonnet-thinking", "Claude Sonnet 4 Thinking"),
  u("claude-3-opus", "Claude 3 Opus"),
]
const usableIDs = new Set(USABLE.map((m) => m.modelId))

// catalog: the scope 3 answer; null: it fails
function fakeAPI(catalog = CATALOG) {
  globalThis.fetch = async (url, init) => {
    const s = String(url)
    if (s.endsWith("/agent.v1.AgentService/GetUsableModels")) return Response.json({ models: USABLE })
    if (s.endsWith("/aiserver.v1.AiService/AvailableModels")) {
      if (JSON.parse(init.body).scope === 3) return catalog ? Response.json({ models: catalog }) : new Response("down", { status: 503 })
      return Response.json({ models: PICKER })
    }
    throw new Error("the test asked " + s)
  }
}

const LV = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
const levels = (e) => LV.filter((l) => l in e.levels)
const run = (raw, id, effort = "", fast) => {
  const r = request(raw, id, effort, fast)
  return { id: r.id, maxMode: r.maxMode, params: Object.fromEntries(r.params.map((p) => [p.id, p.value])) }
}
const list = async (catalog) => {
  fakeAPI(catalog)
  return usable(tok())
}
const claude = (raw) => raw.filter((e) => e.run.startsWith("claude") && !e.usableOnly)

test("the catalog's live Claude is listed once for each size, thinking a parameter, as the picker's models are", async () => {
  const raw = await list()
  expect(claude(raw).map((e) => [e.id, e.name, e.context])).toEqual([
    ["claude-opus-5-5@300k", "Claude Opus 5.5 @ 300k", 300000],
    ["claude-opus-5-5@1m", "Claude Opus 5.5 @ 1m", 1000000],
    ["claude-opus-4-8@300k", "Claude Opus 4.8 @ 300k", 300000],
    ["claude-opus-4-8@1m", "Claude Opus 4.8 @ 1m", 1000000],
    ["claude-sonnet-4-6@200k", "Claude Sonnet 4.6 @ 200k", 200000],
    ["claude-sonnet-4-6@1m", "Claude Sonnet 4.6 @ 1m", 1000000],
    ["claude-sonnet-4@200k", "Claude Sonnet 4 @ 200k", 200000],
  ])
  // the efforts the account is served at each size, and fast where Cursor has it
  expect(claude(raw).map((e) => [e.id, levels(e), e.offersFast])).toEqual([
    ["claude-opus-5-5@300k", ["low", "medium", "high"], true],
    ["claude-opus-5-5@1m", ["low", "medium", "high"], true],
    ["claude-opus-4-8@300k", ["low", "medium", "high"], true],
    ["claude-opus-4-8@1m", ["low", "medium", "high"], true],
    ["claude-sonnet-4-6@200k", ["medium"], false],
    ["claude-sonnet-4-6@1m", ["medium"], false],
    ["claude-sonnet-4@200k", ["none", "high"], false],
  ])
  // no entry of the usable list's is left for them, and nothing the account can't run
  expect(raw.filter((e) => e.usableOnly).map((e) => e.id)).toEqual(["claude-3-opus"])
  expect(raw.some((e) => /haiku/.test(e.id))).toBe(false)
})

test("the picker's models are as they were, and an id of the usable list that isn't Anthropic's is not the catalog's to list", async () => {
  const gpt = { ...OPUS55, name: "gpt-new", clientDisplayName: "GPT New", legacySlugs: ["gpt-new-low", "gpt-new-medium", "gpt-new-high"], vendor: { id: "MODEL_VENDOR_ID_OPENAI" } }
  USABLE.push(u("gpt-new-low", "GPT New Low"))
  try {
    const before = await list(null)
    const raw = await list([...CATALOG, gpt])
    const key = (e) => JSON.stringify([e.id, e.name, e.context, levels(e), e.offersFast, request([e], e.id, "", false)])
    // everything that isn't Claude: the same entries in the same order
    expect(raw.filter((e) => !e.run.startsWith("claude")).map(key)).toEqual(before.filter((e) => !e.run.startsWith("claude")).map(key))
    expect(raw.find((e) => e.id === "gpt-new")?.usableOnly).toBe(true)
    expect(raw.some((e) => e.id.startsWith("gpt-new@"))).toBe(false)
  } finally {
    USABLE.pop()
  }
})

test("every entry runs as an id the account has, with its size, in Max Mode where that size needs it, at the effort and thinking asked", async () => {
  const raw = await list()
  for (const e of claude(raw))
    for (const effort of ["", ...levels(e), "off", "ultra"])
      for (const fast of e.offersFast ? [false, true] : [false]) {
        const r = run(raw, e.id, effort, fast)
        const parts = [e.id, effort, fast, usableIDs.has(r.id), r.params.context === e.size, r.maxMode === (e.size === "1m")]
        expect(parts).toEqual([e.id, effort, fast, true, true, true])
        if (e.id.startsWith("claude-opus-5-5")) expect("thinking" in r.params).toBe(false)
        if (fast) expect(r.id.endsWith("-fast")).toBe(true)
      }
  expect(run(raw, "claude-opus-5-5@1m")).toEqual({ id: "claude-opus-5-5-medium", maxMode: true, params: { context: "1m", effort: "medium", fast: "false" } })
  expect(run(raw, "claude-opus-5-5@300k", "high", true)).toEqual({ id: "claude-opus-5-5-high-fast", maxMode: false, params: { context: "300k", effort: "high", fast: "true" } })
  // thinking is the parameter: on by default, off for none
  expect(run(raw, "claude-opus-4-8@1m", "high")).toMatchObject({ id: "claude-opus-4-8-thinking-high", maxMode: true, params: { thinking: "true", context: "1m" } })
  expect(run(raw, "claude-opus-4-8@300k", "none")).toMatchObject({ id: "claude-opus-4-8-medium", maxMode: false, params: { thinking: "false", context: "300k" } })
  // the account has Sonnet 4.6 at medium alone
  expect(run(raw, "claude-sonnet-4-6@1m", "low").id).toBe("claude-4.6-sonnet-medium-thinking")
})

test("an id from an earlier list still runs as an id the account has, at its size and with its thinking", async () => {
  const raw = await list()
  const q = (id, effort = "", fast) => {
    const r = run(raw, id, effort, fast)
    return [r.id, r.maxMode, r.params.context]
  }
  // the family 0.1.x and the first 0.2.x listed, and each variant's own id
  expect(q("claude-opus-5-5")).toEqual(["claude-opus-5-5-medium", false, "300k"])
  expect(q("claude-opus-5-5", "low")).toEqual(["claude-opus-5-5-low", false, "300k"])
  expect(q("claude-opus-5-5-high")).toEqual(["claude-opus-5-5-high", false, "300k"])
  expect(q("claude-opus-4-8-thinking", "low")[0]).toBe("claude-opus-4-8-thinking-low")
  expect(q("claude-opus-4-8", "low")[0]).toBe("claude-opus-4-8-low")
  expect(q("claude-4.6-sonnet-thinking")[0]).toBe("claude-4.6-sonnet-medium-thinking")
  expect(q("claude-4-sonnet")[0]).toBe("claude-4-sonnet")
  expect(q("claude-4-sonnet-thinking")[0]).toBe("claude-4-sonnet-thinking")
  // a sized name an earlier list had: the model at that size, thinking kept
  expect(q("claude-opus-5-5@1m")).toEqual(["claude-opus-5-5-medium", true, "1m"])
  expect(q("claude-opus-4-8-thinking@1m", "high")).toEqual(["claude-opus-4-8-thinking-high", true, "1m"])
  expect(q("claude-4.6-sonnet@1m")).toEqual(["claude-4.6-sonnet-medium", true, "1m"])
  expect(q("claude-opus-5-5@2m")).toEqual(["claude-opus-5-5-medium", true, "1m"])
  // whatever is asked, an id of Opus or Sonnet goes out as one the account has
  for (const id of [...USABLE.map((x) => x.modelId), "claude-opus-5-5", "claude-opus-4-8", "claude-opus-4-8-thinking", "claude-opus-4-8-thinking@1m", "claude-4.6-sonnet@1m", "claude-4-sonnet", "claude-opus-5-5-fast"])
    for (const effort of ["", "none", "low", "high", "max", "ultra"])
      for (const fast of [undefined, true]) expect([id, effort, fast, usableIDs.has(request(raw, id, effort, fast).id)]).toEqual([id, effort, fast, true])
})

test("a catalog Cursor can't give leaves the list as the picker and the usable list made it", async () => {
  const raw = await list(null)
  expect(claude(raw)).toEqual([])
  expect(raw.filter((e) => e.usableOnly).every((e) => e.context === 200000)).toBe(true)
  expect(raw.filter((e) => e.usableOnly).map((e) => e.id)).toContain("claude-opus-5-5")
  expect((await list([])).map((e) => e.id)).toEqual(raw.map((e) => e.id))
  // a catalog that isn't a list
  expect((await list({ nope: 1 })).map((e) => e.id)).toEqual(raw.map((e) => e.id))
})

test("a model the catalog has hidden, or the picker leaves out, or the account has no id of, is not listed; malformed entries are skipped", async () => {
  const only = (extra) => list([CATALOG[0], CATALOG[1], ...extra])
  expect(claude(await only([{ ...OPUS55, isHidden: true }]))).toEqual([])
  expect(claude(await only([{ ...OPUS55, isChatOnly: true }, { ...OPUS48, supportsAgent: false }, { ...SONNET4, onlySupportsCmdK: true }]))).toEqual([])
  expect(claude(await only([HAIKU45]))).toEqual([])
  // the picker's own model of that name is not added to
  const picker = [{ ...PICKER[0], name: "claude-opus-5-5", legacySlugs: undefined, variants: [{ parameterValues: [], legacySlug: "claude-opus-5-5-medium" }] }]
  const { fromCatalog } = _internal
  expect(fromCatalog(picker, [OPUS55], new Set(usableIDs)).map((m) => m.name)).toEqual([])
  // what is not an object, a list or a string where one is meant
  const bad = [null, 5, "x", {}, { ...OPUS55, name: "claude-bad-1", variants: [null, 5, { parameterValues: 7 }] }, { ...OPUS55, name: "claude-bad-2", legacySlugs: "x" }, { ...OPUS55, name: "claude-bad-3", variants: 5 }, { ...OPUS55, name: "claude-bad-4", parameterDefinitions: [null, { id: "effort" }] }]
  const raw = await only([...bad, OPUS55])
  expect(claude(raw).map((e) => e.id).filter((id) => !id.startsWith("claude-bad"))).toEqual(["claude-opus-5-5@300k", "claude-opus-5-5@1m"])
})

test("a variant the account has no id for is not offered: not an effort, not a size", async () => {
  // Cursor names the account high-effort 300k only through an id that says
  // the same as another (two ids for one variant): left without, it must
  // not be listed as served
  const m = model("claude-amb", "Claude Amb", { contexts: ["300k", "1m"], efforts: ["low", "high"], limit: 300000, limitMax: 1000000, defaults: { effort: "low" }, slug: (t, e) => `claude-amb-${e}` })
  m.legacySlugs = ["claude-amb-low", "claude-amb-high", "claude-amb-high-copy".replace("-copy", "") + "-high"]
  const ids = [u("claude-amb-low", "Claude Amb 1M Low")]
  const saved = [...USABLE]
  USABLE.splice(0, USABLE.length, ...USABLE.filter((x) => x.modelId === "composer-2.5"), ...ids)
  try {
    const raw = await list([CATALOG[0], CATALOG[1], m])
    const e = raw.find((x) => x.id === "claude-amb@300k")
    expect(levels(e)).toEqual(["low"])
    expect(run(raw, e.id, "high").id).toBe("claude-amb-low")
  } finally {
    USABLE.splice(0, USABLE.length, ...saved)
  }
})

test("an id the catalog gives a variant no legacySlug of is the one that says its effort, thinking and fast", async () => {
  const { slugFor } = _internal
  const v = (thinking, effort, fast) => ({ parameterValues: [{ id: "thinking", value: String(thinking) }, { id: "context", value: "300k" }, { id: "effort", value: effort }, { id: "fast", value: String(fast) }] })
  expect(slugFor(OPUS48, v(true, "high", false))).toBe("claude-opus-4-8-thinking-high")
  expect(slugFor(OPUS48, v(false, "low", true))).toBe("claude-opus-4-8-low-fast")
  // an effort the model has no id for, or one of Cursor's own already there
  expect(slugFor(OPUS48, v(true, "max", false))).toBe("")
  expect(slugFor({ ...OPUS48, legacySlugs: [] }, v(true, "high", false))).toBe("")
  expect(slugFor(OPUS48, { ...v(true, "max", false), legacySlug: "mine" })).toBe("mine")
  // an id with no effort in it is the default's (gpt-5.3-codex is medium)
  const codex = { legacySlugs: ["gpt-5.3-codex-low", "gpt-5.3-codex"], variants: [{ parameterValues: [{ id: "reasoning", value: "medium" }], isDefaultNonMaxConfig: true }] }
  expect(slugFor(codex, codex.variants[0])).toBe("gpt-5.3-codex")
  // two ids that say the same, or ids that aren't strings: none
  expect(slugFor({ legacySlugs: ["a-high", "b-high"], variants: [] }, { parameterValues: [{ id: "effort", value: "high" }] })).toBe("")
  expect(slugFor({ legacySlugs: [null, 5, "a-high"], variants: [] }, { parameterValues: [{ id: "effort", value: "high" }] })).toBe("a-high")
})

test("a parameter the catalog's variants carry and the model doesn't define (cyber=false) is never sent", async () => {
  // as the real scope 3 answer has Opus 4.7 to 5.5: every variant says cyber, no definition does
  const cyber = { ...OPUS55, variants: OPUS55.variants.map((v) => ({ ...v, parameterValues: [{ id: "cyber", value: "false" }, ...v.parameterValues] })) }
  const raw = await list([CATALOG[0], CATALOG[1], cyber])
  for (const id of ["claude-opus-5-5@300k", "claude-opus-5-5@1m"])
    for (const effort of ["", "low", "medium", "high"])
      for (const fast of [false, true]) {
        const r = run(raw, id, effort, fast)
        expect("cyber" in r.params).toBe(false)
        expect(usableIDs.has(r.id)).toBe(true)
      }
  expect(run(raw, "claude-opus-5-5@300k", "low")).toEqual({ id: "claude-opus-5-5-low", maxMode: false, params: { context: "300k", effort: "low", fast: "false" } })
  // the same model without it, as the picker has it, runs with the same params
  const plain = await list([CATALOG[0], CATALOG[1], OPUS55])
  expect(run(raw, "claude-opus-5-5@1m", "high", true)).toEqual(run(plain, "claude-opus-5-5@1m", "high", true))
})
