// auth.usage tells what magpie's built-in Zed account shows
// (internal/provider/zed_usage.go), against Zed's replies as its tests
// give them (zed_test.go).
import { afterEach, expect, test } from "bun:test"
import { ZedAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const me = (plan, overdue = false) =>
  JSON.stringify({
    user: { legacy_user_id: 4242, github_login: "octo", name: "Octo Cat" },
    organizations: [{ id: "org-team", name: "Team" }, { id: "org-me", name: "Me", is_personal: true }],
    default_organization_id: "org-me",
    plans_by_organization: { "org-me": plan },
    plan: { plan_v3: plan, subscription_period: { started_at: "2026-09-01T00:00:00Z", ended_at: "2026-10-01T00:00:00Z" }, has_overdue_invoices: overdue },
  })

const auth = (plan = "zed_pro") => ({
  type: "oauth",
  access: "plain-access",
  refresh: JSON.stringify({ userId: "4242", systemId: "", org: "org-me", plan, planName: "Pro" }),
  expires: 0,
  accountId: "octo",
})

async function run(a, reply) {
  const seen = []
  const saved = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.Authorization, cookie: init.headers.Cookie })
    return reply()
  }
  const client = { auth: { set: async (x) => saved.push(x) } }
  const hooks = await ZedAuthPlugin({ client })
  return { u: await hooks.auth.usage(async () => a), seen, saved }
}

test("a Pro account: its plan and its period's end, no windows", async () => {
  const { u, seen, saved } = await run(auth(), () => new Response(me("zed_pro")))
  expect(u).toEqual({ plan: "Pro", until: "2026-10-01T00:00:00Z", signIn: "kept" })
  expect(seen).toEqual([{ url: "https://cloud.zed.dev/client/users/me", auth: "4242 plain-access" }])
  expect(saved).toEqual([])
})

test("a free account reads Free, as the built-in's row names it, and the plan it moved to is kept", async () => {
  const { u, saved } = await run(auth(), () => new Response(me("zed_free")))
  expect(u).toEqual({ plan: "Free", until: "2026-10-01T00:00:00Z", signIn: "kept" })
  expect(saved.length).toBe(1)
  expect(JSON.parse(saved[0].body.refresh)).toMatchObject({ plan: "zed_free", planName: "Free" })
})

test("an overdue invoice is the error it is", async () => {
  const { u } = await run(auth(), () => new Response(me("zed_pro", true)))
  expect(u).toEqual({ plan: "Pro", until: "2026-10-01T00:00:00Z", error: "Zed: this account has an overdue invoice, so its models are paused (see zed.dev/account)", signIn: "kept" })
})

test("a refused pair says the sign-in expired", async () => {
  const { u } = await run(auth(), () => new Response("", { status: 401 }))
  expect(u).toEqual({ error: "octo: the Zed sign-in has expired — sign in again", signIn: "expired" })
})

test("another failure says Zed's message", async () => {
  const { u } = await run(auth(), () => new Response(JSON.stringify({ code: "x", message: "down for a bit" }), { status: 503 }))
  expect(u).toEqual({ error: "Zed: down for a bit (503)", signIn: "kept" })
})

test("a business plan picked by organization", async () => {
  const body = JSON.parse(me("zed_free"))
  body.plans_by_organization["org-me"] = "zed_business"
  const { u } = await run(auth("zed_business"), () => new Response(JSON.stringify(body)))
  expect(u.plan).toBe("Business")
})

test("an account reply that can't be read is an error, as zed.FetchMe's", async () => {
  expect((await run(auth(), () => new Response("<html>oops</html>"))).u).toEqual({ error: "Zed: an unreadable account: invalid character '<' looking for beginning of value", signIn: "kept" })
  expect((await run(auth(), () => new Response(""))).u).toEqual({ error: "Zed: an unreadable account: unexpected end of JSON input", signIn: "kept" })
  expect((await run(auth(), () => new Response("[]"))).u).toEqual({ error: "Zed: an unreadable account: json: cannot unmarshal array into Go value of type zed.Me", signIn: "kept" })
})

