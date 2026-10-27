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
const originalCNRuntime = process.env.QODERCN_RUNTIME_INFO
const realStat = fsPromises.stat
let sandbox, native, reads, nativeError, nativeOutput
const MACHINE_TYPE = "cfe111111111111111"
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "qoder-checkin-"))
  const file = join(sandbox, process.platform === "win32" ? "runtime-info.exe" : "runtime-info")
  writeFileSync(file, "fixture")
  process.env.QODER_RUNTIME_INFO = file
  process.env.QODERCN_RUNTIME_INFO = file
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
  if (originalCNRuntime === undefined) delete process.env.QODERCN_RUNTIME_INFO
  else process.env.QODERCN_RUNTIME_INFO = originalCNRuntime
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

async function loader(make, serve, over = {}) {
  let auth = { ...account(), ...over }
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

// accomplish (Discord, 10-21): international check-in failed while CN's
// needs no device identity at all. A machine-wide Qoder install on Windows
// keeps the runtime under Program Files, which wasn't searched.
test("Windows finds a machine-wide Qoder install's runtime", async () => {
  const file = join(sandbox, "Program Files", "Qoder", "resources", "umid", "runtime-info.exe")
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, "fixture")
  const env = { LOCALAPPDATA: join(sandbox, "Local"), ProgramFiles: join(sandbox, "Program Files") }
  expect(await inSandbox(() => _internal.campaignRuntime({ home: join(sandbox, "nobody"), platform: "win32", arch: "x64", env }))).toBe(file)
})

// Keep desktop discovery inside the fixture, even on a Mac with Qoder installed.
async function inSandbox(run) {
  const inspect = spyOn(fsPromises, "stat").mockImplementation((path, ...args) => {
    if (!String(path).startsWith(sandbox + sep)) return Promise.reject(new Error("outside fixture"))
    return realStat(path, ...args)
  })
  try {
    return await run()
  } finally {
    inspect.mockRestore()
  }
}

