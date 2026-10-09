import { afterEach, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:net"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { StrataPlugin } from "./index.mjs"
import { authHost } from "./auth-fixture.mjs"

const python = process.env.STRATA_TEST_PYTHON
const installed = process.env.STRATA_TEST_ROOT
const cases = []
const lifecycleTest = test.skipIf(process.platform !== "win32" || !python || !installed)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(check, budget = 8000) {
  const end = Date.now() + budget
  while (Date.now() < end) {
    if (await check()) return
    await sleep(50)
  }
  throw new Error("fixture condition timed out")
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
function cleanupManager(record) {
  return spawnSync(join(dirname(python), "pythonw.exe"), ["-B", join(import.meta.dir, "cleanup-fixture.py")], {
    windowsHide: true, input: JSON.stringify(record), encoding: "utf8", timeout: 7000,
  })
}
async function port() {
  const s = createServer()
  await new Promise((r) => s.listen(0, "127.0.0.1", r))
  const p = s.address().port
  await new Promise((r) => s.close(r))
  return p
}
async function setup(options = {}) {
  if (!python || !installed) throw new Error("Set STRATA_TEST_PYTHON and STRATA_TEST_ROOT to an existing Strata environment")
  const directory = mkdtempSync(join(process.env.TEMP, "strata-life-"))
  const root = join(directory, "installation")
  mkdirSync(join(root, "serve"), { recursive: true })
  copyFileSync(join(import.meta.dir, "fake-server.py"), join(root, "serve", "server.py"))
  copyFileSync(join(installed, "serve", "winjob.py"), join(root, "serve", "winjob.py"))
  const config = join(root, "fixture.json")
  writeFileSync(config, JSON.stringify(options))
  const gatewayPort = await port()
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ port: gatewayPort }))
  const gateway = spawn(python, ["-B", join(import.meta.dir, "fake-gateway.py"), String(gatewayPort), options.gatewayName ?? "magpie", join(directory, "gateway.json")],
    { windowsHide: true, stdio: "ignore", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } })
  await until(async () => {
    try { await fetch("http://127.0.0.1:" + gatewayPort, { signal: AbortSignal.timeout(200) }); return true } catch { return false }
  })
  const servicePort = await port()
  const base = "http://127.0.0.1:" + servicePort
  const inputs = { root, python, config, model: "fixture-model", baseURL: base + "/v1", environment: "{}" }
  const host = authHost(directory)
  const client = host.client
  const c = { directory, root, config, gateway, base, inputs, client,
    state: () => {
      const f = join(directory, "strata", "127.0.0.1-" + servicePort, "state.json")
      return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined
    },
    getAuth: host.getAuth,
    gatewayPid: () => JSON.parse(readFileSync(join(directory, "gateway.json"), "utf8")).pid,
    login: (inputs, plugin = c.plugin, fail = false) => host.login(plugin, inputs, fail),
    hooks: async () => StrataPlugin({ directory, client }),
    events: async () => {
      const events = await (await fetch(base + "/events")).json()
      c.child = events.child
      return events
    },
  }
  cases.push(c)
  c.plugin = await c.hooks()
  await c.login(inputs)
  c.loader = await c.plugin.auth.loader(c.getAuth)
  c.request = (init = {}) => c.loader.fetch(base + "/v1/chat/completions", {
    method: "POST", headers: { "X-Test": "kept" }, body: '{"model":"fixture-model","messages":[]}', ...init,
  })
  return c
}
afterEach(async () => {
  for (const c of cases.splice(0)) {
    c.gateway.kill()
    const state = c.state()
    const manager = state?.manager
    if (manager) {
      const result = cleanupManager(manager)
      if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || "Fixture cleanup failed")
    }
    await until(() => [state?.service?.pid, state?.listener?.pid, c.child].filter(Boolean).every((pid) => !alive(pid)), 5000)
    expect(c.directory.startsWith(process.env.TEMP + "\\strata-life-")).toBe(true)
    rmSync(c.directory, { recursive: true, force: true })
  }
}, 15000)

