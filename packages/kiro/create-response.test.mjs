// plugins#842, #848: a Builder ID student account was answered 429
// USER_REQUEST_RATE_EXCEEDED on generateAssistantResponse through the
// plugin while Kiro IDE 1.4.121, 11s later on the same account, was
// answered on CreateResponse ("api=CreateResponse armSource=experiment
// callPath=main"). The IDE picks its API by an experiment Kiro's feature
// configuration names; the plugin now reads it as the IDE does and asks an
// account in the CreateResponse arm at /v1/responses, with the IDE's body,
// headers and reading of the server-sent events, all read from the IDE's
// own extension.js (agent 1.1.787).
import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import { createHash } from "node:crypto"
import { _internal } from "./index.mjs"

const { generate, timing, features, responsesBody, crRefusal } = _internal
const pauses = []
const offline = async () => {
  throw new Error("no network in tests")
}
// the fetch and pause this file gives the plugin are put back when it ends,
// so the package's other files run on their own
let realFetch, realSleep
beforeAll(() => {
  realFetch = globalThis.fetch
  realSleep = timing.sleep
  timing.sleep = async (ms) => void pauses.push(ms)
})
afterAll(() => {
  globalThis.fetch = realFetch
  timing.sleep = realSleep
})
beforeEach(() => {
  globalThis.fetch = offline
  features.clear()
  pauses.length = 0
})
afterEach(() => {
  globalThis.fetch = offline
  features.clear()
})

const PROFILE = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX"
const creds = async () => ({ token: "t", tokenType: "", idc: true, profile: PROFILE, region: "us-east-1" })
// the experiment's key, as the IDE derives it (deriveWireKey)
const KEY = createHash("sha256").update("kiro-feature-config-key-salt-3e9b1d7a" + "create_response_api").digest("hex")
const ARM = { configuration: { [KEY]: "create_response", other: "x" } }

const sse = (...events) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n",
  { status: 200, headers: { "Content-Type": "text/event-stream" } })
const lower = (h) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]))

// kiro is a fake Kiro: the feature configuration it is given, each
// /v1/responses call answered in turn, every call recorded
function kiro({ config = ARM, answers = [] } = {}) {
  const calls = []
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const call = { url, method: init.method ?? "GET", headers: lower(init.headers), body: init.body }
    calls.push(call)
    if (url.pathname === "/featureConfiguration") return typeof config === "function" ? config() : Response.json(config)
    if (url.pathname === "/v1/responses") {
      const a = answers.shift()
      return typeof a === "function" ? a() : a
    }
    if (url.pathname === "/generateAssistantResponse") return new Response(JSON.stringify({ message: "stop here" }), { status: 500 })
    throw new Error("unexpected " + url)
  }
  return calls
}

const DONE = { type: "response.completed", response: { status: "completed", usage: { "kiro:context_usage_percentage": 1, "kiro:credits": { value: 0.25, unit: "credit" } } } }
const req = (more = {}) => ({ model: "claude-haiku-5.5", system: "be brief", messages: [{ role: "user", content: "hi" }], ...more })

