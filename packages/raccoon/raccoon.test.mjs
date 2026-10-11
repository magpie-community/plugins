import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RaccoonAuthPlugin, _internal } from "./index.mjs"

function fakeJwt(claims) {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${h}.${p}.sig`
}

let server = null
let tempDir = null

afterEach(() => {
  server?.stop(true)
  server = null
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  }
  delete process.env.RACCOON_MAIN_SITE_URL
  delete process.env.RACCOON_BOX_AGENT_CONFIG_DIR
  _internal.renewed.clear()
  _internal.renewing.clear()
})

function startServer(routes) {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      const key = `${req.method} ${u.pathname}`
      const handler = routes[key] || routes[u.pathname]
      if (!handler) return new Response(JSON.stringify({ code: 404, message: "not found" }), { status: 404 })
      return handler(req, u)
    },
  })
  process.env.RACCOON_MAIN_SITE_URL = `http://127.0.0.1:${server.port}`
  return server
}

test("decodes JWT claims and converts hex user id to decimal", () => {
  const tok = fakeJwt({ iss: "74350b", name: "RaccoonMason", exp: 1800000000 })
  const claims = _internal.decodeJwtClaims("Bearer " + tok)
  expect(_internal.extractUserId(claims)).toBe("7615755")
  expect(_internal.extractDisplayName(claims)).toBe("RaccoonMason")
  expect(_internal.jwtExpiryMs(tok)).toBe(1800000000 * 1000)
})

test("parses model_catalog entries with effective multiplier and limited_free", () => {
  const models = _internal.parseCatalog({
    code: 0,
    data: {
      categories: [
        {
          type: "chat",
          models: [
            {
              name: "raccoon-8c4485",
              description: "Raccoon-Work",
              tags: ["general", "code", "vision", "reasoning"],
              params: { context_window: 1000000, max_tokens: 100000 },
              billing_multiplier: 1,
              billing_effective_multiplier: 1,
            },
            {
              name: "sn-sensenova-6-8-flash",
              description: "SenseNova-6.8-Flash",
              tags: ["general", "vision", "fast"],
              params: { context_window: 256000, max_tokens: 63999 },
              billing_multiplier: 0.5,
              billing_effective_multiplier: 0,
              billing_status: "limited_free",
            },
          ],
        },
      ],
    },
  })
  expect(models.find((m) => m.id === "raccoon-8c4485")).toMatchObject({
    id: "raccoon-8c4485",
    name: "Raccoon-Work",
    context: 1000000,
    output: 100000,
    images: true,
    free: false,
    rate: 1,
  })
  expect(models.find((m) => m.id === "sn-sensenova-6-8-flash")).toMatchObject({
    id: "sn-sensenova-6-8-flash",
    name: "SenseNova-6.8-Flash",
    images: true,
    free: true,
    rate: 0,
    rateWas: 0.5,
  })
})

test("parses callback URL and direct tokens", () => {
  expect(_internal.parseCallbackInput("office-raccoon://auth/callback?code=abc123&state=s1", "s1")).toEqual({
    code: "abc123",
  })
  expect(() => _internal.parseCallbackInput("office-raccoon://auth/callback?code=abc123&state=wrong", "s1")).toThrow()
  const tok = fakeJwt({ iss: "74350b", exp: 1800000000 })
  expect(_internal.parseCallbackInput(tok, "s1")).toEqual({
    direct: { access: tok, refresh: "" },
  })
})

test("rewrites SSE chunk model name and normalizes CRLF endings", async () => {
  const body = 'data: {"id":"1","model":"internal-raccoon","choices":[{"delta":{"content":"hi"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'
  const orig = new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
  const rewritten = await _internal.rewriteSseModel(orig, "sn-glm-5-3", "kept")
  expect(rewritten.headers.get("x-magpie-sign-in")).toBe("kept")
  const text = await rewritten.text()
  expect(text).toContain('"model":"sn-glm-5-3"')
  expect(text).not.toContain("\r")
  expect(text).toContain("data: [DONE]")
})

