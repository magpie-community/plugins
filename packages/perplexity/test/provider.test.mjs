import { test } from "node:test"
import assert from "node:assert/strict"

import { server } from "../provider.mjs"

const realFetch = globalThis.fetch

const CLIENT = {
  app: { log: async () => {} },
  auth: { set: async () => {} },
}

const message = (o) => `event: message\ndata: ${JSON.stringify(o)}\n\n`
const endOfStream = () => `event: end_of_stream\ndata: {}\n\n`

const answerChunk = (text, progress = "IN_PROGRESS") =>
  message({
    backend_uuid: "b-uuid",
    blocks: [{ intended_usage: "ask_text", markdown_block: { progress, chunks: [text] } }],
  })

const SSE_OK = answerChunk("Hello ") + answerChunk("world.") + answerChunk("Hello world.", "DONE") + endOfStream()

async function withFetch(impl, run) {
  globalThis.fetch = impl
  try {
    return await run()
  } finally {
    globalThis.fetch = realFetch
  }
}

async function load(opts = {}) {
  const plugin = await server({ client: CLIENT }, { tier: "pro", locale: "en", ...opts })
  const shim = await plugin.auth.loader(() => ({ key: "cookie-value", metadata: { email: "me@example.com" } }))
  return { plugin, shim }
}

function body(payload) {
  return {
    method: "POST",
    headers: new Headers({ "x-pplx-session-id": "session-1" }),
    body: JSON.stringify(payload),
  }
}

const ask = (extra = {}) =>
  body({ model: "pplx_pro", messages: [{ role: "user", content: "hello" }], ...extra })

/** Parse an OpenAI-style SSE body into the objects it carried. */
async function readStream(res) {
  const text = await res.text()
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => block.replace(/^data: /, ""))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data))
}

test("a non-streaming answer is translated to a completion with flagged usage", async () => {
  const { shim } = await load()
  const res = await withFetch(async () => new Response(SSE_OK, { status: 200 }), () => shim.fetch("https://ask", ask()))

  assert.equal(res.status, 200)
  const out = await res.json()
  assert.equal(out.object, "chat.completion")
  assert.equal(out.choices[0].message.content, "Hello world.")
  assert.equal(out.choices[0].finish_reason, "stop")
  assert.equal(out.usage.prompt_tokens_details.estimated, true)
  assert.equal(out.usage.completion_tokens_details.estimated, true)
  assert.ok(out.usage.total_tokens > 0)
})

test("a streaming answer arrives as content deltas and ends with [DONE]", async () => {
  const { shim } = await load()
  const res = await withFetch(
    async () => new Response(SSE_OK, { status: 200 }),
    () => shim.fetch("https://ask", ask({ stream: true })),
  )

  assert.equal(res.status, 200)
  assert.match(res.headers.get("content-type"), /text\/event-stream/)
  const chunks = await readStream(res)
  const text = chunks.map((c) => c.choices?.[0]?.delta?.content || "").join("")
  assert.equal(text, "Hello world.")
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop")
  // Usage is only sent when asked for.
  assert.equal(chunks.some((c) => c.usage), false)
})

test("include_usage adds one labelled usage chunk", async () => {
  const { shim } = await load()
  const res = await withFetch(
    async () => new Response(SSE_OK, { status: 200 }),
    () => shim.fetch("https://ask", ask({ stream: true, stream_options: { include_usage: true } })),
  )
  const chunks = await readStream(res)
  const withUsage = chunks.filter((c) => c.usage)
  assert.equal(withUsage.length, 1)
  assert.equal(withUsage[0].usage.prompt_tokens_details.estimated, true)
})

test("a 403 carries Perplexity's own reason, not 'expired'", async () => {
  const { shim } = await load()
  const res = await withFetch(
    async () => new Response('{"detail":"Your account cannot use this model"}', { status: 403 }),
    () => shim.fetch("https://ask", ask()),
  )
  assert.equal(res.status, 403)
  const out = await res.json()
  assert.match(out.error.message, /cannot use this model/)
  assert.equal(out.error.type, "forbidden")
})

