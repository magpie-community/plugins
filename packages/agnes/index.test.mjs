import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgnesPlugin, _internal } from "./index.mjs"

const {
  createPlugin,
  BASE,
  PLATFORM,
  agentWindows,
  profileLabel,
  revealApiKey,
  revealProfileKey,
  browserArgs,
  findBrowser,
  openChromeSession,
  cdpEvaluate,
  waitForBrowserToken,
} = _internal

const apiKey = "test-api-key"
const consoleToken = "console-token"
const browserToken = "browser" + "-token-value"
const auth = {
  type: "api",
  key: apiKey,
  metadata: { consoleToken, keyProfile: "plan" },
}

function jsonRes(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function fakeFetch(calls) {
  return async (input, init) => {
    calls.push({ input: String(input), init })
    return calls.handler(calls.length - 1, input, init)
  }
}

function fakeBrowserSession(token = browserToken) {
  const events = []
  let closed = false
  return {
    events,
    token: async () => token,
    evaluate: async (expression) => {
      events.push(["evaluate", expression])
    },
    close: async () => {
      closed = true
    },
    get closed() {
      return closed
    },
  }
}

describe("config", () => {
  test("declares Agnes with bootstrap text models and keeps configured values", async () => {
    const plugin = createPlugin()
    const cfg = { provider: { agnes: { name: "Mine" } } }
    await plugin.config(cfg)

    expect(cfg.provider.agnes.name).toBe("Mine")
    expect(cfg.provider.agnes.npm).toBe("@ai-sdk/openai-compatible")
    expect(cfg.provider.agnes.api).toBe(BASE)
    expect(Object.keys(cfg.provider.agnes.models)).toContain("agnes-3.0-flash")
    expect(cfg.provider.agnes.models["agnes-3.0-flash"].limit).toEqual({ context: 524288, output: 65536 })
  })
})

describe("sign-in", () => {
  test("keeps the API key for requests and the console token for usage", async () => {
    const plugin = createPlugin()
    expect(await plugin.auth.loader(async () => auth)).toEqual({
      baseURL: BASE,
      apiKey,
    })
    expect(plugin.auth.methods).toHaveLength(4)
    expect(plugin.auth.methods[0]).toMatchObject({
      type: "oauth",
      label: "Agnes browser sign-in (plan key)",
    })
    expect(typeof plugin.auth.methods[0].authorize).toBe("function")
    expect(plugin.auth.methods[1]).toMatchObject({
      type: "oauth",
      label: "Agnes browser sign-in (personal key)",
    })
    expect(plugin.auth.methods[2]).toMatchObject({
      type: "oauth",
      label: "Agnes browser sign-in (enterprise key)",
    })
    expect(plugin.auth.methods[3]).toMatchObject({ type: "api", placeholder: "cpk-…" })
    expect(plugin.auth.methods[3].prompts[0]).toMatchObject({ key: "keyProfile" })
    expect(plugin.auth.methods[3].prompts[1]).toMatchObject({ key: "consoleToken" })
  })

  test("loads an OAuth account's API key and console token", async () => {
    const plugin = createPlugin()
    const oauthAuth = { type: "oauth", access: apiKey, consoleToken, keyProfile: "plan" }
    expect(await plugin.auth.loader(async () => oauthAuth)).toEqual({
      baseURL: BASE,
      apiKey,
    })
  })
})

describe("browser sign-in callback", () => {
  test("finishes a plan-key browser sign-in", async () => {
    const calls = []
    const session = fakeBrowserSession()
    calls.handler = (_i, input) => {
      const path = new URL(String(input)).pathname.replace("/api", "")
      if (path === "/user/self") {
        expect(calls.at(-1).init.headers["x-user-language"]).toBe("en-US")
        return jsonRes(200, { code: 200, data: {} })
      }
      if (path === "/user/agentplan/subscription") {
        return jsonRes(200, { code: 404, message: "No AgentPlan subscription", data: null })
      }
      if (path === "/user/subscription/key/reveal") {
        return jsonRes(200, { code: 200, data: { key: "plan-fixture" } })
      }
      throw new Error(`unexpected ${path}`)
    }
    const plugin = createPlugin({
      fetchImpl: fakeFetch(calls),
      openChrome: async () => session,
    })

    const flow = await plugin.auth.methods[0].authorize()
    const saved = await flow.callback()

    expect(saved).toMatchObject({
      type: "success",
      access: "plan-fixture",
      consoleToken: browserToken,
      accountId: "Agnes Plan",
    })
    expect(session.closed).toBe(true)
  })

  test("finishes a personal-key browser sign-in", async () => {
    const calls = []
    const session = fakeBrowserSession()
    calls.handler = (_i, input) => {
      const path = new URL(String(input)).pathname.replace("/api", "")
      if (path === "/user/self") return jsonRes(200, { code: 200, data: {} })
      if (path === "/token") {
        return jsonRes(200, {
          code: 200,
          data: { items: [{ id: 7, key_profile: "default", status: 1 }] },
        })
      }
      if (path === "/token/7/key") {
        return jsonRes(200, { code: 200, data: { id: 7, key: "personal-fixture" } })
      }
      throw new Error(`unexpected ${path}`)
    }
    const plugin = createPlugin({
      fetchImpl: fakeFetch(calls),
      openChrome: async () => session,
    })

    const flow = await plugin.auth.methods[1].authorize()
    const saved = await flow.callback()

    expect(saved).toMatchObject({
      type: "success",
      access: "personal-fixture",
      accountId: "Agnes Personal",
    })
    expect(session.closed).toBe(true)
  })

  test("clears a refused browser session token", async () => {
    const calls = []
    const session = fakeBrowserSession()
    calls.handler = () => jsonRes(200, { code: 401, message: "not logged in", data: null })
    const plugin = createPlugin({
      fetchImpl: fakeFetch(calls),
      openChrome: async () => session,
    })

    const flow = await plugin.auth.methods[0].authorize()
    const saved = await flow.callback()

    expect(saved.type).toBe("failed")
    expect(saved.error).toContain("session expired")
    expect(session.events).toContainEqual([
      "evaluate",
      'localStorage.removeItem("token")',
    ])
    expect(session.closed).toBe(true)
    expect(calls).toHaveLength(1)
  })
})

test("exports one plugin function", async () => {
  const hooks = await AgnesPlugin()
  expect(hooks.auth.provider).toBe("agnes")
  expect(hooks.provider.id).toBe("agnes")
})

describe("provider.models", () => {
  test("lists the account's text models with documented limits and filters media models", async () => {
    const calls = []
    calls.handler = () =>
      jsonRes(200, {
        object: "list",
        data: [
          { id: "agnes-3.0-flash" },
          { id: "agnes-new-text" },
          { id: "agnes-2.5-pro-alpha" },
          { id: "agnes-image-2.5-flash" },
          { id: "agnes-video-2.5-flash" },
        ],
      })
    const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })

    const models = await plugin.provider.models({ models: {} }, { auth })

    expect(Object.keys(models)).toEqual(["agnes-3.0-flash", "agnes-new-text"])
    expect(models["agnes-3.0-flash"].limit).toEqual({ context: 524288, output: 65536 })
    expect(models["agnes-3.0-flash"].modalities.input).toEqual(["text", "image"])
    expect(models["agnes-new-text"].limit).toEqual({ context: 0, output: 0 })
    expect(models["agnes-new-text"].modalities.input).toEqual(["text"])
    expect(calls[0].input).toBe(`${BASE}/models`)
    expect(calls[0].init.headers.authorization).toBe(`Bearer ${apiKey}`)
  })

  test("keeps the previous list on a server error or network failure", async () => {
    for (const handler of [() => jsonRes(503, {}), () => Promise.reject(new Error("offline"))]) {
      const calls = []
      calls.handler = handler
      const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
      const kept = { models: { kept: { name: "kept" } } }
      expect(await plugin.provider.models(kept, { auth })).toBe(kept.models)
    }
  })

  test("marks a refused API key as expired", async () => {
    for (const status of [401, 403]) {
      const calls = []
      calls.handler = () => jsonRes(status, {})
      const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
      await expect(plugin.provider.models({ models: {} }, { auth })).rejects.toMatchObject({
        signIn: "expired",
      })
    }
  })

  test("throws on a malformed model list so the host keeps its fallback", async () => {
    for (const body of [{ data: "x" }, { data: [{ id: 42 }] }, null]) {
      const calls = []
      calls.handler = () => jsonRes(200, body)
      const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
      await expect(plugin.provider.models({ models: {} }, { auth })).rejects.toThrow(
        "Agnes sent no model list",
      )
    }
  })

  test("lists nothing per-account without an API key", async () => {
    const plugin = createPlugin()
    const kept = { models: { kept: { name: "kept" } } }
    expect(await plugin.provider.models(kept, {})).toBe(kept.models)
  })

  test("lists models for an OAuth account's API key", async () => {
    const calls = []
    calls.handler = () => jsonRes(200, { data: [{ id: "agnes-3.0-flash" }] })
    const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
    const oauthAuth = { type: "oauth", access: apiKey, consoleToken, keyProfile: "plan" }
    const models = await plugin.provider.models({ models: {} }, { auth: oauthAuth })
    expect(Object.keys(models)).toEqual(["agnes-3.0-flash"])
  })
})

