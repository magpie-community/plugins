import { test } from "bun:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { agent, connect, _internal } from "../trae.agent.js"

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..")

test("the agent descriptor names Trae and its three resource places", () => {
  assert.equal(agent.id, "trae")
  assert.equal(agent.name, "Trae")
  assert.equal(agent.config, "~/.trae/magpie/connection.json")
  assert.equal(agent.format, "json")
  // The agent picks its whole model list itself; no single-model selector.
  assert.equal(agent.model, undefined)
  assert.equal(agent.dir, "~/.trae")
  assert.equal(agent.library.mcp, "~/.trae/magpie/mcp.json")
  assert.equal(agent.library.mcpFormat, "claude")
  assert.equal(agent.library.skills, "~/.trae/skills")
  // Trae has no global instructions file; the plugin must not claim one.
  assert.equal(agent.library.instructions, undefined)
  // The row stays clean: no notice line under the agent.
  assert.ok(!agent.notice)
  assert.ok(agent.icon.startsWith("data:image/png;base64,"))
})

test("connect gives the model API the full endpoint, key and model", () => {
  const out = connect({
    gateway: { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "gw-key" },
    model: {
      id: "group/example",
      name: "Example model",
      context: 200000,
      output: 32000,
      images: true,
    },
  })
  assert.deepEqual(out, {
    provider: "custom_openai_compatible",
    endpoint: "http://127.0.0.1:3425/v1/chat/completions",
    apiKey: "gw-key",
    apiFormat: "chat_completions",
    modelId: "group/example",
    modelName: "Example model",
    contextWindow: 200000,
    maxOutputTokens: 32000,
    supportsImages: true,
  })
})

test("connect leaves unknown limits out instead of writing zero", () => {
  const out = connect({
    gateway: { v1: "http://127.0.0.1:3425/v1", key: "k" },
    model: { id: "p/m", name: "M", context: 0, output: 0 },
  })
  assert.equal(out.contextWindow, undefined)
  assert.equal(out.maxOutputTokens, undefined)
  assert.equal(out.supportsImages, undefined)
})

test("connect works without a selected model (the row has no model field)", () => {
  const out = connect({
    gateway: { v1: "http://127.0.0.1:3425/v1", key: "gw-key" },
  })
  assert.equal(out.provider, "custom_openai_compatible")
  assert.equal(out.endpoint, "http://127.0.0.1:3425/v1/chat/completions")
  assert.equal(out.apiKey, "gw-key")
  assert.equal(out.apiFormat, "chat_completions")
  assert.equal(out.modelId, undefined)
  assert.equal(out.modelName, undefined)
})

test("endpointFor tolerates trailing slashes", () => {
  assert.equal(
    _internal.endpointFor({ v1: "http://127.0.0.1:3425/v1///" }),
    "http://127.0.0.1:3425/v1/chat/completions",
  )
})

test("connect refuses a row without a gateway", () => {
  assert.throws(() => connect({}), /Choose a model with a configured Magpie gateway first/)
  assert.throws(() => connect({ gateway: { v1: "http://x/v1" } }), /Choose a model/)
})

test("the agent module runs in moejs: it has no imports and no Node APIs", () => {
  const source = readFileSync(`${HERE}/trae.agent.js`, "utf8")
  assert.doesNotMatch(source, /^\s*import\s/m)
  assert.doesNotMatch(source, /\brequire\(/)
  assert.doesNotMatch(source, /\bprocess\./)
  assert.doesNotMatch(source, /from\s+["']node:/)
})
