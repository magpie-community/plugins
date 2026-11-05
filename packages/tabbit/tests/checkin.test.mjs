// The daily sign-in: what Tabbit's own answers come to, across both scenes.

import test from "node:test"
import assert from "node:assert/strict"
import { checkinOf, _internal } from "../src/checkin.mjs"

const creds = { header: "token=t; user_id=u", token: "t", uid: "u" }

// The fixtures are dated 2026-11-03, so pass a `now` that lands on that local
// day regardless of the machine's zone (a bare local date-time is local).
const atNov3 = { now: new Date("2026-11-03T12:00:00") }

const row = (scene, extra) => ({
  scene_code: scene, activity_open: true, signed_today: false, signed_days: 0,
  total_signed_days: 0, required_days: null, usage_reward_result: null, pet_entitlement_result: null, ...extra,
})
const statusOf = (sign_in_date, rows) => ({ sign_in_date, results: rows })

// stub serves the initial combined status, per-scene verification statuses
// (after[scene]) and per-scene claim replies (claim[scene]).
function stub({ status, claim = {}, after = {} } = {}) {
  const calls = []
  let statusReads = 0
  const original = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url)
    const method = init.method ?? "GET"
    calls.push({ path: url.pathname, query: url.search, method, body: init.body, scenes: url.searchParams.getAll("scene_codes") })
    if (url.pathname.endsWith("/sign-in/status")) {
      if (statusReads++ === 0) return Response.json(status ?? {})
      const scene = url.searchParams.getAll("scene_codes")[0]
      return Response.json(after[scene] ?? {})
    }
    if (url.pathname.endsWith("/sign-in")) {
      const body = JSON.parse(init.body || "{}")
      const scene = (body.scene_codes || [])[0]
      return Response.json(claim[scene] ?? {})
    }
    return new Response("nope", { status: 404 })
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

test("both scenes already signed is 'done', and nothing is claimed", async () => {
  const { calls, restore } = stub({
    status: statusOf("2026-11-03", [
      row("daily_sign_in", { signed_today: true, signed_days: 3, usage_reward_result: "available" }),
      row("desktop_pet", { signed_today: true, signed_days: 3, required_days: 3, pet_entitlement_result: "available" }),
    ]),
  })
  try {
    const out = await checkinOf(creds, atNov3)
    assert.equal(out.outcome, "done")
    assert.equal(calls.filter((c) => c.method === "POST").length, 0)
  } finally {
    restore()
  }
})

test("the unsigned daily_sign_in is claimed (desktop_pet already signed)", async () => {
  const { calls, restore } = stub({
    status: statusOf("2026-11-03", [
      row("daily_sign_in"),
      row("desktop_pet", { signed_today: true, signed_days: 3, required_days: 3 }),
    ]),
    claim: { daily_sign_in: statusOf("2026-11-03", [row("daily_sign_in", { sign_in_result: "success", signed_days: 1, usage_reward_result: "success" })]) },
    after: { daily_sign_in: statusOf("2026-11-03", [row("daily_sign_in", { signed_today: true, signed_days: 1 })]) },
  })
  try {
    const out = await checkinOf(creds, atNov3)
    assert.equal(out.outcome, "claimed")
    assert.match(out.message, /daily_sign_in/)
    const posts = calls.filter((c) => c.method === "POST")
    assert.equal(posts.length, 1)
    const body = JSON.parse(posts[0].body)
    assert.deepEqual(body.scene_codes, ["daily_sign_in"])
    assert.match(body.request_no, /^[0-9a-f-]{36}$/)
  } finally {
    restore()
  }
})

test("'success' is NOT believed when the scene still isn't signed today", async () => {
  const { restore } = stub({
    status: statusOf("2026-11-03", [row("daily_sign_in")]),
    claim: { daily_sign_in: statusOf("2026-11-03", [row("daily_sign_in", { sign_in_result: "success", signed_days: 1 })]) },
    after: { daily_sign_in: statusOf("2026-11-03", [row("daily_sign_in", { signed_today: false })]) },
  })
  try {
    const out = await checkinOf(creds, atNov3)
    assert.equal(out.outcome, "failed")
    assert.match(out.message, /not landed/)
  } finally {
    restore()
  }
})

