// MAGPIE_TRAE_DEBUG (plugins#1366): the request the plugin sends Trae and how
// Trae's answer ended, written to stderr (magpie's app.log) only when asked,
// and never the sign-in or the user's words.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin } from "./index.mjs"
import { fakeTrae, json, signedIn, sse } from "./fake.mjs"

let f
afterEach(() => {
  f?.close()
  delete process.env.MAGPIE_TRAE_DEBUG
})

// the reporter's enterprise model, as the list gives it
const ent = { config_name: "AI/deekseek-v4.1-flash", usage: "chat_completion", config_source: 2, is_preset: false, is_custom_model: true, status: true,
  display_config: { display_name: "deekseek-v4.1-flash", is_custom_model: true },
  model_detail_list: [{ model_name: "deekseek-v4.1-flash", provider: "AI", max_tokens: 32768 }] }
const SECRET = "LINE-001 the user's own words"

const LONG = [["output", { response: "LINE-001" }], ["done", { usage: { prompt_tokens: 80, completion_tokens: 2000 } }]]
const REST = [["output", { response: "LINE-002" }], ["done", { finish_reason: "stop", usage: { prompt_tokens: 90, completion_tokens: 50 } }]]

async function asked(extra = {}, reply = LONG) {
  f?.close()
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [{ function: "chat_v3", config_info_list: [ent] }] }))
  // the next ask of a cut reply (continued) is answered short and whole
  let n = 0
  f.route("POST /api/agent/v3/llm_utils_chat", () => (n++ === 0 ? sse(reply) : sse(REST)))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  await hooks.provider.models({ models: {} }, { auth: signedIn() })
  const opts = await hooks.auth.loader(async () => signedIn())
  const lines = []
  const was = console.error
  console.error = (...xs) => lines.push(xs.join(" "))
  try {
    const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: ent.config_name, max_tokens: 32768, messages: [{ role: "user", content: SECRET }], tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }], ...extra }) })
    await res.text()
  } finally {
    console.error = was
  }
  return lines.filter((l) => l.startsWith("trae debug:"))
}

for (const stream of [false, true]) {
  test(`MAGPIE_TRAE_DEBUG writes the request sent and the reply's end, without the sign-in or the words (stream ${stream})`, async () => {
    process.env.MAGPIE_TRAE_DEBUG = "1"
    const lines = await asked({ stream })
    // the cut reply's ask, then the ask that goes on from it
    expect(lines.length).toBe(6)
    const [req, status, end, req2, status2, end2] = lines
    const sentAt = f.seen.filter((r) => r.path === "/api/agent/v3/llm_utils_chat").at(-2)
    // the id the line names is the one the request carried
    const rid = req.split(" ")[3]
    expect(sentAt.headers.get("x-request-id")).toContain(rid)
    expect(req).toStartWith(`trae debug: request ${rid} POST ${f.origin}/api/agent/v3/llm_utils_chat {`)
    const body = JSON.parse(req.slice(req.indexOf("{")))
    expect(body.max_tokens).toBe(32768)
    expect(body.enterprise_custom_hyper_params).toEqual(sentAt.json.enterprise_custom_hyper_params)
    expect(body.messages).toEqual([{ role: "user", chars: JSON.stringify(sentAt.json.messages[0].content).length }])
    expect(body.tools).toEqual(["read"])
    expect(status).toStartWith(`trae debug: request ${rid} answered 200 text/event-stream`)
    expect(end).toStartWith(`trae debug: reply ${rid} trae_finish="" usage={"prompt_tokens":80,"completion_tokens":2000,`)
    expect(end).toContain("finish_sent=length")
    const rid2 = req2.split(" ")[3]
    expect(rid2).not.toBe(rid)
    expect(f.seen.filter((r) => r.path === "/api/agent/v3/llm_utils_chat").at(-1).headers.get("x-request-id")).toContain(rid2)
    expect(JSON.parse(req2.slice(req2.indexOf("{"))).max_tokens).toBe(32768 - 2000)
    expect(status2).toStartWith(`trae debug: request ${rid2} answered 200 text/event-stream`)
    // the ask that goes on says which round it is and how long Trae took to answer it
    expect(status2).toMatch(/ round=2 wait_ms=\d+$/)
    expect(end2).toStartWith(`trae debug: reply ${rid2} `)
    expect(end2).toContain("finish_sent=stop")
    for (const l of lines) {
      expect(l).not.toContain("jwt-1")
      expect(l).not.toContain(SECRET)
    }
  })
}

test("without MAGPIE_TRAE_DEBUG nothing is written", async () => {
  expect(await asked()).toEqual([])
  process.env.MAGPIE_TRAE_DEBUG = "0"
  expect(await asked()).toEqual([])
})

// the reporter's case (0.2.47): a call Trae cut at 2000 said
// finish_sent=tool_calls; the line says what was sent instead
test("MAGPIE_TRAE_DEBUG says a call cut at Trae's 2000 went out as no call, the reply as length", async () => {
  process.env.MAGPIE_TRAE_DEBUG = "1"
  for (const stream of [false, true]) {
    const lines = await asked({ stream }, [
      ["output", { tool_calls: [{ id: "call_r1", index: 0, function: { name: "read", arguments: '{"path":"src/' } }] }],
      ["done", { usage: { prompt_tokens: 80, completion_tokens: 2000 } }],
    ])
    expect(lines.at(-1)).toEndWith("calls=1 cut_calls=1 finish_sent=length")
  }
})