const legacyPlan = {
  code: 200,
  message: "ok",
  data: {
    plan_name: "Starter",
    status: "active",
    current_period_end: "2026-11-28T09:02:07",
    cancel_renewal_at: null,
    usage: {
      text_generation: {
        windowed: {
          used: 12,
          limit: 1500,
          reset_at: "2026-10-31T12:00:00Z",
          usage_pct: 0.8,
        },
        weekly: {
          used: 120,
          limit: 15000,
          reset_at: "2026-11-02T00:00:00Z",
          usage_pct: 0.8,
        },
      },
      image_generation: {
        daily: {
          used: 60,
          limit: 4000,
          reset_at: "2026-11-01T00:00:00Z",
          usage_pct: 1.5,
        },
      },
      video_generation: {
        daily: {
          used: 115,
          limit: 500,
          reset_at: "2026-11-01T00:00:00Z",
          usage_pct: 23,
        },
      },
    },
  },
}

const agentPlan = {
  code: 200,
  message: "ok",
  data: {
    tier_name: "Pro",
    tier_code: "pro",
    status: "active",
    current_period_end: "2026-11-28T09:02:07",
    auto_renew: true,
  },
}

const agentCredits = {
  code: 200,
  message: "ok",
  data: {
    plan_quota_credits: 240000,
    plan_balance_credits: 200000,
    window_used_credits: 12000,
    window_limit_credits: 24000,
    pack_balance_credits: 50000,
  },
}