test("a claim made before Tabbit's day reaches today is deferred, not fired", async () => {
  const { calls, restore } = stub({ status: statusOf("2026-11-02", [row("daily_sign_in"), row("desktop_pet")]) })
  try {
    const out = await checkinOf(creds, atNov3)
    assert.equal(out.outcome, "failed")
    assert.match(out.message, /waiting for server day|server day 2026-11-02/)
    assert.equal(calls.filter((c) => c.method === "POST").length, 0)
  } finally {
    restore()
  }
})

test("a sign_in_result this file hasn't seen is reported, not guessed as success", async () => {
  const { restore } = stub({
    status: statusOf("2026-11-03", [row("daily_sign_in")]),
    claim: { daily_sign_in: statusOf("2026-11-03", [row("daily_sign_in", { sign_in_result: "throttled" })]) },
  })
  try {
    const out = await checkinOf(creds, atNov3)
    assert.equal(out.outcome, "failed")
    assert.match(out.message, /throttled/)
  } finally {
    restore()
  }
})

test("a race that lands on 'already_signed' is 'done', not a failure", async () => {
  const { restore } = stub({
    status: statusOf("2026-11-03", [row("daily_sign_in")]),
    claim: { daily_sign_in: statusOf("2026-11-03", [row("daily_sign_in", { sign_in_result: "already_signed", signed_days: 1 })]) },
    after: { daily_sign_in: statusOf("2026-11-03", [row("daily_sign_in", { signed_today: true, signed_days: 1 })]) },
  })
  try {
    assert.equal((await checkinOf(creds, atNov3)).outcome, "done")
  } finally {
    restore()
  }
})

test("every scene closed is 'inactive'", async () => {
  const { restore } = stub({ status: statusOf("2026-11-03", [row("daily_sign_in", { activity_open: false }), row("desktop_pet", { activity_open: false })]) })
  try {
    assert.equal((await checkinOf(creds, atNov3)).outcome, "inactive")
  } finally {
    restore()
  }
})

test("no result for any scene is 'ineligible'", async () => {
  const { restore } = stub({ status: statusOf("2026-11-03", []) })
  try {
    assert.equal((await checkinOf(creds, atNov3)).outcome, "ineligible")
  } finally {
    restore()
  }
})

test("a refused sign-in throws with magpie's expired mark", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: "invalid bearer token" }), { status: 401 })
  try {
    await assert.rejects(() => checkinOf(creds, atNov3), (error) => error.signIn === "expired")
  } finally {
    globalThis.fetch = original
  }
})

test("the status call asks for both scenes", async () => {
  const { calls, restore } = stub({ status: statusOf("2026-11-03", [row("daily_sign_in", { signed_today: true, signed_days: 3 }), row("desktop_pet", { signed_today: true, signed_days: 3 })]) })
  try {
    await checkinOf(creds, atNov3)
    assert.ok(calls[0].scenes.includes("daily_sign_in"))
    assert.ok(calls[0].scenes.includes("desktop_pet"))
  } finally {
    restore()
  }
})

test("a reward's number is read out of whatever shape it arrives in", () => {
  assert.equal(_internal.rewardOf({ usage_reward_result: { amount: 3 } }), 3)
  assert.equal(_internal.rewardOf({ usage_reward_result: { credit: "7" } }), 7)
  assert.equal(_internal.rewardOf({ usage_reward_result: 12 }), 12)
  assert.equal(_internal.rewardOf({ usage_reward_result: "success" }), undefined)
  assert.equal(_internal.rewardOf({ usage_reward_result: null }), undefined)
  assert.equal(_internal.rewardOf({}), undefined)
})

test("localDay and sameDay pin the sign-in to the user's calendar day", () => {
  assert.equal(_internal.localDay(new Date("2026-11-03T00:01:00")), "2026-11-03")
  assert.equal(_internal.sameDay("2026-11-03", "2026-11-03"), true)
  assert.equal(_internal.sameDay("2026-11-02", "2026-11-03"), false)
  assert.equal(_internal.sameDay("2026-11-03T12:00:00", "2026-11-03"), true)
  assert.equal(_internal.sameDay("", "2026-11-03"), true)
  assert.equal(_internal.sameDay(undefined, "2026-11-03"), true)
})
