// The plugin's own hooks: the config shape magpie reads, the room plan, and
// a whole request answered from a stubbed Tabbit.

import test from "node:test"
import assert from "node:assert/strict"
import { TabbitPlugin, _internal } from "../index.mjs"
import { credsOf, claimsOf, uidOfClaims, stale, expiresAt } from "../src/api.mjs"

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const GOOD_TURN = [
  frame("message_history", { payload: { messages: [{ message_id: "a0", role: "user", content: "hi" }, { message_id: "a1", role: "assistant", content: "" }] } }),
  frame("assistant_message_started", { payload: { run_id: "r1", message_id: "a1" } }),
  frame("event_message_chunk", { payload: { chunk_type: "thinking", chunk_payload: { reasoning_content: "想" } } }),
  frame("assistant_message_delta", { payload: { chunk_payload: { content: "你" } } }),
  frame("assistant_message_delta", { payload: { chunk_payload: { content: "好" } } }),
  frame("assistant_message_finished", { payload: { message_id: "a1" } }),
  frame("run_completed", { payload: { status: "COMPLETED" } }),
].join("")

// installFetch stubs the network with a Tabbit that answers the four calls.
function installFetch({ onCall } = {}) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url)
    const method = (init.method ?? "GET").toUpperCase()
    calls.push({ method, path: url.pathname, headers: new Headers(init.headers ?? {}), body: init.body })
    onCall?.({ method, path: url.pathname, init })
    if (url.pathname === "/api/v3/chat/rooms" && method === "POST") {
      return Response.json({ room_id: "room-" + calls.length, chat_session_id: "room-" + calls.length })
    }
    if (url.pathname.endsWith("/runs") && method === "POST") {
      return Response.json({ run_id: "run-1", status: "QUEUED" })
    }
    if (url.pathname.endsWith("/join") && method === "POST") {
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(GOOD_TURN))
            c.close()
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    }
    if (url.pathname === "/proxy/v1/model_config/models") {
      return Response.json({
        models: [
          { display_name: "Default", supports_tools: true, support_thinking: true, model_access_type: "free_unlimited" },
          { display_name: "Kimi-K3.1-Pro", supports_tools: true, support_thinking: true, model_access_type: "premium_only" },
          { display_name: "GLM-5.3-Flash", supports_images: true, supports_tools: true, support_thinking: true, model_access_type: "free_metered" },
        ],
      })
    }
    if (url.pathname === "/api/commerce/quota/v1/usage") {
      return Response.json({ member_level: "free", usage_percentage: "12.18%", current_cycle_start: "2026.11.03", current_cycle_end: "2026.11.10" })
    }
    return new Response("not found", { status: 404 })
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

const auth = { type: "api", key: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.sig", metadata: { userId: "u-1" } }

test("config declares tabbit as an OpenAI-compatible provider with bootstrap models", async () => {
  const hooks = await TabbitPlugin()
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const p = cfg.provider.tabbit
  assert.equal(p.name, "Tabbit")
  assert.equal(p.npm, "@ai-sdk/openai-compatible")
  assert.ok(p.api.endsWith("/api/v3/chat"))
  assert.ok(Object.keys(p.models).length >= 3)
})

test("planTurn continues a room only when the transcript does", () => {
  const first = _internal.planTurn(undefined, [{ role: "user", content: "我叫小明" }], 1000)
  assert.equal(first.room, null)
  assert.match(first.content, /我叫小明/)

  const entry = { room: "room-1", parent: "a1", sent: [{ role: "user", content: "我叫小明" }, { role: "assistant", content: "记住了" }], at: 1000 }
  const next = _internal.planTurn(entry, [
    { role: "user", content: "我叫小明" },
    { role: "assistant", content: "记住了" },
    { role: "user", content: "我叫什么" },
  ], 2000)
  assert.equal(next.room, "room-1")
  assert.equal(next.parent, "a1")
  assert.equal(next.content, "我叫什么")
})

test("a diverging transcript gets a fresh room and a flattened prompt", () => {
  const entry = { room: "room-1", parent: "a1", sent: [{ role: "user", content: "别的" }], at: 1000 }
  const plan = _internal.planTurn(entry, [{ role: "user", content: "全新的话题" }], 2000)
  assert.equal(plan.room, null)
  assert.match(plan.content, /全新的话题/)
})

test("a stale room is not continued", () => {
  const entry = { room: "room-1", parent: "a1", sent: [{ role: "user", content: "a" }], at: 0 }
  const plan = _internal.planTurn(entry, [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }], 31 * 60 * 1000)
  assert.equal(plan.room, null)
})

