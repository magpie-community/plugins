import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { DeepRelayPlugin, _internal } from "./index.mjs"
import { BALANCE, MODELS, SUBSCRIPTION, startFake } from "./test/fake.mjs"

const { API, SESSION, OUTPUT_FALLBACK } = _internal.constants

let fake

beforeAll(() => {
	fake = startFake()
})

afterAll(() => {
	fake.stop()
})

beforeEach(() => {
	fake.state.models = MODELS
	fake.state.subscription = SUBSCRIPTION
	fake.state.balance = BALANCE
	fake.state.catalogStatus = 200
	fake.state.subscriptionStatus = 200
	fake.state.balanceStatus = 200
	fake.state.requests.length = 0
	_internal.clearCatalog()
})

const hooks = () => DeepRelayPlugin({}, { api: fake.base })

// ---- catalog mapping -------------------------------------------------------------

describe("catalog mapping", () => {
	test("drops DeepRelay's prefix from the key but keeps the API id", () => {
		expect(_internal.keyOf("deeprelay/deepseek-v4.1-flash")).toBe("deepseek-v4.1-flash")
		expect(_internal.keyOf("deepseek-v4.1-flash")).toBe("deepseek-v4.1-flash")
		expect(_internal.keyOf(undefined)).toBe("")
	})

	test("maps a plan-covered model: limits, capabilities, variants, cost", () => {
		const models = _internal.modelsOf(MODELS, "https://api.deeprelay.ai/v1")
		const m = models["deepseek-v4.1-flash"]
		expect(m.id).toBe("deeprelay/deepseek-v4.1-flash")
		expect(m.api).toEqual({ id: "deeprelay/deepseek-v4.1-flash", url: "https://api.deeprelay.ai/v1", npm: "@ai-sdk/openai-compatible" })
		expect(m.name).toBe("DeepSeek V4.1 Flash 1017")
		expect(m.limit).toEqual({ context: 1048576, output: 393216 })
		expect(m.capabilities.reasoning).toBe(true)
		expect(m.capabilities.temperature).toBe(true)
		expect(m.capabilities.toolcall).toBe(true)
		expect(m.capabilities.attachment).toBe(true)
		expect(m.capabilities.input.image).toBe(true)
		expect(Object.keys(m.variants)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
		expect(m.cost.input).toBeCloseTo(0.0675, 6)
		expect(m.cost.output).toBeCloseTo(0.27, 6)
		expect(m.cost.cache.read).toBeCloseTo(0.0014, 8)
		expect(m.rate).toBeUndefined()
		expect(m.status).toBe("active")
	})

	test("a plan-covered model with a usage factor carries it as a rate", () => {
		const m = _internal.modelsOf(MODELS)["glm-5.3"]
		expect(m.rate).toBe(12)
		expect(m.name).toBe("GLM 5.3")
	})

	test("a pay-as-you-go model is marked and carries no plan rate", () => {
		const m = _internal.modelsOf(MODELS)["deepseek-v4-pro"]
		expect(m.name).toBe("DeepSeek V4 Pro · PAYG")
		expect(m.rate).toBeUndefined()
		expect(m.capabilities.reasoning).toBe(false)
		expect(m.variants).toEqual({})
	})

	test("an economy tier keeps its suffix and falls back for the output cap", () => {
		const m = _internal.modelsOf(MODELS)["qwen3.8-flash:economy"]
		expect(m.id).toBe("deeprelay/qwen3.8-flash:economy")
		expect(m.name).toBe("Qwen 3.8 Flash · Economy · PAYG")
		expect(m.limit.output).toBe(OUTPUT_FALLBACK)
	})

	test("leaves out placeholders and non-chat models", () => {
		const models = _internal.modelsOf(MODELS)
		expect(models.soon).toBeUndefined()
		expect(models["seedream-4.0"]).toBeUndefined()
	})

	test("lists plan-covered models first, then by coding-agent rank", () => {
		const models = _internal.modelsOf(MODELS)
		expect(Object.keys(models)).toEqual(["deepseek-v4.1-flash", "glm-5.3", "deepseek-v4-pro", "qwen3.8-flash:economy"])
	})

	test("a ranked model comes before an unranked one, whatever the names", () => {
		const models = _internal.modelsOf([
			{ id: "deeprelay/aaa", modality: "chat", status: "active", plan_covered: true, name: "AAA" },
			{ id: "deeprelay/zzz", modality: "chat", status: "active", plan_covered: true, name: "ZZZ", coding_agent_rank: 1 },
		])
		expect(Object.keys(models)).toEqual(["zzz", "aaa"])
	})

	test("cost follows the catalog's current period, not always off-peak", () => {
		const m = _internal.modelsOf([{ ...MODELS[0], pricing: { ...MODELS[0].pricing, period: "peak" } }])["deepseek-v4.1-flash"]
		expect(m.cost.input).toBeCloseTo(0.135, 6)
		expect(m.cost.output).toBeCloseTo(0.54, 6)
		expect(m.cost.cache.read).toBeCloseTo(0.0027, 8)
	})

	test("keeps both models when two ids would share a key", () => {
		const models = _internal.modelsOf([
			{ id: "deeprelay/x", modality: "chat", status: "active" },
			{ id: "x", modality: "chat", status: "active" },
		])
		expect(Object.keys(models)).toEqual(["x", "x#2"])
		expect(models.x.id).toBe("deeprelay/x")
		expect(models["x#2"].id).toBe("x")
	})
})

// ---- usage -----------------------------------------------------------------------

describe("usage windows", () => {
	test("builds the plan's meters in order", () => {
		const windows = _internal.windowsOf(SUBSCRIPTION)
		expect(windows.map((w) => w.name)).toEqual(["月输入", "月输出", "周输入", "周输出"])

		const monthly = windows[0]
		expect(monthly.amount).toBe(18.2)
		expect(monthly.limit).toBe(2500)
		expect(monthly.unit).toBe("M tokens")
		expect(monthly.used).toBeCloseTo(0.73, 2)
		expect(monthly.display).toBe("18.2M / 2,500M")
		expect(monthly.span).toBe(30 * 86400)

		// one reset for the monthly windows, on the second, so the account
		// row ends with it
		expect(monthly.resetsAt).toBeUndefined()
		expect(windows[1].resetsAt).toBe("2026-12-17T10:54:49Z")
		expect(windows[1].amount).toBe(0.34)
		expect(windows[1].limit).toBe(250)
		expect(windows[1].display).toBe("0.34M / 250M")

		const weekly = windows[2]
		expect(weekly.resetsAt).toBeUndefined()
		expect(weekly.span).toBe(7 * 86400)
		expect(weekly.display).toBe("18.2M / 625M")
	})

	test("leaves out a cap the deployment does not configure", () => {
		const sub = { ...SUBSCRIPTION, quota: { ...SUBSCRIPTION.quota, weekly_input_tokens: 0 } }
		const names = _internal.windowsOf(sub).map((w) => w.name)
		expect(names).toEqual(["月输入", "月输出", "周输出"])
	})

	test("says when calls were billed to the wallet", () => {
		const sub = { ...SUBSCRIPTION, usage: { ...SUBSCRIPTION.usage, recent_payg_calls_24h: 3 } }
		const w = _internal.windowsOf(sub).at(-1)
		expect(w).toEqual({ name: "钱包调用（24 小时）", display: "3 次调用按量计费", aside: true })
	})

	test("no usage block means no windows, never zeros", () => {
		const sub = { ...SUBSCRIPTION, usage: undefined }
		expect(_internal.windowsOf(sub)).toEqual([])
	})
})

describe("usage hook", () => {
	const auth = async () => ({ type: "api", key: "k-usage" })

	test("reads the plan, the period and the balance", async () => {
		const u = await (await hooks()).auth.usage(auth)
		expect(u.plan).toBe("Plus")
		expect(u.until).toBe("2026-12-17T10:54:49Z")
		expect(u.renew).toBe("auto")
		expect(u.balance).toBe("$12.40")
		expect(u.windows.length).toBe(4)
		expect(u.error).toBeUndefined()
	})

	test("a cancelled plan says it will not renew", async () => {
		fake.state.subscription = { ...SUBSCRIPTION, cancel_at_period_end: true }
		const u = await (await hooks()).auth.usage(auth)
		expect(u.renew).toBe("off")
	})

	test("an unsubscribed org is pay-as-you-go, not a 0% plan", async () => {
		fake.state.subscription = { ...SUBSCRIPTION, subscribed: false, status: "none", usage: undefined }
		const u = await (await hooks()).auth.usage(auth)
		expect(u.plan).toBe("按量计费")
		expect(u.windows).toEqual([])
		expect(u.until).toBeUndefined()
		expect(u.balance).toBe("$12.40")
	})

	test("a key without billing:read says which scope to add", async () => {
		fake.state.subscriptionStatus = 403
		const u = await (await hooks()).auth.usage(auth)
		expect(u.error).toContain("billing:read")
		expect(u.signIn).toBeUndefined()
		expect(u.balance).toBe("$12.40")
	})

	test("a refused key marks the sign-in and keeps the balance it could read", async () => {
		fake.state.subscriptionStatus = 401
		const u = await (await hooks()).auth.usage(auth)
		expect(u.signIn).toBe("expired")
		expect(u.windows).toEqual([])
		expect(u.balance).toBe("$12.40")
	})

	test("a balance read without billing:read keeps the meters", async () => {
		fake.state.balanceStatus = 403
		const u = await (await hooks()).auth.usage(auth)
		expect(u.windows.length).toBe(4)
		expect(u.balance).toBeUndefined()
		expect(u.error).toContain("billing:read")
	})

	test("a keyless account is told to sign in", async () => {
		const u = await (await hooks()).auth.usage(async () => ({ type: "oauth" }))
		expect(u.error).toContain("登录")
	})
})

// ---- the plugin hooks ------------------------------------------------------------

describe("config hook", () => {
	test("declares the provider with the plan's coding models", async () => {
		const cfg = {}
		await (await hooks()).config(cfg)
		const p = cfg.provider.deeprelay
		expect(p.name).toBe("DeepRelay")
		expect(p.npm).toBe("@ai-sdk/openai-compatible")
		expect(p.api).toBe(fake.base)
		expect(Object.keys(p.models)).toEqual(["deepseek-v4.1-flash", "glm-5.3-flash", "glm-5.3", "kimi-k3"])
		expect(p.models["deepseek-v4.1-flash"].id).toBe("deeprelay/deepseek-v4.1-flash")
	})

	test("keeps what the user configured", async () => {
		const cfg = { provider: { deeprelay: { name: "Mine", api: "https://example.test/v1", models: { custom: { name: "Custom" } } } } }
		await (await hooks()).config(cfg)
		expect(cfg.provider.deeprelay.name).toBe("Mine")
		expect(cfg.provider.deeprelay.api).toBe("https://example.test/v1")
		expect(cfg.provider.deeprelay.models.custom).toEqual({ name: "Custom" })
		expect(cfg.provider.deeprelay.models["glm-5.3"]).toBeDefined()
	})
})

describe("provider.models hook", () => {
	test("reads the catalog for the account", async () => {
		const out = await (await hooks()).provider.models({ models: {} }, { auth: { type: "api", key: "k-models" } })
		expect(Object.keys(out).sort()).toEqual(["deepseek-v4-pro", "deepseek-v4.1-flash", "glm-5.3", "qwen3.8-flash:economy"])
		expect(fake.state.requests.at(-1).headers.authorization).toBe("Bearer k-models")
		expect(fake.state.requests.at(-1).search).toBe("?modality=chat")
	})

	test("works before a sign-in, anonymously", async () => {
		const out = await (await hooks()).provider.models({ models: {} }, {})
		expect(Object.keys(out)).toContain("deepseek-v4.1-flash")
		expect(fake.state.requests.at(-1).headers.authorization).toBeUndefined()
	})

	test("caches the catalog for a few minutes", async () => {
		const h = await hooks()
		await h.provider.models({ models: {} }, { auth: { type: "api", key: "k-cache" } })
		await h.provider.models({ models: {} }, { auth: { type: "api", key: "k-cache" } })
		expect(fake.state.requests.filter((r) => r.path === "/v1/models").length).toBe(1)
	})

	test("a failed catalog keeps the list magpie had", async () => {
		fake.state.catalogStatus = 500
		const have = { keep: { name: "Keep" } }
		const out = await (await hooks()).provider.models({ models: have }, { auth: { type: "api", key: "k-500" } })
		expect(out).toBe(have)
	})

	test("a refused key marks the sign-in", async () => {
		fake.state.catalogStatus = 401
		let err
		try {
			await (await hooks()).provider.models({ models: {} }, { auth: { type: "api", key: "k-401" } })
		} catch (e) {
			err = e
		}
		expect(err?.signIn).toBe("expired")
	})
})

describe("loader", () => {
	const loaderOf = async (key = "sk-test") => (await hooks()).auth.loader(async () => ({ type: "api", key }))

	test("sends the account's key and moves the session tag onto DeepRelay's header", async () => {
		const loader = await loaderOf()
		expect(loader.baseURL).toBe(fake.base)
		expect(loader.apiKey).toBe("sk-test")
		const res = await loader.fetch(`${fake.base}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", [SESSION]: "sess-1", "x-keep": "yes" },
			body: '{"model":"deeprelay/x"}',
		})
		expect(res.status).toBe(200)
		const req = fake.state.requests.at(-1)
		expect(req.headers.authorization).toBe("Bearer sk-test")
		expect(req.headers["x-client-request-id"]).toBe("sess-1")
		expect(req.headers["x-keep"]).toBe("yes")
		expect(req.headers[SESSION]).toBeUndefined()
		expect(req.body).toBe('{"model":"deeprelay/x"}')
	})

	test("passes a stream through byte for byte", async () => {
		const loader = await loaderOf()
		const res = await loader.fetch(`${fake.base}/chat/completions`, { method: "POST", body: "{}" })
		const text = await res.text()
		expect(text).toContain('"reasoning_content":"think"')
		expect(text).toContain('"content":"ok"')
		expect(text.trim().endsWith("data: [DONE]")).toBe(true)
	})

	test("a keyless account gets no loader", async () => {
		const loader = await (await hooks()).auth.loader(async () => ({ type: "oauth" }))
		expect(loader).toEqual({})
	})

	test("an unreachable host becomes a 502 the agent can show", async () => {
		const loader = await loaderOf()
		const res = await loader.fetch("http://127.0.0.1:1/v1/chat/completions", { method: "POST", body: "{}" })
		expect(res.status).toBe(502)
		expect((await res.json()).error.message).toContain("无法连接")
	})
})

describe("chat.headers", () => {
	test("tags a named session", async () => {
		const out = { headers: {} }
		await (await hooks())["chat.headers"]({ model: { providerID: "deeprelay" }, sessionID: "sess-1" }, out)
		expect(out.headers[SESSION]).toBe("sess-1")
	})

	test("leaves magpie's synthetic session alone", async () => {
		const out = { headers: {} }
		await (await hooks())["chat.headers"]({ model: { providerID: "deeprelay" }, sessionID: "magpie-0123456789abcdef01234567" }, out)
		expect(out.headers[SESSION]).toBeUndefined()
	})

	test("leaves other providers alone", async () => {
		const out = { headers: {} }
		await (await hooks())["chat.headers"]({ model: { providerID: "anthropic" }, sessionID: "sess-1" }, out)
		expect(out.headers[SESSION]).toBeUndefined()
	})
})

describe("helpers", () => {
	test("baseOf only accepts an http(s) API root", () => {
		expect(_internal.baseOf({})).toBe(API)
		expect(_internal.baseOf({ api: "http://127.0.0.1:9/v1/" })).toBe("http://127.0.0.1:9/v1")
		expect(_internal.baseOf({ api: "ftp://example.test" })).toBe(API)
	})

	test("usd keeps a fraction of a cent visible", () => {
		expect(_internal.usd(0)).toBe("$0.00")
		expect(_internal.usd(12.4)).toBe("$12.40")
		expect(_internal.usd(0.1548)).toBe("$0.15")
		expect(_internal.usd(0.0014)).toBe("$0.0014")
	})
})
