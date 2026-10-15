import { test, expect, mock, afterEach } from "bun:test"
import {
  _internal as I,
  OpenDesignAuthPlugin,
} from "./index.mjs"

// bun test runs every package's files in one process: a fetch left
// stubbed here answers every test file after this one
const realFetch = globalThis.fetch
afterEach(() => {
  mock.restore()
  globalThis.fetch = realFetch
})

// ---- the sign-in it keeps ----------------------------------------------------

test("authOf keeps both keys and the account they belong to", () => {
  expect(I.authOf({ id: "u1", email: "ada@example.com" }, { controlKey: "vela_ctrl_a", runtimeKey: "sk-amr-b" }))
    .toEqual({ type: "success", refresh: "", expires: 0, access: "sk-amr-b", control: "vela_ctrl_a", accountId: "ada@example.com", email: "ada@example.com", uid: "u1" })
})

test("authOf is nothing without both keys", () => {
  expect(I.authOf({}, { runtimeKey: "sk-amr-b" })).toBe(null)
  expect(I.authOf({}, { controlKey: "vela_ctrl_a" })).toBe(null)
  expect(I.authOf(null, {})).toBe(null)
})

test("a control key is not taken as a runtime key", () => {
  expect(I.runtimeKeyOf({ key: "vela_ctrl_a" })).toBe("")
  expect(I.runtimeKeyOf({ access: "sk-amr-b" })).toBe("sk-amr-b")
  expect(I.controlKeyOf({ key: "vela_ctrl_a" })).toBe("vela_ctrl_a")
  expect(I.controlKeyOf({ metadata: { control: "vela_ctrl_c" } })).toBe("vela_ctrl_c")
  expect(I.controlKeyOf({ access: "sk-amr-b" })).toBe("")
})

test("the poll takes the approval's keys, and says so when the code runs out", async () => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    const n = calls.length
    const body = n < 2
      ? { status: "pending", controlKey: null, runtimeKey: null, user: null }
      : { status: "approved", controlKey: "vela_ctrl_a", runtimeKey: "sk-amr-b", user: { id: "u1", email: "ada@example.com" } }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  }
  const got = await I.waitForDevice({ deviceId: "d1", deviceSecret: "s1", interval: 0, until: Date.now() + 5000 }, { sleep: async () => {} })
  expect(got).toMatchObject({ access: "sk-amr-b", control: "vela_ctrl_a", accountId: "ada@example.com", uid: "u1" })
  expect(calls[0]).toBe("https://amr-api.open-design.ai/api/v1/cli/device-authorizations/d1/token")

  globalThis.fetch = async () => new Response(JSON.stringify({ status: "expired" }), { status: 200 })
  await expect(I.waitForDevice({ deviceId: "d2", deviceSecret: "s2", interval: 0, until: Date.now() + 5000 }, { sleep: async () => {} }))
    .rejects.toThrow(/expired/)

  globalThis.fetch = async () => new Response(JSON.stringify({ error: "invalid_device_secret" }), { status: 401 })
  await expect(I.waitForDevice({ deviceId: "d3", deviceSecret: "s3", interval: 0, until: Date.now() + 5000 }, { sleep: async () => {} }))
    .rejects.toThrow(/no longer valid/)
})

// ---- what the dashboard shows ------------------------------------------------

// one reading of /workspaces/{id}/billing/preflight, as the control plane
// answers it
const PREFLIGHT = {
  balanceUsd: "1.5000",
  funding: "wallet",
  codingPlan: {
    eligible: true,
    tier: "go",
    // out of order on purpose: the plugin's own sort is what puts the 5-hour
    // window first, as the vendor's card shows them
    windows: [
      { durationSeconds: 604800, usedCredits: "16251", limitCredits: "150000", resetsAt: "2026-10-18T06:36:14.000Z" },
      { durationSeconds: 18000, usedCredits: "16251", limitCredits: "50000", resetsAt: "2026-10-11T11:36:14.000Z" },
    ],
  },
}

test("the plan's windows become magpie's, shortest first", () => {
  expect(I.allowances(PREFLIGHT.codingPlan)).toEqual([
    { name: "5 hours", used: 32.5, span: 18000, resetsAt: "2026-10-11T11:36:14.000Z", display: "16.3k / 50k credits" },
    { name: "7 days", used: 10.8, span: 604800, resetsAt: "2026-10-18T06:36:14.000Z", display: "16.3k / 150k credits" },
  ])
})

