import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { tmpdir, homedir } from "node:os"
import { relative, isAbsolute } from "node:path"
import * as entry from "./index.mjs"
import { createAuth, metadata, inferenceURL, ID, PORTAL, INFERENCE, WELCOME, LEAD, SCOPE, CLIENT_ID } from "./oauth.mjs"

// Protocol fixtures follow Hermes's auth_device_flow.py, auth_nous.py and
// auth_constants.py: synthetic tokens, NEVER captured user credentials.
const home = relative(tmpdir(), homedir())
assert.ok(home && home !== ".." && !home.startsWith(".." + "/") && !home.startsWith(".." + "\\") && !isAbsolute(home), "Run with an isolated HOME under the temporary directory")
const NOW = 1800000000000
const originalFetch = globalThis.fetch
const originalNow = Date.now
const noNetwork = async () => { throw new Error("unexpected request: tests must not reach the network") }
beforeEach(() => { globalThis.fetch = noNetwork })
afterEach(() => { globalThis.fetch = originalFetch; Date.now = originalNow })
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
const jwt = (c = {}) => ["eyJhbGciOiJSUzI1NiJ9", Buffer.from(JSON.stringify({ sub: "test-account", scope: SCOPE, exp: (NOW + 3600000) / 1000, ...c })).toString("base64url"), "test-signature"].join(".")
const payload = (extra = {}) => ({ access_token: jwt(), refresh_token: "rotated-test-refresh", expires_in: 3600, scope: SCOPE, token_type: "Bearer", inference_base_url: INFERENCE, ...extra })
const saved = (extra = {}, meta = {}) => ({
  type: "oauth", access: jwt(), expires: NOW + 3600000,
  refresh: JSON.stringify({ version: 1, token: "old-test-refresh", scope: SCOPE, tokenType: "Bearer", baseURL: INFERENCE, ...meta }), ...extra,
})
const device = (extra = {}) => ({ device_code: "secret-device-code", user_code: "ABCD-EFGH", verification_uri: PORTAL + "/activate", verification_uri_complete: PORTAL + "/activate?user_code=ABCD-EFGH", expires_in: 600, interval: 5, ...extra })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function store(initial) {
  let value = structuredClone(initial)
  const writes = []
  const client = { auth: { set: async ({ path, body }) => { assert.equal(path.id, ID); writes.push(structuredClone(body)); value = structuredClone(body); return {} } } }
  return { client, writes, get: async () => structuredClone(value), replace: (v) => { value = structuredClone(v) } }
}
function clock() {
  let time = NOW
  const sleeps = []
  return { now: () => time, advance: (ms) => { time += ms }, sleeps, sleep: async (ms) => { sleeps.push(ms); time += ms } }
}
function options(c, request) { return { now: c.now, clock: c.now, sleep: c.sleep, request } }
const expiring = () => saved({ expires: NOW + LEAD - 1, access: jwt({ exp: (NOW + LEAD - 1) / 1000 }) })

// Sign-in: browser/device separation, pacing, terminal and edge errors.
test("device authorization uses only inference:invoke and the public client; callback is single-flight", async () => {
  const c = clock(), calls = []
  const replies = [json(device()), json({ error: "authorization_pending" }, 400), json({ error: "slow_down" }, 400), json(payload())]
  const flow = createAuth({}, options(c, async (url, init) => { calls.push({ url, init }); return replies.shift() }))
  const a = await flow.authorize()
  assert.equal(a.url, device().verification_uri_complete)
  assert.equal(a.method, "auto")
  assert.match(a.instructions, /ABCD-EFGH/)
  assert.ok(!a.instructions.includes("secret-device-code"))
  const p = a.callback()
  assert.equal(p, a.callback())
  const result = await p
  assert.equal(result.type, "success")
  assert.equal(result.expires, NOW + 3600000)
  assert.equal(metadata(result).token, "rotated-test-refresh")
  assert.deepEqual(c.sleeps, [5000, 5000, 10000])
  assert.equal(calls[0].url, PORTAL + "/api/oauth/device/code")
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].init.body)), { client_id: CLIENT_ID, scope: SCOPE })
  for (const { url, init } of calls) {
    assert.equal(init.redirect, "error")
    assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded")
    assert.ok(!url.includes("secret-device-code"))
    assert.ok(!init.body.includes("billing:manage"))
  }
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[1].init.body)), {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: CLIENT_ID, device_code: "secret-device-code",
  })
})

test("omitted interval defaults to five seconds; verification_uri_complete is optional", async () => {
  const c = clock()
  let call = 0
  const flow = createAuth({}, options(c, async () => ++call === 1 ? json(device({ interval: undefined, verification_uri_complete: undefined })) : json(payload())))
  const a = await flow.authorize()
  assert.equal(a.url, device().verification_uri)
  assert.equal((await a.callback()).type, "success")
  assert.deepEqual(c.sleeps, [5000])
})

test("a late callback cannot restart the device code lifetime", async () => {
  const c = clock()
  let calls = 0
  const a = await createAuth({}, options(c, async () => { calls++; return json(device()) })).authorize()
  c.advance(600000)
  const r = await a.callback()
  assert.equal(r.type, "failed")
  assert.match(r.error, /expired_token/)
  assert.equal(calls, 1)
})

test("429 Retry-After and a non-JSON WAF response back off within the original deadline", async () => {
  const c = clock()
  const replies = [json(device()), json({ error: "invalid_grant" }, 429, { "retry-after": "20" }), new Response("challenge", { status: 403, headers: { "x-vercel-mitigated": "challenge" } }), json(payload())]
  const a = await createAuth({}, options(c, async () => replies.shift())).authorize()
  assert.equal((await a.callback()).type, "success")
  assert.deepEqual(c.sleeps, [5000, 20000, 40000])
})

