// The profile-ownership guard and the token wait: the safety-relevant pure
// pieces of the browser layer that need no browser process.
import "./nonet.mjs"
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { removeProfile, waitForToken, profileDir } from "./lib/browser.mjs"

describe("removeProfile ownership", () => {
  test("a directory without the ownership marker is refused and survives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moss-not-ours-"))
    writeFileSync(join(dir, "Cookies"), "innocent")
    expect(await removeProfile(dir)).toBe(false)
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(join(dir, "Cookies"))).toBe(true)
  })

  test("a directory carrying the .moss-profile marker is removed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moss-marked-"))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, ".moss-profile"), "1")
    expect(await removeProfile(dir)).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })

  test("a one-off login directory is owned by its name pattern alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-moss-login-"))
    writeFileSync(join(dir, "Cookies"), "session")
    expect(await removeProfile(dir)).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })

  test("the plugin's default profile location is owned even without a marker", async () => {
    const dir = profileDir()
    mkdirSync(dir, { recursive: true })
    try {
      expect(await removeProfile(dir)).toBe(true)
      expect(existsSync(dir)).toBe(false)
    } finally {
      try {
        require("node:fs").rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  })

  test("an empty or missing path is a no-op success", async () => {
    expect(await removeProfile("")).toBe(true)
    expect(await removeProfile(join(tmpdir(), "moss-missing-profile-xyz"))).toBe(true)
  })
})

describe("waitForToken", () => {
  const hangingSession = () => ({ token: () => new Promise(() => {}) })

  test("an aborted signal ends the wait as cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(waitForToken(hangingSession(), { timeoutMs: 4000, pollMs: 10, signal: controller.signal })).rejects.toMatchObject({
      cancelled: true,
    })
  })

  test("a session that never answers hits the timeout", async () => {
    await expect(waitForToken(hangingSession(), { timeoutMs: 80, pollMs: 10 })).rejects.toThrow("登录超时")
  })

  test("a session that answers returns the token", async () => {
    const token = await waitForToken({ token: async () => "tok-1" }, { timeoutMs: 4000, pollMs: 10 })
    expect(token).toBe("tok-1")
  })
})
