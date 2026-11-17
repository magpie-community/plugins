import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LEVELS, MAX_MODELS, agent, connect, declaredModels, defaultLevel, manifest, providers, splitModels } from "./pi-desktop.agent.js"

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
const gateway = { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: `magpie-${agent.id}` }
const catalog = (count, vendor = (i) => `v${i}`) => Array.from({ length: count }, (_, i) => ({ id: `${vendor(i)}/m${i}`, name: `M${i}`, efforts: ["low", "high"] }))
const built = connect({ gateway, models: catalog(97) })

// The rules Pi-Desktop 0.22's validateManifest and its host apply to the fields this manifest uses.
const API_STYLES = ["chat_completions", "opencode_go", "responses", "anthropic_messages", "google_generative_ai", "openai_codex_responses", "pi_messages"]
const localized = (value, max) => typeof value === "string"
  ? !!value.trim() && value.length <= max
  : ["en", "zh-CN"].every((locale) => typeof value?.[locale] === "string" && !!value[locale].trim() && value[locale].length <= max)

test("passes Pi-Desktop's manifest rules", () => {
  expect(built.schemaVersion).toBe(1)
  expect(built.id).toMatch(/^[a-z0-9]+(\.[a-z0-9_-]+)+$/)
  expect(built.name.trim()).not.toBe("")
  expect(built.version).toMatch(/^\d+\.\d+\.\d+$/)
  expect(built.version).toBe(pkg.version)
  for (const p of built.contributes.providers) {
    expect(p.id).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
    expect(p.name.trim()).not.toBe("")
    expect(localized(p.category, 128)).toBe(true)
    expect(localized(p.description, 280)).toBe(true)
    expect(p.description.en).toContain(gateway.key)
    expect(p.description["zh-CN"]).toContain(gateway.key)
    expect(p.baseUrl).toBe(gateway.v1)
    expect(API_STYLES).toContain(p.apiStyle)
    expect(p.authKind).toBe("api_key")
    expect(p.models.length).toBeLessThanOrEqual(MAX_MODELS)
    for (const m of p.models) {
      for (const level of m.thinkingLevels) expect(LEVELS).toContain(level)
      expect(m.thinkingLevels).toContain(m.defaultThinkingLevel)
    }
  }
  expect(agent.notice).toContain("Magpie")
})

test("asks for provider.register only", () => {
  expect(built.permissions).toEqual(["provider.register"])
  expect(built.contributes.agentExtensions).toBeUndefined()
  expect(built.fs).toBeUndefined()
  expect(built.net).toBeUndefined()
  expect(built.ui).toBeUndefined()
})

test("needs no file but the manifest, which loads as a module without hooks", () => {
  expect(built.main).toBe("manifest.json")
  const dir = mkdtempSync(join(tmpdir(), "magpie-pi-manifest-"))
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(built, null, 2))
  // What Pi-Desktop's plugin host does with the entry file.
  const mod = createRequire(import.meta.url)(join(dir, built.main))
  expect(mod.onLoad).toBeUndefined()
  expect(mod.onUnload).toBeUndefined()
  expect(mod.onProviderOAuth).toBeUndefined()
})

test("starts a chat on high, else the nearest level above, else below", () => {
  expect(defaultLevel(["low", "medium", "high", "xhigh", "max"])).toBe("high")
  expect(defaultLevel(["xhigh", "max"])).toBe("xhigh")
  expect(defaultLevel(["off", "low", "medium"])).toBe("medium")
  expect(defaultLevel(["off"])).toBe("off")
  expect(defaultLevel([])).toBeUndefined()
  expect(defaultLevel(["low", "medium", "high"], "medium")).toBe("medium")
  expect(defaultLevel(["low", "high"], "medium")).toBe("high")
})

test("splits past Pi-Desktop's 64 models per provider, keeping a vendor together", () => {
  const split = (models) => splitModels(declaredModels(models)).map((c) => c.length)
  expect(split(catalog(MAX_MODELS))).toEqual([MAX_MODELS])
  // 60 single-model vendors, then a vendor of 10 that would straddle the limit.
  expect(split(catalog(70, (i) => (i < 60 ? `v${i}` : "big")))).toEqual([60, 10])
  // One vendor larger than a provider has to be cut.
  expect(split(catalog(150, () => "one"))).toEqual([64, 64, 22])
  expect(splitModels([])).toEqual([[]])
})

test("names the cards Magpie, Magpie 2, … and keeps the first one's id", () => {
  const cards = built.contributes.providers
  // "magpie" is the id whose key Pi-Desktop already holds.
  expect(cards.map((p) => [p.id, p.name, p.models.length])).toEqual([["magpie", "Magpie", 64], ["magpie-2", "Magpie 2", 33]])
  expect(cards.flatMap((p) => p.models)).toEqual(declaredModels(catalog(97)))
  expect(new Set(cards.flatMap((p) => p.models.map((m) => m.id))).size).toBe(97)
  expect(providers(gateway.v1, []).map((p) => p.id)).toEqual(["magpie"])
  expect(manifest(gateway.v1, []).contributes.providers[0].models).toEqual([])
})

test("ships every file it needs", () => {
  for (const file of ["pi-desktop.agent.js", "scripts/doctor.mjs", "README.md"]) expect(pkg.files).toContain(file)
})