// complete's answer to a request, the token already minted once
async function ask(replies) {
  const s = _internal.stateOf(auth())
  _internal.tokens.clear()
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url).replace("https://cloud.zed.dev", ""))
    return replies.shift()()
  }
  const res = await _internal.complete(s, "https://cloud.zed.dev/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) })
  return { res, body: await res.json(), seen }
}

test("a model token refused right after it was minted is the built-in's 401, the account kept (not lapsed)", async () => {
  const tok = () => new Response(JSON.stringify({ token: "llm" }))
  const no = () => new Response("", { status: 401 })
  const { res, body, seen } = await ask([tok, no, tok, no])
  expect(seen).toEqual(["/client/llm_tokens", "/completions", "/client/llm_tokens", "/completions"])
  expect(res.status).toBe(401)
  expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
  expect(body.error.message).toBe("the sign-in was refused — sign in again")
})

test("the account's own sign-in refused is a 401 that marks it lapsed, worded as the built-in's", async () => {
  let r = await ask([() => new Response("", { status: 401 })])
  expect(r.res.status).toBe(401)
  expect(r.res.headers.get("x-magpie-sign-in")).toBe("expired")
  expect(r.body.error.message).toBe("octo: the Zed sign-in has expired — sign in again")
  // refused on the second mint, after a stale token: marked all the same
  const tok = () => new Response(JSON.stringify({ token: "llm" }))
  r = await ask([tok, () => new Response("", { status: 401 }), () => new Response("", { status: 401 })])
  expect([r.res.status, r.res.headers.get("x-magpie-sign-in")]).toEqual([401, "expired"])
})

test("a mint that fails otherwise is a 502 that leaves the account be, whatever its body says", async () => {
  const { res, body } = await ask([() => new Response(JSON.stringify({ message: "sign in again later" }), { status: 403 })])
  expect(res.status).toBe(502)
  expect(res.headers.get("x-magpie-sign-in")).toBeNull()
  expect(body.error.message).toBe("sign in again later (403)")
})

test("a vendor's 401 Zed passes on (upstream_status) is a 401 the account keeps; other refusals say nothing of it", async () => {
  const tok = () => new Response(JSON.stringify({ token: "llm" }))
  let r = await ask([tok, () => new Response(JSON.stringify({ code: "upstream", message: "bad key", upstream_status: 401 }), { status: 500 })])
  expect([r.res.status, r.res.headers.get("x-magpie-sign-in")]).toEqual([401, "kept"])
  r = await ask([tok, () => new Response("", { status: 403 })])
  expect([r.res.status, r.res.headers.get("x-magpie-sign-in")]).toEqual([403, null])
  r = await ask([tok, () => new Response("", { status: 402 })])
  expect([r.res.status, r.res.headers.get("x-magpie-sign-in")]).toEqual([402, null])
})

test("errors don't name Zed, which magpie adds", async () => {
  const tok = () => new Response(JSON.stringify({ token: "llm" }))
  let r = await ask([tok, () => new Response(JSON.stringify({ code: "x", message: "down for a bit" }), { status: 503 })])
  expect(r.res.status).toBe(503)
  expect(r.body.error.message).toBe("down for a bit")
  r = await ask([tok, () => new Response("", { status: 402 })])
  expect(r.body.error.message).toBe("payment required — this account's plan doesn't include Zed's hosted models, or its allowance is used up (see zed.dev/account)")
  r = await ask([() => new Response("", { status: 500 })])
  expect(r.body.error.message).toBe("Internal Server Error (500)")
})

test("a model Zed gives no limits has none made up", async () => {
  const e = _internal.entry({ provider: "anthropic", id: "x", display_name: "X" })
  expect(e.limit).toEqual({ context: 0, output: 0 })
  expect(_internal.entry({ provider: "anthropic", id: "y", max_token_count: 1000, max_output_tokens: 10 }).limit).toEqual({ context: 1000, output: 10 })
})

