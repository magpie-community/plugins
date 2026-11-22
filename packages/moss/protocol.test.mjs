// The portal-api client: the console's own headers, its endpoints, and how
// failures are told from successes. Every claim here is measured from the
// live console (2026-11-21): same-origin cookie session, Origin required on
// mutations, {items,total} lists, display-string credit amounts.
import "./nonet.mjs"
import { afterEach, describe, expect, test } from "bun:test"
import {
  ENDPOINTS,
  ProtocolError,
  cleanDetail,
  consoleHeaders,
  cookieDomainMatches,
  createKey,
  deleteKey,
  listKeys,
  me,
  normalizeApiKey,
  probeApiKey,
  readConsoleToken,
  usageSummary,
} from "./lib/protocol.mjs"
import { fakeMoss, json, meBody, usageSummaryBody } from "./fake.mjs"

let f

afterEach(() => {
  f?.close()
  f = undefined
})

describe("console headers", () => {
  test("the console session travels as the cookie, with the console's origin", () => {
    const h = consoleHeaders("tok-1")
    expect(h.cookie).toBe("moss_studio_prod_access_token=tok-1")
    expect(h.origin).toBe(ENDPOINTS.console)
    expect(h.referer.startsWith(ENDPOINTS.console)).toBe(true)
    expect(h["sec-fetch-site"]).toBe("same-origin")
  })

  test("extra headers win over the defaults", () => {
    const h = consoleHeaders("t", { "content-type": "application/json" })
    expect(h["content-type"]).toBe("application/json")
  })
})

describe("readConsoleToken", () => {
  test("a bare token passes through", () => {
    expect(readConsoleToken("abc.def.ghi")).toBe("abc.def.ghi")
  })
  test("a full cookie string yields the session value, url-decoded", () => {
    expect(readConsoleToken("other=1; moss_studio_prod_access_token=a%2Fb;c=3")).toBe("a/b")
  })
  test("the alternate deployment name is accepted too", () => {
    expect(readConsoleToken("moss_studio_access_token=zzz")).toBe("zzz")
  })
  test("a cookie-shaped string without the session name is refused", () => {
    expect(readConsoleToken("other=1; acw_tc=zzz")).toBe("")
    expect(readConsoleToken("")).toBe("")
  })
})

describe("portal endpoints", () => {
  test("me reads the account with the cookie session", async () => {
    f = fakeMoss()
    f.route("GET /portal-api/me", () => json(meBody()))
    const who = await me("tok-1")
    expect(who.Username).toBe("张三")
    const req = f.seen.at(-1)
    expect(req.headers.get("cookie")).toBe("moss_studio_prod_access_token=tok-1")
    expect(req.headers.get("origin")).toBe(f.origin)
  })

  test("usage-summary returns the display-string credit fields", async () => {
    f = fakeMoss()
    f.route("GET /portal-api/maas/credits/usage-summary", () => json(usageSummaryBody()))
    const s = await usageSummary("tok-1")
    expect(s.display_available_points).toBe("1,200.00")
    expect(s.frozen_points).toBe(34.56)
  })

  test("transactions carry direction/limit/offset as query params", async () => {
    f = fakeMoss()
    f.route("GET /portal-api/maas/credits/transactions", () => json({ items: [], total: 0 }))
    // transactions is imported through quota.mjs; call it via the protocol export
    const { transactions } = await import("./lib/protocol.mjs")
    await transactions("tok-1", { limit: 7, offset: 14 })
    const req = f.seen.at(-1)
    expect(req.path).toBe("/portal-api/maas/credits/transactions")
    expect(req.query.get("direction")).toBe("credit")
    expect(req.query.get("limit")).toBe("7")
    expect(req.query.get("offset")).toBe("14")
  })

  test("a refusal (403 permission_error) becomes a ProtocolError with the status", async () => {
    f = fakeMoss()
    f.route("GET /portal-api/me", () => json({ code: 102111001, message: "permission denied" }, 403))
    let caught
    try {
      await me("tok-dead")
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ProtocolError)
    expect(caught.status).toBe(403)
    expect(String(caught.message)).toContain("permission denied")
  })

  test("a network failure is a ProtocolError, not a crash", async () => {
    f = fakeMoss()
    f.close() // nothing listens: the fetch fails
    f = undefined
    let caught
    try {
      await me("tok-1")
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ProtocolError)
  })

  test("createKey posts a JSON name and returns the plaintext once", async () => {
    f = fakeMoss()
    f.route("POST /portal-api/api_keys", (r) => json({ id: "9", name: r.json.name, api_key: "sk-new-plaintext" }))
    const created = await createKey("tok-1", "moss-test")
    expect(created.api_key).toBe("sk-new-plaintext")
    const req = f.seen.at(-1)
    expect(req.json).toEqual({ name: "moss-test" })
    expect(req.headers.get("content-type")).toBe("application/json")
  })

  test("deleteKey hits /api_keys/:id", async () => {
    f = fakeMoss()
    f.route("DELETE /portal-api/api_keys/9", () => json({ ok: true }))
    await deleteKey("tok-1", "9")
    expect(f.seen.at(-1).path).toBe("/portal-api/api_keys/9")
  })

  test("listKeys reads the items list", async () => {
    f = fakeMoss()
    f.route("GET /portal-api/api_keys", () => json({ items: [{ id: "1", name: "a", status: "active", created_at: "2026-11-20T00:00:00Z" }], total: 1 }))
    const listed = await listKeys("tok-1")
    expect(listed.items).toHaveLength(1)
  })

  test("the api side: probeApiKey treats 401/403 as refused, other statuses as not", async () => {
    f = fakeMoss()
    f.route("GET /v1/models", () => json({}, 403))
    await expect(probeApiKey("sk-dead")).rejects.toThrow("403")
    f.route("GET /v1/models", () => json({ object: "list", data: [] }))
    expect(await probeApiKey("sk-live")).toBe(true)
  })

  test("apiModels marks a refused key so the caller can tell it from a network failure", async () => {
    f = fakeMoss()
    f.route("GET /v1/models", () => json({}, 401))
    let caught
    try {
      await (await import("./lib/protocol.mjs")).apiModels("sk-dead")
    } catch (e) {
      caught = e
    }
    expect(caught?.refused).toBe(true)
  })
})

describe("small protocol helpers", () => {
  test("normalizeApiKey trims quotes and a stray Bearer", () => {
    expect(normalizeApiKey("  Bearer sk-1  ")).toBe("sk-1")
    expect(normalizeApiKey('"sk-2"')).toBe("sk-2")
  })
  test("cleanDetail masks tokens but keeps words", () => {
    const out = cleanDetail("failed for moss_studio_prod_access_token=abc.def.ghi and sk-12345678")
    expect(out).not.toContain("abc.def.ghi")
    expect(out).not.toContain("sk-12345678")
    expect(out).toContain("failed for")
  })
  test("cookieDomainMatches accepts the console's domains and subdomains only", () => {
    expect(cookieDomainMatches(".mosi.cn")).toBe(true)
    expect(cookieDomainMatches("platform.mosi.cn")).toBe(true)
    expect(cookieDomainMatches(".moss.cn")).toBe(true)
    expect(cookieDomainMatches("evil-mosi.cn")).toBe(false)
    expect(cookieDomainMatches("mosi.cn.evil.com")).toBe(false)
  })
})
