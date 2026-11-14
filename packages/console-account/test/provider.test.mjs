import test, { afterEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import * as entry from "../index.mjs"
import { buildModels, finishDevice, makePlugin, refreshAuth, startDevice, usageWindows } from "../provider.mjs"

const nativeFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = nativeFetch })
const catalog = (mode) => JSON.parse(readFileSync(new URL(`../catalog/${mode}.json`, import.meta.url), "utf8")).data
const auth = (access = "test-access", orgID = "org-z") => ({
  type: "oauth", access, refresh: "test-refresh", expires: Date.now() + 3600000,
  metadata: { email: "example@example.invalid", orgID, orgName: "Example" },
})
const token = { access_token: "test-new-access", refresh_token: "test-new-refresh", expires_in: 3600, org_id: "org-z" }
const device = () => ({ device_code: "test-device", interval: 5, deadline: Date.now() + 600000 })

test("entry exports exactly two provider plugins", async () => {
  assert.equal(Object.keys(entry).length, 2)
  for (const factory of Object.values(entry)) assert.equal((await factory()).auth.methods[0].type, "oauth")
})

test("Go catalog preserves all four native protocols and real limits", () => {
  const models = buildModels(catalog("go"), "go")
  assert.equal(Object.keys(models).length, 30)
  assert.equal(models["deepseek-v4.1-flash"].api.npm, "@ai-sdk/openai-compatible")
  assert.equal(models["gpt-6-luna"].api.npm, "@ai-sdk/openai")
  assert.equal(models["minimax-m3"].api.npm, "@ai-sdk/anthropic")
  assert.equal(models["gemini-4-argon"].api.npm, "@ai-sdk/google")
  assert.equal(models["deepseek-v4.1-flash"].limit.context, 1000000)
  assert.equal(models["deepseek-v4.1-flash"].capabilities.input.image, true)
})

test("Console filters restricted free models", () => {
  const models = buildModels(catalog("console"), "console")
  assert.ok(models["gpt-6-luna"])
  assert.equal(models["big-pickle"], undefined)
  assert.equal(models["mimo-v2.6-flash-free"], undefined)
})

test("empty authenticated workspace model config preserves the Go catalog", () => {
  const remote = JSON.parse(readFileSync(new URL("./fixtures/empty-console-config.json", import.meta.url), "utf8"))
  const models = buildModels(catalog("go"), "go", remote)
  assert.equal(Object.keys(models).length, 30)
  assert.equal(models["gpt-6-luna"].api.npm, "@ai-sdk/openai")
  assert.equal(models["minimax-m3"].api.npm, "@ai-sdk/anthropic")
})

test("sparse model config keeps unmentioned models and respects explicit disables", () => {
  const configured = { providers: { "opencode-go": { models: { "minimax-m3": { disabled: true } } } } }
  const models = buildModels(catalog("go"), "go", configured)
  assert.equal(Object.keys(models).length, 29)
  assert.ok(models["deepseek-v4.1-flash"])
  assert.equal(models["minimax-m3"], undefined)
})

test("device login uses the official JSON protocol and resolves relative URLs", async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://opencode.ai/console/auth/device/code")
    assert.deepEqual(JSON.parse(init.body), { client_id: "opencode-cli", supports_org_scope: true })
    assert.match(new Headers(init.headers).get("user-agent"), /^magpie-/)
    assert.equal(init.redirect, "error")
    return Response.json({ ...device(), user_code: "TEST-CODE", expires_in: 600, verification_uri_complete: "/console/device?user_code=TEST-CODE" })
  }
  assert.equal((await startDevice()).url, "https://opencode.ai/console/device?user_code=TEST-CODE")
})

test("device flow backs off and retains the workspace selected in the browser", async () => {
  const waits = [], replies = [{ error: "authorization_pending" }, { error: "slow_down" }, token]
  globalThis.fetch = async (url, init) => {
    if (url.endsWith("/token")) {
      assert.equal(JSON.parse(init.body).device_code, "test-device")
      const reply = replies.shift()
      return Response.json(reply, { status: reply.error ? 400 : 200 })
    }
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-new-access")
    if (url.endsWith("/user")) return Response.json({ id: "user-test", email: "example@example.invalid" })
    if (url.endsWith("/orgs")) return Response.json([{ id: "org-a", name: "Alpha" }, { id: "org-z", name: "Example" }])
    throw new Error("unexpected URL")
  }
  const result = await finishDevice(device(), { sleep: async (ms) => { waits.push(ms) } })
  assert.deepEqual(waits, [5000, 5000, 10000])
  assert.equal(result.type, "success")
  assert.equal(result.metadata.orgID, "org-z")
  assert.equal(result.refresh, "test-new-refresh")
})