test("a transport timeout backs off without polling past expiry", async () => {
  const c = clock()
  let calls = 0
  const a = await createAuth({}, options(c, async () => {
    if (++calls === 1) return json(device({ expires_in: 12 }))
    throw new Error("transport with secret-device-code")
  })).authorize()
  const r = await a.callback()
  assert.equal(r.type, "failed")
  assert.match(r.error, /expired_token/)
  assert.equal(calls, 2)
  assert.deepEqual(c.sleeps, [5000, 7000])
  assert.ok(!r.error.includes("secret-device-code"))
})

test("access_denied stops immediately and does not echo vendor descriptions", async () => {
  const c = clock(), replies = [json(device()), json({ error: "access_denied", error_description: "secret-device-code rotated-test-refresh" }, 400)]
  const a = await createAuth({}, options(c, async () => replies.shift())).authorize()
  const r = await a.callback()
  assert.equal(r.type, "failed")
  assert.match(r.error, /access_denied/)
  assert.ok(!r.error.includes("secret-device-code"))
  assert.equal(c.sleeps.length, 1)
})

test("verification URLs are pinned before the host can open a browser", async () => {
  for (const bad of ["https://attacker.invalid/activate", "http://portal.nousresearch.com/activate", "https://portal.nousresearch.com:8443/activate", "https://user@portal.nousresearch.com/activate", "javascript:alert(1)"]) {
    const c = clock()
    await assert.rejects(createAuth({}, options(c, async () => json(device({ verification_uri_complete: bad })))).authorize(), /invalid_verification_uri/)
  }
})

test("malformed device replies are not silently assigned arbitrary defaults", async () => {
  for (const bad of [{ expires_in: 0 }, { expires_in: "600" }, { interval: -1 }, { device_code: "" }, { user_code: "" }]) {
    const c = clock()
    await assert.rejects(createAuth({}, options(c, async () => json(device(bad)))).authorize(), /invalid_device_code_response/)
  }
})

test("initial login rejects non-inference, expired and non-JWT access tokens", async () => {
  for (const access of ["opaque-token", jwt({ scope: "billing:manage" }), jwt({ exp: -1 })]) {
    const c = clock(), replies = [json(device()), json(payload({ access_token: access, scope: "billing:manage" }))]
    const a = await createAuth({}, options(c, async () => replies.shift())).authorize()
    assert.equal((await a.callback()).type, "failed")
  }
})

// Refresh: standard store fields, rotations, ownership and failure semantics.
test("host refresh uses x-nous-refresh-token, never a refresh_token form field", async () => {
  const s = store(expiring()), c = clock()
  const flow = createAuth(s.client, options(c, async (url, init) => {
    assert.equal(url, PORTAL + "/api/oauth/token")
    assert.equal(init.redirect, "error")
    assert.equal(init.headers["x-nous-refresh-token"], "old-test-refresh")
    assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), { grant_type: "refresh_token", client_id: CLIENT_ID })
    return json(payload({ access_token: jwt({ exp: (NOW + 600000) / 1000 }), inference_base_url: WELCOME }))
  }))
  const fields = await flow.refresh(await s.get())
  assert.deepEqual(Object.keys(fields).sort(), ["access", "expires", "refresh"])
  assert.equal(fields.expires, NOW + 600000)
  assert.equal(metadata(fields).baseURL, WELCOME)
  assert.equal(s.writes.length, 0, "the host must own its guarded save")
})

test("requests and the host refresh share one rotation, including different loaders", async () => {
  const s = store(expiring()), c = clock(), entered = deferred(), reply = deferred()
  let calls = 0
  const flow = createAuth(s.client, options(c, async () => { calls++; entered.resolve(); await reply.promise; return json(payload()) }))
  const a = await s.get()
  const work = Promise.all([flow.fresh(s.get), flow.fresh(s.get), flow.refresh(a), flow.refresh(a)])
  await entered.promise
  reply.resolve()
  const got = await work
  assert.equal(calls, 1)
  assert.equal(s.writes.length, 1)
  assert.ok(got.every((r) => metadata(r).token === "rotated-test-refresh"))
})

test("failed persistence retains the successor and retries saving, not the spent refresh token", async () => {
  const s = store(expiring()), c = clock()
  const save = s.client.auth.set
  let fails = true, calls = 0
  s.client.auth.set = async (args) => { if (fails) throw new Error("disk full"); return save(args) }
  const flow = createAuth(s.client, options(c, async () => { calls++; return json(payload()) }))
  await assert.rejects(flow.fresh(s.get), (e) => e.code === "could_not_save_rotated_token" && e.signIn === "kept")
  fails = false
  const a = await flow.fresh(s.get)
  assert.equal(calls, 1)
  assert.equal(metadata(a).token, "rotated-test-refresh")
  assert.equal(metadata(await s.get()).token, "rotated-test-refresh")
})

test("an SDK error result is also a failed save", async () => {
  const s = store(expiring()), c = clock()
  s.client.auth.set = async () => ({ error: { message: "write failed" } })
  const flow = createAuth(s.client, options(c, async () => json(payload())))
  await assert.rejects(flow.fresh(s.get), /could_not_save_rotated_token/)
})

