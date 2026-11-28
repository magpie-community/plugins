import assert from "node:assert/strict"
import { test } from "node:test"
import { stderrTail } from "./credentials.mjs"

// The sentence a caller is given keeps what gcloud said (#403): on Windows
// that reason is the only thing that says which of the account, the project
// or the install is wrong.
test("stderrTail keeps gcloud's own words, trimmed", () => {
  assert.equal(stderrTail("  ERROR: (gcloud.auth.login) invalid_grant  \n"), "ERROR: (gcloud.auth.login) invalid_grant")
  assert.equal(stderrTail(""), "")
  assert.equal(stderrTail(undefined), "")
  assert.equal(stderrTail(null), "")
})

test("stderrTail keeps the end, where the reason is", () => {
  const long = "preamble\n".repeat(200) + "ERROR: the real reason"
  const got = stderrTail(long, 40)
  assert.ok(got.startsWith("…"), got.slice(0, 8))
  assert.equal(got.length, 41)
  assert.ok(got.endsWith("ERROR: the real reason"), got)
})