lifecycleTest("A02/A03/A07/A17/A19: concurrent first requests share one silent startup, then the gateway exit cleans the tree", async () => {
  const c = await setup({ delay: 0.5 })
  const replies = await Promise.all(Array.from({ length: 4 }, () => c.request().then((r) => r.json())))
  expect(replies.map((r) => r.answer)).toEqual(Array(4).fill("fixture answer"))
  const events = await c.events()
  expect(events.console).toBe(false)
  expect(c.state().console).toBe(false)
  expect(events.requests.length).toBe(4)
  expect(new Set(replies.map((r) => r.pid)).size).toBe(1)
  expect(readFileSync(join(c.root, "starts.jsonl"), "utf8").trim().split("\n").length).toBe(1)
  c.gateway.kill()
  await until(() => !alive(events.pid) && !alive(events.child) && !alive(c.state().manager.pid))
}, 15000)


lifecycleTest("A15: startup failure is reported, and a later request retries after the cause is fixed", async () => {
  const c = await setup({ fail: true })
  await expect(c.request()).rejects.toThrow("Strata")
  writeFileSync(c.config, "{}")
  const response = await c.request()
  expect((await response.json()).answer).toBe("fixture answer")
}, 15000)


lifecycleTest("A05/A09/A13: reopening and saving stop reconnects the retained instance without any new inference", async () => {
  const c = await setup()
  await c.request()
  const before = await c.events()
  await c.login({ ...c.inputs, autoStop: "no" })
  await sleep(500)
  c.gateway.kill()
  await sleep(500)
  expect((await c.events()).pid).toBe(before.pid)
  expect(alive(c.state().manager.pid)).toBe(true)
  const newPort = await port()
  writeFileSync(join(c.directory, "settings.json"), JSON.stringify({ port: newPort }))
  c.gateway = spawn(python, ["-B", join(import.meta.dir, "fake-gateway.py"), String(newPort), "magpie", join(c.directory, "gateway.json")],
    { windowsHide: true, stdio: "ignore" })
  await until(async () => { try { await fetch("http://127.0.0.1:" + newPort); return true } catch { return false } })
  const newHost = await c.hooks()
  await newHost.auth.loader(c.getAuth)
  await expect(c.login({ ...c.inputs, autoStop: "yes" }, newHost, true)).rejects.toThrow("save denied")
  await sleep(350)
  expect(c.state().autoStop).toBe(false)
  expect(c.state().gateway.pid).not.toBe(c.gatewayPid())
  expect((await c.events()).pid).toBe(before.pid)
  await c.login({ ...c.inputs, autoStop: "yes" }, newHost)
  await until(() => c.state()?.gateway?.pid === c.gatewayPid() && c.state()?.autoStop === true)
  expect((await c.events()).requests.length).toBe(1)
  expect((await c.events()).pid).toBe(before.pid)
  expect(alive(c.state().manager.pid)).toBe(true)
  c.gateway.kill()
  await until(() => !alive(before.pid) && !alive(before.child) && !alive(c.state().manager.pid))
}, 15000)
lifecycleTest("A08: gateway exit stops an in-flight generation without waiting for its 30-second answer", async () => {
  const c = await setup({ busy: true })
  const pending = c.request().catch((e) => e)
  await until(async () => { try { return (await c.events()).requests.length === 1 } catch { return false } })
  const before = await c.events()
  c.gateway.kill()
  await until(() => !alive(before.pid) && !alive(before.child) && !alive(c.state().manager.pid), 5000)
  expect(await pending).toBeInstanceOf(Error)
}, 15000)
lifecycleTest("A16: cancelling one startup waiter does not cancel another or send the cancelled generation", async () => {
  const c = await setup({ delay: 0.8 })
  const controller = new AbortController()
  const cancelled = c.request({ signal: controller.signal }).catch((e) => e)
  const other = c.request()
  await sleep(100)
  controller.abort(new Error("waiter cancelled"))
  expect((await cancelled).message).toBe("waiter cancelled")
  expect((await (await other).json()).answer).toBe("fixture answer")
  expect((await c.events()).requests.length).toBe(1)
}, 15000)