const balance = {
  code: 200,
  message: "ok",
  data: {
    topup_balance_minor: 1000,
    bonus_balance_minor: 234.56,
    total_minor: 1234.56,
    available_total_minor: 1200,
    currency: "usd",
  },
}

function platformHandler(routes) {
  return (_i, input) => {
    const path = new URL(String(input)).pathname.replace("/api", "")
    return jsonRes(200, routes[path] ?? { code: 404, message: "not found", data: null })
  }
}

describe("auth.usage", () => {
  test("asks for the console token without sending the API key to its endpoint", async () => {
    const calls = []
    calls.handler = () => {
      throw new Error("must not fetch")
    }
    const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
    const card = await plugin.auth.usage(async () => ({ type: "api", key: apiKey }))

    expect(calls).toHaveLength(0)
    expect(card.error).toContain("console token")
    expect(card.signIn).toBe("kept")
    expect(card.windows).toEqual([])
  })

  test("maps the legacy Token Plan's request, image and video windows", async () => {
    const calls = []
    calls.handler = platformHandler({
      "/user/subscription": legacyPlan,
      "/user/agentplan/subscription": { code: 404, message: "No AgentPlan subscription", data: null },
    })
    const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })

    const card = await plugin.auth.usage(async () => auth)

    expect(card.plan).toBe("Starter (Token Plan)")
    expect(card.until).toBe("2026-11-28T09:02:07.000Z")
    expect(card.renew).toBe("auto")
    expect(card.windows.map((w) => w.name)).toEqual([
      "Text · 5 hours",
      "Text · weekly",
      "Images · daily",
      "Video seconds · daily",
    ])
    expect(card.windows[0]).toMatchObject({
      used: 0.8,
      amount: 12,
      limit: 1500,
      unit: "requests",
      display: "12 / 1,500 requests",
      resetsAt: "2026-10-31T12:00:00.000Z",
    })
    expect(card.windows[2]).toMatchObject({ used: 1.5, display: "60 / 4,000 images" })
    expect(card.windows[3]).toMatchObject({ used: 23, display: "115 / 500 seconds" })
    expect(card.windows[0].aside).toBeUndefined()
    expect(card.windows[1].aside).toBeUndefined()
    expect(card.windows[2].aside).toBe(true)
    expect(card.windows[3].aside).toBe(true)
    expect(calls.map((c) => c.input)).toEqual([
      `${PLATFORM}/user/subscription`,
      `${PLATFORM}/user/agentplan/subscription`,
    ])
    for (const call of calls) {
      expect(call.init.headers.authorization).toBe(`Bearer ${consoleToken}`)
      expect(call.init.headers.authorization).not.toContain(apiKey)
    }
  })

  test("reads usage for an OAuth account's console token", async () => {
    const calls = []
    calls.handler = platformHandler({
      "/user/subscription": legacyPlan,
      "/user/agentplan/subscription": { code: 404, message: "No AgentPlan subscription", data: null },
    })
    const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
    const oauthAuth = { type: "oauth", access: apiKey, consoleToken, keyProfile: "plan" }
    const card = await plugin.auth.usage(async () => oauthAuth)
    expect(card.windows).toHaveLength(4)
  })

  test("plan accounts do not query or show balance", async () => {
    const calls = []
    calls.handler = (_i, input) => {
      const path = new URL(String(input)).pathname.replace("/api", "")
      if (path === "/user/balance") throw new Error("must not read balance")
      if (path === "/user/agentplan/subscription") {
        return jsonRes(200, { code: 404, message: "No AgentPlan subscription", data: null })
      }
      return jsonRes(200, legacyPlan)
    }
    const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })

    const card = await plugin.auth.usage(async () => auth)

    expect(card.windows).toHaveLength(4)
    expect(card.balance).toBeUndefined()
    expect(calls).toHaveLength(2)
  })

  test.each(["default", "enterprise"])(
    "%s accounts show balance without querying plan usage",
    async (keyProfile) => {
      const calls = []
      calls.handler = (_i, input) => {
        const path = new URL(String(input)).pathname.replace("/api", "")
        if (path !== "/user/balance") throw new Error(`unexpected ${path}`)
        return jsonRes(200, balance)
      }
      const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })
      const profileAuth = {
        type: "oauth",
        access:
          keyProfile === "enterprise" ? "profile-enterprise" : "profile-personal",
        consoleToken,
        keyProfile,
      }

      const card = await plugin.auth.usage(async () => profileAuth)

      expect(card.plan).toBe(
        keyProfile === "enterprise" ? "Enterprise API key" : "Personal API key",
      )
      expect(card.balance).toBe("$12.00")
      expect(card.windows).toEqual([])
      expect(calls).toHaveLength(1)
      expect(calls[0].input).toBe(`${PLATFORM}/user/balance`)
    },
  )

  test("maps Agent Plan monthly, five-hour and purchased credits", async () => {
    const calls = []
    calls.handler = platformHandler({
      "/user/subscription": { code: 404, message: "No subscription", data: null },
      "/user/agentplan/subscription": agentPlan,
      "/user/agentplan/credits": agentCredits,
    })
    const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })

    const card = await plugin.auth.usage(async () => auth)

    expect(card.plan).toBe("Pro (Agent Plan)")
    expect(card.until).toBe("2026-11-28T09:02:07.000Z")
    expect(card.renew).toBe("auto")
    expect(card.windows).toHaveLength(3)
    expect(card.windows[0]).toMatchObject({
      name: "Monthly credits",
      amount: 40000,
      limit: 240000,
      unit: "credits",
      display: "40,000 / 240,000 credits",
      resetsAt: "2026-11-28T09:02:07.000Z",
    })
    expect(card.windows[0].used).toBeCloseTo(16.67, 1)
    expect(card.windows[1]).toMatchObject({
      name: "5-hour window",
      used: 50,
      amount: 12000,
      limit: 24000,
      display: "12,000 / 24,000 credits",
    })
    expect(card.windows[2]).toMatchObject({
      name: "Purchased credits",
      balance: 50000,
      unit: "credits",
      display: "50,000 credits",
      aside: true,
    })
    expect(calls.map((c) => c.input)).toContain(`${PLATFORM}/user/agentplan/credits`)
  })

  test("shows both plans when the account holds both", async () => {
    const calls = []
    calls.handler = platformHandler({
      "/user/subscription": legacyPlan,
      "/user/agentplan/subscription": agentPlan,
      "/user/agentplan/credits": agentCredits,
    })
    const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })

    const card = await plugin.auth.usage(async () => auth)

    expect(card.plan).toBe("Pro (Agent Plan) + Starter (Token Plan)")
    expect(card.windows).toHaveLength(7)
  })

  test("falls back to the subscription's monthly credits when the balance is absent", () => {
    const windows = agentWindows(
      { current_period_end: "2026-11-28T09:02:07", monthly_credits: 100000 },
      { plan_quota_credits: null, plan_balance_credits: null },
    )

    expect(windows[0]).toMatchObject({
      name: "Monthly credits",
      used: 0,
      amount: 0,
      limit: 100000,
      display: "0 / 100,000 credits",
    })
  })

  test("a refused console token keeps the API-key sign-in", async () => {
    const calls = []
    calls.handler = (_i, input) =>
      String(input).includes("agentplan")
        ? jsonRes(200, { code: 404, message: "No AgentPlan subscription", data: null })
        : jsonRes(401, { code: 401, message: "Not logged in or invalid token", data: null })
    const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })

    const card = await plugin.auth.usage(async () => auth)

    expect(card.signIn).toBe("kept")
    expect(card.windows).toEqual([])
    expect(card.error).toContain("console token")
  })

  test("keeps a readable plan when another usage request fails", async () => {
    const calls = []
    calls.handler = (_i, input) =>
      String(input).endsWith("/user/agentplan/subscription")
        ? jsonRes(503, {})
        : jsonRes(200, legacyPlan)
    const plugin = createPlugin({ fetchImpl: fakeFetch(calls) })

    const card = await plugin.auth.usage(async () => auth)

    expect(card.windows).toHaveLength(4)
    expect(card.error).toContain("Agent Plan")
  })
})

