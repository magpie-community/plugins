// Tests for the Cline provider plugin. Every request the plugin would make is
// answered by a mock fetch here; nothing reaches the network.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { ClinePlugin, _internal } from "./index.mjs"

const { authOf, parseAuth, parseFeed, prettify, balanceOf, balanceWindow, usd, usageOf, failure, bearerOf, toMs, refresh, deviceAuthorize, pollDevice, clientHeaders, constants: { CLIENT, DEFAULT_MODELS } } = _internal

// ---- a fetch that answers from a script -----------------------------------------

let calls = []
let routes = []
const realFetch = globalThis.fetch

// route is [urlPart, responder]; responder is status+json, a Response, or a
// function (init) => Response. Unmatched URLs fail loudly.
function serve(routesIn) {
	routes = [...routesIn]
	calls = []
	globalThis.fetch = async (input, init = {}) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		calls.push({ url, init })
		// routes are consumed in order: the same URL may be scripted twice
		const idx = routes.findIndex(([part]) => url.includes(part))
		if (idx < 0) throw new Error(`no route for ${url}`)
		const r = routes[idx][1]
		routes.splice(idx, 1)
		if (typeof r === "function") return r(init)
		if (r instanceof Response) return r
		return Response.json(r.body ?? {}, { status: r.status ?? 200, headers: r.headers })
	}
}

afterEach(() => {
	globalThis.fetch = realFetch
})

const client = () => {
	const saved = []
	// store is the sign-in as magpie keeps it, and re-reads it on every call
	// the way the host does — so a save this plugin makes is seen by the next
	// request, and one it fails to make isn't
	let stored = null
	const store = async () => stored
	return {
		client: {
			app: { log: async () => {} },
			auth: {
				set: async (input) => {
					saved.push(input.body)
					stored = input.body
				},
			},
			tui: { showToast: async () => {} },
			config: { get: async () => ({ data: {} }) },
		},
		saved,
		store,
		// raw is the sign-in this test's getAuth starts from
		seed: (a) => {
			stored = a
		},
	}
}

const chatUrl = "https://api.cline.bot/api/v1/chat/completions"
const chatInit = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? { model: "anthropic/claude-sonnet-5" }) })

// ---- the hook shapes the plugin market checks ------------------------------------

test("the plugin exports the auth/config/provider hooks", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	expect(hooks.auth.provider).toBe("cline")
	expect(typeof hooks.auth.loader).toBe("function")
	expect(hooks.auth.methods.length).toBeGreaterThan(0)
	for (const m of hooks.auth.methods) {
		expect(["oauth", "api"]).toContain(m.type)
		if (m.type === "oauth") expect(typeof m.authorize).toBe("function")
	}
	expect(typeof hooks.auth.usage).toBe("function")
	expect(typeof hooks.provider.models).toBe("function")
})

test("config declares the provider with an npm package and models", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	const cfg = { provider: {} }
	await hooks.config(cfg)
	const p = cfg.provider.cline
	expect(p.npm).toBe("@ai-sdk/openai-compatible")
	expect(p.api).toBe("https://api.cline.bot/api/v1")
	expect(Object.keys(p.models).length).toBeGreaterThan(0)
	expect(p.models["anthropic/claude-sonnet-5"]).toBeTruthy()
	// user overrides win
	const cfg2 = { provider: { cline: { name: "Mine", models: { "mine/own": { name: "Own" } } } } }
	await hooks.config(cfg2)
	expect(cfg2.provider.cline.name).toBe("Mine")
	expect(cfg2.provider.cline.models["mine/own"]).toBeTruthy()
	expect(cfg2.provider.cline.models["anthropic/claude-sonnet-5"]).toBeTruthy()
})

test("the models hook falls back to what config had when the feed fails", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([])
	const out = await hooks.provider.models({ models: { "fallback/one": { name: "One" } } })
	expect(out["fallback/one"]).toBeTruthy()
})

// ---- the loader -------------------------------------------------------------------

test("loader returns nothing when not signed in", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	const l = await hooks.auth.loader(async () => null)
	expect(l).toEqual({})
	const l2 = await hooks.auth.loader(async () => ({ type: "other" }))
	expect(l2).toEqual({})
})