test("a 429 carries the quota message Perplexity sent", async () => {
  const { shim } = await load()
  const res = await withFetch(
    async () =>
      new Response('{"error":{"message":"You have used all your Pro Search queries."}}', { status: 429 }),
    () => shim.fetch("https://ask", ask()),
  )
  assert.equal(res.status, 429)
  const out = await res.json()
  assert.match(out.error.message, /Pro Search queries/)
  assert.equal(out.error.code, "rate_limited")
})

test("a 401 is reported as an expired session", async () => {
  const { shim } = await load()
  const res = await withFetch(
    async () => new Response("unauthorized", { status: 401 }),
    () => shim.fetch("https://ask", ask()),
  )
  assert.equal(res.status, 401)
  const out = await res.json()
  assert.equal(out.error.type, "session_expired")
})

test("an unexpected upstream status keeps its own number", async () => {
  const { shim } = await load()
  const res = await withFetch(
    async () => new Response("boom", { status: 500 }),
    () => shim.fetch("https://ask", ask()),
  )
  assert.equal(res.status, 500)
  const out = await res.json()
  assert.match(out.error.message, /500/)
  assert.match(out.error.message, /boom/)
})

test("tools are rejected instead of silently dropped", async () => {
  const { shim } = await load()
  let called = false
  const res = await withFetch(
    async () => {
      called = true
      return new Response(SSE_OK, { status: 200 })
    },
    () => shim.fetch("https://ask", ask({ tools: [{ type: "function", function: { name: "x" } }] })),
  )
  assert.equal(called, false, "nothing was sent upstream")
  assert.equal(res.status, 400)
  const out = await res.json()
  assert.equal(out.error.code, "tools_unsupported")
  assert.match(out.error.message, /function calling/i)
})

test("with tools: \"ignore\" the request is answered as text and marked", async () => {
  const { shim } = await load({ tools: "ignore" })
  const res = await withFetch(
    async () => new Response(SSE_OK, { status: 200 }),
    () => shim.fetch("https://ask", ask({ tools: [{ type: "function", function: { name: "Read" } }] })),
  )
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("x-magpie-tools-ignored"), "1")
  const out = await res.json()
  // The substitution is said in the answer itself, not only in a header.
  assert.match(out.choices[0].message.content, /Tools were ignored/)
  assert.match(out.choices[0].message.content, /Hello world\./)
})

test("the tools-ignored mark is on a streamed answer too", async () => {
  const { shim } = await load({ tools: "ignore" })
  const res = await withFetch(
    async () => new Response(SSE_OK, { status: 200 }),
    () => shim.fetch("https://ask", ask({ stream: true, tools: [{ type: "function", function: { name: "Read" } }] })),
  )
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("x-magpie-tools-ignored"), "1")
  const chunks = await readStream(res)
  const text = chunks.map((c) => c.choices?.[0]?.delta?.content || "").join("")
  assert.match(text, /Tools were ignored/)
})

test("tool_choice without any tools is not a tool request", async () => {
  // Clients send "auto" by default; only an actual tools array means tools.
  const { shim } = await load()
  let called = false
  const res = await withFetch(
    async () => {
      called = true
      return new Response(SSE_OK, { status: 200 })
    },
    () => shim.fetch("https://ask", ask({ tool_choice: "auto" })),
  )
  assert.equal(called, true)
  assert.equal(res.status, 200)
})

test("an error before the first token is a failed request, not a 200 stream", async () => {
  const { shim } = await load()
  const res = await withFetch(
    async () => new Response(message({ error: "quota exhausted" }) + endOfStream(), { status: 200 }),
    () => shim.fetch("https://ask", ask({ stream: true })),
  )
  assert.equal(res.status, 502)
  const out = await res.json()
  assert.match(out.error.message, /quota exhausted/)
  assert.equal(out.error.code, "midstream_error")
})

test("an error before any token fails a non-streaming request too", async () => {
  const { shim } = await load()
  const res = await withFetch(
    async () => new Response(message({ error: "nope" }) + endOfStream(), { status: 200 }),
    () => shim.fetch("https://ask", ask()),
  )
  assert.equal(res.status, 502)
})