test("a rotated refresh token is persisted before rejecting an unusable JWT", async () => {
  const s = store(expiring()), c = clock()
  const spent = []
  const flow = createAuth(s.client, options(c, async (_url, init) => {
    spent.push(init.headers["x-nous-refresh-token"])
    return json(spent.length === 1 ? payload({ access_token: "not-a-jwt" }) : payload({ refresh_token: "third-refresh" }))
  }))
  await assert.rejects(flow.fresh(s.get), /unusable_inference_jwt/)
  assert.equal(metadata(await s.get()).token, "rotated-test-refresh")
  await assert.rejects(flow.fresh(s.get), /unusable_inference_jwt/)
  assert.equal(spent.length, 1, "malformed success must not cause a tight refresh loop")
  c.advance(31000)
  await flow.fresh(s.get)
  assert.deepEqual(spent, ["old-test-refresh", "rotated-test-refresh"])
})

test("host refresh returns an unusable rotated successor for the host to persist", async () => {
  const s = store(expiring()), c = clock()
  const flow = createAuth(s.client, options(c, async () => json(payload({ access_token: "" }))))
  const fields = await flow.refresh(await s.get())
  assert.equal(fields.access, "")
  assert.equal(metadata(fields).token, "rotated-test-refresh")
  assert.equal(s.writes.length, 0)
})

test("a transient early-refresh failure keeps a still-valid JWT and observes a cooldown", async () => {
  for (const status of [408, 429, 500, 503]) {
    const s = store(expiring()), c = clock()
    let calls = 0
    const flow = createAuth(s.client, options(c, async () => { calls++; return json({ error: "invalid_grant" }, status) }))
    assert.equal((await flow.fresh(s.get)).access, (await s.get()).access)
    await flow.fresh(s.get)
    assert.equal(calls, 1)
    assert.equal(s.writes.length, 0)
  }
})

test("a temporary failure after actual expiry is kept, not signed out", async () => {
  const s = store(saved({ expires: NOW - 1, access: jwt({ exp: (NOW - 1) / 1000 }) })), c = clock()
  const flow = createAuth(s.client, options(c, async () => json({}, 503)))
  await assert.rejects(flow.fresh(s.get), (e) => e.signIn === "kept")
  assert.equal(s.writes.length, 0)
})

test("grant-dead errors require sign-in; WAF 403 and 429 do not", async () => {
  for (const code of ["invalid_grant", "invalid_token", "refresh_token_reused"]) {
    const s = store(expiring()), c = clock()
    let calls = 0
    const flow = createAuth(s.client, options(c, async () => { calls++; return json({ error: code, error_description: "old-test-refresh" }, 400) }))
    await assert.rejects(flow.fresh(s.get), (e) => e.signIn === "expired" && !e.message.includes("old-test-refresh"))
    await assert.rejects(flow.fresh(s.get), (e) => e.signIn === "expired")
    assert.equal(calls, 1)
    assert.equal(s.writes.length, 0)
  }
  const s = store(expiring()), c = clock()
  const flow = createAuth(s.client, options(c, async () => new Response("checkpoint", { status: 403, headers: { "x-vercel-mitigated": "deny" } })))
  assert.equal((await flow.fresh(s.get)).access, (await s.get()).access)
})

test("a newer login wins over an in-flight old refresh", async () => {
  const s = store(expiring()), c = clock(), entered = deferred(), reply = deferred()
  const flow = createAuth(s.client, options(c, async () => { entered.resolve(); await reply.promise; return json(payload()) }))
  const p = flow.fresh(s.get)
  await entered.promise
  const next = saved({ access: jwt({ sub: "other-account" }) }, { token: "new-login-refresh" })
  s.replace(next)
  reply.resolve()
  assert.equal((await p).access, next.access)
  assert.deepEqual(await s.get(), next)
  assert.equal(s.writes.length, 0)
})

test("refresh preserves metadata changed while the exchange is in flight", async () => {
  const s = store({ ...expiring(), label: "before" }), c = clock(), entered = deferred(), reply = deferred()
  const flow = createAuth(s.client, options(c, async () => { entered.resolve(); await reply.promise; return json(payload()) }))
  const p = flow.fresh(s.get)
  await entered.promise
  s.replace({ ...await s.get(), label: "after" })
  reply.resolve()
  await p
  assert.equal((await s.get()).label, "after")
})

test("accounts with the same display identity have independent refresh state", async () => {
  const a = store(expiring()), b = store({ ...expiring(), refresh: saved({}, { token: "other-refresh" }).refresh })
  const c = clock(), tokens = []
  const flow = createAuth({}, options(c, async (_url, init) => { const t = init.headers["x-nous-refresh-token"]; tokens.push(t); return json(payload({ refresh_token: t + "-next" })) }))
  const [x, y] = await Promise.all([flow.refresh(await a.get()), flow.refresh(await b.get())])
  assert.deepEqual(tokens.sort(), ["old-test-refresh", "other-refresh"])
  assert.notEqual(metadata(x).token, metadata(y).token)
})

test("a stale snapshot follows multiple rotations without redeeming an old token", async () => {
  const c = clock(), initial = expiring(), spent = []
  const flow = createAuth({}, options(c, async (_url, init) => {
    spent.push(init.headers["x-nous-refresh-token"])
    return json(payload({ access_token: jwt({ exp: (c.now() + 3600000) / 1000 }), refresh_token: `next-${spent.length}` }))
  }))
  await flow.refresh(initial)
  c.advance(3600000)
  await flow.refresh(initial)
  c.advance(3600000)
  await flow.refresh(initial)
  assert.deepEqual(spent, ["old-test-refresh", "next-1", "next-2"])
})

test("inference URL metadata cannot grant authority to an arbitrary recipient", () => {
  assert.equal(inferenceURL(WELCOME + "/"), WELCOME)
  for (const url of ["http://inference-api.nousresearch.com/v1", "https://evil.invalid/v1", INFERENCE + "?token=x", INFERENCE + "/other", "https://user@inference-api.nousresearch.com/v1", "https://inference-api.nousresearch.com:8443/v1"]) assert.equal(inferenceURL(url), INFERENCE)
})

