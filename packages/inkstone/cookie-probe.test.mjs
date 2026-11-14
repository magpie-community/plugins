// #840/#847 的测试：Cookies sqlite 探针、基线判定与非 Windows 完成信号。
// bun:sqlite 是真的（Bun 内置），库是我们造的临时文件，不带任何真实 cookie。
import "./nonet.mjs"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "bun:test"
import { chromiumMicros, cookieBaseline, hostMatches, profileHasNewCookie } from "./lib/cookieProbe.mjs"
import { consoleCookieDomain, waitForConsoleWindow } from "./lib/browser.mjs"

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
  db.query("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, creation_utc INTEGER, last_update_utc INTEGER, expires_utc INTEGER)").run()
  for (const row of rows) {
    db.query("INSERT INTO cookies (host_key, name, value, creation_utc, last_update_utc, expires_utc) VALUES (?, ?, ?, ?, ?, ?)").run(
      row.host_key ?? ".intern-ai.org.cn",
      row.name,
      row.value ?? "ciphertext",
      row.creation_utc ?? chromiumMicros(),
      row.last_update_utc ?? chromiumMicros(),
      row.expires_utc ?? chromiumMicros(Date.now() + 86400_000),
    )
  }
  db.close()
  return dir
}

const DOMAIN = "intern-ai.org.cn"

test("the baseline is empty on a fresh profile and carries the row on a kept one", () => {
  const profile = fakeProfileWith([{ name: "uaa-token" }])
  expect(cookieBaseline(profile, "uaa-token", DOMAIN)).toHaveLength(1)
  rmSync(dir, { recursive: true, force: true })
  dir = mkdtempSync(join(tmpdir(), "inkstone-probe-empty-"))
  expect(cookieBaseline(dir, "uaa-token", DOMAIN)).toEqual([])
})

test("a row that was there at launch is not this sign-in (the #847 blocking case)", () => {
  // keep_sign_in's profile: the old uaa-token is already there; the page
  // writes no new cookie — the wait must NOT read that as a finished sign-in
  const profile = fakeProfileWith([{ name: "uaa-token" }])
  const baseline = cookieBaseline(profile, "uaa-token", DOMAIN)
  expect(profileHasNewCookie(profile, "uaa-token", baseline, DOMAIN)).toBe(false)
})

test("a new row, or an overwritten one, is this sign-in", () => {
  const frozenNowMs = Date.now()
  const originalDateNow = Date.now
  Date.now = () => frozenNowMs
  try {
    const profile = fakeProfileWith([{ name: "uaa-token", creation_utc: chromiumMicros(frozenNowMs - 60_000) }])
    const baseline = cookieBaseline(profile, "uaa-token", DOMAIN)
    expect(profileHasNewCookie(profile, "uaa-token", baseline, DOMAIN)).toBe(false)

    const { Database } = require("bun:sqlite")
    const db = new Database(join(profile, "Default", "Cookies"))
    db.query("UPDATE cookies SET last_update_utc = ? WHERE name = 'uaa-token'").run(chromiumMicros(frozenNowMs + 1000))
    db.close()
    expect(profileHasNewCookie(profile, "uaa-token", baseline, DOMAIN)).toBe(true)
  } finally {
    Date.now = originalDateNow
  }
})

test("an expired row, another domain's row, another cookie's row: all refused", () => {
  const profile = fakeProfileWith([
    { name: "uaa-token", host_key: ".some-other.test" },
    { name: "sid" },
    { name: "uaa-token", expires_utc: chromiumMicros(Date.now() - 3600_000) },
  ])
  expect(profileHasNewCookie(profile, "uaa-token", [], DOMAIN)).toBe(false)
})

test("no store, a locked store, a file that is not sqlite: not-yet, never a throw", () => {
  dir = mkdtempSync(join(tmpdir(), "inkstone-probe-none-"))
  expect(profileHasNewCookie(dir, "uaa-token", [], DOMAIN)).toBe(false)
  mkdirSync(join(dir, "Default"), { recursive: true })
  writeFileSync(join(dir, "Default", "Cookies"), "this is not sqlite")
  expect(profileHasNewCookie(dir, "uaa-token", [], DOMAIN)).toBe(false)
})

