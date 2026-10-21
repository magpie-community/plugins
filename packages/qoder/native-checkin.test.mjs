// Native auth.checkin: the campaigns answer in magpie's outcome words, not
// Qoder's raw page.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import * as childProcess from "node:child_process"
import * as fsPromises from "node:fs/promises"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { QoderAuthPlugin, QoderCNAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
const originalRuntime = process.env.QODER_RUNTIME_INFO
const MACHINE_TYPE = "cfe111111111111111"
let sandbox, native, reads, nativeError, nativeOutput
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "qoder-native-checkin-"))
  process.env.QODER_RUNTIME_INFO = join(sandbox, process.platform === "win32" ? "runtime-info.exe" : "runtime-info")
  writeFileSync(process.env.QODER_RUNTIME_INFO, "fixture")
  reads = []
  nativeError = null
  nativeOutput = (uid) => JSON.stringify({ machineToken: "sdk-token-" + uid, machineType: MACHINE_TYPE })
  native = spyOn(childProcess, "execFile").mockImplementation((file, args, options, done) => ({
    stdin: {
      on() {},
      end(text) {
        const input = text ? JSON.parse(text) : {}
        reads.push({ args, input })
        queueMicrotask(() => done(nativeError, nativeOutput(input.account ?? "u1")))
      },
    },
  }))
})
afterEach(() => {
  globalThis.fetch = real
  native.mockRestore()
  if (originalRuntime === undefined) delete process.env.QODER_RUNTIME_INFO
  else process.env.QODER_RUNTIME_INFO = originalRuntime
  const target = realpathSync(sandbox)
  if (!target.startsWith(realpathSync(tmpdir()) + sep)) throw new Error("test directory escaped temp root")
  rmSync(target, { recursive: true, force: true })
})

