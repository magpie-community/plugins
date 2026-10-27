// auth.usage tells what magpie's built-in Grok account shows
// (internal/provider/grok_usage.go), against the CLI backend's replies as
// its tests give them (grok_usage_test.go).
import { noRealGrok } from "./nocli.mjs"
import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GrokAuthPlugin, _internal } from "./index.mjs"

noRealGrok()

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

// a CLI home whose token is good for a day, so nothing renews it
const home = mkdtempSync(join(tmpdir(), "grok-usage-"))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const expires = new Date(Date.now() + 24 * 3600_000).toISOString()
writeFileSync(join(home, "auth.json"), JSON.stringify({ a: { key: "tok-2", email: "g@x.ai", expires_at: expires } }))
const auth = { type: "oauth", refresh: home, access: "tok-1", expires: 0, accountId: "g@x.ai" }

async function run(a, reply) {
  const seen = []
  const saved = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers })
    return reply()
  }
  const client = { auth: { set: async (x) => saved.push(x) } }
  const hooks = await GrokAuthPlugin({ client })
  return { u: await hooks.auth.usage(async () => a), seen, saved }
}

test("SuperGrok's week and its on-demand spending; the CLI's newer token is kept", async () => {
  const { u, seen, saved } = await run(auth, () =>
    Response.json({
      config: {
        creditUsagePercent: 42.5,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-21T02:17:59.504011+00:00", end: "2026-09-28T02:17:59.504011+00:00" },
        onDemandCap: { val: 2000 },
        onDemandUsed: { val: 500 },
        billingPeriodEnd: "2026-09-28T02:17:59.504011+00:00",
      },
    }),
  )
  expect(u).toEqual({
    signIn: "kept",
    windows: [
      { name: "7 days", used: 42.5, span: 604800, resetsAt: "2026-09-28T02:17:59.504011+00:00" },
      { name: "On-demand", used: 25, resetsAt: "2026-09-28T02:17:59.504011+00:00", aside: true },
    ],
  })
  expect(seen).toEqual([{ url: "https://cli-chat-proxy.grok.com/v1/billing?format=credits", headers: { Authorization: "Bearer tok-2", Accept: "application/json" } }])
  expect(saved).toEqual([{ path: { id: "grok" }, body: { ...auth, access: "tok-2", expires: Date.parse(expires), accountId: "g@x.ai" } }])
})

test("a month with no on-demand cap is one window", async () => {
  const { u, saved } = await run({ ...auth, access: "tok-2", expires: Date.parse(expires) }, () =>
    Response.json({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "2026-10-01T00:00:00+00:00" }, onDemandCap: { val: 0 } } }),
  )
  expect(u).toEqual({ signIn: "kept", windows: [{ name: "Month", used: 0, span: 2592000, resetsAt: "2026-10-01T00:00:00+00:00" }] })
  expect(saved).toEqual([])
})