test("denied, expired and cancelled device attempts stop", async () => {
  globalThis.fetch = async () => Response.json({ error: "access_denied" }, { status: 400 })
  await assert.rejects(finishDevice(device(), { sleep: async () => {} }), /已拒绝/)
  await assert.rejects(finishDevice({ ...device(), deadline: Date.now() - 1 }), /过期/)
  await assert.rejects(finishDevice(device(), { signal: AbortSignal.abort() }), { name: "AbortError" })
})

test("external authorization URLs are rejected", async () => {
  globalThis.fetch = async () => Response.json({ ...device(), user_code: "TEST", expires_in: 600, verification_uri_complete: "https://example.invalid/console/device" })
  await assert.rejects(startDevice(), /意外的授权地址/)
})

test("refresh rotates tokens and preserves account metadata; invalid grant expires login", async () => {
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(init.body).grant_type, "refresh_token")
    return Response.json(token)
  }
  const result = await refreshAuth(auth())
  assert.equal(result.refresh, "test-new-refresh")
  assert.equal(result.metadata.email, "example@example.invalid")
  globalThis.fetch = async () => Response.json({ error: "invalid_grant" }, { status: 400 })
  await assert.rejects(refreshAuth(auth()), (e) => e.signIn === "expired")
})

test("usage displays measured windows without treating unknown usage as zero", () => {
  const windows = usageWindows({ usage: { rolling: { percent: 42, resetsAt: "2026-11-14T12:00:00Z" }, monthly: { percent: 102 } } }, [{
    ruleID: "model-budget", limitDollars: 20, spentDollars: 15, coverage: "models", models: [{ providerID: "opencode-go", modelID: "gpt-6-luna" }],
  }], "opencode-go", "console")
  assert.deepEqual(windows.map((w) => w.used), [42, 102, 75])
  assert.deepEqual(windows[2].models, ["gpt-6-luna"])
  assert.equal(windows.find((w) => w.name === "7 days"), undefined)
})

test("request signing uses the selected account each time and preserves streaming", async () => {
  let selected = auth()
  const plugin = makePlugin("go"), seen = []
  const loader = await plugin.auth.loader(async () => selected)
  const reply = new Response("data: test\n\n", { headers: { "content-type": "text/event-stream" } })
  globalThis.fetch = async (input, init) => {
    seen.push(new Request(input, init))
    return reply
  }
  const request = { method: "POST", body: '{"model":"minimax-m3"}', headers: { "x-opencode-session": "conversation-a", "x-api-key": "old-key" } }
  assert.equal(await loader.fetch("https://opencode.ai/inference/go/anthropic/v1/messages", request), reply)
  selected = auth("other-access", "other-org")
  await loader.fetch("https://opencode.ai/inference/go/openai/v1/responses", request)
  assert.equal(seen[0].headers.get("authorization"), "Bearer test-access")
  assert.equal(seen[1].headers.get("authorization"), "Bearer other-access")
  assert.equal(seen[1].headers.get("x-opencode-org-id"), "other-org")
  assert.equal(seen[0].headers.get("x-api-key"), null)
  assert.equal(seen[0].headers.get("x-opencode-session"), "conversation-a")
})

test("standalone model tests get independent session IDs", async () => {
  const loader = await makePlugin("go").auth.loader(async () => auth())
  const sessions = []
  globalThis.fetch = async (input, init) => {
    sessions.push(new Request(input, init).headers.get("x-opencode-session"))
    return new Response("test")
  }
  await loader.fetch("https://opencode.ai/inference/go/openai/v1/chat/completions")
  await loader.fetch("https://opencode.ai/inference/go/openai/v1/chat/completions")
  assert.match(sessions[0], /^magpie-[a-f0-9-]{36}$/)
  assert.notEqual(sessions[0], sessions[1])
})

test("Magpie-provided session IDs are preserved", async () => {
  const loader = await makePlugin("go").auth.loader(async () => auth())
  globalThis.fetch = async (input, init) => {
    assert.equal(new Request(input, init).headers.get("x-opencode-session"), "original-conversation")
    return new Response("test")
  }
  await loader.fetch("https://opencode.ai/inference/go/openai/v1/chat/completions", { headers: { "x-magpie-session": "original-conversation" } })
})

