// An enterprise custom model's own endpoint (plugins#1366, 0.2.53). Trae CN
// 3.4.22's client sends an enterprise model whose detail carries a
// custom_config (provider custom_openai_compatible, auth_type 0) straight
// to its base_url, an OpenAI chat/completions URL, with the detail's ak and
// max_tokens. The reporter's captures there answered 8274 and 12182
// completion tokens with "stop"; llm_utils_chat cuts the same model at 2000
// a round. Anything else goes through llm_utils_chat as before.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, json, signedIn, sse } from "./fake.mjs"

let f
afterEach(() => {
  f?.close()
  delete process.env.MAGPIE_TRAE_DEBUG
  _internal.directRefused.clear()
})

const AK = "sk-ent-SECRET-0123456789abcdef"
const PATH = "/erp/v1/chat/completions"
// the reporter's model as their list gives it, its custom_config's base_url
// pointed at the fake
const entOf = (origin, cfg = {}, detail = {}) => ({
  config_name: "AI/deekseek-v4.1-flash", usage: "chat_completion", config_source: 2, is_preset: false, is_custom_model: true, status: true,
  display_config: { display_name: "deekseek-v4.1-flash", is_custom_model: true },
  model_detail_list: [{ model_name: "deekseek-v4.1-flash", provider: "custom_openai_compatible", max_tokens: 32768,
    custom_config: { base_url: origin + PATH, ak: AK, auth_type: 0, status: true, client_connect: false, custom_model_id: "cm-1", is_custom_base_url: true, ...cfg }, ...detail }],
})

