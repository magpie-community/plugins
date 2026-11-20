// DeepRelay (deeprelay.ai) for magpie and OpenCode.
//
// The plugin turns a DeepRelay subscription into a provider:
//
//   config            declares `deeprelay` and the plan's coding models
//   auth.loader       sends every request with the account's key
//   provider.models   reads DeepRelay's live catalog for that account
//   auth.usage        reports the plan's meters and the wallet balance
//   chat.headers      tags each request with magpie's session id
//
// DeepRelay speaks OpenAI chat completions, so nothing is translated here:
// magpie's gateway converts whatever the agent speaks, and the AI SDK's
// openai-compatible provider already reads DeepSeek-style `reasoning_content`
// in streaming and non-streaming replies. The plugin maps only the
// catalog: model ids lose their `deeprelay/` prefix so an agent says
// `deeprelay/deepseek-v4.1-flash` rather than `deeprelay/deeprelay/…`, and
// each model's context window, output cap, tool/vision support, reasoning
// levels, plan weight and list price come from DeepRelay rather than a guess.

const PROVIDER = "deeprelay"
const API = "https://api.deeprelay.ai/v1"
const PREFIX = "deeprelay/"

// magpie's session id, carried from chat.headers to the loader's fetch in a
// private header that is removed before the request leaves the plugin.
const SESSION = "x-magpie-deeprelay-session"

// magpie's synthetic session id (derived from the first user message) is
// shared by unrelated conversations, so it is not sent as a session tag.
const SYNTHETIC_SESSION = /^magpie-[0-9a-f]{24}$/

const CATALOG_TTL = 5 * 60 * 1000
const OUTPUT_FALLBACK = 32768
const TIMEOUT = 20_000

const httpFetch = (...args) => globalThis.fetch(...args)

// ---- small helpers ---------------------------------------------------------------

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined)

// usd is a dollar amount as it is usually written: cents above a cent, four
// decimals under one (a fraction of a cent is not "$0.00" to its owner).
const usd = (n) => (n === 0 || Math.abs(n) >= 0.01 ? `$${n.toFixed(2)}` : `$${Number(n.toFixed(4))}`)

const pct = (amount, limit) => (Number.isFinite(amount) && Number.isFinite(limit) && limit > 0 ? Math.round((100 * amount) / limit * 100) / 100 : undefined)

const seconds = (a, b) => {
	const x = Date.parse(a)
	const y = Date.parse(b)
	return Number.isFinite(x) && Number.isFinite(y) && y > x ? Math.round((y - x) / 1000) : undefined
}

// keyOf is the model key an agent names: DeepRelay's `deeprelay/` prefix is
// dropped so `deeprelay/deepseek-v4.1-flash` is the whole name the agent says.
function keyOf(id) {
	const s = String(id ?? "")
	return s.startsWith(PREFIX) ? s.slice(PREFIX.length) : s
}

// baseOf is the API root: DeepRelay's production host, or the `api` plugin
// option (a staging host, a proxy of your own).
function baseOf(options) {
	const api = options?.api
	return typeof api === "string" && /^https?:\/\//i.test(api) ? api.replace(/\/+$/, "") : API
}

function errorResponse(status, message) {
	return new Response(JSON.stringify({ error: { message, type: status === 401 ? "authentication_error" : "api_error" } }), {
		status,
		headers: { "content-type": "application/json" },
	})
}

// getJSON reads one DeepRelay endpoint without throwing: usage should say
// what went wrong, not lose the meters it could read.
async function getJSON(url, key, fetchImpl = httpFetch, signal) {
	const headers = { accept: "application/json" }
	if (key) headers.authorization = `Bearer ${key}`
	let res
	try {
		res = await fetchImpl(url, { headers, signal: signal ?? AbortSignal.timeout(TIMEOUT) })
	} catch (e) {
		return { ok: false, status: 0, error: e?.message ?? String(e) }
	}
	const text = await res.text().catch(() => "")
	let data
	try {
		data = text ? JSON.parse(text) : null
	} catch {
		data = null
	}
	return { ok: res.ok, status: res.status, data, text }
}

