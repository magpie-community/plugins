// auth.usage tells what magpie's built-in Factory account shows
// (internal/provider/factory_usage.go), against Factory's replies as its
// tests give them (factory_test.go).
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const LIMITS = {
  limits: {
    standard: {
      fiveHour: { usedPercent: 42, windowEnd: "2026-10-01T05:00:00Z" },
      weekly: { usedPercent: 10, windowEnd: 1791763200000 },
      monthly: { usedPercent: 130, windowEnd: "1793000000000" },
    },
    core: { fiveHour: { usedPercent: 100, windowEnd: "2026-10-01T05:00:00Z" } },
  },
  extraUsageBalanceCents: 1250,
  extraUsageAllowed: true,
}

const CORE = ["glm-5.3", "glm-5.3-flash", "glm-5.2", "kimi-k3", "deepseek-v4.1-flash", "qwen3.8-max", "minimax-m3", "minimax-m2.7", "mistral-large-4", "mistral-medium-3.5", "nemotron-3-ultra"]

const account = (over = {}) => ({
  type: "oauth",
  access: "tok-a",
  refresh: "r-a",
  expires: Date.now() + 3_600_000,
  accountId: "ada",
  activeOrganizationId: "fac_A",
  region: "eu",
  premBaseHost: "",
  ...over,
})

async function plugin(auth, serve) {
  const seen = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    const h = new Headers(init.headers)
    seen.push(`${u.host}${u.pathname} ${h.get("X-Factory-Org-Id") ?? ""}`)
    return serve(u.pathname, h, init)
  }
  const client = { auth: { set: async ({ body }) => (auth = body) } }
  const hooks = await FactoryAuthPlugin({ client })
  return { usage: () => hooks.auth.usage(async () => auth), seen, auth: () => auth }
}

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })

test("standard's windows, Droid Core's, and the extra usage", async () => {
  const p = await plugin(account(), (path, h) => {
    expect(h.get("Authorization")).toBe("Bearer tok-a")
    expect(h.get("X-Factory-Client")).toBe("cli")
    return path === "/api/billing/limits" ? json(LIMITS) : new Response("", { status: 404 })
  })
  expect(await p.usage()).toEqual({
    windows: [
      { name: "5 hours", used: 42, span: 18000, resetsAt: "2026-10-01T05:00:00.000Z", aside: true, notModels: CORE },
      { name: "7 days", used: 10, span: 604800, resetsAt: "2026-10-12T00:00:00.000Z", aside: true, notModels: CORE },
      { name: "30 days", used: 100, span: 2592000, resetsAt: "2026-10-26T07:33:20.000Z", aside: true, notModels: CORE },
      { name: "Droid Core · 5 hours", used: 100, span: 18000, resetsAt: "2026-10-01T05:00:00.000Z", aside: true, models: CORE },
      { name: "Extra usage", used: 0, display: "$12.50", aside: true },
    ],
    signIn: "kept",
  })
  // an EU org's usage is asked of the EU API, with its org
  expect(p.seen).toEqual(["api.eu.factory.ai/api/billing/limits fac_A"])
})

test("with no extra usage allowed a window used up stops the account; a half cent rounds as Go's does", () => {
  const w = _internal.limitWindows({
    limits: { standard: { fiveHour: { usedPercent: -3, windowEnd: "soon" }, weekly: null } },
    extraUsageBalanceCents: 12.5,
    extraUsageAllowed: false,
  })
  expect(w).toEqual([
    { name: "5 hours", used: 0, span: 18000, notModels: CORE },
    { name: "Extra usage", used: 0, display: "$0.12", aside: true },
  ])
})

test("no standard limits is an error", async () => {
  const p = await plugin(account(), () => json({ limits: { core: {} } }))
  expect(await p.usage()).toEqual({ error: "Factory: the account reported no limits", signIn: "kept" })
})

test("an org Factory refuses is put right and the limits asked once more", async () => {
  const refused = { error: { message: "Requested active organization is not accessible by this user" } }
  const p = await plugin(account({ activeOrganizationId: "fac_gone", region: "" }), (path, h) => {
    if (path === "/api/cli/whoami") return json({ userId: "user_1", orgId: "fac_A", region: "" })
    if (path === "/api/billing/limits")
      return h.get("X-Factory-Org-Id") === "fac_A" ? json({ limits: { standard: { fiveHour: { usedPercent: 7 } } } }) : json(refused, 403)
    return new Response("", { status: 404 })
  })
  expect(await p.usage()).toEqual({ windows: [{ name: "5 hours", used: 7, span: 18000, notModels: CORE }], signIn: "kept" })
  expect(p.seen).toEqual(["api.factory.ai/api/billing/limits fac_gone", "api.factory.ai/api/cli/whoami ", "api.factory.ai/api/billing/limits fac_A"])
  expect(p.auth().activeOrganizationId).toBe("fac_A")
})

test("another refusal is Factory's message, not retried", async () => {
  const p = await plugin(account(), () => json({ error: { message: "model not allowed" } }, 403))
  expect(await p.usage()).toEqual({ error: "Factory: model not allowed", signIn: "kept" })
  expect(p.seen.length).toBe(1)
  const q = await plugin(account(), () => new Response("upstream   went\naway", { status: 502 }))
  expect(await q.usage()).toEqual({ error: "Factory: 502 Bad Gateway: upstream went away", signIn: "kept" })
})

test("a refresh token WorkOS refuses lapses the account", async () => {
  const p = await plugin(account({ expires: Date.now() - 1000 }), (path) =>
    path === "/user_management/authenticate" ? json({ error: "invalid_grant", error_description: "gone" }, 400) : new Response("", { status: 404 }),
  )
  expect(await p.usage()).toEqual({ error: "ada's Factory sign-in has expired — sign in again (Factory: invalid_grant gone)", signIn: "expired" })
})

// the built-in's factoryFresh took the lapse mark off when it renewed the
// token, whatever the limits read then met; a read with no renewal, clean or
// not, left the mark be
test("a read that renewed the token says so, whatever the limits then answer", async () => {
  const renewing = (limits) => (path) =>
    path === "/user_management/authenticate" ? json({ access_token: "tok-new", refresh_token: "r-new" }) : path === "/api/billing/limits" ? limits() : json({}, 404)
  const p = await plugin(account({ expires: Date.now() - 1000 }), renewing(() => json({ limits: { standard: { fiveHour: { usedPercent: 7 } } } })))
  expect(await p.usage()).toEqual({ windows: [{ name: "5 hours", used: 7, span: 18000, notModels: CORE }], signIn: "renewed" })
  const q = await plugin(account({ expires: Date.now() - 1000 }), renewing(() => json({ error: { message: "busy" } }, 503)))
  expect(await q.usage()).toEqual({ error: "Factory: busy", signIn: "renewed" })
})

test("a token put in an org on the way renews it, as the built-in's factoryMendOrg took the mark off", async () => {
  const refused = { error: { message: "Requested active organization is not accessible by this user" } }
  const p = await plugin(account({ activeOrganizationId: "", region: "" }), (path, h, init) => {
    if (path === "/api/cli/org") return json({ workosOrgIds: ["org_W"] })
    if (path === "/user_management/authenticate") return json({ access_token: "tok-org" })
    if (path === "/api/billing/limits")
      return h.get("Authorization") === "Bearer tok-org" ? json({ limits: { standard: { fiveHour: { usedPercent: 1 } } } }) : json(refused, 403)
    return json({}, 404)
  })
  expect((await p.usage()).signIn).toBe("renewed")
})
