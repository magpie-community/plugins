// A chat goes out as MiniMax Code sends one: the account in Authorization,
// the SDK's key a placeholder, MiniMax Code's User-Agent and X-Mavis-*
// headers, the conversation's id from magpie's session.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { MiniMaxCodeAuthPlugin, MiniMaxCodeGlobalAuthPlugin } from "./index.mjs"
import { fakeMiniMax, json } from "./fake.mjs"

let f
afterEach(() => f?.close())

const auth = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000 }
const body = '{"model":"MiniMax-M3.1-Flash-Preview","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'

test("a chat carries MiniMax Code's headers", async () => {
  f = fakeMiniMax()
  f.route("POST /mavis/api/v1/llm/v1/messages", () => json({ type: "message", content: [] }))
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => auth)
  expect(opts.baseURL).toBe(f.origin + "/mavis/api/v1/llm/v1")
  expect(opts.apiKey).toBe("sk-xxx")
  // magpie's chat.headers hook gives the conversation's id
  const out = { headers: {} }
  await hooks["chat.headers"]({ sessionID: "ses_1", model: { providerID: "minimax-code", id: "MiniMax-M3" }, provider: { info: { id: "minimax-code" } } }, out)
  expect(out.headers).toEqual({ "X-Mavis-Session-Id": "ses_1" })
  // as the host sends it: the SDK's key, the hook's headers, the body
  const res = await opts.fetch(opts.baseURL + "/messages", {
    method: "POST",
    headers: new Headers({ "x-api-key": "sk-xxx", "content-type": "application/json", "anthropic-beta": "interleaved-thinking-2025-05-14", ...out.headers }),
    body,
  })
  expect(res.status).toBe(200)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  const r = f.seen.at(-1)
  expect(r.path).toBe("/mavis/api/v1/llm/v1/messages")
  expect(r.text).toBe(body)
  expect(r.headers.get("authorization")).toBe("Bearer tok")
  expect(r.headers.get("x-api-key")).toBe("sk-xxx")
  expect(r.headers.get("user-agent")).toBe("MiniMaxAgent")
  expect(r.headers.get("x-mavis-agent-id")).toBe("main")
  expect(r.headers.get("x-mavis-session-id")).toBe("ses_1")
  expect(r.headers.get("x-mavis-timezone-offset")).toBe(String(new Date().getTimezoneOffset() * -60))
  expect(r.headers.get("anthropic-version")).toBe("2023-06-01")
  expect(r.headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14")
})

test("chat.headers leaves other providers' requests alone", async () => {
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const out = { headers: {} }
  await hooks["chat.headers"]({ sessionID: "ses_1", model: { providerID: "minimax-code-global" }, provider: { info: { id: "minimax-code-global" } } }, out)
  expect(out.headers).toEqual({})
})

test("a request with no session of its own gets one that stays the same", async () => {
  f = fakeMiniMax()
  f.route("POST /mavis/api/v1/llm/v1/messages", () => json({}))
  const hooks = await MiniMaxCodeGlobalAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => auth)
  await opts.fetch(opts.baseURL + "/messages", { method: "POST", body })
  await opts.fetch(opts.baseURL + "/messages", { method: "POST", body })
  const [a, b] = f.seen.map((r) => r.headers.get("x-mavis-session-id"))
  expect(a).toMatch(/^[0-9a-f-]{36}$/)
  expect(b).toBe(a)
})

test("credits run out is a 429, so another account takes over", async () => {
  f = fakeMiniMax()
  f.route("POST /mavis/api/v1/llm/v1/messages", () => json({ type: "error", error: { type: "permission_error", message: "积分余额不足" } }, 402))
  const opts = await (await MiniMaxCodeAuthPlugin({ client: {} })).auth.loader(async () => auth)
  const res = await opts.fetch(opts.baseURL + "/messages", { method: "POST", body })
  expect(res.status).toBe(429)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await res.json()).error).toEqual({ type: "rate_limit_error", message: "usage limit reached: 积分余额不足" })
})

test("other refusals go on as they came, the account kept", async () => {
  f = fakeMiniMax()
  f.route("POST /mavis/api/v1/llm/v1/messages", () => json({ type: "error", error: { type: "invalid_request_error", message: "bad model" } }, 400))
  const opts = await (await MiniMaxCodeAuthPlugin({ client: {} })).auth.loader(async () => auth)
  const res = await opts.fetch(opts.baseURL + "/messages", { method: "POST", body })
  expect(res.status).toBe(400)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await res.json()).error.message).toBe("bad model")
})

// Exercise the actual auth-loader fetch, including Go's HTML-escaped JSON.
test("all five efforts reach the subscription fetch without markers or thinking", async () => {
  const { onRequest } = await import("./effort-bridge.mjs")
  f = fakeMiniMax()
  f.route("POST /mavis/api/v1/llm/v1/messages", () => json({ type: "message", content: [] }))
  const opts = await (await MiniMaxCodeAuthPlugin({ client: {} })).auth.loader(async () => auth)
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    const marked = onRequest({ model: "minimax-code/MiniMax-M3.1-Flash", reasoning: { effort } }, { protocol: "responses" })
    const converted = JSON.stringify({ model: "MiniMax-M3.1-Flash", system: marked.instructions,
      thinking: { type: "enabled", budget_tokens: 7168 }, messages: [{ role: "user", content: "hi" }] })
      .replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")
    const res = await opts.fetch(new Request(opts.baseURL + "/messages", { method: "POST", body: converted }))
    expect(res.status).toBe(200)
    const r = f.seen.at(-1)
    expect(r.json.output_config).toEqual({ effort })
    expect(r.json.thinking).toBeUndefined()
    expect(r.json.system).toBeUndefined()
    expect(r.text).not.toContain("magpie-minimax-effort:")
    expect(JSON.stringify([...r.headers])).not.toContain("magpie-minimax-effort:")
  }
})
