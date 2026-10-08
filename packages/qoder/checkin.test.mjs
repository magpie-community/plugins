// The account's fetch sends Qoder's campaigns pages (the daily check-in) as
// the account, on the device token, for both sites; anything else on those
// hosts is still refused as not a chat.
import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test"
import * as childProcess from "node:child_process"
import * as fsPromises from "node:fs/promises"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, sep } from "node:path"
import { QoderAuthPlugin, QoderCNAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
const originalRuntime = process.env.QODER_RUNTIME_INFO
const realStat = fsPromises.stat
let sandbox, native, reads, nativeError, nativeOutput
const MACHINE_TYPE = "cfe111111111111111"
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "qoder-checkin-"))
  const file = join(sandbox, process.platform === "win32" ? "runtime-info.exe" : "runtime-info")
  writeFileSync(file, "fixture")
  process.env.QODER_RUNTIME_INFO = file
  reads = []
  nativeError = null
  nativeOutput = (uid) => JSON.stringify({ machineToken: "sdk-token-" + uid, machineType: MACHINE_TYPE, machineCode: "fixture-code" })
  native = spyOn(childProcess, "execFile").mockImplementation((file, args, options, done) => ({
    stdin: {
      on() {},
      end(text) {
        const input = text ? JSON.parse(text) : {}
        reads.push({ file, args, options, input })
        queueMicrotask(() => done(nativeError, nativeOutput(input.account ?? "u1")))
      },
    },
  }))
})
afterEach(() => {
  globalThis.fetch = real
  native.mockRestore()
  setSystemTime()
  if (originalRuntime === undefined) delete process.env.QODER_RUNTIME_INFO
  else process.env.QODER_RUNTIME_INFO = originalRuntime
  // Only remove the directory this test made under the system's temp root.
  const target = realpathSync(sandbox)
  if (!target.startsWith(realpathSync(tmpdir()) + sep)) throw new Error("test directory escaped temp root")
  rmSync(target, { recursive: true, force: true })
})

const account = () => ({
  type: "oauth",
  access: "jt-one",
  refresh: "rt-one",
  expires: Date.now() + 86_400_000,
  accountId: "one@x",
  uid: "u1",
  deviceToken: "dt-old",
  deviceRefresh: "drt-old",
})

const json = (v, status = 200) => new Response(JSON.stringify(v), { status })

async function loader(make, serve) {
  let auth = account()
  const seen = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    seen.push({ origin: u.origin, path: u.pathname, method: init.method ?? "GET", auth: init.headers?.Authorization, body: init.body })
    return serve(u, init)
  }
  const client = { auth: { set: async ({ body }) => (auth = body) } }
  const hooks = await make({ client })
  const l = await hooks.auth.loader(async () => auth)
  return { fetch: l.fetch, seen, auth: () => auth }
}