const account = () => ({
  type: "oauth", access: "jt", refresh: "rt", expires: Date.now() + 3_600_000,
  accountId: "one@x", uid: "u1", deviceToken: "dt", deviceRefresh: "drt",
})
const json = (v, status = 200) => new Response(JSON.stringify(v), { status })
const LIST = { campaigns: [{ campaignId: "c1", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE", benefit: { amount: 100 } }] }

async function checkin(make, serve, origin = "https://openapi.qoder.sh") {
  let auth = account()
  const seen = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    seen.push({ path: u.pathname, method: init.method ?? "GET", auth: init.headers.Authorization, body: init.body })
    return serve(u, init)
  }
  const hooks = await make({ client: { auth: { set: async ({ body }) => (auth = body) } } })
  return { out: await hooks.auth.checkin(async () => auth), seen, auth: () => auth }
}

test("a claimable campaign is claimed with the native identity", async () => {
  const p = await checkin(QoderAuthPlugin, (u, init) => {
    const identified = init.headers["Cosy-MachineToken"] === "sdk-token-u1" && init.headers["Cosy-MachineType"] === MACHINE_TYPE
    if (u.pathname.endsWith("/claim")) return json(identified ? { status: "CLAIMED" } : { status: "INELIGIBLE" })
    return json(identified ? LIST : { campaigns: [] })
  })
  expect(p.out).toEqual({ outcome: "claimed", credit: 100 })
  expect(p.seen.map((x) => x.path)).toEqual(["/sash/api/v1/me/campaigns", "/sash/api/v1/me/campaigns/c1/claim"])
  expect(reads).toHaveLength(1)
})

test("an already-claimed campaign is done without another claim", async () => {
  const p = await checkin(QoderAuthPlugin, () => json({ campaigns: [{ campaignId: "c1", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMED", benefit: { amount: 100 } }] }))
  expect(p.out).toEqual({ outcome: "done", credit: 100 })
  expect(p.seen.map((x) => x.path)).toEqual(["/sash/api/v1/me/campaigns"])
})

test("no benefit campaign is inactive", async () => {
  const p = await checkin(QoderAuthPlugin, () => json({ campaigns: [{ campaignId: "x", actionType: "VIEW_DETAILS", claimStatus: "CLAIMABLE" }] }))
  expect(p.out).toEqual({ outcome: "inactive" })
})

test("a claim answer with nested data is read", async () => {
  const p = await checkin(QoderAuthPlugin, (u) => u.pathname.endsWith("/claim") ? json({ data: { status: "CLAIMED", benefit: { amount: 100 } } }) : json(LIST))
  expect(p.out).toEqual({ outcome: "claimed", credit: 100 })
})

test("CN claims without the native runtime", async () => {
  process.env.QODER_RUNTIME_INFO = join(sandbox, "not-installed")
  const p = await checkin(QoderCNAuthPlugin, (u, init) => {
    expect(init.headers["Cosy-MachineToken"]).toBeUndefined()
    return u.pathname.endsWith("/claim") ? json({ status: "CLAIMED" }) : json(LIST)
  }, "https://openapi.qoder.com.cn")
  expect(p.out).toEqual({ outcome: "claimed", credit: 100 })
  expect(reads).toHaveLength(0)
})

test("an unreadable list reply is failed", async () => {
  const p = await checkin(QoderAuthPlugin, () => new Response("<html>"))
  expect(p.out).toMatchObject({ outcome: "failed" })
  expect(p.out.message).toContain("unreadable")
})

test("yesterday's claimed entry does not hide today's claimable campaign", async () => {
  const list = { campaigns: [
    { campaignId: "old", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMED", startAt: Math.floor(Date.now()/1000)-86400, endAt: Math.floor(Date.now()/1000)+86400, benefit: { amount: 50 } },
    { campaignId: "new", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE", startAt: Math.floor(Date.now()/1000)-100, endAt: Math.floor(Date.now()/1000)+86000, benefit: { amount: 100 } },
  ] }
  const p = await checkin(QoderAuthPlugin, (u) => u.pathname.endsWith("/claim") ? json({ status: "CLAIMED", benefit: { amount: 125 } }) : json(list))
  expect(p.out).toEqual({ outcome: "claimed", credit: 125 })
})

test("an active claimed campaign is done, and an unavailable one retries", async () => {
  const active = { campaignId: "c", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMED", startAt: Math.floor(Date.now()/1000)-100, endAt: Math.floor(Date.now()/1000)+1000, benefit: { amount: 100 } }
  let p = await checkin(QoderAuthPlugin, () => json({ campaigns: [active] }))
  expect(p.out).toEqual({ outcome: "done", credit: 100 })
  p = await checkin(QoderAuthPlugin, () => json({ campaigns: [{ ...active, claimStatus: "DISABLED" }] }))
  expect(p.out).toEqual({ outcome: "failed", message: "campaigns: today's credits aren't offered yet" })
})

test("a refused device token is rotated and the claim asked again", async () => {
  const p = await checkin(QoderAuthPlugin, (u, init) => {
    if (u.pathname === "/api/v1/deviceToken/refresh") return json({ device_token: "dt-new", refresh_token: "drt-new" })
    const authed = init.headers.Authorization === "Bearer dt-new" && init.headers["Cosy-MachineToken"] === "sdk-token-u1"
    return authed ? (u.pathname.endsWith("/claim") ? json({ status: "CLAIMED" }) : json(LIST)) : new Response("", { status: 401 })
  })
  expect(p.out).toEqual({ outcome: "claimed", credit: 100 })
  expect(p.auth().deviceToken).toBe("dt-new")
})

test("a PAT account's daily check-in claims on its job token, with no device token to rotate", async () => {
  for (const [make, origin] of [[QoderAuthPlugin, "https://openapi.qoder.sh"], [QoderCNAuthPlugin, "https://openapi.qoder.com.cn"]]) {
    let auth = { ...account(), patAuth: true, pat: "pt-x", deviceToken: "", deviceRefresh: "" }
    const seen = []
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(String(url))
      seen.push({ origin: u.origin, path: u.pathname, auth: init.headers.Authorization })
      if (init.headers.Authorization !== "Bearer jt") return new Response("", { status: 401 })
      return u.pathname.endsWith("/claim") ? json({ status: "CLAIMED" }) : json(LIST)
    }
    const hooks = await make({ client: { auth: { set: async ({ body }) => (auth = body) } } })
    const out = await hooks.auth.checkin(async () => auth)
    expect(out).toEqual({ outcome: "claimed", credit: 100 })
    expect(seen.map((s) => s.origin + s.path)).toEqual([origin + "/sash/api/v1/me/campaigns", origin + "/sash/api/v1/me/campaigns/c1/claim"])
    expect(auth.deviceToken).toBe("")
  }
})

test("a PAT account's refused check-in is failed, not rotated", async () => {
  let auth = { ...account(), patAuth: true, pat: "pt-x", deviceToken: "", deviceRefresh: "" }
  const seen = []
  globalThis.fetch = async (url) => (seen.push(new URL(String(url)).pathname), json({}, 403))
  const hooks = await QoderCNAuthPlugin({ client: { auth: { set: async ({ body }) => (auth = body) } } })
  const out = await hooks.auth.checkin(async () => auth)
  expect(out).toEqual({ outcome: "failed", message: "campaigns: HTTP 403" })
  expect(seen).toEqual(["/sash/api/v1/me/campaigns"])
})
