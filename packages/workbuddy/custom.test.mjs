// plugins#1015 (CnsMaple): an enterprise account's own models,
// "custom:<name>|<name>" with modelType "enterprise", are in /v3/config's
// models but in no agent's list. WorkBuddy's CLI appends every "custom:"
// model to the agent's list itself; the plugin read only the agent's list,
// so they were missing. The entries are the issue's shape, word for word.
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const custom = (name) => ({
  id: `custom:${name}|${name}`,
  name,
  modelType: "enterprise",
  maxInputTokens: 256000,
  maxOutputTokens: 64000,
  supportsImages: true,
  supportsReasoning: true,
  supportsToolCall: true,
  reasoning: { supportedEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", canDisableThinking: true },
})

const config = JSON.stringify({
  code: 0,
  data: {
    agents: [
      { name: "cli", models: ["glm-5.3"] },
      { name: "compact", models: ["glm-5.3"] },
    ],
    models: [
      { id: "glm-5.3", name: "GLM-5.3", maxInputTokens: 1000000, maxOutputTokens: 131072, credits: "x0.08" },
      custom("claude-opus-5-5"),
      custom("gpt-5.6-sol"),
      { id: "kimi-k2.5", name: "Kimi-K2.5" }, // in no agent's list, and no custom model: left out as before
    ],
  },
})

async function listed(site) {
  globalThis.fetch = async () => new Response(config)
  return _internal.liveModels(_internal.SITES[site], { access: "a", uid: "u", enterpriseId: "ent-1" })
}

for (const site of ["workbuddy", "workbuddy-ai"]) {
  test(`${site}: an enterprise's custom: models are listed after the agent's, id as given`, async () => {
    const out = await listed(site)
    expect(out.map((m) => m.id)).toEqual(["glm-5.3", "custom:claude-opus-5-5|claude-opus-5-5", "custom:gpt-5.6-sol|gpt-5.6-sol"])
  })

  test(`${site}: a custom: model carries its context, output, images and efforts`, async () => {
    const m = (await listed(site)).find((x) => x.id === "custom:claude-opus-5-5|claude-opus-5-5")
    expect(m.name).toBe("claude-opus-5-5")
    expect(m.context).toBe(256000)
    expect(m.output).toBe(64000)
    expect(m.images).toBe(true)
    expect(m.efforts).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
    expect(m.effort).toBe("medium")
    // no credits in its entry: neither free nor priced
    expect(m.free).toBeUndefined()
    expect(m.rate).toBeUndefined()

    const info = _internal.modelOf(_internal.SITES[site], { id: site }, m)
    expect(info.id).toBe("custom:claude-opus-5-5|claude-opus-5-5")
    expect(info.api.id).toBe("custom:claude-opus-5-5|claude-opus-5-5")
    // on chat, where the reporter's chat to it was served
    expect(info.api.npm).toBe("@ai-sdk/openai-compatible")
    expect(info.limit).toEqual({ context: 256000, output: 64000 })
    expect(Object.keys(info.variants)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
  })
}

test("a custom: model the agent names already is listed once, where the agent put it", async () => {
  const cfg = JSON.parse(config)
  cfg.data.agents[0].models = ["custom:gpt-5.6-sol|gpt-5.6-sol", "glm-5.3"]
  globalThis.fetch = async () => new Response(JSON.stringify(cfg))
  const out = await _internal.liveModels(_internal.SITES.workbuddy, { access: "a", uid: "u" })
  expect(out.map((m) => m.id)).toEqual(["custom:gpt-5.6-sol|gpt-5.6-sol", "glm-5.3", "custom:claude-opus-5-5|claude-opus-5-5"])
})

test("a config with no cli agent lists nothing, custom: models too", async () => {
  const cfg = JSON.parse(config)
  cfg.data.agents = [{ name: "compact", models: ["glm-5.3"] }]
  globalThis.fetch = async () => new Response(JSON.stringify(cfg))
  expect(await _internal.liveModels(_internal.SITES.workbuddy, { access: "a", uid: "u" })).toEqual([])
})
