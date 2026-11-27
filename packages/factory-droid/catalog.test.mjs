import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import plugin from "./opencode.mjs"

const variables = ["XDG_CACHE_HOME", "FACTORY_DROID_BIN", "FACTORY_HOME_OVERRIDE", "FACTORY_API_KEY", "FAKE_DROID_CATALOG"]
let saved, root, fixture, cache
beforeEach(() => {
  saved = Object.fromEntries(variables.map(k => [k, process.env[k]]))
  root = mkdtempSync(join(tmpdir(), "droid-catalog-test-"))
  fixture = join(root, "fixture.json")
  cache = join(root, "magpie", "factory-droid", "models")
  process.env.XDG_CACHE_HOME = root
  process.env.FACTORY_HOME_OVERRIDE = root
  process.env.FACTORY_DROID_BIN = fileURLToPath(new URL("./test/fake-droid.mjs", import.meta.url))
  process.env.FAKE_DROID_CATALOG = fixture
  delete process.env.FACTORY_API_KEY
  configure({})
})
afterEach(() => {
  for (const k of variables) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(root, { recursive: true, force: true })
})

const configure = data => writeFileSync(fixture, JSON.stringify(data))
const host = async () => (await plugin.server()).provider
const list = (p, key = "primary-secret", signal) => p.models({}, { auth: { type: "api", key }, signal })
const calls = () => readFileSync(fixture + ".calls", "utf8").trim().split("\n").length
const only = id => ({ models: [{ id, displayName: id, supportedReasoningEfforts: ["low"] }] })
const unavailable = { error: { code: -32603, message: "Temporary catalog failure" } }
const refused = { error: { code: -32000, message: "Authentication required" } }
function ageSnapshot(ms) {
  const file = join(cache, readdirSync(cache)[0])
  const data = JSON.parse(readFileSync(file, "utf8"))
  writeFileSync(file, JSON.stringify({ ...data, at: Date.now() - ms }))
}

test("cold callers share discovery and independent hosts reuse only their account's models", async () => {
  configure({ "primary-secret": { ...only("model-a"), delay: 1000 }, "other-secret": only("model-b") })
  const p = await host()
  const [a, same] = await Promise.all([list(p), list(p)])
  expect(Object.keys(a)).toEqual(["default", "model-a"])
  expect(same["model-a"].variants).toEqual({ low: { effort: "low" } })
  expect(calls()).toBe(1)
  const second = await host()
  expect(Object.keys(await list(second))).toEqual(Object.keys(a))
  expect(calls()).toBe(1)
  expect(Object.keys(await list(second, "other-secret"))).toEqual(["default", "model-b"])
  expect(calls()).toBe(2)
  expect(readdirSync(cache)).toHaveLength(2)
  for (const name of readdirSync(cache)) {
    expect(name).toMatch(/^[0-9a-f]{64}\.json$/)
    const file = join(cache, name)
    expect(readFileSync(file, "utf8")).not.toContain("secret")
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600)
  }
})

test("stale results survive a temporary failure, and a successful empty catalog removes old models", async () => {
  configure({ "primary-secret": only("formerly-enabled") })
  await list(await host())
  ageSnapshot(65_000)
  configure({ "primary-secret": unavailable })
  const offline = await host()
  expect((await list(offline))["formerly-enabled"]).toBeDefined()
  await offline.warming()
  expect((await list(offline))["formerly-enabled"]).toBeDefined()
  expect(calls()).toBe(2)
  configure({ "primary-secret": { models: [] } })
  const changed = await host()
  await list(changed)
  await changed.warming()
  const empty = await list(changed)
  expect(Object.keys(empty)).toEqual(["default"])
  expect(empty[Symbol.for("magpie.fellBack")]).toBeUndefined()
  expect(Object.keys(await list(await host()))).toEqual(["default"])
})

test("revoked credentials clear stale snapshots, while expired or corrupt snapshots cannot supply a list", async () => {
  configure({ "primary-secret": only("private-model") })
  await list(await host())
  ageSnapshot(70_000)
  configure({ "primary-secret": refused })
  const revoked = await host()
  await list(revoked)
  await revoked.warming()
  await expect(list(revoked)).rejects.toMatchObject({ status: 401 })
  expect(readdirSync(cache)).toEqual([])
  configure({ "primary-secret": only("replacement") })
  await list(await host())
  ageSnapshot(25 * 3600_000)
  configure({ "primary-secret": unavailable })
  await expect(list(await host())).rejects.toThrow("Temporary catalog failure")
  writeFileSync(join(cache, readdirSync(cache)[0]), "{")
  configure({ "primary-secret": only("recovered") })
  expect(Object.keys(await list(await host()))).toEqual(["default", "recovered"])
})

