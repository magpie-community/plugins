// plugins#1360: agy 1.5.12 selects models through configOptions and rejects an
// effort-suffixed id on session/set_model ("Unknown model ID"). A session
// opened without that catalog is degraded. It must be closed and the request
// answered 502, so the client tries again. A catalog that is present but
// lacks the model stays 400. An older agy still uses session/set_model.

import { test } from "node:test"
import assert from "node:assert/strict"
import { BASE_MODEL_ROWS, baseBody, createBridgeKit, modelsOutput, sleep } from "./testkit.mjs"

const ROWS = [
  ...BASE_MODEL_ROWS,
  ["gemini-4-neon-high", "Gemini 4 Neon (High)"],
  ["gemini-4-neon-medium", "Gemini 4 Neon (Medium)"],
  ["gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"],
  ["gemini-4-hydrogen-xhigh", "Gemini 4 Hydrogen (XHigh)"],
]

const UNKNOWN = (params) => ({ code: -32603, message: `Unknown model ID: ${params.modelId}` })

const REFUSED_LISTING = {
  code: 1,
  stderr: "Error: Eligibility check failed: PERMISSION_DENIED (code 403): You do not have a valid license of this product. (#3501). Please log out (/logout) and log back in (/login).\n",
}

function catalog(models, { current = models[0], thought = "low", levels = ["low", "medium", "high", "xhigh"] } = {}) {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: current,
      options: models.map(value => ({ value, name: value })) },
    { id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: thought,
      options: levels.map(value => ({ value, name: value })) },
  ]
}

async function withKit(options, fn) {
  const kit = await createBridgeKit({
    modelsBehavior: { stdout: modelsOutput(ROWS) },
    agentVersion: "1.5.12",
    setModelError: UNKNOWN,
    ...options,
  })
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

async function ready(kit) {
  await kit.models()
  const warming = kit.plugin.provider.warming?.()
  if (warming) await warming
  for (let i = 0; i < 50 && kit.children.size; i++) await sleep(10)
}

function turn(model, effort) {
  return baseBody({
    model: `agy-cli/${model}`,
    tools: [],
    stream: false,
    thinking: { type: "adaptive" },
    output_config: { effort },
    messages: [{ role: "user", content: "hi" }],
  })
}

function bridgeSpawns(kit) {
  return kit.acpSpawns.map((spawn, index) => ({ spawn, index })).filter(item => item.spawn.env?.AGY_BRIDGE_TOKEN)
}

async function degraded(kit, model, effort) {
  await ready(kit)
  const listed = await kit.models()
  assert.ok(listed[model], `catalog has no ${model}: ${Object.keys(listed).join(", ")}`)
  const response = await kit.request(turn(model, effort))
  const body = await response.json()
  return { response, body }
}

test("plugins#1360 agy 1.5.12 with no model catalog closes the session and answers a retryable 502", async () => {
  const cases = [
    ["missing configOptions", undefined, "gemini-4-neon", "medium", "gemini-4-neon-medium"],
    ["null configOptions", null, "gemini-4-neon", "medium", "gemini-4-neon-medium"],
    ["empty configOptions", [], "gemini-4-neon", "medium", "gemini-4-neon-medium"],
    ["configOptions without a model select", [
      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "ask", options: [{ value: "ask", name: "Ask" }] },
    ], "gemini-4-hydrogen", "xhigh", "gemini-4-hydrogen-xhigh"],
    ["model select with no values", [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "", options: [] },
    ], "gemini-4-neon", "medium", "gemini-4-neon-medium"],
  ]
  for (const [label, sessionConfig, model, effort, resolved] of cases) {
    await withKit({ sessionConfig }, async (kit) => {
      const { response, body } = await degraded(kit, model, effort)
      assert.equal(response.status, 502, `${label}: ${response.status} ${body.error?.message}`)
      assert.equal(body.error.type, "api_error", label)
      assert.equal(body.error.code, "degraded_session", label)
      assert.match(body.error.message, new RegExp(resolved), label)
      assert.match(body.error.message, /without a model catalog/, label)
      assert.match(body.error.message, /send the request again/, label)
      assert.doesNotMatch(body.error.message, /unavailable to this agy account/, label)
      assert.notEqual(response.headers.get("x-should-retry"), "false", label)
      assert.deepEqual(kit.setModels, [], `${label} fell back to session/set_model: ${kit.setModels}`)
      assert.deepEqual(kit.setConfigs, [], label)
      const bridges = bridgeSpawns(kit)
      assert.equal(bridges.length, 1, label)
      assert.equal(bridges[0].spawn.child.closed, true, `${label}: degraded session still running`)
      assert.equal(kit.module.__agyTestAllProcs.size, 0, label)
      assert.equal(kit.module.__agyTestPool.size, 0, label)
    })
  }
})

