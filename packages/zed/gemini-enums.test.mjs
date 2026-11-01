// Zed's cloud parses a Google request with its own serde enums (zed
// crates/google_ai): ThinkingLevel UPPERCASE only, FunctionCallingMode
// lowercase only. A thinking budget reached it as thinkingLevel "low" and was
// answered 400 "failed to parse Google AI request: unknown variant `low`,
// expected one of `MINIMAL`, `LOW`, `MEDIUM`, `HIGH`" (#215, iron-water).
// Zed's /models then came to list a Gemini model's efforts uppercase, so its
// variants were keyed LOW/MEDIUM/HIGH and hosts that map efforts by key found
// none (#215, Yezike-yyy). A variant stays as @ai-sdk/google takes it
// (lowercase); only the wire is uppercase (ump45nose, #587).
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.tokens.clear()
})

const s = { userId: "4242", access: "plain-access", systemId: "", org: "org-me", plan: "zed_pro", who: "octo" }

// supported_effort_levels as Zed's /models lists them on a Student plan on
// 2026-11-01, byte for byte from #215 (gemini-3.5-flash's list was cut off
// after LOW there).
const LISTED = {
  "gemini-4-argon": `[{"name":"Low","value":"LOW"},{"name":"Medium","value":"MEDIUM","is_default":true},{"name":"High","value":"HIGH"}]`,
  "gemini-3.1-pro-preview": `[{"name":"Low","value":"LOW"},{"name":"Medium","value":"MEDIUM"},{"name":"High","value":"HIGH","is_default":true}]`,
  "gemini-3.8-flash": `[{"name":"Low","value":"LOW"},{"name":"Medium","value":"MEDIUM","is_default":true},{"name":"High","value":"HIGH"}]`,
  "gemini-3.5-flash": `[{"name":"Minimal","value":"MINIMAL"},{"name":"Low","value":"LOW"}]`,
}
const listed = (id) => ({ provider: "google", id, supports_thinking: true, supported_effort_levels: JSON.parse(LISTED[id]) })

// @ai-sdk/google's providerOptions.google.thinkingLevel:
// z.enum(['minimal','low','medium','high']) (google-language-model-options.ts)
const AI_SDK_LEVELS = ["minimal", "low", "medium", "high"]

test("a Gemini model Zed lists with uppercase efforts declares lowercase variants", () => {
  for (const [id, want] of [
    ["gemini-4-argon", ["low", "medium", "high"]],
    ["gemini-3.1-pro-preview", ["low", "medium", "high"]],
    ["gemini-3.8-flash", ["low", "medium", "high"]],
    ["gemini-3.5-flash", ["minimal", "low"]],
  ]) {
    const e = _internal.entry(listed(id))
    expect(e.reasoning).toBe(true)
    expect(Object.keys(e.variants)).toEqual(want)
    for (const k of want) {
      expect(e.variants[k]).toEqual({ thinkingConfig: { includeThoughts: true, thinkingLevel: k } })
      expect(AI_SDK_LEVELS).toContain(e.variants[k].thinkingConfig.thinkingLevel)
    }
    // OpenCode's provider.models hands on the same variants
    expect(Object.keys(_internal.model(listed(id)).variants)).toEqual(want)
  }
})

test("lowercase efforts, as Zed listed them before, are unchanged; a doubled one is declared once", () => {
  const e = _internal.entry({ provider: "google", id: "gemini-3.8-flash", supports_thinking: true, supported_effort_levels: [{ value: "low" }, { value: "medium" }, { value: "high" }] })
  expect(Object.keys(e.variants)).toEqual(["low", "medium", "high"])
  expect(e.variants.high.thinkingConfig.thinkingLevel).toBe("high")
  const d = _internal.entry({ provider: "google", id: "g", supported_effort_levels: [{ value: "LOW" }, { value: "low" }, { value: "" }, {}, null] })
  expect(Object.keys(d.variants)).toEqual(["low"])
})

test("another vendor's uppercase effort is keyed and given lowercase too", () => {
  const a = _internal.entry({ provider: "anthropic", id: "claude-sonnet-5", supported_effort_levels: [{ value: "HIGH" }] })
  expect(a.variants).toEqual({ high: { effort: "high" } })
  const o = _internal.entry({ provider: "open_ai", id: "gpt-5.5", supported_effort_levels: [{ value: "Low" }] })
  expect(o.variants).toEqual({ low: { reasoningEffort: "low" } })
})