// an OpenAI stream: data lines, then [DONE]
const chunks = (xs) => new Response(xs.map((x) => `data: ${JSON.stringify(x)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
const delta = (d, finish = null) => ({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: d, finish_reason: finish }] })

// a long reply: 600 pieces, well past the 2000 tokens llm_utils_chat lets out
const PIECES = Array.from({ length: 600 }, (_, i) => `LINE-${String(i).padStart(3, "0")} `)
const LONG = [delta({ role: "assistant", content: "" }), ...PIECES.map((p) => delta({ content: p })), delta({}, "stop"),
  { id: "c1", choices: [], usage: { prompt_tokens: 900, completion_tokens: 8274, total_tokens: 9174 } }]

const TRAE_REPLY = [["output", { response: "via trae" }], ["done", { finish_reason: "stop", usage: { prompt_tokens: 5, completion_tokens: 2 } }]]

async function setup(entry, direct = () => chunks(LONG)) {
  f?.close()
  f = fakeTrae()
  const e = typeof entry === "function" ? entry(f.origin) : entry
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [{ function: "chat_v3", config_info_list: [e] }] }))
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse(TRAE_REPLY))
  f.route("POST " + PATH, direct)
  const hooks = await TraeCNAuthPlugin({ client: {} })
  await hooks.provider.models({ models: {} }, { auth: signedIn() })
  return hooks.auth.loader(async () => signedIn())
}

const TOOLS = [{ type: "function", function: { name: "read", parameters: { type: "object" } } }]
const ask = (opts, extra = {}) => opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({
  model: "AI/deekseek-v4.1-flash", messages: [{ role: "user", content: "write a lot" }], tools: TOOLS, ...extra }) })
const directs = () => f.seen.filter((r) => r.path === PATH)
const traes = () => f.seen.filter((r) => r.path === "/api/agent/v3/llm_utils_chat")

// the stream's text, finish and usage
async function streamed(res) {
  let text = ""
  let finish = null
  let usage = null
  const calls = new Map()
  for (const line of (await res.text()).split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue
    const v = JSON.parse(line.slice(6))
    if (v.usage) usage = v.usage
    for (const c of v.choices ?? []) {
      if (c.delta?.content) text += c.delta.content
      for (const tc of c.delta?.tool_calls ?? []) {
        const x = calls.get(tc.index) ?? { id: "", name: "", arguments: "" }
        if (tc.id) x.id = tc.id
        if (tc.function?.name) x.name = tc.function.name
        x.arguments += tc.function?.arguments ?? ""
        calls.set(tc.index, x)
      }
      if (c.finish_reason) finish = c.finish_reason
    }
  }
  return { text, finish, usage, calls: [...calls.values()] }
}

test("an enterprise custom model goes to its own base_url as Trae's client sends it, and a long reply comes back whole", async () => {
  for (const stream of [false, true]) {
    const opts = await setup((o) => entOf(o))
    const res = await ask(opts, { stream, max_tokens: 64000, temperature: 0.2 })
    expect(res.status).toBe(200)
    const want = PIECES.join("")
    if (stream) {
      const got = await streamed(res)
      expect(got.text).toBe(want)
      expect(got.finish).toBe("stop")
      expect(got.usage.completion_tokens).toBe(8274)
    } else {
      const body = await res.json()
      expect(body.choices[0].message.content).toBe(want)
      expect(body.choices[0].finish_reason).toBe("stop")
      expect(body.usage.completion_tokens).toBe(8274)
    }
    expect(traes().length).toBe(0)
    // the tenant's own endpoint books nothing at Trae: no settlement is read
    expect(f.seen.filter((r) => r.path === "/api/v1/commercial/get_session_usage").length).toBe(0)
    const [r] = directs()
    expect(directs().length).toBe(1)
    expect(r.headers.get("authorization")).toBe("Bearer " + AK)
    expect(r.headers.get("x-model-provider")).toBe("custom_openai_compatible")
    expect(r.headers.get("user-agent")).toBe("hertz")
    expect(r.headers.get("x-request-id")).toMatch(/^req_[0-9a-f-]{36}$/)
    // nothing of the IDE's own sign-in goes to the enterprise's endpoint
    expect([...r.headers.values()].join(" ")).not.toContain("jwt-1")
    // the detail's model name and max_tokens (64000 asked, 32768 the most)
    expect(r.json).toMatchObject({ model: "deekseek-v4.1-flash", max_tokens: 32768, stream: true, stream_options: { include_usage: true },
      messages: [{ role: "user", content: "write a lot" }], tools: TOOLS, temperature: 0.2 })
  }
})

test("with no output limit asked, the detail's max_tokens is sent; a smaller one asked is kept", async () => {
  let opts = await setup((o) => entOf(o))
  await (await ask(opts)).text()
  expect(directs()[0].json.max_tokens).toBe(32768)
  opts = await setup((o) => entOf(o))
  await (await ask(opts, { max_completion_tokens: 1000 })).text()
  expect(directs()[0].json.max_tokens).toBe(1000)
})

test("tool calls come back in OpenAI form, gathered by index", async () => {
  const calling = [
    delta({ role: "assistant", content: "reading" }),
    delta({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read", arguments: "" } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '"src/a.go"}' } }] }),
    delta({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "read", arguments: '{"path":"b"}' } }] }),
    delta({}, "tool_calls"),
    { id: "c1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
  ]
  for (const stream of [false, true]) {
    const opts = await setup((o) => entOf(o), () => chunks(calling))
    const res = await ask(opts, { stream })
    const want = [{ id: "call_a", name: "read", arguments: '{"path":"src/a.go"}' }, { id: "call_b", name: "read", arguments: '{"path":"b"}' }]
    if (stream) {
      const got = await streamed(res)
      expect(got.calls).toEqual(want)
      expect(got.finish).toBe("tool_calls")
    } else {
      const m = (await res.json()).choices[0]
      expect(m.finish_reason).toBe("tool_calls")
      expect(m.message.tool_calls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }))).toEqual(want)
    }
  }
})

test("an endpoint that answers one whole completion (not a stream) is read too", async () => {
  const opts = await setup((o) => entOf(o), () => json({ id: "c1", object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "whole", reasoning_content: "thought" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }))
  const body = await (await ask(opts)).json()
  expect(body.choices[0].message.content).toBe("whole")
  expect(body.usage.completion_tokens).toBe(4)
})

test("a reply the endpoint ends for length says length", async () => {
  const opts = await setup((o) => entOf(o), () => chunks([delta({ content: "part" }), delta({}, "length")]))
  const body = await (await ask(opts, { max_tokens: 10 })).json()
  expect(body.choices[0].finish_reason).toBe("length")
})

// anything short of what Trae's client needs to ask the endpoint itself
// goes through llm_utils_chat as before
const NOT_DIRECT = {
  "no custom_config": (o) => { const e = entOf(o); delete e.model_detail_list[0].custom_config; return e },
  "auth_type 1": (o) => entOf(o, { auth_type: 1 }),
  "no auth_type": (o) => entOf(o, { auth_type: undefined }),
  "custom_config off": (o) => entOf(o, { status: false }),
  "no ak": (o) => entOf(o, { ak: "" }),
  "no base_url": (o) => entOf(o, { base_url: "" }),
  "a base_url that isn't chat/completions": (o) => entOf(o, { base_url: o + "/erp/v1" }),
  "another provider": (o) => entOf(o, {}, { provider: "volcengine" }),
  "a preset": (o) => ({ ...entOf(o), config_source: 1, is_preset: true, is_custom_model: false, display_config: { display_name: "x" } }),
}
for (const [name, entry] of Object.entries(NOT_DIRECT)) {
  test(`${name}: llm_utils_chat as before`, async () => {
    const opts = await setup(entry)
    const body = await (await ask(opts)).json()
    expect(body.choices[0].message.content).toBe("via trae")
    expect(directs().length).toBe(0)
    expect(traes().length).toBe(1)
  })
}

test("an endpoint that turns the ak away falls back to llm_utils_chat, and isn't asked again with that ak", async () => {
  const opts = await setup((o) => entOf(o), () => json({ error: { message: "invalid api key", code: "invalid_api_key" } }, 401))
  for (let i = 0; i < 2; i++) {
    const body = await (await ask(opts)).json()
    expect(body.choices[0].message.content).toBe("via trae")
  }
  expect(directs().length).toBe(1)
  expect(traes().length).toBe(2)
})

test("an endpoint that fails otherwise (500, an error in the stream, an HTML page) falls back, and is asked again next time", async () => {
  const answers = [
    () => json({ error: { message: "upstream down" } }, 500),
    () => chunks([{ error: { message: "model overloaded", code: 503 } }]),
    () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
  ]
  let n = 0
  const opts = await setup((o) => entOf(o), () => answers[n++]())
  for (let i = 0; i < answers.length; i++) {
    const body = await (await ask(opts)).json()
    expect(body.choices[0].message.content).toBe("via trae")
  }
  expect(directs().length).toBe(3)
  expect(traes().length).toBe(3)
})

test("MAGPIE_TRAE_DEBUG says the endpoint asked and the ak's length, never the ak or the words", async () => {
  process.env.MAGPIE_TRAE_DEBUG = "1"
  const lines = []
  const was = console.error
  console.error = (...xs) => lines.push(xs.join(" "))
  try {
    for (const stream of [false, true]) {
      const opts = await setup((o) => entOf(o))
      await (await ask(opts, { stream })).text()
    }
    // and one the endpoint refuses
    const opts = await setup((o) => entOf(o), () => json({ error: { message: "invalid api key" } }, 401))
    await (await ask(opts)).text()
  } finally {
    console.error = was
  }
  const ours = lines.filter((l) => l.startsWith("trae debug:"))
  const asked = ours.filter((l) => l.includes(" direct "))
  expect(asked.length).toBe(3)
  expect(asked[0]).toContain(`POST ${f.origin.replace(/:\d+$/, "")}`)
  expect(asked[0]).toContain(`${PATH} direct ak_chars=${AK.length} {`)
  expect(ours.some((l) => /trae debug: reply \S+ trae_finish="" usage=\{"prompt_tokens":900,"completion_tokens":8274/.test(l) && l.endsWith("finish_sent=stop"))).toBe(true)
  for (const l of lines) {
    expect(l).not.toContain(AK)
    expect(l).not.toContain("SECRET")
    expect(l).not.toContain("write a lot")
    expect(l).not.toContain("jwt-1")
  }
})

test("directOf: the detail's endpoint, or null", () => {
  const e = entOf("https://tokenerpgw.example.com")
  expect(_internal.directOf(e)).toEqual({ url: "https://tokenerpgw.example.com" + PATH, ak: AK, provider: "custom_openai_compatible", model: "deekseek-v4.1-flash", most: 32768 })
  expect(_internal.directOf(entOf("ftp://x"))).toBe(null)
  expect(_internal.directOf(entOf("https://x", { auth_type: "0" }))?.ak).toBe(AK)
  expect(_internal.directOf(null)).toBe(null)
})
