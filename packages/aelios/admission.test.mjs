import { afterEach, beforeEach, expect, test } from "bun:test"
import { flush, onRequest, onResponse, reset } from "./aelios.hooks.mjs"

const originalFetch = globalThis.fetch
const originalNow = Date.now
let calls, metadata
const identity = (slug = "default", mainModels = ["main-*"]) => ({ slug, name: slug, mainModels })
const bodyFor = (protocol, tool = false) => protocol === "responses"
  ? { model: "main-1", input: tool ? [{ type: "function_call_output", call_id: "c", output: "result" }] : "private user dialogue" }
  : { model: "main-1", messages: tool
    ? protocol === "anthropic"
      ? [{ role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "result" }] }]
      : [{ role: "tool", tool_call_id: "c", content: "result" }]
    : [{ role: "user", content: "private user dialogue" }] }
function context(protocol = "chat", options = {}, model = "main-1") {
  const reports = []
  return { protocol, model, agent: "codex", origin: "local", state: {}, success: true,
    options: { serverUrl: "https://aelios.example", apiKey: "synthetic-key", record: true, ...options },
    report: code => reports.push(code), reports }
}
const getCalls = () => calls.filter(c => c.init.method === "GET")
const postCalls = () => calls.filter(c => c.init.method === "POST")
async function turn(c, body = bodyFor(c.protocol)) {
  await onRequest(body, c)
  onResponse({ choices: [{ message: { content: "answer" } }] }, c)
  await flush()
}
beforeEach(() => {
  reset()
  calls = []
  metadata = () => Response.json({ identities: [identity()] })
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init.body && JSON.parse(init.body) })
    if (init.method === "GET") return metadata(url, init)
    return Response.json(String(url).endsWith("recall") ? { memory: "empty" } : { recorded: true })
  }
})
afterEach(() => { globalThis.fetch = originalFetch; Date.now = originalNow; reset() })

for (const protocol of ["chat", "anthropic", "responses"]) {
  for (const mode of ["normal", "recordOnly", "tool"]) {
    test(`${protocol} ${mode}: unbound sends metadata only and never records`, async () => {
      const c = context(protocol, mode === "recordOnly" ? { recall: false } : {}, "unbound-model")
      await turn(c, bodyFor(protocol, mode === "tool"))
      expect(getCalls()).toHaveLength(1)
      expect(postCalls()).toHaveLength(0)
      expect(c.reports).toEqual(["unbound"])
      expect(c.state.aelios).toBeUndefined()
    })
    test(`${protocol} ${mode}: admitted identity is pinned for recall and record`, async () => {
      const c = context(protocol, mode === "recordOnly" ? { recall: false } : {})
      await turn(c, bodyFor(protocol, mode === "tool"))
      expect(getCalls()).toHaveLength(1)
      expect(postCalls().length).toBe(mode === "normal" ? 2 : 1)
      expect(postCalls().every(call => call.body.identity === "default")).toBe(true)
    })
  }
}

test("automatic selection uses first model match and literal anchored case-insensitive glob with basename", async () => {
  metadata = () => Response.json({ identities: [identity("wrong", ["main"]), identity("first", ["MAIN.*"]), identity("second", ["*"])] })
  const c = context("chat", {}, "vendor/main.123")
  await turn(c)
  expect(postCalls().every(call => call.body.identity === "first")).toBe(true)
  reset(); calls.length = 0
  metadata = () => Response.json({ identities: [identity("literal", ["main.+"])] })
  await turn(context("chat", {}, "main.123"))
  expect(postCalls()).toHaveLength(0)
})

for (const selected of ["absent", "wrong-model"]) {
  test(`explicit identity ${selected} cannot borrow another identity's model permission`, async () => {
    metadata = () => Response.json({ identities: [identity(), identity("wrong-model", ["other-*"])] })
    const c = context("chat", { identity: selected })
    await turn(c)
    expect(postCalls()).toHaveLength(0)
    expect(c.reports).toEqual(["unbound"])
  })
}
test("configured routes select identity before metadata admission", async () => {
  metadata = () => Response.json({ identities: [identity(), identity("routed", ["main-*"])] })
  const c = context("chat", { identity: "absent", routes: [{ agents: ["codex"], models: ["main-*"], identity: "routed" }] })
  await turn(c)
  expect(postCalls().every(call => call.body.identity === "routed")).toBe(true)
  calls.length = 0; reset()
  metadata = () => Response.json({ identities: [identity()] })
  await turn(context("chat", c.options))
  expect(postCalls()).toHaveLength(0)
})

test("cache shares across selected identities but isolates server and key", async () => {
  metadata = () => Response.json({ identities: [identity(), identity("another")] })
  await turn(context())
  await turn(context("chat", { identity: "another" }))
  expect(getCalls()).toHaveLength(1)
  await turn(context("chat", { apiKey: "second-key" }))
  await turn(context("chat", { serverUrl: "https://second.example" }))
  expect(getCalls()).toHaveLength(3)
  reset()
  await turn(context())
  expect(getCalls()).toHaveLength(4)
})

