// The two "api" sign-in methods and the browser sign-in's fail-fast paths:
// everything a user hits before any browser window opens.
import "./nonet.mjs"
import { afterEach, describe, expect, test } from "bun:test"
import { _internal } from "./index.mjs"
import { fakeMoss, json, meBody } from "./fake.mjs"

let f
afterEach(() => {
  f?.close()
  f = undefined
})

describe("api-key-only authorize", () => {
  test("a working key is accepted and saved as an api entry", async () => {
    f = fakeMoss()
    f.route("GET /v1/models", () => json({ object: "list", data: [{ id: "nex-n2.6" }] }))
    const plugin = _internal.createPlugin()
    const method = plugin.auth.methods.find((m) => m.label === "API key only (models, no credit card)")
    const out = await method.authorize({ apiKey: "sk-live" })
    expect(out.type).toBe("success")
    expect(out.key).toBe("sk-live")
    expect(out.source).toBe("api")
    expect(out.metadata).toBeUndefined() // this method keeps the plain shape
  })

  test("a refused key fails the sign-in with the probe's wording", async () => {
    f = fakeMoss()
    f.route("GET /v1/models", () => json({ message: "permission denied" }, 403))
    const plugin = _internal.createPlugin()
    const method = plugin.auth.methods.find((m) => m.label === "API key only (models, no credit card)")
    const out = await method.authorize({ apiKey: "sk-dead" })
    expect(out.type).toBe("failed")
    expect(String(out.error)).toContain("403")
  })

  test("a network failure does not fail the sign-in (the key is kept unprobed)", async () => {
    const plugin = _internal.createPlugin({ fetchImpl: async () => { throw new Error("ECONNREFUSED") } })
    const method = plugin.auth.methods.find((m) => m.label === "API key only (models, no credit card)")
    const out = await method.authorize({ apiKey: "sk-live" })
    expect(out.type).toBe("success")
  })
})

describe("api-key + console-token authorize", () => {
  const methodOf = (plugin) => plugin.auth.methods.find((m) => m.label === "API key + console token (models + credit card)")

  test("a bare token is stored, never a whole pasted cookie string", async () => {
    f = fakeMoss()
    f.route("GET /v1/models", () => json({ object: "list", data: [{ id: "nex-n2.6" }] }))
    f.route("GET /portal-api/me", () => json(meBody()))
    const plugin = _internal.createPlugin()
    const out = await methodOf(plugin).authorize({ apiKey: "sk-live", consoleToken: "bare-token-value" })
    expect(out.type).toBe("success")
    expect(out.consoleToken).toBe("bare-token-value")
    expect(out.metadata.consoleToken).toBe("bare-token-value")
    expect(out.username).toBe("张三")
    expect(out.source).toBe("manual")
  })

  test("a full cookie string is reduced to the session token in metadata", async () => {
    f = fakeMoss()
    f.route("GET /v1/models", () => json({ object: "list", data: [{ id: "nex-n2.6" }] }))
    f.route("GET /portal-api/me", () => json(meBody()))
    const plugin = _internal.createPlugin()
    const out = await methodOf(plugin).authorize({
      apiKey: "sk-live",
      consoleToken: "other=1; moss_studio_prod_access_token=a%2Fb;c=3",
    })
    expect(out.type).toBe("success")
    expect(out.consoleToken).toBe("a/b")
    expect(out.metadata.consoleToken).toBe("a/b")
    // the rest of the paste never reaches the stored credential
    expect(JSON.stringify(out)).not.toContain("other_cookie")
  })

  test("a cookie string without the session name is refused", async () => {
    f = fakeMoss()
    const plugin = _internal.createPlugin()
    const out = await methodOf(plugin).authorize({ apiKey: "sk-live", consoleToken: "other=1; acw_tc=zzz" })
    expect(out.type).toBe("failed")
    expect(String(out.error)).toContain("could not read a console session token")
  })

  test("a refused console token fails with the vendor's message", async () => {
    f = fakeMoss()
    f.route("GET /v1/models", () => json({ object: "list", data: [{ id: "nex-n2.6" }] }))
    f.route("GET /portal-api/me", () => json({ message: "unauthorized" }, 401))
    const plugin = _internal.createPlugin()
    const out = await methodOf(plugin).authorize({ apiKey: "sk-live", consoleToken: "expired-token" })
    expect(out.type).toBe("failed")
    expect(String(out.error)).toContain("unauthorized")
  })

  test("a missing key fails before anything else", async () => {
    f = fakeMoss()
    const plugin = _internal.createPlugin()
    const out = await methodOf(plugin).authorize({ apiKey: "", consoleToken: "tok" })
    expect(out.type).toBe("failed")
    expect(String(out.error)).toContain("API key is required")
  })
})

describe("browser sign-in fail-fast", () => {
  test("no browser on the machine fails before any window opens", async () => {
    const plugin = _internal.createPlugin({ browserCandidates: () => [] })
    const out = plugin.auth.methods[0].authorize()
    expect(out.type).toBe("failed")
    expect(String(out.error)).toContain("Microsoft Edge")
    expect(String(out.error)).toContain("MAGPIE_MOSS_BROWSER")
  })

  test("a broken browser path fails the same way", async () => {
    const plugin = _internal.createPlugin({ browser: "C:/no/such/browser.exe" })
    const out = plugin.auth.methods[0].authorize()
    expect(out.type).toBe("failed")
  })

  test("a displayless Linux box is told which key-only methods remain", async () => {
    const plugin = _internal.createPlugin({
      browserCandidates: () => ["/usr/bin/google-chrome"],
      platform: "linux",
      env: {},
    })
    const saved = { platform: process.platform, display: process.env.DISPLAY, wayland: process.env.WAYLAND_DISPLAY }
    Object.defineProperty(process, "platform", { value: "linux", configurable: true })
    delete process.env.DISPLAY
    delete process.env.WAYLAND_DISPLAY
    try {
      const out = plugin.auth.methods[0].authorize()
      expect(out.type).toBe("failed")
      expect(String(out.error)).toContain("API key only")
    } finally {
      Object.defineProperty(process, "platform", { value: saved.platform, configurable: true })
      if (saved.display !== undefined) process.env.DISPLAY = saved.display
      if (saved.wayland !== undefined) process.env.WAYLAND_DISPLAY = saved.wayland
    }
  })
})