test("loader refuses what isn't a chat completion", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	const l = await hooks.auth.loader(async () => ({ type: "api", key: "sk" }))
	const notChat = await l.fetch("https://api.cline.bot/api/v1/models", { method: "GET" })
	expect(notChat.status).toBe(404)
	const notJson = await l.fetch(chatUrl, { method: "POST", body: "hello" })
	expect(notJson.status).toBe(400)
	const noBody = await l.fetch(chatUrl, { method: "POST" })
	expect(noBody.status).toBe(400)
})

test("an API-key account signs requests with the raw key", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		[chatUrl, () => Response.json({ ok: true })],
	])
	const l = await hooks.auth.loader(async () => ({ type: "api", key: "ck_abc" }))
	const res = await l.fetch(chatUrl, chatInit())
	expect(res.status).toBe(200)
	expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
	expect(calls[0].init.headers.get("Authorization")).toBe("Bearer ck_abc")
	// the request reads as Cline's own client, headers down
	expect(calls[0].init.headers.get("X-CLIENT-TYPE")).toBe(CLIENT.type)
	expect(calls[0].init.headers.get("X-CLIENT-VERSION")).toBe(CLIENT.version)
	expect(calls[0].init.headers.get("X-PLATFORM")).toBe(CLIENT.platform)
	expect(calls[0].init.headers.get("X-PLATFORM-VERSION")).toBe(CLIENT.version)
	expect(calls[0].init.headers.get("X-CORE-VERSION")).toBe(CLIENT.core)
	expect(calls[0].init.headers.get("X-IS-MULTIROOT")).toBe("false")
	expect(calls[0].init.headers.get("User-Agent")).toBe(`Cline/${CLIENT.version}`)
	expect(calls[0].init.headers.get("HTTP-Referer")).toBe("https://cline.bot")
	expect(calls[0].init.headers.get("X-Title")).toBe("Cline")
	expect(calls[0].init.headers.get("X-Task-ID")).toBeTruthy()
	expect(await res.json()).toEqual({ ok: true })
})

test("clientHeaders is the official client's set, task id only when asked", () => {
	const h = clientHeaders()
	expect(h["X-CLIENT-TYPE"]).toBe("cline-cli")
	expect(h["X-Task-ID"]).toBeUndefined()
	expect(clientHeaders("task-1")["X-Task-ID"]).toBe("task-1")
})

test("a finished non-stream answer has Cline's envelope taken off, a stream doesn't", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		[chatUrl, () => Response.json({ data: { id: "gen_1", object: "chat.completion", choices: [{ index: 0, message: { content: "OK" } }] } })],
	])
	const l = await hooks.auth.loader(async () => ({ type: "api", key: "ck" }))
	const res = await l.fetch(chatUrl, chatInit())
	expect(await res.json()).toEqual({ id: "gen_1", object: "chat.completion", choices: [{ index: 0, message: { content: "OK" } }] })

	serve([
		[chatUrl, () => new Response('data: {"object":"chat.completion.chunk"}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } })],
	])
	const res2 = await l.fetch(chatUrl, chatInit({ stream: true }))
	expect(res2.headers.get("content-type")).toBe("text/event-stream")
	expect(await res2.text()).toBe('data: {"object":"chat.completion.chunk"}\n\ndata: [DONE]\n\n')

	// a JSON answer with no envelope rides as it came
	serve([
		[chatUrl, () => Response.json({ choices: [{ index: 0, message: { content: "raw" } }] })],
	])
	const res3 = await l.fetch(chatUrl, chatInit())
	expect(await res3.json()).toEqual({ choices: [{ index: 0, message: { content: "raw" } }] })
})

test("a live access token is used as-is, without a refresh", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		[chatUrl, () => Response.json({ ok: true })],
	])
	const l = await hooks.auth.loader(async () => ({ type: "oauth", access: "jwt1", refresh: "r1", expires: Date.now() + 60 * 60 * 1000, uid: "u1", accountId: "a@b.c" }))
	const res = await l.fetch(chatUrl, chatInit())
	expect(res.status).toBe(200)
	expect(calls.length).toBe(1)
	expect(calls[0].init.headers.get("Authorization")).toBe("Bearer workos:jwt1")
})

