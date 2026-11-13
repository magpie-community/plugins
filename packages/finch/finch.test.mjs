import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { agent, connect } from "./finch.agent.js"

const gateway = { v1: "http://127.0.0.1:3425/v1", key: "synthetic-magpie-finch" }
const haiku = { id: "claude/claude-haiku-5-5", name: "Claude Haiku 5.5 · Claude Code", owned_by: "claude", context: 200000, images: true, efforts: ["low", "high"] }
const output = (models = [haiku], model) => connect({ gateway, models, model })
const names = models => output(models).models.map(m => m.name)

// These are the same four models used for the README's before/after JSON.
const example = [
  haiku,
  { ...haiku, id: "claude/claude-opus-5-5", name: "Claude Opus 5.5 · Claude Code" },
  { ...haiku, id: "relay/claude-opus-5-5", name: "Claude Opus 5.5 · Relay", owned_by: "relay" },
  { ...haiku, id: "codex/gpt-5-4", name: undefined, owned_by: "codex" },
]

test("declares the supported Finch file, model selection, usage prefix and live-sync notice", () => {
  expect(agent).toMatchObject({ id: "finch", name: "Finch", dir: "~/.finch", config: "~/.finch/config/integrations/magpie.json", format: "json", model: "defaultModel", ua: ["finch"] })
  expect(agent.notice).toContain("文件变化自动同步，无需重启")
  expect(agent.library).toBeUndefined()
})

test("ships Finch's own icon in the package and embeds it for the Agents row and plugin listing", async () => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8")
  const icon = await Bun.file(new URL("./icon.svg", import.meta.url)).text()
  const dataUri = "data:image/svg+xml;base64," + Buffer.from(icon).toString("base64")
  expect(agent.icon).toBe(dataUri)
  expect(pkg.magpie.icon).toBe(dataUri)
  expect(pkg.files).toContain("icon.svg")
  expect(readme).toContain("./icon.svg")
})

