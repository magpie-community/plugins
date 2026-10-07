// Tests for the Cline provider plugin. Every request the plugin would make is
// answered by a mock fetch here; nothing reaches the network.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { ClinePlugin, _internal } from "./index.mjs"

const { authOf, parseAuth, parseFeed, prettify, creditsOf, balanceUSD, usd, usageOf, limitWindows, failure, bearerOf, toMs, refresh, deviceAuthorize, pollDevice, clientHeaders, constants: { CLIENT, DEFAULT_MODELS } } = _internal

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
	// the numbers are what has to match: the CLI release, and the @cline/core
	// that release ships (cline@3.0.68 depends on 0.0.90, not 3.0.67's 0.0.89)
	expect(CLIENT.version).toBe("3.0.68")
	expect(CLIENT.core).toBe("0.0.90")
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

test("a rotated pair survives a failing auth.set more than once", async () => {
	const { client: c, saved, store, seed } = client()
	c.auth.set = async () => {
		throw new Error("disk full")
	}
	const hooks = await ClinePlugin({ client: c })
	// Cline refuses a refresh token it has already spent, as WorkOS does: with
	// the save failing every time, getAuth goes on handing back the first pair,
	// and each rotation must move on to the newest one rather than walk back
	const spent = new Set()
	let n = 0
	const rotating = (init) => {
		const { refreshToken } = JSON.parse(init.body)
		if (spent.has(refreshToken)) return Response.json({ error: "invalid_grant" }, { status: 400 })
		spent.add(refreshToken)
		n += 1
		return Response.json({ success: true, data: { accessToken: `jwt${n}`, refreshToken: `r${n}`, expiresAt: new Date(Date.now() + 1000).toISOString(), userInfo: { clineUserId: "cu1" } } })
	}
	const ok = () => Response.json({ ok: true })
	serve([
		["/auth/refresh", rotating], [chatUrl, ok],
		["/auth/refresh", rotating], [chatUrl, ok],
		["/auth/refresh", rotating], [chatUrl, ok],
	])
	// every token expires inside the refresh lead, so each request renews
	seed({ type: "oauth", access: "jwt0", refresh: "r0", expires: Date.now() + 1000, uid: "cu1", accountId: "a@b.c" })
	const l = await hooks.auth.loader(store)
	const out = [await l.fetch(chatUrl, chatInit()), await l.fetch(chatUrl, chatInit()), await l.fetch(chatUrl, chatInit())]
	expect(out.map((r) => r.status)).toEqual([200, 200, 200])
	// each refresh spends the pair the one before it minted — r0 is never
	// offered a second time (against 0.1.0 the third request re-spent it, got
	// invalid_grant and answered 401)
	expect(calls.filter((x) => x.url.includes("/auth/refresh")).map((x) => JSON.parse(x.init.body).refreshToken)).toEqual(["r0", "r1", "r2"])
	expect(calls.filter((x) => x.url === chatUrl).map((x) => x.init.headers.get("Authorization"))).toEqual(["Bearer workos:jwt1", "Bearer workos:jwt2", "Bearer workos:jwt3"])
	expect(saved.length).toBe(0)
})

