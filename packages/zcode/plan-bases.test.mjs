import assert from "node:assert/strict"
import { test } from "node:test"
import { planBases } from "./index.mjs"

// ZCode 3.16 names ten plans across two sites, and four of them are served on
// the two lanes it added (#400): an idle plan off-peak, a card at full speed.
// A plan asked on the wrong lane is refused there, so the lane is read with the
// key rather than assumed from the site.
test("planBases carries the two lanes 3.16 added, and the site ones stay", () => {
  const rows = planBases()
  const baseOf = (id) => rows.find(([ids]) => ids.includes(id))?.[1]

  assert.match(baseOf("account:zai-offpeak-idle-plan"), /\/api\/v1\/off-peak\/anthropic$/)
  assert.match(baseOf("account:bigmodel-offpeak-idle-plan"), /\/api\/v1\/off-peak\/anthropic$/)
  assert.match(baseOf("account:zai-highspeed-card"), /\/api\/v1\/highspeed\/anthropic$/)
  assert.match(baseOf("account:bigmodel-highspeed-card"), /\/api\/v1\/highspeed\/anthropic$/)

  // the six the plugin already reached keep their own site's lane
  assert.equal(baseOf("builtin:zai-coding-plan"), "https://api.z.ai/api/anthropic")
  assert.equal(baseOf("account:zai-individual-coding-plan"), "https://api.z.ai/api/anthropic")
  assert.equal(baseOf("builtin:bigmodel-coding-plan"), "https://open.bigmodel.cn/api/anthropic")
  assert.equal(baseOf("account:bigmodel-individual-coding-plan"), "https://open.bigmodel.cn/api/anthropic")
})

test("planBases names each provider once, so a key is never read twice", () => {
  const ids = planBases().flatMap(([list]) => list)
  assert.equal(new Set(ids).size, ids.length, `重复: ${ids}`)
})

test("an id the config does not carry is on no lane", () => {
  const rows = planBases()
  const known = new Set(rows.flatMap(([list]) => list))
  assert.equal(known.has("account:zai-something-else"), false)
})
