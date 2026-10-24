// Match the host's usage-window contract, with a fake GraphQL account only.
import { afterEach, expect, test } from "bun:test"
import { _internal as w } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
const usage = async (user) => {
  globalThis.fetch = async (_url, init) => {
    expect(JSON.parse(init.body).operationName).toBe("GetRequestLimitInfo")
    return Response.json({ data: { user: { user } } })
  }
  const p = await w.createPlugin({ client: { auth: { set: async () => {} } } }, { readUser: async () => { throw new Error("unexpected credential read") } })
  return p.auth.usage(async () => ({ type: "oauth", access: "fake", refresh: "fake", expires: Date.now() + 3600_000 }))
}

test("an exhausted request allowance is a limiting window with visible counts", async () => {
  const result = await usage({ requestLimitInfo: { isUnlimited: false, requestsUsedSinceLastRefresh: 150, requestLimit: 150 } })
  const window = result.windows[0]
  expect(window.used).toBe(100)
  expect(window.aside).toBeUndefined()
  expect(window.display).toBe("150/150 requests")
  expect(result.signIn).toBe("kept")
})

test("bonus usage is computed from active grants, including fully spent grants", async () => {
  const result = await usage({ bonusGrants: [
    { requestCreditsGranted: 20, requestCreditsRemaining: 5 },
    { requestCreditsGranted: 10, requestCreditsRemaining: 10 },
    { requestCreditsGranted: 100, requestCreditsRemaining: 100, expiration: "2000-01-01T00:00:00Z" },
  ] })
  expect(result.windows).toEqual([{ name: "Bonus credits", used: 50, display: "15/30 credits left", aside: true }])
  const spent = await usage({ bonusGrants: [{ requestCreditsGranted: 20, requestCreditsRemaining: 0 }] })
  expect(spent.windows[0]).toMatchObject({ used: 100, display: "0/20 credits left", aside: true })
})

test("unlimited accounts and an empty bonus do not acquire a false allowance cap", async () => {
  expect((await usage({ requestLimitInfo: { isUnlimited: true }, bonusGrants: [] })).windows).toEqual([{ name: "Requests", used: 0 }])
})

test("client version overrides reach both request headers and GraphQL context", async () => {
  const old = process.env.MAGPIE_WARP_CLIENT_VERSION
  const version = "v0.2026.10.09.08.27.stable_01"
  process.env.MAGPIE_WARP_CLIENT_VERSION = version
  try {
    expect(w.baseHeaders("fake")["x-warp-client-version"]).toBe(version)
    globalThis.fetch = async (_url, init) => {
      expect(init.headers["X-Warp-Client-Version"]).toBe(version)
      expect(JSON.parse(init.body).variables.requestContext.clientContext.version).toBe(version)
      return Response.json({ data: { user: { user: {} } } })
    }
    await w.requestWindows("fake")
  } finally {
    if (old === undefined) delete process.env.MAGPIE_WARP_CLIENT_VERSION
    else process.env.MAGPIE_WARP_CLIENT_VERSION = old
  }
})