test("the held pair is kept per rotation chain, so no account is sent on another's token", async () => {
	const { client: c, saved } = client()
	c.auth.set = async () => {
		throw new Error("disk full")
	}
	const hooks = await ClinePlugin({ client: c })
	// magpie calls ClinePlugin once for the provider and hands every account its
	// own getAuth, so two accounts are two chains on one plugin instance
	const accounts = ["A", "B"].map((who) => {
		const stored = { type: "oauth", access: `${who}-jwt0`, refresh: `${who}-r0`, expires: Date.now() + 1000, uid: `cu-${who}`, accountId: `${who}@b.c` }
		return async () => stored
	})
	// Cline refuses a refresh token it has already spent and every token wants
	// renewing again, so a request riding the wrong account's pair shows up
	const spent = new Set()
	const rotating = (init) => {
		const { refreshToken } = JSON.parse(init.body)
		if (spent.has(refreshToken)) return Response.json({ error: "invalid_grant" }, { status: 400 })
		spent.add(refreshToken)
		const [who, n] = refreshToken.split("-r")
		return Response.json({ success: true, data: { accessToken: `${who}-jwt${Number(n) + 1}`, refreshToken: `${who}-r${Number(n) + 1}`, expiresAt: new Date(Date.now() + 1000).toISOString(), userInfo: { clineUserId: `cu-${who}` } } })
	}
	const ok = () => Response.json({ ok: true })
	serve([
		["/auth/refresh", rotating], [chatUrl, ok],
		["/auth/refresh", rotating], [chatUrl, ok],
		["/auth/refresh", rotating], [chatUrl, ok],
	])
	const [a, b] = await Promise.all([hooks.auth.loader(accounts[0]), hooks.auth.loader(accounts[1])])
	const out = [await a.fetch(chatUrl, chatInit()), await b.fetch(chatUrl, chatInit()), await a.fetch(chatUrl, chatInit())]
	expect(out.map((r) => r.status)).toEqual([200, 200, 200])
	// A, B, A: each goes out on its own account's token, and each refresh spends
	// one of that same account's — the third request must ride A's second pair,
	// not the newest pair any account reached (a shared `held` sent B's there)
	expect(calls.filter((x) => x.url === chatUrl).map((x) => x.init.headers.get("Authorization"))).toEqual(["Bearer workos:A-jwt1", "Bearer workos:B-jwt1", "Bearer workos:A-jwt2"])
	expect(calls.filter((x) => x.url.includes("/auth/refresh")).map((x) => JSON.parse(x.init.body).refreshToken)).toEqual(["A-r0", "B-r0", "A-r1"])
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

test("a renewal clears the mark even when the chat that follows fails", async () => {
	const { client: c, store, seed } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		["/auth/refresh", () => Response.json({ success: true, data: { accessToken: "jwt2", refreshToken: "r2", expiresAt: new Date(Date.now() + 3600_000).toISOString(), userInfo: { clineUserId: "cu1" } } })],
		[chatUrl, () => Response.json({ error: { message: "boom" } }, { status: 500 })],
	])
	seed({ type: "oauth", access: "jwt1", refresh: "r1", expires: Date.now() + 1000, uid: "cu1", accountId: "a@b.c" })
	const l = await hooks.auth.loader(store)
	const res = await l.fetch(chatUrl, chatInit())
	expect(res.status).toBe(500)
	// the token was renewed, so the sign-in mark is cleared (renewed) even
	// though the request failed — the renewed mark survives a failed request
	expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
})

test("a renewal's mark survives a network error on the chat itself", async () => {
	const { client: c, store, seed } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		["/auth/refresh", () => Response.json({ success: true, data: { accessToken: "jwt2", refreshToken: "r2", expiresAt: new Date(Date.now() + 3600_000).toISOString(), userInfo: { clineUserId: "cu1" } } })],
		[chatUrl, () => {
			throw new Error("socket hang up")
		}],
	])
	seed({ type: "oauth", access: "jwt1", refresh: "r1", expires: Date.now() + 1000, uid: "cu1", accountId: "a@b.c" })
	const l = await hooks.auth.loader(store)
	const res = await l.fetch(chatUrl, chatInit())
	// the token was renewed and a request that never left the machine is an
	// ordinary failure: the mark comes off here too, not only on an answer
	expect(res.status).toBe(502)
	expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
	expect((await res.json()).error.message).toContain("socket hang up")
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
	// what is used of the whole, so a card that says left says 750 / 1000
	expect(out.windows[0].amount).toBe(250)
	expect(out.windows[0].limit).toBe(1000)
})

// magpie says a window's share from what is used of it, so a window made of a
// count alone reads as 0% used: its bar full and "100% left", whatever the
// balance. Cline's accounts are served {balance} in millionths of a dollar,
// and the card said "$0.48 left" beside 100% left.
test("a balance with no whole is the card's balance, not a meter", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		["/users/me", () => Response.json({ success: true, data: { clineUserId: "cu1", email: "a@b.c" } })],
		["/users/cu1/balance", () => Response.json({ success: true, data: { balance: 480000 } })],
	])
	const out = await hooks.auth.usage(async () => ({ type: "api", key: "ck", accountId: "a@b.c" }))
	expect(out.balance).toBe("$0.48")
	expect(out.windows).toEqual([])
})

