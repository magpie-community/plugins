// An API key made at the build's /profile/keys page (plugins#407) is sent as
// WorkBuddy's own CLI sends CODEBUDDY_API_KEY (@tencent-ai/codebuddy-code
// 2.177.0): X-API-Key and Authorization: Bearer, both the key, X-User-Id
// "anonymous_" and the key's last eight characters, no X-Domain, to the
// build's own host. The browser and desktop sign-ins are unchanged. Every
// fetch here is a fake; nothing reaches the network.
import { afterEach, expect, test } from "bun:test"
import { WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const KEY = "ck_test0000000000abcdefgh"
const OK = () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })

// record answers each fetch with reply and keeps the URL and headers sent
function record(reply = OK) {
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), headers: new Headers(init?.headers) })
    return reply(String(url))
  }
  return sent
}

const chat = (opts, url) =>
  opts.fetch(url, {
    method: "POST",
    // what an SDK given apiKey "" sends: an empty key header and Bearer
    headers: { authorization: "Bearer ", "x-api-key": "" },
    body: JSON.stringify({ model: "glm-5.3", stream: true, messages: [{ role: "user", content: "hi" }] }),
  })

for (const [plugin, site, url] of [
  [WorkBuddyAuthPlugin, "workbuddy", "https://copilot.tencent.com/v2/chat/completions"],
  [WorkBuddyAIAuthPlugin, "workbuddy-ai", "https://www.workbuddy.ai/v2/chat/completions"],
]) {
  test(`${site}: offers an API key sign-in beside the browser and desktop ones`, async () => {
    const hooks = await plugin({ client: {} })
    const ms = hooks.auth.methods
    expect(ms.map((m) => m.type)).toEqual(["oauth", "oauth", "api"])
    const name = _internal.SITES[site].name
    expect(ms[2].label).toBe(`${name} API key`)
    expect(ms[2].placeholder).toContain(site === "workbuddy" ? "www.workbuddy.cn/profile/keys" : "www.workbuddy.ai/profile/keys")
    expect(ms[0].label).toBe(`${name} account (browser)`)
    expect(ms[1].label).toBe(`${name} desktop's sign-in`)
  })

  test(`${site}: a key's chat carries X-API-Key and Bearer to ${new URL(url).host}`, async () => {
    const sent = record()
    const hooks = await plugin({ client: {} })
    // the provider's own api is where a model's chat goes
    const cfg = { provider: {} }
    await hooks.config(cfg)
    expect(cfg.provider[site].api + "/chat/completions").toBe(url)
    const opts = await hooks.auth.loader(async () => ({ type: "api", key: KEY }))
    expect(typeof opts.fetch).toBe("function")
    const res = await chat(opts, url)
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(1)
    const h = sent[0].headers
    expect(sent[0].url).toBe(url)
    expect(h.get("x-api-key")).toBe(KEY)
    expect(h.get("authorization")).toBe("Bearer " + KEY)
    expect(h.get("x-user-id")).toBe("anonymous_abcdefgh")
    expect(h.has("x-domain")).toBe(false)
    expect(h.has("x-enterprise-id")).toBe(false)
    expect(h.get("user-agent")).toMatch(/^WorkBuddy\//)
    expect(h.get("x-product")).toBe("SaaS")
  })

  test(`${site}: a browser sign-in's chat is as before, no X-API-Key`, async () => {
    const sent = record()
    const hooks = await plugin({ client: {} })
    const opts = await hooks.auth.loader(async () => ({ type: "oauth", access: "tok", refresh: "r", uid: "u1", expires: Date.now() + 3600_000 }))
    await chat(opts, url)
    const h = sent[0].headers
    expect(sent[0].url).toBe(url)
    expect(h.get("authorization")).toBe("Bearer tok")
    expect(h.has("x-api-key")).toBe(false)
    expect(h.get("x-user-id")).toBe("u1")
    expect(h.get("x-domain")).toBe(new URL(url).host)
  })

  test(`${site}: a refused key is a 401 that says to check the key, never a refresh`, async () => {
    const sent = record(() => new Response('{"code":401}', { status: 401, headers: { "www-authenticate": 'Bearer realm="copilot", error="invalid_token"' } }))
    const hooks = await plugin({ client: {} })
    const opts = await hooks.auth.loader(async () => ({ type: "api", key: KEY }))
    const res = await chat(opts, url)
    expect(res.status).toBe(401)
    expect(sent).toHaveLength(1) // no refresh asked, no second send
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
    const { error } = await res.json()
    expect(error.message).toContain("refused this API key (401)")
    expect(error.message).toContain(site === "workbuddy" ? "https://www.workbuddy.cn/profile/keys" : "https://www.workbuddy.ai/profile/keys")
  })

  test(`${site}: a key's credits are unknown, asked of nothing`, async () => {
    const sent = record(() => new Response("{}", { status: 500 }))
    const hooks = await plugin({ client: {} })
    const u = await hooks.auth.usage(async () => ({ type: "api", key: KEY }))
    expect(sent).toHaveLength(0)
    expect(u.signIn).toBe("kept")
    expect(u.error).toContain("credits unknown")
    expect(u.windows).toBeUndefined()
  })
}

// /v3/config is asked with a key only as the CLI asks it: for ck_ and pt_
// keys (shouldLoadRemoteConfig); any other key keeps the built-in list
test("models: a ck_ key asks /v3/config with the key's headers, another key asks nothing", async () => {
  const sent = record(() =>
    Response.json({ code: 0, data: { agents: [{ name: "cli", models: ["glm-9"] }], models: [{ id: "glm-9", name: "GLM-9", maxInputTokens: 1000, maxOutputTokens: 100 }] } }),
  )
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const provider = { id: "workbuddy", models: { builtin: { id: "builtin" } } }
  const got = await hooks.provider.models(provider, { auth: { type: "api", key: KEY } })
  expect(sent).toHaveLength(1)
  expect(sent[0].url).toBe("https://copilot.tencent.com/v3/config")
  expect(sent[0].headers.get("x-api-key")).toBe(KEY)
  expect(sent[0].headers.get("authorization")).toBe("Bearer " + KEY)
  expect(Object.keys(got)).toEqual(["glm-9"])

  const other = await hooks.provider.models(provider, { auth: { type: "api", key: "sk-something-else" } })
  expect(sent).toHaveLength(1)
  expect(other).toBe(provider.models)
})

test("an empty key is not signed in", async () => {
  record()
  const hooks = await WorkBuddyAIAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => ({ type: "api", key: "  " }))
  await expect(chat(opts, "https://www.workbuddy.ai/v2/chat/completions")).rejects.toThrow("isn't signed in")
})
