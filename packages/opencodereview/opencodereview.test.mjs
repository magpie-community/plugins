import { expect, test } from "bun:test"
import { agent, connect } from "./opencodereview.agent.js"

const gateway = { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-opencodereview" }
const model = { id: "zai/glm-5.3", name: "GLM-5.3" }

// Apply key-paths the way magpie edits a JSON config: dotted paths address
// nested keys, missing intermediates are created, other keys are preserved.
function apply(config, entries) {
  const out = structuredClone(config)
  for (const [path, value] of Object.entries(entries)) {
    const parts = path.split(".")
    let node = out
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== "object" || node[part] === null) node[part] = {}
      node = node[part]
    }
    node[parts[parts.length - 1]] = value
  }
  return out
}

test("says where ocr keeps its model", () => {
  expect(agent).toMatchObject({
    id: "opencodereview",
    bin: "ocr",
    dir: "~/.opencodereview",
    config: "~/.opencodereview/config.json",
    format: "json",
    model: "model",
  })
  // ocr sends magpie's model id as is
  expect(agent.prefix).toBeUndefined()
})

test("shows ocr's own icon, as the package gives it", async () => {
  const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json()
  expect(agent.icon).toBe("https://raw.githubusercontent.com/alibaba/open-code-review/main/imgs/logo.svg")
  expect(pkg.magpie.icon).toBe(agent.icon)
})

test("matches ocr's User-Agent, which magpie reads as lowercase prefixes", () => {
  const real = "open-code-review/v1.13.2 | claude"
  expect(agent.ua.length).toBeGreaterThan(0)
  for (const entry of agent.ua) {
    expect(entry).toBe(entry.toLowerCase())
    expect(real.startsWith(entry)).toBe(true)
  }
  expect(agent.ua).toContain("open-code-review")
})

test("tells the user when a new model takes effect, in English and Chinese", () => {
  expect(agent.notice).toContain("the next ocr review / ocr scan uses the new model")
  expect(agent.notice).toContain("下一次 ocr review / ocr scan 即使用新模型")
})

test("points ocr at magpie's anthropic endpoint with its own key", () => {
  const out = connect({ gateway, model })
  expect(out).toEqual({
    provider: "magpie",
    "custom_providers.magpie": {
      url: "http://127.0.0.1:3425",
      protocol: "anthropic",
      api_key: "magpie-opencodereview",
    },
  })
  // no /v1 suffix: ocr's anthropic protocol appends /v1/messages itself
  expect(out["custom_providers.magpie"].url).not.toContain("/v1")
  // one unit, as pig writes its provider: no empty magpie provider is left
  // behind when disconnect takes the key out
  expect(Object.keys(out)).toEqual(["provider", "custom_providers.magpie"])
})

test("yields a config ocr accepts, leaving other providers alone", () => {
  const existing = {
    provider: "local",
    model: "zai/glm-5.3",
    custom_providers: {
      local: { url: "http://127.0.0.1:3425", protocol: "anthropic", api_key: "x" },
    },
    llm: {},
  }
  // magpie writes the model key itself, connect's keys alongside it
  const out = apply(apply(existing, { model: model.id }), connect({ gateway, model }))
  expect(out).toEqual({
    provider: "magpie",
    model: "zai/glm-5.3",
    custom_providers: {
      local: { url: "http://127.0.0.1:3425", protocol: "anthropic", api_key: "x" },
      magpie: { url: gateway.url, protocol: "anthropic", api_key: gateway.key },
    },
    llm: {},
  })
})

test("creates custom_providers on a fresh config", () => {
  const out = apply({}, connect({ gateway, model }))
  expect(out.custom_providers.magpie.url).toBe(gateway.url)
})

test("does not depend on receiving a model", () => {
  expect(connect({ gateway }).provider).toBe("magpie")
})