test("usage reads ClinePass's 5-hour, weekly and monthly limits", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		["/users/me/plan/usage-limits", () => Response.json({ success: true, data: { limits: [
			{ type: "monthly", percentUsed: 12.5, resetsAt: "2026-11-01T00:00:00.000Z" },
			{ type: "five_hour", percentUsed: 40, resetsAt: "2026-10-05T15:00:00.000Z" },
			{ type: "weekly", percentUsed: 130 },
		] } })],
		["/users/me", () => Response.json({ success: true, data: { clineUserId: "cu1" } })],
		["/users/cu1/balance", () => Response.json({ success: true, data: { balance: 25000000 } })],
	])
	const out = await hooks.auth.usage(async () => ({ type: "api", key: "ck" }))
	expect(out.windows).toEqual([
		{ name: "5 hours", used: 40, span: 18000, resetsAt: "2026-10-05T15:00:00.000Z" },
		{ name: "Weekly", used: 100, span: 604800 },
		{ name: "Month", used: 12.5, span: 2592000, resetsAt: "2026-11-01T00:00:00.000Z" },
	])
	// the credits are a balance, not a fourth meter
	expect(out.balance).toBe("$25.00")
	const limits = calls.find((x) => x.url.endsWith("/users/me/plan/usage-limits"))
	expect(limits.init.headers.Authorization).toBe("Bearer ck")
})

test("an account whose limits can't be read keeps its balance and its sign-in", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		["/users/me/plan/usage-limits", () => Response.json({ success: false, error: "no active plan" }, { status: 403 })],
		["/users/me", () => Response.json({ success: true, data: { clineUserId: "cu1" } })],
		["/users/cu1/balance", () => Response.json({ success: true, data: { balance: 1000000 } })],
	])
	const out = await hooks.auth.usage(async () => ({ type: "api", key: "ck" }))
	expect(out.signIn).toBe("kept")
	expect(out.error).toBeUndefined()
	expect(out.windows).toEqual([])
	expect(out.balance).toBe("$1.00")
})

test("limitWindows leaves out what it doesn't know", () => {
	expect(limitWindows(null)).toEqual([])
	expect(limitWindows({ limits: [{ type: "daily", percentUsed: 5 }, { type: "five_hour" }] })).toEqual([{ name: "5 hours", used: 0, span: 18000 }])
})

test("usage tries the ids users/me names, in order", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		["/users/me", () => Response.json({ success: true, data: { subject: "sub1" } })],
		["/users/sub1/balance", () => Response.json({ success: true, data: { credits: "42" } })],
	])
	const out = await hooks.auth.usage(async () => ({ type: "api", key: "ck" }))
	expect(out.windows).toEqual([])
	expect(out.balance).toBe("42 credits")
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

test("the models hook gives each model the window Cline's catalog has for it, and no reply limit", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([
		["/ai/cline/recommended-models", () => Response.json({ recommended: [{ id: "anthropic/claude-sonnet-5.5" }], free: [{ id: "cline-free/mimo-v2.6-flash" }] })],
		["/ai/cline/models", () => Response.json({ data: [
			{ id: "anthropic/claude-sonnet-5.5", context: 0, context_length: 1000000, top_provider: { context_length: 1000000, max_completion_tokens: 128000 } },
			{ id: "inclusionai/ling-3.1-flash", context_length: "262144", top_provider: { max_completion_tokens: 32768 } },
			{ id: "only/top", top_provider: { context_length: 200000 } },
			{ id: "no/size", context_length: null },
		] })],
	])
	const out = await hooks.provider.models({ models: {} })
	expect(out["anthropic/claude-sonnet-5.5"].limit).toEqual({ context: 1000000, output: 0 })
	expect(out["inclusionai/ling-3.1-flash"].limit).toEqual({ context: 262144, output: 0 })
	expect(out["only/top"].limit).toEqual({ context: 200000, output: 0 })
	// one the catalog doesn't list, or lists without a size, says none: magpie
	// gives it models.dev's for the model after its prefix
	expect(out["cline-free/mimo-v2.6-flash"].limit).toEqual({ context: 0, output: 0 })
	expect(out["no/size"].limit).toEqual({ context: 0, output: 0 })
})

test("prettify reads a model id as a name", () => {
	expect(prettify("anthropic/claude-sonnet-5.5")).toBe("Claude Sonnet 5.5")
	expect(prettify("openai/gpt-6-astra")).toBe("GPT 6 Astra")
	expect(prettify("moonshotai/kimi-k3")).toBe("Kimi K3")
})

test("balanceUSD reads Cline's balance shape, in dollars", () => {
	expect(balanceUSD({ balance: 4507 })).toBe("$0.0045")
	expect(balanceUSD({ balance: 25000000 })).toBe("$25.00")
	expect(balanceUSD({ balance: 0 })).toBe("$0.00")
	expect(balanceUSD({ balance: "900000" })).toBe("$0.90")
	expect(balanceUSD({ totalCredits: 100 })).toBe(null)
	expect(balanceUSD(null)).toBe(null)
})

