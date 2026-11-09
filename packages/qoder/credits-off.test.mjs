// plugins#880 (zane668): on an international personal_professional_trial
// account, once the 800 credits were used up the account's listing had
// dfmodel off, and the plugin answered every chat for it with its own
// `400 unknown or disabled model "dfmodel"`, which magpie reads as the
// request's fault: a routing group neither failed over nor rested the
// account (yetone/magpie#5726). Qoder had said `429 usage limit reached`
// at 16:11, the 400 followed from 17:14, and dfmodel answered 200 again
// once the daily credits came back.
//
// A model the live listing names and has off, on an account whose usage
// says no credits are left, is now that account's quota: 429 usage limit
// reached. A model off while credits are left, an id Qoder never served,
// and a usage that can't be read keep the 400.
//
// The issue gives the plan, the 800 credits, used 100%, and dfmodel off; it
// doesn't give the listing's or the usage's bytes, so their shape is the
// one the other tests here use (listing-renew, spare-free). Every fetch is
// a fake; nothing reaches the network.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from "node:crypto"
import { QoderAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
const site = _internal.SITES.qoder
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
beforeEach(() => (site.rsaKey = publicKey.export({ type: "spki", format: "pem" })))
afterEach(() => {
  globalThis.fetch = real
  delete site.rsaKey
})

const HOUR = 3_600_000
const CHAT = "https://api3.qoder.sh/v1/chat/completions"
const MODELS = ["dfmodel", "qfmodel", "efficient"]
const TRIAL = (used) => ({ displayMode: "qoder", qoderUsage: { userType: "personal_professional_trial", userQuota: { total: 800, used, remaining: 800 - used, unit: "credits" } } })

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })
const line = (body) => `data:${JSON.stringify({ headers: {}, body: JSON.stringify(body), statusCodeValue: 200 })}\n\n`
const answered = () =>
  new Response(line({ choices: [{ delta: { content: "hello" } }] }) + line({ choices: [{ delta: {}, finish_reason: "stop" }] }) + `data:${JSON.stringify({ headers: {}, body: "[DONE]", statusCodeValue: 200 })}\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  })
const chat = (model) => ({ method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) })

function tokenOf(headers) {
  const block = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, Buffer.from(headers["Cosy-Key"], "base64"))
  const key = block.subarray(block.indexOf(0, 2) + 1)
  const [payload] = headers.Authorization.slice("Bearer COSY.".length).split(".")
  const { info } = JSON.parse(Buffer.from(payload, "base64").toString())
  const d = createDecipheriv("aes-128-cbc", key, key)
  return JSON.parse(Buffer.concat([d.update(Buffer.from(info, "base64")), d.final()]).toString()).security_oauth_token
}

// qoder is the fake: state.off is the models the listing has off,
// state.usage the usage reply (a function, or the envelope)
function qoder(state) {
  const pairs = new Map([["jrt-1", "jt-1"]])
  const honoured = new Set(["jt-1"])
  const calls = { refresh: [], usage: 0, chats: [] }
  let n = 1
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname === "/sash/api/v2/me/usage") {
      calls.usage++
      return typeof state.usage === "function" ? state.usage() : json(state.usage)
    }
    if (u.pathname === "/api/v1/jobToken/refresh") {
      const rt = JSON.parse(init.body).refresh_token
      calls.refresh.push(rt)
      if (!pairs.has(rt)) return json({ message: "invalid refresh token" }, 401)
      pairs.delete(rt)
      n++
      honoured.add(`jt-${n}`)
      pairs.set(`jrt-${n}`, `jt-${n}`)
      return json({ token: `jt-${n}`, refresh_token: `jrt-${n}`, expires_in: 24 * HOUR })
    }
    const t = tokenOf(init.headers)
    if (u.pathname.endsWith("/model/list")) {
      return json({ app: MODELS.map((key) => ({ key, display_name: key, enable: !state.off.includes(key) })), byok_teams: [], byok_enterprise: [] })
    }
    calls.chats.push(t)
    return answered()
  }
  return calls
}

async function account() {
  const box = {
    stored: { type: "oauth", access: "jt-1", refresh: "jrt-1", expires: Date.now() + 24 * HOUR, accountId: "trial@example.com", uid: "u-trial", email: "trial@example.com", machineId: "m1", deviceToken: "dt-1", deviceRefresh: "drt-1" },
  }
  const hooks = await QoderAuthPlugin({ client: { auth: { set: async ({ body }) => (box.stored = { ...body }) } } })
  const l = await hooks.auth.loader(async () => box.stored)
  return { fetch: l.fetch, box }
}

test("plugins#880: dfmodel off with the 800 credits used up is the account's quota, a 429 usage limit, with no token spent", async () => {
  const calls = qoder({ off: ["dfmodel"], usage: TRIAL(800) })
  const a = await account()
  const res = await a.fetch(CHAT, chat("dfmodel"))
  expect(res.status).toBe(429)
  const message = (await res.json()).error.message
  expect(message).toStartWith("usage limit reached: ")
  expect(message).toContain("800 / 800 credits")
  expect(message).toContain('"dfmodel"')
  expect(message).not.toContain("unknown or disabled")
  expect(res.headers.get("X-Magpie-Sign-In")).toBeNull()
  expect(calls.refresh).toEqual([])
  expect(calls.chats).toEqual([])
  // the models still on are served
  expect((await a.fetch(CHAT, chat("qfmodel"))).status).toBe(200)
})

test("plugins#880: once the daily credits are back and the listing has dfmodel on again, it is served", async () => {
  const state = { off: ["dfmodel"], usage: TRIAL(800) }
  qoder(state)
  const a = await account()
  expect((await a.fetch(CHAT, chat("dfmodel"))).status).toBe(429)
  state.off = []
  state.usage = TRIAL(0)
  expect((await a.fetch(CHAT, chat("dfmodel"))).status).toBe(200)
})

test("a model off while credits are left is still said disabled", async () => {
  const calls = qoder({ off: ["dfmodel"], usage: TRIAL(200) })
  const a = await account()
  const res = await a.fetch(CHAT, chat("dfmodel"))
  expect(res.status).toBe(400)
  expect((await res.json()).error.message).toContain('unknown or disabled model "dfmodel"')
  expect(calls.usage).toBe(1)
})

test("an id Qoder never served is said unknown with the credits used up, its usage not read", async () => {
  const calls = qoder({ off: ["dfmodel"], usage: TRIAL(800) })
  const a = await account()
  const res = await a.fetch(CHAT, chat("no-such-model"))
  expect(res.status).toBe(400)
  expect((await res.json()).error.message).toContain('unknown or disabled model "no-such-model"')
  expect(calls.usage).toBe(0)
  expect(calls.refresh).toEqual([])
})

test("a usage that can't be read says nothing of the credits: the model off is said disabled", async () => {
  qoder({ off: ["dfmodel"], usage: () => new Response("boom", { status: 500 }) })
  const a = await account()
  const res = await a.fetch(CHAT, chat("dfmodel"))
  expect(res.status).toBe(400)
  expect((await res.json()).error.message).toContain('unknown or disabled model "dfmodel"')
})

test("spentOf: none left in every pool spent in turn, a free account's pools of 0 too; a pool with some left, or no pool, is not spent", () => {
  const { spentOf } = _internal
  expect(spentOf(TRIAL(800))).toBe("800 / 800 credits")
  expect(spentOf(TRIAL(799))).toBe("")
  expect(spentOf({ displayMode: "qoder", qoderUsage: { userQuota: { total: 300, used: 300 }, addOnQuota: { total: 100, used: 40 } } })).toBe("")
  expect(spentOf({ displayMode: "qoder", qoderUsage: { userQuota: { total: 300, used: 300 }, add_on_quota: { total: 100, remaining: 0 } } })).toBe("400 / 400 credits")
  expect(spentOf({ displayMode: "qoder", qoderUsage: { userType: "personal_standard", userQuota: { total: 0, used: 0, remaining: 0 } } })).toBe("0 / 0 credits")
  expect(spentOf({ displayMode: "qoder", qoderUsage: { userType: "personal" } })).toBe("")
  expect(spentOf({ displayMode: "enterprise" })).toBe("")
  expect(spentOf({ displayMode: "qoder", qoderUsage: { userQuota: { total: 800 } } })).toBe("")
})
