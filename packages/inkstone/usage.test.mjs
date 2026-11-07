// The credit card: the console's balance, windows and credit packs as magpie's
// usage card. Everything runs against the local fake; a read that fails must
// say so rather than show a fake zero. Per-model token spend belongs to the
// usage page, not this card.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { InkStoneAuthPlugin } from "./index.mjs"
import { fakeInkStone, ok, poolUsageFixture, packagesFixture } from "./fake.mjs"

let f
afterEach(() => f?.close())

const auth = { type: "oauth", access: "sk-test", apiKey: "sk-test", uaaToken: "uaa-token" }

async function plugin(options = {}) {
  return InkStoneAuthPlugin({ client: { auth: { set: async () => {} } } }, options)
}

function serve({ free = ok({ has_received: true }), validate = ok({ name: "张三", phone: "12345678901" }) } = {}) {
  f.route("GET /api/tokenplan/v1/credits/balance", () => ok(poolUsageFixture()))
  f.route("GET /api/tokenplan/v1/credits/packages", () => ok(packagesFixture()))
  f.route("GET /api/tokenplan/v1/users/validate", () => validate)
  f.route("POST /api/tokenplan/v1/users/free-grant", () => free)
}

test("balance, 5h/7d windows and the credit packs become the card", async () => {
  f = fakeInkStone()
  serve()
  const p = await plugin()
  const u = await p.auth.usage(async () => auth)
  expect(u.plan).toBe("墨点计划 (Token Plan)")
  expect(u.user).toBe("123****8901")
  expect(u.balance).toBe("10 墨点 · 2 个可用包")
  expect(u.signIn).toBe("kept")

  const five = u.windows.find((w) => w.name === "5 hours")
  expect(five.used).toBeCloseTo(35, 1)
  expect(five.display).toBe("3.5 / 10")
  expect(five.resetsAt).toBe("2026-11-05T08:00:00.000Z")
  const seven = u.windows.find((w) => w.name === "7 days")
  expect(seven.used).toBeCloseTo(17.6, 1)
  expect(seven.display).toBe("8.8 / 50")

  const names = u.windows.map((w) => w.name)
  expect(names).toContain("每月免费基础包")
  expect(names).toContain("扩容包")
  expect(names).toContain("限速")
  expect(names).not.toContain("最近到期")

  // the expiry day is the viewer's calendar day: derive the expected string
  // from the same local parse instead of a fixed UTC date (a fixed date fails
  // in far-east zones, where 2026-11-28T12:00Z is already the 29th)
  const endDay = (() => {
    const d = new Date("2026-11-28T12:00:00Z")
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  })()
  expect(u.windows.find((w) => w.name === "每月免费基础包").display).toBe(`剩 6.5 / 10 · ${endDay} 到期`)
  // amount is the used share (10 - 6.5), not the remainder
  expect(u.windows.find((w) => w.name === "每月免费基础包").used).toBe(35)
  expect(u.windows.find((w) => w.name === "每月免费基础包").amount).toBe(3.5)
  expect(u.windows.find((w) => w.name === "每月免费基础包").limit).toBe(10)
  expect(u.windows.find((w) => w.name === "每月免费基础包").runsOutAt).toBe("2026-11-28T12:00:00.000Z")
  expect(u.windows.find((w) => w.name === "每月免费基础包").runsOut).toBe(6.5)
  expect(u.windows.find((w) => w.name === "限速").display).toBe("50 RPM · 2,000,000 TPM")
  expect(u.windows.find((w) => w.name === "本月免费额度")).toBeUndefined()
  // the card carries no per-model rows: token spend is the usage page's job
  expect(names.some((n) => n.startsWith("模型 "))).toBe(false)
  expect(names).not.toContain("本月已用")
  expect(names).not.toContain("今日 tokens")
  // the pack rows never become meters
  expect(u.windows.find((w) => w.name === "每月免费基础包").aside).toBe(true)
})

test("a usage read asks only the three credit APIs — no per-model calls", async () => {
  f = fakeInkStone()
  serve()
  const p = await plugin()
  await p.auth.usage(async () => auth)
  const paths = f.seen.map((r) => r.path)
  expect(paths.some((p) => p.endsWith("/models/called"))).toBe(false)
  expect(paths.some((p) => p.endsWith("/usage/summary"))).toBe(false)
  expect(paths.some((p) => p.endsWith("/credits/transactions"))).toBe(false)
  expect(paths.some((p) => p.endsWith("/credits/balance"))).toBe(true)
  expect(paths.some((p) => p.endsWith("/credits/packages"))).toBe(true)
})

test("the card is cached briefly: a second read in the same minute asks nothing new", async () => {
  f = fakeInkStone()
  serve()
  const p = await plugin()
  await p.auth.usage(async () => auth)
  const balanceCalls = f.seen.filter((r) => r.path.endsWith("/credits/balance")).length
  await p.auth.usage(async () => auth)
  expect(f.seen.filter((r) => r.path.endsWith("/credits/balance")).length).toBe(balanceCalls)
})

test("reading usage never claims free credits; magpie decides with auth.checkin", async () => {
  f = fakeInkStone()
  serve()
  const p = await plugin()
  const u = await p.auth.usage(async () => auth)
  expect(f.seen.some((r) => r.method === "POST" && r.path.endsWith("/users/free-grant"))).toBe(false)
  expect(u.windows.some((w) => w.name === "本月免费额度")).toBe(false)
})

