import { expect, test } from "bun:test"
import * as mod from "./factory-identity.middleware.js"
import { check } from "../../scripts/middleware.mjs"

check(import.meta.dir, mod)

test("a Factory rewrite leaves the shared request intact for a later provider try", () => {
  const original = "You are omp's trusted coding assistant."
  const request = {
    model: "group/work",
    system: [{ type: "text", text: original, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hello" }],
  }
  const before = structuredClone(request)
  const rewritten = mod.onProvider(request, { protocol: "anthropic", provider: { id: "factory" } })
  expect(rewritten.system[0].text).toBe("You are droid's trusted coding assistant.")
  expect(rewritten.system[0].cache_control).toEqual({ type: "ephemeral" })
  expect(request).toEqual(before)
  const next = mod.onProvider(request, { protocol: "anthropic", provider: { id: "openai" } })
  expect(next ?? request).toEqual(before)
})