test("plugins#1360 a retry after the degraded session opens a new one and selects through configOptions", async () => {
  await withKit({ sessionConfig: [] }, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await agent.text("ok")
      return { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } }
    }
    const first = await degraded(kit, "gemini-4-neon", "medium")
    assert.equal(first.response.status, 502, first.body.error?.message)
    assert.equal(kit.module.__agyTestAllProcs.size, 0)

    kit.sessionConfig = catalog(["gemini-4-neon", "gemini-4-hydrogen"], { current: "gemini-4-hydrogen", thought: "low" })
    kit.setModelError = null
    const response = await kit.request(turn("gemini-4-neon", "medium"))
    assert.equal(response.status, 200, await response.clone().text())
    const message = await response.json()
    assert.match(message.content?.map(block => block.text).join(""), /ok/)
    const bridges = bridgeSpawns(kit)
    assert.equal(bridges.length, 2, "the closed session was reused")
    assert.equal(bridges[0].spawn.child.closed, true)
    assert.equal(bridges[1].spawn.child.closed, false)
    assert.deepEqual(kit.setModels, [], `legacy set_model ran: ${kit.setModels}`)
    assert.ok(kit.setConfigs.some(item => item.spawn === bridges[1].index && item.configId === "model" && item.value === "gemini-4-neon"), JSON.stringify(kit.setConfigs))
    assert.ok(kit.setConfigs.some(item => item.spawn === bridges[1].index && item.configId === "thought_level" && item.value === "medium"), JSON.stringify(kit.setConfigs))
    assert.equal(kit.module.__agyTestPool.size, 1)
  })
})

test("plugins#1360 a healthy catalog that lacks the model is still a 400", async () => {
  await withKit({
    sessionConfig: catalog(["gemini-3.8-flash"], { current: "gemini-3.8-flash" }),
  }, async (kit) => {
    await ready(kit)
    const response = await kit.request(turn("gemini-4-argon", "high"))
    const body = await response.json()
    assert.equal(response.status, 400, body.error?.message)
    assert.equal(body.error.type, "invalid_request_error")
    assert.match(body.error.message, /unavailable to this agy account/)
    assert.match(body.error.message, /Unknown model ID: gemini-4-argon-high/)
    assert.deepEqual(kit.setModels, ["gemini-4-argon-high"])
  })
})

test("plugins#1360 an older agy with no configOptions still selects through session/set_model", async () => {
  for (const agentVersion of ["1.4.12", "1.5.0", "1.5.11"]) {
    await withKit({
      agentVersion,
      sessionConfig: [],
      setModelError: null,
    }, async (kit) => {
      kit.defaultPrompt = async (agent) => {
        await agent.text("legacy")
        return { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 6 } }
      }
      const response = await kit.request(baseBody({
        model: "agy-cli/gemini-4-argon",
        tools: [],
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }))
      assert.equal(response.status, 200, `${agentVersion}: ${await response.clone().text()}`)
      assert.deepEqual(kit.setModels, ["gemini-4-argon-high"], agentVersion)
      assert.deepEqual(kit.setConfigs, [], agentVersion)
      assert.equal(kit.module.__agyTestPool.size, 1, agentVersion)
    })
  }
})

test("plugins#1360 a refused account with an empty catalog is still a 403, not a degraded session", async () => {
  await withKit({ modelsBehavior: REFUSED_LISTING, sessionConfig: [] }, async (kit) => {
    const response = await kit.request(turn("gemini-4-argon", "high"))
    const body = await response.json()
    assert.equal(response.status, 403, body.error?.message)
    assert.equal(body.error.type, "permission_error")
    assert.match(body.error.message, /#3501/)
    assert.doesNotMatch(body.error.message, /unavailable to this agy account/)
    assert.doesNotMatch(body.error.message, /without a model catalog/)
    assert.deepEqual(kit.setModels, [])
  })
})
