import assert from "node:assert/strict"
import { test } from "node:test"
import { extraPhrases, sanitizeBody } from "./index.mjs"

// A phrase the user adds is escaped as the built-in ones are (#406): Factory's
// policy check reads the whole conversation, and the \uXXXX form is what the
// model still reads and the check does not.
test("extraPhrases takes only named, non-empty strings", () => {
  assert.deepEqual(extraPhrases({ redact_phrases: ["Secret Project", "", "  "] }), ["Secret Project", "  "])
  assert.deepEqual(extraPhrases({}), [])
  assert.deepEqual(extraPhrases({ redact_phrases: "not-a-list" }), [])
  assert.deepEqual(extraPhrases({ redact_phrases: [1, null, "ok"] }), ["ok"])
  assert.deepEqual(extraPhrases(), [])
})

test("sanitizeBody escapes a phrase the user named, and changes nothing else", () => {
  const body = JSON.stringify({ messages: [{ role: "user", content: "run Secret Project now" }] })
  const withRule = sanitizeBody(body, ["Secret Project"])
  assert.ok(!withRule.includes("Secret Project"), withRule)
  assert.ok(withRule.includes("\\u0053ecret Project"), withRule)
  assert.ok(withRule.includes("run "), "the rest of the sentence was rewritten")

  // no rules: the body is handed back as it came
  assert.equal(sanitizeBody(body, []), body)
})

test("sanitizeBody leaves a body it cannot parse", () => {
  assert.equal(sanitizeBody("not json", ["x"]), "not json")
})