test("saved-state corruption is not an empty account or a successful parse", async () => {
  const s = store(saved({ refresh: "not-json" })), c = clock()
  await assert.rejects(createAuth(s.client, options(c, noNetwork)).fresh(s.get), (e) => e.code === "unreadable_saved_sign_in" && e.signIn === "kept")
  assert.equal(s.writes.length, 0)
})

// End-to-end through the exported plugin hooks, with every fetch intercepted.
test("one entrypoint, distinct provider id, non-destructive config and standard loader contract", async () => {
  assert.deepEqual(Object.entries(entry).filter(([, v]) => typeof v === "function").map(([k]) => k), ["NousPortalAuthPlugin"])
  const s = store(saved()), hooks = await entry.NousPortalAuthPlugin({ client: s.client })
  const config = { provider: { nous: { name: "API key preset" }, [ID]: { name: "Custom label", models: { custom: { name: "Mine" } } } } }
  await hooks.config(config)
  assert.equal(config.provider.nous.name, "API key preset")
  assert.equal(config.provider[ID].name, "Custom label")
  assert.equal(config.provider[ID].models.custom.name, "Mine")
  assert.equal(hooks.auth.refreshLead, LEAD)
  assert.deepEqual(await hooks.auth.loader(async () => ({ type: "api", key: "unrelated" })), {})
  assert.equal((await hooks.auth.loader(s.get)).apiKey, "nous-portal-oauth")
})

test("Request bytes, tool calls, caller headers and SSE are preserved; unrelated credentials are stripped", async () => {
  Date.now = () => NOW
  const s = store(saved()), hooks = await entry.NousPortalAuthPlugin({ client: s.client }), loader = await hooks.auth.loader(s.get)
  const body = '{ "model": "nous/hermes-test", "messages": [], "tools": [{"type":"function","function":{"name":"run"}}], "stream": true }'
  const ac = new AbortController()
  const req = new Request(INFERENCE + "/chat/completions", { method: "POST", body, signal: ac.signal, headers: { authorization: "placeholder", "x-api-key": "do-not-forward", "x-nous-refresh-token": "also-private", cookie: "private", "x-magpie-work-dir": "/private", "x-test": "keep", "content-type": "application/json" } })
  const sse = 'data: {"choices":[{"delta":{"tool_calls":[]}}]}\n\ndata: [DONE]\n\n'
  const response = new Response(sse, { headers: { "content-type": "text/event-stream", "x-upstream": "kept" } })
  globalThis.fetch = async (url, init) => {
    assert.equal(url, INFERENCE + "/chat/completions")
    assert.equal(Buffer.from(init.body).toString(), body)
    assert.equal(init.headers.get("authorization"), "Bearer " + (await s.get()).access)
    for (const name of ["x-api-key", "x-nous-refresh-token", "cookie", "x-magpie-work-dir", "content-length"]) assert.equal(init.headers.has(name), false)
    assert.equal(init.headers.get("x-test"), "keep")
    assert.equal(init.redirect, "error")
    assert.equal(init.signal.aborted, false)
    return response
  }
  const result = await loader.fetch(req)
  // Response may wrap the stream (Bun does); identity is not its contract.
  assert.equal(result.status, response.status)
  assert.equal(result.headers.get("content-type"), "text/event-stream")
  assert.equal(result.headers.get("x-upstream"), "kept")
  assert.equal(result.headers.get("x-magpie-sign-in"), "kept")
  assert.equal(await result.text(), sse)
  assert.equal(req.headers.get("authorization"), "placeholder")
})

test("SSE bytes arrive before upstream closes and consumer cancellation reaches upstream", { timeout: 15000 }, async () => {
  Date.now = () => NOW
  const s = store(saved()), hooks = await entry.NousPortalAuthPlugin({ client: s.client }), loader = await hooks.auth.loader(s.get)
  let controller, cancelled, closed = false, reader, timer
  const source = new ReadableStream({
    start(c) { controller = c },
    cancel(reason) { cancelled = reason; closed = true },
  })
  globalThis.fetch = async () => new Response(source, { headers: { "content-type": "text/event-stream" } })
  // Hold the source open until its bytes have reached the consumer. The timer
  // only detects a deadlock; no timing threshold decides whether streaming works.
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("SSE did not reach the consumer while upstream was still open")), 5000)
  })
  const pending = loader.fetch(INFERENCE + "/chat/completions", { method: "POST", body: '{"stream":true}' })
  try {
    const result = await Promise.race([pending, deadline])
    assert.equal(result.headers.get("content-type"), "text/event-stream")
    reader = result.body.getReader()
    const bytes = Buffer.from('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n')
    const split = bytes.indexOf(Buffer.from("你")) + 1 // split a UTF-8 character, not just an SSE event
    for (const chunk of [bytes.subarray(0, split), bytes.subarray(split)]) {
      controller.enqueue(chunk)
      const received = []
      let length = 0
      // A runtime may rechunk a stream; compare bytes, not read boundaries.
      while (length < chunk.length) {
        const part = await Promise.race([reader.read(), deadline])
        assert.equal(part.done, false, "the source has not ended")
        received.push(Buffer.from(part.value))
        length += part.value.byteLength
      }
      assert.deepEqual(Buffer.concat(received), chunk)
      assert.equal(closed, false)
    }
    await Promise.race([reader.cancel("consumer stopped"), deadline])
    assert.equal(cancelled, "consumer stopped")
  } finally {
    clearTimeout(timer)
    // Also releases a buffering regression, so a failing test leaves no reader
    // or pending fetch running into the next test.
    if (!closed) { controller.close(); closed = true }
    if (reader) { await reader.cancel(); reader.releaseLock() }
    await pending.catch(() => {})
  }
})

