// Zed's cloud reads a Gemini request's toolConfig.functionCallingConfig.mode
// in lowercase (auto, any, none). The Gemini API's proto enums, which the AI
// SDK and magpie's Code Assist envelope write (AUTO, ANY, NONE), are answered
// 400 "failed to parse Google AI request: unknown variant `AUTO`, expected one
// of `auto`, `any`, `none`": every Gemini turn that declared a tool failed
// while plain chat worked (atticuskk, magpie#4657).
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.tokens.clear()
})

const s = { userId: "4242", access: "plain-access", systemId: "", org: "org-me", plan: "zed_pro", who: "octo" }

// sent is the provider_request the plugin hands Zed for a Gemini body, from
// an upstream that refuses a mode as Zed's cloud does.
async function sent(body) {
  let got
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path === "/client/llm_tokens") return Response.json({ token: "llm-token" })
    if (path === "/completions") {
      got = JSON.parse(init.body)
      const mode = got.provider_request.toolConfig?.functionCallingConfig?.mode
      if (mode !== undefined && !["auto", "any", "none"].includes(mode)) {
        return new Response(`failed to parse Google AI request: unknown variant \`${mode}\`, expected one of \`auto\`, \`any\`, \`none\``, { status: 400 })
      }
      const ev = (e) => JSON.stringify({ event: e })
      return new Response(
        [
          ev({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], modelVersion: "gemini-3.5-flash" }),
          JSON.stringify({ status: "stream_ended" }),
        ].join("\n") + "\n",
        { headers: { "x-zed-server-supports-status-messages": "true" } },
      )
    }
    return new Response("", { status: 404 })
  }
  const res = await _internal.complete(s, "https://cloud.zed.dev/v1beta/models/gemini-3.5-flash:generateContent", { method: "POST", body: JSON.stringify(body) })
  return { req: got.provider_request, res, text: await res.text() }
}

const tools = [{ functionDeclarations: [{ name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } }] }]
const ask = (toolConfig) => ({ contents: [{ role: "user", parts: [{ text: "Weather in Paris? Use the tool." }] }], tools, ...(toolConfig && { toolConfig }) })

for (const [mode, want] of [["AUTO", "auto"], ["ANY", "any"], ["NONE", "none"], ["auto", "auto"]]) {
  test(`a tool-calling mode ${mode} goes to Zed as ${want}`, async () => {
    const { req, res } = await sent(ask({ functionCallingConfig: { mode, ...(mode === "ANY" && { allowedFunctionNames: ["get_weather"] }) } }))
    expect(res.status).toBe(200)
    expect(req.toolConfig.functionCallingConfig.mode).toBe(want)
    // nothing else in it moves
    if (mode === "ANY") expect(req.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(["get_weather"])
    expect(req.tools).toEqual(tools)
  })
}

test("a request with no toolConfig is sent without one", async () => {
  const { req, res } = await sent(ask())
  expect(res.status).toBe(200)
  expect(req.toolConfig).toBeUndefined()
})