test("auth.checkin claims the monthly grant through magpie's hook", async () => {
  f = fakeInkStone()
  serve()
  const p = await plugin()
  const r = await p.auth.checkin(async () => auth)
  expect(r).toEqual({ outcome: "done" })
  expect(f.seen.filter((r) => r.method === "POST" && r.path.endsWith("/users/free-grant")).length).toBe(1)
})

test("auth.checkin says the account can't take part when the phone is missing", async () => {
  f = fakeInkStone()
  serve({
    free: new Response(JSON.stringify({ code: -15900, msg: "PhoneRequired", data: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  })
  const p = await plugin()
  const r = await p.auth.checkin(async () => auth)
  expect(r.outcome).toBe("ineligible")
})

test("a console 401 for auth.checkin is a plain failure: the host's checkin path reads no signIn", async () => {
  f = fakeInkStone()
  // keep_sign_in off: the 401 path must not launch a browser in the test
  const p = await plugin({ keep_sign_in: false })
  f.route("POST /api/tokenplan/v1/users/free-grant", () => new Response("", { status: 401 }))
  const r = await p.auth.checkin(async () => auth)
  expect(r).toEqual({ outcome: "failed", message: expect.stringContaining("401") })
})

test("no console token: the card says how to get one, and models stay usable", async () => {
  f = fakeInkStone()
  const p = await plugin()
  const u = await p.auth.usage(async () => ({ type: "api", key: "sk-test" }))
  expect(u.error).toContain("ink credits")
  expect(u.windows).toEqual([])
  expect(u.signIn).toBe("kept")
})

test("a console 401 is an error, not an empty balance, and does not sign the account out", async () => {
  f = fakeInkStone()
  f.route("GET /api/tokenplan/v1/credits/balance", () => new Response("", { status: 401 }))
  // keep_sign_in off: the 401 path must not launch a browser in the test
  const p = await plugin({ keep_sign_in: false })
  const u = await p.auth.usage(async () => auth)
  expect(u.error).toContain("console session expired")
  expect(u.signIn).toBe("kept")
})

test("a console 403 is reported as a disabled account, not as a broken balance", async () => {
  f = fakeInkStone()
  f.route("GET /api/tokenplan/v1/credits/balance", () => new Response("", { status: 403 }))
  const p = await plugin({ keep_sign_in: false })
  const u = await p.auth.usage(async () => auth)
  expect(u.error).toBe("TokenPlan account disabled in the console")
  expect(u.signIn).toBe("kept")
  expect(u.balance).toBeUndefined()
})

test("a balance read that fails for another reason keeps the reason and no fake zero", async () => {
  f = fakeInkStone()
  f.route("GET /api/tokenplan/v1/credits/balance", () => new Response("", { status: 503 }))
  const p = await plugin()
  const u = await p.auth.usage(async () => auth)
  expect(u.error).toContain("credit balance")
  expect(u.balance).toBeUndefined()
  expect(u.signIn).toBe("kept")
})

test("a zero balance is shown as 0 credits, never hidden or treated as a read failure", async () => {
  f = fakeInkStone()
  serve()
  f.route("GET /api/tokenplan/v1/credits/balance", () =>
    ok({
      available_credits: 0,
      active_package_count: 0,
      usage_windows: {
        "5h": { enabled: true, limit_credits: 10, remaining_credits: 0 },
      },
    }),
  )
  f.route("GET /api/tokenplan/v1/credits/packages", () => ok({ total: 0, packages: [] }))
  const p = await plugin()
  const u = await p.auth.usage(async () => auth)
  expect(u.balance).toBe("0 墨点")
  expect(u.error).toBeUndefined()
})

test("a phone number missing before free credits is reported by auth.checkin", async () => {
  f = fakeInkStone()
  serve({ validate: ok({ name: "张三", phone: "" }) })
  f.route("POST /api/tokenplan/v1/users/free-grant", () =>
    new Response(JSON.stringify({ code: -15900, msg: "PhoneRequired", data: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  )
  const p = await plugin()
  const u = await p.auth.usage(async () => auth)
  // 插件不再自动 claim，也不会因手机号缺失污染卡片；该状态由宿主的 checkin 处理。
  expect(u.error).toBeUndefined()
  expect(u.windows.some((w) => w.name === "本月免费额度")).toBe(false)
  const r = await p.auth.checkin(async () => auth)
  expect(r).toEqual({
    outcome: "ineligible",
    message: "Bind a phone number in the InkStone console to claim free credits.",
  })
})

// #826: the "API key + console token" method is an api method, and magpie's
// host save() keeps its answers under metadata, not at the top level:
// {type: "api", key, metadata: {...inputs, ...result.metadata}}.
test("an api entry with the token under metadata (as host save() writes it) reads the card", async () => {
  f = fakeInkStone()
  serve()
  const p = await plugin()
  for (const field of ["uaaToken", "uaa_token", "consoleToken"]) {
    const saved = { type: "api", key: "sk-test", metadata: { apiKey: "sk-test", [field]: "uaa-token" } }
    const u = await p.auth.usage(async () => saved)
    expect(u.error).toBeUndefined()
    expect(u.balance).toBe("10 墨点 · 2 个可用包")
  }
})
