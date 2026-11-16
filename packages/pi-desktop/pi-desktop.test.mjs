import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { agent, connect } from "./pi-desktop.agent.js"

const gateway = { url: "http://127.0.0.1:3499", v1: "http://127.0.0.1:3499/v1", key: `magpie-${agent.id}` }
const model = { id: "relay/vendor/model:variant", name: "Example", context: 262144, output: 32768, images: true, efforts: ["none", "low", "high", "max", "ultra"] }
const output = (models = [model], gw = gateway) => connect({ gateway: gw, models, agent: { id: agent.id, config: "/synthetic/.config/magpie-pi-desktop/plugin/manifest.json" } })
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))

// Magpie 0.1.2404's own agents, as `magpie <unknown agent>` lists them, plus "pi-desktop",
// which it refuses too ("agent id "pi-desktop" is magpie's own agent's").
const magpieOwnIds = [
  "agy", "aionui", "air", "alma", "ante", "aside", "astrbot", "atomcode", "cindy", "claude", "claude-desktop",
  "claude-science", "cline", "codebuddy", "codex", "commandcode", "copilot", "copilot-jetbrains", "crush", "cursor",
  "cursor-local", "deveco", "devin", "droid", "dsh", "empryo", "fx", "gemini", "goose", "grok", "grok-app", "hanako",
  "hermes", "jcode", "kimi", "kirocrew", "lody", "mimocode", "minimax-code", "morph", "mothx", "muse", "newmax", "omo",
  "omp", "openchamber", "openclaw", "opencode", "openpencil", "pencil", "penguin", "pi", "pi-desktop", "prime-agent",
  "qoder", "qoder-cn", "qwen", "raycast", "reasonix", "snow", "stepcode", "t3code", "vscode", "vscode-insiders",
  "vscodium", "workbuddy", "workbuddy-ai", "zcode", "zed", "zoo-code",
]

test("registers Pi-Desktop as a connect-only agent detected by its data folder", () => {
  expect(agent).toMatchObject({ id: "pi-desktop-app", name: "Pi-Desktop", dir: "~/.pi-desktop", config: "~/.config/magpie-pi-desktop/plugin/manifest.json", format: "json" })
  expect(agent.model).toBeUndefined()
  expect(agent.bin).toBeUndefined()
  expect(agent.library).toBeUndefined()
  expect(agent.notice).toContain(`magpie-${agent.id}`)
  expect(agent.icon.startsWith("data:image/svg+xml;base64,")).toBe(true)
})

test("uses an id Magpie accepts for a plugin agent", () => {
  expect(agent.id).toMatch(/^[a-z0-9._-]+$/)
  expect(magpieOwnIds).not.toContain(agent.id)
})

test("declares the standard community Agent entry and no host plugin", () => {
  expect(pkg.name).toBe("@magpie-community/agent-pi-desktop")
  expect(pkg.type).toBe("module")
  expect(pkg.magpie.agent).toBe("./pi-desktop.agent.js")
  expect(pkg.magpie.icon).toBe(agent.icon)
  expect(pkg.main).toBeUndefined()
  expect(pkg.dependencies).toBeUndefined()
  expect(pkg.scripts.preinstall).toBeUndefined()
  expect(pkg.scripts.postinstall).toBeUndefined()
  for (const file of pkg.files) expect(() => readFileSync(new URL(`./${file}`, import.meta.url))).not.toThrow()
})

test("stays import-free for Magpie's descriptor runtime", () => {
  const source = readFileSync(new URL("./pi-desktop.agent.js", import.meta.url), "utf8")
  expect(source).not.toMatch(/^\s*import\s/m)
  expect(source).not.toMatch(/\brequire\(/)
})

test("writes a whole Pi-Desktop manifest, with the gateway and key beside it", () => {
  const out = output()
  expect(Object.keys(out)).toEqual(["schemaVersion", "id", "name", "version", "description", "author", "homepage", "main", "contributes", "permissions", "engines", "magpie"])
  // No key is a dotted path: Magpie sets each as one top-level key of the file.
  for (const key of Object.keys(out)) expect(key).not.toContain(".")
  expect(out.magpie).toEqual({ baseUrl: gateway.v1, apiKey: "magpie-pi-desktop-app", apiStyle: "chat_completions" })
  expect(out.version).toBe(pkg.version)
  expect(agent.config.endsWith("/manifest.json")).toBe(true)
})

test("declares the catalog as Pi-Desktop models, keeping gateway ids", () => {
  expect(output().contributes.providers[0].models).toEqual([{
    id: "relay/vendor/model:variant", name: "Example", contextWindow: 262144, maxTokens: 32768, supportsImages: true,
    thinkingLevels: ["off", "low", "high", "max"], defaultThinkingLevel: "high",
  }])
})

test("drops limits it does not know and caps output at the context window", () => {
  const [bare, capped] = output([
    { id: "a/b", context: 0, output: -1, efforts: [] },
    { id: "c/d", name: "D", context: 8192, output: 65536 },
  ]).contributes.providers[0].models
  // No levels known: Pi-Desktop keeps its generic settings for the model.
  expect(bare).toEqual({ id: "a/b", name: "a/b" })
  expect(capped).toEqual({ id: "c/d", name: "D", contextWindow: 8192, maxTokens: 8192 })
})

test("gives a model that always reasons no off level, and leaves ultra out", () => {
  const [entry, top] = output([{ ...model, efforts: ["low", "medium", "high"] }, { ...model, id: "x/top", efforts: ["xhigh", "max", "ultra"] }]).contributes.providers[0].models
  expect(entry.thinkingLevels).toEqual(["low", "medium", "high"])
  expect(top.thinkingLevels).toEqual(["xhigh", "max"])
  expect(top.defaultThinkingLevel).toBe("xhigh")
})

test("keeps one provider without models for an empty or missing catalog", () => {
  for (const out of [output([]), connect({ gateway })]) {
    expect(out.contributes.providers).toHaveLength(1)
    expect(out.contributes.providers[0]).toMatchObject({ id: "magpie", baseUrl: gateway.v1, models: [] })
  }
})

test("skips entries without an id and repeated ids", () => {
  const models = output([model, null, { name: "no id" }, { ...model, name: "again" }]).contributes.providers[0].models
  expect(models.map((m) => m.name)).toEqual(["Example"])
})

test("reads the gateway on every call and leaves its inputs alone", () => {
  const models = [structuredClone(model)]
  const before = structuredClone(models)
  output(models)
  expect(models).toEqual(before)
  const other = { url: "http://127.0.0.1:4000", v1: "http://127.0.0.1:4000/v1", key: "magpie-other" }
  const out = output([model], other)
  expect(out.magpie).toMatchObject({ baseUrl: other.v1, apiKey: other.key })
  expect(out.contributes.providers[0].baseUrl).toBe(other.v1)
  expect(JSON.stringify(output())).toBe(JSON.stringify(output()))
})
