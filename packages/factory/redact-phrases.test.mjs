import assert from "node:assert/strict"
import { test } from "node:test"
import { _internal } from "./index.mjs"

// magpie's own switches are read through the magpie the plugin was made with
// (input.magpie.option), at each request. A phrase list arrives as a string
// when the editor writes one, and as a list when a caller does.
test("extra phrases come from magpie's switch, and nothing named is nothing extra", () => {
  const said = (v) => ({ option: (id, key) => (id === "factory" && key === "redact_phrases" ? v : undefined) })

  assert.deepEqual(_internal.redactPhrases(said("Secret Project, Internal")), ["Secret Project", "Internal"])
  assert.deepEqual(_internal.redactPhrases(said(["Secret Project", "  ", "Internal"])), ["Secret Project", "  ", "Internal"])
  assert.deepEqual(_internal.redactPhrases(said("")), [])
  assert.deepEqual(_internal.redactPhrases(said(undefined)), [])
  assert.deepEqual(_internal.redactPhrases({ option: () => { throw new Error("no such switch") } }), [], "a switch magpie can't answer is none, not a crash")
  assert.deepEqual(_internal.redactPhrases(undefined), [], "a plugin made with no magpie has none")
})
