// The daily sign-in: what Tabbit's own answers come to.

import test from "node:test"
import assert from "node:assert/strict"
import { checkinOf, _internal } from "../src/checkin.mjs"

const creds = { header: "token=t; user_id=u", token: "t", uid: "u" }

// stub answers the status and the sign-in with what the test wants.
function stub({ status, claim } = {}) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url)
    calls.push({ path: url.pathname, query: url.search, method: init.method ?? "GET", body: init.body })
    if (url.pathname.endsWith("/sign-in/status")) return Response.json(status ?? {})
    if (url.pathname.endsWith("/sign-in")) return Response.json(claim ?? {})
    return new Response("nope", { status: 404 })
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

const open = (extra) => ({
  sign_in_date: "2026-11-03",
  results: [{ scene_code: "desktop_pet", activity_open: true, signed_today: false, signed_days: 0, total_signed_days: 0, required_days: 3, usage_reward_result: null, pet_entitlement_result: "not_eligible", ...extra }],
})

test("a day already signed is 'done', and nothing is claimed", async () => {
  const { calls, restore } = stub({ status: open({ signed_today: true, signed_days: 1 }) })
  try {
    const out = await checkinOf(creds)
    assert.equal(out.outcome, "done")
    assert.equal(out.streak, 1)
    assert.equal(calls.filter((c) => c.method === "POST").length, 0)
  } finally {
    restore()
  }
})

test("a fresh day is claimed, with the request number Tabbit wants", async () => {
  const { calls, restore } = stub({
    status: open(),
    claim: { sign_in_date: "2026-11-03", results: [{ scene_code: "desktop_pet", activity_open: true, sign_in_result: "signed", signed_days: 1, required_days: 3, usage_reward_result: { amount: 5 } }] },
  })
  try {
    const out = await checkinOf(creds)
    assert.equal(out.outcome, "claimed")
    assert.equal(out.credit, 5)
    assert.equal(out.streak, 1)
    const post = calls.find((c) => c.method === "POST")
    const body = JSON.parse(post.body)
    assert.deepEqual(body.scene_codes, ["desktop_pet"])
    assert.match(body.request_no, /^[0-9a-f-]{36}$/)
  } finally {
    restore()
  }
})

test("a race that lands on 'already_signed' is 'done', not a failure", async () => {
  const { restore } = stub({
    status: open(),
    claim: { results: [{ scene_code: "desktop_pet", activity_open: true, sign_in_result: "already_signed", signed_days: 1 }] },
  })
  try {
    assert.equal((await checkinOf(creds)).outcome, "done")
  } finally {
    restore()
  }
})

test("a closed activity is 'inactive'", async () => {
  const { restore } = stub({ status: { results: [{ scene_code: "desktop_pet", activity_open: false, signed_today: false }] } })
  try {
    assert.equal((await checkinOf(creds)).outcome, "inactive")
  } finally {
    restore()
  }
})

test("no result for the scene is 'ineligible'", async () => {
  const { restore } = stub({ status: { sign_in_date: "2026-11-03", results: [] } })
  try {
    assert.equal((await checkinOf(creds)).outcome, "ineligible")
  } finally {
    restore()
  }
})

test("a word this file hasn't seen is reported, not guessed as a success", async () => {
  const { restore } = stub({ status: open(), claim: { results: [{ scene_code: "desktop_pet", sign_in_result: "throttled" }] } })
  try {
    const out = await checkinOf(creds)
    assert.equal(out.outcome, "failed")
    assert.match(out.message, /throttled/)
  } finally {
    restore()
  }
})

test("a refused sign-in throws with magpie's expired mark", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: "invalid bearer token" }), { status: 401 })
  try {
    await assert.rejects(() => checkinOf(creds), (error) => error.signIn === "expired")
  } finally {
    globalThis.fetch = original
  }
})

test("the status call asks for the scene the service takes", async () => {
  const { calls, restore } = stub({ status: open({ signed_today: true }) })
  try {
    await checkinOf(creds)
    assert.match(calls[0].query, /scene_codes=desktop_pet/)
  } finally {
    restore()
  }
})

test("a reward's number is read out of whatever shape it arrives in", () => {
  assert.equal(_internal.rewardOf({ usage_reward_result: { amount: 3 } }), 3)
  assert.equal(_internal.rewardOf({ usage_reward_result: { credit: "7" } }), 7)
  assert.equal(_internal.rewardOf({ usage_reward_result: 12 }), 12)
  assert.equal(_internal.rewardOf({ usage_reward_result: null }), undefined)
  assert.equal(_internal.rewardOf({}), undefined)
})