test("a window with nothing to divide is left out", () => {
  expect(I.allowances({ windows: [{ durationSeconds: 18000, usedCredits: "3", limitCredits: "0" }] })).toEqual([])
  expect(I.allowances(null)).toEqual([])
})

test("window names follow the vendor's own card", () => {
  expect(I.windowName(18000)).toBe("5 hours")
  expect(I.windowName(604800)).toBe("7 days")
  expect(I.windowName(3600)).toBe("1 hour")
  expect(I.windowName(86400)).toBe("1 day")
  expect(I.windowName(900)).toBe("15 minutes")
  expect(I.windowName(0)).toBe("Allowance")
})

test("credits are shown short", () => {
  expect(I.credits("16251")).toBe("16.3k")
  expect(I.credits("9999")).toBe("9999")
  expect(I.credits("477")).toBe("477")
  expect(I.credits("150000")).toBe("150k")
  expect(I.credits("2340000")).toBe("2.3M")
  expect(I.credits(undefined)).toBe("")
})

test("the plan reads as the dashboard names it", () => {
  expect(I.thePlan({ membershipTier: "go" }, "")).toBe("Design Plan Go")
  expect(I.thePlan(null, "pro")).toBe("Design Plan Pro")
  expect(I.thePlan(null, "")).toBe("Open Design")
})

test("the wallet shows as dollars", () => {
  expect(I.money("1.5000")).toBe("$1.50")
  expect(I.money(undefined)).toBe("")
})

// ---- the account's models ----------------------------------------------------

// one reading of amr-link's /v1/models
const CATALOG = {
  data: [
    {
      id: "gpt-6-luna",
      architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
      metadata: { cost: "low", capability: "standard", context_limit: 1050000, context_budget: 304000 },
    },
    {
      id: "deepseek-v4-pro",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      metadata: { cost: "high", capability: "advanced", context_limit: 1048000, context_budget: 232000 },
    },
    { id: "brand-new-9", architecture: { input_modalities: ["text", "image"] }, metadata: { cost: "medium", capability: "advanced" } },
  ],
}

test("the account's list is the vendor's own, live", () => {
  const models = I.modelsOf(CATALOG)
  expect(Object.keys(models)).toEqual(["gpt-6-luna", "deepseek-v4-pro", "brand-new-9"])
  expect(models["gpt-6-luna"]).toEqual({
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    reasoning: false,
    rate: "x0.5",
    tool_call: true,
    attachment: true,
    api: { npm: "@ai-sdk/openai-compatible" },
    provider: { npm: "@ai-sdk/openai-compatible" },
    limit: { context: 1050000, output: 304000 },
    modalities: { input: ["text", "image", "file"], output: ["text"] },
  })
  expect(models["deepseek-v4-pro"]).toMatchObject({ reasoning: true, rate: "x2", limit: { context: 1048000, output: 232000 } })
  // a model the seed doesn't know is named by its id, and a catalog entry
  // without limits still gets a workable entry
  expect(models["brand-new-9"]).toEqual({
    id: "brand-new-9",
    name: "brand-new-9",
    attachment: true,
    tool_call: true,
    reasoning: true,
    rate: "x1",
    api: { npm: "@ai-sdk/openai-compatible" },
    provider: { npm: "@ai-sdk/openai-compatible" },
    limit: { context: 200000, output: 32000 },
    modalities: { input: ["text", "image"], output: ["text"] },
  })
})

test("an empty catalog is no models", () => {
  expect(I.modelsOf({ data: [] })).toEqual({})
  expect(I.modelsOf(null)).toEqual({})
})

// ---- what magpie is given ----------------------------------------------------

