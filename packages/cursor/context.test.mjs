// The list is Cursor's picker, as pi-cursor-sdk lists Cursor's catalog: a
// model once for each context size, named "<title> @ <size>" with that
// window; one without sizes once, with Cursor's limit. Effort and fast are
// the request's, sent as the variant's parameters. Nothing reaches Cursor.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { CursorAuthPlugin, _internal } from "./index.mjs"

const { usable, request } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
let n = 0
const tok = () => "tok-context-" + ++n

const en = (...vs) => ({ enumParameter: { values: vs.map((value) => ({ value })) } })
const bool = { booleanParameter: { values: [{ value: "false" }, { value: "true" }] } }
const v = (pv, o = {}) => ({ parameterValues: Object.entries(pv).map(([id, value]) => ({ id, value })), ...o })
export const PICKER = [
  {
    name: "claude-opus-5-5", legacySlugs: ["claude-5.5-opus"], clientDisplayName: "Claude Opus 5.5", contextTokenLimit: 300000, contextTokenLimitForMaxMode: 1000000, supportsNonMaxMode: true,
    parameterDefinitions: [{ id: "context", parameterType: en("300k", "1m") }, { id: "effort", parameterType: en("low", "medium", "high", "xhigh", "max") }, { id: "fast", parameterType: bool }],
    variants: [
      v({ context: "300k", effort: "medium", fast: "false" }, { isDefaultNonMaxConfig: true, legacySlug: "claude-opus-5-5-medium" }),
      v({ context: "300k", effort: "high", fast: "false" }, { legacySlug: "claude-opus-5-5-high" }),
      v({ context: "300k", effort: "medium", fast: "true" }, { isMaxMode: true, legacySlug: "claude-opus-5-5-medium-fast" }),
      v({ context: "300k", effort: "high", fast: "true" }, { isMaxMode: true, legacySlug: "claude-opus-5-5-high-fast" }),
      v({ context: "1m", effort: "medium", fast: "false" }, { isMaxMode: true, isDefaultMaxConfig: true, legacySlug: "claude-opus-5-5-medium" }),
    ],
  },
  {
    name: "claude-haiku-5-5", clientDisplayName: "Claude Haiku 5.5", contextTokenLimit: 300000, contextTokenLimitForMaxMode: 1000000, supportsNonMaxMode: true,
    parameterDefinitions: [{ id: "thinking", parameterType: bool }, { id: "context", parameterType: en("300k", "1m") }, { id: "reasoning_effort", parameterType: en("low", "medium", "high") }],
    variants: [v({ thinking: "true", context: "300k", reasoning_effort: "high" }, { isDefaultNonMaxConfig: true, legacySlug: "claude-haiku-5-5-thinking-high" }), v({ thinking: "true", context: "300k", reasoning_effort: "low" }, { legacySlug: "claude-haiku-5-5-thinking-low" }), v({ thinking: "false", context: "300k", reasoning_effort: "high" }, { legacySlug: "claude-haiku-5-5-high" }), v({ thinking: "false", context: "300k", reasoning_effort: "low" }, { legacySlug: "claude-haiku-5-5-low" })],
  },
  {
    name: "grok-4.7", clientDisplayName: "Grok 4.7", contextTokenLimit: 256000, contextTokenLimitForMaxMode: 500000, supportsNonMaxMode: true,
    parameterDefinitions: [{ id: "context", parameterType: en("256k", "500k") }, { id: "reasoning_effort", parameterType: en("low", "high") }, { id: "fast", parameterType: bool }],
    variants: [v({ context: "256k", reasoning_effort: "high", fast: "true" }, { isDefaultNonMaxConfig: true, legacySlug: "grok-4.7-high-fast" }), v({ context: "256k", reasoning_effort: "low", fast: "true" }, { legacySlug: "grok-4.7-low-fast" }), v({ context: "256k", reasoning_effort: "high", fast: "false" }, { legacySlug: "grok-4.7-high" }), v({ context: "256k", reasoning_effort: "low", fast: "false" }, { legacySlug: "grok-4.7-low" }), v({ context: "500k", reasoning_effort: "high", fast: "true" }, { isMaxMode: true })],
  },
  { name: "grok-4.6", clientDisplayName: "Grok 4.6", contextTokenLimit: 256000, contextTokenLimitForMaxMode: 256000, supportsNonMaxMode: true, parameterDefinitions: [{ id: "effort", parameterType: en("low", "high") }], variants: [v({ effort: "high" }, { isDefaultNonMaxConfig: true, legacySlug: "cursor-grok-4.6-high" }), v({ effort: "low" }, { legacySlug: "cursor-grok-4.6-low" })] },
  { name: "composer-2.5", clientDisplayName: "Composer 2.5", contextTokenLimit: 200000, supportsNonMaxMode: true, parameterDefinitions: [{ id: "fast", parameterType: bool }], variants: [v({ fast: "true" }, { isDefaultNonMaxConfig: true, legacySlug: "composer-2.5-fast" }), v({ fast: "false" }, { legacySlug: "composer-2.5" })] },
  { name: "default", clientDisplayName: "Auto", supportsNonMaxMode: true, variants: [v({}, { isDefaultNonMaxConfig: true, legacySlug: "default" })] },
  { name: "max-only", clientDisplayName: "Max Only", contextTokenLimit: 200000, contextTokenLimitForMaxMode: 400000, supportsNonMaxMode: false },
  { name: "secret", clientDisplayName: "Secret", isHidden: true },
  { name: "tab-only", clientDisplayName: "Tab", onlySupportsCmdK: true },
  // the CLI's picker leaves these out
  { name: "claude-4.5-haiku", clientDisplayName: "Haiku 4.5", contextTokenLimit: 200000, supportsNonMaxMode: true },
  { name: "claude-haiku-4-5", clientDisplayName: "Claude Haiku 4.5", contextTokenLimit: 200000, supportsNonMaxMode: true },
]