test("401 cancels the old response, refreshes once and replays the exact body only once", async () => {
  Date.now = () => NOW
  const s = store(saved()), hooks = await entry.NousPortalAuthPlugin({ client: s.client }), loader = await hooks.auth.loader(s.get)
  let calls = 0, refreshes = 0, cancelled = false
  const bodies = [], bearers = []
  globalThis.fetch = async (url, init) => {
    if (url === PORTAL + "/api/oauth/token") { refreshes++; return json(payload({ access_token: jwt({ sub: "renewed" }) })) }
    calls++; bodies.push(Buffer.from(init.body).toString()); bearers.push(init.headers.get("authorization"))
    return calls === 1 ? new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 401 }) : json({ error: "still unauthorized" }, 401)
  }
  const response = await loader.fetch(INFERENCE + "/chat/completions", { method: "POST", body: '{"stream":true}' })
  assert.equal(response.status, 401)
  assert.equal(calls, 2)
  assert.equal(refreshes, 1)
  assert.equal(cancelled, true)
  assert.deepEqual(bodies, ['{"stream":true}', '{"stream":true}'])
  assert.notEqual(bearers[0], bearers[1])
})

test("403, 429 and server failures are returned without a forced refresh or replay", async () => {
  Date.now = () => NOW
  for (const status of [403, 429, 500]) {
    const s = store(saved()), hooks = await entry.NousPortalAuthPlugin({ client: s.client }), loader = await hooks.auth.loader(s.get)
    let calls = 0
    globalThis.fetch = async (url) => { calls++; assert.ok(url.startsWith(INFERENCE)); return json({ error: "test" }, status, { "retry-after": "60" }) }
    const response = await loader.fetch(INFERENCE + "/chat/completions", { method: "POST", body: "{}" })
    assert.equal(response.status, status)
    assert.equal(response.headers.get("x-magpie-sign-in"), "kept")
    assert.equal(response.headers.get("retry-after"), "60")
    assert.equal(calls, 1)
  }
})

test("foreign origins, alternate ports and unsupported paths are refused before refresh", async () => {
  Date.now = () => NOW
  const s = store(expiring()), hooks = await entry.NousPortalAuthPlugin({ client: s.client }), loader = await hooks.auth.loader(s.get)
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error("must not send") }
  for (const url of ["https://evil.invalid/v1/models", "http://inference-api.nousresearch.com/v1/models", "https://inference-api.nousresearch.com:8443/v1/models", INFERENCE + "/messages", INFERENCE + "/images/generations", INFERENCE + "/models#secret"]) await assert.rejects(loader.fetch(url), /refusing_inference_destination/)
  assert.equal(calls, 0)
})

test("RequestInit overrides the Request, including method, body and headers", async () => {
  Date.now = () => NOW
  const s = store(saved()), hooks = await entry.NousPortalAuthPlugin({ client: s.client }), loader = await hooks.auth.loader(s.get)
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.method, "POST")
    assert.equal(Buffer.from(init.body).toString(), "override")
    assert.equal(init.headers.get("x-test"), "new")
    return json({})
  }
  await loader.fetch(new Request(INFERENCE + "/chat/completions", { method: "POST", body: "old", headers: { "x-test": "old" } }), { method: "POST", body: "override", headers: { "x-test": "new" } })
})

test("an already-aborted request neither refreshes nor sends inference", async () => {
  Date.now = () => NOW
  const s = store(expiring()), hooks = await entry.NousPortalAuthPlugin({ client: s.client }), loader = await hooks.auth.loader(s.get)
  let calls = 0
  globalThis.fetch = async () => { calls++; return json(payload()) }
  const ac = new AbortController(); ac.abort()
  await assert.rejects(loader.fetch(INFERENCE + "/models", { signal: ac.signal }), (e) => e.name === "AbortError")
  assert.equal(calls, 0)
})

test("aborting one waiter does not abandon a rotating token needed by another request", async () => {
  Date.now = () => NOW
  const s = store(expiring()), hooks = await entry.NousPortalAuthPlugin({ client: s.client }), loader = await hooks.auth.loader(s.get)
  const entered = deferred(), reply = deferred()
  let refreshes = 0, inferences = 0
  globalThis.fetch = async (url) => {
    if (url === PORTAL + "/api/oauth/token") { refreshes++; entered.resolve(); await reply.promise; return json(payload()) }
    inferences++; return json({ data: [] })
  }
  const ac = new AbortController()
  const first = loader.fetch(INFERENCE + "/models", { signal: ac.signal })
  const firstRejected = assert.rejects(first, (e) => e.name === "AbortError")
  await entered.promise
  const second = loader.fetch(INFERENCE + "/models")
  ac.abort()
  await firstRejected
  reply.resolve()
  await second
  assert.equal(refreshes, 1)
  assert.equal(inferences, 1)
  assert.equal(metadata(await s.get()).token, "rotated-test-refresh")
})

test("the live model catalog preserves slash IDs and replaces the bootstrap, including an empty list", async () => {
  Date.now = () => NOW
  const s = store(saved()), hooks = await entry.NousPortalAuthPlugin({ client: s.client })
  const provider = { id: ID, models: { "Hermes-4-70B": {}, "vendor/model": { name: "Known", limit: { context: 123, output: 45 } } } }
  globalThis.fetch = async (url) => { assert.equal(url, INFERENCE + "/models"); return json({ data: [{ id: "vendor/model" }, { id: "nous/hermes-test" }] }) }
  const models = await hooks.provider.models(provider, { auth: await s.get() })
  assert.deepEqual(Object.keys(models), ["vendor/model", "nous/hermes-test"])
  assert.equal(models["vendor/model"].api.id, "vendor/model")
  assert.equal(models["vendor/model"].limit.context, 123)
  globalThis.fetch = async () => json({ data: [] })
  assert.deepEqual(await hooks.provider.models(provider, { auth: await s.get() }), {})
})