test("the probe copy lives in the profile (0700), not the system temp (N6)", () => {
  const profile = fakeProfileWith([{ name: "uaa-token" }])
  let sawPath = ""
  profileHasNewCookie(profile, "uaa-token", [], DOMAIN, {
    sqliteOpen: (p) => {
      sawPath = p
      return [{ host_key: ".intern-ai.org.cn", name: "uaa-token", creation_utc: chromiumMicros(), last_update_utc: chromiumMicros(), expires_utc: chromiumMicros(Date.now() + 60_000) }]
    },
  })
  expect(sawPath.startsWith(profile)).toBe(true)
  expect(sawPath.includes("inkstone-cookie-probe")).toBe(true)
})

test("the production domain is the console's registrable domain, not the public suffix", () => {
  // 早期实现取最后两段，控制台主机 discovery.intern-ai.org.cn 会得到
  // org.cn（公共后缀）——库里任何 .org.cn 的 uaa-token 都会被当成控制台
  // 会话。这里走生产函数，再用它去探针里验一遍。
  const domain = consoleCookieDomain()
  expect(domain).toBe("intern-ai.org.cn")
  const profile = fakeProfileWith([
    // 同一枚 cookie、未过期、刚写入，但在别的 org.cn 站点上
    { name: "uaa-token", host_key: ".other.org.cn" },
  ])
  expect(profileHasNewCookie(profile, "uaa-token", [], domain)).toBe(false)
  // 控制台自己的行才算数（对照：同样的行、换成控制台域）
  rmSync(join(profile, "Default", "Cookies"), { force: true })
  const { Database } = require("bun:sqlite")
  const db = new Database(join(profile, "Default", "Cookies"))
  db.query("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, creation_utc INTEGER, last_update_utc INTEGER, expires_utc INTEGER)").run()
  const now = chromiumMicros()
  db.query(
    "INSERT INTO cookies (host_key, name, value, creation_utc, last_update_utc, expires_utc) VALUES ('.discovery.intern-ai.org.cn', 'uaa-token', 'ciphertext', ?, ?, ?)",
  ).run(now, now, chromiumMicros(Date.now() + 86400_000))
  db.close()
  expect(profileHasNewCookie(profile, "uaa-token", [], domain)).toBe(true)
})

test("hostMatches takes the console root, its dot form and its subdomains", () => {
  expect(hostMatches(".intern-ai.org.cn", DOMAIN)).toBe(true)
  expect(hostMatches("intern-ai.org.cn", DOMAIN)).toBe(true)
  expect(hostMatches("discovery.intern-ai.org.cn", DOMAIN)).toBe(true)
  expect(hostMatches(".evilintern-ai.org.cn", DOMAIN)).toBe(false)
  expect(hostMatches(".other.test", DOMAIN)).toBe(false)
})

test("off Windows the console title is never read, and a new cookie ends the wait", async () => {
  const { spawn } = await import("node:child_process")
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { stdio: "ignore" })
  try {
    const profile = fakeProfileWith([])
    let probes = 0
    let titles = 0
    // a title that would end the wait at once, if this platform read it
    const titleOf = () => {
      titles += 1
      return "书生·端砚 Intern InkStone"
    }
    const logs = []
    const how = await waitForConsoleWindow(child, {
      platform: "darwin",
      profile,
      titleOf,
      cookieProbe: () => {
        probes += 1
        return probes >= 3 // the console writes the session, on poll 3
      },
      timeoutMs: 5000,
      pollMs: 20,
      log: (...args) => logs.push(args.map(String).join(" ")),
    })
    expect(how).toBe("console")
    expect(probes).toBeGreaterThanOrEqual(3)
    // the title is never read off Windows (it would have ended the wait at once)
    expect(titles).toBe(0)
    // the progress lines #840 asks for
    expect(logs.some((l) => l.includes("cookie store"))).toBe(true)
    expect(logs.some((l) => l.includes("closing the window"))).toBe(true)
  } finally {
    try { child.kill() } catch {}
  }
})

test("off Windows with no probe the wait still ends only on exit", async () => {
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