test("usd writes cents above a cent and four decimals under one", () => {
	expect(usd(25)).toBe("$25.00")
	expect(usd(0.0045)).toBe("$0.0045")
	expect(usd(0)).toBe("$0.00")
	expect(usd(0.9)).toBe("$0.90")
})

test("creditsOf reads a whole as a window, a count alone as the balance", () => {
	expect(creditsOf({ totalCredits: 1000, usedCredits: 250 })).toEqual({ window: { name: "Credits", used: 25, amount: 250, limit: 1000, display: "250 / 1000" } })
	expect(creditsOf({ total: 100, remaining: 75 }).window.used).toBeCloseTo(25)
	expect(creditsOf({ total: 100, remaining: 75 }).window.amount).toBe(25)
	expect(creditsOf({ credits: 42 })).toEqual({ balance: "42 credits" })
	// what is used alone is no share of anything: a line, set aside
	expect(creditsOf({ used: 30 })).toEqual({ window: { name: "Credits", used: 0, aside: true, display: "30 credits used" } })
	const withReset = creditsOf({ totalCredits: 10, usedCredits: 1, resetAt: 1893456000000 })
	expect(withReset.window.resetsAt).toBeTruthy()
	expect(creditsOf({})).toEqual({})
	expect(creditsOf(null)).toEqual({})
	expect(creditsOf({ hello: "world" })).toEqual({})
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
	expect(failure(403, "Unauthorized").status).toBe(401)
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

test("failure keys on Cline's codes and whole phrases, not loose substrings", () => {
	// a 403 that merely mentions "tokens" is not a lapsed sign-in: the message
	// is kept as the gateway wrote it
	const tooMany = failure(403, JSON.stringify({ error: { message: "max_tokens exceeds the model's limit" } }))
	expect(tooMany.status).toBe(403)
	expect(tooMany.message).toContain("max_tokens exceeds")
	// "credit" somewhere in the text is not a rate limit either
	const note = failure(400, JSON.stringify({ error: { message: "this credit card was declined by the issuer" } }))
	expect(note.status).toBe(400)
	expect(note.message).toContain("credit card")
	// the codes Cline's client actually raises
	expect(failure(403, JSON.stringify({ error: { code: "ENTITLEMENT_ERROR", message: "no plan" } })).status).toBe(403)
	expect(failure(429, JSON.stringify({ error: { code: "SPEND_LIMIT_EXCEEDED", message: "org budget spent" } })).status).toBe(429)
	// the gateway's own wording for a plan the account hasn't got
	const notSubscribed = failure(403, JSON.stringify({ error: { message: "Error 403: the user is not subscribed to required model plan" } }))
	expect(notSubscribed.status).toBe(403)
	expect(notSubscribed.message).toContain("ClinePass")
	expect(failure(403, "Unauthorized").status).toBe(401)
	expect(failure(401, "anything at all").status).toBe(401)
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

// ---- the device poll --------------------------------------------------------------

// a poller whose clock and fetch answer from a script, so no real waiting
function pollScript(replies) {
	const waits = []
	const fetched = []
	let i = 0
	let clock = 0
	return {
		waits,
		fetched,
		fetchImpl: async (url) => {
			fetched.push(url)
			const r = replies[i++]
			clock += (waits.at(-1) ?? 0) * 1000
			if (r instanceof Error) throw r
			return r
		},
		sleep: async (ms) => waits.push(ms / 1000),
		now: () => clock,
	}
}

test("slow_down raises the interval for every later poll", async () => {
	const p = pollScript([
		Response.json({ error: "slow_down" }, { status: 400 }),
		Response.json({ error: "authorization_pending" }, { status: 400 }),
		Response.json({ access_token: "wt", refresh_token: "wr" }),
	])
	const j = await pollDevice({ device_code: "dc", interval: 1, expires_in: 300 }, p)
	expect(j.access_token).toBe("wt")
	// 1s, then 2s (raised), then 2s again (kept) — not back to 1
	expect(p.waits).toEqual([1, 2, 2])
})

test("the poll starts at a second, whatever the code asked for", async () => {
	const p = pollScript([Response.json({ access_token: "wt" })])
	await pollDevice({ device_code: "dc", interval: 0.25, expires_in: 300 }, p)
	expect(p.waits).toEqual([1])
})

test("a 5xx, a non-JSON 2xx or a network error is a poll to try again", async () => {
	const p = pollScript([
		Response.json({ boom: true }, { status: 503 }),
		new Response("not json", { headers: { "Content-Type": "text/plain" } }),
		new Error("network down"),
		Response.json({ access_token: "wt", refresh_token: "wr" }),
	])
	const j = await pollDevice({ device_code: "dc", interval: 1, expires_in: 300 }, p)
	expect(j.access_token).toBe("wt")
	expect(p.fetched.length).toBe(4)
})

test("a reply that isn't JSON and isn't a 5xx fails the poll straight away", async () => {
	const p = pollScript([new Response("<html>bad request</html>", { status: 400, headers: { "Content-Type": "text/html" } })])
	// an HTML 400 used to read as WorkOS having a moment, so the poll ran on to
	// the deadline — ten minutes on a sign-in that was never going to finish
	await expect(pollDevice({ device_code: "dc", interval: 1, expires_in: 300 }, p)).rejects.toThrow("refused (HTTP 400)")
	expect(p.fetched.length).toBe(1)
})

test("a refusal the browser made still fails the poll", async () => {
	const p = pollScript([Response.json({ error: "access_denied", error_description: "user said no" }, { status: 400 })])
	await expect(pollDevice({ device_code: "dc", interval: 1, expires_in: 300 }, p)).rejects.toThrow("access_denied")
})

test("an auth entry is read the same however it was stored", () => {
	const a = authOf({ type: "oauth", access: "a", refresh: "r", expires: 5, uid: "u", accountId: "x" })
	expect(a).toEqual({ type: "oauth", access: "a", refresh: "r", expires: 5, key: "", uid: "u", email: "", name: "", accountId: "x" })
	expect(authOf({ type: "api", key: "k" }).type).toBe("api")
	expect(authOf(null).type).toBe("oauth")
})

// ---- pinUpstream: DeepSeek's models only through DeepSeek's own API -------------

test("pinBody pins a DeepSeek model to DeepSeek's API, keeping the body's prefix", () => {
	const { pinBody, pinned } = _internal
	const body = `{"model":"cline-pass/deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}],"stream":true}`
	const out = pinBody(body, JSON.parse(body), true)
	expect(out.startsWith(body.slice(0, -1))).toBe(true)
	expect(JSON.parse(out).providerOptions).toEqual({ gateway: { only: ["deepseek"] } })
	// off, another vendor's model, a free model, or the client's own options: as sent
	expect(pinBody(body, JSON.parse(body), false)).toBe(body)
	const glm = `{"model":"cline-pass/glm-5.3"}`
	expect(pinBody(glm, JSON.parse(glm), true)).toBe(glm)
	const free = `{"model":"cline-free/deepseek-v4.1-flash"}`
	expect(pinBody(free, JSON.parse(free), true)).toBe(free)
	const own = `{"model":"deepseek/deepseek-v4-pro","providerOptions":{"gateway":{"only":["fireworks"]}}}`
	expect(pinBody(own, JSON.parse(own), true)).toBe(own)
	expect(pinned(true, "DeepSeek/DeepSeek-V4-Pro")).toBe("deepseek")
	expect(JSON.parse(pinBody(`{}`, {}, true))).toEqual({})
})

for (const [how, plugin, provider] of [
	["the plugin's own option", { pinUpstream: true }, undefined],
	["OpenCode's provider.cline.options", undefined, { id: "cline", options: { pinUpstream: true } }],
]) {
	test(`pinUpstream set as ${how} pins DeepSeek requests, and only them`, async () => {
		const { client: c } = client()
		const hooks = await ClinePlugin({ client: c }, plugin)
		serve([
			[chatUrl, () => Response.json({ ok: true })],
			[chatUrl, () => Response.json({ ok: true })],
		])
		const l = await hooks.auth.loader(async () => ({ type: "api", key: "ck" }), provider)
		await l.fetch(chatUrl, chatInit({ model: "cline-pass/deepseek-v4-pro", messages: [] }))
		await l.fetch(chatUrl, chatInit({ model: "cline-pass/kimi-k3", messages: [] }))
		expect(JSON.parse(calls[0].init.body).providerOptions).toEqual({ gateway: { only: ["deepseek"] } })
		expect(JSON.parse(calls[1].init.body).providerOptions).toBeUndefined()
	})
}

test("without pinUpstream a DeepSeek request goes as sent", async () => {
	const { client: c } = client()
	const hooks = await ClinePlugin({ client: c })
	serve([[chatUrl, () => Response.json({ ok: true })]])
	const l = await hooks.auth.loader(async () => ({ type: "api", key: "ck" }), { id: "cline", options: {} })
	const sent = { model: "cline-pass/deepseek-v4-pro", messages: [] }
	await l.fetch(chatUrl, chatInit(sent))
	expect(calls[0].init.body).toBe(JSON.stringify(sent))
})