export function fakeAPI(picker = PICKER, usableIDs) {
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.endsWith("/agent.v1.AgentService/GetUsableModels")) return usableIDs ? Response.json({ models: usableIDs.map((modelId) => ({ modelId })) }) : new Response("down", { status: 503 })
    if (u.endsWith("/aiserver.v1.AiService/AvailableModels")) return picker ? Response.json({ models: picker }) : new Response("down", { status: 503 })
    throw new Error("the test asked " + u)
  }
}

test("a model once for each context size, named with it and with that window", async () => {
  fakeAPI()
  const raw = await usable(tok())
  const by = Object.fromEntries(raw.map((m) => [m.id, [m.name, m.context]]))
  expect(by).toEqual({
    "claude-opus-5-5@300k": ["Claude Opus 5.5 @ 300k", 300000],
    "claude-opus-5-5@1m": ["Claude Opus 5.5 @ 1m", 1000000],
    "claude-haiku-5-5@300k": ["Claude Haiku 5.5 @ 300k", 300000],
    "claude-haiku-5-5@1m": ["Claude Haiku 5.5 @ 1m", 1000000],
    "grok-4.7@256k": ["Grok 4.7 @ 256k", 256000],
    "grok-4.7@500k": ["Grok 4.7 @ 500k", 500000],
    // no sizes: Cursor's limit (for a Max Mode only model, Max Mode's)
    "grok-4.6": ["Grok 4.6", 256000],
    "composer-2.5": ["Composer 2.5", 200000],
    "max-only": ["Max Only", 400000],
    // Cursor's default, Auto; no limit given
    auto: ["Auto", 200000],
  })
  // hidden, Tab-only and the ones the CLI's picker leaves out are not there
  for (const gone of ["secret", "tab-only", "claude-4.5-haiku", "claude-haiku-4-5"]) expect(raw.some((m) => m.run === gone)).toBe(false)
})

test("the provider's list, efforts as variants, no model of its own for fast or an effort", async () => {
  fakeAPI()
  const hooks = await CursorAuthPlugin()
  const jwt = ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200 + ++n })).toString("base64url"), "s"].join(".")
  const list = await hooks.provider.models({ models: {} }, { auth: { type: "oauth", access: jwt, refresh: "", expires: 0 } })
  expect(list["claude-opus-5-5@300k"].limit.context).toBe(300000)
  expect(Object.keys(list["claude-opus-5-5@300k"].variants)).toEqual(["low", "medium", "high", "xhigh", "max"])
  expect(Object.keys(list["claude-haiku-5-5@300k"].variants)).toEqual(["low", "medium", "high"])
  expect(list["composer-2.5"].capabilities.reasoning).toBe(false)
  expect(Object.keys(list).some((id) => /-fast$|-(low|medium|high)$/.test(id))).toBe(false)
})

