// The Gemini request magpie (or the AI SDK) hands the plugin, shaped as
// the built-in shaped it for Antigravity (codeassist.go's Antigravity
// rules; codeassist_test.go's TestBuildCodeAssistForAntigravity,
// TestCodeAssistAntigravityLevels and TestCodeAssistToolImagesAfterEveryResponse).
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { shape, cloak, sessionOf, envelope } = _internal

// what magpie's generic Code Assist build makes of codeassist_test.go's
// codeAssistRequest
const generic = () => ({
  systemInstruction: { role: "user", parts: [{ text: "be brief" }] },
  contents: [
    { role: "user", parts: [{ text: "read a" }] },
    { role: "model", parts: [{ text: "hm", thought: true }, { text: "ok" }, { functionCall: { id: "toolu_01:x", name: "read", args: { path: "a" } }, thoughtSignature: "skip_thought_signature_validator" }] },
    { role: "user", parts: [{ functionResponse: { id: "toolu_01:x", name: "read", response: { output: "A!" } } }] },
    { role: "user", parts: [{ text: "and?" }] },
  ],
  tools: [{ functionDeclarations: [{ name: "read", description: "read a file", parametersJsonSchema: { type: "object", properties: { path: { type: ["string", "null"] } }, required: ["path"], additionalProperties: false } }] }],
  toolConfig: { functionCallingConfig: { mode: "AUTO" } },
  generationConfig: { maxOutputTokens: 2000, thinkingConfig: { includeThoughts: true, thinkingBudget: 4000 } },
})

