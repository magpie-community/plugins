import { afterEach, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { StrataPlugin } from "./index.mjs"

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
  const gateway = spawn(python, ["-B", join(import.meta.dir, "fake-gateway.py"), String(gatewayPort)],
    { windowsHide: true, stdio: "ignore", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } })
  await until(async () => {
    try { await fetch("http://127.0.0.1:" + gatewayPort, { signal: AbortSignal.timeout(200) }); return true } catch { return false }
  })
  const servicePort = await port()
  const base = "http://127.0.0.1:" + servicePort
  const inputs = { root, python, config, model: "fixture-model", baseURL: base + "/v1", environment: "{}" }
  let auth
  const client = { auth: { set: async ({ body }) => {
    auth = body
    writeFileSync(join(directory, "plugin-auth.json"), JSON.stringify({ strata: body }))
    return { data: true }
  } }, app: { log: async () => {} } }
  const c = { directory, root, config, gateway, base, inputs, client,
    state: () => {
      const f = join(directory, "strata", "127.0.0.1-" + servicePort, "state.json")
      return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined
    },
    getAuth: async () => auth,
    hooks: async () => StrataPlugin({ directory, client }),
    events: async () => (await fetch(base + "/events")).json(),
  }
  cases.push(c)
  c.plugin = await c.hooks()
  await c.plugin.auth.methods[0].authorize(inputs)
  c.loader = await c.plugin.auth.loader(c.getAuth)
  c.request = (init = {}) => c.loader.fetch(base + "/v1/chat/completions", {
    method: "POST", headers: { "X-Test": "kept" }, body: '{"model":"fixture-model","messages":[]}', ...init,
  })
  return c
}
afterEach(async () => {
  for (const c of cases.splice(0)) {
    await c.plugin.auth.methods[0].authorize({ ...c.inputs, autoStop: "yes" })
    c.gateway.kill()
    await until(() => !c.state()?.manager || !alive(c.state().manager.pid), 10000)
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


lifecycleTest("A05/A09/A13: a saved keep option applies without another inference, then a new gateway adopts the same managed instance", async () => {
  const c = await setup()
  await c.request()
  const before = await c.events()
  await c.plugin.auth.methods[0].authorize({ ...c.inputs, autoStop: "no" })
  await sleep(500)
  c.gateway.kill()
  await sleep(500)
  expect((await c.events()).pid).toBe(before.pid)
  expect(alive(c.state().manager.pid)).toBe(true)
  const newPort = await port()
  writeFileSync(join(c.directory, "settings.json"), JSON.stringify({ port: newPort }))
  c.gateway = spawn(python, ["-B", join(import.meta.dir, "fake-gateway.py"), String(newPort)],
    { windowsHide: true, stdio: "ignore" })
  await until(async () => { try { await fetch("http://127.0.0.1:" + newPort); return true } catch { return false } })
  const newHost = await c.hooks()
  await newHost.auth.loader(c.getAuth)
  await newHost.auth.methods[0].authorize({ ...c.inputs, autoStop: "yes" })
  const actual = await (await fetch("http://127.0.0.1:" + newPort)).json()
  await until(() => c.state()?.gateway?.pid === actual.pid)
  expect((await c.events()).requests.length).toBe(1)
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
  const actual = await (await fetch("http://127.0.0.1:" + JSON.parse(readFileSync(join(c.directory, "settings.json"), "utf8")).port)).json()
  expect(c.state().gateway.pid).toBe(actual.pid)
  await requestFromHost(c)
  expect((await c.events()).requests.length).toBe(5)
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
  await c.plugin.auth.methods[0].authorize({ ...c.inputs, autoStop: "no" })
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
  const failedHost = await StrataPlugin({ directory: c.directory, client: {
    auth: { set: async () => { throw new Error("save denied") } }, app: { log: async () => {} },
  } })
  await expect(failedHost.auth.methods[0].authorize({ ...c.inputs, autoStop: "no" })).rejects.toThrow("save denied")
  c.gateway.kill()
  await until(() => !alive(events.pid) && !alive(events.child) && !alive(c.state().manager.pid))
}, 15000)