test("a near-expiry account is renewed, the rotated pair saved, the answer marked renewed", async () => {
	const { client: c, saved, store, seed } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		["/auth/refresh", () => Response.json({ success: true, data: { accessToken: "jwt2", refreshToken: "r2", expiresAt: new Date(Date.now() + 3600_000).toISOString(), userInfo: { subject: "s1", email: "a@b.c", clineUserId: "cu1" } } })],
		[chatUrl, () => Response.json({ ok: true })],
	])
	const raw = { type: "oauth", access: "jwt1", refresh: "r1", expires: Date.now() + 1000, uid: "cu1", accountId: "a@b.c" }
	seed(raw)
	const l = await hooks.auth.loader(store)
	const res = await l.fetch(chatUrl, chatInit())
	expect(res.status).toBe(200)
	expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
	expect(calls[0].url).toContain("/auth/refresh")
	expect(calls[0].init.body).toBe(JSON.stringify({ refreshToken: "r1", grantType: "refresh_token" }))
	expect(calls[1].init.headers.get("Authorization")).toBe("Bearer workos:jwt2")
	expect(saved.length).toBe(1)
	expect(saved[0].type).toBe("oauth")
	expect(saved[0].access).toBe("jwt2")
	expect(saved[0].refresh).toBe("r2")
	expect(saved[0].accountId).toBe("a@b.c")
})

test("a refused refresh is the sign-in gone, marked expired", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		["/auth/refresh", () => Response.json({ error: "invalid_grant" }, { status: 400 })],
	])
	const l = await hooks.auth.loader(async () => ({ type: "oauth", access: "jwt1", refresh: "r1", expires: Date.now() + 1000 }))
	const res = await l.fetch(chatUrl, chatInit())
	expect(res.status).toBe(401)
	expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
	const body = await res.json()
	expect(body.error.message).toContain("sign in to Cline again")
})

test("a transient refresh failure leaves a still-good token to make its request", async () => {
	const { client: c, store, seed } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		["/auth/refresh", () => Response.json({ boom: true }, { status: 500 })],
		[chatUrl, () => Response.json({ ok: true })],
	])
	// four minutes left: inside the refresh lead, but still good — the request
	// goes out on it rather than failing (Cline keeps the token too)
	seed({ type: "oauth", access: "jwt1", refresh: "r1", expires: Date.now() + 4 * 60 * 1000, uid: "cu1", accountId: "a@b.c" })
	const l = await hooks.auth.loader(store)
	const res = await l.fetch(chatUrl, chatInit())
	expect(res.status).toBe(200)
	expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
	expect(calls[0].url).toContain("/auth/refresh")
	expect(calls[1].init.headers.get("Authorization")).toBe("Bearer workos:jwt1")
})

test("a transient refresh failure with an expired token fails the request, unmarked", async () => {
	const { client: c, store, seed } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		["/auth/refresh", () => Response.json({ boom: true }, { status: 500 })],
	])
	seed({ type: "oauth", access: "jwt1", refresh: "r1", expires: Date.now() - 1000 })
	const l = await hooks.auth.loader(store)
	const res = await l.fetch(chatUrl, chatInit())
	expect(res.status).toBe(502)
	expect(res.headers.get("X-Magpie-Sign-In")).toBe(null)
})

