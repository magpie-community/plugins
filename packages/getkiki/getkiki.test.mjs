import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { agent, connect } from "./getkiki.agent.js"

const gateway = { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-getkiki" }
const model = { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", context: 131072, output: 32768, images: true, efforts: ["none", "low", "high"] }

test("points Magpie at Kiki's pi models.json and the MODEL line in its .env", () => {
  assert.equal(agent.id, "getkiki")
  assert.equal(agent.config, "~/kiki-data/engine/models.json")
  assert.equal(agent.format, "json")
  // the model lives in .env, so agent.model stays out (Magpie refuses both)
  assert.equal(agent.model, undefined)
  assert.deepEqual(agent.startup, { config: "~/kiki-data/.env", format: "env", model: "MODEL" })
  assert.equal(agent.library, undefined)
})

test("the startup model names the provider connect writes, as Kiki splits it", () => {
  const out = connect({ gateway, models: [model] })
  assert.deepEqual(Object.keys(out), ["providers.magpie"])
  // Magpie writes MODEL=<prefix><provider>/<model>; Kiki takes the part before the first / as pi's provider
  const written = agent.prefix + model.id
  const [provider, ...rest] = written.split("/")
  assert.equal(`providers.${provider}`, "providers.magpie")
  assert.ok(out["providers.magpie"].models.some((m) => m.id === rest.join("/")))
})

test("writes one whole provider with the gateway and this agent's key", () => {
  const p = connect({ gateway, models: [model] })["providers.magpie"]
  assert.equal(p.baseUrl, gateway.v1)
  assert.equal(p.apiKey, "magpie-getkiki")
  assert.equal(p.api, "openai-completions")
  assert.deepEqual(p.models, [{
    id: model.id, name: "DeepSeek V4 Pro", input: ["text", "image"], reasoning: true,
    contextWindow: 131072, maxTokens: 32768,
    thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null },
  }])
})

test("leaves unknown limits to pi and handles text-only models", () => {
  for (const limits of [{}, { context: 0, output: 0 }]) {
    assert.deepEqual(connect({ gateway, models: [{ id: "x/plain", ...limits }] })["providers.magpie"].models, [
      { id: "x/plain", name: "x/plain", input: ["text"], reasoning: false },
    ])
  }
  assert.equal(connect({ gateway, models: [{ id: "x/y", context: 1000, output: 4000 }] })["providers.magpie"].models[0].maxTokens, 1000)
  assert.deepEqual(connect({ gateway })["providers.magpie"].models, [])
})

test("package.json declares the agent, its icon and no install scripts", () => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  assert.equal(pkg.magpie.agent, "./getkiki.agent.js")
  assert.equal(pkg.magpie.icon, agent.icon)
  assert.equal(pkg.main, undefined)
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.scripts.postinstall, undefined)
})