test("a request goes as the variant its size, effort and fast pick, in that variant's mode", async () => {
  fakeAPI()
  const raw = await usable(tok())
  const p = (r) => Object.fromEntries(r.params.map((x) => [x.id, x.value]))
  // the variant's own id, which the agent API takes (not the picker's name)
  let r = request(raw, "claude-opus-5-5@300k", "", undefined)
  expect([r.id, r.maxMode, p(r)]).toEqual(["claude-opus-5-5-medium", false, { context: "300k", effort: "medium", fast: "false" }])
  r = request(raw, "claude-opus-5-5@300k", "high", true)
  expect([r.id, r.maxMode, p(r)]).toEqual(["claude-opus-5-5-high-fast", true, { context: "300k", effort: "high", fast: "true" }])
  r = request(raw, "claude-opus-5-5@1m", "medium", undefined)
  expect([r.id, r.maxMode, p(r).context]).toEqual(["claude-opus-5-5-medium", true, "1m"])
  expect(request(raw, "grok-4.6", "low", undefined).id).toBe("cursor-grok-4.6-low")
  expect(request(raw, "composer-2.5", "", undefined).id).toBe("composer-2.5")
  // an effort it lacks: the nearest
  expect(p(request(raw, "claude-opus-5-5@300k", "minimal", undefined)).effort).toBe("low")
  // a Claude asked not to think
  expect(p(request(raw, "claude-haiku-5-5@300k", "none", undefined))).toEqual({ thinking: "false", context: "300k", reasoning_effort: "high" })
  // fast off unless asked, though Cursor's default has it on
  expect(p(request(raw, "grok-4.7@256k", "high", undefined)).fast).toBe("false")
  expect(p(request(raw, "composer-2.5", "", true))).toEqual({ fast: "true" })
  // a size more than Cursor allows outside Max Mode, with no variant for it
  r = request(raw, "grok-4.7@500k", "low", false)
  expect([r.maxMode, p(r)]).toEqual([true, { context: "500k", reasoning_effort: "low", fast: "false" }])
  expect(request(raw, "max-only", "", undefined).maxMode).toBe(true)
  expect(request(raw, "auto", "", undefined)).toMatchObject({ id: "default", params: [], maxMode: false })
  // not in the list: as it is named
  expect(request(raw, "some-cursor-id", "", undefined)).toEqual({ id: "some-cursor-id", params: [], maxMode: false })
})

test("a picker Cursor can't give is a failure, not an empty list", async () => {
  fakeAPI(null)
  await expect(usable(tok())).rejects.toThrow()
})

// what 0.1.11 listed for this picker, each family of the variants' ids one
// model (offered() there, given the legacySlugs above as the usable list):
// claude-opus-5-5, claude-opus-5-5-fast, claude-haiku-5-5-thinking,
// claude-haiku-5-5, grok-4.7-fast, grok-4.7, cursor-grok-4.6,
// composer-2.5-fast, composer-2.5, default. They are in agents' configs
// and magpie's picks; the picker's bare name is a 502 from the agent API.
test("an id 0.1.11 listed still runs, as the variant it stood for, at the effort asked", async () => {
  fakeAPI()
  const raw = await usable(tok())
  const q = (id, effort = "", fast) => {
    const r = request(raw, id, effort, fast)
    return [r.id, r.maxMode, Object.fromEntries(r.params.map((x) => [x.id, x.value]))]
  }
  // a family that is the picker's name too: its default size, not fast
  expect(q("claude-opus-5-5")).toEqual(["claude-opus-5-5-medium", false, { context: "300k", effort: "medium", fast: "false" }])
  expect(q("claude-opus-5-5", "high")).toEqual(["claude-opus-5-5-high", false, { context: "300k", effort: "high", fast: "false" }])
  expect(q("claude-opus-5-5", "", true)).toEqual(["claude-opus-5-5-medium-fast", true, { context: "300k", effort: "medium", fast: "true" }])
  expect(q("grok-4.7", "low")).toEqual(["grok-4.7-low", false, { context: "256k", reasoning_effort: "low", fast: "false" }])
  expect(q("cursor-grok-4.6")).toEqual(["cursor-grok-4.6-high", false, { effort: "high" }])
  expect(q("cursor-grok-4.6", "low")).toEqual(["cursor-grok-4.6-low", false, { effort: "low" }])
  // a -fast family: fast, though the request doesn't ask
  expect(q("claude-opus-5-5-fast")).toEqual(["claude-opus-5-5-medium-fast", true, { context: "300k", effort: "medium", fast: "true" }])
  expect(q("claude-opus-5-5-fast", "high")).toEqual(["claude-opus-5-5-high-fast", true, { context: "300k", effort: "high", fast: "true" }])
  expect(q("grok-4.7-fast", "low")).toEqual(["grok-4.7-low-fast", false, { context: "256k", reasoning_effort: "low", fast: "true" }])
  expect(q("composer-2.5-fast")).toEqual(["composer-2.5-fast", false, { fast: "true" }])
  // a Claude with thinking apart from one without
  expect(q("claude-haiku-5-5-thinking", "low")).toEqual(["claude-haiku-5-5-thinking-low", false, { thinking: "true", context: "300k", reasoning_effort: "low" }])
  expect(q("claude-haiku-5-5")).toEqual(["claude-haiku-5-5-high", false, { thinking: "false", context: "300k", reasoning_effort: "high" }])
  expect(q("claude-haiku-5-5", "low")).toEqual(["claude-haiku-5-5-low", false, { thinking: "false", context: "300k", reasoning_effort: "low" }])
  expect(q("default")).toEqual(["default", false, {}])
})