test("refresh 400 params_invalid_error marks signIn expired and uses details", async () => {
  startServer({
    "POST /api/web/auth/v1/refresh": () =>
      new Response(
        JSON.stringify({
          code: 100002,
          message: "params_invalid_error",
          details: "refresh token is invalid or expired",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const staleTok = fakeJwt({ iss: "74350b", exp: Math.floor(Date.now() / 1000) - 10 })
  const u = await hooks.auth.usage(async () => ({
    type: "oauth",
    access: staleTok,
    refresh: "bad-rt",
    expires: Date.now() - 10_000,
  }))
  expect(u.signIn).toBe("expired")
  expect(u.error).toContain("refresh token is invalid or expired")
})

test("desktop sign-in is read-only and never writes or refreshes auth.json", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "raccoon-test-"))
  process.env.RACCOON_BOX_AGENT_CONFIG_DIR = tempDir
  const authFile = join(tempDir, "auth.json")
  const staleTok = fakeJwt({ iss: "74350b", name: "DeskUser", exp: Math.floor(Date.now() / 1000) - 10 })
  const originalContent = JSON.stringify({ access_token: staleTok, refresh_token: "D1" }, null, 2)
  writeFileSync(authFile, originalContent)

  let refreshCalled = false
  startServer({
    "POST /api/web/auth/v1/refresh": () => {
      refreshCalled = true
      return Response.json({ code: 0, data: { access_token: "x", refresh_token: "D2" } })
    },
  })

  const hooks = await RaccoonAuthPlugin({ client: {} })
  const res = await hooks.auth.usage(async () => ({ type: "oauth", source: "desktop" }))
  expect(refreshCalled).toBe(false)
  expect(res.signIn).toBe("expired")
  expect(await Bun.file(authFile).text()).toBe(originalContent)
})

test("usage does not invent 300/9000 floors when bills do not cover balance", async () => {
  const validTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  startServer({
    "GET /api/web/points/v1/balance": () =>
      Response.json({
        code: 0,
        data: { available_points: 500, daily_points: 0, reward_points: 500, monthly_points: 0, topup_points: 0 },
      }),
    "GET /api/web/auth/v1/entitlement_info": () => Response.json({ code: 0, data: {} }),
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => ({
    type: "oauth",
    access: validTok,
    refresh: "rt1",
    expires: Date.now() + 3600_000,
  }))
  expect(u.balance).toBe("500 credits")
  expect(u.windows).toEqual([])
})

test("usage reports Credits window when unexpired bills account for total granted", async () => {
  const validTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  startServer({
    "GET /api/web/points/v1/balance": () =>
      Response.json({
        code: 0,
        data: { available_points: 9519, daily_points: 519, reward_points: 9000, monthly_points: 0, topup_points: 0 },
      }),
    "GET /api/web/auth/v1/entitlement_info": () => Response.json({ code: 0, data: {} }),
    "GET /api/web/points/v1/bills": () =>
      Response.json({
        code: 0,
        data: {
          items: [
            { bill_id: "b1", biz_type: "daily_grant", points: 300, expire_at: "2029-10-18T23:59:59+08:00" },
            { bill_id: "b2", biz_type: "daily_grant", points: 300, expire_at: "2029-10-17T23:59:59+08:00" },
            { bill_id: "b3", biz_type: "reward_grant", points: 9000 },
          ],
        },
      }),
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => ({
    type: "oauth",
    access: validTok,
    refresh: "rt1",
    expires: Date.now() + 3600_000,
  }))
  expect(u.balance).toBeUndefined()
  expect(u.windows.length).toBe(1)
  expect(u.windows[0]).toMatchObject({
    name: "Credits",
    amount: 81,
    limit: 9600,
    display: "81 / 9600",
    unit: "credits",
  })
})

test("checkin preserves renewed tokens, claims once, and returns done on second call", async () => {
  const staleTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) - 5 })
  const freshTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  const today = _internal.beijingTodayKey()
  const billItems = []

  startServer({
    "POST /api/web/auth/v1/refresh": () =>
      Response.json({ code: 0, data: { access_token: freshTok, refresh_token: "C2" } }),
    "GET /api/web/office/v3/setting_info": () => {
      if (!billItems.some((b) => b.bill_id === "daily-1")) {
        billItems.push({
          bill_id: "daily-1",
          biz_type: "daily_grant",
          event_name: "每日积分发放",
          points: 300,
          created_at: `${today}T08:00:00+08:00`,
        })
      }
      return Response.json({ code: 0, data: {} })
    },
    "POST /api/web/desktop/v1/login/points/grant": () =>
      Response.json({ code: 0, data: { granted: false } }),
    "GET /api/web/points/v1/bills": () =>
      Response.json({ code: 0, data: { items: billItems } }),
  })

  const saves = []
  let stored = {
    type: "oauth",
    access: staleTok,
    refresh: "C1",
    expires: Date.now() - 5000,
  }
  const client = {
    auth: {
      set: async ({ body }) => {
        saves.push(body)
        stored = body
      },
    },
  }
  const hooks = await RaccoonAuthPlugin({ client })

  const r1 = await hooks.auth.checkin(async () => stored)
  expect(r1).toMatchObject({ outcome: "claimed", credit: 300 })
  expect(saves.at(-1).access).toBe(freshTok)
  expect(saves.at(-1).refresh).toBe("C2")
  expect(saves.at(-1).onboardingSettled).toBe(true)

  const r2 = await hooks.auth.checkin(async () => stored)
  expect(r2).toMatchObject({ outcome: "done" })
})

test("checkin returns failed instead of throwing when upstream errors", async () => {
  const validTok = fakeJwt({ iss: "74350b", exp: Math.floor(Date.now() / 1000) + 3600 })
  startServer({
    "GET /api/web/office/v3/setting_info": () => new Response("unauthorized", { status: 401 }),
    "GET /api/web/points/v1/bills": () => new Response("unauthorized", { status: 401 }),
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const r = await hooks.auth.checkin(async () => ({
    type: "oauth",
    access: validTok,
    refresh: "",
    expires: Date.now() + 3600_000,
    onboardingSettled: true,
  }))
  expect(r.outcome).toBe("failed")
})