test("expired standalone credentials never exchange or save a rotating token", async () => {
  let exchanges = 0, saves = 0
  const plugin = makePlugin("go", { client: { auth: { async set() { saves++ } } } })
  globalThis.fetch = async () => { exchanges++; return Response.json(token) }
  const loader = await plugin.auth.loader(async () => ({ ...auth(), expires: Date.now() - 1 }))
  await assert.rejects(loader.fetch("https://opencode.ai/inference/go/openai/v1/responses"), (e) => e.signIn === "expired")
  assert.equal(exchanges, 0)
  assert.equal(saves, 0)
  assert.equal(plugin.auth.rotating, true)
})

test("Go refuses token forwarding to other hosts or plan endpoints", async () => {
  const loader = await makePlugin("go").auth.loader(async () => auth())
  globalThis.fetch = async () => { throw new Error("must not send") }
  await assert.rejects(loader.fetch("https://example.invalid/inference/go/openai/v1/responses"), /官方接口以外/)
  await assert.rejects(loader.fetch("https://opencode.ai/inference/openai/v1/responses"), /官方接口以外/)
})

test("model discovery authenticates workspace config without treating it as a complete catalog", async () => {
  globalThis.fetch = async (url, init) => {
    if (url.endsWith("/models")) return Response.json({ data: catalog("go") })
    assert.equal(new Headers(init.headers).get("x-org-id"), "org-z")
    return Response.json({ providers: { "opencode-go": { models: {} } } })
  }
  const models = await makePlugin("go").provider.models({ models: {} }, { auth: auth() })
  assert.equal(Object.keys(models).length, 30)
  assert.ok(models["deepseek-v4.1-flash"])
})

test("quota reads use distinct workspace headers and retain partial results", async () => {
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init.headers)
    if (url.endsWith("/usage")) {
      assert.equal(headers.get("x-opencode-org-id"), "org-z")
      return Response.json({ usage: { weekly: { percent: 18 } } })
    }
    assert.equal(headers.get("x-org-id"), "org-z")
    return new Response("temporary", { status: 502 })
  }
  const result = await makePlugin("go").auth.usage(async () => auth())
  assert.equal(result.windows[0].used, 18)
  assert.equal(result.signIn, "kept")
  assert.equal(result.error, undefined)
  assert.match(result.windows[1].display, /502/)
  globalThis.fetch = async () => new Response(null, { status: 401 })
  assert.equal((await makePlugin("go").auth.usage(async () => auth())).signIn, "expired")
})

test("an empty upstream catalog fails discovery instead of publishing an empty model list", async () => {
  globalThis.fetch = async (url) => url.endsWith("/models")
    ? Response.json({ data: [] })
    : Response.json({ providers: { "opencode-go": { models: {} } } })
  await assert.rejects(makePlugin("go").provider.models({ models: { existing: {} } }, { auth: auth() }), /空模型目录.*保留已有列表/)
})

test("session header hook is scoped to its own provider", async () => {
  const hook = makePlugin("go")["chat.headers"], output = { headers: {} }
  await hook({ model: { providerID: "another" }, sessionID: "a" }, output)
  assert.deepEqual(output.headers, {})
  await hook({ model: { providerID: "opencode-go-account" }, sessionID: "b" }, output)
  assert.equal(output.headers["x-opencode-session"], "b")
})


test("discovery rejects unusable catalogs and malformed workspace config while honoring disables", async () => {
  let rows = [{ id: "broken-model" }], config = {}
  globalThis.fetch = async (url) => Response.json(url.endsWith("/models") ? { data: rows } : config)
  const discover = () => makePlugin("go").provider.models({ models: { existing: {} } }, { auth: auth() })
  await assert.rejects(discover(), /目录格式无效/)
  rows = [null, { id: 42 }, ...catalog("go")]
  config = null
  await assert.rejects(discover(), /配置格式无效/)
  config = { providers: { "opencode-go": { models: { bad: null } } } }
  await assert.rejects(discover(), /配置格式无效/)
  config = { providers: { "opencode-go": { disabled: true } } }
  assert.equal(Object.keys(await discover()).length, 0)
})

test("catalog ignores unsafe or malformed entries without losing valid rows", () => {
  const valid = catalog("go")[0]
  const unsafe = { ...valid, id: "unsafe", api: { "chat-completions": { base_url: "https://example.invalid/inference/go/v1" } } }
  assert.deepEqual(Object.keys(buildModels([null, unsafe, valid], "go")), [valid.id])
})