test("legacy discovery uses availableModels when the advertised extension is absent", async () => {
  const availableModels = [{ modelId: "legacy", name: "Legacy model" }, { modelId: "hidden", disabled: true }]
  configure({ local: { availableModels, error: { code: -32601, message: "Unknown method" } } })
  const p = await host()
  const rows = await p.models()
  expect(Object.keys(rows)).toEqual(["default", "legacy"])
  expect(rows.legacy.capabilities.attachment).toBe(false)
  expect(() => readdirSync(cache)).toThrow()
})

test("one caller's abort does not cancel another account or another waiter", async () => {
  configure({ "primary-secret": { ...only("a"), delay: 180 }, "other-secret": { ...only("b"), delay: 80 } })
  const p = await host(), ctl = new AbortController()
  const interrupted = list(p, "primary-secret", ctl.signal)
  const remaining = Promise.all([list(p), list(p, "other-secret")])
  setTimeout(() => ctl.abort(new Error("caller left")), 25)
  await expect(interrupted).rejects.toThrow("caller left")
  await p.warming()
  const [a, b] = await remaining
  expect(Object.keys(a)).toEqual(["default", "a"])
  expect(Object.keys(b)).toEqual(["default", "b"])
  expect(calls()).toBe(2)
})

test("a cold listing that exceeds the time budget marks its default as provisional", async () => {
  configure({ "primary-secret": { ...only("slow"), delay: 6250 } })
  const p = await host()
  const early = await list(p)
  expect(Object.keys(early)).toEqual(["default"])
  expect(early[Symbol.for("magpie.fellBack")]).toBe(true)
  await p.warming()
  expect(Object.keys(await list(p))).toEqual(["default", "slow"])
}, 12_000)

test("a changed local Droid login cannot reuse the previous catalog or completed receipt", async () => {
  const { mkdirSync } = await import("node:fs")
  const dir = join(root, ".factory")
  mkdirSync(dir)
  const stamp = join(dir, "auth.v2.file")
  writeFileSync(stamp, "first fixture")
  configure({ local: only("local-a") })
  const hooks = await plugin.server()
  const opts = await hooks.auth.loader(() => ({ type: "api", key: "factory-droid-local-login" }))
  const messages = [{ role: "user", content: "call report" }]
  const send = async () => {
    const r = await opts.fetch(opts.baseURL + "/messages", { body: JSON.stringify({
      model: "fake", tools: [{ name: "report", input_schema: { type: "object" } }], messages,
    }) })
    expect(r.status).toBe(200)
    return r.json()
  }
  expect(Object.keys(await hooks.provider.models())).toEqual(["default", "local-a"])
  const first = await send()
  messages.push({ role: "assistant", content: first.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: first.content[0].id, content: "receipt" }] })
  const prior = await send()
  expect(prior.content[0].text).toContain("MCP returned")
  expect((await send()).id).toBe(prior.id)

  writeFileSync(stamp, "replacement credential fixture")
  configure({ local: only("local-b") })
  expect(Object.keys(await hooks.provider.models())).toEqual(["default", "local-b"])
  const replay = await send()
  expect(replay.id).not.toBe(prior.id)
  expect(replay.content.at(-1).text).toContain('"tool_result":')
  expect(() => readdirSync(cache)).toThrow()
})

test("a local login with no visible credential marker reads the current list each time", async () => {
  const p = await host()
  configure({ local: only("one") })
  expect(Object.keys(await p.models())).toEqual(["default", "one"])
  configure({ local: only("two") })
  expect(Object.keys(await p.models())).toEqual(["default", "two"])
  expect(calls()).toBe(2)
})

test("config-only models can be listed, selected, and assigned their own reasoning setting", async () => {
  for (const picker of ["modern", "legacy-set", "ignored"]) {
    configure({ local: { legacy: true, picker, availableModels: [] } })
    const hooks = await plugin.server()
    const rows = await hooks.provider.models()
    expect(Object.keys(rows)).toEqual(["default", "fake"])
    expect(rows.fake.name).toBe("Picker model")
    const opts = await hooks.auth.loader(() => undefined)
    const r = await opts.fetch(opts.baseURL + "/messages", { body: JSON.stringify({
      model: "fake", messages: [{ role: "user", content: "check effort" }], output_config: { effort: "low" },
    }) })
    if (picker === "ignored") {
      expect(r.status).toBe(502)
      expect((await r.json()).error.message).toContain("did not apply the requested model")
    } else {
      expect(r.status).toBe(200)
      expect((await r.json()).content.at(-1).text).toContain("fake:")
    }
  }
})

test("an installed GenerateImage tool adds an image-only Magpie model after account discovery", async () => {
  const prior = process.env.FAKE_DROID_IMAGE
  try {
    process.env.FAKE_DROID_IMAGE = "1"
    configure({ local: only("chat") })
    const rows = await (await host()).models()
    expect(rows["droid-image"].capabilities.output).toEqual({ text: false, image: true })
    expect(rows["droid-image"].api.npm).toBe("@ai-sdk/openai-compatible")
  } finally {
    if (prior === undefined) delete process.env.FAKE_DROID_IMAGE
    else process.env.FAKE_DROID_IMAGE = prior
  }
})