test("a variant's own id, and a model's legacy slug, run as what they name", async () => {
  fakeAPI()
  const raw = await usable(tok())
  const q = (id, effort = "", fast) => {
    const r = request(raw, id, effort, fast)
    return [r.id, r.maxMode, Object.fromEntries(r.params.map((x) => [x.id, x.value]))]
  }
  expect(q("claude-opus-5-5-high")).toEqual(["claude-opus-5-5-high", false, { context: "300k", effort: "high", fast: "false" }])
  expect(q("claude-opus-5-5-high-fast")).toEqual(["claude-opus-5-5-high-fast", true, { context: "300k", effort: "high", fast: "true" }])
  // the request's effort and tier still count
  expect(q("claude-opus-5-5-high", "medium")[0]).toBe("claude-opus-5-5-medium")
  expect(q("claude-opus-5-5-high", "", true)[0]).toBe("claude-opus-5-5-high-fast")
  // an id two sizes share: the default size, outside Max Mode
  expect(q("claude-opus-5-5-medium")).toEqual(["claude-opus-5-5-medium", false, { context: "300k", effort: "medium", fast: "false" }])
  // an effort no variant here is named for: the family, at that effort
  expect(q("claude-opus-5-5-xhigh")[2]).toEqual({ context: "300k", effort: "xhigh", fast: "false" })
  expect(q("claude-5.5-opus")).toEqual(["claude-opus-5-5-medium", false, { context: "300k", effort: "medium", fast: "false" }])
})

test("a variant the usable list says the account hasn't got is neither offered nor asked for", async () => {
  // Opus at medium only, Grok 4.6 at high only; nothing of Haiku or Grok 4.7,
  // which are the picker's alone and kept whole
  fakeAPI(PICKER, ["claude-opus-5-5-medium", "cursor-grok-4.6-high", "composer-2.5", "composer-2.5-fast", "default"])
  const raw = await usable(tok())
  const levels = Object.fromEntries(raw.map((m) => [m.id, Object.keys(m.levels)]))
  expect(levels["claude-opus-5-5@300k"]).toEqual(["medium"])
  expect(levels["claude-opus-5-5@1m"]).toEqual(["medium"])
  expect(levels["grok-4.6"]).toEqual(["high"])
  expect(levels["claude-haiku-5-5@300k"]).toEqual(["low", "medium", "high"])
  expect(levels["grok-4.7@256k"]).toEqual(["low", "high"])
  const q = (id, effort = "", fast) => {
    const r = request(raw, id, effort, fast)
    return [r.id, r.maxMode, Object.fromEntries(r.params.map((x) => [x.id, x.value]))]
  }
  // high and fast, which it hasn't: the variant it has
  expect(q("claude-opus-5-5@300k", "high", true)).toEqual(["claude-opus-5-5-medium", false, { context: "300k", effort: "medium", fast: "false" }])
  expect(q("claude-opus-5-5@1m", "high")).toEqual(["claude-opus-5-5-medium", true, { context: "1m", effort: "medium", fast: "false" }])
  expect(q("cursor-grok-4.6", "low")).toEqual(["cursor-grok-4.6-high", false, { effort: "high" }])
  expect(q("composer-2.5", "", true)).toEqual(["composer-2.5-fast", false, { fast: "true" }])
})