test("an empty answer is an error, not an empty string", async () => {
  const { shim } = await load()
  for (const stream of [false, true]) {
    const res = await withFetch(
      async () => new Response(endOfStream(), { status: 200 }),
      () => shim.fetch("https://ask", ask({ stream })),
    )
    assert.equal(res.status, 502)
    const out = await res.json()
    assert.equal(out.error.code, "empty_answer")
  }
})

test("an error after content is labelled inside the stream", async () => {
  const { shim } = await load()
  const res = await withFetch(
    async () => new Response(answerChunk("partial ") + message({ error: "cut off" }) + endOfStream(), { status: 200 }),
    () => shim.fetch("https://ask", ask({ stream: true })),
  )
  assert.equal(res.status, 200)
  const chunks = await readStream(res)
  assert.ok(chunks.some((c) => c.error?.code === "midstream_error"))
  assert.equal(chunks.map((c) => c.choices?.[0]?.delta?.content || "").join(""), "partial ")
})

test("a network failure is reported as one", async () => {
  const { shim } = await load()
  const res = await withFetch(
    async () => {
      throw new Error("ECONNREFUSED")
    },
    () => shim.fetch("https://ask", ask()),
  )
  assert.equal(res.status, 502)
  const out = await res.json()
  assert.equal(out.error.code, "network")
  assert.match(out.error.message, /ECONNREFUSED/)
})

test("the sign-in page label and provider config come from the plugin", async () => {
  const { plugin } = await load()
  const cfg = { provider: {} }
  await plugin.config(cfg)
  assert.equal(cfg.provider.perplexity.name, "Perplexity Pro")
  assert.equal(cfg.provider.perplexity.models.sonnet.id, "claude50sonnet")
  // Max-only models stay hidden on the Pro tier.
  assert.equal(cfg.provider.perplexity.models.opus, undefined)
  assert.equal(plugin.auth.methods[0].label, "Paste a session cookie")
})

test("the same plugin speaks Chinese when asked", async () => {
  const plugin = await server({ client: CLIENT }, { tier: "pro", locale: "zh" })
  assert.equal(plugin.auth.methods[0].label, "粘贴 Session Cookie")
})

test("quota windows are the counters Perplexity returned, with no invented span", async () => {
  const { plugin } = await load()
  const usage = await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          remaining_pro: 7,
          remaining_research: 2,
          remaining_labs: 0,
          remaining_agentic_research: 4,
          free_queries: { available: true },
        }),
        { status: 200 },
      ),
    () => plugin.auth.usage(() => ({ key: "cookie-value", metadata: { email: "me@example.com", tier: "pro" } })),
  )
  assert.equal(usage.plan, "Pro")
  assert.equal(usage.user, "me@example.com")
  const byName = Object.fromEntries(usage.windows.map((w) => [w.name, w]))
  assert.equal(byName["Pro Search"].balance, 7)
  assert.equal(byName["Deep Research"].balance, 2)
  assert.equal(byName["Labs"].balance, 0)
  assert.equal(byName["Agentic Research"].balance, 4)
  assert.ok(byName["Free quick search"])
  for (const w of usage.windows) assert.equal(w.span, undefined)
  assert.match(byName["Pro Search"].display, /7/)
})

test("a failed quota read says so instead of showing a fake balance", async () => {
  const { plugin } = await load()
  const usage = await withFetch(
    async () => new Response("nope", { status: 500 }),
    () => plugin.auth.usage(() => ({ key: "cookie-value", metadata: {} })),
  )
  assert.deepEqual(usage.windows, [])
  assert.match(usage.error, /500/)
})

test("models() reports an expired cookie as a sign-in problem", async () => {
  const { plugin } = await load()
  const provider = { models: {} }
  await withFetch(
    async () => new Response("", { status: 401 }),
    async () => {
      await assert.rejects(
        () => plugin.provider.models(provider, { auth: { key: "cookie-value" } }),
        (e) => e.signIn === "expired",
      )
    },
  )
})

