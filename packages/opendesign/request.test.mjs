import "./nonet.mjs"
import { afterEach, beforeEach, expect, test } from "bun:test"
import plugin, { _internal } from "./index.mjs"
import { fakeOpenDesign, json, MODELS } from "./fake.mjs"

let fake
beforeEach(() => (fake = fakeOpenDesign()))
afterEach(() => fake.close())

const getAuth = async () => ({ type: "api", key: "sk-amr-r vela_ctrl_c" })
const loaded = async () => (await plugin.server({})).auth.loader(getAuth)

test("config names the provider on the link plane with Chat Completions", async () => {
  const cfg = {}
  await (await plugin.server({})).config(cfg)
  expect(cfg.provider.opendesign.npm).toBe("@ai-sdk/openai-compatible")
  expect(Object.keys(cfg.provider.opendesign.models)).toEqual(_internal.SEED)
})

test("a request goes to chat/completions with the runtime key, never the control key", async () => {
  fake.route("POST /v1/chat/completions", () => json({ id: "c", choices: [{ message: { role: "assistant", content: "hi" } }] }))
  const l = await loaded()
  expect(l.baseURL).toBe(fake.origin + "/v1")
  expect(l.apiKey).toBe("sk-amr-r")
  const res = await l.fetch(l.baseURL + "/chat/completions", { method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }) })
  expect(res.status).toBe(200)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect(fake.seen[0].headers.get("authorization")).toBe("Bearer sk-amr-r")
  expect(fake.seen[0].json.model).toBe("deepseek-v4-flash")
})

test("the key never goes to another host", async () => {
  const l = await loaded()
  const res = await l.fetch("http://127.0.0.1:1/v1/chat/completions", { method: "POST", body: "{}" })
  expect(res.status).toBe(400)
  expect(fake.seen.length).toBe(0)
})

// the codes vela-errors.ts classifies, in the bodies the link plane sends
const cases = [
  [402, { error: { code: "insufficient_balance", message: "Insufficient balance" } }, 429, "top up", null],
  [403, { error: { message: "no", accountAction: "recharge" } }, 429, "top up", null],
  [403, { error: { code: "tier_model_not_entitled", message: "nope" } }, 403, "isn't in the account's Open Design plan", null],
  [403, { error: { code: "tier_request_kind_not_entitled", message: "nope" } }, 403, "kind of request", null],
  [401, { error: { code: "auth_required", message: "Invalid API key" } }, 401, "sign in again", "expired"],
  [403, { code: "auth_required", accountAction: "relogin", message: "x" }, 401, "sign in again", "expired"],
  [500, { error: { code: "upstream_provider_unauthenticated", message: "x" } }, 502, "outage", null],
  [400, { error: { message: "bad tools" } }, 400, "bad tools", null],
]
for (const [status, body, want, says, signIn] of cases)
  test(`a ${status} ${JSON.stringify(body).slice(0, 60)} is a ${want}`, async () => {
    fake.route("POST /v1/chat/completions", () => json(body, status))
    const l = await loaded()
    const res = await l.fetch(l.baseURL + "/chat/completions", { method: "POST", body: "{}" })
    expect(res.status).toBe(want)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe(signIn)
    expect((await res.json()).error.message).toContain(says)
  })

test("models are the account's own list, with the window from context_limit", async () => {
  fake.route("GET /v1/models", () => json(MODELS))
  const ms = await (await plugin.server({})).provider.models({ models: {} }, { auth: await getAuth() })
  expect(Object.keys(ms)).toEqual(["deepseek-v4-flash", "claude-sonnet-4.6"])
  expect(ms["deepseek-v4-flash"]).toMatchObject({ name: "DeepSeek V4 Flash", limit: { context: 1048000, output: 32000 }, providerID: "opendesign" })
  expect(ms["deepseek-v4-flash"].api).toEqual({ id: "deepseek-v4-flash", url: fake.origin + "/v1", npm: "@ai-sdk/openai-compatible" })
  expect(ms["claude-sonnet-4.6"].limit).toEqual({ context: 200000, output: 0 })
  expect(ms["claude-sonnet-4.6"].capabilities.attachment).toBe(true)
  expect(fake.seen[0].headers.get("authorization")).toBe("Bearer sk-amr-r")
})

test("a refused key on /models marks the sign-in; another failure keeps the list there was", async () => {
  const have = { a: {} }
  fake.route("GET /v1/models", () => json({}, 500))
  expect(await (await plugin.server({})).provider.models({ models: have }, { auth: await getAuth() })).toBe(have)
  fake.route("GET /v1/models", () => json({ error: { message: "bad key" } }, 401))
  await expect((await plugin.server({})).provider.models({ models: have }, { auth: await getAuth() })).rejects.toMatchObject({ signIn: "expired" })
})