// Opus 5 as Cursor has it: without thinking, low to high; with it, up to
// max, the default. An id of the branch without thinking asked at xhigh
// fitted nothing and went as the default's id with thinking=false, a name
// and parameters at odds (review of #51).
const OPUS5 = {
  name: "claude-opus-5", clientDisplayName: "Claude Opus 5", contextTokenLimit: 300000, contextTokenLimitForMaxMode: 1000000, supportsNonMaxMode: true,
  parameterDefinitions: [{ id: "thinking", parameterType: bool }, { id: "context", parameterType: en("300k") }, { id: "effort", parameterType: en("low", "medium", "high", "xhigh", "max") }, { id: "fast", parameterType: bool }],
  variants: [
    ...["low", "medium", "high"].flatMap((e) => [v({ thinking: "false", context: "300k", effort: e, fast: "false" }, { legacySlug: "claude-opus-5-" + e }), v({ thinking: "false", context: "300k", effort: e, fast: "true" }, { isMaxMode: true, legacySlug: "claude-opus-5-" + e + "-fast" })]),
    ...["low", "medium", "high", "xhigh", "max"].flatMap((e) => [v({ thinking: "true", context: "300k", effort: e, fast: "false" }, { legacySlug: "claude-opus-5-thinking-" + e, ...(e === "high" ? { isDefaultNonMaxConfig: true } : {}) }), v({ thinking: "true", context: "300k", effort: e, fast: "true" }, { isMaxMode: true, legacySlug: "claude-opus-5-thinking-" + e + "-fast" })]),
  ],
}

test("an id of Cursor's own at an effort its branch hasn't goes as that branch's nearest, not the default's id", async () => {
  fakeAPI([OPUS5])
  const raw = await usable(tok())
  const q = (id, effort = "", fast) => {
    const r = request(raw, id, effort, fast)
    return [r.id, r.maxMode, Object.fromEntries(r.params.map((x) => [x.id, x.value]))]
  }
  // without thinking it stops at high
  expect(q("claude-opus-5-low", "xhigh")).toEqual(["claude-opus-5-high", false, { thinking: "false", context: "300k", effort: "high", fast: "false" }])
  expect(q("claude-opus-5-medium-fast", "max")).toEqual(["claude-opus-5-high-fast", true, { thinking: "false", context: "300k", effort: "high", fast: "true" }])
  // the 0.1.x family without thinking
  expect(q("claude-opus-5", "max")).toEqual(["claude-opus-5-high", false, { thinking: "false", context: "300k", effort: "high", fast: "false" }])
  expect(q("claude-opus-5-fast", "xhigh")).toEqual(["claude-opus-5-high-fast", true, { thinking: "false", context: "300k", effort: "high", fast: "true" }])
  // with thinking at xhigh, asked not to think: no thinking, at its nearest effort
  expect(q("claude-opus-5-thinking-xhigh", "none")).toEqual(["claude-opus-5-high", false, { thinking: "false", context: "300k", effort: "high", fast: "false" }])
  // what the branch has still goes as asked, and the other branch is untouched
  expect(q("claude-opus-5-low", "high")[0]).toBe("claude-opus-5-high")
  expect(q("claude-opus-5-thinking-low", "max")[0]).toBe("claude-opus-5-thinking-max")
  // every id sent agrees with its parameters
  const slug = new Map(OPUS5.variants.map((x) => [x.legacySlug, Object.fromEntries(x.parameterValues.map((p) => [p.id, p.value]))]))
  for (const id of [...slug.keys(), "claude-opus-5", "claude-opus-5-fast", "claude-opus-5-thinking", "claude-opus-5-thinking-fast"])
    for (const effort of ["", "none", "low", "medium", "high", "xhigh", "max"])
      for (const fast of [undefined, true]) {
        const [sent, , params] = q(id, effort, fast)
        expect([id, effort, fast, params]).toEqual([id, effort, fast, { ...params, ...slug.get(sent) }])
      }
})