test("malformed quota successes report errors while retaining good windows", async () => {
  globalThis.fetch = async (url) => Response.json(url.endsWith("/usage") ? { usage: {} } : { unexpected: true })
  let result = await makePlugin("go").auth.usage(async () => auth())
  assert.equal(result.signIn, "kept")
  assert.match(result.error, /额度信息格式无效/)
  assert.match(result.error, /预算信息格式无效/)
  globalThis.fetch = async (url) => Response.json(url.endsWith("/usage") ? { usage: { weekly: { percent: 18 }, rolling: {} } } : [])
  result = await makePlugin("go").auth.usage(async () => auth())
  assert.equal(result.windows[0].used, 18)
  assert.equal(result.error, undefined)
  assert.match(result.windows[1].display, /额度信息格式无效/)
})

test("filtered and per-model budget spend is displayed aside without broad routing", () => {
  const base = { ruleID: "test", limitDollars: 10, spentDollars: 5, coverage: "models" }
  for (const models of [[{ providerID: "another", modelID: "same" }], [{ providerID: "opencode-go", modelID: "same", spentDollars: 2 }]]) {
    const [w] = usageWindows(undefined, [{ ...base, models }])
    assert.equal(w.aside, true)
    assert.equal(w.models, undefined)
  }
})

test("device polling honors long server intervals and rejects credential URLs", async () => {
  let wait
  globalThis.fetch = async () => Response.json({ error: "access_denied" }, { status: 400 })
  await assert.rejects(finishDevice({ ...device(), interval: 90 }, { sleep: async (ms) => { wait = ms } }), /已拒绝/)
  assert.equal(wait, 90000)
  globalThis.fetch = async () => Response.json({ ...device(), user_code: "test", expires_in: 100, verification_uri_complete: "https://user:pass@opencode.ai/console/device" })
  await assert.rejects(startDevice(), /授权地址/)
})

test("invalid authorization JSON and account shapes produce safe errors", async () => {
  globalThis.fetch = async () => new Response("secret-invalid-json")
  await assert.rejects(startDevice(), (e) => /JSON 格式无效/.test(e.message) && !e.message.includes("secret"))
  globalThis.fetch = async (url) => url.endsWith("/token") ? Response.json(token) : Response.json(url.endsWith("/user") ? { id: 123, email: "x" } : [])
  await assert.rejects(finishDevice(device(), { sleep: async () => {} }), /账户信息不完整/)
})


test("vendor-filtered budgets do not affect all-model routing", () => {
  const [w] = usageWindows(undefined, [{ ruleID: "vendor", coverage: "all", vendors: [{ id: "v" }], limitDollars: 10, spentDollars: 4 }])
  assert.equal(w.aside, true)
})

test("a pending device poll is cancelled at its deadline", async () => {
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
  })
  await assert.rejects(finishDevice({ ...device(), deadline: Date.now() + 50 }, { sleep: async () => {} }), /过期/)
})


test("refresh keeps the workspace and rejects missing refresh credentials", async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({ ...token, org_id: "other" }) }
  await assert.rejects(refreshAuth({ ...auth(), refresh: "" }), (e) => e.signIn === "expired")
  assert.equal(calls, 0)
  await assert.rejects(refreshAuth(auth()), (e) => e.signIn === "expired")
  globalThis.fetch = async () => Response.json(token)
  assert.equal((await makePlugin("go", { magpie: {} }).auth.refresh(auth())).metadata.orgID, "org-z")
})

test("device accounts distinguish workspaces and require a scoped selection", async () => {
  let scoped = false
  globalThis.fetch = async (url) => {
    if (url.endsWith("/token")) return Response.json(scoped ? token : { ...token, org_id: null })
    if (url.endsWith("/user")) return Response.json({ id: "u", email: "e@example.invalid" })
    return Response.json([{ id: "org-z", name: "Z" }, { id: "other", name: "Other" }])
  }
  await assert.rejects(finishDevice(device(), { sleep: async () => {} }), /请选择/)
  scoped = true
  const result = await finishDevice(device(), { sleep: async () => {} })
  assert.equal(result.accountId, "e@example.invalid · Z")
  assert.match(result.uid, /^[a-f0-9]{64}$/)
  assert.equal(result.metadata.orgID, "org-z")
  globalThis.fetch = async (url) => {
    if (url.endsWith("/token")) return Response.json({ ...token, org_id: "other" })
    if (url.endsWith("/user")) return Response.json({ id: "u", email: "e@example.invalid" })
    return Response.json([{ id: "org-z", name: "Z" }, { id: "other", name: "Other" }])
  }
  const other = await finishDevice(device(), { sleep: async () => {} })
  assert.equal(other.accountId, "e@example.invalid · Other")
  assert.notEqual(other.uid, result.uid)
})

