import test from "node:test"
import assert from "node:assert/strict"

import { FloatboatPlugin } from "./index.mjs"

test("declares the floatboat provider, its models and its sign-in", async () => {
  const hooks = await FloatboatPlugin({})

  const cfg = {}
  await hooks.config(cfg)
  const provider = cfg.provider.floatboat
  assert.equal(provider.name, "Floatboat")
  const ids = Object.keys(provider.models)
  assert.equal(ids.length, 13, `13 model ids, got ${ids.length}`)
  assert.ok(ids.includes("lite"))
  assert.ok(ids.includes("claude-sonnet-5.5"))

  assert.equal(hooks.auth.provider, "floatboat")
  assert.ok(hooks.auth.methods.some((m) => m.type === "oauth"), "a browser sign-in")
  assert.ok(hooks.auth.methods.some((m) => m.type === "api"), "a pasted token or key")
  assert.equal(typeof hooks.auth.loader, "function")
  assert.equal(typeof hooks.auth.usage, "function")
  assert.equal(typeof hooks.auth.checkin, "function")
  assert.equal(typeof hooks.provider.models, "function")
})

test("every model carries a name, a limit and a rate", async () => {
  const hooks = await FloatboatPlugin({})
  const cfg = {}
  await hooks.config(cfg)
  for (const [id, model] of Object.entries(cfg.provider.floatboat.models)) {
    assert.ok(model.name, `${id} has a name`)
    assert.ok(model.limit?.context > 0, `${id} has a context limit`)
    assert.ok(model.limit?.output > 0, `${id} has an output limit`)
  }
})
