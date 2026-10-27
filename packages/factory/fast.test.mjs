// magpie-community/plugins#119 (psylch, plugin 0.1.26): Factory sells Opus
// 5.5 Fast and Opus 5 Fast, and droid offers them, but the plugin had no
// -fast model ("Factory: Not found."), and Opus 5.5 asked with speed "fast"
// was served at standard speed with nothing said. The cases are droid
// 0.240.0's own entries and request code, saved byte for byte in testdata.
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { FactoryAuthPlugin } from "./index.mjs"

const DROID = readFileSync(new URL("./testdata/droid-0.240.0-fast.txt", import.meta.url), "utf8")
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

function entry(id) {
  const line = DROID.split("\n").find((l) => l.startsWith(`"${id}":{id:"${id}",`))
  if (!line) throw new Error(`${id} is not in the fixture`)
  return line
}

async function plugin() {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), ...init })
    return new Response("{}", { headers: { "content-type": "application/json" } })
  }
  const auth = { type: "oauth", access: "factory-token", expires: Date.now() + 3_600_000, activeOrganizationId: "org_A" }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  const cfg = { provider: {} }
  await hooks.config(cfg)
  return { models: cfg.provider.factory.models, l: await hooks.auth.loader(async () => auth), seen }
}

const OFFERED = ["claude-opus-5-5-fast", "claude-opus-5-fast", "claude-opus-4-8-fast", "gpt-5.5-fast", "gpt-5.4-fast", "gpt-5.3-codex-fast"]

test("droid's Fast Mode models are offered at their base model's limits and efforts", async () => {
  const { models } = await plugin()
  for (const id of OFFERED) {
    const text = entry(id)
    const base = text.match(/baseVariant:"([^"]+)"/)[1]
    const m = models[id]
    expect(m).toBeDefined()
    expect(m.name).toBe(text.match(/,name:"([^"]+)"/)[1])
    expect(m.limit).toEqual(models[base].limit)
    expect(m.provider).toEqual(models[base].provider)
    const efforts = JSON.parse(text.match(/reasoningEffort:\{supported:(\[[^\]]*\])/)[1]).filter((e) => e !== "off")
    expect(Object.keys(m.variants)).toEqual(efforts)
  }
  // left out, each for its reason (index.mjs, above MODELS)
  for (const id of ["claude-opus-4-6-fast", "claude-opus-4-7-fast", "gpt-5.4-mini-fast", "gpt-5.6-sol-fast", "glm-5.2-fast"]) expect(models[id]).toBeUndefined()
  expect(entry("gpt-5.6-sol-fast")).toContain("unreleased:!0")
  expect(entry("glm-5.2-fast")).toContain("featureFlag:")
})

test("an Opus Fast Mode model goes out as droid sends it: its own id, speed fast and the fast-mode beta", async () => {
  const { l, seen } = await plugin()
  expect(entry("claude-opus-5-5-fast")).toContain("anthropicFastMode:!0")
  expect(DROID).toContain('if(t?.anthropicFastMode){if(_.speed="fast",!f.betaFlags.includes("fast-mode-2026-02-01"))')
  const url = "https://api.factory.ai/api/llm/a/v1/messages"
  await l.fetch(url, { method: "POST", headers: { "anthropic-beta": "client-beta" }, body: JSON.stringify({ model: "claude-opus-5-5-fast", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }) })
  let sent = JSON.parse(seen[0].body)
  expect(sent.model).toBe("claude-opus-5-5-fast")
  expect(sent.speed).toBe("fast")
  expect(seen[0].headers.get("anthropic-beta")).toBe("client-beta,fast-mode-2026-02-01")
  expect(seen[0].headers.get("x-api-provider")).toBe("anthropic")

  // the issue's second case: Opus 5.5 asked for fast reaches Opus 5.5 Fast
  await l.fetch(url, { method: "POST", headers: { "anthropic-beta": "fast-mode-2026-02-01" }, body: JSON.stringify({ model: "claude-opus-5-5", speed: "fast", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }) })
  sent = JSON.parse(seen[1].body)
  expect(sent.model).toBe("claude-opus-5-5-fast")
  expect(sent.speed).toBe("fast")
  expect(seen[1].headers.get("anthropic-beta")).toBe("fast-mode-2026-02-01")

  // not asked for fast: Opus 5.5 as it was
  await l.fetch(url, { method: "POST", body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }) })
  sent = JSON.parse(seen[2].body)
  expect(sent.model).toBe("claude-opus-5-5")
  expect("speed" in sent).toBe(false)
  expect(seen[2].headers.get("anthropic-beta")).toBeNull()
})

test("a GPT Fast Mode model goes out as droid sends it: its own id at the priority tier", async () => {
  const { l, seen } = await plugin()
  expect(entry("gpt-5.5-fast")).toContain("apiRequest:Ee,")
  expect(DROID).toContain('Ee=C({parallelToolCalls:!0,extendedCache:!0,safetyId:!0,verbosity:"low",serviceTier:"priority"})')
  const url = "https://api.factory.ai/api/llm/o/v1/responses"
  await l.fetch(url, { method: "POST", body: JSON.stringify({ model: "gpt-5.5-fast", input: "hi" }) })
  let sent = JSON.parse(seen[0].body)
  expect(sent.model).toBe("gpt-5.5-fast")
  expect(sent.service_tier).toBe("priority")
  expect(seen[0].headers.get("x-api-provider")).toBe("openai")
  expect(seen[0].headers.get("anthropic-beta")).toBeNull()
  // GPT-5.5 at the priority tier is its Fast Mode model
  await l.fetch(url, { method: "POST", body: JSON.stringify({ model: "gpt-5.5", service_tier: "priority", input: "hi" }) })
  sent = JSON.parse(seen[1].body)
  expect(sent.model).toBe("gpt-5.5-fast")
  // a model with no Fast Mode model is left as it was asked
  await l.fetch(url, { method: "POST", body: JSON.stringify({ model: "gpt-6-sol", service_tier: "priority", input: "hi" }) })
  sent = JSON.parse(seen[2].body)
  expect(sent.model).toBe("gpt-6-sol")
  expect(sent.service_tier).toBe("priority")
})

// #119 (psylch, 0.1.27): magpie shows a provider with nothing picked only
// the first 24 models of its list. Placed beside their base models, the Fast
// Mode models pushed GPT-5.3-Codex, Grok and GLM out of those 24; listed
// last, the first 24 are 0.1.26's again.
test("the Fast Mode models come after every other model, so magpie's first 24 are the ones it showed before", async () => {
  const { models } = await plugin()
  const ids = Object.keys(models)
  const first = ids.findIndex((id) => id.endsWith("-fast"))
  expect(ids.slice(first).every((id) => id.endsWith("-fast"))).toBe(true)
  expect(ids.slice(first)).toEqual(OFFERED)
  for (const id of ["gpt-5.3-codex", "grok-4.7", "grok-4.6", "glm-5.3", "glm-5.3-flash"]) expect(ids.slice(0, 24)).toContain(id)
})
