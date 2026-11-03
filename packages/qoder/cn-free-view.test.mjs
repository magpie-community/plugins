// star21321321124_93024 on Discord (2026-11-01): a Qoder CN personal account,
// its 1500 credits all left, listed one model in magpie, the free Flash, so
// agents saw that one alone.
//
// testdata/cn-listing-free-view.json is what gateway.qoder.com.cn's
// /algo/api/v2/model/list answered on 2026-11-01 to a caller it doesn't take
// for an account: in every scene the free Qwen3.8-Flash on, and Auto, Fast,
// Qwen3.8-Max, DeepSeek, GLM, Kimi and MiniMax off. The account's own list
// is the same bytes with each model on. The fake gives the free view to a
// job token it no longer takes in full and the account's list to one it
// does, as plugins#484's fake does for qoder.com; 0.2.49 renewed such a token
// for a chat but not for the list magpie reads (provider.models), which is
// the list agents see. Calls are COSY-signed; the fake opens the envelope
// with the private half of a key the test puts in place of Qoder's.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from "node:crypto"
import { QoderCNAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
const site = _internal.SITES["qoder-cn"]
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
beforeEach(() => (site.rsaKey = publicKey.export({ type: "spki", format: "pem" })))
afterEach(() => {
  globalThis.fetch = real
  delete site.rsaKey
})

const HOUR = 3_600_000
const FREE_VIEW = readFileSync(new URL("./testdata/cn-listing-free-view.json", import.meta.url), "utf8")
const ACCOUNT = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(FREE_VIEW)).map(([k, v]) => [k, Array.isArray(v) ? v.map((m) => ({ ...m, enable: true })) : v])))
// the app scene's models an agent can pick: all but auto
const APP = JSON.parse(FREE_VIEW).app.map((m) => m.key).filter((k) => k !== "auto")

const json = (v, status = 200) => new Response(typeof v === "string" ? v : JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })

// tokenOf is the job token a COSY-signed call carries
function tokenOf(headers) {
  const block = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, Buffer.from(headers["Cosy-Key"], "base64"))
  const key = block.subarray(block.indexOf(0, 2) + 1)
  const [payload] = headers.Authorization.slice("Bearer COSY.".length).split(".")
  const { info } = JSON.parse(Buffer.from(payload, "base64").toString())
  const d = createDecipheriv("aes-128-cbc", key, key)
  return JSON.parse(Buffer.concat([d.update(Buffer.from(info, "base64")), d.final()]).toString()).security_oauth_token
}

// qoderCN is the fake. honoured is the job tokens it lists the account's
// models for; renewing gives a token it honours unless stale says not.
function qoderCN({ honoured = new Set(), stale = false } = {}) {
  const pairs = new Map([["jrt-1", "jt-1"]])
  const calls = { refresh: [], listings: [] }
  let n = 1
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.host === "openapi.qoder.com.cn" && u.pathname === "/api/v1/jobToken/refresh") {
      const rt = JSON.parse(init.body).refresh_token
      calls.refresh.push(rt)
      if (!pairs.has(rt)) return json({ message: "invalid refresh token" }, 401)
      pairs.delete(rt)
      n++
      if (!stale) honoured.add(`jt-${n}`)
      pairs.set(`jrt-${n}`, `jt-${n}`)
      return json({ token: `jt-${n}`, refresh_token: `jrt-${n}`, expires_in: 24 * HOUR })
    }
    if (u.host === "gateway.qoder.com.cn" && u.pathname === "/algo/api/v2/model/list") {
      const t = tokenOf(init.headers)
      calls.listings.push(t)
      return json(honoured.has(t) ? ACCOUNT : FREE_VIEW)
    }
    return new Response("", { status: 404 })
  }
  return calls
}

// account is a Qoder CN personal account as magpie saved it, its job token a
// day from its saved end
async function account() {
  const box = { stored: { type: "oauth", access: "jt-1", refresh: "jrt-1", expires: Date.now() + 24 * HOUR, accountId: "cn@x", uid: "u-cn", machineId: "m-cn", deviceToken: "dt-cn", deviceRefresh: "drt-cn" } }
  const hooks = await QoderCNAuthPlugin({ client: { auth: { set: async ({ body }) => (box.stored = { ...body }) } } })
  return { hooks, box, list: () => hooks.provider.models({ models: { fallback: {} } }, { auth: box.stored }) }
}

test("the free view is Qoder CN's real answer: only the free model on", () => {
  const listing = JSON.parse(FREE_VIEW)
  const on = listing.app.filter((m) => m.enable).map((m) => m.display_name)
  expect(on).toEqual(["Qwen3.8-Flash"])
  expect(APP.length).toBeGreaterThan(5)
})

test("an account listed the free view on its job token lists every model after one renewal", async () => {
  const calls = qoderCN()
  const a = await account()
  const ms = await a.list()
  expect(Object.keys(ms)).toEqual(APP)
  expect(ms.qfmodel.free).toBe(true)
  expect(ms.qmodel_38max.free).toBe(false)
  expect(calls.refresh).toEqual(["jrt-1"])
  expect(calls.listings).toEqual(["jt-1", "jt-2"])
  expect(a.box.stored).toMatchObject({ access: "jt-2", refresh: "jrt-2" })
  // the renewed token lists them again with no renewal
  expect(Object.keys(await a.list())).toEqual(APP)
  expect(calls.refresh).toEqual(["jrt-1"])
})

test("the account's next usage read says the renewal the list made", async () => {
  qoderCN()
  const a = await account()
  await a.list()
  globalThis.fetch = async (url) => {
    if (new URL(String(url)).pathname === "/sash/api/v2/me/usage") return json({ displayMode: "qoder", qoderUsage: { userType: "personal", userQuota: { total: 1500, used: 0 } } })
    return json({ app: [] })
  }
  expect((await a.hooks.auth.usage(async () => a.box.stored)).signIn).toBe("renewed")
})

test("an account that lists the free view on a renewed token too is listed as it is, renewed once", async () => {
  const calls = qoderCN({ stale: true })
  const a = await account()
  expect(Object.keys(await a.list())).toEqual(["qfmodel"])
  // past the five minutes a refused renewed token isn't renewed again for:
  // the list magpie reads again later spends no refresh token
  const now = Date.now
  try {
    for (let i = 1; i <= 2; i++) {
      Date.now = () => now() + i * 30 * 60_000
      expect(Object.keys(await a.list())).toEqual(["qfmodel"])
    }
  } finally {
    Date.now = now
  }
  expect(calls.refresh).toEqual(["jrt-1"])
})

test("an account whose list has its paid models on spends no refresh token", async () => {
  const calls = qoderCN({ honoured: new Set(["jt-1"]) })
  const a = await account()
  expect(Object.keys(await a.list())).toEqual(APP)
  expect(calls.refresh).toEqual([])
  expect(calls.listings).toEqual(["jt-1"])
})

test("freeView: a list with a paid model on, or with none that costs credits, isn't the free view", () => {
  const { freeView } = _internal
  expect(freeView(JSON.parse(FREE_VIEW).app)).toBe(true)
  expect(freeView(JSON.parse(ACCOUNT).app)).toBe(false)
  expect(freeView([{ key: "qfmodel", enable: true, price_factor: 0 }])).toBe(false)
  expect(freeView([{ key: "auto", enable: false, price_factor: 0.5 }, { key: "qfmodel", enable: true, price_factor: 0 }])).toBe(false)
  expect(freeView([{ key: "gmodel", enable: false, price_factor: 0.8 }, { key: "kmodel", enable: true, price_factor: 0.8 }])).toBe(false)
})