test("an account in the IDE's CreateResponse arm is asked at /v1/responses, with the IDE's headers", async () => {
  const calls = kiro({ answers: [sse({ type: "response.output_text.delta", delta: "hello" }, DONE)] })
  const res = await generate(creds, {}, req(), undefined, "session-1")
  expect(res.status).toBe(200)
  const out = await res.json()
  expect(out.content).toEqual([{ type: "text", text: "hello" }])
  expect(out.stop_reason).toBe("end_turn")
  expect(out.usage.credit).toBe(0.25)

  // the feature configuration, as the IDE's GetFeatureConfiguration asks it
  const [fc, chat] = calls
  expect(fc.method).toBe("GET")
  expect(fc.url.origin + fc.url.pathname).toBe("https://runtime.us-east-1.kiro.dev/featureConfiguration")
  expect(Object.fromEntries(fc.url.searchParams)).toEqual({ origin: "AI_EDITOR", version: "1.4.121" })
  expect(fc.headers["x-amzn-kiro-profile-arn"]).toBe(PROFILE)
  expect(fc.headers.authorization).toBe("Bearer t")

  expect(chat.method).toBe("POST")
  expect(chat.url.href).toBe("https://runtime.us-east-1.kiro.dev/v1/responses")
  const h = chat.headers
  expect(h["user-agent"]).toMatch(/^KiroIDE-1\.4\.121-[0-9a-f]{64}-KAS\/0\.66\.89 acp-client\/kiro-ide$/)
  expect(h.authorization).toBe("Bearer t")
  expect(h["x-amzn-kiro-origin"]).toBe("AI_EDITOR")
  expect(h["x-amzn-codewhisperer-optout"]).toBe("true")
  expect(h["x-amzn-kiro-profile"]).toBe(PROFILE)
  expect(h.tokentype).toBe("SSO_OIDC")
  expect(h["x-amzn-kiro-attempt"]).toBe("1;max=3")
  expect(h["content-type"]).toBe("application/json")
  // none of the AWS SDK's: the IDE sends CreateResponse with its own client
  for (const k of ["amz-sdk-invocation-id", "amz-sdk-request", "x-amz-user-agent", "x-amzn-kiro-agent-mode", "x-amzn-kiro-client-attribution"])
    expect(k in h).toBe(false)

  const body = JSON.parse(chat.body)
  expect(body.model).toBe("claude-haiku-5.5")
  expect(body.stream).toBe(true)
  expect(body.origin).toBe("AI_EDITOR")
  expect(body.profileArn).toBe(PROFILE)
  expect(body.metadata["kiro:agent_mode"]).toBe("vibe")
  expect(body.metadata["kiro:conversation_id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/)
  // the instructions stay at the head of the first message, as the IDE
  // sends them without its system_field_injection
  expect("instructions" in body).toBe(false)
  expect(body.input).toEqual([{ role: "user", content: "be brief\n\nhi" }])
  expect("conversationState" in body).toBe(false)
})

test("the feature configuration is read once for a sign-in and kept 15 minutes", async () => {
  const calls = kiro({ answers: [sse(DONE), sse(DONE)] })
  await generate(creds, {}, req())
  await generate(creds, {}, req())
  expect(calls.filter((c) => c.url.pathname === "/featureConfiguration")).toHaveLength(1)
  expect(calls.filter((c) => c.url.pathname === "/v1/responses")).toHaveLength(2)
})

test("an account out of the arm, or whose configuration can't be read, stays on generateAssistantResponse", async () => {
  for (const config of [{ configuration: {} }, { configuration: { [KEY]: "generate_assistant_response" } },
    () => new Response("{}", { status: 500 }), () => new Response("not json")]) {
    features.clear()
    const calls = kiro({ config })
    await generate(creds, {}, req())
    expect(calls.map((c) => c.url.pathname)).toEqual(["/featureConfiguration", "/generateAssistantResponse"])
  }
})

test("tools, calls, results and images go as the IDE's input items", () => {
  const body = responsesBody({
    profileArn: PROFILE,
    conversationState: {
      conversationId: "c-1",
      history: [
        { userInputMessage: { content: "read it", modelId: "m", origin: "AI_EDITOR" } },
        { assistantResponseMessage: { content: "ok", toolUses: [{ name: "Read", toolUseId: "tu1", input: { path: "a" } }] } },
      ],
      currentMessage: {
        userInputMessage: {
          content: "and this",
          modelId: "m",
          origin: "AI_EDITOR",
          images: [{ format: "png", source: { bytes: "QUJD" } }],
          userInputMessageContext: {
            toolResults: [{ toolUseId: "tu1", status: "success", content: [{ text: "one" }, { text: "two" }] }],
            tools: [{ toolSpecification: { name: "Read", description: "reads", inputSchema: { json: { type: "object", properties: {} } } } }, { cachePoint: { type: "default" } }],
          },
        },
      },
    },
    additionalModelRequestFields: { thinking: { type: "adaptive" }, output_config: { effort: "high" } },
  })
  expect(body.input).toEqual([
    { role: "user", content: "read it" },
    { role: "assistant", content: "ok" },
    { type: "function_call", call_id: "tu1", name: "Read", arguments: '{"path":"a"}' },
    { type: "function_call_output", call_id: "tu1", output: "one\ntwo" },
    { role: "user", content: [{ type: "input_text", text: "and this" }, { type: "input_image", image_url: "data:image/png;base64,QUJD" }] },
  ])
  expect(body.tools).toEqual([{ type: "function", name: "Read", description: "reads", parameters: { type: "object", properties: {} } }])
  expect(body.reasoning).toEqual({ type: "adaptive", effort: "high" })
  expect(body.metadata).toEqual({ "kiro:agent_mode": "vibe", "kiro:conversation_id": "c-1" })
})

test("a call in the server-sent events is a tool_use, its arguments in pieces or whole", async () => {
  kiro({
    answers: [
      sse(
        { type: "response.output_text.delta", delta: "let me look" },
        { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "Read", arguments: "" } },
        { type: "response.function_call_arguments.delta", delta: '{"path":' },
        { type: "response.function_call_arguments.delta", delta: '"a"}' },
        { type: "response.function_call_arguments.done" },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", arguments: '{"path":"a"}' } },
        { type: "response.output_item.added", item: { type: "function_call", call_id: "c2", name: "Read", arguments: "" } },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "c2", arguments: '{"path":"b"}' } },
        DONE,
      ),
    ],
  })
  const out = await (await generate(creds, {}, req({ tools: [{ name: "Read", input_schema: { type: "object" } }] }))).json()
  expect(out.content).toEqual([
    { type: "text", text: "let me look" },
    { type: "tool_use", id: "c1", name: "Read", input: { path: "a" } },
    { type: "tool_use", id: "c2", name: "Read", input: { path: "b" } },
  ])
  expect(out.stop_reason).toBe("tool_use")
})