test("a usage read says what the built-in's did of the sign-in: marked only on Zed's 401, never cleared", async () => {
  expect((await run(auth(), () => new Response(me("zed_pro")))).u.signIn).toBe("kept")
  expect((await run(auth(), () => new Response("", { status: 401 }))).u.signIn).toBe("expired")
  expect((await run(auth(), () => new Response("", { status: 503 }))).u.signIn).toBe("kept")
  expect((await run(auth(), () => new Response("[]"))).u.signIn).toBe("kept")
  const hooks = await ZedAuthPlugin({})
  expect(await hooks.auth.usage(async () => ({ type: "api", key: "x" }))).toEqual({ error: "no such Zed account", signIn: "kept" })
})

// ---- the dollar spend, read with the web session the sign-in was given ----

// billing is zed.dev's account page's own answer, as the browser's session
// sees it (a real reply's shape; the spend is cents and the limit may be
// null — the plan has no spending cap set)
const billing = (spend, limit) =>
  JSON.stringify({
    plan: "token_based_zed_student",
    is_account_too_young: false,
    current_usage: { token_spend_in_cents: spend, token_spend: { spend_in_cents: spend, limit_in_cents: limit, updated_at: "2026-10-06T09:50:02.628Z" }, edit_predictions: { used: 0, limit: null, remaining: null } },
  })

const webAuth = (plan = "zed_pro") => ({ ...auth(plan), webCookie: "zed.session=ses-123" })

async function run2(a, meReply, billingReply) {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), cookie: init.headers.Cookie })
    return String(url).includes("/frontend/billing/usage") ? billingReply() : meReply()
  }
  const hooks = await ZedAuthPlugin({ client: { auth: { set: async () => {} } } })
  return { u: await hooks.auth.usage(async () => a), seen }
}

test("a web session given at the sign-in adds the dollar spend as the account's allowance, ending with the period", async () => {
  const { u, seen } = await run2(webAuth(), () => new Response(me("zed_pro")), () => new Response(billing(25, 1000)))
  expect(u).toEqual({
    plan: "Pro",
    until: "2026-10-01T00:00:00Z",
    signIn: "kept",
    windows: [{ name: "Token spend", used: 2.5, amount: 0.25, limit: 10, unit: "usd", display: "$0.25 / $10.00", resetsAt: "2026-10-01T00:00:00Z" }],
  })
  expect(seen).toEqual([
    { url: "https://cloud.zed.dev/client/users/me", cookie: undefined },
    { url: "https://cloud.zed.dev/frontend/billing/usage", cookie: "zed.session=ses-123" },
  ])
})

test("without a web session the card is as it was, and the billing page is not asked", async () => {
  const { u, seen } = await run2(auth(), () => new Response(me("zed_pro")), () => { throw new Error("asked") })
  expect(u).toEqual({ plan: "Pro", until: "2026-10-01T00:00:00Z", signIn: "kept" })
  expect(seen).toEqual([{ url: "https://cloud.zed.dev/client/users/me", cookie: undefined }])
})

test("a spend with no limit is shown without one, set aside: no percent made up, nothing to hold on", async () => {
  const { u } = await run2(webAuth(), () => new Response(me("zed_student")), () => new Response(billing(3, null)))
  expect(u.windows).toEqual([{ name: "Token spend", aside: true, used: 0, display: "$0.03 spent" }])
})

test("a web session that has run out is a line on the card, not an error: the editor sign-in is another one and stays fine", async () => {
  const { u } = await run2(webAuth(), () => new Response(me("zed_pro")), () => new Response("", { status: 401 }))
  expect(u).toEqual({
    plan: "Pro",
    until: "2026-10-01T00:00:00Z",
    signIn: "kept",
    windows: [{ name: "Token spend", used: 0, aside: true, display: "add the web session again to see dollar usage" }],
  })
})