test("bad catalog reads throw instead of pretending the account has no models", async () => {
  Date.now = () => NOW
  const s = store(saved()), hooks = await entry.NousPortalAuthPlugin({ client: s.client })
  for (const body of [{}, { data: {} }, { data: [{ id: "" }] }]) {
    globalThis.fetch = async () => json(body)
    await assert.rejects(hooks.provider.models({ id: ID, models: {} }, { auth: await s.get() }), /invalid_models_response/)
  }
})

test("cancellation while reading the request body never starts an orphaned refresh", async () => {
  Date.now = () => NOW
  const s = store(expiring()), hooks = await entry.NousPortalAuthPlugin({ client: s.client }), loader = await hooks.auth.loader(s.get)
  let controller, calls = 0
  const ac = new AbortController()
  const body = new ReadableStream({ start(c) { controller = c } })
  globalThis.fetch = async () => { calls++; throw new Error("must not start") }
  const pending = loader.fetch(new Request(INFERENCE + "/chat/completions", { method: "POST", body, duplex: "half", signal: ac.signal }))
  const rejected = assert.rejects(pending, (e) => e.name === "AbortError")
  ac.abort()
  controller.close()
  await rejected
  await Promise.resolve()
  assert.equal(calls, 0)
})

test("catalog snapshots never rotate or overwrite a concurrently changed account", async () => {
  Date.now = () => NOW
  const s = store(expiring()), hooks = await entry.NousPortalAuthPlugin({ client: s.client })
  const snapshot = await s.get()
  const next = saved({}, { token: "new-login-refresh" })
  let calls = 0
  globalThis.fetch = async (url, init) => {
    calls++
    assert.equal(url, INFERENCE + "/models")
    assert.equal(init.redirect, "error")
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer " + snapshot.access)
    s.replace(next)
    return json({ data: [] })
  }
  await hooks.provider.models({ id: ID, models: {} }, { auth: snapshot })
  assert.equal(calls, 1)
  assert.equal(s.writes.length, 0)
  assert.deepEqual(await s.get(), next)
})

test("a failed credential read is unknown, not a logout, and cannot leak store contents", async () => {
  const s = store(expiring()), c = clock()
  const flow = createAuth(s.client, options(c, noNetwork))
  await assert.rejects(flow.fresh(async () => { throw new Error("parse error: old-test-refresh") }), (e) => e.code === "could_not_read_sign_in" && e.signIn === "kept" && !e.message.includes("old-test-refresh"))
  assert.equal(s.writes.length, 0)
})

test("a successful proactive request refresh reports renewed without changing SSE bytes", async () => {
  Date.now = () => NOW
  const s = store(expiring()), hooks = await entry.NousPortalAuthPlugin({ client: s.client }), loader = await hooks.auth.loader(s.get)
  globalThis.fetch = async (url) => url === PORTAL + "/api/oauth/token" ? json(payload()) : new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  const result = await loader.fetch(INFERENCE + "/chat/completions", { method: "POST", body: "{}" })
  assert.equal(result.headers.get("x-magpie-sign-in"), "renewed")
  assert.equal(await result.text(), "data: [DONE]\n\n")
})

test("device polling uses monotonic time even when the wall clock moves backwards", async () => {
  let monotonic = 0, wall = NOW, calls = 0
  const flow = createAuth({}, {
    now: () => wall, clock: () => monotonic,
    sleep: async (ms) => { monotonic += ms },
    request: async () => {
      if (++calls === 1) return json(device({ expires_in: 12 }))
      wall -= 3600000
      return json({ error: "authorization_pending" }, 400)
    },
  })
  assert.equal((await (await flow.authorize()).callback()).type, "failed")
  assert.equal(monotonic, 12000)
  assert.equal(calls, 3)
})

test("a broken server lifetime cannot leave a login poll running indefinitely", async () => {
  const c = clock()
  let calls = 0
  const a = await createAuth({}, options(c, async () => {
    if (++calls === 1) return json(device({ expires_in: 1e100, interval: 1e100 }))
    throw new Error("must not poll past the local deadline")
  })).authorize()
  assert.equal((await a.callback()).type, "failed")
  assert.deepEqual(c.sleeps, [1800000])
  assert.equal(calls, 1)
})

test("JWT scp arrays work; missing subjects never become a shared synthetic account id", async () => {
  const c = clock()
  const replies = [json(device()), json(payload({ access_token: jwt({ scope: undefined, scp: [SCOPE], sub: undefined }), scope: undefined }))]
  const a = await createAuth({}, options(c, async () => replies.shift())).authorize()
  const result = await a.callback()
  assert.equal(result.type, "success")
  assert.equal(Object.hasOwn(result, "accountId"), false)
})

test("HTTP-date Retry-After is measured against the wall clock, independent of timezone", async () => {
  const c = clock()
  const replies = [json(device()), json({}, 503, { "retry-after": new Date(NOW + 25000).toUTCString() }), json(payload())]
  const a = await createAuth({}, options(c, async () => replies.shift())).authorize()
  assert.equal((await a.callback()).type, "success")
  assert.deepEqual(c.sleeps, [5000, 20000])
})

