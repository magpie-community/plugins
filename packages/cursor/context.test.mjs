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
    name: "claude-opus-5-5", clientDisplayName: "Claude Opus 5.5", contextTokenLimit: 300000, contextTokenLimitForMaxMode: 1000000, supportsNonMaxMode: true,
    parameterDefinitions: [{ id: "context", parameterType: en("300k", "1m") }, { id: "effort", parameterType: en("low", "medium", "high", "xhigh", "max") }, { id: "fast", parameterType: bool }],
    variants: [
      v({ context: "300k", effort: "medium", fast: "false" }, { isDefaultNonMaxConfig: true, legacySlug: "claude-opus-5-5-medium" }),
      v({ context: "300k", effort: "high", fast: "false" }, { legacySlug: "claude-opus-5-5-high" }),
      v({ context: "300k", effort: "high", fast: "true" }, { isMaxMode: true, legacySlug: "claude-opus-5-5-high-fast" }),
      v({ context: "1m", effort: "medium", fast: "false" }, { isMaxMode: true, isDefaultMaxConfig: true, legacySlug: "claude-opus-5-5-medium" }),
    ],
  },
  {
    name: "claude-haiku-5-5", clientDisplayName: "Claude Haiku 5.5", contextTokenLimit: 300000, contextTokenLimitForMaxMode: 1000000, supportsNonMaxMode: true,
    parameterDefinitions: [{ id: "thinking", parameterType: bool }, { id: "context", parameterType: en("300k", "1m") }, { id: "reasoning_effort", parameterType: en("low", "medium", "high") }],
    variants: [v({ thinking: "true", context: "300k", reasoning_effort: "high" }, { isDefaultNonMaxConfig: true }), v({ thinking: "false", context: "300k", reasoning_effort: "high" })],
  },
  {
    name: "grok-4.7", clientDisplayName: "Grok 4.7", contextTokenLimit: 256000, contextTokenLimitForMaxMode: 500000, supportsNonMaxMode: true,
    parameterDefinitions: [{ id: "context", parameterType: en("256k", "500k") }, { id: "reasoning_effort", parameterType: en("low", "high") }, { id: "fast", parameterType: bool }],
    variants: [v({ context: "256k", reasoning_effort: "high", fast: "true" }, { isDefaultNonMaxConfig: true }), v({ context: "500k", reasoning_effort: "high", fast: "true" }, { isMaxMode: true })],
  },
  { name: "grok-4.6", clientDisplayName: "Grok 4.6", contextTokenLimit: 256000, contextTokenLimitForMaxMode: 256000, supportsNonMaxMode: true, parameterDefinitions: [{ id: "effort", parameterType: en("low", "high") }], variants: [v({ effort: "high" }, { isDefaultNonMaxConfig: true, legacySlug: "cursor-grok-4.6-high" }), v({ effort: "low" }, { legacySlug: "cursor-grok-4.6-low" })] },
  { name: "composer-2.5", clientDisplayName: "Composer 2.5", contextTokenLimit: 200000, supportsNonMaxMode: true, parameterDefinitions: [{ id: "fast", parameterType: bool }], variants: [v({ fast: "true" }, { isDefaultNonMaxConfig: true, legacySlug: "composer-2.5-fast" }), v({ fast: "false" }, { legacySlug: "composer-2.5" })] },
  { name: "default", clientDisplayName: "Auto", supportsNonMaxMode: true, variants: [v({}, { isDefaultNonMaxConfig: true, legacySlug: "default" })] },
  { name: "max-only", clientDisplayName: "Max Only", contextTokenLimit: 200000, contextTokenLimitForMaxMode: 400000, supportsNonMaxMode: false },
  { name: "secret", clientDisplayName: "Secret", isHidden: true },
  { name: "tab-only", clientDisplayName: "Tab", onlySupportsCmdK: true },
]

export function fakeAPI(picker = PICKER) {
  globalThis.fetch = async (url) => {
    const u = String(url)
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
