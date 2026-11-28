import assert from "node:assert/strict"
import { test } from "node:test"
import { CommandCodePlugin, _internal } from "./index.mjs"

// magpie's switches for a provider are read through the magpie it was made
// with (#2038), so the plugin has to be made with one before the switch says
// anything: this is the same path the gateway takes at each request.
test("the Responses switch is off until magpie says otherwise", async () => {
  await CommandCodePlugin({ client: {}, magpie: { option: () => false } })
  assert.equal(_internal.preferResponsesOn(), false)

  await CommandCodePlugin({ client: {}, magpie: { option: (id, key) => key === "preferResponses" && id === "commandcode-plan" } })
  assert.equal(_internal.preferResponsesOn(), true, "the provider's own key, and only it")

  await CommandCodePlugin({ client: {}, magpie: { option: () => { throw new Error("no such switch") } } })
  assert.equal(_internal.preferResponsesOn(), false, "a switch magpie can't answer is off, not a crash")

  await CommandCodePlugin({ client: {} })
  assert.equal(_internal.preferResponsesOn(), false, "a plugin made with no magpie is off")
})