// ---- the catalog -----------------------------------------------------------------

// DeepRelay's pricing is per 1M tokens in cents, and the cache rate in
// micro-cents (1e-6 cent). magpie wants dollars per 1M tokens, so a cent
// rate divides by 100 and a micro-cent rate by 1e8.
const per1m = (microcents) => (Number.isFinite(microcents) ? microcents / 1e8 : undefined)

function costOf(pricing) {
	// the rate in effect when the catalog was read: `period` names the side
	// of the peak schedule, and that side carries exact micro-cents (the flat
	// fields are the same rates rounded to whole cents)
	const period = pricing?.period
	const tier = (period && pricing?.[period]) || pricing || {}
	const input = per1m(tier.input_per_1m_tokens_microcents) ?? (num(tier.input_per_1m_tokens_cents) ?? 0) / 100
	const output = per1m(tier.output_per_1m_tokens_microcents) ?? (num(tier.output_per_1m_tokens_cents) ?? 0) / 100
	const read = per1m(tier.cached_input_per_1m_tokens_microcents) ?? per1m(pricing?.cached_input_per_1m_tokens_microcents) ?? 0
	return { input, output, cache: { read, write: 0 } }
}

function nameOf(m, key) {
	const base = String(m?.name ?? "").trim() || key
	const tier = m?.tier === "economy" ? " · Economy" : ""
	const payg = m?.plan_covered === true ? "" : " · PAYG"
	return `${base}${tier}${payg}`
}

// runtimeModel is one catalog entry as the OpenCode Model magpie reads. The
// key the agent names is `key`; `id` and `api.id` stay DeepRelay's own id,
// which is what the request body's `model` must carry.
function runtimeModel(m, key, base = API) {
	const params = Array.isArray(m?.supported_parameters) ? m.supported_parameters : []
	const vision = params.includes("vision")
	const tools = params.includes("tools")
	// DeepRelay accepts the effort names and maps aliases itself, so the
	// catalog's list is offered as-is.
	const efforts = Array.isArray(m?.reasoning_efforts) ? m.reasoning_efforts.filter((e) => typeof e === "string" && e) : []
	const factor = num(m?.usage_factor_milli) ?? 1000
	const model = {
		id: m.id,
		providerID: PROVIDER,
		name: nameOf(m, key),
		api: { id: m.id, url: base, npm: "@ai-sdk/openai-compatible" },
		status: m?.status === "deprecated" ? "deprecated" : "active",
		cost: costOf(m?.pricing),
		limit: { context: num(m?.context_length) ?? 0, output: num(m?.max_completion_tokens) ?? OUTPUT_FALLBACK },
		capabilities: {
			temperature: params.includes("temperature"),
			// the effort control: a model that always reasons but lists no
			// efforts has no control to show, so it stays off
			reasoning: efforts.length > 0,
			attachment: vision,
			toolcall: tools,
			input: { text: true, image: vision, audio: false, video: false, pdf: false },
			output: { text: true, image: false, audio: false, video: false, pdf: false },
			interleaved: false,
		},
		release_date: "",
		variants: Object.fromEntries(efforts.map((e) => [e, {}])),
	}
	// DeepRelay's usage_factor_milli is per token; magpie's `rate` is a
	// per-request multiplier, so this is only the picker's display value.
	if (m?.plan_covered === true && factor !== 1000) model.rate = factor / 1000
	return model
}