test("a billing reply that can't be read is no line at all, the card as it was", async () => {
  const { u } = await run2(webAuth(), () => new Response(me("zed_pro")), () => new Response("<html>oops</html>"))
  expect(u).toEqual({ plan: "Pro", until: "2026-10-01T00:00:00Z", signIn: "kept" })
  const failed = await run2(webAuth(), () => new Response(me("zed_pro")), () => { throw new Error("network") })
  expect(failed.u).toEqual({ plan: "Pro", until: "2026-10-01T00:00:00Z", signIn: "kept" })
  const none = await run2(webAuth(), () => new Response(me("zed_pro")), () => new Response(JSON.stringify({ plan: "zed_pro" })))
  expect(none.u).toEqual({ plan: "Pro", until: "2026-10-01T00:00:00Z", signIn: "kept" })
})

test("a plan Zed won't serve is still the error it was, the spend beside it", async () => {
  const { u } = await run2(webAuth(), () => new Response(me("zed_pro", true)), () => new Response(billing(25, 1000)))
  expect(u.error).toBe("Zed: this account has an overdue invoice, so its models are paused (see zed.dev/account)")
  expect(u.windows).toEqual([{ name: "Token spend", used: 2.5, amount: 0.25, limit: 10, unit: "usd", display: "$0.25 / $10.00", resetsAt: "2026-10-01T00:00:00Z" }])
})

// the spend window is the account's allowance: spent to its limit, magpie
// holds the account until the period ends — as it does a Codex window
test("a spend at its limit holds the account until the period ends", async () => {
  const { u } = await run2(webAuth(), () => new Response(me("zed_student")), () => new Response(billing(1000, 1000)))
  expect(u.windows).toEqual([{ name: "Token spend", used: 100, amount: 10, limit: 10, unit: "usd", display: "$10.00 / $10.00", resetsAt: "2026-10-01T00:00:00Z" }])
})

// webCookieOf takes the session as it's pasted: a bare value, the
// zed.session pair, or a whole Cookie header off the devtools — of which
// only the session is kept, wherever it sat in the header
test("the web session is read as it's pasted: bare, paired, or a whole Cookie header", () => {
  expect(_internal.webCookieOf({ webCookie: "ses-123" })).toBe("zed.session=ses-123")
  expect(_internal.webCookieOf({ webCookie: "ses+12/3==" })).toBe("zed.session=ses+12/3==")
  expect(_internal.webCookieOf({ webCookie: "zed.session=ses-123" })).toBe("zed.session=ses-123")
  expect(_internal.webCookieOf({ webCookie: "zed.session=ses-123; __cf_bm=cf; other=a" })).toBe("zed.session=ses-123")
  expect(_internal.webCookieOf({ webCookie: "other=a; zed.session=ses-123; third=b" })).toBe("zed.session=ses-123")
  expect(_internal.webCookieOf({ webCookie: "  " })).toBe("")
  expect(_internal.webCookieOf({})).toBe("")
  expect(_internal.webCookieOf({ webCookie: "no-session-here=1; other=2" })).toBe("")
})

// the spend is the personal account's: a business organization's is zed.dev's
// org page, which no real account has checked here, so its account carries
// no window rather than the personal one's
test("an account that calls the models under a business organization carries no spend window", async () => {
  const body = JSON.parse(me("zed_business"))
  const org = { id: "org-me", name: "Me", is_personal: false }
  body.organizations = [{ id: "org-team", name: "Team", is_personal: false }, org]
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    return String(url).includes("/frontend/billing/usage") ? new Response(billing(25, 1000)) : new Response(JSON.stringify(body))
  }
  const hooks = await ZedAuthPlugin({ client: { auth: { set: async () => {} } } })
  const u = await hooks.auth.usage(async () => webAuth("zed_business"))
  expect(u).toEqual({ plan: "Business", until: "2026-10-01T00:00:00Z", signIn: "kept" })
  expect(seen).toEqual(["https://cloud.zed.dev/client/users/me"])
})

