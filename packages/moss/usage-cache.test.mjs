// The account card's cache and renewal behavior: the credit card is read
// through a 60s token-keyed cache, a 401 gets one silent renewal, and the
// host's options (opt) override the factory defaults.
import "./nonet.mjs"
import { afterEach, describe, expect, test } from "bun:test"
import { _internal } from "./index.mjs"
import { fakeMoss, json, meBody, usageSummaryBody } from "./fake.mjs"

let f
afterEach(() => {
  f?.close()
  f = undefined
})

const apiAuth = { type: "api", key: "sk-test", metadata: { apiKey: "sk-test", consoleToken: "tok-1" } }

describe("usage cache", () => {
  test("a second read within the TTL hits the cache (one usage-summary request)", async () => {
    f = fakeMoss()
    let hits = 0
    f.route("GET /portal-api/maas/credits/usage-summary", () => {
      hits++
      return json(usageSummaryBody())
    })
    f.route("GET /portal-api/me", () => json(meBody()))
    f.route("GET /portal-api/maas/credits/transactions", () => json({ items: [], total: 0 }))
    const plugin = _internal.createPlugin({ quotaTtlMs: 60_000 })
    await plugin.auth.usage(async () => apiAuth)
    await plugin.auth.usage(async () => apiAuth)
    expect(hits).toBe(1)
  })

  test("an expired cache entry reads again", async () => {
    f = fakeMoss()
    let hits = 0
    f.route("GET /portal-api/maas/credits/usage-summary", () => {
      hits++
      return json(usageSummaryBody())
    })
    f.route("GET /portal-api/me", () => json(meBody()))
    f.route("GET /portal-api/maas/credits/transactions", () => json({ items: [], total: 0 }))
    const plugin = _internal.createPlugin({ quotaTtlMs: 1 })
    await plugin.auth.usage(async () => apiAuth)
    await new Promise((r) => setTimeout(r, 15))
    await plugin.auth.usage(async () => apiAuth)
    expect(hits).toBe(2)
  })

  test("a different console token does not share the cache", async () => {
    f = fakeMoss()
    let hits = 0
    f.route("GET /portal-api/maas/credits/usage-summary", () => {
      hits++
      return json(usageSummaryBody())
    })
    f.route("GET /portal-api/me", () => json(meBody()))
    f.route("GET /portal-api/maas/credits/transactions", () => json({ items: [], total: 0 }))
    const plugin = _internal.createPlugin({ quotaTtlMs: 60_000 })
    await plugin.auth.usage(async () => apiAuth)
    await plugin.auth.usage(async () => ({ ...apiAuth, metadata: { ...apiAuth.metadata, consoleToken: "tok-2" } }))
    expect(hits).toBe(2)
  })
})

describe("usage renewal", () => {
  test("renewal off: an expired session says so and stays 'kept'", async () => {
    f = fakeMoss()
    f.route("GET /portal-api/maas/credits/usage-summary", () => json({ message: "unauthorized" }, 401))
    const plugin = _internal.createPlugin({ keep_sign_in: false })
    const card = await plugin.auth.usage(async () => apiAuth)
    expect(String(card.error)).toContain("console session expired")
    expect(card.signIn).toBe("kept")
  })

  test("renewal on but the profile is gone: same honest card, no crash", async () => {
    f = fakeMoss()
    f.route("GET /portal-api/maas/credits/usage-summary", () => json({ message: "unauthorized" }, 401))
    const plugin = _internal.createPlugin({
      browser: "C:/no/such/browser.exe",
      MAGPIE_MOSS_PROFILE: undefined,
    })
    const card = await plugin.auth.usage(async () => apiAuth)
    expect(String(card.error)).toContain("console session expired")
    expect(card.signIn).toBe("kept")
  })
})

describe("host option precedence (opt)", () => {
  test("magpie.option(false) beats a true factory option", async () => {
    f = fakeMoss()
    const plugin = _internal.createPlugin({ create_key: true }, { magpie: { option: () => false } })
    // keep_sign_in is read by renew(); create_key by the browser callback.
    // The observable: opt returns false, so renew bails before any browser.
    f.route("GET /portal-api/maas/credits/usage-summary", () => json({ message: "unauthorized" }, 401))
    const card = await plugin.auth.usage(async () => apiAuth)
    expect(String(card.error)).toContain("console session expired")
  })

  test("a throwing magpie.option (older host) falls back to the factory option", async () => {
    f = fakeMoss()
    f.route("GET /portal-api/maas/credits/usage-summary", () => json({ message: "unauthorized" }, 401))
    const plugin = _internal.createPlugin(
      { keep_sign_in: false },
      { magpie: { option: () => { throw new Error("no such option") } } },
    )
    const card = await plugin.auth.usage(async () => apiAuth)
    // keep_sign_in:false was honored (fallback worked): no renewal attempted,
    // the card says expired and no browser was touched.
    expect(String(card.error)).toContain("console session expired")
  })
})
