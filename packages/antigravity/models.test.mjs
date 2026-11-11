// The account's models as the built-in lists them: one model per family of
// levels (internal/provider/antigravity_models_test.go), and the variant a
// request at an effort goes out under (codeassist_test.go's
// TestCodeAssistAntigravityLevels).
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { collapse, byEffort, families, sentID, listed, catalogOf } = _internal

const raw = [
  ["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"],
  ["gemini-3-flash", "Gemini 3 Flash"],
  ["gemini-3-flash-agent", "Gemini 3.5 Flash (High)"],
  ["gemini-3.1-pro-high", "Gemini 3.1 Pro (High)"],
  ["gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)"],
  ["gemini-3.5-flash-extra-low", "Gemini 3.5 Flash (Low)"],
  ["gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"],
  ["gemini-3.5-flash-low", "Gemini 3.5 Flash (Medium)"],
  ["gemini-3.7-flash-high", "Gemini 3.7 Flash (High)"],
  ["gemini-3.7-flash-low", "Gemini 3.7 Flash (Low)"],
  ["gemini-3.7-flash-medium", "Gemini 3.7 Flash (Medium)"],
  ["gemini-3.7-flash-tiered", ""],
  ["gemini-pro-agent", "Gemini 3.1 Pro (High)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
].map(([id, name]) => ({ id, name, context: 0, output: 0, images: true }))

test("a family of levels is one model", () => {
  expect(collapse(raw).map((m) => `${m.id}|${m.name}|${m.efforts.join(",")}`)).toEqual([
    "claude-opus-4-6-thinking|Claude Opus 4.6 (Thinking)|",
    "gemini-3-flash|Gemini 3 Flash|",
    "gemini-3-flash-agent|Gemini 3.5 Flash (High)|",
    "gemini-3.1-pro|Gemini 3.1 Pro|low,high",
    "gemini-3.5-flash|Gemini 3.5 Flash|low,medium",
    "gemini-3.5-flash-lite|Gemini 3.5 Flash Lite|",
    "gemini-3.7-flash|Gemini 3.7 Flash|low,medium,high",
    "gemini-3.7-flash-tiered|Gemini 3.7 Flash (Tiered)|low,medium,high",
    "gemini-pro-agent|Gemini 3.1 Pro (High)|",
    "gpt-oss-120b-medium|GPT-OSS 120B (Medium)|",
  ])
  const vs = (id) => byEffort(families(raw).find((f) => f.id === id))
  expect(vs("gemini-3.7-flash")).toMatchObject({ "": "gemini-3.7-flash-high", high: "gemini-3.7-flash-high", low: "gemini-3.7-flash-low", medium: "gemini-3.7-flash-medium" })
  expect(vs("gemini-3.5-flash")).toMatchObject({ "": "gemini-3.5-flash-low", low: "gemini-3.5-flash-extra-low", medium: "gemini-3.5-flash-low" })
  // an id of no level is the default; without high, the highest
  expect(byEffort(families([{ id: "m-low", name: "" }, { id: "m", name: "" }, { id: "m-high", name: "" }])[0])[""]).toBe("m")
  expect(byEffort(families([{ id: "m-low", name: "" }, { id: "m-medium", name: "" }])[0])[""]).toBe("m-medium")
})

test("models Antigravity leaves unnamed (#955)", () => {
  const got = collapse(
    [["gemini-3.6-flash-high", "Gemini 3.6 Flash (High)"], ["gemini-3.6-flash-low", "Gemini 3.6 Flash (Low)"], ["gemini-3.6-flash-tiered", ""], ["gemini-9-flash-tiered", ""], ["mystery-model", ""]].map(
      ([id, name]) => ({ id, name, images: true, context: 0, output: 0 }),
    ),
  ).map((m) => `${m.id}|${m.name}|${m.efforts.join(",")}`)
  expect(got).toEqual([
    "gemini-3.6-flash|Gemini 3.6 Flash|low,high",
    "gemini-3.6-flash-tiered|Gemini 3.6 Flash (Tiered)|low,high",
    "gemini-9-flash-tiered|gemini-9-flash-tiered|",
    "mystery-model|mystery-model|",
  ])
})

test.each([
  ["gemini-3.7-flash", "low", "gemini-3.7-flash-low", "low"],
  ["gemini-3.7-flash", "medium", "gemini-3.7-flash-medium", "medium"],
  ["gemini-3.7-flash", "xhigh", "gemini-3.7-flash-high", "high"],
  ["gemini-3.7-flash", "", "gemini-3.7-flash-high", "high"],
  ["gemini-3.7-flash-high", "", "gemini-3.7-flash-high", "high"],
  ["gemini-3.7-flash-high", "low", "gemini-3.7-flash-low", "low"],
  ["gemini-3.1-pro", "medium", "gemini-3.1-pro-high", "high"],
  ["gemini-3-flash", "medium", "gemini-3-flash", ""],
  ["gemini-pro-agent", "medium", "gemini-pro-agent", ""],
])("%s at %p goes as %s", (model, effort, want, at) => {
  const levels = [
    ["gemini-3-flash", "Gemini 3 Flash"],
    ["gemini-3.1-pro-high", "Gemini 3.1 Pro (High)"],
    ["gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)"],
    ["gemini-3.7-flash-high", "Gemini 3.7 Flash (High)"],
    ["gemini-3.7-flash-low", "Gemini 3.7 Flash (Low)"],
    ["gemini-3.7-flash-medium", "Gemini 3.7 Flash (Medium)"],
    ["gemini-pro-agent", "Gemini 3.1 Pro (High)"],
  ].map(([id, name]) => ({ id, name }))
  expect(sentID(levels, model, effort)).toEqual([want, at])
})

test("the list as fetchAvailableModels gives it", () => {
  const res = {
    models: {
      "gemini-3-flash": { displayName: "Gemini 3 Flash", maxTokens: 1048576, maxOutputTokens: 65536, supportsImages: true, quotaInfo: { remainingFraction: 0.5, resetTime: "2099-01-01T00:00:00Z" } },
      "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", quotaInfo: {} },
      "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)" },
      chat_20706: { displayName: "internal" },
      "tab_x": { displayName: "tab" },
      "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro" },
      "gemini-old": { displayName: "Gemini Old", disabled: true },
      // a name that is another's: the id's
      "gemini-3-flash-agent": { displayName: "Gemini 3 Flash" },
    },
    agentModelSorts: [{ groups: [{ modelIds: ["claude-sonnet-4-6", "gemini-3-flash"] }] }],
  }
  const infos = listed(res)
  expect(infos.map((m) => m.id)).toEqual(["claude-sonnet-4-6", "gemini-3-flash", "gemini-3-flash-agent", "gpt-oss-120b-medium"])
  expect(infos[0].remaining).toBe(0) // the fraction left out once none is left
  expect(infos[1]).toMatchObject({ remaining: 0.5, resets: "2099-01-01T00:00:00Z", context: 1048576, output: 65536 })
  expect(infos[2].name).toBe("")
  expect(infos[3].remaining).toBe(-1)
  const cat = catalogOf(infos)
  expect(cat.find((m) => m.id === "gpt-oss-120b-medium").images).toBe(false)
  expect(cat.find((m) => m.id === "claude-sonnet-4-6").images).toBe(true)
  // nothing listed: the fallback
  expect(catalogOf([]).length).toBeGreaterThan(3)
})