test("a rotated pair survives a failing auth.set: the next request doesn't re-spend the old token", async () => {
	const { client: c, saved, store, seed } = client()
	c.auth.set = async () => {
		throw new Error("disk full")
	}
	const hooks = await ClinePlugin({ client: c })
	serve([
		["/auth/refresh", () => Response.json({ success: true, data: { accessToken: "jwt2", refreshToken: "r2", expiresAt: new Date(Date.now() + 3600_000).toISOString(), userInfo: { clineUserId: "cu1", email: "a@b.c" } } })],
		[chatUrl, () => Response.json({ ok: true })],
		[chatUrl, () => Response.json({ ok: true })],
	])
	seed({ type: "oauth", access: "jwt1", refresh: "r1", expires: Date.now() + 1000, uid: "cu1", accountId: "a@b.c" })
	const l = await hooks.auth.loader(store)
	const res = await l.fetch(chatUrl, chatInit())
	expect(res.status).toBe(200)
	const refreshCall = calls.find((x) => x.url.includes("/auth/refresh"))
	expect(refreshCall.init.body).toBe(JSON.stringify({ refreshToken: "r1", grantType: "refresh_token" }))
	expect(calls.find((x) => x.url === chatUrl).init.headers.get("Authorization")).toBe("Bearer workos:jwt2")
	// getAuth still hands back the spent pair (the save failed), and the next
	// request must use the pair held in memory, not refresh r1 again
	const res2 = await l.fetch(chatUrl, chatInit())
	expect(res2.status).toBe(200)
	expect(calls.filter((x) => x.url.includes("/auth/refresh")).length).toBe(1)
	expect(calls.filter((x) => x.url === chatUrl).map((x) => x.init.headers.get("Authorization"))).toEqual(["Bearer workos:jwt2", "Bearer workos:jwt2"])
	expect(saved.length).toBe(0)
})

test("concurrent requests collapse to one refresh", async () => {
	const { client: c, store, seed } = client()
	const hooks = await ClinePlugin({ client: c })
	let refreshes = 0
	serve([
		["/auth/refresh", () => {
			refreshes++
			return Response.json({ success: true, data: { accessToken: "jwt2", refreshToken: "r2", expiresAt: new Date(Date.now() + 3600_000).toISOString(), userInfo: { clineUserId: "cu1" } } })
		}],
		[chatUrl, () => Response.json({ ok: true })],
		[chatUrl, () => Response.json({ ok: true })],
		[chatUrl, () => Response.json({ ok: true })],
	])
	seed({ type: "oauth", access: "jwt1", refresh: "r1", expires: Date.now() + 1000, uid: "cu1", accountId: "a@b.c" })
	const l = await hooks.auth.loader(store)
	const [a, b, d] = await Promise.all([l.fetch(chatUrl, chatInit()), l.fetch(chatUrl, chatInit()), l.fetch(chatUrl, chatInit())])
	expect([a.status, b.status, d.status]).toEqual([200, 200, 200])
	expect(refreshes).toBe(1)
})

test("an upstream chat refusal comes back as OpenAI's error shape", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		[chatUrl, () => Response.json({ error: { code: "insufficient_credits", message: "Insufficient balance. Your Cline Credits balance is $0.00", current_balance: 0.004507, buy_credits_url: "https://app.cline.bot/credits" } }, { status: 402 })],
	])
	const l = await hooks.auth.loader(async () => ({ type: "api", key: "ck" }))
	const res = await l.fetch(chatUrl, chatInit())
	expect(res.status).toBe(429)
	const body = await res.json()
	expect(body.error.type).toBe("cline_error")
	expect(body.error.message).toContain("out of credits ($0.00)")
	expect(body.error.message).toContain("app.cline.bot/credits")
})

test("a model the account isn't entitled to says which plan it wants", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		[chatUrl, () => Response.json({ error: { code: "ENTITLEMENT_ERROR", message: "Error 403: the user is not subscribed to required model plan" } }, { status: 403 })],
	])
	const l = await hooks.auth.loader(async () => ({ type: "api", key: "ck" }))
	const res = await l.fetch(chatUrl, chatInit())
	expect(res.status).toBe(403)
	const body = await res.json()
	expect(body.error.message).toContain("ClinePass")
	expect(body.error.message).toContain("not subscribed")
})

test("an upstream chat 401 keeps the sign-in mark", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		[chatUrl, () => Response.json({ error: { message: "nope" } }, { status: 401 })],
	])
	const l = await hooks.auth.loader(async () => ({ type: "api", key: "ck" }))
	const res = await l.fetch(chatUrl, chatInit())
	expect(res.status).toBe(401)
	expect(res.headers.get("X-Magpie-Sign-In")).toBe(null)
})

// ---- the device sign-in ------------------------------------------------------------

