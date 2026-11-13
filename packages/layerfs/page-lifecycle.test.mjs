import { afterAll, expect, test } from "bun:test"
import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

const ownTestRoot = await mkdtemp(join(tmpdir(), "layerfs-page-lifecycle-"))
const target = process.env.LAYERFS_TEST_INDEX || join(import.meta.dir, "index.mjs")

afterAll(async () => {
  const absolute = resolve(ownTestRoot)
  assert.ok(absolute.startsWith(resolve(tmpdir()) + sep), "cleanup stays inside the test root")
  await rm(absolute, { recursive: true, force: true })
}, 120_000)

async function until(action, message, timeout = 9000) {
  const end = Date.now() + timeout
  let last
  do {
    try {
      last = await action()
      if (last) return last
    } catch {}
    await delay(50)
  } while (Date.now() < end)
  assert.fail(`${message}; last=${JSON.stringify(last)}`)
}

async function request(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: "/" }, (response) => {
      let body = ""
      response.setEncoding("utf8").on("data", (chunk) => { body += chunk })
      response.on("end", () => resolve(response.statusCode === 200 && body.includes("fixture")))
    })
    req.setTimeout(250, () => req.destroy())
    req.on("error", () => resolve(false))
  })
}

async function fixture({ block = false, holdTrajectory = false } = {}) {
  const folder = await mkdtemp(join(ownTestRoot, "case-"))
  const home = join(folder, "home")
  const source = join(folder, "source")
  await mkdir(home)
  await mkdir(source)
  await writeFile(join(source, "hello.txt"), "fixture content\n")
  const blocker = http.createServer((_, response) => response.writeHead(503).end())
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve))
  const port = blocker.address().port
  if (!block) await new Promise((resolve) => blocker.close(resolve))
  const store = join(home, "store")
  const child = fork(fileURLToPath(new URL("./fixtures/page-lifecycle.mjs", import.meta.url)), [], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      MAGPIE_LAYERFS_HOME: store,
      MAGPIE_LAYERFS_BACKEND: "sim",
      MAGPIE_LAYERFS_NATIVE: "",
      LAYERFS_TEST_INDEX: target,
      LAYERFS_TEST_PORT: String(port),
      LAYERFS_TEST_SOURCE: source,
      LAYERFS_TEST_HOLD_TRAJECTORY: holdTrajectory ? "1" : "",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  let errorOutput = ""
  child.stderr.on("data", (chunk) => { errorOutput += chunk })
  const pending = new Map()
  let readyResolve
  const ready = new Promise((resolve) => { readyResolve = resolve })
  child.on("message", (message) => {
    if (message.ready) readyResolve(message)
    else pending.get(message.id)?.(message)
  })
  let nextId = 0
  const rpc = async (method) => {
    const id = ++nextId
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`test RPC timed out: ${method}; ${errorOutput}`)), 5000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        pending.delete(id)
        resolve(message)
      })
      child.send({ id, method })
    })
    if (response.error) throw new Error(response.error)
    return response
  }
  const cleanup = async () => {
    if (blocker.listening) await new Promise((resolve) => blocker.close(resolve))
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve))
      child.kill()
      await exited
    }
    const absolute = resolve(folder)
    assert.ok(absolute.startsWith(resolve(ownTestRoot) + sep), "cleanup stays inside the fixture")
    await rm(absolute, { recursive: true, force: true })
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child failed to initialize: ${errorOutput}`)), 5000)
      ready.then((message) => { clearTimeout(timer); resolve(message) })
    })
  } catch (error) {
    await cleanup()
    throw error
  }
  return {
    home, store, port, rpc, cleanup,
    release: () => new Promise((resolve) => blocker.close(resolve)),
  }
}

test("retries automatically after a retired host releases the page port", async () => {
  const f = await fixture({ block: true })
  try {
    await f.rpc("provision")
    expect(await request(f.port)).toBe(false)
    // The first retry is due one second after the failed bind.
    await delay(1200)
    await f.release()
    await until(() => request(f.port), "page must recover without another tool call", 3500)
  } finally {
    await f.cleanup()
  }
}, 15_000)

test("concurrent reused provisions wait for the trajectory check", async () => {
  const f = await fixture({ holdTrajectory: true })
  try {
    await f.rpc("provision")
    const result = await f.rpc("concurrent")
    expect(result.result.every((entry) => entry.reused)).toBe(true)
    expect(await request(f.port)).toBe(false)
    await f.rpc("releaseTrajectory")
    await until(() => request(f.port), "one shared start must listen")
  } finally {
    await f.cleanup()
  }
}, 15_000)

test("an absent project store writes nothing", async () => {
  const f = await fixture()
  try {
    await delay(1400)
    await expect(access(f.store)).rejects.toThrow()
    await expect(access(join(f.home, "projects"))).rejects.toThrow()
  } finally {
    await f.cleanup()
  }
}, 15_000)

test("a rejected backend initialization is not cached forever", async () => {
  const f = await fixture()
  try {
    expect((await f.rpc("backendFailure")).result.rejected).toBe(true)
    const result = await f.rpc("status")
    expect(result.result.backend).toBe("sim")
    expect(result.result.projects).toEqual([])
  } finally {
    await f.cleanup()
  }
}, 15_000)
