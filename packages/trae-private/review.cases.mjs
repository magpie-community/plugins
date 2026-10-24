// 构造 fixture；没有生产流量或真实凭据。
import { beforeEach, afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import Plugin, { _internal as I } from "./index.mjs"
let root, a, b
const original = { fetch: globalThis.fetch, execFile: I.execFile, spawnLogin: I.spawnLogin, launchDebugBrowser: I.launchDebugBrowser }
function files(home, uid = "fake-a", base = "https://a.example.test/prefix", wire = "raw-a") {
  mkdirSync(join(home, "cli"), { recursive: true })
  writeFileSync(join(home, "cli/auth.json"), JSON.stringify({ trae: { access_token: `fake-${uid}`, refresh_token: "fake-refresh", user_id: uid, expires_at: new Date(Date.now() + 86400000).toISOString(), endpoints: { api_base_url: base } } }))
  writeFileSync(join(home, "cli/models_cache.json"), JSON.stringify({ models: [{ config_name: "m", context_window: 200000, business_metadata: { variants: { standard_key: wire } } }] }))
}
async function auth(home = a) { return I.signInAt({ baseURL: home === a ? "https://a.example.test/prefix" : "https://b.example.test/team" }, home) }
const body = (extra = {}) => JSON.stringify({ model: "m", messages: [{ role: "user", content: "测试" }], ...extra })
const events = (...ev) => ev.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")
function mockReply(extra = []) {
  globalThis.fetch = async () => new Response(events(["output", { response: "ok", finish_reason: "stop" }], ...extra), { headers: { "content-type": "text/event-stream" } })
}
beforeEach(() => {
  root = mkdtempSync(join(process.env.TMPDIR, "review-")); a = join(root, "a"); b = join(root, "b")
  process.env.TRAE_HOME = a; process.env.XDG_CONFIG_HOME = join(root, "config")
  process.env.TRAE_PRIVATE_NO_AUTO_REFRESH = "1"
  files(a); files(b, "fake-b", "https://b.example.test/team", "raw-b")
})
afterEach(() => {
  globalThis.fetch = original.fetch
  I.execFile = original.execFile; I.spawnLogin = original.spawnLogin; I.launchDebugBrowser = original.launchDebugBrowser
  for (const k of ["TRAE_PRIVATE_CONTEXT", "TRAE_PRIVATE_OUTPUT", "TRAE_PRIVATE_BODY_BUDGET", "TRAE_PRIVATE_APP_ID", "TRAE_PRIVATE_USER_AGENT", "TRAE_PRIVATE_PROTOCOL_VERSION"]) delete process.env[k]
  process.env.TRAE_PRIVATE_NO_AUTO_REFRESH = "1"
  rmSync(root, { recursive: true, force: true })
})
test("binding: default home is frozen; token rotation preserves metadata without refresh secret", async () => {
  const signed = await I.signInAt({ baseURL: "https://a.example.test/prefix" }, "")
  expect(signed.traeHome).toBe(I.traeHome(a))
  expect(signed.refresh).toBeNull()
  process.env.TRAE_HOME = b
  const plugin = await Plugin()
  const updated = await plugin.auth.refresh(signed)
  expect(updated?.access ?? signed.access).toBe("fake-fake-a")
})
test("binding: chat/refresh/usage reject identity or deployment replacement", async () => {
  const signed = await auth(); const p = await Plugin(); const loader = await p.auth.loader(async () => signed)
  for (const [uid, base] of [["fake-b", "https://a.example.test/prefix"], ["fake-a", "https://evil.example.test"]]) {
    files(a, uid, base)
    const res = await loader.fetch("https://unused.invalid", { body: body() })
    expect(res.status).toBe(401)
    expect((await res.json()).error.message).toMatch(/账号|部署/)
    await expect(p.auth.refresh(signed)).rejects.toThrow(/账号|部署/)
    expect((await p.auth.usage(async () => signed)).error).toMatch(/账号|部署/)
  }
})
test("binding: unbound legacy record requires reconnect", async () => {
  await expect((await Plugin()).auth.refresh({ access: "unrelated" })).rejects.toThrow(/重新|连接/)
})
test("catalog: selected home maps raw model, preserves prefix and rejects redirect", async () => {
  process.env.TRAE_HOME = a
  const signed = await auth(b); let sent
  globalThis.fetch = async (url, init) => { sent = { url, ...init }; return new Response(events(["done", { response: "ok" }]), { headers: { "content-type": "text/event-stream" } }) }
  const l = await (await Plugin()).auth.loader(async () => signed)
  expect((await l.fetch("https://unused.invalid", { body: body() })).status).toBe(200)
  expect(sent.url).toBe("https://b.example.test/team/api/ide/v2/llm_raw_chat")
  expect(sent.redirect).toBe("error")
  expect(JSON.parse(sent.body).model_name).toBe("raw-b")
  expect((await l.fetch("https://unused.invalid", { body: body({ model: "unknown" }) })).status).toBe(400)
})
test("catalog: corrupt B never returns A; empty/deleted model stays deleted", () => {
  expect(I.catalog(a)[0].wire).toBe("raw-a")
  writeFileSync(join(b, "cli/models_cache.json"), "{")
  expect(() => I.catalog(b)).toThrow()
  writeFileSync(join(a, "cli/models_cache.json"), '{"models":[]}')
  expect(I.catalog(a)).toEqual([])
  writeFileSync(join(a, "cli/models_cache.json"), "{")
  expect(() => I.catalog(a)).toThrow()
})
test("cookie: ambiguous account keys, malicious suffix, host-only/path/secure/expiry", () => {
  const ca = { traeHome: a, uid: "first+last@example.test", baseURL: "https://a.example.test" }
  const cb = { ...ca, uid: "first-last@example.test" }
  expect(I.webCookiePath(ca)).not.toBe(I.webCookiePath(cb))
  const cookie = (domain, extra = {}) => ({ name: "X-Cloudide-Tob-Session", value: "fake-cookie", domain, path: "/", secure: true, ...extra })
  for (const bad of [cookie("a.example.test.evil.test"), cookie("example.test", { hostOnly: true }), cookie("a.example.test", { path: "/other" }), cookie("a.example.test", { expires: 1 })]) {
    expect(I.cookieForHost([bad], "https://a.example.test/quota")).toBe("")
  }
  expect(I.cookieForHost([cookie(".example.test")], "https://a.example.test/quota")).toBe("fake-cookie")
  expect(I.cookieForHost([cookie("a.example.test")], "https://a.example.test/quota")).toBe("fake-cookie")
  expect(I.cookieForHost([cookie("a.example.test")], "http://a.example.test/quota")).toBe("")
})
test("context: existing model cannot override authoritative limits/capabilities; switch takes effect", async () => {
  process.env.TRAE_PRIVATE_CONTEXT = "1000000"
  const off = await Plugin({ magpie: { option: () => false } }); const on = await Plugin({ magpie: { option: () => true } })
  const provider = { models: { m: { name: "custom", limit: { context: 0 }, capabilities: { toolcall: false } } } }
  const model = (await off.provider.models(provider)).m
  expect(model.name).toBe("custom"); expect(model.limit.context).toBe(200000); expect(model.capabilities.toolcall).toBe(true)
  expect((await on.provider.models(provider)).m.limit.context).toBe(1000000)
  const config = { provider: { "trae-private": provider } }; await off.config(config)
  expect(config.provider["trae-private"].models.m.limit.context).toBe(200000)
})
test("protocol: nested usage after finish and empty tool at finish+EOF for collect and stream", async () => {
  const signed = await auth(); const l = await (await Plugin()).auth.loader(async () => signed)
  for (const stream of [false, true]) {
    globalThis.fetch = async () => new Response(events(["output", { tool_calls: [{ function_call: { name: "f" } }], finish_reason: "tool_calls" }], ["token_usage", { usage: { prompt_tokens: 3, completion_tokens: 4 } }]), { headers: { "content-type": "text/event-stream" } })
    const r = await l.fetch("https://unused.invalid", { body: body({ stream }) })
    expect(r.status).toBe(200)
    if (!stream) { const j = await r.json(); expect(j.usage.total_tokens).toBe(7); expect(j.choices[0].message.tool_calls[0].function.arguments).toBe("{}") }
    else { const text = await r.text(); expect(text).toContain('"total_tokens":7'); expect(text).toContain('"arguments":"{}"') }
  }
})
test("quota: threshold precedes rounding", () => {
  for (const [used, over] of [[200.009, false], [200.011, true]]) {
    const q = I.quotaOf({ user_model_quota: { paygo_currency_quota: 200 } }, { user_usage_list: [{}, { model_usage_detail_list: [{ total_cost_currency: used }] }] })
    expect(Boolean(q.windows[0].over)).toBe(over)
    expect(q.windows[0].used).toBeGreaterThan(100)
  }
})
test("budget: production entry refuses irreducible UTF-8/tools/current image bodies", async () => {
  process.env.TRAE_PRIVATE_BODY_BUDGET = "300"
  const signed = await auth(); const l = await (await Plugin()).auth.loader(async () => signed)
  for (const extra of [{ messages: [{ role: "user", content: "中".repeat(300) }] }, { tools: [{ function: { name: "f", parameters: { description: "x".repeat(1000) } } }] }, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(1000)}` } }] }] }]) {
    expect((await l.fetch("https://unused.invalid", { body: body(extra) })).status).toBe(413)
  }
})


// Application IDs must be explicitly supplied; no deployment default is shipped.
test("required app ID: missing and empty fail before network; configured value is forwarded", async () => {
  const signed = await auth()
  const loader = await (await Plugin()).auth.loader(async () => signed)
  let calls = 0, appId
  globalThis.fetch = async (_url, options) => {
    calls++
    appId = options.headers["x-app-id"]
    return new Response(events(["output", { response: "ok", finish_reason: "stop" }], ["done", {}]), { headers: { "content-type": "text/event-stream" } })
  }
  for (const value of [undefined, ""]) {
    if (value === undefined) delete process.env.TRAE_PRIVATE_APP_ID
    else process.env.TRAE_PRIVATE_APP_ID = value
    expect(() => I.protocolConfig()).toThrow("TRAE_PRIVATE_APP_ID is required")
    const response = await loader.fetch("https://unused.invalid", { body: body() })
    expect(response.ok).toBe(false)
    expect(await response.text()).toContain("TRAE_PRIVATE_APP_ID is required")
    expect(calls).toBe(0)
  }
  process.env.TRAE_PRIVATE_APP_ID = "explicit-fixture-app"
  expect((await loader.fetch("https://unused.invalid", { body: body() })).status).toBe(200)
  expect(calls).toBe(1)
  expect(appId).toBe("explicit-fixture-app")
})