test("Go budgets are aside and Console per-model budgets use individual spend", () => {
  const b = { coverage: "models", per: "model", scope: "each", limitDollars: 10, spentDollars: 8, models: [
    { providerID: "opencode", modelID: "a", spentDollars: 2 },
    { providerID: "opencode", modelID: "b", spentDollars: 8 },
  ] }
  assert.equal(usageWindows(undefined, [b], "opencode-go", "go")[0].aside, true)
  const rows = usageWindows(undefined, [b], "opencode", "console")
  assert.deepEqual(rows.map((r) => [r.amount, r.models]), [[2, ["a"]], [8, ["b"]]])
  assert.ok(rows.every((r) => r.name.startsWith("Member budget")))
  const mixed = { ...b, models: [b.models[0], { ...b.models[1], providerID: "other" }] }
  assert.equal(usageWindows(undefined, [mixed], "opencode", "console")[0].aside, true)
})

test("usage forwards host cancellation to both requests", async () => {
  const controller = new AbortController(), seen = []
  globalThis.fetch = async (_url, init) => { seen.push(init.signal); return Response.json(_url.endsWith("/usage") ? { usage: { weekly: { percent: 1 } } } : []) }
  await makePlugin("go").auth.usage(async () => auth(), {}, { signal: controller.signal })
  controller.abort()
  assert.equal(seen.length, 2)
  assert.ok(seen.every((s) => s.aborted))
})


test("native quota labels and explicitly limited windows retain displayed percentage", () => {
  const rows = usageWindows({ usage: { rolling: { percent: 98.9, status: "rate-limited" }, weekly: { percent: 12 }, monthly: { percent: 3 } } })
  assert.deepEqual(rows.map((w) => w.name), ["5 hours", "7 days", "Monthly"])
  assert.equal(rows[0].used, 100)
  assert.equal(rows[0].display, "Rate limited · 98.9% reported")
  assert.equal(rows[1].display, undefined)
})

test("unavailable budgets are distinct from an empty list and aborts propagate", async () => {
  globalThis.fetch = async (url) => url.endsWith("/usage") ? Response.json({ usage: { weekly: { percent: 7 } } }) : new Response(null, { status: 403 })
  const plugin = makePlugin("go")
  const result = await plugin.auth.usage(async () => auth())
  assert.equal(result.windows[0].used, 7)
  assert.equal(result.error, undefined)
  assert.match(result.windows[1].display, /无法读取 Console 预算/)
  assert.equal(result.windows[1].aside, true)
  assert.equal(result.windows[1].used, undefined)
  assert.equal(result.windows[1].amount, undefined)
  assert.equal(result.windows[1].limit, undefined)
  globalThis.fetch = async (url) => Response.json(url.endsWith("/usage") ? { usage: { weekly: { percent: 7 } } } : [])
  assert.equal((await plugin.auth.usage(async () => auth())).error, undefined)
  await assert.rejects(plugin.auth.usage(async () => auth(), {}, { signal: AbortSignal.abort() }), { name: "AbortError" })
})


test("partial authenticated usage remains visible after a 401 and a 404", async () => {
  const plugin = makePlugin("go")
  globalThis.fetch = async (url) => url.endsWith("/usage") ? Response.json({ usage: { weekly: { percent: 9 } } }) : new Response(null, { status: 401 })
  let result = await plugin.auth.usage(async () => auth())
  assert.equal(result.signIn, "kept")
  assert.equal(result.error, undefined)
  assert.equal(result.windows[0].used, 9)
  assert.equal(result.windows[1].aside, true)
  globalThis.fetch = async (url) => url.endsWith("/usage") ? Response.json({ usage: { weekly: { percent: 9 } } }) : new Response(null, { status: 404 })
  result = await plugin.auth.usage(async () => auth())
  assert.equal(result.error, undefined)
  assert.match(result.windows[1].display, /无法读取 Console 预算/)
})