test("a second account does not inherit the first account's thread", async () => {
  const plugin = await server({ client: CLIENT }, { tier: "pro", locale: "en" })
  const sent = []
  const upstream = async (url, init) => {
    sent.push(JSON.parse(init.body))
    return new Response(answerChunk("ok.", "DONE") + endOfStream(), { status: 200 })
  }
  const alice = await plugin.auth.loader(() => ({ key: "k-a", accountId: "alice@example.com", metadata: { email: "alice@example.com" } }))
  const bob = await plugin.auth.loader(() => ({ key: "k-b", accountId: "bob@example.com", metadata: { email: "bob@example.com" } }))
  await withFetch(upstream, () => alice.fetch("https://ask", ask()))
  await withFetch(upstream, () => bob.fetch("https://ask", ask()))
  assert.equal(sent[0].params.last_backend_uuid, null)
  assert.equal(sent[1].params.last_backend_uuid, null, "bob never sees alice's backend uuid")
})

test("the same account continues its thread", async () => {
  const plugin = await server({ client: CLIENT }, { tier: "pro", locale: "en" })
  const sent = []
  const upstream = async (url, init) => {
    sent.push(JSON.parse(init.body))
    return new Response(answerChunk("ok.", "DONE") + endOfStream(), { status: 200 })
  }
  const auth = () => ({ key: "k-a", accountId: "a@example.com", metadata: { email: "a@example.com" } })
  const shim = await plugin.auth.loader(auth)
  await withFetch(upstream, () => shim.fetch("https://ask", ask()))
  await withFetch(upstream, () =>
    shim.fetch("https://ask", body({
      model: "pplx_pro",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "second" },
      ],
    })),
  )
  assert.equal(sent[1].params.last_backend_uuid, "b-uuid")
})

test("the visitor id is stable and the user id comes from the account", async () => {
  const plugin = await server({ client: CLIENT }, { tier: "pro", locale: "en" })
  const sent = []
  const upstream = async (url, init) => {
    sent.push(JSON.parse(init.body))
    return new Response(answerChunk("ok.", "DONE") + endOfStream(), { status: 200 })
  }
  const meta = { email: "a@example.com", userId: "user-123", visitorId: "visit-456" }
  const shim = await plugin.auth.loader(() => ({ key: "k", accountId: meta.email, metadata: meta }))
  await withFetch(upstream, () => shim.fetch("https://ask", ask()))
  await withFetch(upstream, () => shim.fetch("https://ask", ask()))
  assert.equal(sent[0].params.visitor_id, "visit-456")
  assert.equal(sent[1].params.visitor_id, "visit-456", "same visitor on every request")
  assert.equal(sent[0].params.user_nextauth_id, "user-123")
})

test("an account without a stored id still gets a stable pair", async () => {
  const plugin = await server({ client: CLIENT }, { tier: "pro", locale: "en" })
  const sent = []
  const upstream = async (url, init) => {
    sent.push(JSON.parse(init.body))
    return new Response(answerChunk("ok.", "DONE") + endOfStream(), { status: 200 })
  }
  const shim = await plugin.auth.loader(() => ({ key: "k", accountId: "z@example.com", metadata: { email: "z@example.com" } }))
  await withFetch(upstream, () => shim.fetch("https://ask", ask()))
  await withFetch(upstream, () => shim.fetch("https://ask", ask()))
  assert.equal(sent[0].params.visitor_id, sent[1].params.visitor_id)
  assert.equal(sent[0].params.user_nextauth_id, sent[1].params.user_nextauth_id)
})

test("cancelling the client stream stops the upstream read", async () => {
  const { shim } = await load()
  let upstreamCancelled = false
  const enc = new TextEncoder()
  const upstreamBody = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(answerChunk("first token.", "DONE")))
    },
    cancel() {
      upstreamCancelled = true
    },
  })
  const res = await withFetch(
    async () => new Response(upstreamBody, { status: 200 }),
    () => shim.fetch("https://ask", ask({ stream: true })),
  )
  assert.equal(res.status, 200)
  await res.body.cancel()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(upstreamCancelled, true, "the upstream response was released")
})