test("a non-streaming request is answered as one chat.completion", async () => {
  const { calls, restore } = installFetch()
  try {
    const hooks = await TabbitPlugin()
    const loader = await hooks.auth.loader(async () => auth)
    const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-tabbit-session": "s1" },
      body: JSON.stringify({ model: "Default", messages: [{ role: "user", content: "hi" }], stream: false }),
    })
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.object, "chat.completion")
    assert.equal(body.choices[0].message.content, "你好")
    assert.equal(body.choices[0].message.reasoning_content, "想")
    assert.ok(body.usage.total_tokens > 0)
    // the cookie the token implies is on every call
    assert.match(calls[0].headers.get("cookie"), /token=eyJ/)
  } finally {
    restore()
  }
})

test("a streaming request comes back as OpenAI chunks ending in [DONE]", async () => {
  const { restore } = installFetch()
  try {
    const hooks = await TabbitPlugin()
    const loader = await hooks.auth.loader(async () => auth)
    const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "Default", messages: [{ role: "user", content: "hi" }], stream: true, stream_options: { include_usage: true } }),
    })
    assert.match(res.headers.get("content-type"), /text\/event-stream/)
    const text = await res.text()
    assert.match(text, /"content":"你"/)
    assert.match(text, /"reasoning_content":"想"/)
    assert.match(text, /data: \[DONE\]/)
    assert.match(text, /"usage"/)
  } finally {
    restore()
  }
})

test("the model list follows the account, and premium rows are dropped on request", async () => {
  const { restore } = installFetch()
  try {
    const hooks = await TabbitPlugin()
    const provider = { models: {} }
    const rows = await hooks.provider.models(provider, { auth })
    assert.deepEqual(Object.keys(rows), ["Default", "Kimi-K3.1-Pro", "GLM-5.3-Flash"])

    globalThis.magpie = { option: () => true }
    const freeOnly = await hooks.provider.models(provider, { auth })
    assert.deepEqual(Object.keys(freeOnly), ["Default", "GLM-5.3-Flash"])
    delete globalThis.magpie
  } finally {
    restore()
  }
})

test("usage reports the cycle as a percentage window", async () => {
  const { restore } = installFetch()
  try {
    const hooks = await TabbitPlugin()
    const u = await hooks.auth.usage(async () => auth)
    assert.equal(u.plan, "Tabbit free")
    assert.equal(u.windows[0].used, 12.18)
    assert.equal(u.windows[0].unit, "%")
    assert.equal(u.windows[0].resetsAt, "2026-11-09T16:00:00.000Z")
  } finally {
    restore()
  }
})

test("a refused sign-in marks the account, and says so in words", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "请先登录" }), { status: 401 })
  try {
    const hooks = await TabbitPlugin()
    const loader = await hooks.auth.loader(async () => auth)
    const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "Default", messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get("x-magpie-sign-in"), "expired")
  } finally {
    globalThis.fetch = original
  }
})

test("a premium-only model's 403 does not mark the sign-in", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(typeof input === "string" ? input : input.url).pathname
    if (path === "/api/v3/chat/rooms") return Response.json({ room_id: "r" })
    return new Response(JSON.stringify({ detail: { message: "premium users only", code: 492 } }), { status: 403 })
  }
  try {
    const hooks = await TabbitPlugin()
    const loader = await hooks.auth.loader(async () => auth)
    const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "Kimi-K3.1-Pro", messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 403)
    assert.equal(res.headers.get("x-magpie-sign-in"), null)
  } finally {
    globalThis.fetch = original
  }
})

test("credsOf accepts a bare JWT and a full cookie string", () => {
  const bare = credsOf({ key: "aaa.bbb.ccc", metadata: { userId: "u9" } })
  assert.match(bare.header, /token=aaa\.bbb\.ccc/)
  assert.match(bare.header, /user_id=u9/)
  const whole = credsOf({ key: "token=xyz; user_id=u2; managed=tab_browser" })
  assert.equal(whole.token, "xyz")
  assert.equal(whole.uid, "u2")
  assert.equal(credsOf({ key: "" }), null)
})

test("the JWT's own claims name the account and its end", () => {
  const payload = Buffer.from(JSON.stringify({ sub: "u-7", exp: 2000000000 })).toString("base64url")
  const token = `h.${payload}.s`
  const claims = claimsOf(token)
  assert.equal(uidOfClaims(claims), "u-7")
  assert.equal(expiresAt({ key: token }), new Date(2000000000 * 1000).toISOString())
  assert.equal(stale({ key: token }), false)
  const past = Buffer.from(JSON.stringify({ sub: "u", exp: 1 })).toString("base64url")
  assert.equal(stale({ key: `h.${past}.s` }), true)
})

