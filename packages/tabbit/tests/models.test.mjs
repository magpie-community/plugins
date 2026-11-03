// The catalog → magpie model rows.

import test from "node:test"
import assert from "node:assert/strict"
import { BOOTSTRAP, rowsOf, rowOf, modelIdOf, isFree, isPremium, namesOf } from "../src/models.mjs"

const catalog = [
  { display_name: "Default", supports_tools: true, support_thinking: true, model_access_type: "free_unlimited", display_multiplier: 0 },
  { display_name: "DeepSeek-V4.1-Flash", supports_images: true, supports_tools: true, support_thinking: true, model_access_type: "free_metered", display_multiplier: 0.2 },
  { display_name: "Kimi-K3.1-Pro", supports_images: true, supports_tools: true, support_thinking: true, model_access_type: "premium_only", display_multiplier: 1 },
  { display_name: "Hidden-Thing", hidden: true, model_access_type: "free_metered" },
]

test("the model id is the catalog's display name, verbatim", () => {
  assert.equal(modelIdOf(catalog[1]), "DeepSeek-V4.1-Flash")
  assert.deepEqual(namesOf(catalog), ["Default", "DeepSeek-V4.1-Flash", "Kimi-K3.1-Pro", "Hidden-Thing"])
})

test("free / premium come from model_access_type", () => {
  assert.equal(isFree(catalog[0]), true)
  assert.equal(isFree(catalog[1]), true)
  assert.equal(isFree(catalog[2]), false)
  assert.equal(isPremium(catalog[2]), true)
})

test("rowsOf drops hidden models, and premium ones when asked", () => {
  assert.deepEqual(Object.keys(rowsOf(catalog)), ["Default", "DeepSeek-V4.1-Flash", "Kimi-K3.1-Pro"])
  assert.deepEqual(Object.keys(rowsOf(catalog, { freeOnly: true })), ["Default", "DeepSeek-V4.1-Flash"])
})

test("a row says what an agent may do: reason yes, client tools no", () => {
  const row = rowOf(catalog[1])
  assert.equal(row.id, "DeepSeek-V4.1-Flash")
  assert.equal(row.providerID, "tabbit")
  assert.equal(row.api.npm, "@ai-sdk/openai-compatible")
  assert.equal(row.capabilities.reasoning, true)
  // Tabbit's tools are server-side; a client-declared tool cannot be honoured.
  assert.equal(row.capabilities.toolcall, false)
  assert.equal(row.capabilities.input.image, true)
  assert.equal(catalog[2].supports_images, true)
})

test("a text-only model does not claim image input", () => {
  const row = rowOf(catalog[0])
  assert.equal(row.capabilities.input.image, false)
})

test("known limits win over the default, and the default is used otherwise", () => {
  const deep = rowOf(catalog[1])
  assert.equal(deep.limit.context, 1048576)
  const other = rowOf({ display_name: "Whatever" }, { context: 12345, output: 678 })
  assert.deepEqual(other.limit, { context: 12345, output: 678 })
})

test("the bootstrap catalog is non-empty and every row is well formed", () => {
  assert.ok(BOOTSTRAP.length >= 3)
  const rows = rowsOf(BOOTSTRAP)
  assert.ok(Object.keys(rows).length >= 3)
  for (const row of Object.values(rows)) {
    assert.equal(row.providerID, "tabbit")
    assert.ok(row.id && row.name)
    assert.ok(row.limit.context > 0)
  }
})
