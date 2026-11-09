import { test } from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { stopChrome, removeProfile, retireBrowser, makeCloser } from "../login.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test("stopChrome waits for the process to exit before returning", async () => {
  let exited = false
  const proc = {
    kill() { setTimeout(() => { exited = true }, 60) },
    exited: sleep(60).then(() => { exited = true }),
  }
  await stopChrome(proc, 200)
  assert.equal(exited, true, "the profile is only safe to delete after exit")
})

test("stopChrome escalates to SIGKILL when the first signal is ignored", async () => {
  const signals = []
  let resolveExit
  const exited = new Promise((r) => { resolveExit = r })
  const proc = {
    kill(signal) {
      signals.push(signal || "SIGTERM")
      if (signal === "SIGKILL") resolveExit()
    },
    exited,
  }
  await stopChrome(proc, 30)
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
})

test("stopChrome tolerates a process that is already gone", async () => {
  const proc = {
    kill() { throw new Error("ESRCH") },
    exited: Promise.resolve(),
  }
  await assert.doesNotReject(() => stopChrome(proc, 10))
})

test("removeProfile deletes the throwaway profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "pplx-test-"))
  const profile = join(root, "magpie-pplx-login-1")
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, "Cookies"), "session")
  await removeProfile(profile, root)
  assert.deepEqual(await readdir(root), [])
  await rm(root, { recursive: true, force: true })
})

test("removeProfile refuses a path outside the temp root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pplx-test-"))
  const outside = await mkdtemp(join(tmpdir(), "pplx-keep-"))
  const keep = join(outside, "keep-me")
  await writeFile(keep, "x")
  await assert.doesNotReject(() => removeProfile(outside, root))
  assert.deepEqual(await readdir(outside), ["keep-me"], "nothing was deleted")
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

test("a profile that will not delete raises profile_cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "pplx-test-"))
  const profile = join(root, "magpie-pplx-login-2")
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, "Cookies"), "session")
  // Removing a directory needs write permission on its parent; without it the
  // retries all fail and the caller must hear about it.
  await chmod(root, 0o500)
  try {
    await assert.rejects(
      () => removeProfile(profile, root, 2),
      (e) => e.code === "profile_cleanup",
    )
  } finally {
    await chmod(root, 0o700)
    await rm(root, { recursive: true, force: true })
  }
})

test("retireBrowser removes the profile only after the process exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pplx-test-"))
  const profile = join(root, "magpie-pplx-login-3")
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, "Cookies"), "session")

  let alive = true
  let stillThereWhileAlive = false
  const proc = {
    kill() {},
    exited: sleep(60).then(() => {
      stillThereWhileAlive = existsSync(profile)
      alive = false
    }),
  }
  await retireBrowser(proc, profile, root)
  assert.equal(alive, false)
  assert.equal(stillThereWhileAlive, true, "the rm waited for the exit")
  assert.equal(existsSync(profile), false)
  await rm(root, { recursive: true, force: true })
})

test("removeProfile retries a failed removal instead of giving up", async () => {
  const root = await mkdtemp(join(tmpdir(), "pplx-test-"))
  const profile = join(root, "magpie-pplx-login-4")
  await mkdir(profile, { recursive: true })
  let calls = 0
  const flaky = async (dir, options) => {
    calls++
    if (calls < 3) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" })
    return rm(dir, options)
  }
  await removeProfile(profile, root, 5, flaky)
  assert.equal(calls, 3, "it retried until the removal worked")
  assert.equal(existsSync(profile), false)
  await rm(root, { recursive: true, force: true })
})

test("removeProfile reports the code after every retry fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pplx-test-"))
  const profile = join(root, "magpie-pplx-login-5")
  await mkdir(profile, { recursive: true })
  let calls = 0
  const broken = async () => {
    calls++
    throw Object.assign(new Error("EACCES"), { code: "EACCES" })
  }
  await assert.rejects(() => removeProfile(profile, root, 3, broken), (e) => e.code === "profile_cleanup")
  assert.equal(calls, 3)
  await rm(root, { recursive: true, force: true })
})

test("close() stops the page, waits for Chrome, then removes the profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "pplx-test-"))
  const profile = join(root, "magpie-pplx-login-6")
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, "Cookies"), "session")

  const order = []
  const page = { stop() { order.push("page") } }
  const proc = {
    kill() { order.push("kill") },
    exited: Promise.resolve().then(() => order.push("exit")),
  }
  const remove = async (dir, options) => {
    order.push("remove")
    return rm(dir, options)
  }
  const close = makeCloser({ page, proc, profile, root, remove })
  await close()
  assert.deepEqual(order, ["page", "kill", "exit", "remove"], "the removal waits for the exit")
  assert.equal(existsSync(profile), false)

  // Idempotent: a second close does nothing.
  await close()
  assert.deepEqual(order, ["page", "kill", "exit", "remove"])
  await rm(root, { recursive: true, force: true })
})
