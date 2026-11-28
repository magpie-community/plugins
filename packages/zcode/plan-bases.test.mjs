import assert from "node:assert/strict"
import { test } from "node:test"
import { planBases } from "./index.mjs"

// ZCode 3.16 names ten plans across two sites, and four of them are served on
// the two lanes it added (#400): an idle plan off-peak, a card at full speed.
// The two lanes share one base between the two sites, so the plan's own id is
// what names its site - reading it off the base called a BigModel plan Z.ai's.
test("planBases carries the two lanes 3.16 added, with their own site", () => {
  const row = (id) => planBases().find((r) => r.ids.includes(id))

  const off = row("account:zai-offpeak-idle-plan")
  assert.match(off.base, /\/api\/v1\/off-peak\/anthropic$/)
  assert.equal(off.site, "zai")

  const offBM = row("account:bigmodel-offpeak-idle-plan")
  assert.equal(offBM.base, off.base, "the two idle plans share one base")
  assert.equal(offBM.site, "bigmodel", "and their ids are what tell them apart")

  assert.equal(row("account:zai-highspeed-card").site, "zai")
  assert.equal(row("account:bigmodel-highspeed-card").site, "bigmodel")

  // the six the plugin already reached keep their own site's lane
  assert.equal(row("builtin:zai-coding-plan").base, "https://api.z.ai/api/anthropic")
  assert.equal(row("builtin:zai-coding-plan").site, "zai")
  assert.equal(row("builtin:bigmodel-coding-plan").base, "https://open.bigmodel.cn/api/anthropic")
  assert.equal(row("builtin:bigmodel-coding-plan").site, "bigmodel")
})

test("planBases names each provider once, so a key is never read twice", () => {
  const ids = planBases().flatMap((r) => r.ids)
  assert.equal(new Set(ids).size, ids.length, `重复: ${ids}`)
})

test("an id the config does not carry is on no lane", () => {
  const known = new Set(planBases().flatMap((r) => r.ids))
  assert.equal(known.has("account:zai-something-else"), false)
})