// modelsOf turns a catalog into the provider's model map: chat models only
// (agents cannot use image, video or embedding models), placeholders left
// out, plan-covered models first so the picker and `magpie provider test`
// lead with the ones a subscription pays for, and a key collision falls back
// to a #2 suffix so no model is lost.
function modelsOf(list, base = API) {
	const out = {}
	const seen = new Set()
	const rank = (m) => num(m?.coding_agent_rank) ?? Number.POSITIVE_INFINITY
	const ordered = (Array.isArray(list) ? list : [])
		.filter((m) => m && m.modality === "chat" && m.status !== "coming_soon" && m.id)
		.sort((a, b) => {
			const plan = (b.plan_covered === true) - (a.plan_covered === true)
			if (plan) return plan
			// NaN (both unranked) falls through to the name; ±Infinity is a real
			// order, a ranked model before one the catalog did not rank
			const byRank = rank(a) - rank(b)
			if (byRank) return byRank
			return String(a.name ?? a.id).localeCompare(String(b.name ?? b.id))
		})
	for (const m of ordered) {
		const baseKey = keyOf(m.id) || m.id
		let key = baseKey
		for (let n = 2; seen.has(key); n++) key = `${baseKey}#${n}`
		const model = runtimeModel(m, key, base)
		seen.add(key)
		out[key] = model
	}
	return out
}

// catalogCache keeps the last answer per key for a few minutes: magpie asks
// for the list at start-up, on a sign-in change and on a refresh, and the
// catalog itself changes roughly hourly.
const catalogCache = new Map()
const CATALOG_CACHE_MAX = 32

function cacheCatalog(tag, entry) {
	catalogCache.set(tag, entry)
	if (catalogCache.size <= CATALOG_CACHE_MAX) return
	// a long-lived host can see many keys; drop the oldest settled entry
	for (const [k, v] of catalogCache) {
		if (k !== tag && !v.pending) {
			catalogCache.delete(k)
			return
		}
	}
}

async function catalog(key, base = API, fetchImpl = httpFetch) {
	const tag = `${base}\0${key ?? ""}`
	const hit = catalogCache.get(tag)
	if (hit && Date.now() - hit.at < CATALOG_TTL) return hit.data
	if (hit?.pending) return hit.pending
	const pending = (async () => {
		const r = await getJSON(`${base}/models?modality=chat`, key, fetchImpl)
		if (!r.ok) {
			const err = new Error(r.error ?? `DeepRelay answered ${r.status}`)
			err.status = r.status
			throw err
		}
		const data = Array.isArray(r.data?.data) ? r.data.data : []
		cacheCatalog(tag, { at: Date.now(), data })
		return data
	})()
	cacheCatalog(tag, { at: 0, pending })
	try {
		return await pending
	} catch (e) {
		catalogCache.delete(tag)
		throw e
	}
}

// ---- usage -----------------------------------------------------------------------

function tokenWindow(name, amount, limit, { resetsAt, span } = {}) {
	if (!Number.isFinite(amount) || !Number.isFinite(limit) || limit <= 0) return null
	const w = {
		name,
		used: pct(amount, limit),
		// magpie's card prints amount / limit itself, so they go in millions
		// and the unit says so: "18.2 / 2,500 M tokens"
		amount: millions(amount),
		limit: millions(limit),
		unit: "M tokens",
		display: `${millionText(amount)} / ${millionText(limit)}`,
	}
	if (resetsAt) w.resetsAt = resetsAt
	if (span) w.span = span
	return w
}

const millions = (n) => Math.round((n / 1e6) * 100) / 100
const millionText = (n) => `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n / 1e6)}M`