// PR #163: transport failures are not evidence that a refresh grant is dead.
const blockedReplies = [
  ["HTML 403", () => new Response("<html>blocked old-test-refresh</html>", { status: 403, headers: { "content-type": "text/html" } })],
  ["empty 401", () => new Response(null, { status: 401 })],
  ["JSON without an OAuth code", () => json({}, 403)],
  ["unknown OAuth code", () => json({ error: "proxy_denied", error_description: "old-test-refresh" }, 401)],
  ["nested error", () => json({ error: { code: "invalid_grant" } }, 403)],
]

test("host refresh keeps unknown 401/403 refusals and retries after cooldown", async () => {
  for (const [name, reply] of blockedReplies) {
    const c = clock(), original = expiring(), s = store(original)
    let calls = 0
    const flow = createAuth(s.client, options(c, async () => ++calls === 1 ? reply() : json(payload())))
    const kept = (e) => e.code === "oauth_request_failed" && e.signIn === "kept" && !e.message.includes("old-test-refresh")
    await assert.rejects(flow.refresh(original), kept, name)
    await assert.rejects(flow.refresh(original), kept, name)
    assert.equal(calls, 1, "do not hammer a blocked endpoint")
    assert.deepEqual(await s.get(), original)
    c.advance(30001)
    const got = await flow.refresh(original)
    assert.equal(metadata(got).token, "rotated-test-refresh", name)
    assert.equal(calls, 2, "an unknown refusal must not permanently disable refresh")
    assert.equal(s.writes.length, 0, "the host owns persistence")
  }
})

test("an expired account survives blocked refresh and saves a later successful rotation", async () => {
  for (const [name, reply] of blockedReplies) {
    const c = clock(), original = saved({ expires: NOW - 1, access: jwt({ exp: (NOW - 1) / 1000 }) }), s = store(original)
    let calls = 0
    const flow = createAuth(s.client, options(c, async () => ++calls === 1 ? reply() : json(payload())))
    await assert.rejects(flow.fresh(s.get), (e) => e.signIn === "kept", name)
    await assert.rejects(flow.fresh(s.get), (e) => e.signIn === "kept", name)
    assert.equal(calls, 1)
    assert.deepEqual(await s.get(), original)
    assert.equal(s.writes.length, 0)
    c.advance(30001)
    assert.equal((await flow.fresh(s.get)).signIn, "renewed", name)
    assert.equal(metadata(await s.get()).token, "rotated-test-refresh")
    assert.equal(s.writes.length, 1)
  }
})

test("an unknown refresh refusal keeps a valid JWT but never reuses a rejected bearer", async () => {
  for (const [name, reply] of blockedReplies) {
    const c = clock(), original = expiring(), s = store(original)
    let calls = 0
    const flow = createAuth(s.client, options(c, async () => { calls++; return reply() }))
    assert.equal((await flow.fresh(s.get)).access, original.access, name)
    await assert.rejects(flow.fresh(s.get, original.access), (e) => e.signIn === "kept", name)
    assert.equal(calls, 1)
    assert.deepEqual(await s.get(), original)
    assert.equal(s.writes.length, 0)
  }
})

test("explicit dead grants still expire the account on 400, 401 and 403", async () => {
  for (const status of [400, 401, 403]) for (const error of ["invalid_grant", "invalid_token", "refresh_token_reused"]) {
    const c = clock(), s = store(expiring())
    let calls = 0
    const flow = createAuth(s.client, options(c, async () => { calls++; return json({ error }, status) }))
    await assert.rejects(flow.refresh(await s.get()), (e) => e.signIn === "expired" && e.code === error)
    c.advance(60000)
    await assert.rejects(flow.fresh(s.get), (e) => e.signIn === "expired" && e.code === error)
    assert.equal(calls, 1)
    assert.equal(s.writes.length, 0)
  }
})

test("device login without either expiry uses a one-hour scheduling fallback", async () => {
  const c = clock(), replies = [json(device()), json(payload({ expires_in: undefined, access_token: jwt({ exp: undefined }) }))]
  const flow = createAuth({}, options(c, async () => replies.shift()))
  const login = await flow.authorize(), got = await login.callback()
  assert.equal(got.type, "success")
  assert.equal(got.expires, c.now() + 3600000)
  assert.equal(flow.current({ ...got, type: "oauth" }).access, got.access)
})

test("host renewal without expiry returns a stable lifetime instead of renewing every 30s", async () => {
  const c = clock(), original = expiring()
  let calls = 0
  const flow = createAuth({}, options(c, async () => {
    calls++
    return json(payload({ expires_in: undefined, access_token: jwt({ exp: undefined }) }))
  }))
  const got = await flow.refresh(original)
  assert.equal(got.expires, NOW + 3600000)
  c.advance(31000)
  assert.deepEqual(await flow.refresh({ ...original, ...got }), got)
  assert.equal(calls, 1)
})

test("request renewal persists fallback expiry across reloads and honors the refresh lead", async () => {
  const c = clock(), s = store(expiring()), spent = []
  const request = async (_url, init) => {
    spent.push(init.headers["x-nous-refresh-token"])
    return json(payload({ expires_in: undefined, access_token: jwt({ exp: undefined, iat: c.now() / 1000 }), refresh_token: `rotated-${spent.length}` }))
  }
  const flow = createAuth(s.client, options(c, request))
  const got = await flow.fresh(s.get)
  assert.equal(got.expires, NOW + 3600000)
  assert.equal(s.writes.length, 1)
  const reloaded = createAuth(s.client, options(c, request))
  c.advance(31000)
  assert.equal((await reloaded.fresh(s.get)).expires, got.expires)
  c.advance(3600000 - LEAD - 31000 - 1)
  assert.equal((await reloaded.fresh(s.get)).expires, got.expires)
  assert.equal(spent.length, 1)
  c.advance(1)
  const next = await reloaded.fresh(s.get)
  assert.equal(next.expires, c.now() + 3600000)
  assert.deepEqual(spent, ["old-test-refresh", "rotated-1"])
  assert.equal(s.writes.length, 2)
})