test("reasoning and its signature come back as a thinking block; an incomplete reply says why it stopped", async () => {
  kiro({
    answers: [
      sse(
        { type: "response.reasoning_text.delta", delta: "hmm" },
        { type: "response.output_item.done", item: { type: "reasoning", encrypted_content: JSON.stringify({ reasoningText: { text: "hmm", signature: "SIG" } }) } },
        { type: "response.output_text.delta", delta: "cut" },
        { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: {} } },
      ),
    ],
  })
  const out = await (await generate(creds, {}, req())).json()
  expect(out.content[0]).toMatchObject({ type: "thinking", thinking: "hmm" })
  expect(_internal.unsealReasoning(out.content[0].signature, _internal.reasoningScope({}, await creds(), req().model))).toEqual({ reasoningText: { text: "hmm", signature: "SIG" } })
  expect(out.content[1]).toEqual({ type: "text", text: "cut" })
  expect(out.stop_reason).toBe("max_tokens")
})

test("a stream is passed on as Messages' events", async () => {
  kiro({ answers: [sse({ type: "response.output_text.delta", delta: "hel" }, { type: "response.output_text.delta", delta: "lo" }, DONE)] })
  const res = await generate(creds, {}, req({ stream: true }))
  expect(res.headers.get("Content-Type")).toBe("text/event-stream")
  const text = await res.text()
  expect(text).toContain('"text_delta","text":"hel"')
  expect(text).toContain('"text_delta","text":"lo"')
  expect(text).toContain("message_stop")
})

test("a CreateResponse throttle is waited out and tried again as the IDE does, the last one passed on", async () => {
  const limited = () => new Response(JSON.stringify({ error: { message: "Too many requests", type: "too_many_requests", code: "rate_limit_exceeded" } }), { status: 429 })
  const calls = kiro({ answers: [limited, limited, limited] })
  const res = await generate(creds, {}, req(), undefined)
  const tries = calls.filter((c) => c.url.pathname === "/v1/responses")
  expect(tries.map((c) => c.headers["x-amzn-kiro-attempt"])).toEqual(["1;max=3", "2;max=3", "3;max=3"])
  expect(pauses).toHaveLength(2)
  expect(res.status).toBe(429)
  const msg = (await res.json()).error.message
  expect(msg).toContain("USER_REQUEST_RATE_EXCEEDED")
  expect(msg).toContain("Too many requests")
})

test("a throttle that clears on the next try is answered", async () => {
  const limited = () => new Response(JSON.stringify({ error: { message: "Too many requests", code: "rate_limit_exceeded" } }), { status: 429, headers: { "x-amzn-kiro-ratelimit-retry-after": "1500" } })
  kiro({ answers: [limited, sse({ type: "response.output_text.delta", delta: "ok" }, DONE)] })
  const res = await generate(creds, {}, req())
  expect(res.status).toBe(200)
  expect(pauses).toEqual([1500])
})

test("an error in the stream before any answer is a status magpie moves on from", async () => {
  kiro({ answers: [sse({ type: "error", error: { type: "too_many_requests", code: "rate_limit_exceeded", message: "slow down" } })] })
  let res = await generate(creds, {}, req())
  expect(res.status).toBe(429)
  expect((await res.json()).error.message).toContain("USER_REQUEST_RATE_EXCEEDED")

  kiro({ answers: [sse({ type: "response.failed", response: { error: { code: "context_length_exceeded", message: "Input is too long." } } })] })
  res = await generate(creds, {}, req())
  expect(res.status).toBe(400)
  expect((await res.json()).error.message).toContain("CONTENT_LENGTH_EXCEEDS_THRESHOLD")
})

test("CreateResponse's refusals read as generateAssistantResponse's", () => {
  expect(JSON.parse(crRefusal(429, JSON.stringify({ error: { message: "m", code: "rate_limit_exceeded" } })))).toEqual({ message: "m", reason: "USER_REQUEST_RATE_EXCEEDED" })
  expect(JSON.parse(crRefusal(429, JSON.stringify({ message: "m", reason: "kiro:monthly_request_count", retryAfterMilliseconds: 10 }))))
    .toEqual({ message: "m", reason: "MONTHLY_REQUEST_COUNT", retryAfterMilliseconds: 10 })
  expect(JSON.parse(crRefusal(413, "too big"))).toEqual({ message: "too big", reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" })
  expect(JSON.parse(crRefusal(500, ""))).toEqual({ message: "CreateResponse HTTP 500" })
})
