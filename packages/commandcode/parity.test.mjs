// What magpie's built-in Command Code did that the plugin must too
// (internal/provider/commandcode_plan.go, internal/gateway/commandcode.go):
// the month's credits renew at the plan's period's end (yetone/magpie#2454),
// the models the CLI calls free are free (cmdFree), and a Go request's
// max_tokens stays within the 200,000 Command Code takes
// (CommandCodeMaxOutput).
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CommandCodePlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.subsSeen.clear()
  _internal.extraSeen.clear()
})

// magpie's cmdFree, exactly
const BUILTIN_FREE = [
  "stealth/space-bunny-alpha", "stealth/pixel-canary",
  "poolside/laguna-s-2.1-free", "inclusionai/ling-3.0-flash-free",
  "inclusionai/ling-3.0-flash-sante:free", "inclusionai/ling-3.1-flash:free",
  "MiniMaxAI/MiniMax-M3-Free", "minimax/minimax-m3-free",
  "minimax/minimax-m2.7-free", "meituan/LongCat-2.0:free", "tencent/Hy3",
]

test("the Credits window renews when the plan's period ends", async () => {
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    if (path === "/alpha/billing/subscriptions")
      return Response.json({ success: true, data: { planId: "individual-pro-monthly", status: "active", currentPeriodEnd: "2026-11-02T08:00:00Z" } })
    if (path === "/alpha/billing/credits") return Response.json({ credits: { monthlyCredits: 12 } })
    return new Response("", { status: 404 })
  }
  const hooks = await CommandCodePlugin()
  const u = await hooks.auth.usage(async () => ({ type: "api", key: "k" }))
  expect(u.windows).toEqual([{ name: "Credits", used: 60, display: "$18.00 / $30.00", amount: 18, limit: 30, resetsAt: "2026-11-02T08:00:00.000Z" }])
  expect(u.until).toBe("2026-11-02T08:00:00.000Z")
})

test("no period end, no reset on the Credits window", async () => {
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    if (path === "/alpha/billing/subscriptions") return Response.json({ data: { planId: "individual-go", status: "active" } })
    if (path === "/alpha/billing/credits") return Response.json({ credits: { monthlyCredits: 4 } })
    return new Response("", { status: 404 })
  }
  const hooks = await CommandCodePlugin()
  const u = await hooks.auth.usage(async () => ({ type: "api", key: "k" }))
  expect(u.windows).toEqual([{ name: "Credits", used: 60, display: "$6.00 / $10.00", amount: 6, limit: 10 }])
})

// a list of every free id and two paid ones, as the Provider API gives it
const listed = {
  data: [...BUILTIN_FREE, "deepseek/deepseek-v4-pro", "moonshotai/Kimi-K3"].map((id) => ({ id, context_length: 200000 })),
}

async function modelsOf(plan) {
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    if (path === "/alpha/billing/subscriptions") return Response.json({ data: { planId: plan, status: "active" } })
    if (path === "/alpha/billing/credits") return Response.json({ credits: { monthlyCredits: 1 } })
    if (path === "/provider/v1/models") return Response.json(listed)
    return new Response("", { status: 404 })
  }
  const hooks = await CommandCodePlugin()
  return hooks.provider.models({ models: {} }, { auth: { type: "api", key: "k-" + plan } })
}

for (const plan of ["individual-max-monthly", "individual-go"]) {
  test(`${plan}: the models the CLI calls free are free, and no other`, async () => {
    const ms = await modelsOf(plan)
    const free = Object.values(ms).filter((m) => m.free === true).map((m) => m.id)
    expect(free.sort()).toEqual([...BUILTIN_FREE].sort())
    expect(ms["deepseek/deepseek-v4-pro"].free).toBeUndefined()
  })
}

test("the Go table's free models are free when the list can't be had", async () => {
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    if (path === "/alpha/billing/subscriptions") return Response.json({ data: { planId: "individual-go", status: "active" } })
    return new Response("", { status: 503 })
  }
  const hooks = await CommandCodePlugin()
  const ms = await hooks.provider.models({ models: {} }, { auth: { type: "api", key: "go-k", metadata: { plan: "Go" } } })
  const free = Object.values(ms).filter((m) => m.free).map((m) => m.id).sort()
  expect(free).toEqual(_internal.GO_MODELS.map((m) => m.id).filter((id) => BUILTIN_FREE.includes(id)).sort())
  expect(free.length).toBe(6)
})

// sent asks a Go chat completion with max_tokens asked and says the
// max_tokens /alpha/generate was sent
async function sent(asked) {
  let body
  globalThis.fetch = async (url, init) => {
    if (new URL(String(url)).pathname === "/alpha/generate") {
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({ type: "text-delta", text: "ok" }) + "\n" + JSON.stringify({ type: "finish", finishReason: "stop" }) + "\n")
    }
    return new Response("", { status: 404 })
  }
  const hooks = await CommandCodePlugin()
  const opts = await hooks.auth.loader(async () => ({ type: "api", key: "go-key", metadata: { plan: "Go" } }))
  await (await opts.fetch("https://api.commandcode.ai/provider/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", messages: [{ role: "user", content: "hi" }], ...asked }),
  })).text()
  return body.params.max_tokens
}

test("a Go request's max_tokens stays within the 200,000 Command Code takes", async () => {
  expect(await sent({ max_tokens: 384_000 })).toBe(200_000)
  expect(await sent({ max_completion_tokens: 512_000 })).toBe(200_000)
  expect(await sent({ max_tokens: 8_000 })).toBe(8_000)
  expect(await sent({})).toBe(64_000)
})
