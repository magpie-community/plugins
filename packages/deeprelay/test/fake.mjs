// A fake DeepRelay: the catalog, the subscription and the wallet, plus a
// streaming chat route so the loader's passthrough can be checked byte for
// byte. Every request is recorded, headers and body included.

const json = (body, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export const MODELS = [
	{
		id: "deeprelay/deepseek-v4.1-flash",
		object: "model",
		modality: "chat",
		tier: "serverless",
		status: "active",
		name: "DeepSeek V4.1 Flash 1017",
		context_length: 1048576,
		max_completion_tokens: 393216,
		supported_parameters: ["model", "messages", "temperature", "stream", "tools", "tool_choice", "reasoning_effort", "vision"],
		reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
		plan_covered: true,
		coding_agent_rank: 1,
		pricing: {
			currency: "usd",
			input_per_1m_tokens_cents: 7,
			output_per_1m_tokens_cents: 27,
			cached_input_per_1m_tokens_microcents: 140000,
			period: "off_peak",
			peak: { input_per_1m_tokens_microcents: 13500000, output_per_1m_tokens_microcents: 54000000, cached_input_per_1m_tokens_microcents: 270000 },
			off_peak: { input_per_1m_tokens_microcents: 6750000, output_per_1m_tokens_microcents: 27000000, cached_input_per_1m_tokens_microcents: 140000 },
		},
	},
	{
		id: "deeprelay/glm-5.3",
		object: "model",
		modality: "chat",
		tier: "serverless",
		status: "active",
		name: "GLM 5.3",
		context_length: 1048576,
		max_completion_tokens: 131072,
		supported_parameters: ["model", "messages", "stream", "tools", "tool_choice", "reasoning_effort"],
		reasoning_efforts: ["none", "low", "medium", "high"],
		plan_covered: true,
		usage_factor_milli: 12000,
		coding_agent_rank: 3,
	},
	{
		id: "deeprelay/deepseek-v4-pro",
		object: "model",
		modality: "chat",
		tier: "serverless",
		status: "active",
		name: "DeepSeek V4 Pro",
		context_length: 1048576,
		max_completion_tokens: 393216,
		supported_parameters: ["model", "messages", "stream", "tools"],
		plan_covered: false,
		usage_factor_milli: 2000,
		coding_agent_rank: 2,
	},
	{
		id: "deeprelay/qwen3.8-flash:economy",
		object: "model",
		modality: "chat",
		tier: "economy",
		status: "active",
		name: "Qwen 3.8 Flash",
		context_length: 1000000,
		// no max_completion_tokens: the plugin's fallback applies
		supported_parameters: ["model", "messages", "stream", "tools"],
		plan_covered: false,
	},
	{
		id: "deeprelay/soon",
		object: "model",
		modality: "chat",
		status: "coming_soon",
		name: "Coming soon",
	},
	{
		id: "deeprelay/seedream-4.0",
		object: "model",
		modality: "image",
		status: "active",
		name: "Seedream 4.0",
	},
]

export const SUBSCRIPTION = {
	subscribed: true,
	status: "active",
	cancel_at_period_end: false,
	current_period_start: "2026-11-17T10:54:49Z",
	current_period_end: "2026-12-17T10:54:49Z",
	plan: { key: "plus", name: "Plus", price: { amount_cents: 499, currency: "usd", interval: "month", interval_count: 1 } },
	quota: {
		input_tokens_monthly: 2500000000,
		output_tokens_monthly: 250000000,
		weekly_input_tokens: 625000000,
		weekly_output_tokens: 62500000,
		max_usage_micro_cents: 50000000000,
		payg_discount_bp: 0,
		searches_monthly: 500,
	},
	usage: {
		period_start: "2026-11-17T10:54:49Z",
		period_end: "2026-12-17T10:54:49Z",
		weighted_input_tokens: 18196365,
		weighted_output_tokens: 336991,
		weekly_weighted_input_tokens: 18196365,
		weekly_weighted_output_tokens: 336991,
		cost_micro_cents: 15479495,
		recent_payg_calls_24h: 0,
		searches: 4,
	},
	plans: [],
	renew_from_balance: false,
}

export const BALANCE = { balance_cents: 1240, balance_dollars: 12.4, auto_pay_enabled: false, auto_pay_threshold_cents: 0, auto_pay_amount_cents: 0, burn_cents_per_hour: 0 }

export function startFake() {
	const state = {
		models: MODELS,
		subscription: SUBSCRIPTION,
		balance: BALANCE,
		catalogStatus: 200,
		subscriptionStatus: 200,
		balanceStatus: 200,
		requests: [],
	}

	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url)
			const body = req.method === "POST" ? await req.text() : undefined
			state.requests.push({ method: req.method, path: url.pathname, search: url.search, headers: Object.fromEntries(req.headers), body })

			if (url.pathname === "/v1/models") {
				if (state.catalogStatus !== 200) return json({ error: { message: "catalog unavailable", type: "api_error" } }, state.catalogStatus)
				return json({ object: "list", data: state.models })
			}
			if (url.pathname === "/v1/billing/subscription") {
				if (state.subscriptionStatus !== 200)
					return json({ type: "https://api.deeprelay.ai/errors/insufficient_scope", title: "Forbidden", status: 403, code: "insufficient_scope" }, state.subscriptionStatus)
				return json(state.subscription)
			}
			if (url.pathname === "/v1/billing/balance") {
				if (state.balanceStatus !== 200) return json({ error: { message: "no balance" } }, state.balanceStatus)
				return json(state.balance)
			}
			if (url.pathname === "/v1/chat/completions") {
				const chunks = [
					'data: {"choices":[{"delta":{"reasoning_content":"think"},"index":0}]}\n\n',
					'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n',
					'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
					"data: [DONE]\n\n",
				]
				const stream = new ReadableStream({
					start(controller) {
						for (const c of chunks) controller.enqueue(new TextEncoder().encode(c))
						controller.close()
					},
				})
				return new Response(stream, { headers: { "content-type": "text/event-stream" } })
			}
			return json({ error: { message: "not found" } }, 404)
		},
	})

	return { server, state, base: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}