test("a follow-up in the same session reuses the room and sends only the new message", async () => {
  const { calls, restore } = installFetch()
  try {
    const hooks = await TabbitPlugin()
    _internal.rooms.clear()
    const loader = await hooks.auth.loader(async () => auth)
    const send = (messages) =>
      loader.fetch(`${loader.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-magpie-tabbit-session": "s-room" },
        body: JSON.stringify({ model: "Default", messages, stream: false }),
      })

    await send([{ role: "user", content: "我叫小明" }])
    const first = calls.filter((c) => c.path === "/api/v3/chat/rooms" && c.method === "POST").length
    assert.equal(first, 1)

    await send([
      { role: "user", content: "我叫小明" },
      { role: "assistant", content: "记住了" },
      { role: "user", content: "我叫什么" },
    ])
    // no second room: the transcript continues the one we have
    assert.equal(calls.filter((c) => c.path === "/api/v3/chat/rooms" && c.method === "POST").length, 1)
    const runs = calls.filter((c) => c.path.endsWith("/runs"))
    assert.equal(runs.length, 2)
    const second = JSON.parse(runs[1].body)
    assert.equal(second.input_payload.content, "我叫什么")
    assert.equal(second.input_payload.parent_message_id, "a1")
  } finally {
    restore()
    _internal.rooms.clear()
  }
})

test("a different session gets its own room and a flattened prompt", async () => {
  const { calls, restore } = installFetch()
  try {
    const hooks = await TabbitPlugin()
    _internal.rooms.clear()
    const loader = await hooks.auth.loader(async () => auth)
    await loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-tabbit-session": "s-a" },
      body: JSON.stringify({ model: "Default", messages: [{ role: "user", content: "一" }], stream: false }),
    })
    await loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-tabbit-session": "s-b" },
      body: JSON.stringify({
        model: "Default",
        messages: [
          { role: "system", content: "简洁" },
          { role: "user", content: "一" },
          { role: "assistant", content: "二" },
          { role: "user", content: "三" },
        ],
        stream: false,
      }),
    })
    assert.equal(calls.filter((c) => c.path === "/api/v3/chat/rooms" && c.method === "POST").length, 2)
    const runs = calls.filter((c) => c.path.endsWith("/runs"))
    const body = JSON.parse(runs[1].body)
    assert.match(body.input_payload.content, /\[system\]/)
    assert.match(body.input_payload.content, /user: 一/)
    assert.match(body.input_payload.content, /assistant: 二/)
    assert.match(body.input_payload.content, /user: 三$/)
  } finally {
    restore()
    _internal.rooms.clear()
  }
})

// ---- review round: statuses, accounts, cancel, pruning --------------------

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url")
const jwtFor = (sub) => `h.${b64url({ sub, exp: 2000000000 })}.s`

const chatBody = (model = "Default", messages = [{ role: "user", content: "hi" }], extra = {}) =>
  JSON.stringify({ model, messages, stream: false, ...extra })

async function fetchWith(auth, body, headers = {}) {
  const hooks = await TabbitPlugin()
  const loader = await hooks.auth.loader(async () => auth)
  return loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  })
}

test("the plugin's own 400 (no model) passes through as 400", async () => {
  const res = await fetchWith(auth, JSON.stringify({ messages: [{ role: "user", content: "hi" }] }))
  assert.equal(res.status, 400)
})

test("a path this provider doesn't serve is a 404, not a 502", async () => {
  const hooks = await TabbitPlugin()
  const loader = await hooks.auth.loader(async () => auth)
  const res = await loader.fetch(`${loader.baseURL}/models`, { method: "GET" })
  assert.equal(res.status, 404)
})

test("Tabbit's 429 passes through with its retry-after", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(typeof input === "string" ? input : input.url).pathname
    if (path === "/api/v3/chat/rooms") return new Response("{}", { status: 429, headers: { "retry-after": "7" } })
    return new Response("{}", { status: 200 })
  }
  try {
    const res = await fetchWith(auth, chatBody())
    assert.equal(res.status, 429)
    assert.equal(res.headers.get("retry-after"), "7")
  } finally {
    globalThis.fetch = original
  }
})

test("a 500 from Tabbit is a 502 here", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (input) => {
    const path = new URL(typeof input === "string" ? input : input.url).pathname
    if (path === "/api/v3/chat/rooms") return new Response("boom", { status: 500 })
    return new Response("{}", { status: 200 })
  }
  try {
    const res = await fetchWith(auth, chatBody())
    assert.equal(res.status, 502)
  } finally {
    globalThis.fetch = original
  }
})

test("rooms are keyed by account as well as session", async () => {
  const { calls, restore } = installFetch()
  try {
    _internal.rooms.clear()
    let current = { type: "api", key: jwtFor("acct-a") }
    const hooks = await TabbitPlugin()
    const loader = await hooks.auth.loader(async () => current)
    const send = (key, messages) => {
      current = { type: "api", key }
      return loader.fetch(`${loader.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-magpie-tabbit-session": "shared" },
        body: JSON.stringify({ model: "Default", messages, stream: false }),
      })
    }
    await send(jwtFor("acct-a"), [{ role: "user", content: "我叫小明" }])
    // B continues A's transcript: with a session-only key this would reuse A's
    // room, which is the bug. With the account in the key it must not.
    await send(jwtFor("acct-b"), [
      { role: "user", content: "我叫小明" },
      { role: "assistant", content: "记住了" },
      { role: "user", content: "我叫什么" },
    ])
    const rooms = calls.filter((c) => c.path === "/api/v3/chat/rooms" && c.method === "POST")
    assert.equal(rooms.length, 2, "B reused A's room")
    const runs = calls.filter((c) => c.path.endsWith("/runs")).map((c) => c.path)
    assert.equal(runs.length, 2)
    assert.notEqual(runs[0].split("/")[5], runs[1].split("/")[5], "the same room was used for both accounts")
  } finally {
    restore()
    _internal.rooms.clear()
  }
})