const LIST = { campaigns: [{ campaignId: "c1", actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE", benefit: { amount: 100 } }] }
const CAMPAIGN_URL = "https://openapi.qoder.sh/sash/api/v1/me/campaigns"

test("international campaigns expose the daily 100 credits using the native device identity", async () => {
  const p = await loader(QoderAuthPlugin, (u, init) => {
    const identified = init.headers["Cosy-MachineToken"] === "sdk-token-u1" && init.headers["Cosy-MachineType"] === MACHINE_TYPE
    if (u.pathname.endsWith("/claim")) return json({ status: identified ? "CLAIMED" : "INELIGIBLE" })
    return json(identified ? LIST : { campaigns: [{ campaignId: "details", actionType: "VIEW_DETAILS", claimStatus: "CLAIMED" }] })
  })
  const list = await p.fetch(CAMPAIGN_URL, { method: "GET" })
  expect(await list.json()).toEqual(LIST)
  const claim = await p.fetch(CAMPAIGN_URL + "/c1/claim", { method: "POST", body: "{}" })
  expect((await claim.json()).status).toBe("CLAIMED")
  expect(reads).toHaveLength(1)
  expect(reads[0].args).toEqual(process.platform === "linux" ? ["3"] : ["3", "--account-stdin"])
  if (process.platform !== "linux") expect(reads[0].input).toEqual({ account: "u1" })
})

test("parallel requests share the native identity and refresh it after an hour", async () => {
  setSystemTime(new Date("2026-10-08T06:00:00Z"))
  const p = await loader(QoderAuthPlugin, () => json(LIST))
  await Promise.all([p.fetch(CAMPAIGN_URL), p.fetch(CAMPAIGN_URL)])
  expect(reads).toHaveLength(1)
  setSystemTime(new Date("2026-10-08T07:00:00Z"))
  await p.fetch(CAMPAIGN_URL)
  expect(reads).toHaveLength(2)
})

test("two accounts get separate native identities", async () => {
  const p = await loader(QoderAuthPlugin, () => json(LIST))
  await p.fetch(CAMPAIGN_URL)
  p.auth().uid = "u2"
  await p.fetch(CAMPAIGN_URL)
  expect(reads).toHaveLength(2)
  if (process.platform !== "linux") expect(reads.map((r) => r.input.account)).toEqual(["u1", "u2"])
})

test("a missing native runtime fails before querying campaigns", async () => {
  process.env.QODER_RUNTIME_INFO = join(sandbox, "not-installed")
  native.mockImplementation((file, args, options, done) => {
    queueMicrotask(() => done(new Error("ENOENT")))
    return { stdin: { on() {}, end() {} } }
  })
  const p = await loader(QoderAuthPlugin, () => json(LIST))
  const response = await p.fetch(CAMPAIGN_URL)
  expect(response.status).toBe(502)
  expect(await response.text()).toContain("device identity")
  expect(p.seen).toHaveLength(0)
})

test("Windows finds the Qoder desktop's installed runtime", async () => {
  const file = join(sandbox, "Programs", "Qoder", "resources", "umid", "runtime-info.exe")
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, "fixture")
  expect(await _internal.campaignRuntime({ home: sandbox, platform: "win32", arch: "x64", env: { LOCALAPPDATA: sandbox } })).toBe(file)
})

for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"], ["linux", "x64"]]) {
  test(`${platform}/${arch}: finds the newest matching CLI runtime`, async () => {
    const cache = join(sandbox, ".qoder", ".bin")
    const name = platform === "win32" ? "runtime-info.exe" : "runtime-info"
    const old = join(cache, `umid-${platform}-${arch}-ffff`)
    const newest = join(cache, `umid-${platform}-${arch}-aaaa`)
    const other = join(cache, `umid-${platform}-other-ffff`)
    for (const dir of [old, newest, other]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, name), "fixture")
    }
    utimesSync(old, new Date(1000), new Date(1000))
    utimesSync(newest, new Date(2000), new Date(2000))
    // Keep desktop discovery inside this fixture, even on a Mac with Qoder installed.
    const inspect = spyOn(fsPromises, "stat").mockImplementation((path, ...args) => {
      if (!String(path).startsWith(sandbox + sep)) return Promise.reject(new Error("outside fixture"))
      return realStat(path, ...args)
    })
    try {
      expect(await _internal.campaignRuntime({ home: sandbox, platform, arch, env: {} })).toBe(join(newest, name))
    } finally {
      inspect.mockRestore()
    }
  })
}

test("unavailable native identity fails the request and can be retried", async () => {
  nativeError = new Error("fixture helper unavailable")
  const p = await loader(QoderAuthPlugin, () => json(LIST))
  const failed = await p.fetch(CAMPAIGN_URL)
  expect(failed.status).toBe(502)
  expect(await failed.text()).toContain("device identity")
  expect(p.seen).toHaveLength(0)
  nativeError = null
  expect((await p.fetch(CAMPAIGN_URL)).status).toBe(200)
  expect(reads).toHaveLength(2)
})

for (const identity of [{}, { machineToken: "", machineType: MACHINE_TYPE }, { machineToken: "token", machineType: "" }, { machineToken: "token\ninvalid", machineType: MACHINE_TYPE }, null]) {
  test(`invalid native identity is an error before querying campaigns: ${JSON.stringify(identity)}`, async () => {
    nativeOutput = () => JSON.stringify(identity)
    const p = await loader(QoderAuthPlugin, () => json(LIST))
    const response = await p.fetch(CAMPAIGN_URL)
    expect(response.status).toBe(502)
    expect(await response.text()).toContain("device identity")
    expect(p.seen).toHaveLength(0)
  })
}