test("the device sign-in approves, registers, and keeps the pair", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	const oauth = hooks.auth.methods.find((m) => m.type === "oauth")
	expect(oauth.label).toContain("Cline")
	serve([
		["user_management/authorize/device", () => Response.json({ device_code: "dc1", user_code: "ABCD-1234", verification_uri: "https://eu.workos.com/device", verification_uri_complete: "https://eu.workos.com/device?code=ABCD-1234", interval: 0.25, expires_in: 300 })],
		["user_management/authenticate", () => Response.json({ error: "authorization_pending" }, { status: 400 })],
		["user_management/authenticate", () => Response.json({ access_token: "wt1", refresh_token: "wr1", token_type: "bearer" })],
		["/auth/register", () => Response.json({ success: true, data: { accessToken: "ca1", refreshToken: "cr1", tokenType: "bearer", expiresAt: new Date(Date.now() + 3600_000).toISOString(), userInfo: { subject: "sub1", email: "a@b.c", name: "Ada", clineUserId: "cu1" } } })],
	])
	const start = await oauth.authorize()
	expect(start.url).toBe("https://eu.workos.com/device?code=ABCD-1234")
	expect(start.method).toBe("auto")
	const r = await start.callback()
	expect(r.type).toBe("success")
	expect(r.access).toBe("ca1")
	expect(r.refresh).toBe("cr1")
	expect(r.email).toBe("a@b.c")
	expect(r.uid).toBe("cu1")
	expect(r.accountId).toBe("a@b.c")
	expect(typeof r.expires).toBe("number")
	expect(calls[1].init.body).toContain("urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code")
	expect(calls[2].init.body).toContain("device_code=dc1")
	expect(calls[3].init.body).toBe(JSON.stringify({ accessToken: "wt1", refreshToken: "wr1" }))
})

test("a refused device approval fails the sign-in", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	const oauth = hooks.auth.methods.find((m) => m.type === "oauth")
	serve([
		["user_management/authorize/device", () => Response.json({ device_code: "dc1", user_code: "X", verification_uri: "https://eu.workos.com/device", interval: 0.25, expires_in: 300 })],
		["user_management/authenticate", () => Response.json({ error: "access_denied", error_description: "user said no" }, { status: 400 })],
	])
	const start = await oauth.authorize()
	const r = await start.callback()
	expect(r.type).toBe("failed")
	expect(r.error).toContain("access_denied")
})

test("a failed register trades on nothing", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	const oauth = hooks.auth.methods.find((m) => m.type === "oauth")
	serve([
		["user_management/authorize/device", () => Response.json({ device_code: "dc1", user_code: "X", verification_uri: "https://eu.workos.com/device", interval: 0.25, expires_in: 300 })],
		["user_management/authenticate", () => Response.json({ access_token: "wt1", refresh_token: "wr1" })],
		["/auth/register", () => Response.json({ success: false, error: "unknown account" }, { status: 200 })],
	])
	const start = await oauth.authorize()
	const r = await start.callback()
	expect(r.type).toBe("failed")
	expect(r.error).toContain("unknown account")
})

test("a device code request that fails fails the authorize", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		["user_management/authorize/device", () => Response.json({ message: "no device grants" }, { status: 403 })],
	])
	const oauth = hooks.auth.methods.find((m) => m.type === "oauth")
	await expect(oauth.authorize()).rejects.toThrow("device code request failed")
})

// ---- usage -----------------------------------------------------------------------

test("usage reads the account's balance", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		["/users/me", () => Response.json({ success: true, data: { subject: "sub1", clineUserId: "cu1", email: "a@b.c", plan: "Usage-Billing" } })],
		["/users/cu1/balance", () => Response.json({ success: true, data: { totalCredits: 1000, usedCredits: 250 } })],
	])
	const out = await hooks.auth.usage(async () => ({ type: "api", key: "ck", accountId: "a@b.c" }))
	expect(out.signIn).toBe("kept")
	expect(out.plan).toBe("Usage-Billing")
	expect(out.user).toBe("a@b.c")
	expect(out.windows.length).toBe(1)
	expect(out.windows[0].name).toBe("Credits")
	expect(out.windows[0].used).toBeCloseTo(25)
	expect(out.windows[0].display).toBe("250 / 1000")
})