// A stub that behaves like a real fetch: refuses at once when its signal is
// already aborted, and errors the body when the signal aborts mid-read.
function abortableTabbit({ encoder, calls, onJoin }) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url)
    const path = url.pathname
    const method = (init.method ?? "GET").toUpperCase()
    if (init.signal?.aborted) throw init.signal.reason ?? new Error("aborted")
    calls.push({ method, path, signal: init.signal })
    if (path === "/api/v3/chat/rooms") return Response.json({ room_id: "room-abort" })
    if (path.endsWith("/runs")) return Response.json({ run_id: "r1" })
    if (path.endsWith("/join")) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(frame("assistant_message_started", { payload: { run_id: "r1", message_id: "a1" } })))
          c.enqueue(encoder.encode(frame("assistant_message_delta", { payload: { chunk_payload: { content: "半" } } })))
          const onAbort = () => {
            try {
              c.error(init.signal.reason ?? new Error("aborted"))
            } catch {}
          }
          if (init.signal) init.signal.addEventListener("abort", onAbort, { once: true })
        },
        cancel() {},
      })
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    return new Response("{}", { status: 200 })
  }
}

test("aborting the request mid-stream asks Tabbit to stop the run", async () => {
  const encoder = new TextEncoder()
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = abortableTabbit({ encoder, calls })
  try {
    const ctrl = new AbortController()
    const hooks = await TabbitPlugin()
    const loader = await hooks.auth.loader(async () => auth)
    const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "Default", messages: [{ role: "user", content: "hi" }], stream: true }),
      signal: ctrl.signal,
    })
    const reader = res.body.getReader()
    await reader.read()
    ctrl.abort(new Error("client gave up"))
    try {
      await reader.read()
    } catch {
      /* the body errors, as a real fetch's does */
    }
    await new Promise((r) => setTimeout(r, 150))
    const stopCall = calls.find((c) => c.path === "/proxy/v0/chat/stop/")
    assert.ok(stopCall, "stop was never sent: " + JSON.stringify(calls.map((c) => c.path)))
    // and it must not ride the request's already-aborted signal
    assert.equal(stopCall.signal?.aborted, false, "stop used the aborted request signal")
  } finally {
    globalThis.fetch = original
  }
})