test("TTL refresh failure removes cached permission and failure has short backoff", async () => {
  let now = originalNow()
  Date.now = () => now
  await turn(context())
  now += 60_001
  metadata = () => new Response(null, { status: 401 })
  calls.length = 0
  const c = context()
  await turn(c)
  await turn(context())
  expect(getCalls()).toHaveLength(1)
  expect(postCalls()).toHaveLength(0)
  expect(c.reports).toEqual(["unauthorized"])
  now += 5001
  metadata = () => Response.json({ identities: [identity()] })
  await turn(context())
  expect(getCalls()).toHaveLength(2)
  expect(postCalls()).toHaveLength(2)
})

test("concurrent admission deduplicates metadata lookup", async () => {
  let release
  metadata = () => new Promise(resolve => { release = resolve })
  const a = context(), b = context()
  const work = [onRequest(bodyFor("chat"), a), onRequest(bodyFor("chat"), b)]
  expect(getCalls()).toHaveLength(1)
  release(Response.json({ identities: [identity()] }))
  await Promise.all(work)
  expect(postCalls()).toHaveLength(2)
})

for (const [status, code] of [[401, "unauthorized"], [403, "unbound"], [404, "unavailable"], [500, "unavailable"]]) {
  test(`metadata ${status} fails closed with ${code}`, async () => {
    metadata = () => new Response(null, { status })
    const c = context()
    await turn(c)
    expect(postCalls()).toHaveLength(0)
    expect(c.reports).toEqual([code])
  })
}
for (const invalid of [null, {}, { identities: [{}] }, { identities: [identity("x", [3])] }, { identities: [ { slug: "x", mainModels: ["*"] } ] }, { identities: Array(257).fill(identity()) }]) {
  test(`malformed metadata ${JSON.stringify(invalid).slice(0, 75)} fails closed`, async () => {
    metadata = () => Response.json(invalid)
    const c = context()
    await turn(c)
    expect(postCalls()).toHaveLength(0)
    expect(c.reports).toEqual(["invalid"])
  })
}
test("metadata body has a byte limit", async () => {
  metadata = () => new Response(JSON.stringify({ padding: "x".repeat(256 * 1024), identities: [identity()] }))
  const c = context()
  await turn(c)
  expect(postCalls()).toHaveLength(0)
  expect(c.reports).toEqual(["invalid"])
})
test("metadata request authenticates GET without dialogue and refuses redirects", async () => {
  await turn(context("chat", { apiKey: "bearer existing", serverUrl: "https://aelios.example/base" }))
  const call = getCalls()[0]
  expect(call.url).toBe("https://aelios.example/base/v1/hook/identities")
  expect(call.init.headers.Authorization).toBe("bearer existing")
  expect(call.init.redirect).toBe("error")
  expect(call.init.body).toBeUndefined()
})
test("missing key sends no metadata or dialogue", async () => {
  const c = context("chat", { apiKey: undefined, apiKeyEnv: "AELIOS_ADMISSION_ABSENT_KEY" })
  await turn(c)
  expect(calls).toHaveLength(0)
  expect(c.reports).toEqual(["unauthorized"])
})
for (const stalled of ["fetch", "body"]) {
  test(`metadata deadline covers stalled ${stalled}, even if transport ignores abort`, async () => {
    let signal
    metadata = (_url, init) => {
      signal = init.signal
      return stalled === "fetch" ? new Promise(() => {}) : new Response(new ReadableStream({ start() {} }))
    }
    const c = context("chat", { requestTimeoutMs: 50 })
    const start = performance.now()
    await turn(c)
    expect(performance.now() - start).toBeLessThan(500)
    expect(signal.aborted).toBe(true)
    expect(postCalls()).toHaveLength(0)
    expect(c.reports).toEqual(["unavailable"])
  })
}
for (const recall of [true, false]) {
  test(`admission preserves Claude thinking and signatures in the actual request (recall ${recall})`, async () => {
    const body = { model: "main-1", thinking: { type: "enabled", budget_tokens: 4096 }, messages: [
      { role: "assistant", content: [
        { type: "thinking", thinking: "private reasoning", signature: "opaque-signature" },
        { type: "redacted_thinking", data: "opaque-redacted-data" },
      ] }, { role: "user", content: "private user dialogue" },
    ] }
    const original = structuredClone(body)
    await turn(context("anthropic", { recall }), body)
    expect(body).toEqual(original)
    reset(); calls.length = 0
    metadata = () => Response.json({ identities: [] })
    await turn(context("anthropic", { recall }), body)
    expect(body).toEqual(original)
    expect(postCalls()).toHaveLength(0)
  })
}

test("onResponse keeps admitted identity after cache expiry without metadata", async () => {
  const c = context("chat", { recall: false })
  await onRequest(bodyFor("chat"), c)
  Date.now = () => originalNow() + 120_000
  metadata = () => { throw new Error("must not refresh on response") }
  c.options.identity = "changed-after-admission"
  onResponse({ choices: [{ message: { content: "answer" } }] }, c)
  await flush()
  expect(getCalls()).toHaveLength(1)
  expect(postCalls()[0].body.identity).toBe("default")
})
