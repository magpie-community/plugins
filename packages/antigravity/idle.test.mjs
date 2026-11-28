import assert from "node:assert/strict"
import { test } from "node:test"
import { idleDeadline } from "./idle.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The deadline ends a stream that goes silent, and only then (#1318): a
// steady stream keeps it armed but never fires it.
test("idleDeadline aborts only after ms of silence", async () => {
  const d = idleDeadline(40)
  try {
    for (let i = 0; i < 4; i++) {
      await sleep(20)
      assert.equal(d.aborted, false, "it aborted a stream that was still arriving")
      d.touch()
    }
    await sleep(80)
    assert.equal(d.aborted, true, "a silent stream was left running")
  } finally {
    d.dispose()
  }
})

test("idleDeadline says why it ended, and dispose does not abort", async () => {
  let said = ""
  const d = idleDeadline(30, { onIdle: (ms) => (said = String(ms)) })
  await sleep(60)
  assert.equal(d.aborted, true)
  assert.equal(said, "30")

  const e = idleDeadline(30)
  e.dispose()
  await sleep(60)
  assert.equal(e.aborted, false, "dispose aborted a call that had finished")
})

test("idleDeadline with no ms never ends a stream", async () => {
  const d = idleDeadline(0)
  await sleep(30)
  assert.equal(d.aborted, false)
  d.dispose()
})
