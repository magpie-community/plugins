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
    seen.push({ url: String(url), auth: init.headers.Authorization })
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

test("a free account's card says No plan, as the built-in's zedLoginQuota did; its row keeps Free, and the plan it moved to is kept", async () => {
  const { u, saved } = await run(auth(), () => new Response(me("zed_free")))
  expect(u).toEqual({ plan: "No plan", until: "2026-10-01T00:00:00Z", signIn: "kept" })
  expect(saved.length).toBe(1)
  expect(JSON.parse(saved[0].body.refresh)).toMatchObject({ plan: "zed_free", planName: "Free" })
  // an account that names no plan at all is free too
  expect((await run(auth(), () => new Response(me("")))).u.plan).toBe("No plan")
  // an overdue invoice is what a free card says, its plan named as the row names it
  expect((await run(auth(), () => new Response(me("zed_free", true)))).u).toEqual({ plan: "Free", until: "2026-10-01T00:00:00Z",
    error: "Zed: this account has an overdue invoice, so its models are paused (see zed.dev/account)", signIn: "kept" })
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