test("the plugin declares the provider and answers its methods", async () => {
  const hooks = await OpenDesignAuthPlugin({})
  const cfg = {}
  await hooks.config(cfg)
  expect(cfg.provider.opendesign).toMatchObject({
    name: "Open Design",
    npm: "@ai-sdk/openai-compatible",
    api: "https://amr-link.open-design.ai/v1",
  })
  // the seed models.mjs carries, which a signed-in account's list replaces
  expect(Object.keys(cfg.provider.opendesign.models)).toHaveLength(11)
  expect(cfg.provider.opendesign.models["deepseek-v4.1-flash"]).toEqual({
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    attachment: true,
    tool_call: true,
    reasoning: true,
    rate: "x0.5",
    api: { npm: "@ai-sdk/openai-compatible" },
    provider: { npm: "@ai-sdk/openai-compatible" },
    limit: { context: 1048000, output: 232000 },
    modalities: { input: ["text", "image"], output: ["text"] },
  })
  expect(hooks.auth.provider).toBe("opendesign")
  expect(hooks.auth.methods.map((m) => m.type)).toEqual(["oauth", "api"])
  expect(hooks.provider.id).toBe("opendesign")
})

test("every model is asked on the API its thinking comes back on", async () => {
  const hooks = await OpenDesignAuthPlugin({})
  const cfg = {}
  await hooks.config(cfg)
  const models = cfg.provider.opendesign.models
  // most of the vendor's models answer thinking on chat completions, and the
  // compatible package is what tells magpie so
  expect(models["deepseek-v4.1-flash"].api.npm).toBe("@ai-sdk/openai-compatible")
  expect(models["deepseek-v4.1-flash"].provider.npm).toBe("@ai-sdk/openai-compatible")
  // the three asked elsewhere: two on Responses, one on Anthropic's messages
  expect(models["claude-haiku-5.5"].api.npm).toBe("@ai-sdk/openai")
  expect(models["deepseek-v4-pro"].api.npm).toBe("@ai-sdk/openai")
  expect(models["glm-5.3-flash"].api.npm).toBe("@ai-sdk/anthropic")
  // all three APIs are declared, which is what gives the provider its three
  // endpoints in magpie
  expect(new Set(Object.values(models).map((m) => m.api.npm)))
    .toEqual(new Set(["@ai-sdk/openai-compatible", "@ai-sdk/openai", "@ai-sdk/anthropic"]))
})

test("an API magpie kept from an earlier version is not kept", async () => {
  const hooks = await OpenDesignAuthPlugin({})
  // magpie hands back what the hook last wrote; a model kept from a version
  // that asked this one on the Responses API is asked where it is asked now
  const cfg = { provider: { opendesign: { models: { "glm-5.3-flash": {
    id: "glm-5.3-flash", name: "GLM 5.3 Flash", api: { npm: "@ai-sdk/openai" },
  } } } } }
  await hooks.config(cfg)
  const kept = cfg.provider.opendesign.models["glm-5.3-flash"]
  expect(kept.api.npm).toBe("@ai-sdk/anthropic")
  expect(kept.provider.npm).toBe("@ai-sdk/anthropic")
  // what magpie kept of it that is not the API stays
  expect(kept.name).toBe("GLM 5.3 Flash")
})

test("the loader hands the runtime key to the model plane", async () => {
  const hooks = await OpenDesignAuthPlugin({})
  expect(await hooks.auth.loader(async () => ({ access: "sk-amr-b", control: "vela_ctrl_a" })))
    .toEqual({ baseURL: "https://amr-link.open-design.ai/v1", apiKey: "sk-amr-b" })
  expect(await hooks.auth.loader(async () => null)).toEqual({})
})

test("the account's models are read at its own key", async () => {
  const hooks = await OpenDesignAuthPlugin({})
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push([String(url), new Headers(init.headers).get("authorization")])
    return new Response(JSON.stringify(CATALOG), { status: 200, headers: { "content-type": "application/json" } })
  }
  const given = { models: {} }
  const models = await hooks.provider.models(given, { auth: { access: "sk-amr-b", control: "vela_ctrl_a" } })
  expect(seen).toEqual([["https://amr-link.open-design.ai/v1/models", "Bearer sk-amr-b"]])
  expect(Object.keys(models)).toEqual(["gpt-6-luna", "deepseek-v4-pro", "brand-new-9"])

  // a vendor that refuses the key marks the account
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "invalid_api_key" } }), { status: 401 })
  await expect(hooks.provider.models(given, { auth: { access: "sk-amr-b" } })).rejects.toThrow(/invalid_api_key/)
  // a vendor hiccup keeps the list magpie had
  globalThis.fetch = async () => new Response("{}", { status: 500 })
  expect(await hooks.provider.models(given, { auth: { access: "sk-amr-b" } })).toBe(given.models)
  // nothing signed in: the list it was given
  expect(await hooks.provider.models(given, { auth: null })).toBe(given.models)
})

