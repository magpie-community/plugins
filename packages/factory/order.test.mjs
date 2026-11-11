import { expect, test } from "bun:test"
import { FactoryAuthPlugin } from "./index.mjs"

async function setup(magpie) {
  return FactoryAuthPlugin({ client: { auth: { set: async () => {} } }, magpie })
}
async function lists(hooks) {
  const cfg = { provider: {} }
  await hooks.config(cfg)
  return [cfg.provider.factory.models, await hooks.provider.models({ id: "factory" }, {})]
}

test("company ordering is opt-in, preserves metadata, and is read on each model listing", async () => {
  let enabled = false
  const hooks = await setup({ option: (_, key) => key === "group_models_by_company" && enabled })
  expect(hooks.auth.options.find((o) => o.key === "group_models_by_company")).toBeDefined()
  const original = await lists(await setup())
  const originalOrder = original.map((models) => Object.keys(models))
  // Anchor the baseline independently of the switch: always-on grouping must fail.
  expect(originalOrder[0][0]).toBe("claude-fable-5.1")
  expect((await lists(hooks)).map((models) => Object.keys(models))).toEqual(originalOrder)
  enabled = true
  const grouped = await lists(hooks)
  expect(Object.keys(grouped[0])).toEqual(Object.keys(grouped[1]))
  for (const [index, models] of grouped.entries()) {
    expect(models).toEqual(original[index])
    const ids = Object.keys(models)
    const before = (a, b) => expect(ids.indexOf(a)).toBeLessThan(ids.indexOf(b))
    expect(ids[0]).toBe("claude-fable-5.2")
    before("claude-fable-5.2", "claude-fable-5.1")
    before("claude-fable-5", "claude-opus-5-5")
    before("claude-opus-5-5", "claude-opus-5")
    before("claude-haiku-4-5-20251001", "gpt-6.1-sol")
    before("gpt-6.1-sol", "gpt-6-sol")
    before("gpt-6-luna", "gpt-5.6-sol")
    before("gpt-5.3-codex-fast", "gemini-4-carbon")
    before("gemini-4-carbon", "gemini-4-argon")
    before("gemini-3.8-flash", "gemini-3.1-pro-preview")
    before("glm-5.2-fast", "kimi-k3.1-pro")
    for (const id of ids.filter((id) => id.endsWith("-fast"))) {
      expect(ids.indexOf(id)).toBe(ids.indexOf(id.slice(0, -5)) + 1)
    }
  }
  enabled = false
  expect((await lists(hooks)).map((models) => Object.keys(models))).toEqual(originalOrder)
})

test("absent, false, non-boolean and throwing options retain the default order", async () => {
  const original = (await lists(await setup())).map((models) => Object.keys(models))
  expect(original[0][0]).toBe("claude-fable-5.1")
  const hosts = [undefined, {}, { option: 5 }, { option() { throw Error("unsupported") } },
    ...[false, "true", 1, null].map((value) => ({ option: () => value }))]
  for (const host of hosts) {
    expect((await lists(await setup(host))).map((models) => Object.keys(models))).toEqual(original)
  }
})
