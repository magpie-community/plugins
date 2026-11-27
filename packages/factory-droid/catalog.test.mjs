import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import plugin from "./opencode.mjs"

const variables = ["XDG_CACHE_HOME", "FACTORY_DROID_BIN", "FACTORY_HOME_OVERRIDE", "FACTORY_API_KEY",
  "FAKE_DROID_CATALOG", "FAKE_DROID_IMAGE", "FAKE_DROID_LIST_TOOLS_DELAY", "FAKE_DROID_LIST_TOOLS_FAIL", "FAKE_DROID_PROBE_GATE"]
const hosts = new Set()
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
  for (const key of ["FACTORY_API_KEY", "FAKE_DROID_IMAGE", "FAKE_DROID_LIST_TOOLS_DELAY", "FAKE_DROID_LIST_TOOLS_FAIL", "FAKE_DROID_PROBE_GATE"]) delete process.env[key]
  configure({})
})
afterEach(async () => {
  if (process.env.FAKE_DROID_PROBE_GATE) writeFileSync(process.env.FAKE_DROID_PROBE_GATE, "")
  await Promise.all([...hosts].map(p => p.warming()))
  hosts.clear()
  for (const k of variables) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(root, { recursive: true, force: true })
})

const configure = data => writeFileSync(fixture, JSON.stringify(data))
async function host() {
  const { provider } = await plugin.server()
  hosts.add(provider)
  return provider
}
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

async function primeCache() {
  const p = await host()
  await list(p)
  await p.warming()
}

function holdImageProbe() {
  process.env.FAKE_DROID_IMAGE = "1"
  const gate = join(root, "release-probe")
  process.env.FAKE_DROID_PROBE_GATE = gate
  return gate
}

async function waitForFile(file) {
  const deadline = Date.now() + 4_000
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for " + file)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test("cold callers share discovery and independent hosts reuse only their account's models", async () => {
  configure({ "primary-secret": { ...only("model-a"), delay: 1000 }, "other-secret": only("model-b") })
  const p = await host()
  const [a, same] = await Promise.all([list(p), list(p)])
  expect(Object.keys(a)).toEqual(["default", "model-a"])
  expect(same["model-a"].variants).toEqual({ low: { effort: "low" } })
  expect(calls()).toBe(1)
  await p.warming()
  const second = await host()
  expect(Object.keys(await list(second))).toEqual(Object.keys(a))
  expect(calls()).toBe(1)
  expect(Object.keys(await list(second, "other-secret"))).toEqual(["default", "model-b"])
  expect(calls()).toBe(2)
  await second.warming()
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
  await primeCache()
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
  await primeCache()
  ageSnapshot(70_000)
  configure({ "primary-secret": refused })
  const revoked = await host()
  await list(revoked)
  await revoked.warming()
  await expect(list(revoked)).rejects.toMatchObject({ status: 401 })
  expect(readdirSync(cache)).toEqual([])
  configure({ "primary-secret": only("replacement") })
  await primeCache()
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
  process.env.FAKE_DROID_IMAGE = "1"
  configure({ "primary-secret": only("chat") })
  const p = await host()
  await list(p)
  await p.warming()
  const image = (await list(p))["droid-image"]
  expect(image.capabilities.output).toEqual({ text: false, image: true })
  expect(image.api.npm).toBe("@ai-sdk/openai-compatible")
})

test("the image probe can take longer than three seconds without delaying the chat list", async () => {
  process.env.FAKE_DROID_IMAGE = "1"
  process.env.FAKE_DROID_LIST_TOOLS_DELAY = "3500"
  configure({ "primary-secret": only("chat") })
  const p = await host()
  expect(Object.keys(await list(p))).toEqual(["default", "chat"])
  await p.warming()
  expect(Object.keys(await list(p))).toEqual(["default", "chat", "droid-image"])
}, 15_000)

test("the first chat list preserves Magpie's previous image pick until discovery finishes", async () => {
  const gate = holdImageProbe()
  configure({ "primary-secret": only("chat") })
  const p = await host()
  const previous = { models: { "droid-image": { id: "droid-image" } } }
  const ctx = { auth: { type: "api", key: "primary-secret" } }
  // Magpie keeps its last complete list when the hook returns magpie.fellBack.
  // An unreleased probe must not make either cold caller wait for the six-second deadline.
  const callers = [p.models(previous, ctx), p.models(previous, ctx)]
  const [first, second] = await Promise.all(callers)
  expect(Object.keys(first)).toEqual(["default", "chat"])
  expect(second).toBe(first)
  expect(first[Symbol.for("magpie.fellBack")]).toBe(true)
  const displayed = first[Symbol.for("magpie.fellBack")] ? previous.models : first
  expect(displayed["droid-image"]).toBe(previous.models["droid-image"])
  expect(existsSync(cache)).toBe(false)
  const warming = p.warming()
  expect(warming).toBeInstanceOf(Promise)
  writeFileSync(gate, "")
  await warming
  const complete = await p.models(previous, ctx)
  expect(complete[Symbol.for("magpie.fellBack")]).toBeUndefined()
  expect(complete["droid-image"].capabilities.output.image).toBe(true)
}, 5_000)

