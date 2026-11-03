// #675 (orinsid): a WeChat token lives two hours, and OrcaTerm drops the
// OAuth session with it, so a renewal after expiry is SESSION_EXPIRED for
// good. magpie renews a plugin's sign-in only when something uses the
// account (a request, a usage read) and the token is within auth.refreshLead
// of expiring, five minutes when the plugin doesn't say. These tests apply
// magpie's rule (host.js leadOf/renewAt) to the plugin's hook.
import { expect, test } from "bun:test"
import { OrcaTermAuthPlugin } from "./index.mjs"

const HOUR = 3600e3
const TOKEN_LIFE = 2 * HOUR

// host.js: leadOf and renewAt
const leadOf = (a) => {
  const v = a?.refreshLead
  return Number.isFinite(v) && v >= 0 ? Math.min(v, 24 * HOUR) : 5 * 60e3
}
const renewAt = (a, expires) => Math.max(1, expires - leadOf(a))

const auth = async () => (await OrcaTermAuthPlugin({ client: { app: { log: () => {} } } })).auth

test("an account used once an hour is renewed before its token expires", async () => {
  const a = await auth()
  // a token signed in at 0; the account is used once an hour, at any
  // minute past the sign-in: one use must fall where magpie renews
  for (let first = 0; first < 60; first++) {
    const uses = []
    for (let t = first * 60e3; t < TOKEN_LIFE; t += HOUR) uses.push(t)
    const due = uses.filter((t) => t >= renewAt(a, TOKEN_LIFE))
    expect({ first, renewed: due.length > 0 }).toEqual({ first, renewed: true })
  }
})

test("a token just renewed isn't renewed again on the next use", async () => {
  const a = await auth()
  // the lead is shorter than the token's life, so a request right after a
  // sign-in or a renewal doesn't spend another refresh
  expect(leadOf(a)).toBeLessThan(TOKEN_LIFE - 15 * 60e3)
  expect(Date.now() < renewAt(a, Date.now() + TOKEN_LIFE)).toBe(true)
})

test("the lead is one magpie takes as said, not its cap", async () => {
  const a = await auth()
  expect(Number.isFinite(a.refreshLead)).toBe(true)
  expect(leadOf(a)).toBe(a.refreshLead)
})