// windowsOf is the plan's meters as magpie shows them: the monthly and
// rolling-week weighted-token caps. A cap the deployment does not configure
// (0) is left out rather than shown as 0. The web-search allowance and the
// usage backstop (quota.max_usage_micro_cents) are not shown: the backstop
// is an anti-abuse ceiling on the list-price value of plan traffic, not an
// allowance. `deeprelay quota --short` shows both.
function windowsOf(sub) {
	const out = []
	const q = sub?.quota ?? {}
	const u = sub?.usage
	if (!u) return out
	const span = seconds(sub?.current_period_start, sub?.current_period_end)
	const resetsAt = sub?.current_period_end
	const push = (w) => {
		if (w) out.push(w)
	}
	push(tokenWindow("月输入", num(u.weighted_input_tokens), num(q.input_tokens_monthly), { span }))
	// the monthly windows share one reset; it is attached to the second window.
	push(tokenWindow("月输出", num(u.weighted_output_tokens), num(q.output_tokens_monthly), { resetsAt, span }))
	// the weekly caps roll: they have no reset moment, only a window length
	push(tokenWindow("周输入", num(u.weekly_weighted_input_tokens), num(q.weekly_input_tokens), { span: 7 * 86400 }))
	push(tokenWindow("周输出", num(u.weekly_weighted_output_tokens), num(q.weekly_output_tokens), { span: 7 * 86400 }))
	const payg = num(u.recent_payg_calls_24h)
	if (Number.isFinite(payg) && payg > 0) {
		out.push({ name: "钱包调用（24 小时）", display: `${payg} 次调用按量计费`, aside: true })
	}
	return out
}

// usageOf reads the subscription and the wallet. A key without `billing:read`
// still serves models and chat; it just cannot show the meters, and the error
// says which scope to add rather than looking like a lapsed sign-in.
async function usageOf(auth, base = API, fetchImpl = httpFetch) {
	if (auth?.type !== "api" || !auth.key) return { windows: [], error: "登录 DeepRelay 后可以读取用量" }
	const key = auth.key
	const [sub, bal] = await Promise.all([getJSON(`${base}/billing/subscription`, key, fetchImpl), getJSON(`${base}/billing/balance`, key, fetchImpl)])
	const out = { windows: [] }
	// read each endpoint independently: a refused subscription does not hide
	// a balance that could still be read.
	if (sub.status !== 401) {
		if (sub.ok && sub.data) {
			const s = sub.data
			if (s.subscribed) {
				out.plan = s.plan?.name ?? "DeepRelay"
				if (s.current_period_end) out.until = s.current_period_end
				out.renew = s.cancel_at_period_end ? "off" : "auto"
				out.windows = windowsOf(s)
			} else {
				// the quota on an unsubscribed org describes the Base plan it would
				// get, not a meter it has: showing it as 0% used would be a lie
				out.plan = "按量计费"
			}
		} else if (sub.status === 403) {
			out.error = "这个 key 没有 billing:read 权限，读不到用量；给 key 加上 billing:read（或改用 full_access）"
		} else if (sub.error) {
			out.error = `DeepRelay 用量：${sub.error}`
		} else if (sub.status) {
			out.error = `DeepRelay 用量：HTTP ${sub.status}`
		}
	}
	if (bal.status !== 401) {
		if (bal.ok && bal.data) {
			const dollars = num(bal.data.balance_dollars) ?? (num(bal.data.balance_cents) ?? 0) / 100
			out.balance = usd(dollars)
		} else if (bal.status === 403) {
			out.error ??= "这个 key 没有 billing:read 权限，读不到余额"
		} else if (bal.error) {
			out.error ??= `DeepRelay 余额：${bal.error}`
		}
	}
	if (sub.status === 401 || bal.status === 401) {
		out.error ??= "DeepRelay 拒绝了这个 key，请重新登录"
		out.signIn = "expired"
	}
	return out
}

// ---- the plugin ------------------------------------------------------------------

// DEFAULT_MODELS is what the provider offers before an account answered: the
// four models DeepRelay's own setup puts in a coding agent, with the limits
// its docs quote. provider.models replaces the list once a key is in.
const defaultModels = () => ({
	"deepseek-v4.1-flash": {
		id: "deeprelay/deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		limit: { context: 1048576, output: 32768 },
		reasoning: true,
		tool_call: true,
	},
	"glm-5.3-flash": {
		id: "deeprelay/glm-5.3-flash",
		name: "GLM 5.3 Flash",
		limit: { context: 1048576, output: 32768 },
		reasoning: true,
		tool_call: true,
	},
	"glm-5.3": {
		id: "deeprelay/glm-5.3",
		name: "GLM 5.3",
		limit: { context: 1048576, output: 32768 },
		reasoning: true,
		tool_call: true,
	},
	"kimi-k3": {
		id: "deeprelay/kimi-k3",
		name: "Kimi K3",
		limit: { context: 1048576, output: 32768 },
		reasoning: true,
		tool_call: true,
	},
})