// sent is the provider_request the plugin hands Zed for a Gemini body, from
// an upstream that parses both enums as Zed's cloud does.
async function sent(body, model = "gemini-4-argon") {
  let got
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path === "/client/llm_tokens") return Response.json({ token: "llm-token" })
    if (path === "/completions") {
      got = JSON.parse(init.body)
      const level = got.provider_request.generationConfig?.thinkingConfig?.thinkingLevel
      if (level !== undefined && !["MINIMAL", "LOW", "MEDIUM", "HIGH"].includes(level)) {
        return new Response(`failed to parse Google AI request: unknown variant \`${level}\`, expected one of \`MINIMAL\`, \`LOW\`, \`MEDIUM\`, \`HIGH\``, { status: 400 })
      }
      const mode = got.provider_request.toolConfig?.functionCallingConfig?.mode
      if (mode !== undefined && !["auto", "any", "none"].includes(mode)) {
        return new Response(`failed to parse Google AI request: unknown variant \`${mode}\`, expected one of \`auto\`, \`any\`, \`none\``, { status: 400 })
      }
      const ev = (e) => JSON.stringify({ event: e })
      return new Response(
        [
          ev({ candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
          JSON.stringify({ status: "stream_ended" }),
        ].join("\n") + "\n",
        { headers: { "x-zed-server-supports-status-messages": "true" } },
      )
    }
    return new Response("", { status: 404 })
  }
  const res = await _internal.complete(s, `https://cloud.zed.dev/v1beta/models/${model}:streamGenerateContent?alt=sse`, { method: "POST", body: JSON.stringify(body) })
  return { req: got.provider_request, res, text: await res.text() }
}

const tools = [{ functionDeclarations: [{ name: "Bash", description: "run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }] }]
const ask = (extra = {}) => ({ contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 64, ...extra.generationConfig }, ...(extra.toolConfig && { tools, toolConfig: extra.toolConfig }) })

test("each declared variant, as the AI SDK writes it, reaches Zed uppercase and is answered", async () => {
  const e = _internal.entry(listed("gemini-4-argon"))
  for (const [k, want] of [["low", "LOW"], ["medium", "MEDIUM"], ["high", "HIGH"]]) {
    // @ai-sdk/google writes providerOptions.google.thinkingConfig into
    // generationConfig as given
    const { req, res, text } = await sent(ask({ generationConfig: { thinkingConfig: e.variants[k].thinkingConfig }, toolConfig: { functionCallingConfig: { mode: "AUTO" } } }))
    expect(text).not.toContain("unknown variant")
    expect(res.status).toBe(200)
    expect(req.model).toBe("models/gemini-4-argon")
    expect(req.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: want })
    expect(req.toolConfig.functionCallingConfig.mode).toBe("auto")
  }
})

test("a thinking level in any case goes to Zed uppercase", async () => {
  for (const [given, want] of [["minimal", "MINIMAL"], ["low", "LOW"], ["medium", "MEDIUM"], ["high", "HIGH"], ["HIGH", "HIGH"], ["High", "HIGH"]]) {
    const { req, res } = await sent(ask({ generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: given } } }))
    expect(res.status).toBe(200)
    expect(req.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: want })
  }
})

test("an empty thinking level is left out; a budget alone is sent as it was", async () => {
  let { req, res } = await sent(ask({ generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: "" } } }))
  expect(res.status).toBe(200)
  expect(req.generationConfig.thinkingConfig).toEqual({ includeThoughts: true })
  ;({ req, res } = await sent(ask({ generationConfig: { thinkingConfig: { thinkingBudget: 2000 } } })))
  expect(res.status).toBe(200)
  expect(req.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 2000 })
})

test("VALIDATED, which Zed has no mode for, is asked as auto", async () => {
  const { req, res } = await sent(ask({ toolConfig: { functionCallingConfig: { mode: "VALIDATED", allowedFunctionNames: ["Bash"] } } }))
  expect(res.status).toBe(200)
  expect(req.toolConfig.functionCallingConfig).toEqual({ mode: "auto", allowedFunctionNames: ["Bash"] })
})
