// #840 的测试：Cookies sqlite 探针与非 Windows 完成信号。
// bun:sqlite 是真的（Bun 内置），所以探针的读写都是真库——只是库是我们
// 造的临时文件，不带任何真实 cookie。
import "./nonet.mjs"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "bun:test"
import { profileHasCookie } from "./lib/cookieProbe.mjs"
import { waitForConsoleWindow } from "./lib/browser.mjs"

let dir = ""
afterEach(() => {
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
    dir = ""
  }
})

/** 一个真的 sqlite 库：<profile>/Default/Cookies，行由 rows 给出。 */
function fakeProfileWith(rows) {
  dir = mkdtempSync(join(tmpdir(), "inkstone-probe-profile-"))
  mkdirSync(join(dir, "Default"), { recursive: true })
  const { Database } = require("bun:sqlite")
  const db = new Database(join(dir, "Default", "Cookies"))
  db.query("CREATE TABLE cookies (name TEXT, value TEXT)").run()
  for (const row of rows) db.query("INSERT INTO cookies (name, value) VALUES (?, ?)").run(row.name, row.value)
  db.close()
  return dir
}

test("the probe finds the uaa-token row in a real sqlite profile", () => {
  const profile = fakeProfileWith([{ name: "sid", value: "x" }, { name: "uaa-token", value: "secret" }])
  expect(profileHasCookie(profile, "uaa-token")).toBe(true)
  expect(profileHasCookie(profile, "other-cookie")).toBe(false)
})

test("a profile without the Default/Cookies file, or a locked one, reads as not-yet", () => {
  dir = mkdtempSync(join(tmpdir(), "inkstone-probe-empty-"))
  expect(profileHasCookie(dir, "uaa-token")).toBe(false)
  // a file that is not a database: the probe must swallow the error
  mkdirSync(join(dir, "Default"), { recursive: true })
  writeFileSync(join(dir, "Default", "Cookies"), "this is not sqlite")
  expect(profileHasCookie(dir, "uaa-token")).toBe(false)
})

test("off Windows the console title is never read, and a cookie row ends the wait", async () => {
  const { spawn } = await import("node:child_process")
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { stdio: "ignore" })
  try {
    const profile = fakeProfileWith([]) // starts empty
    let probes = 0
    const probe = (p) => {
      probes += 1
      return probes >= 3 // the "console writes the session" moment, on poll 3
    }
    const logs = []
    const how = await waitForConsoleWindow(child, {
      platform: "darwin",
      profile,
      cookieProbe: (p) => probe(p),
      timeoutMs: 5000,
      pollMs: 20,
      log: (level, message) => logs.push(message),
    })
    expect(how).toBe("console")
    expect(probes).toBeGreaterThanOrEqual(3)
    // the progress lines #840 asks for
    expect(logs.some((l) => l.includes("cookie store"))).toBe(true)
    expect(logs.some((l) => l.includes("closing the window"))).toBe(true)
  } finally {
    try { child.kill() } catch {}
  }
})

test("off Windows with no probe (a one-off profile without the store) the wait still ends only on exit", async () => {
  const { spawn } = await import("node:child_process")
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { stdio: "ignore" })
  try {
    const early = await waitForConsoleWindow(child, { platform: "linux", timeoutMs: 120, pollMs: 40 })
    expect(early).toBe("timeout")
    child.kill()
    const how = await waitForConsoleWindow(child, { platform: "linux", timeoutMs: 2000, pollMs: 50 })
    expect(how).toBe("closed")
  } finally {
    try { child.kill() } catch {}
  }
})
