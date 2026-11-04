import { describe, it, afterEach, jest, spyOn } from "bun:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { SAPAICorePlugin } from "../src/index.js"

const cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  jest.useRealTimers()
})

const version = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")).version
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aicore-revision-"))
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
  const root = path.join(dir, "plugin")
  await fs.mkdir(root)
  await fs.cp(new URL("../src", import.meta.url), path.join(root, "src"), { recursive: true })
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", version }))
  return { dir, root }
}


async function fakeGit(dir, command) {
  const bin = path.join(dir, "bin")
  await fs.mkdir(bin)
  await fs.writeFile(path.join(bin, "git"), `#!/bin/sh\n${command}\n`, { mode: 0o755 })
  const original = process.env.PATH
  process.env.PATH = bin
  cleanups.push(() => { process.env.PATH = original })
}

describe("package version at startup", () => {
  it("does not execute Git even when a local package has Git metadata", async () => {
    const { dir, root } = await fixture()
    await fs.mkdir(path.join(root, ".git"))
    const invoked = path.join(dir, "git-invoked")
    await fakeGit(dir, `printf invoked > ${JSON.stringify(invoked)}\nprintf unexpected-git-revision`)
    const { SAPAICorePlugin } = await import(pathToFileURL(path.join(root, "src/index.js")).href)
    let finish
    const recorded = new Promise(resolve => { finish = resolve })
    const app = { log(options) { assert.equal(this, app); finish(options) } }
    await SAPAICorePlugin({ client: { app } })
    const record = await recorded
    assert.ok(record.body.message.includes(version))
    await assert.rejects(fs.access(invoked), { code: "ENOENT" })
  }, 15000)
})

describe("startup host logging", () => {

  for (const [name, log] of [
    ["synchronous", () => {}],
    ["throwing", () => { throw new Error("sync log failure") }],
    ["rejecting", () => Promise.reject(new Error("async log failure"))],
    ["pending", () => new Promise(() => {})],
  ]) {
    it(`does not let a ${name} logger prevent initialization`, async () => {
      const hooks = await SAPAICorePlugin({ client: { app: { log } } })
      assert.equal(typeof hooks.config, "function")
      await new Promise(resolve => setImmediate(resolve))
    })
  }

  it("stays silent without a host logger", async () => {
    const logged = []
    const logSpy = spyOn(console, "log").mockImplementation((...args) => logged.push(args))
    cleanups.push(() => logSpy.mockRestore())
    const errorSpy = spyOn(console, "error").mockImplementation((...args) => logged.push(args))
    cleanups.push(() => errorSpy.mockRestore())
    for (const input of [undefined, {}, { client: {} }, { client: { app: {} } }]) {
      assert.equal(typeof (await SAPAICorePlugin(input)).config, "function")
    }
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(logged, [])
  })
})