test("usage tries the ids users/me names, in order", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		["/users/me", () => Response.json({ success: true, data: { subject: "sub1" } })],
		["/users/sub1/balance", () => Response.json({ success: true, data: { credits: "42" } })],
	])
	const out = await hooks.auth.usage(async () => ({ type: "api", key: "ck" }))
	expect(out.windows[0].display).toBe("42 credits left")
})

test("usage reports a lapsed account as expired", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		["/users/me", () => Response.json({ message: "expired" }, { status: 401 })],
	])
	const out = await hooks.auth.usage(async () => ({ type: "oauth", access: "jwt", refresh: "r", expires: Date.now() + 3600_000 }))
	expect(out.signIn).toBe("expired")
	expect(out.windows).toEqual([])
})

test("usage never throws", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([])
	const out = await hooks.auth.usage(async () => ({ type: "api", key: "ck" }))
	expect(out.error).toBeTruthy()
	expect(out.signIn).toBe("kept")
})

// ---- the pieces -------------------------------------------------------------------

test("parseAuth reads Cline's token answer, falling back on the refresh", () => {
	const p = parseAuth({ accessToken: "a1", refreshToken: "r1", expiresAt: "2030-01-01T00:00:00Z", userInfo: { subject: "s", email: "a@b.c", name: "Ada", clineUserId: "cu1" } })
	expect(p.access).toBe("a1")
	expect(p.refresh).toBe("r1")
	expect(p.expires).toBeGreaterThan(Date.now())
	expect(p.uid).toBe("cu1")
	expect(p.email).toBe("a@b.c")
	expect(p.accountId).toBe("a@b.c")
	const p2 = parseAuth({ accessToken: "a2", userInfo: { subject: "s" } }, "r-old")
	expect(p2.refresh).toBe("r-old")
	expect(p2.expires).toBeGreaterThan(Date.now())
	expect(parseAuth({}).error).toBeTruthy()
	expect(parseAuth({ accessToken: "a" }).error).toBeTruthy()
})

test("bearerOf prefixes a signed-in token, once", () => {
	expect(bearerOf({ type: "api", key: "ck" })).toBe("ck")
	expect(bearerOf({ type: "oauth", access: "jwt" })).toBe("workos:jwt")
	expect(bearerOf({ type: "oauth", access: "workos:jwt" })).toBe("workos:jwt")
	// the prefix is matched whatever case it came in, as Cline's client does
	expect(bearerOf({ type: "oauth", access: "WorkOS:jwt" })).toBe("WorkOS:jwt")
	expect(bearerOf({ type: "oauth", access: "" })).toBe("")
})

test("refresh trades the token and falls back when nothing rotated", async () => {
	serve([
		["/auth/refresh", () => Response.json({ success: true, data: { accessToken: "a2", refreshToken: "r2", expiresAt: new Date(Date.now() + 3600_000).toISOString() } })],
	])
	const p = await refresh({ refresh: "r1" })
	expect(p.access).toBe("a2")
	expect(p.refresh).toBe("r2")
	serve([
		["/auth/refresh", () => Response.json({ success: true, data: { accessToken: "a3", expiresAt: new Date(Date.now() + 3600_000).toISOString() } })],
	])
	const p2 = await refresh({ refresh: "r-old" })
	expect(p2.refresh).toBe("r-old")
})

test("refresh keeps a lapsed sign-in a Lapsed error", async () => {
	serve([
		["/auth/refresh", () => Response.json({ error: "unauthorized" }, { status: 403 })],
	])
	await expect(refresh({ refresh: "r1" })).rejects.toMatchObject({ expired: true })
})

test("toMs takes an ISO datetime, or an hour out", () => {
	expect(toMs("2030-01-01T00:00:00Z")).toBe(Date.parse("2030-01-01T00:00:00Z"))
	expect(toMs("garbage")).toBeGreaterThan(Date.now() + 59 * 60 * 1000)
})