test("no current period: the billing period's Allowance; an unknown one has no span", async () => {
  let { u } = await run(auth, () => Response.json({ config: { creditUsagePercent: 7, billingPeriodEnd: "2026-10-05T00:00:00Z" } }))
  expect(u).toEqual({ signIn: "kept", windows: [{ name: "Allowance", used: 7, resetsAt: "2026-10-05T00:00:00Z" }] })
  ;({ u } = await run(auth, () => Response.json({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_HOURLY", end: "soon" } } })))
  expect(u).toEqual({ signIn: "kept", windows: [{ name: "Allowance", used: 0 }] })
})

test("a refused token with no Grok Build to renew it says so; no sign-in says to sign in", async () => {
  const [path, bin] = [process.env.PATH, process.env.GROK_BIN_DIR]
  process.env.PATH = ""
  process.env.GROK_BIN_DIR = join(home, "none")
  try {
    const { u } = await run(auth, () => new Response("", { status: 401 }))
    expect(u).toMatchObject({ signIn: "kept", windows: [] })
    expect(u.error).toContain("there is no Grok Build here to renew it")
  } finally {
    process.env.PATH = path
    if (bin === undefined) delete process.env.GROK_BIN_DIR
    else process.env.GROK_BIN_DIR = bin
  }
  const { u, seen } = await run({ ...auth, refresh: join(home, "none") }, () => Response.json({}))
  // a home of the plugin's: `grok login` signs in ~/.grok, not there
  expect(u).toEqual({ signIn: "kept", error: "Grok is not signed in for this account any more; add the account in magpie again", windows: [] })
  expect(seen).toEqual([])
})

// grok_usage.go gives the card Go's error for a request that got no
// answer or JSON that won't read; the plugin said nothing and threw
test("a fetch that fails is the card's error, worded for magpie's keepLast", async () => {
  const url = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
  const fail = (e) => () => { throw e }
  const cases = [
    [Object.assign(new TypeError("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" }), "connection refused"],
    [Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }), "connection refused"],
    [Object.assign(new Error("getaddrinfo ENOTFOUND cli-chat-proxy.grok.com"), { code: "ENOTFOUND" }), "no such host"],
    [new DOMException("The operation timed out.", "TimeoutError"), "timeout"],
    [new TypeError("fetch failed"), "EOF"],
  ]
  for (const [e, said] of cases) {
    const { u } = await run(auth, fail(e))
    expect(u.windows).toEqual([])
    expect(u.signIn).toBe("kept")
    expect(u.error.startsWith(`Get "${url}": `)).toBe(true)
    expect(u.error).toMatch(/no such host|connection refused|timeout|EOF|Service Unavailable/)
    expect(u.error).toContain(said)
  }
})

test("a reply that isn't JSON is the card's error, as Go's encoding/json says it", async () => {
  expect((await run(auth, () => new Response("<html>oops</html>"))).u).toEqual({ signIn: "kept", error: "invalid character '<' looking for beginning of value", windows: [] })
  expect((await run(auth, () => new Response(""))).u).toEqual({ signIn: "kept", error: "unexpected end of JSON input", windows: [] })
})

test("a status Go has no words for still says something", async () => {
  expect((await run(auth, () => new Response("", { status: 509 }))).u).toEqual({ signIn: "kept", error: "HTTP 509", windows: [] })
})

test("a model list Grok couldn't give fails, not falls back to the configured few", async () => {
  globalThis.fetch = async () => new Response("down", { status: 503 })
  const hooks = await GrokAuthPlugin({ client: { auth: { set: async () => {} } } })
  await expect(hooks.provider.models({ id: "grok", models: { "grok-4.7": { id: "grok-4.7" } } }, { auth })).rejects.toThrow()
})

// a free account's billing reads 0% used while its requests are 429'd
// (H20 on Discord): the 429 is what the card shows, until it lifts
test("a request answered 429 shows a spent Rate limit window until its reset", async () => {
  const billing = () => Response.json({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-10-12T02:17:59Z" } } })
  const week = { name: "7 days", used: 0, span: 604800, resetsAt: "2026-10-12T02:17:59Z" }
  const hooks = await GrokAuthPlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => auth)
  const send = async (res) => {
    globalThis.fetch = async () => res
    return opts.fetch("https://cli-chat-proxy.grok.com/v1/responses", { method: "POST", body: JSON.stringify({ model: "grok-4.7", input: "hi" }) })
  }
  const card = async () => {
    globalThis.fetch = async () => billing()
    return (await hooks.auth.usage(async () => auth)).windows
  }
  expect(await card()).toEqual([week])

  // Retry-After in seconds
  const t0 = Date.now()
  expect((await send(new Response("You've hit the rate limit for your plan.", { status: 429, headers: { "Retry-After": "120" } }))).status).toBe(429)
  let ws = await card()
  expect(ws.length).toBe(2)
  expect(ws[0]).toMatchObject({ name: "Rate limit", used: 100, aside: true })
  const at = Date.parse(ws[0].resetsAt)
  expect(at).toBeGreaterThanOrEqual(t0 + 119_000)
  expect(at).toBeLessThanOrEqual(Date.now() + 121_000)
  expect(ws[1]).toEqual(week)

  // a request that goes through lifts it
  await send(Response.json({ ok: true }))
  expect(await card()).toEqual([week])

  // a reset header in epoch seconds
  const reset = Math.floor(Date.now() / 1000) + 600
  await send(new Response("", { status: 429, headers: { "x-ratelimit-reset-requests": String(reset) } }))
  expect((await card())[0]).toMatchObject({ name: "Rate limit", resetsAt: new Date(reset * 1000).toISOString() })

  // a reset passed is gone; none named holds HOLD_MS from the 429
  const { limited, HOLD_MS } = _internal
  limited.get(home).until = Date.now() - 1
  expect(await card()).toEqual([week])
  await send(new Response("", { status: 429 }))
  ws = await card()
  expect(Date.parse(ws[0].resetsAt) - limited.get(home).at).toBe(HOLD_MS)
  limited.get(home).at -= HOLD_MS
  expect(await card()).toEqual([week])

  // another answer that failed leaves it as it was
  await send(new Response("", { status: 429 }))
  await send(new Response("", { status: 500 }))
  expect((await card())[0].name).toBe("Rate limit")
  limited.clear()
})

test("a body in bytes is reshaped as a string one is", () => {
  const { rewrite, bodyText } = _internal
  const chat = { model: "grok-4.7", tools: [{ type: "function", name: "f" }, { type: "custom", name: "apply_patch" }] }
  const want = rewrite(JSON.stringify(chat))
  expect(JSON.parse(want).tools.length).toBe(1)
  for (const b of [Buffer.from(JSON.stringify(chat)), new TextEncoder().encode(JSON.stringify(chat))]) expect(rewrite(bodyText(b))).toBe(want)
})
