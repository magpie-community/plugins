// Tests for auth.refresh, the hook magpie renews a sign-in through ahead of
// its end. Every request is answered by a mock fetch; nothing reaches the
// network.
import { test, expect, afterEach } from "bun:test"
import { ClinePlugin } from "./index.mjs"

const API = "https://api.cline.bot/api/v1"
const chatUrl = `${API}/chat/completions`
const chatInit = () => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "anthropic/claude-sonnet-5" }) })

let calls = []
const realFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = realFetch
})

// serve answers each URL from routes ([urlPart, (init) => Response]), in
// order; an unmatched URL fails loudly
function serve(routes) {
	routes = [...routes]
	calls = []
	globalThis.fetch = async (input, init = {}) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		calls.push({ url, init })
		const idx = routes.findIndex(([part]) => url.includes(part))
		if (idx < 0) throw new Error(`no route for ${url}`)
		const r = routes[idx][1]
		routes.splice(idx, 1)
		return r(init)
	}
}

const refreshes = () => calls.filter((c) => c.url.includes("/auth/refresh"))

const rotated = (n, extra = {}) => () =>
	Response.json({ success: true, data: { accessToken: `jwt${n}`, refreshToken: `r${n}`, expiresAt: new Date(Date.now() + 3600_000).toISOString(), userInfo: { clineUserId: "cu1", ...extra } } })

// plugin is the plugin over a store that saves what client.auth.set is given
async function plugin(seed) {
	const saved = []
	let stored = seed
	const client = {
		app: { log: async () => {} },
		auth: {
			set: async (input) => {
				saved.push(input.body)
				stored = input.body
			},
		},
	}
	return { hooks: await ClinePlugin({ client }), saved, getAuth: async () => stored }
}

const due = () => ({ type: "oauth", access: "jwt1", refresh: "r1", expires: Date.now() + 60_000, uid: "cu1", email: "a@b.c", accountId: "a@b.c" })

test("the lead is no shorter than the check before each request", async () => {
	const { hooks } = await plugin(due())
	expect(hooks.auth.refreshLead).toBeGreaterThanOrEqual(5 * 60 * 1000)
	expect(hooks.auth.rotating).toBe(true)
	expect(typeof hooks.auth.refresh).toBe("function")
})

test("auth.refresh renews and gives the new pair, leaving the save to magpie", async () => {
	const { hooks, saved } = await plugin(due())
	serve([["/auth/refresh", rotated(2)]])
	const got = await hooks.auth.refresh(due())
	expect(got.access).toBe("jwt2")
	expect(got.refresh).toBe("r2")
	expect(got.expires).toBeGreaterThan(Date.now() + 50 * 60_000)
	// only what changed: no type, nothing the sign-in had already
	expect(got.type).toBeUndefined()
	expect(got.uid).toBeUndefined()
	expect(got.email).toBeUndefined()
	expect(JSON.parse(refreshes()[0].init.body).refreshToken).toBe("r1")
	expect(saved.length).toBe(0)
})

test("auth.refresh and a request's refresh at once spend the refresh token once", async () => {
	for (const hookFirst of [true, false]) {
		const { hooks, getAuth } = await plugin(due())
		// the refresh is held open until both are under way
		let open
		const gate = new Promise((r) => (open = r))
		serve([["/auth/refresh", async () => (await gate, rotated(2)())], [chatUrl, () => Response.json({ ok: true })]])
		const l = await hooks.auth.loader(getAuth)
		const started = async () => {
			while (!refreshes().length) await new Promise((r) => setTimeout(r, 1))
		}
		let got, res
		if (hookFirst) {
			const h = hooks.auth.refresh(due())
			await started()
			const q = l.fetch(chatUrl, chatInit())
			open()
			;[got, res] = await Promise.all([h, q])
		} else {
			const q = l.fetch(chatUrl, chatInit())
			await started()
			const h = hooks.auth.refresh(due())
			open()
			;[got, res] = await Promise.all([h, q])
		}
		expect(res.status).toBe(200)
		expect(got.access).toBe("jwt2")
		expect(got.refresh).toBe("r2")
		expect(refreshes().length).toBe(1)
		expect(calls.find((c) => c.url === chatUrl).init.headers.get("Authorization")).toBe("Bearer workos:jwt2")
	}
})

test("a refresh Cline refuses is the sign-in expired", async () => {
	const { hooks, saved } = await plugin(due())
	serve([["/auth/refresh", () => Response.json({ error: "invalid_grant", error_description: "refresh token revoked" }, { status: 400 })]])
	const e = await hooks.auth.refresh(due()).then(() => null, (e) => e)
	expect(e).toBeInstanceOf(Error)
	expect(e.signIn).toBe("expired")
	expect(saved.length).toBe(0)
})

test("a refresh that failed for a while throws plainly, for magpie to retry", async () => {
	const { hooks } = await plugin(due())
	serve([["/auth/refresh", () => new Response("upstream down", { status: 503 })]])
	const e = await hooks.auth.refresh(due()).then(() => null, (e) => e)
	expect(e).toBeInstanceOf(Error)
	expect(e.signIn).toBeUndefined()
	// and the refresh token wasn't spent: the next try sends it again
	serve([["/auth/refresh", rotated(2)]])
	expect((await hooks.auth.refresh(due())).access).toBe("jwt2")
	expect(JSON.parse(refreshes()[0].init.body).refreshToken).toBe("r1")
})

test("an account with nothing to renew with gives nothing", async () => {
	const { hooks } = await plugin(due())
	serve([])
	expect(await hooks.auth.refresh({ type: "api", key: "ck" })).toBeUndefined()
	expect(await hooks.auth.refresh({ type: "oauth", access: "jwt1", refresh: "", expires: Date.now() + 60_000 })).toBeUndefined()
	expect(calls.length).toBe(0)
})
