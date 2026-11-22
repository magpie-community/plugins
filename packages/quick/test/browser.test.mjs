// Pure pieces of the one-click sign-in layer that need no browser process:
// candidate selection (env override, dedup, a broken explicit path),
// requireBrowser's error, the profile directory's ownership rules, the
// cookie header assembly, and the account/csrf discovery from the page
// shapes Quick actually serves (the signed-out landing page's config is
// HTML-escaped with "csrf":null; the signed-in page carries the token).
// The browser-driving paths are not tested live — the moss module's
// equivalents are proven on this machine and the shapes are shared.
import { afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { browserCandidates, cookieHeaderOf, profileDir, requireBrowser } from "../lib/browser.mjs"
import { discoverAccount, pageConfigOf } from "../lib/session.mjs"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.MAGPIE_QUICK_BROWSER
  delete process.env.MAGPIE_QUICK_PROFILE
})

describe("browserCandidates", () => {
  test("an explicit existing path short-circuits the scan; a missing one throws", () => {
    expect(() => browserCandidates("C:/no/such/browser.exe")).toThrow("指定的浏览器不存在")
    const p = fileURLToPath(import.meta.url)
    expect(browserCandidates(p)).toEqual([p])
  })

  test("the env override comes first and is deduplicated", () => {
    process.env.MAGPIE_QUICK_BROWSER = fileURLToPath(import.meta.url)
    const list = browserCandidates()
    expect(list[0]).toBe(fileURLToPath(import.meta.url))
    expect(new Set(list).size).toBe(list.length)
    for (const p of list) expect(existsSync(p)).toBe(true)
  })

  test("a non-existent env override is refused loudly, not silently swapped", () => {
    process.env.MAGPIE_QUICK_BROWSER = "C:/no/such/browser.exe"
    expect(() => browserCandidates()).toThrow("MAGPIE_QUICK_BROWSER")
  })
})

describe("requireBrowser", () => {
  test("with no browser installed it names the paste method as the way out", () => {
    expect(() => requireBrowser("", { candidates: () => [] })).toThrow("Cookie")
  })

  test("with a candidate it returns the first", () => {
    expect(requireBrowser("", { candidates: () => ["C:/x/chrome.exe"] })).toBe("C:/x/chrome.exe")
  })
})

describe("profileDir", () => {
  test("lives under the plugin's own name, overridable by env", () => {
    const d = profileDir()
    expect(d).toContain("magpie")
    expect(d).toContain("quick-browser")
    process.env.MAGPIE_QUICK_PROFILE = "C:/tmp/x"
    expect(profileDir()).toBe("C:/tmp/x")
  })
})

describe("cookieHeaderOf", () => {
  test("assembles the Cookie header string from the jar's cookies", () => {
    // the real session cookies are browser-level httpOnly ones (recon:
    // qs_lang, EXP_*, cwr_*, AMP_*); mbtc is NOT a cookie — it is the page
    // config's csrf token
    expect(
      cookieHeaderOf([
        { name: "qs_lang", value: "en-US", domain: ".quick.aws.com" },
        { name: "cwr_u", value: "u1", domain: "quick.aws.com" },
      ]),
    ).toBe("qs_lang=en-US; cwr_u=u1")
    expect(cookieHeaderOf([])).toBe("")
  })
})

// the page-config block the way Quick actually serves it: an HTML-escaped
// hidden <div> (verified against the captured landing page)
const escapedConfig = (obj) =>
  `<div id="page-config" encoding="HTML_ESCAPE" style="display: none; !important" hidden>${JSON.stringify(obj).replace(/"/g, "&quot;")}</div>`

describe("pageConfigOf", () => {
  test("parses the HTML-escaped page-config block", () => {
    const cfg = pageConfigOf(`<html><body>${escapedConfig({ pageType: "QuickSuiteLanding", csrf: null })}</body></html>`)
    expect(cfg.pageType).toBe("QuickSuiteLanding")
    expect(cfg.csrf).toBe(null)
  })

  test("returns null for a page without the block or with a broken one", () => {
    expect(pageConfigOf("<html>no config</html>")).toBe(null)
    expect(pageConfigOf('<script id="page-config">{broken</script>')).toBe(null)
    expect(pageConfigOf("")).toBe(null)
  })
})

describe("discoverAccount", () => {
  test("reads the csrf from the signed-in page config (HTML-escaped), accountId given", async () => {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.includes("/start/chat")) {
        return new Response(escapedConfig({ pageType: "QuickSuiteChat", csrf: "tok-1" }), { status: 200 })
      }
      throw new Error(`unexpected fetch ${url}`)
    }
    const a = await discoverAccount("qs_lang=1; cwr_u=2", { accountId: "ACC-123" })
    expect(a.accountId).toBe("ACC-123")
    expect(a.mbtc).toBe("tok-1")
    expect(a.cookie).toBe("qs_lang=1; cwr_u=2")
  })

  test("discovers the accountId from the /sn/start redirect when not given", async () => {
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input)
      if (url.endsWith("/sn/start")) {
        const r = new Response("", { status: 302, headers: { location: "https://quick.aws.com/sn/account/ACC-9/start/chat" } })
        return r
      }
      if (url.includes("/start/chat")) return new Response(escapedConfig({ csrf: "tok-9" }), { status: 200 })
      throw new Error(`unexpected fetch ${url}`)
    }
    const a = await discoverAccount("cwr_u=1")
    expect(a.accountId).toBe("ACC-9")
    expect(a.mbtc).toBe("tok-9")
  })

  test("a signed-out session (no account redirect) is refused with the fix", async () => {
    globalThis.fetch = async () => new Response("<html>sign in</html>", { status: 200 })
    await expect(discoverAccount("x=1")).rejects.toThrow("account page")
  })

  test("a signed-in page whose config still has csrf:null says so", async () => {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.includes("/start/chat")) return new Response(escapedConfig({ pageType: "QuickSuiteLanding", csrf: null }), { status: 200 })
      return new Response("", { status: 302, headers: { location: "https://quick.aws.com/sn/account/ACC-123/start/chat" } })
    }
    await expect(discoverAccount("x=1")).rejects.toThrow("csrf")
  })

  test("an http error from the account page is reported as a refused session", async () => {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.includes("/start/chat")) return new Response("denied", { status: 403 })
      return new Response("", { status: 302, headers: { location: "https://quick.aws.com/sn/account/ACC-123/start/chat" } })
    }
    await expect(discoverAccount("x=1")).rejects.toThrow("403")
  })
})