function requestFromHost(c, module = join(import.meta.dir, "index.mjs")) {
  const child = spawn(process.execPath, [join(import.meta.dir, "host-client.mjs"), module, c.directory, c.base],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: process.env })
  return new Promise((resolve, reject) => {
    let text = "", error = ""
    child.stdout.on("data", (part) => { text += part })
    child.stderr.on("data", (part) => { error += part })
    child.on("error", reject)
    child.on("exit", (code) => code === 0 ? resolve(JSON.parse(text)) : reject(new Error(error)))
  })
}
lifecycleTest("A03/A10/A14/A17: independent plugin hosts share one startup and their exit does not stop the real gateway's instance", async () => {
  const c = await setup({ delay: 0.8 })
  const answers = await Promise.all(Array.from({ length: 4 }, () => requestFromHost(c)))
  expect(new Set(answers.map((a) => a.pid)).size).toBe(1)
  const before = await c.events()
  await sleep(400)
  expect((await c.events()).pid).toBe(before.pid)
  expect(readFileSync(join(c.root, "starts.jsonl"), "utf8").trim().split("\n").length).toBe(1)
  expect(c.state().gateway.pid).toBe(c.gatewayPid())
  const manager = c.state().manager
  const helper = join(c.directory, "strata", "127.0.0.1-" + new URL(c.base).port, "manager.py")
  rmSync(helper)
  await Promise.all(Array.from({ length: 4 }, () => requestFromHost(c)))
  expect(existsSync(helper)).toBe(false)
  expect(c.state().manager).toEqual(manager)
  expect((await c.events()).requests.length).toBe(8)
}, 15000)
lifecycleTest("A11/A12: removal of an isolated installed plugin leaves its manager responsible until actual gateway exit", async () => {
  const c = await setup()
  const packageDir = join(c.directory, "installed-plugin")
  mkdirSync(packageDir)
  for (const name of ["index.mjs", "manager.py"]) copyFileSync(join(import.meta.dir, name), join(packageDir, name))
  await requestFromHost(c, join(packageDir, "index.mjs"))
  const before = await c.events()
  expect(packageDir.startsWith(c.directory + "\\")).toBe(true)
  rmSync(packageDir, { recursive: true })
  await sleep(400)
  expect((await c.events()).pid).toBe(before.pid)
  c.gateway.kill()
  await until(() => !alive(before.pid) && !alive(before.child) && !alive(c.state().manager.pid))
}, 15000)


lifecycleTest("A04: an instance started outside the plugin stays running when the gateway exits", async () => {
  const c = await setup()
  const service = spawn(python, ["-B", "-m", "serve.server", "--engine", "strata", "--config", c.config,
    "--host", "127.0.0.1", "--port", new URL(c.base).port],
    { cwd: c.root, windowsHide: true, stdio: "ignore", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } })
  let events
  try {
    await until(async () => { try { events = await c.events(); return true } catch { return false } })
    const response = await c.request()
    expect((await response.json()).pid).toBe(events.pid)
    expect(c.state()).toBeUndefined()
    c.gateway.kill()
    await sleep(400)
    expect((await c.events()).pid).toBe(events.pid)
  } finally {
    service.kill()
    if (events) await until(() => !alive(events.pid) && !alive(events.child))
  }
}, 15000)
lifecycleTest("A18: a stopped service is not restarted until the next real request", async () => {
  const c = await setup()
  await c.request()
  const first = await c.events()
  await fetch(c.base + "/crash").catch(() => {})
  await until(() => !alive(first.pid) && !alive(first.child) && !alive(c.state().manager.pid))
  await sleep(400)
  expect(readFileSync(join(c.root, "starts.jsonl"), "utf8").trim().split("\n").length).toBe(1)
  const second = await (await c.request()).json()
  expect(second.answer).toBe("fixture answer")
  expect(second.pid).not.toBe(first.pid)
}, 15000)


lifecycleTest("A15/A16: Strata's inference error is returned unchanged without restarting or replaying", async () => {
  const c = await setup({ status: 503 })
  const response = await c.request()
  expect(response.status).toBe(503)
  expect((await response.json()).answer).toBe("fixture answer")
  expect((await c.events()).requests.length).toBe(1)
}, 15000)


lifecycleTest("A09: the keep option also preserves a service when its gateway exits during startup", async () => {
  const c = await setup({ delay: 0.8 })
  await c.login({ ...c.inputs, autoStop: "no" })
  const pending = c.request().catch((e) => e)
  await until(() => !!c.state()?.service)
  c.gateway.kill()
  const reply = await pending
  expect(reply).toBeInstanceOf(Response)
  expect((await reply.json()).answer).toBe("fixture answer")
  expect(alive(c.state().manager.pid)).toBe(true)
}, 15000)


