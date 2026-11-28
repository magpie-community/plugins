// plugins#1670: a models listing saves the sign-in (client.auth.set) only
// when its token changed. Each save has magpie read every sign-in again,
// and before magpie v0.1.4992 it listed every plugin again too, without
// end. The fake is cn-free-view's: Qoder CN, COSY-signed calls opened with
// a key the test puts in place of Qoder's.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from "node:crypto"
import { QoderCNAuthPlugin } from "./index.mjs"
import { _internal } from "./index.mjs"

const real = globalThis.fetch
const site = _internal.SITES["qoder-cn"]
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const realNow = Date.now
let now
beforeEach(() => {
  site.rsaKey = publicKey.export({ type: "spki", format: "pem" })
  now = realNow()
  Date.now = () => now
})
afterEach(() => {
  globalThis.fetch = real
  Date.now = realNow
  delete site.rsaKey
})

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const FREE_VIEW = readFileSync(new URL("./testdata/cn-listing-free-view.json", import.meta.url), "utf8")
const ACCOUNT = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(FREE_VIEW)).map(([k, v]) => [k, Array.isArray(v) ? v.map((m) => ({ ...m, enable: true })) : v])))
const json = (v, status = 200) => new Response(typeof v === "string" ? v : JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })

function tokenOf(headers) {
  const block = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, Buffer.from(headers["Cosy-Key"], "base64"))
  const key = block.subarray(block.indexOf(0, 2) + 1)
  const [payload] = headers.Authorization.slice("Bearer COSY.".length).split(".")
  const { info } = JSON.parse(Buffer.from(payload, "base64").toString())
  const d = createDecipheriv("aes-128-cbc", key, key)
  return JSON.parse(Buffer.concat([d.update(Buffer.from(info, "base64")), d.final()]).toString()).security_oauth_token
}

// qoderCN lists the account's models for the job tokens in honoured, the
// free view for any other. A refresh gives a new pair, or with same the
// pair it was asked with back.
function qoderCN({ honoured = new Set(), same = false } = {}) {
  const calls = { refresh: [], listings: [] }
  let n = 1
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname === "/api/v1/jobToken/refresh") {
      const rt = JSON.parse(init.body).refresh_token
      calls.refresh.push(rt)
      if (same) return json({ token: `jt-${rt.slice(4)}`, refresh_token: rt, expires_in: 24 * HOUR })
      n++
      honoured.add(`jt-${n}`)
      return json({ token: `jt-${n}`, refresh_token: `jrt-${n}`, expires_in: 24 * HOUR })
    }
    if (u.pathname === "/algo/api/v2/model/list") {
      const t = tokenOf(init.headers)
      calls.listings.push(t)
      return json(honoured.has(t) ? ACCOUNT : FREE_VIEW)
    }
    return new Response("", { status: 404 })
  }
  return calls
}

async function account(expires = 24 * HOUR) {
  const box = { stored: { type: "oauth", access: "jt-1", refresh: "jrt-1", expires: Date.now() + expires, accountId: "cn@x", uid: "u-cn", machineId: "m-cn", deviceToken: "dt-cn", deviceRefresh: "drt-cn" } }
  const sets = []
  const hooks = await QoderCNAuthPlugin({ client: { auth: { set: async ({ body }) => { sets.push(body); box.stored = { ...body } } } } })
  return { sets, box, list: () => hooks.provider.models({ models: { fallback: {} } }, { auth: box.stored }) }
}

test("listing models twice with an unchanged token saves nothing", async () => {
  const calls = qoderCN({ honoured: new Set(["jt-1"]) })
  const a = await account()
  for (let i = 0; i < 2; i++) {
    expect(Object.keys(await a.list()).length).toBeGreaterThan(5)
    now += 10 * MINUTE
  }
  expect(a.sets).toEqual([])
  expect(calls.refresh).toEqual([])
})

test("a token near its end is renewed and saved once, and the renewed one listed again saves nothing", async () => {
  const calls = qoderCN({ honoured: new Set(["jt-1"]) })
  const a = await account(2 * MINUTE)
  await a.list()
  expect(a.sets.length).toBe(1)
  expect(a.sets[0]).toMatchObject({ access: "jt-2", refresh: "jrt-2" })
  for (let i = 0; i < 2; i++) {
    now += 10 * MINUTE
    await a.list()
  }
  expect(a.sets.length).toBe(1)
  expect(calls.refresh).toEqual(["jrt-1"])
})

// A refresh that hands the job token it was asked with back renewed
// nothing. Up to 0.2.78 the free view on such a token had each listing
// past RELOGIN_GAP spend the refresh token again and save the same sign-in:
// three listings, three saves.
test("a renewal for the free view that gives the same token back saves nothing and isn't asked again", async () => {
  const calls = qoderCN({ same: true })
  const a = await account()
  for (let i = 0; i < 3; i++) {
    expect(Object.keys(await a.list())).toEqual(["qfmodel"])
    now += 10 * MINUTE
  }
  expect(a.sets).toEqual([])
  expect(calls.refresh).toEqual(["jrt-1"])
})
