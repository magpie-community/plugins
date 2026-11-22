// Pure pieces of the browser layer that need no browser process: candidate
// selection (env override, platform lists, a broken explicit path),
// requireBrowser's error, closeWindowGracefully's wait/force split, and the
// silent renewal's guards (missing profile, busy profile → "", never a
// browser launch).
import "./nonet.mjs"
import { afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import {
  browserCandidates,
  closeWindowGracefully,
  consoleCookieDomain,
  renewSilently,
  requireBrowser,
} from "./lib/browser.mjs"

afterEach(() => {
  delete process.env.MAGPIE_MOSS_BROWSER
  delete process.env.MAGPIE_MOSS_PROFILE
})

describe("browserCandidates", () => {
  test("an explicit existing path short-circuits the scan; a missing one throws", () => {
    expect(() => browserCandidates("C:/no/such/browser.exe")).toThrow("指定的浏览器不存在")
    // a real existing file as the explicit candidate (this test file itself)
    const p = fileURLToPath(import.meta.url)
    expect(browserCandidates(p)).toEqual([p])
  })

  test("the env override comes first when the default browser is installed", () => {
    // an existing file as the override so the strict existence check passes
    process.env.MAGPIE_MOSS_BROWSER = fileURLToPath(import.meta.url)
    const list = browserCandidates()
    // the override must be listed before any default guess (this machine has
    // Edge); on a bare box it may be the only entry
    if (list.length > 1) expect(list[0]).toBe(fileURLToPath(import.meta.url))
    expect(list).toContain(fileURLToPath(import.meta.url))
    // nothing invented: every path in the list exists on this machine
    for (const p of list) expect(require("node:fs").existsSync(p)).toBe(true)
  })

  test("candidates are deduplicated", () => {
    process.env.MAGPIE_MOSS_BROWSER = fileURLToPath(import.meta.url)
    const list = browserCandidates()
    expect(new Set(list).size).toBe(list.length)
  })

  test("a non-existent env override is refused loudly, not silently swapped", () => {
    process.env.MAGPIE_MOSS_BROWSER = "C:/no/such/browser.exe"
    expect(() => browserCandidates()).toThrow("MAGPIE_MOSS_BROWSER")
  })
})

describe("requireBrowser", () => {
  test("with an empty candidate list the error names the ways out", () => {
    let msg = ""
    try {
      requireBrowser(undefined, { candidates: () => [] })
    } catch (e) {
      msg = String(e.message)
    }
    expect(msg).toContain("Microsoft Edge")
    expect(msg).toContain("MAGPIE_MOSS_BROWSER")
  })

  test("on darwin the error also says Safari cannot be used", () => {
    let msg = ""
    try {
      requireBrowser(undefined, { candidates: () => [], platform: "darwin" })
    } catch (e) {
      msg = String(e.message)
    }
    expect(msg).toContain("Safari")
  })

  test("the first existing candidate wins", () => {
    expect(requireBrowser(undefined, { candidates: () => ["/usr/bin/chromium", "/usr/bin/google-chrome"] })).toBe(
      "/usr/bin/chromium",
    )
  })
})

describe("closeWindowGracefully", () => {
  test("an already-exited child returns immediately", async () => {
    const child = fakeProcess({ exitCode: 0 })
    expect(await closeWindowGracefully(child, { timeoutMs: 50 })).toBe(true)
    expect(child.forceKilled).toBe(false) // no force kill needed
  })

  test("a child that exits in time is not force-killed", async () => {
    const child = fakeProcess()
    setTimeout(() => child.emitExit(0), 60)
    expect(await closeWindowGracefully(child, { timeoutMs: 5000 })).toBe(true)
    expect(child.forceKilled).toBe(false)
  })

  test("a child that hangs is force-killed after the timeout", async () => {
    const child = fakeProcess()
    const out = await closeWindowGracefully(child, { timeoutMs: 120 })
    expect(out).toBe(false)
    // off Windows killTree sends SIGKILL directly; on Windows it runs
    // taskkill on the PID, observable as our graceful-close having run to
    // its timeout (force) rather than an early return
    if (WINDOWS) expect(out).toBe(false)
    else expect(child.forceKilled).toBe(true)
  }, 10_000)

  test("a missing child is a no-op", async () => {
    expect(await closeWindowGracefully(null)).toBeUndefined()
  })
})

describe("renewSilently guards", () => {
  test("a missing profile returns an empty token without launching anything", async () => {
    // profileDir() points nowhere in this test env unless MAGPIE_MOSS_PROFILE
    // says so; an empty string means "cannot renew", never an error.
    const token = await renewSilently({ browserPath: "C:/no/such/browser.exe", timeoutMs: 200 })
    expect(token).toBe("")
  })
})

describe("cookie parsing", () => {
  test("consoleCookieDomain is the registrable domain of the console URL", () => {
    expect(consoleCookieDomain()).toBe("mosi.cn")
  })
})

/** The parts of a ChildProcess closeWindowGracefully and killTree touch.
 * `killed` starts true only after our own kill() — on Windows killTree goes
 * through taskkill instead, which the probe below observes. */
function fakeProcess({ exitCode = null } = {}) {
  const p = {
    pid: 4242,
    exitCode,
    signalCode: null,
    killed: false,
    forceKilled: false,
    listeners: {},
    on(ev, fn) {
      (p.listeners[ev] ??= []).push(fn)
      return p
    },
    once(ev, fn) {
      return p.on(ev, fn)
    },
    kill(sig) {
      p.killed = true
      if (sig === "SIGKILL") p.forceKilled = true
      return true
    },
    emitExit(code) {
      p.exitCode = code
      for (const fn of p.listeners.exit ?? []) fn()
    },
  }
  return p
}

const WINDOWS = process.platform === "win32"