// cliCache lays out Qoder CLI's .bin as qodercli 1.1.66 writes it
// (extractBinary): a folder umid-win32-<arch>-<hash> holding runtime-info.exe
// and sgsdk.dll on Windows; a file runtime-info-<platform>-<arch>-<hash>
// elsewhere, beside its .tmp while it is being written. It returns the
// newest matching runtime.
function cliCache(config, platform, arch) {
  const cache = join(config, ".bin")
  mkdirSync(cache, { recursive: true })
  const make = (hash, a, time) => {
    let file
    if (platform === "win32") {
      const dir = join(cache, `umid-win32-${a}-${hash}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "sgsdk.dll"), "fixture")
      file = join(dir, "runtime-info.exe")
    } else {
      file = join(cache, `runtime-info-${platform}-${a}-${hash}`)
    }
    writeFileSync(file, "fixture")
    utimesSync(file, new Date(time), new Date(time))
    return file
  }
  make("ffffffffffffffff", arch, 1000)
  make("eeeeeeeeeeeeeeee", "other", 3000)
  const newest = make("aaaaaaaaaaaaaaaa", arch, 2000)
  if (platform !== "win32") writeFileSync(join(cache, `runtime-info-${platform}-${arch}-bbbbbbbbbbbbbbbb.0a1b2c3d.tmp`), "partial")
  return newest
}

for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["linux", "arm64"]]) {
  test(`${platform}/${arch}: finds the newest runtime Qoder CLI cached`, async () => {
    const newest = cliCache(join(sandbox, ".qoder"), platform, arch)
    expect(await inSandbox(() => _internal.campaignRuntime({ home: sandbox, platform, arch, env: {}, opt: join(sandbox, "opt") }))).toBe(newest)
  })
}

test("finds the runtime under Qoder CLI's own config folder", async () => {
  const dir = cliCache(join(sandbox, "custom"), "linux", "x64")
  const named = cliCache(join(sandbox, "clihome", ".qoder-work"), "linux", "x64")
  const run = (env) => inSandbox(() => _internal.campaignRuntime({ home: join(sandbox, "nobody"), platform: "linux", arch: "x64", env, opt: join(sandbox, "opt") }))
  expect(await run({ QODER_CONFIG_DIR: join(sandbox, "custom") })).toBe(dir)
  expect(await run({ QODER_CLI_HOME: join(sandbox, "clihome"), QODER_CONFIG_DIR_NAME: ".qoder-work" })).toBe(named)
})

test("Linux finds the Qoder desktop's /opt/Qoder runtime", async () => {
  const file = join(sandbox, "opt", "Qoder", "resources", "umid", "runtime-info")
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, "fixture")
  expect(await inSandbox(() => _internal.campaignRuntime({ home: sandbox, platform: "linux", arch: "x64", env: {}, opt: join(sandbox, "opt") }))).toBe(file)
})

// Qoder CN keeps its runtime under its own names (Qoder CN desktop 0.4.9's
// .deb, macOS installer and Windows user installer; qoderclicn 1.1.77), and
// never reads the international Qoder's.
const CN = _internal.RUNTIMES?.["qoder-cn"]
const cnRuntime = (opts) => inSandbox(() => _internal.campaignRuntime({ arch: "x64", env: {}, opt: join(sandbox, "opt"), runtime: CN, ...opts }))
const fixture = (...parts) => {
  const file = join(sandbox, ...parts)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, "fixture")
  return file
}

test("Qoder CN: Linux finds /opt/Qoder-CN, never /opt/Qoder", async () => {
  fixture("opt", "Qoder", "resources", "umid", "runtime-info")
  await expect(cnRuntime({ home: sandbox, platform: "linux" })).rejects.toThrow("Qoder CN check-in: device identity runtime not found")
  const file = fixture("opt", "Qoder-CN", "resources", "umid", "runtime-info")
  expect(await cnRuntime({ home: sandbox, platform: "linux" })).toBe(file)
})

test("Qoder CN: macOS finds Qoder CN.app", async () => {
  fixture("Applications", "Qoder.app", "Contents", "Resources", "umid", "runtime-info")
  const file = fixture("Applications", "Qoder CN.app", "Contents", "Resources", "umid", "runtime-info")
  expect(await cnRuntime({ home: sandbox, platform: "darwin", arch: "arm64" })).toBe(file)
})

test("Qoder CN: Windows finds the Qoder CN desktop's runtime", async () => {
  fixture("Local", "Programs", "Qoder", "resources", "umid", "runtime-info.exe")
  const file = fixture("Local", "Programs", "Qoder CN", "resources", "umid", "runtime-info.exe")
  expect(await cnRuntime({ home: join(sandbox, "nobody"), platform: "win32", env: { LOCALAPPDATA: join(sandbox, "Local") } })).toBe(file)
})

test("Qoder CN: finds its CLI's cache in .qoder-cn and its QODERCN_ folders, never .qoder", async () => {
  cliCache(join(sandbox, ".qoder"), "linux", "x64")
  await expect(cnRuntime({ home: sandbox, platform: "linux" })).rejects.toThrow("QODERCN_RUNTIME_INFO")
  await expect(cnRuntime({ home: sandbox, platform: "linux", env: { QODER_CONFIG_DIR: join(sandbox, ".qoder") } })).rejects.toThrow("not found")
  const own = cliCache(join(sandbox, ".qoder-cn"), "linux", "x64")
  expect(await cnRuntime({ home: sandbox, platform: "linux" })).toBe(own)
  const dir = cliCache(join(sandbox, "custom"), "linux", "x64")
  expect(await cnRuntime({ home: join(sandbox, "nobody"), platform: "linux", env: { QODERCN_CONFIG_DIR: join(sandbox, "custom") } })).toBe(dir)
  const named = cliCache(join(sandbox, "clihome", ".qcn"), "linux", "x64")
  expect(await cnRuntime({ home: join(sandbox, "nobody"), platform: "linux", env: { QODERCN_CLI_HOME: join(sandbox, "clihome"), QODERCN_CONFIG_DIR_NAME: ".qcn" } })).toBe(named)
})

test("Qoder CN: QODERCN_RUNTIME_INFO names its runtime; QODER_RUNTIME_INFO is the international one's", async () => {
  const intl = fixture("intl", "runtime-info")
  await expect(cnRuntime({ home: sandbox, platform: "linux", env: { QODER_RUNTIME_INFO: intl } })).rejects.toThrow("not found")
  expect(await cnRuntime({ home: sandbox, platform: "linux", env: { QODERCN_RUNTIME_INFO: intl } })).toBe(intl)
})

test("no runtime anywhere says how to get one", async () => {
  await expect(inSandbox(() => _internal.campaignRuntime({ home: sandbox, platform: "linux", arch: "x64", env: {}, opt: join(sandbox, "opt") }))).rejects.toThrow("device identity runtime not found")
})

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
  delete process.env.QODERCN_RUNTIME_INFO
  const nowhere = spyOn(fsPromises, "stat").mockImplementation(() => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })))
  try {
    const p = await loader(QoderCNAuthPlugin, (u, init) => {
      expect(init.headers["Cosy-MachineToken"]).toBeUndefined()
      expect(init.headers["Cosy-MachineType"]).toBeUndefined()
      return json(u.pathname.endsWith("/claim") ? { status: "CLAIMED" } : LIST)
    })
    const url = "https://openapi.qoder.com.cn/sash/api/v1/me/campaigns"
    expect(await (await p.fetch(url)).json()).toEqual(LIST)
    expect((await (await p.fetch(url + "/c1/claim", { method: "POST", body: "{}" })).json()).status).toBe("CLAIMED")
    expect(reads).toHaveLength(0)
  } finally {
    nowhere.mockRestore()
  }
})

// #2911, plugins#304: Qoder CN's desktop (0.4.9) and CLI send Qoder CN's
// own runtime-info identity, environment 0, on its campaigns pages.
test("CN campaigns carry Qoder CN's own device identity, environment 0", async () => {
  const p = await loader(QoderCNAuthPlugin, (u, init) => {
    expect(init.headers["Cosy-MachineToken"]).toBe("sdk-token-u1")
    expect(init.headers["Cosy-MachineType"]).toBe(MACHINE_TYPE)
    return json(u.pathname.endsWith("/claim") ? { status: "CLAIMED" } : LIST)
  })
  const url = "https://openapi.qoder.com.cn/sash/api/v1/me/campaigns"
  expect(await (await p.fetch(url)).json()).toEqual(LIST)
  expect((await (await p.fetch(url + "/c1/claim", { method: "POST", body: "{}" })).json()).status).toBe("CLAIMED")
  expect(reads).toHaveLength(1)
  expect(reads[0].args).toEqual(process.platform === "linux" ? ["0"] : ["0", "--account-stdin"])
})

test("a PAT account checks in on its job token, having no device token", async () => {
  // a PAT sign-in keeps no device token; the campaigns pages take the job
  // token the exchange gave, as the usage endpoint does. A live Qoder CN PAT
  // account answered 200 to the list and CLAIMED to a claim.
  const p = await loader(
    QoderCNAuthPlugin,
    (u, init) => {
      if (u.pathname === "/sash/api/v1/me/campaigns") return json(LIST)
      if (u.pathname === "/sash/api/v1/me/campaigns/c1/claim") return json({ status: "CLAIMED" })
      return new Response("", { status: 404 })
    },
    { patAuth: true, pat: "pt-cn", deviceToken: "", deviceRefresh: "" },
  )
  const origin = "https://openapi.qoder.com.cn"
  const list = await p.fetch(origin + "/sash/api/v1/me/campaigns", { method: "GET" })
  expect(list.status).toBe(200)
  expect(await list.json()).toEqual(LIST)
  const claim = await p.fetch(origin + "/sash/api/v1/me/campaigns/c1/claim", { method: "POST", body: "{}" })
  expect(claim.status).toBe(200)
  expect((await claim.json()).status).toBe("CLAIMED")
  // the job token signs both calls, and no device-token refresh is asked for
  expect(p.seen).toEqual([
    { origin, path: "/sash/api/v1/me/campaigns", method: "GET", auth: "Bearer jt-one", body: undefined },
    { origin, path: "/sash/api/v1/me/campaigns/c1/claim", method: "POST", auth: "Bearer jt-one", body: "{}" },
  ])
  expect(p.seen.some((s) => s.path.includes("deviceToken"))).toBe(false)
})

test("a PAT account's refused check-in is the answer, with no second token to rotate", async () => {
  const p = await loader(
    QoderCNAuthPlugin,
    () => new Response("", { status: 401 }),
    { patAuth: true, pat: "pt-cn", deviceToken: "", deviceRefresh: "" },
  )
  const res = await p.fetch("https://openapi.qoder.com.cn/sash/api/v1/me/campaigns", { method: "GET" })
  expect(res.status).toBe(401)
  // nothing is rotated: the refresh call would fail with no device refresh
  expect(p.seen.map((s) => s.path)).toEqual(["/sash/api/v1/me/campaigns"])
  expect(p.auth().deviceToken).toBe("")
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