describe("plan key reveal", () => {
  test("prefers Agent Plan's key when that plan is active", async () => {
    const calls = []
    const platform = async (path) => {
      calls.push(path)
      if (path === "/user/agentplan/subscription") return { data: { tier_code: "pro" } }
      if (path === "/user/agentplan/key/reveal") return { data: { key: "apk-key" } }
      throw new Error(`unexpected ${path}`)
    }
    expect(await revealApiKey("jwt", platform)).toBe("apk-key")
    expect(calls).toEqual(["/user/agentplan/subscription", "/user/agentplan/key/reveal"])
  })

  test("falls back to the Token Plan key", async () => {
    const calls = []
    const platform = async (path) => {
      calls.push(path)
      if (path === "/user/agentplan/subscription") return { missing: true }
      if (path === "/user/subscription/key/reveal") return { data: { key: "cpk-key" } }
      throw new Error(`unexpected ${path}`)
    }
    expect(await revealApiKey("jwt", platform)).toBe("cpk-key")
    expect(calls).toEqual(["/user/agentplan/subscription", "/user/subscription/key/reveal"])
  })
})

describe("profile key reveal", () => {
  test("selects the first active personal key and reveals it by id", async () => {
    const calls = []
    const platform = async (path, _token, options) => {
      calls.push([path, options?.method ?? "GET"])
      if (path === "/token?key_profile=default") {
        return {
          data: {
            items: [
              { id: 1, key_profile: "default", status: 0 },
              { id: 2, key_profile: "default", status: 1 },
              { id: 3, key_profile: "default", status: 1 },
            ],
          },
        }
      }
      if (path === "/token/2/key") return { data: { id: 2, key: "personal-key" } }
      throw new Error(`unexpected ${path}`)
    }
    expect(await revealProfileKey("jwt", "default", platform)).toBe("personal-key")
    expect(calls).toEqual([
      ["/token?key_profile=default", "GET"],
      ["/token/2/key", "POST"],
    ])
  })

  test("fails clearly when the profile has no active key", async () => {
    const platform = async () => ({ data: { items: [{ id: 1, status: 0 }] } })
    await expect(revealProfileKey("jwt", "enterprise", platform)).rejects.toThrow(
      "no active enterprise API key",
    )
  })
})