test("local lookups without a credential marker read their own chat and image capabilities", async () => {
  const gate = holdImageProbe(), p = await host()
  configure({ local: only("first-login") })
  const early = await p.models()
  expect(Object.keys(early)).toEqual(["default", "first-login"])
  expect(early[Symbol.for("magpie.fellBack")]).toBe(true)
  const warming = p.warming()
  expect(warming).toBeInstanceOf(Promise)
  writeFileSync(gate, "")
  await warming

  configure({ local: only("next-login") })
  delete process.env.FAKE_DROID_IMAGE
  const next = await p.models()
  expect(Object.keys(next)).toEqual(["default", "next-login"])
  expect(next[Symbol.for("magpie.fellBack")]).toBeUndefined()
  expect(calls()).toBe(2)
  expect(existsSync(cache)).toBe(false)
}, 5_000)

test("a host that checks warming after the probe finishes still reloads the list", async () => {
  const gate = holdImageProbe(), p = await host()
  configure({ "primary-secret": only("chat") })
  expect((await list(p))[Symbol.for("magpie.fellBack")]).toBe(true)
  writeFileSync(gate, "")
  // Saving the complete catalog happens before the host consults warming().
  await waitForFile(cache)
  expect(p.warming()).toBeInstanceOf(Promise)
  expect((await list(p))["droid-image"].capabilities.output.image).toBe(true)
  expect(p.warming()).toBeUndefined()
})

test("a refresh keeps the complete catalog while the image probe is waiting", async () => {
  process.env.FAKE_DROID_IMAGE = "1"
  configure({ "primary-secret": only("old-chat") })
  await primeCache()
  ageSnapshot(65_000)
  const file = join(cache, readdirSync(cache)[0])
  const onDisk = readFileSync(file, "utf8")
  const gate = holdImageProbe()
  configure({ "primary-secret": { ...only("new-chat"), observeClose: true } })
  const p = await host()
  const previous = await list(p)
  expect(Object.keys(previous)).toEqual(["default", "old-chat", "droid-image"])
  // The ACP process exits after the catalog request. The image process still needs our release.
  await waitForFile(gate + ".catalog-closed")
  expect(await list(p)).toBe(previous)
  expect(readFileSync(file, "utf8")).toBe(onDisk)
  writeFileSync(gate, "")
  await p.warming()
  expect(Object.keys(await list(p))).toEqual(["default", "new-chat", "droid-image"])
})

test("an inconclusive image probe preserves the previous complete catalog", async () => {
  process.env.FAKE_DROID_IMAGE = "1"
  configure({ "primary-secret": only("chat") })
  await primeCache()
  ageSnapshot(65_000)
  const file = join(cache, readdirSync(cache)[0])
  const onDisk = readFileSync(file, "utf8")
  process.env.FAKE_DROID_LIST_TOOLS_FAIL = "1"
  const p = await host()
  await list(p)
  await p.warming()
  expect((await list(p))["droid-image"]).toBeDefined()
  expect(readFileSync(file, "utf8")).toBe(onDisk)
  const cold = await host()
  await list(cold, "uncached")
  await cold.warming()
  expect((await list(cold, "uncached"))[Symbol.for("magpie.fellBack")]).toBe(true)
  expect(readdirSync(cache)).toHaveLength(1)
})

for (const outcome of ["refused", "empty", "legacy"]) {
  test(`the image probe exits when the model list is ${outcome}`, async () => {
    const gate = holdImageProbe(), p = await host()
    const legacy = { error: { code: -32601, message: "Unknown method" }, availableModels: [{ modelId: "legacy" }] }
    configure({ "primary-secret": { refused, empty: { models: [] }, legacy }[outcome] })
    if (outcome === "refused") await expect(list(p)).rejects.toMatchObject({ status: 401 })
    else {
      const models = await list(p)
      expect(Object.keys(models)).toEqual(outcome === "empty" ? ["default"] : ["default", "legacy"])
      expect(models[Symbol.for("magpie.fellBack")]).toBeUndefined()
    }
    await p.warming()
    const pid = Number(readFileSync(gate + ".pid", "utf8"))
    expect(() => process.kill(pid, 0)).toThrow()
  })
}