test("CN still queries and claims without a native identity runtime", async () => {
  process.env.QODER_RUNTIME_INFO = join(sandbox, "not-installed")
  const p = await loader(QoderCNAuthPlugin, (u, init) => {
    expect(init.headers["Cosy-MachineToken"]).toBeUndefined()
    expect(init.headers["Cosy-MachineType"]).toBeUndefined()
    return json(u.pathname.endsWith("/claim") ? { status: "CLAIMED" } : LIST)
  })
  const url = "https://openapi.qoder.com.cn/sash/api/v1/me/campaigns"
  expect(await (await p.fetch(url)).json()).toEqual(LIST)
  expect((await (await p.fetch(url + "/c1/claim", { method: "POST", body: "{}" })).json()).status).toBe("CLAIMED")
  expect(reads).toHaveLength(0)
})

for (const [make, origin] of [
  [QoderAuthPlugin, "https://openapi.qoder.sh"],
  [QoderCNAuthPlugin, "https://openapi.qoder.com.cn"],
]) {
  test(`${origin}: the campaigns list and a claim go out on the device token`, async () => {
    const p = await loader(make, (u, init) => {
      if (u.pathname === "/sash/api/v1/me/campaigns") return json(LIST)
      if (u.pathname === "/sash/api/v1/me/campaigns/c1/claim") return json({ data: { status: "CLAIMED", benefit: { amount: 100 } } })
      return new Response("", { status: 404 })
    })
    const list = await p.fetch(origin + "/sash/api/v1/me/campaigns", { method: "GET" })
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual(LIST)
    const claim = await p.fetch(origin + "/sash/api/v1/me/campaigns/c1/claim", { method: "POST", body: "{}" })
    expect(claim.status).toBe(200)
    expect((await claim.json()).data.status).toBe("CLAIMED")
    expect(p.seen).toEqual([
      { origin, path: "/sash/api/v1/me/campaigns", method: "GET", auth: "Bearer dt-old", body: undefined },
      { origin, path: "/sash/api/v1/me/campaigns/c1/claim", method: "POST", auth: "Bearer dt-old", body: "{}" },
    ])
  })
}

test("a refused device token is rotated, saved, and the claim asked again", async () => {
  const p = await loader(QoderAuthPlugin, (u, init) => {
    if (u.pathname === "/api/v1/deviceToken/refresh") return json({ device_token: "dt-new", refresh_token: "drt-new" })
    if (u.pathname === "/sash/api/v1/me/campaigns/c1/claim")
      return init.headers.Authorization === "Bearer dt-new" && init.headers["Cosy-MachineToken"] === "sdk-token-u1" && init.headers["Cosy-MachineType"] === MACHINE_TYPE
        ? json({ status: "CLAIMED" }) : new Response("", { status: 401 })
    return new Response("", { status: 404 })
  })
  const res = await p.fetch("https://openapi.qoder.sh/sash/api/v1/me/campaigns/c1/claim", { method: "POST", body: "{}" })
  expect(res.status).toBe(200)
  expect(p.auth().deviceToken).toBe("dt-new")
  expect(p.auth().deviceRefresh).toBe("drt-new")
})

test("only the campaigns pages of the account's own site pass", () => {
  const { campaignPage, SITES } = _internal
  expect(campaignPage(SITES.qoder, "https://openapi.qoder.sh/sash/api/v1/me/campaigns")).toBe(true)
  expect(campaignPage(SITES.qoder, "https://openapi.qoder.sh/sash/api/v1/me/campaigns/x-1/claim")).toBe(true)
  expect(campaignPage(SITES.qoder, "https://openapi.qoder.com.cn/sash/api/v1/me/campaigns")).toBe(false)
  expect(campaignPage(SITES.qoder, "https://openapi.qoder.sh/sash/api/v2/me/usage")).toBe(false)
  expect(campaignPage(SITES.qoder, "https://openapi.qoder.sh/sash/api/v1/me/campaigns/a/b/claim")).toBe(false)
  expect(campaignPage(SITES.qoder, "https://evil.example/sash/api/v1/me/campaigns")).toBe(false)
  expect(campaignPage(SITES["qoder-cn"], "https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/c/claim")).toBe(true)
})

test("another page on the openapi host is still refused", async () => {
  const p = await loader(QoderAuthPlugin, () => json({}))
  const res = await p.fetch("https://openapi.qoder.sh/api/v1/userinfo", { method: "GET" })
  expect(res.status).toBe(404)
  expect(p.seen).toEqual([])
})