test("a turn longer than the request timeout still finishes", async () => {
  const old = process.env.TABBIT_TIMEOUT_MS
  process.env.TABBIT_TIMEOUT_MS = "30"
  const encoder = new TextEncoder()
  const original = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(typeof input === "string" ? input : input.url).pathname
    if (init.signal?.aborted) throw init.signal.reason ?? new Error("aborted")
    if (path === "/api/v3/chat/rooms") return Response.json({ room_id: "room-long" })
    if (path.endsWith("/runs")) return Response.json({ run_id: "r1" })
    if (path.endsWith("/join")) {
      const stream = new ReadableStream({
        async start(c) {
          const onAbort = () => {
            try {
              c.error(init.signal.reason ?? new Error("timed out"))
            } catch {}
          }
          if (init.signal) init.signal.addEventListener("abort", onAbort, { once: true })
          c.enqueue(encoder.encode(frame("assistant_message_started", { payload: { run_id: "r1", message_id: "a1" } })))
          // far longer than the 30 ms request timeout set above
          await new Promise((r) => setTimeout(r, 180))
          c.enqueue(encoder.encode(frame("assistant_message_delta", { payload: { chunk_payload: { content: "慢" } } })))
          c.enqueue(encoder.encode(frame("run_completed", { payload: {} })))
          c.close()
        },
        cancel() {},
      })
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    return new Response("{}", { status: 200 })
  }
  try {
    const res = await fetchWith(auth, chatBody())
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.choices[0].message.content, "慢")
  } finally {
    globalThis.fetch = original
    if (old === undefined) delete process.env.TABBIT_TIMEOUT_MS
    else process.env.TABBIT_TIMEOUT_MS = old
  }
})

test("a quiet stream ends at the turn timeout and stops the run", async () => {
  const old = process.env.TABBIT_STREAM_TIMEOUT_MS
  process.env.TABBIT_STREAM_TIMEOUT_MS = "120"
  const encoder = new TextEncoder()
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(typeof input === "string" ? input : input.url).pathname
    const method = (init.method ?? "GET").toUpperCase()
    if (init.signal?.aborted) throw init.signal.reason ?? new Error("aborted")
    calls.push({ method, path, signal: init.signal })
    if (path === "/api/v3/chat/rooms") return Response.json({ room_id: "room-quiet" })
    if (path.endsWith("/runs")) return Response.json({ run_id: "r1" })
    if (path.endsWith("/join")) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(frame("assistant_message_started", { payload: { run_id: "r1", message_id: "a1" } })))
          // then nothing at all: a stream that went quiet
        },
        cancel() {},
      })
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    return new Response("{}", { status: 200 })
  }
  try {
    const started = Date.now()
    const hooks = await TabbitPlugin()
    const loader = await hooks.auth.loader(async () => auth)
    const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "Default", messages: [{ role: "user", content: "hi" }], stream: true }),
    })
    const text = await res.text()
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2000, "took " + elapsed + "ms, the quiet stream was not woken")
    assert.match(text, /"error"/)
    assert.ok(calls.some((c) => c.path === "/proxy/v0/chat/stop/"), "stop was never sent")
  } finally {
    globalThis.fetch = original
    if (old === undefined) delete process.env.TABBIT_STREAM_TIMEOUT_MS
    else process.env.TABBIT_STREAM_TIMEOUT_MS = old
  }
})

test("a stream cut after the turn starts is an error event, and the room is not remembered", async () => {
  const encoder = new TextEncoder()
  const original = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(typeof input === "string" ? input : input.url).pathname
    if (path === "/api/v3/chat/rooms") return Response.json({ room_id: "room-cut" })
    if (path.endsWith("/runs")) return Response.json({ run_id: "r1" })
    if (path.endsWith("/join")) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(frame("snapshot_begin", { payload: {} })))
          c.enqueue(encoder.encode(frame("assistant_message_started", { payload: { run_id: "r1", message_id: "a1" } })))
          c.close() // cut here, no run_completed
        },
        cancel() {},
      })
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    return new Response("{}", { status: 200 })
  }
  try {
    _internal.rooms.clear()
    const hooks = await TabbitPlugin()
    const loader = await hooks.auth.loader(async () => auth)
    const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-tabbit-session": "cut" },
      body: JSON.stringify({ model: "Default", messages: [{ role: "user", content: "hi" }], stream: true }),
    })
    const text = await res.text()
    assert.match(text, /"error"/)
    assert.match(text, /data: \[DONE\]/)
    assert.doesNotMatch(text, /"finish_reason":"stop"/)
    assert.equal(_internal.rooms.size, 0, "a cut turn was remembered as a room")
  } finally {
    globalThis.fetch = original
    _internal.rooms.clear()
  }
})

test("rooms are pruned by ttl and capped in size", () => {
  _internal.rooms.clear()
  const stale = Date.now() - 31 * 60 * 1000
  _internal.rooms.set("old", { room: "r", parent: null, sent: [], at: stale })
  for (let i = 0; i < 400; i++) _internal.rooms.set(`k${i}`, { room: "r", parent: null, sent: [], at: Date.now() })
  _internal.pruneRooms()
  assert.equal(_internal.rooms.has("old"), false)
  assert.ok(_internal.rooms.size <= 256, "size " + _internal.rooms.size)
  _internal.rooms.clear()
})