test("ships a single import-free agent with no runtime dependencies or install hooks", () => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  const source = readFileSync(new URL(pkg.magpie.agent, import.meta.url), "utf8")
  expect(pkg.name).toBe("@magpie-community/agent-finch")
  expect(pkg.magpie.agent).toBe("./finch.agent.js")
  expect(pkg.main).toBeUndefined()
  expect(pkg.dependencies).toBeUndefined()
  expect(pkg.files).toEqual(["finch.agent.js", "icon.svg", "README.md"])
  expect(pkg.scripts.preinstall).toBeUndefined()
  expect(pkg.scripts.postinstall).toBeUndefined()
  expect(source).not.toMatch(/\bimport\s*(?:["'{*]|\()/)
})

test("produces the schema v1 document and maps all model capabilities", () => {
  expect(output([haiku], haiku)).toEqual({
    schemaVersion: 1, id: "magpie", name: "Magpie", protocol: "openai-completions",
    baseUrl: gateway.v1, apiKey: gateway.key, defaultModel: haiku.id,
    models: [{ requestModel: haiku.id, name: "Claude Haiku 5.5", enabled: true, supportsVision: true, supportsThinking: true, contextLength: 200000 }],
  })
})

test("strips the provider suffix, including common middle-dot and whitespace variants", () => {
  for (const separator of [" · ", " • ", " ‧ ", " ∙ ", " ⋅ ", " ・ ", " ･ ", "·", "\u00a0·\u00a0", "\t·  "]) {
    expect(names([{ ...haiku, name: `  Claude Haiku 5.5${separator}Claude Code  ` }])).toEqual(["Claude Haiku 5.5"])
  }
})

test("does not strip decimals, hyphens or anything before the last provider suffix", () => {
  for (const name of ["Claude Haiku 5.5", "GPT-5.4", "My.Model", "Model · Variant · Provider"]) {
    expect(names([{ ...haiku, name }])).toEqual([name === "Model · Variant · Provider" ? "Model · Variant" : name])
  }
})

test("qualifies EVERY duplicate after stripping, and leaves unique names clean", () => {
  expect(names(example)).toEqual(["Claude Haiku 5.5", "Claude Opus 5.5 (Claude Code)", "Claude Opus 5.5 (Relay)", "GPT 5.4"])
  expect(names([...example].reverse())).toEqual([...names(example)].reverse())
})

test("falls back to owned_by or the request ID provider when duplicate names have no suffix", () => {
  expect(names([
    { ...haiku, name: "Same" },
    { ...haiku, id: "relay/same", name: "Same", owned_by: undefined },
  ])).toEqual(["Same (claude)", "Same (relay)"])
})

test("same-provider duplicates use the complete request IDs as a final discriminator", () => {
  const models = [haiku, { ...haiku, id: "claude/haiku-alias" }]
  expect(names(models)).toEqual([
    "Claude Haiku 5.5 (Claude Code) [claude/claude-haiku-5-5]",
    "Claude Haiku 5.5 (Claude Code) [claude/haiku-alias]",
  ])
})

test("handles literal names that collide with generated provider and ID labels", () => {
  const models = [
    { ...haiku, id: "a/x", name: "Same · P" },
    { ...haiku, id: "b/x", name: "Same · Q" },
    { ...haiku, id: "c/x", name: "Same (P)" },
    { ...haiku, id: "d/x", name: "Same (P) [a/x]" },
    { ...haiku, id: "e/x", name: "Same (P) [a/x] (2)" },
  ]
  const result = names(models)
  expect(result).toEqual(["Same (P) [a/x] (3)", "Same (Q)", "Same (P) [c/x]", "Same (P) [a/x]", "Same (P) [a/x] (2)"])
  expect(new Set(result).size).toBe(models.length)
  expect(names([...models].reverse())).toEqual([...result].reverse())
})

test("derives readable model names for missing, empty and whitespace-only names", () => {
  for (const name of [undefined, "", "   "]) {
    expect(names([{ ...haiku, name }])).toEqual(["Claude Haiku 5.5"])
  }
  expect(names([{ ...haiku, id: "codex/gpt-5-4", name: undefined }])).toEqual(["GPT 5.4"])
  expect(names([{ ...haiku, name: " · Provider" }])).toEqual(["Claude Haiku 5.5"])
})

test("requestModel stays the exact gateway ID across stripping, fallback and disambiguation", () => {
  const models = [...example, { ...haiku, id: "relay/vendor/model:variant", name: "" }]
  const result = JSON.parse(JSON.stringify(output(models, example[2])))
  expect(result.models.map(m => m.requestModel)).toEqual(models.map(m => m.id))
  expect(result.defaultModel).toBe("relay/claude-opus-5-5")
})

test("does not set a default unless a model was selected by the host", () => {
  expect(output().defaultModel).toBeUndefined()
})

test("handles missing capabilities as text-only and non-thinking", () => {
  expect(output([{ id: "relay/plain", context: 8192 }]).models[0]).toEqual({
    requestModel: "relay/plain", name: "Plain", enabled: true,
    supportsVision: false, supportsThinking: false, contextLength: 8192,
  })
})

test("omits unknown or invalid context windows before naming the emitted catalog", () => {
  const invalid = [undefined, 0, -1, 1.5, NaN, Infinity, "200000", Number.MAX_SAFE_INTEGER + 1]
    .map((context, index) => ({ ...haiku, id: `unknown/${index}`, context }))
  expect(output([haiku, ...invalid]).models).toEqual(output().models)
  expect(output([{ ...haiku, context: 1 }]).models[0].contextLength).toBe(1)
})

test("refuses an empty eligible catalog and selected models outside it before writing", () => {
  expect(() => output([])).toThrow("known positive context window")
  expect(() => output([{ ...haiku, context: 0 }])).toThrow("known positive context window")
  expect(() => output([haiku], { ...haiku, id: "unknown/model", context: 0 })).toThrow("no eligible catalog entry")
})

test("rejects invalid or duplicate request IDs instead of emitting an invalid Finch document", () => {
  expect(() => output([haiku, haiku])).toThrow("unique gateway model IDs")
  for (const id of ["", " bad/id "]) expect(() => output([{ ...haiku, id }])).toThrow("unique gateway model IDs")
})

test("follows gateway and catalog changes without caching a key, URL or previous name", () => {
  const result = connect({ gateway: { v1: "http://127.0.0.1:3500/v1", key: "synthetic-next-key" }, models: [{ ...haiku, name: "Updated · Provider" }] })
  expect(result.baseUrl).toBe("http://127.0.0.1:3500/v1")
  expect(result.apiKey).toBe("synthetic-next-key")
  expect(result.models[0].name).toBe("Updated")
  expect(names([example[1]])).toEqual(["Claude Opus 5.5"])
})

test("does not mutate even deeply frozen host inputs", () => {
  const models = Object.freeze(example.map(m => Object.freeze({ ...m, efforts: Object.freeze([...m.efforts]) })))
  const input = Object.freeze({ gateway: Object.freeze({ ...gateway }), models, model: models[0] })
  const before = JSON.stringify(input)
  connect(input)
  expect(JSON.stringify(input)).toBe(before)
})