export const DeepRelayPlugin = async (_input, options = {}) => {
	const base = baseOf(options)

	return {
		config: async (cfg) => {
			cfg.provider ??= {}
			const was = cfg.provider[PROVIDER] ?? {}
			cfg.provider[PROVIDER] = {
				name: "DeepRelay",
				npm: "@ai-sdk/openai-compatible",
				api: base,
				...was,
				models: { ...defaultModels(), ...(was.models ?? {}) },
			}
		},

		auth: {
			provider: PROVIDER,

			methods: [{ type: "api", label: "DeepRelay API key", placeholder: "deeprelay_live_…" }],

			// loader hands the AI SDK the account's key and the address, and
			// moves magpie's session id onto DeepRelay's own request tag so a
			// task's calls can be found together in the request log.
			async loader(getAuth) {
				const auth = await getAuth()
				if (auth?.type !== "api" || !auth.key) return {}
				return {
					baseURL: base,
					apiKey: auth.key,
					async fetch(input, init = {}) {
						const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
						const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
						const session = headers.get(SESSION)
						headers.delete(SESSION)
						headers.set("authorization", `Bearer ${auth.key}`)
						if (session) headers.set("x-client-request-id", session.slice(0, 128))
						// the body is unchanged, but the SDK's length and host are
						// for its own request; let fetch write them
						headers.delete("content-length")
						headers.delete("host")
						const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
						try {
							return await httpFetch(url, { ...init, headers, signal })
						} catch (e) {
							return errorResponse(502, `无法连接 DeepRelay：${e?.message ?? e}`)
						}
					},
				}
			},

			usage: async (getAuth) => {
				try {
					return await usageOf(await getAuth(), base)
				} catch (e) {
					return { windows: [], error: e?.message ?? String(e) }
				}
			},
		},

		provider: {
			id: PROVIDER,
			async models(provider, { auth } = {}) {
				const have = provider?.models ?? {}
				try {
					const list = await catalog(auth?.key, base)
					const models = modelsOf(list, base)
					// an empty catalog is not a list: keep what magpie had
					return Object.keys(models).length ? models : have
				} catch (e) {
					if (e?.status === 401) throw Object.assign(new Error("DeepRelay 拒绝了这个 key，请重新登录"), { signIn: "expired" })
					// a catalog DeepRelay could not give is a failure, not the
					// few configured: magpie keeps the list it had
					return have
				}
			},
		},

		"chat.headers": async (input, output) => {
			const id = input?.model?.providerID ?? input?.provider?.info?.id
			if (id !== PROVIDER) return
			const session = String(input?.sessionID ?? "").trim()
			if (!session || SYNTHETIC_SESSION.test(session)) return
			output.headers[SESSION] = session.slice(0, 128)
		},
	}
}

// for tests
export const _internal = {
	keyOf,
	baseOf,
	costOf,
	nameOf,
	runtimeModel,
	modelsOf,
	catalog,
	windowsOf,
	usageOf,
	getJSON,
	usd,
	pct,
	errorResponse,
	clearCatalog: () => catalogCache.clear(),
	constants: { PROVIDER, API, PREFIX, SESSION, CATALOG_TTL, CATALOG_CACHE_MAX, OUTPUT_FALLBACK, defaultModels },
}

// The shape the plugin host looks for: default {id, server}. The host takes
// this over the named exports, so also exporting DeepRelayPlugin by name (as
// the tests import it) changes nothing the host does.
export default { id: PROVIDER, server: DeepRelayPlugin }