lifecycleTest("A05: a failed configuration save does not change the running instance's last successful exit option", async () => {
  const c = await setup()
  await c.request()
  const events = await c.events()
  await expect(c.login({ ...c.inputs, autoStop: "no" }, c.plugin, true)).rejects.toThrow("save denied")
  c.gateway.kill()
  await until(() => !alive(events.pid) && !alive(events.child) && !alive(c.state().manager.pid))
}, 15000)

lifecycleTest("A17: forced fixture cleanup rejects a stale identity and stops only its owned manager", async () => {
  const c = await setup()
  await c.request()
  const record = c.state().manager
  const events = await c.events()
  const rejected = cleanupManager({ ...record, created: "0" })
  expect(rejected.status).not.toBe(0)
  expect(rejected.stderr).toContain("identity changed")
  expect(alive(record.pid)).toBe(true)
  expect(cleanupManager(record).status).toBe(0)
  await until(() => !alive(events.pid) && !alive(events.child))
}, 15000)


lifecycleTest("A05/A09: stale loaders, missing/corrupt auth and invalid or foreign policies preserve the last confirmed keep option", async () => {
  const c = await setup()
  await c.request()
  const old = await c.getAuth()
  await c.login({ ...c.inputs, autoStop: "no" })
  await until(() => c.state()?.autoStop === false)
  const stale = await c.plugin.auth.loader(async () => old)
  await stale.fetch(c.base + "/v1/chat/completions", { method: "POST", body: "{}" })
  const file = join(c.directory, "plugin-auth.json")
  const saved = readFileSync(file, "utf8")
  try {
    rmSync(file)
    await sleep(350)
    expect(c.state().autoStop).toBe(false)
    writeFileSync(file, "{")
    await sleep(350)
    expect(c.state().autoStop).toBe(false)
    writeFileSync(file, JSON.stringify({ strata: { ...old, metadata: { ...old.metadata, autoStop: "true" } },
      "strata#foreign": { ...old, metadata: { ...old.metadata, baseURL: "http://127.0.0.1:1/v1", autoStop: true } },
      "strata#invalid-url": { ...old, metadata: { ...old.metadata, baseURL: {}, autoStop: true } } }))
    await sleep(350)
    expect(c.state().autoStop).toBe(false)
    c.gateway.kill()
    await sleep(400)
    expect((await c.events()).pid).toBe(c.state().listener.pid)
    expect(alive(c.state().manager.pid)).toBe(true)
  } finally { writeFileSync(file, saved) }
}, 15000)

lifecycleTest("A15: a gateway HTTP identity mismatch starts no Strata and preserves the unrelated listener", async () => {
  const c = await setup({ gatewayName: "another-service" })
  await expect(c.request()).rejects.toThrow("identify as Magpie")
  expect(alive(c.gateway.pid)).toBe(true)
  expect(existsSync(join(c.root, "starts.jsonl"))).toBe(false)
}, 15000)

lifecycleTest("A18: a stopped state with its mutex still held is waited out before a request starts a new manager", async () => {
  const c = await setup()
  const dir = join(c.directory, "strata", "127.0.0.1-" + new URL(c.base).port)
  mkdirSync(dir, { recursive: true })
  const holder = spawn(join(dirname(python), "pythonw.exe"), ["-B", join(import.meta.dir, "mutex-fixture.py"), dir,
    new URL(c.base).port], { windowsHide: true, stdio: "ignore" })
  try {
    await until(() => c.state()?.status === "stopped")
    expect((await (await c.request()).json()).answer).toBe("fixture answer")
    expect(c.state().manager.pid).not.toBe(holder.pid)
  } finally { holder.kill() }
}, 15000)


