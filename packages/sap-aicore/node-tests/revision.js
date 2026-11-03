import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { pluginRevision } from "../src/revision.js"
import { SAPAICorePlugin } from "../src/index.js"

const version = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")).version
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aicore-revision-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const root = path.join(dir, "plugin")
  await fs.mkdir(root)
  await fs.cp(new URL("../src", import.meta.url), path.join(root, "src"), { recursive: true })
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", version }))
  const load = () => import(pathToFileURL(path.join(root, "src/revision.js")).href)
  return { dir, root, load }
}

function checkout(root) {
  git(root, "init", "-b", "main")
  git(root, "add", ".")
  git(root, "-c", "user.name=Revision Test", "-c", "user.email=revision@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture")
  git(root, "tag", "v1.0.0")
}

async function fakeGit(t, dir, command) {
  const bin = path.join(dir, "bin")
  await fs.mkdir(bin)
  await fs.writeFile(path.join(bin, "git"), `#!/bin/sh\n${command}\n`, { mode: 0o755 })
  const original = process.env.PATH
  process.env.PATH = bin
  t.after(() => { process.env.PATH = original })
}

describe("pluginRevision", () => {
  it("returns and caches the in-flight revision Promise", async () => {
    const pending = pluginRevision()
    assert.equal(pending, pluginRevision())
    assert.ok((await pending).startsWith(version))
  })

  it("reports the exact revision of its own checkout despite inherited Git overrides", async t => {
    const { root, load } = await fixture(t)
    checkout(root)
    const expected = `${version} (${git(root, "describe", "--tags", "--always", "--dirty")})`
    const original = process.env.GIT_DIR
    process.env.GIT_DIR = "/nonexistent-revision-repo"
    t.after(() => {
      if (original === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = original
    })
    assert.equal(await (await load()).pluginRevision(), expected)
  })

  it("supports a checkout with a worktree gitfile", async t => {
    const { dir, root } = await fixture(t)
    checkout(root)
    const worktree = path.join(dir, "worktree")
    git(root, "worktree", "add", "--detach", worktree)
    const { pluginRevision } = await import(pathToFileURL(path.join(worktree, "src/revision.js")).href)
    assert.equal(await pluginRevision(), `${version} (${git(worktree, "describe", "--tags", "--always", "--dirty")})`)
  })

  for (const invalidMetadata of [false, true]) {
    it(`never reports an enclosing repository${invalidMetadata ? " even with an invalid .git directory" : ""}`, async t => {
      const { dir, root, load } = await fixture(t)
      checkout(dir)
      if (invalidMetadata) await fs.mkdir(path.join(root, ".git"))
      assert.equal(await (await load()).pluginRevision(), version)
    })
  }

  for (const command of ["exit 1", "exec /bin/sleep 10"]) {
    it(`falls back to the version on Git ${command === "exit 1" ? "failure" : "timeout"}`, async t => {
      const { dir, root, load } = await fixture(t)
      await fs.mkdir(path.join(root, ".git"))
      await fakeGit(t, dir, command)
      assert.equal(await (await load()).pluginRevision(), version)
    })
  }

  it("falls back when Git is unavailable", async t => {
    const { dir, root, load } = await fixture(t)
    await fs.mkdir(path.join(root, ".git"))
    await fakeGit(t, dir, "exit 1")
    await fs.unlink(path.join(dir, "bin/git"))
    assert.equal(await (await load()).pluginRevision(), version)
  })

  it("does not block the event loop or plugin initialization on Git", async t => {
    const { dir, root, load } = await fixture(t)
    await fs.mkdir(path.join(root, ".git"))
    await fakeGit(t, dir, "exec /bin/sleep 10")
    const { SAPAICorePlugin } = await import(pathToFileURL(path.join(root, "src/index.js")).href)
    let logged = false
    const hooks = await SAPAICorePlugin({ client: { app: { log() { logged = true } } } })
    assert.equal(typeof hooks.config, "function")
    assert.equal(logged, false)
    let settled = false
    const pending = (await load()).pluginRevision().then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(settled, false)
    await pending
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(logged, true)
  })
})

describe("startup revision log", () => {
  it("uses the documented host log body and preserves the logger receiver", async () => {
    const logged = []
    const app = { log(opts) { assert.equal(this, app); logged.push(opts) } }
    await SAPAICorePlugin({ client: { app } })
    await pluginRevision()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(logged, [{ body: { service: "sap-aicore", level: "info", message: `revision ${await pluginRevision()}` } }])
  })

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

  it("stays silent without a host logger", async t => {
    const logged = []
    t.mock.method(console, "log", (...args) => logged.push(args))
    t.mock.method(console, "error", (...args) => logged.push(args))
    for (const input of [undefined, {}, { client: {} }, { client: { app: {} } }]) {
      assert.equal(typeof (await SAPAICorePlugin(input)).config, "function")
    }
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(logged, [])
  })
})