test("Claude on Antigravity", () => {
  const r = shape(generic(), "claude-sonnet-4-6", "", "")
  const s = JSON.stringify(r)
  expect(s).toContain(`"id":"toolu_01_x"`)
  expect(s).toContain(`"response":{"result":"A!"}`)
  expect(r.toolConfig.functionCallingConfig.mode).toBe("VALIDATED")
  expect(r.generationConfig.maxOutputTokens).toBe(2000)
  // Sonnet here doesn't think
  expect(r.generationConfig.thinkingConfig).toBeUndefined()
  expect(r.tools[0].functionDeclarations[0]).toEqual({ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string", nullable: true } }, required: ["path"] } })
  // what the user said joins the tool's turn
  expect(r.contents.length).toBe(3)
  expect(r.contents[2].parts.map((p) => (p.functionResponse ? "response" : p.text))).toEqual(["response", "and?"])
  // a thinking Claude keeps its budget
  const t = shape(generic(), "claude-opus-4-6-thinking", "", "")
  expect(t.generationConfig.thinkingConfig.thinkingBudget).toBe(4000)
})

test("Gemini on Antigravity", () => {
  const r = shape(generic(), "gemini-3-flash", "", "")
  expect(r.generationConfig.maxOutputTokens).toBeUndefined()
  expect(r.generationConfig.thinkingConfig).toEqual({ includeThoughts: true })
  expect(r.toolConfig.functionCallingConfig.mode).toBe("AUTO")
  // the user's turn stays its own for Gemini
  expect(r.contents.length).toBe(4)
  expect(shape(generic(), "gpt-oss-120b-medium", "", "").generationConfig?.thinkingConfig).toBeUndefined()
  // an empty declaration's parameters
  const g = generic()
  delete g.tools[0].functionDeclarations[0].parametersJsonSchema
  expect(shape(g, "gemini-3-flash", "", "").tools[0].functionDeclarations[0].parameters).toEqual({ type: "object", properties: {} })
})

test.each([
  // [model sent, the variant's level, the effort asked, the level sent]
  ["gemini-3.7-flash-low", "low", "low", "low"],
  ["gemini-3.7-flash-medium", "medium", "medium", "medium"],
  ["gemini-3.7-flash-high", "high", "xhigh", "high"],
  ["gemini-3.1-pro-high", "high", "medium", "high"],
  ["gemini-3-flash", "", "medium", "medium"],
  ["gemini-pro-agent", "", "medium", "high"],
  ["gemini-pro-agent", "", "low", "low"],
  // reasoning off goes at low, the least every one takes (#250)
  ["gemini-3.1-flash-lite", "", "minimal", "low"],
  ["gemini-3.1-flash-lite", "", "none", "low"],
  // a variant at minimal is asked at minimal; a Pro, at low
  ["gemini-3.5-flash-extra-low", "minimal", "", "minimal"],
  ["gemini-3.1-pro-low", "minimal", "", "low"],
  // a model that draws, asked off, goes at high
  ["gemini-3.1-flash-image", "", "minimal", "high"],
])("%s (%p) asked %p thinks at %p", (sent, at, effort, level) => {
  const r = shape(generic(), sent, at, effort)
  expect(r.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: level })
})

test("a level a variant put on a model told a budget goes", () => {
  const g = generic()
  g.generationConfig.thinkingConfig = { includeThoughts: true, thinkingLevel: "high" }
  expect(shape(g, "gemini-2.5-flash", "", "").generationConfig?.thinkingConfig).toBeUndefined()
})

test("a tool's images follow every response, for Claude", () => {
  const img = (d) => ({ inlineData: { mimeType: "image/png", data: d } })
  const g = {
    contents: [
      { role: "user", parts: [{ text: "look" }] },
      { role: "model", parts: [{ functionCall: { id: "a", name: "shot", args: {} } }, { functionCall: { id: "b", name: "shot", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "a", name: "shot", response: { output: "one" } } }, img("1"), { functionResponse: { id: "b", name: "shot", response: { output: "two" } } }, img("2"), img("3")] },
      { role: "user", parts: [{ text: "what now?" }] },
    ],
  }
  const r = shape(g, "claude-sonnet-4-6", "", "")
  const lines = r.contents[2].parts.map((p) => (p.functionResponse ? "response " + p.functionResponse.id : p.inlineData ? "image " + p.inlineData.data : p.text))
  expect(lines).toEqual(["response a", "response b", "Image returned by tool shot (call a):", "image 1", "2 images returned by tool shot (call b):", "image 2", "image 3", "what now?"])
  expect(r.contents.length).toBe(3)
  // Gemini takes them where they are
  expect(shape(g, "gemini-3-flash", "", "").contents[2].parts.length).toBe(5)
})

test("the lines Antigravity turns away are broken up", () => {
  const sys = "x-anthropic-billing-header: cc_version=2\nYou are Claude Code, built on Anthropic's Claude Agent SDK.\nhi"
  const out = cloak(sys)
  expect(out).not.toBe(sys)
  expect(out.replaceAll("​", "")).toBe(sys)
  expect(out).toContain("x​-anthropic-billing-header:")
  expect(out).toContain("b​uilt on Anthropic's")
  // twice is the same as once, and other text is left alone
  expect(cloak(out)).toBe(out)
  expect(cloak("be brief")).toBe("be brief")
  const r = shape({ systemInstruction: { parts: [{ text: sys }] }, contents: [] }, "gemini-3-flash", "", "")
  expect(r.systemInstruction.parts[0].text).toBe(out)
})

test("a conversation keeps its session", () => {
  const a = { contents: [{ role: "user", parts: [{ text: "hello there" }] }] }
  const b = { contents: [{ role: "user", parts: [{ text: "hello there" }] }, { role: "model", parts: [{ text: "hi" }] }] }
  expect(sessionOf(a)).toBe(sessionOf(b))
  expect(sessionOf(a)).toMatch(/^-\d+$/)
  expect(sessionOf({ contents: [{ role: "user", parts: [{ text: "other" }] }] })).not.toBe(sessionOf(a))
  const env = envelope(a, "gemini-3-flash", "ag-proj")
  expect(env).toMatchObject({ model: "gemini-3-flash", project: "ag-proj", userAgent: "antigravity", requestType: "agent" })
  expect(env.requestId).toMatch(/^agent-[0-9a-f]{12}$/)
  expect(env.request.sessionId).toBe(sessionOf(a))
})

test("an empty text a stream ended on isn't sent back (Claude: text Field required)", () => {
  const g = { contents: [
    { role: "user", parts: [{ text: "read it" }] },
    { role: "model", parts: [{ text: "Sure." }, { functionCall: { id: "toolu_vrtx_1", name: "read", args: {} } }, { text: "" }] },
    { role: "user", parts: [{ functionResponse: { id: "toolu_vrtx_1", name: "read", response: { output: "A" } } }] },
  ] }
  expect(shape(g, "claude-sonnet-4-6", "", "").contents[1].parts.map((p) => Object.keys(p)[0])).toEqual(["text", "functionCall"])
  // a signature on an empty text is kept
  const s = { contents: [{ role: "model", parts: [{ text: "a" }, { text: "", thoughtSignature: "sig" }] }] }
  expect(shape(s, "gemini-3-flash", "", "").contents[0].parts[1]).toEqual({ text: "", thoughtSignature: "sig" })
})