lifecycleTest("A05/A09: runtime state write failures retain the service and manager, then recover the saved keep option", async () => {
  const c = await setup()
  await c.request()
  const before = await c.events()
  const dir = join(c.directory, "strata", "127.0.0.1-" + new URL(c.base).port)
  const file = join(dir, "state.json")
  const manager = c.state().manager
  chmodSync(file, 0o444)
  try {
    await c.login({ ...c.inputs, autoStop: "no" })
    await until(() => readFileSync(join(dir, "manager.log"), "utf8").includes("state write failed"))
    expect((await c.events()).pid).toBe(before.pid)
    expect(alive(manager.pid)).toBe(true)
    expect(alive(c.gateway.pid)).toBe(true)
    expect(c.state().autoStop).toBe(true)
  } finally { chmodSync(file, 0o666) }
  await until(() => c.state()?.autoStop === false)
  expect(c.state().manager).toEqual(manager)
  c.gateway.kill()
  await sleep(400)
  expect((await c.events()).pid).toBe(before.pid)
  expect(alive(manager.pid)).toBe(true)
}, 15000)

lifecycleTest("A15: a startup ownership write failure creates no service, and retry after restoring writes works", async () => {
  const c = await setup()
  const dir = join(c.directory, "strata", "127.0.0.1-" + new URL(c.base).port)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, "state.json")
  writeFileSync(file, JSON.stringify({ status: "stopped" }))
  chmodSync(file, 0o444)
  try {
    await expect(c.request()).rejects.toThrow("manager exited")
    expect(existsSync(join(c.root, "starts.jsonl"))).toBe(false)
  } finally { chmodSync(file, 0o666) }
  expect((await (await c.request()).json()).answer).toBe("fixture answer")
}, 15000)


lifecycleTest("A05/A09/A13: a saved keep option survives unconfirmed gateway association and unreadable auth until an actual request reconnects", async () => {
  const c = await setup()
  await c.request()
  const before = await c.events()
  const unavailablePort = await port()
  writeFileSync(join(c.directory, "settings.json"), JSON.stringify({ port: unavailablePort }))
  await c.login({ ...c.inputs, autoStop: "no" })
  await until(() => c.state()?.autoStop === false && c.state()?.status === "uncertain")
  const file = join(c.directory, "plugin-auth.json")
  const saved = readFileSync(file, "utf8")
  try {
    rmSync(file)
    c.gateway.kill()
    const newPort = await port()
    writeFileSync(join(c.directory, "settings.json"), JSON.stringify({ port: newPort }))
    c.gateway = spawn(python, ["-B", join(import.meta.dir, "fake-gateway.py"), String(newPort), "magpie",
      join(c.directory, "gateway.json")], { windowsHide: true, stdio: "ignore" })
    await until(async () => { try { await fetch("http://127.0.0.1:" + newPort); return true } catch { return false } })
    expect((await (await c.request()).json()).pid).toBe(before.pid)
    await until(() => c.state()?.gateway?.pid === c.gatewayPid() && c.state()?.status === "ready")
    expect(c.state().autoStop).toBe(false)
    c.gateway.kill()
    await sleep(400)
    expect((await c.events()).pid).toBe(before.pid)
    expect(alive(c.state().manager.pid)).toBe(true)
  } finally { writeFileSync(file, saved) }
}, 15000)


lifecycleTest("A03: a candidate exits promptly while the startup mutex is held and no state has been published", async () => {
  const c = await setup()
  const dir = join(c.directory, "strata", "127.0.0.1-" + new URL(c.base).port)
  mkdirSync(dir, { recursive: true })
  const holder = spawn(join(dirname(python), "pythonw.exe"), ["-B", join(import.meta.dir, "mutex-fixture.py"), dir,
    new URL(c.base).port, "unpublished"], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] })
  let owner
  try {
    await until(() => existsSync(join(dir, "held.json")))
    owner = JSON.parse(readFileSync(join(dir, "held.json"), "utf8"))
    const candidate = spawnSync(join(dirname(python), "pythonw.exe"), ["-B", join(import.meta.dir, "manager.py"), dir], {
      windowsHide: true, input: JSON.stringify({ baseURL: c.inputs.baseURL }), encoding: "utf8", timeout: 2000,
    })
    expect(candidate.error).toBeUndefined()
    expect(candidate.status).toBe(0)
    expect(existsSync(join(dir, "state.json"))).toBe(false)
    expect(alive(owner.pid)).toBe(true)
  } finally {
    holder.stdin.end()
    await until(() => !alive(holder.pid) && (!owner || !alive(owner.pid)))
  }
}, 15000)