test("parseFeed reads the feed's four arrays, and only them", () => {
	const ms = parseFeed({
		recommended: [{ id: "anthropic/claude-sonnet-5.5", name: "claude-sonnet-5.5", tags: ["NEW"] }, { id: "openai/gpt-6-astra", name: "GPT 6 Astra" }],
		free: [{ id: "cline-free/mimo-v2.6-flash", name: "Mimo V2.6 Flash" }],
		clinePass: [{ id: "cline-pass/glm-5.3", name: "cline-pass/glm-5.3" }],
		// not a group Cline's client reads: a tag, a description, a stray id
		tags: ["NEW"],
		description: "some/model",
		nested: { deeper: ["google/gemini-2.5-pro"] },
	})
	const by = Object.fromEntries(ms.map((m) => [m.id, m]))
	expect(ms.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5.5", "openai/gpt-6-astra", "cline-free/mimo-v2.6-flash", "cline-pass/glm-5.3"])
	// a name that is just the id (or its last part) is the raw id: prettified
	expect(by["anthropic/claude-sonnet-5.5"].name).toBe("Claude Sonnet 5.5")
	// a real display name is kept
	expect(by["openai/gpt-6-astra"].name).toBe("GPT 6 Astra")
	// the free group says so in its name, the plan-gated group names its plan
	expect(by["cline-free/mimo-v2.6-flash"].free).toBe(true)
	expect(by["cline-free/mimo-v2.6-flash"].name).toBe("Mimo V2.6 Flash (free)")
	expect(by["cline-pass/glm-5.3"].free).toBe(false)
	expect(by["cline-pass/glm-5.3"].name).toBe("GLM 5.3 (ClinePass)")
	// clineCloud is left out, as Cline's own client leaves it out by default
	expect(parseFeed({ clineCloud: ["cloud/one"] })).toEqual([])
	// a model in both recommended and free keeps the free mark (and its name)
	const both = parseFeed({ recommended: [{ id: "stealth/space-bunny-alpha", name: "space-bunny-alpha" }], free: [{ id: "stealth/space-bunny-alpha", name: "Space Bunny Alpha" }] })
	expect(both.length).toBe(1)
	expect(both[0].free).toBe(true)
	expect(both[0].name).toBe("Space Bunny Alpha (free)")
	// a bare string id is read, a number or a slashless word is not
	expect(parseFeed({ recommended: ["ok/one", "hello", 42] }).map((m) => m.id)).toEqual(["ok/one"])
})

test("the bundled snapshot matches Cline's generated recommended list", () => {
	const ids = DEFAULT_MODELS.map((m) => m.id)
	expect(ids).toContain("anthropic/claude-sonnet-5.5")
	expect(ids).not.toContain("google/gemini-2.5-pro")
	expect(ids).not.toContain("minimax/minimax-m2.5")
	for (const id of ["cline-pass/mimo-v2.6-pro", "cline-pass/glm-5.3-flash", "cline-pass/qwen3.7-max", "cline-pass/qwen3.7-plus", "cline-pass/mimo-v2.5-pro", "cline-pass/mimo-v2.5"])
		expect(ids).toContain(id)
	const by = Object.fromEntries(DEFAULT_MODELS.map((m) => [m.id, m]))
	expect(by["cline-free/deepseek-v4.1-flash"].name).toBe("Deepseek V4.1 Flash (free)")
	expect(by["cline-pass/mimo-v2.5-pro"].name).toBe("MiMo V2.5 Pro (ClinePass)")
})

test("the models hook merges the cloud catalog with the recommended feed", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		["/ai/cline/recommended-models", () => Response.json({ data: { recommended: [{ id: "anthropic/claude-sonnet-5.5" }], free: [{ id: "cline-free/mimo-v2.6-flash" }] } })],
		["/ai/cline/models", () => Response.json({ data: [{ id: "local-model", display_name: "Local Model" }, { id: "anthropic/claude-sonnet-5.5", display_name: "Claude Sonnet 5.5" }] })],
	])
	const out = await hooks.provider.models({ models: {} })
	expect(Object.keys(out)).toEqual(["anthropic/claude-sonnet-5.5", "cline-free/mimo-v2.6-flash", "local-model"])
	expect(out["local-model"].name).toBe("Local Model")
	// the cloud catalog's raw-id name is prettified
	expect(out["cline-free/mimo-v2.6-flash"].name).toBe("MiMo V2.6 Flash (free)")
})