test("known lifetimes take precedence over the fallback and use the earlier bound", async () => {
  for (const [ttl, jwtTTL, expected] of [[900, 3600, 900], [undefined, 600, 600], [7200, 900, 900], [7200, undefined, 7200]]) {
    const c = clock()
    const flow = createAuth({}, options(c, async () => json(payload({ expires_in: ttl, access_token: jwt({ exp: jwtTTL === undefined ? undefined : NOW / 1000 + jwtTTL }) }))))
    assert.equal((await flow.refresh(expiring())).expires, NOW + expected * 1000)
  }
})

test("fallback expiry does not extend an explicitly expired or malformed lifetime", async () => {
  const cases = [
    ...[0, -1, 1e308].map(expires_in => ({ expires_in })),
    ...[null, "3600"].map(expires_in => ({ expires_in, access_token: jwt({ exp: undefined }) })),
    ...[0, -1, null, "1800003600", 1e308].map(exp => ({ expires_in: undefined, access_token: jwt({ exp }) })),
  ]
  for (const fields of cases) {
    const c = clock()
    const flow = createAuth({}, options(c, async () => json(payload(fields))))
    const got = await flow.refresh(expiring())
    assert.equal(got.expires, 1)
    assert.equal(metadata(got).token, "rotated-test-refresh", "a bad lifetime cannot discard an already rotated refresh token")
    assert.throws(() => flow.current({ type: "oauth", ...got }), /unusable_inference_jwt/)
  }
})

// #328: Nous sending expires_in null or as a string must not make a sign-in
// whose JWT exp is valid unusable; the exp decides, as Hermes's does
test("a null or string expires_in beside a valid JWT exp takes the exp", async () => {
  for (const expires_in of [null, "3600", "", {}]) {
    const c = clock()
    const exp = (NOW + 600000) / 1000
    const flow = createAuth({}, options(c, async () => json(payload({ expires_in, access_token: jwt({ exp }) }))))
    const got = await flow.refresh(expiring())
    assert.equal(got.expires, exp * 1000, `expires_in ${JSON.stringify(expires_in)}`)
    assert.equal(flow.current({ type: "oauth", ...got }).access, got.access)
  }
})

test("fallback expiry cannot make malformed or non-inference JWTs usable", async () => {
  for (const fields of [
    { access_token: "not-a-jwt" },
    { access_token: jwt({ exp: undefined, scope: "profile" }), scope: "profile" },
    { access_token: jwt({ exp: undefined }), token_type: "Basic" },
  ]) {
    const c = clock()
    const flow = createAuth({}, options(c, async () => json(payload({ expires_in: undefined, ...fields }))))
    const got = await flow.refresh(expiring())
    assert.equal(got.expires, 1)
    assert.equal(metadata(got).token, "rotated-test-refresh")
    assert.throws(() => flow.current({ type: "oauth", ...got }), /unusable_inference_jwt/)
  }
})

test("decoded response headers are stripped for success, errors and the final 401 replay", async () => {
  Date.now = () => NOW
  for (const status of [200, 401, 403, 429, 500]) {
    const s = store(saved()), hooks = await entry.NousPortalAuthPlugin({ client: s.client }), loader = await hooks.auth.loader(s.get)
    let calls = 0
    const body = status === 200 ? 'data: {"text":"你好"}\n\ndata: [DONE]\n\n' : '{"error":"upstream refused"}'
    globalThis.fetch = async (url) => {
      if (String(url).includes("/api/oauth/token")) return json(payload({ access_token: jwt({ jti: "next" }) }))
      calls++
      return new Response(body, { status, headers: { "content-type": status === 200 ? "text/event-stream" : "application/json", "content-encoding": "gzip", "content-length": "999", "retry-after": "7", "x-upstream": "kept" } })
    }
    const res = await loader.fetch(INFERENCE + "/chat/completions", { method: "POST", body: "{}" })
    assert.equal(res.status, status)
    assert.equal(res.headers.has("content-encoding"), false)
    assert.equal(res.headers.has("content-length"), false)
    assert.equal(res.headers.get("x-upstream"), "kept")
    assert.equal(res.headers.get("retry-after"), "7")
    assert.equal(await res.text(), body)
    assert.equal(calls, status === 401 ? 2 : 1)
  }
})

test("native fetch decompression through a loopback server preserves bytes without wire headers", { timeout: 15000 }, async () => {
  const { createServer } = await import("node:http")
  const { gzipSync } = await import("node:zlib")
  const body = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n'
  const zipped = gzipSync(Buffer.from(body))
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip", "content-length": String(zipped.length), "x-upstream": "native", connection: "close" })
    res.end(zipped)
  })
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
    Date.now = () => NOW
    const s = store(saved()), hooks = await entry.NousPortalAuthPlugin({ client: s.client }), loader = await hooks.auth.loader(s.get)
    globalThis.fetch = async (url, init) => {
      assert.equal(url, INFERENCE + "/chat/completions")
      return originalFetch(`http://127.0.0.1:${server.address().port}/`, init)
    }
    const res = await loader.fetch(INFERENCE + "/chat/completions", { method: "POST", body: "{}" })
    assert.equal(res.headers.get("content-type"), "text/event-stream")
    assert.equal(res.headers.get("x-upstream"), "native")
    assert.equal(res.headers.has("content-encoding"), false)
    assert.equal(res.headers.has("content-length"), false)
    assert.equal(await res.text(), body)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