test("profile labels contain no account identity", () => {
  expect(profileLabel("plan")).toBe("Agnes Plan")
  expect(profileLabel("default")).toBe("Agnes Personal")
  expect(profileLabel("enterprise")).toBe("Agnes Enterprise")
})

test("browser args use a private profile and loopback debugging", () => {
  const args = browserArgs("/tmp/agnes-profile", 9222, "https://platform.agnes-ai.com/login")
  expect(args).toContain("--user-data-dir=/tmp/agnes-profile")
  expect(args).toContain("--remote-debugging-port=9222")
  expect(args).toContain("--remote-debugging-address=127.0.0.1")
  expect(args).not.toContain("--remote-allow-origins=*")
  expect(args.at(-1)).toBe("https://platform.agnes-ai.com/login")
})

test("CDP evaluation surfaces page exceptions", async () => {
  class FakeWebSocket {
    constructor() {
      setTimeout(() => {
        this.onopen?.()
      }, 0)
    }
    send() {
      setTimeout(() => {
        this.onmessage?.({
          data: JSON.stringify({
            id: 1,
            result: {
              exceptionDetails: {
                exception: { description: "SecurityError: localStorage access is denied" },
              },
            },
          }),
        })
      }, 0)
    }
    close() {}
  }

  await expect(
    cdpEvaluate("ws://127.0.0.1/fake", "localStorage.getItem('token')", 1000, FakeWebSocket),
  ).rejects.toThrow("SecurityError")
})