test("prettify reads a model id as a name", () => {
	expect(prettify("anthropic/claude-sonnet-5.5")).toBe("Claude Sonnet 5.5")
	expect(prettify("openai/gpt-6-astra")).toBe("GPT 6 Astra")
	expect(prettify("moonshotai/kimi-k3")).toBe("Kimi K3")
})

test("balanceWindow reads Cline's balance shape, in dollars", () => {
	expect(balanceWindow({ balance: 4507 })).toEqual({ name: "Credits", used: 0, display: "$0.0045 left" })
	expect(balanceWindow({ balance: 25000000 }).display).toBe("$25.00 left")
	expect(balanceWindow({ balance: 0 }).display).toBe("$0.00 left")
	expect(balanceWindow({ balance: "900000" }).display).toBe("$0.90 left")
	expect(balanceWindow({ totalCredits: 100 })).toBe(null)
	expect(balanceWindow(null)).toBe(null)
})

test("usd writes cents above a cent and four decimals under one", () => {
	expect(usd(25)).toBe("$25.00")
	expect(usd(0.0045)).toBe("$0.0045")
	expect(usd(0)).toBe("$0.00")
	expect(usd(0.9)).toBe("$0.90")
})

test("balanceOf reads a total with its used or remaining, or just what's left", () => {
	expect(balanceOf({ totalCredits: 1000, usedCredits: 250 })).toEqual({ name: "Credits", used: 25, display: "250 / 1000" })
	expect(balanceOf({ total: 100, remaining: 75 }).used).toBeCloseTo(25)
	expect(balanceOf({ credits: 42 }).display).toBe("42 credits left")
	expect(balanceOf({ used: 30 }).display).toBe("30 credits used")
	const withReset = balanceOf({ totalCredits: 10, usedCredits: 1, resetAt: 1893456000000 })
	expect(withReset.resetsAt).toBeTruthy()
	expect(balanceOf({})).toBe(null)
	expect(balanceOf(null)).toBe(null)
	expect(balanceOf({ hello: "world" })).toBe(null)
})

test("usageOf reads a plan when the profile names one", () => {
	const u = usageOf({ plan: "ClinePass" }, { totalCredits: 100, usedCredits: 10 })
	expect(u.plan).toBe("ClinePass")
	expect(u.windows.length).toBe(1)
	expect(usageOf({}, null).windows).toEqual([])
})

test("failure maps the refusals OpenAI's way", () => {
	expect(failure(401, "expired token")).toEqual({ status: 401, message: "the sign-in lapsed — sign in again" })
	// an empty 403 isn't about the credentials: it passes through
	expect(failure(403, "")).toEqual({ status: 403, message: "Forbidden" })
	expect(failure(403, "unauthorized").status).toBe(401)
	// a 403 about something else — Cline's own-surface models — passes through
	const gated = failure(403, JSON.stringify({ error: { message: "cline-free/mimo is only available via Cline product surfaces" } }))
	expect(gated.status).toBe(403)
	expect(gated.message).toContain("product surfaces")
	expect(failure(429, "rate limited").status).toBe(429)
	const broke = failure(402, "Insufficient credits")
	expect(broke.status).toBe(429)
	expect(broke.message).toContain("out of credits")
	expect(failure(500, "boom").status).toBe(500)
	expect(failure(90, "weird").status).toBe(502)
	expect(failure(503, "").message).toBeTruthy()
})

test("deviceAuthorize wants a device code back", async () => {
	serve([
		["user_management/authorize/device", () => Response.json({ device_code: "dc", verification_uri: "https://x" })],
	])
	const d = await deviceAuthorize()
	expect(d.device_code).toBe("dc")
	serve([
		["user_management/authorize/device", () => Response.json({ incomplete: true })],
	])
	await expect(deviceAuthorize()).rejects.toThrow("incomplete")
})

test("an auth entry is read the same however it was stored", () => {
	const a = authOf({ type: "oauth", access: "a", refresh: "r", expires: 5, uid: "u", accountId: "x" })
	expect(a).toEqual({ type: "oauth", access: "a", refresh: "r", expires: 5, key: "", uid: "u", email: "", name: "", accountId: "x" })
	expect(authOf({ type: "api", key: "k" }).type).toBe("api")
	expect(authOf(null).type).toBe("oauth")
})
