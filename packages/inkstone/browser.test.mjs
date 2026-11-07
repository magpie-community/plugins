// The browser helpers that can be tested without launching a browser: the
// cookie parse, JWT expiry, argv, and the profile location.
import "./nonet.mjs"
import { join } from "node:path"
import { expect, test } from "bun:test"
import {
  browserArgs,
  browserCandidates,
  jwtExp,
  profileDir,
  readUaaToken,
  tokenFresh,
  waitForConsoleWindow,
  waitForToken,
} from "./lib/browser.mjs"

test("uaa-token is read out of document.cookie and URL-decoded", () => {
  expect(readUaaToken("a=b; uaa-token=abc.def.ghi; c=d")).toBe("abc.def.ghi")
  const encoded = encodeURIComponent("hello world")
  expect(readUaaToken(`uaa-token=${encoded}`)).toBe("hello world")
  expect(readUaaToken("")).toBe("")
  expect(readUaaToken("nothing=here")).toBe("")
})

test("a JWT's exp is read, an opaque token is left to the 401", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const jwt = ["e30", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "sig"].join(".")
  expect(jwtExp(jwt)).toBe(exp * 1000)
  expect(jwtExp("opaque-token")).toBe(0)
  expect(tokenFresh(jwt, 10 * 60_000)).toBe(true)
  const stale = ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 1 })).toString("base64url"), "sig"].join(".")
  expect(tokenFresh(stale, 10 * 60_000)).toBe(false)
  expect(tokenFresh("opaque-token", 10 * 60_000)).toBe(true)
})

test("browser candidates reject a path that is not there", () => {
  expect(() => browserCandidates("C:\\definitely\\not\\here.exe")).toThrow()
  // an existing executable is taken as the explicit browser
  expect(browserCandidates(process.execPath)).toEqual([process.execPath])
})

test("waitForToken's single read has its own timeout, the account never waits 8 minutes", async () => {
  let calls = 0
  const session = {
    token: async () => {
      calls += 1
      return calls === 1 ? "" : "read-token"
    },
  }
  expect(await waitForToken(session, { timeoutMs: 5000, pollMs: 50 })).toBe("read-token")
  expect(calls).toBe(2)

  const gridlock = { token: async () => new Promise(() => {}) }
  const start = Date.now()
  await expect(waitForToken(gridlock, { timeoutMs: 50, pollMs: 25 })).rejects.toThrow(/登录超时/)
  expect(Date.now() - start).toBeLessThan(2000)
})

test("headless renewal gets its own argv and the profile is per platform", () => {
  const headless = browserArgs("C:\\profile", 0, "https://discovery.intern-ai.org.cn/token-plan/home", {
    headless: true,
  })
  expect(headless[0]).toBe("--headless=new")
  expect(headless).toContain("--user-data-dir=C:\\profile")
  expect(headless).toContain("--remote-debugging-port=0")
  // the visible login window carries no debugging port: the console's
  // CAPTCHA must see an ordinary browser, not an automation session
  const visible = browserArgs("C:\\profile", 0, "https://discovery.intern-ai.org.cn/token-plan/home", {
    cdp: false,
    login: true,
  })
  expect(visible.some((a) => a.startsWith("--remote-debugging-port"))).toBe(false)
  expect(visible).toContain("--window-size=1100,800")
  // join() on the expected side too: the separator is the test host's, not win32's
  expect(profileDir({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32")).toBe(
    join("C:\\Users\\u\\AppData\\Local", "magpie", "inkstone-browser"),
  )
  expect(profileDir({ HOME: "/home/u" }, "linux").endsWith(join("magpie", "inkstone-browser"))).toBe(true)
})

test('off Windows the login wait ends on process exit, never on a title', async () => {
  const { spawn } = await import('node:child_process')
  // a child that stays alive in a non-Windows run must never be treated as
  // 'console': only its exit ends the wait. The title probe is counted: a
  // build that reads the title on every OS (canReadTitle true everywhere)
  // fails here — the probe must not run off Windows at all
  let titleProbes = 0
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' })
  try {
    const early = await waitForConsoleWindow(child, { platform: 'linux', timeoutMs: 120, pollMs: 40, titleDelayMs: 0, windowTitle: () => (titleProbes++, '书生·端砚 Intern InkStone') })
    expect(early).toBe('timeout')
    expect(titleProbes).toBe(0)
    child.kill()
    const how = await waitForConsoleWindow(child, { platform: 'linux', timeoutMs: 2000, pollMs: 50 })
    expect(how).toBe('closed')
  } finally {
    try { child.kill() } catch {}
  }
})

test('on Windows the login wait ends on the console title (two hits)', async () => {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' })
  try {
    const how = await waitForConsoleWindow(child, {
      platform: 'win32',
      timeoutMs: 5000,
      pollMs: 20,
      titleDelayMs: 0,
      windowTitle: () => '书生·端砚 Intern InkStone - 控制台',
    })
    expect(how).toBe('console')
  } finally {
    try { child.kill() } catch {}
  }
})

test('the SSO title never counts as the console', async () => {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' })
  try {
    const how = await waitForConsoleWindow(child, {
      platform: 'win32',
      timeoutMs: 800,
      pollMs: 20,
      titleDelayMs: 0,
      windowTitle: () => '上海人工智能实验室-用户认证体系',
    })
    expect(how).toBe('timeout')
  } finally {
    try { child.kill() } catch {}
  }
})