test("usage reads the plan, the wallet and the windows at the control key", async () => {
  const hooks = await OpenDesignAuthPlugin({})
  const seen = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    seen.push([u, new Headers(init.headers).get("authorization")])
    if (u.endsWith("/api/v1/workspaces/current")) return new Response(JSON.stringify({ activeWorkspaceId: "ws1", personalMembershipTier: "go" }), { status: 200 })
    if (u.includes("/billing/preflight")) return new Response(JSON.stringify(PREFLIGHT), { status: 200 })
    if (u.includes("/billing/summary")) {
      return new Response(JSON.stringify({
        membershipTier: "go",
        subscriptionStatus: "active",
        subscriptionCancelAtPeriodEnd: false,
        subscriptionCurrentPeriodEnd: "2026-11-11T06:36:14.000Z",
        balanceUsd: "1.5000",
      }), { status: 200 })
    }
    return new Response("{}", { status: 404 })
  }
  const auth = { access: "sk-amr-b", control: "vela_ctrl_a", email: "ada@example.com" }
  expect(await hooks.auth.usage(async () => auth)).toEqual({
    plan: "Design Plan Go",
    user: "ada@example.com",
    balance: "$1.50",
    until: "2026-11-11T06:36:14.000Z",
    renew: "auto",
    windows: [
      { name: "5 hours", used: 32.5, span: 18000, resetsAt: "2026-10-11T11:36:14.000Z", display: "16.3k / 50k credits" },
      { name: "7 days", used: 10.8, span: 604800, resetsAt: "2026-10-18T06:36:14.000Z", display: "16.3k / 150k credits" },
    ],
    signIn: "kept",
  })
  expect(seen.every(([, key]) => key === "Bearer vela_ctrl_a")).toBe(true)
})

test("usage says a refused sign-in marks the account, and that an API key has none", async () => {
  const hooks = await OpenDesignAuthPlugin({})
  globalThis.fetch = async (url) => (String(url).endsWith("/workspaces/current")
    ? new Response(JSON.stringify({ activeWorkspaceId: "ws1" }), { status: 200 })
    : new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }))
  expect(await hooks.auth.usage(async () => ({ access: "sk-amr-b", control: "vela_ctrl_a" })))
    .toMatchObject({ signIn: "expired", windows: [] })

  expect(await hooks.auth.usage(async () => ({ access: "sk-amr-b" })))
    .toMatchObject({ signIn: "kept", windows: [], error: expect.stringMatching(/API key/) })
})

test("the API key method takes the key as it is", async () => {
  const hooks = await OpenDesignAuthPlugin({})
  const m = hooks.auth.methods.find((x) => x.type === "api")
  expect(m.type).toBe("api")
  // magpie's own prompt saves what the user pasted; the plugin adds nothing
  expect(m.authorize).toBeUndefined()
})

test("everything the manifest ships is on disk", async () => {
  // `files` naming a file that isn't there ships a package missing it, which
  // is how 0.1.2 went out without refresh-models.mjs. The manifest is found
  // by walking up, so this file works in `test/` and at a package root alike.
  const { existsSync } = await import("node:fs")
  const { dirname, join } = await import("node:path")
  const { fileURLToPath } = await import("node:url")
  let root = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(root, "package.json"))) {
    const up = dirname(root)
    if (up === root) throw new Error("no package.json above this test")
    root = up
  }
  const pkg = await Bun.file(join(root, "package.json")).json()
  for (const f of pkg.files) expect(existsSync(join(root, f))).toBe(true)
  // the plugin's own imports are among them (npm ships package.json itself,
  // whatever `files` says)
  const src = await Bun.file(join(root, pkg.main ?? "index.mjs")).text()
  const imports = [...src.matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]).filter((f) => f !== "package.json")
  expect(imports.length).toBeGreaterThan(0)
  for (const spec of imports) expect(pkg.files).toContain(spec)
})
