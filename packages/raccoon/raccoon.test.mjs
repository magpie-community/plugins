import { expect, test } from "bun:test"
import { RaccoonAuthPlugin, _internal } from "./index.mjs"

function fakeJwt(claims) {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${h}.${p}.sig`
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
  const work = models.find((m) => m.id === "raccoon-8c4485")
  expect(work).toMatchObject({
    id: "raccoon-8c4485",
    name: "Raccoon-Work",
    context: 1000000,
    output: 100000,
    images: true,
    free: false,
    rate: 1,
  })
  const flash = models.find((m) => m.id === "sn-sensenova-6-8-flash")
  expect(flash).toMatchObject({
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

test("rewrites SSE chunk model name to requested model", async () => {
  const body = 'data: {"id":"1","model":"internal-raccoon","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
  const orig = new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
  const rewritten = await _internal.rewriteSseModel(orig, "sn-glm-5-3", "kept")
  expect(rewritten.headers.get("x-magpie-sign-in")).toBe("kept")
  const text = await rewritten.text()
  expect(text).toContain('"model":"sn-glm-5-3"')
  expect(text).toContain("data: [DONE]")
})

test("plugin hook shape satisfies OpenCode and magpie check", async () => {
  const client = {
    app: { log: async () => {} },
    auth: { set: async () => {} },
    tui: { showToast: async () => {} },
    config: { get: async () => ({ data: {} }) },
  }
  const hooks = await RaccoonAuthPlugin({ client, directory: process.cwd(), worktree: process.cwd(), project: {} })
  expect(hooks.auth.provider).toBe("raccoon")
  expect(typeof hooks.auth.loader).toBe("function")
  expect(typeof hooks.auth.usage).toBe("function")
  expect(typeof hooks.auth.checkin).toBe("function")
  expect(hooks.auth.methods.length).toBeGreaterThanOrEqual(2)
  const cfg = { provider: {} }
  await hooks.config(cfg)
  expect(cfg.provider.raccoon.npm).toBe("@ai-sdk/openai-compatible")
  expect(Object.keys(cfg.provider.raccoon.models).length).toBeGreaterThanOrEqual(5)
})