test("browser token polling retries page exceptions while the page loads", async () => {
  let calls = 0
  const token = await waitForBrowserToken(
    async () => {
      calls++
      if (calls <= 2) {
        throw Object.assign(new Error("SecurityError: localStorage access is denied"), {
          fatal: true,
        })
      }
      return "browser-token"
    },
    1000,
    { pollMs: 1, fatalGraceMs: 1000 },
  )

  expect(token).toBe("browser-token")
  expect(calls).toBe(3)
})

test("browser token polling reports the last page exception on timeout", async () => {
  await expect(
    waitForBrowserToken(
      async () => {
        throw Object.assign(new Error("SecurityError: localStorage access is denied"), {
          fatal: true,
        })
      },
      20,
      { pollMs: 1, fatalGraceMs: 1000 },
    ),
  ).rejects.toThrow("SecurityError: localStorage access is denied")
})

test("browser token polling gives up on a persistent page exception", async () => {
  let calls = 0
  await expect(
    waitForBrowserToken(
      async () => {
        calls++
        throw Object.assign(new Error("SecurityError: localStorage access is denied"), {
          fatal: true,
        })
      },
      1000,
      { pollMs: 1, fatalGraceMs: 5 },
    ),
  ).rejects.toThrow("SecurityError: localStorage access is denied")
  expect(calls).toBeGreaterThan(1)
})

test.skipIf(!findBrowser() || process.env.AGNES_BROWSER_TEST !== "1")(
  "browser session reads only its target page and keeps its private profile",
  async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(
          '<!doctype html><script>localStorage.setItem("token","browser-test-token")</script>',
          { headers: { "content-type": "text/html" } },
        )
      },
    })
    const profile = mkdtempSync(join(tmpdir(), "agnes-profile-test-"))
    const session = await openChromeSession(`http://127.0.0.1:${server.port}/`, {
      targetPrefix: `http://127.0.0.1:${server.port}/`,
      profileDir: profile,
    })
    try {
      expect(await session.token(20000)).toBe("browser-test-token")
    } finally {
      await session.close()
      server.stop(true)
    }
    expect(existsSync(session.profilePath)).toBe(true)
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  },
  30000,
)
