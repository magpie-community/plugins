import assert from "node:assert/strict"
import test from "node:test"
import { walletCard } from "./lib/page.mjs"
import { profileOf, fingerprint } from "./lib/session.mjs"

test("余额卡片不伪造签到成功", () => {
  const card = walletCard({ balance: 100, checkedIn: false, enabled: true })
  assert.equal(card.balance, 100)
  assert.equal(card.windows[0].display, "今天可签到")
})

test("每个账号的浏览器配置独立", () => {
  const a = { apiKey: "first" }
  const b = { apiKey: "second" }
  assert.notEqual(fingerprint(a), fingerprint(b))
  assert.notEqual(profileOf(a), profileOf(b))
  assert.equal(profileOf(a), profileOf(a))
})
