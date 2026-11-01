// Zed's cloud parses a Google request with its own serde enums: thinkingLevel
// UPPERCASE only, functionCallingConfig.mode lowercase only. Claude Code's
// effort reached it as thinkingLevel "high" through magpie and was answered
// 400 "failed to parse Google AI request: unknown variant `high`, expected
// one of `MINIMAL`, `LOW`, `MEDIUM`, `HIGH`"; a request with tools as
// "unknown variant `AUTO`, expected one of `auto`, `any`, `none`" (#215).
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.tokens.clear()
})

const s = { userId: "4242", access: "plain-access", systemId: "", org: "org-me", plan: "zed_pro", who: "octo" }

const gemini = (extra) => ({
  contents: [{ role: "user", parts: [{ text: "hi" }] }],
  generationConfig: { maxOutputTokens: 64, ...(extra.generationConfig ?? {}) },
  ...(extra.toolConfig ? { toolConfig: extra.toolConfig } : {}),
  ...(extra.tools ? { tools: extra.tools } : {}),
})

test("a lowercase thinkingLevel goes to Zed in its uppercase spelling", () => {
  for (const [given, want] of [["minimal", "MINIMAL"], ["low", "LOW"], ["medium", "MEDIUM"], ["high", "HIGH"], ["HIGH", "HIGH"], ["High", "HIGH"]]) {
    const { req } = _internal.providerRequest("gemini", gemini({ generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: given } } }), "gemini-4-argon")
    expect(req.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: want })
  }
})

test("an empty thinkingLevel is left out; a thinkingBudget alone is left as sent", () => {
  let { req } = _internal.providerRequest("gemini", gemini({ generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: "" } } }), "gemini-4-argon")
  expect(req.generationConfig.thinkingConfig).toEqual({ includeThoughts: true })
  ;({ req } = _internal.providerRequest("gemini", gemini({ generationConfig: { thinkingConfig: { thinkingBudget: 2000 } } }), "gemini-4-argon"))
  expect(req.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 2000 })
})

test("Google's uppercase function calling modes go to Zed lowercase", () => {
  for (const [given, want] of [["AUTO", "auto"], ["ANY", "any"], ["NONE", "none"], ["VALIDATED", "auto"], ["auto", "auto"]]) {
    const { req } = _internal.providerRequest("gemini", gemini({ toolConfig: { functionCallingConfig: { mode: given, allowedFunctionNames: ["Bash"] } } }), "gemini-4-argon")
    expect(req.toolConfig.functionCallingConfig).toEqual({ mode: want, allowedFunctionNames: ["Bash"] })
  }
})

test("a request without either is sent untouched", () => {
  const { req } = _internal.providerRequest("gemini", gemini({}), "gemini-4-argon")
  expect(req).toEqual({ ...gemini({}), model: "models/gemini-4-argon" })
})

test("the variants a Google model declares carry Zed's uppercase level", () => {
  const e = _internal.entry({ provider: "google", id: "gemini-3.8-flash", supports_thinking: true, supported_effort_levels: [{ value: "low" }, { value: "high" }] })
  expect(e.variants.low.thinkingConfig.thinkingLevel).toBe("LOW")
  expect(e.variants.high.thinkingConfig.thinkingLevel).toBe("HIGH")
})

test("a Claude Code turn through magpie reaches Zed's /completions with HIGH and auto", async () => {
  let got
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path === "/client/llm_tokens") return Response.json({ token: "llm-token" })
    if (path === "/completions") {
      got = JSON.parse(init.body)
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
  const body = gemini({
    generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
    tools: [{ functionDeclarations: [{ name: "Bash", description: "run a command", parameters: { type: "object", properties: { command: { type: "string" } } } }] }],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
  })
  const res = await _internal.complete(s, "https://cloud.zed.dev/v1/models/gemini-4-argon:streamGenerateContent?alt=sse", { method: "POST", body: JSON.stringify(body) })
  expect(res.status).toBe(200)
  await res.text()
  expect(got.provider).toBe("google")
  expect(got.provider_request.model).toBe("models/gemini-4-argon")
  expect(got.provider_request.generationConfig.thinkingConfig.thinkingLevel).toBe("HIGH")
  expect(got.provider_request.toolConfig.functionCallingConfig.mode).toBe("auto")
})
