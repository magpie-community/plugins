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

test("omp's RFC 2119 line goes as RFC 2119's own \"key words\", as the real account turned it away", () => {
  const line = "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL."
  const sys = line + " `NEVER` = `MUST NOT`; `AVOID` = `SHOULD NOT`.\n\n§ Role"
  const out = cloak(sys)
  // a zero-width break of this line was turned away 1 to 3 times in 10 on
  // 11-14; "key words" went through 10 of 10
  expect(out).toBe(sys.replace("keywords", "key words"))
  expect(out).not.toContain("\u200b")
  expect(cloak("RFC 2119 keywords: MUST")).toBe("RFC 2119 keywords: MUST")
})

// omp 18.20.0's first line, byte for byte (src/prompts/system/system-prompt.md),
// and the copies of it a real account turned away on 11-14 although no
// space in them is a single space: wrapped after "REQUIRED," with LF or
// CRLF, wrapped after "RFC 2119", indented, a tab, two spaces, a no-break
// space. The same account answered the line without its period, with no
// space after a comma, or in another order, so those go as written.
const OMP_LINE = "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` = `MUST NOT`; `AVOID` = `SHOULD NOT`."
const OMP_COPIES = [
  "RFC 2119 keywords: MUST, REQUIRED,\nSHOULD, RECOMMENDED, MAY, OPTIONAL.",
  "RFC 2119 keywords: MUST, REQUIRED,\r\nSHOULD, RECOMMENDED, MAY, OPTIONAL.\r\n",
  "RFC 2119\nkeywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.",
  "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY,\n    OPTIONAL.",
  "RFC 2119 keywords:\tMUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.",
  "RFC  2119 keywords:  MUST,  REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.",
  "RFC\u00a02119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.",
]
const OMP_PASSED = [
  "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL",
  "RFC 2119 keywords: MUST,REQUIRED,SHOULD,RECOMMENDED,MAY,OPTIONAL.",
  "RFC 2119 keywords: MUST, SHOULD, MAY, REQUIRED, RECOMMENDED, OPTIONAL.",
  "RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.",
]

test("omp's line is reworded wherever white space wraps or widens it", () => {
  const { turnsAway, hint } = _internal
  for (const line of [OMP_LINE, ...OMP_COPIES]) {
    const sys = "<conventions>\n" + line + "\n</conventions>\n\n§ Role"
    const out = cloak(sys)
    expect(out).toBe(sys.replace("keywords", "key words"))
    expect(turnsAway(out)).toBe(false)
    expect(hint(sys)).toContain("oh-my-pi (omp)")
    // every white space stays as it was
    expect(shape({ systemInstruction: { parts: [{ text: sys }] }, contents: [] }, "gemini-3-flash", "", "").systemInstruction.parts[0].text).toBe(out)
  }
  for (const line of OMP_PASSED) expect(cloak(line)).toBe(line)
  // the other lines take white space the same way (Hermes' and Codex's
  // were turned away wrapped and with a tab on the same account)
  expect(cloak("You are Hermes Agent, an intelligent\nAI assistant created by Nous Research.")).toContain("i\u200bn\u200btelligent\nAI a\u200bs\u200bsistant")
  expect(cloak("You are Codex, an agent\tbased on GPT-5.")).toContain("a\u200bg\u200bent\tb\u200ba\u200bsed")
})

test("the lines Antigravity turns away are broken up", () => {
  const sys = "x-anthropic-billing-header: cc_version=2\nYou are Claude Code, built on Anthropic's Claude Agent SDK.\nhi"
  const out = cloak(sys)
  expect(out).not.toBe(sys)
  expect(out.replaceAll("​", "")).toBe(sys)
  expect(out).toContain("x-a\u200bn\u200bthropic-b\u200bi\u200blling-h\u200be\u200bader:")
  expect(out).toContain("b\u200bu\u200bilt on A\u200bn\u200bthropic's C\u200bl\u200baude A\u200bg\u200bent S\u200bD\u200bK")
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

test("sessions with shared AGENTS.md preambles or distinct host headers don't collide", () => {
  const preamble = [
    { text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>global</INSTRUCTIONS>" },
    { text: "<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>" },
  ]
  const chatA = { contents: [{ role: "user", parts: preamble }, { role: "user", parts: [{ text: "fix login bug" }] }] }
  const chatA2 = { contents: [...chatA.contents, { role: "model", parts: [{ text: "looking" }] }] }
  const chatB = { contents: [{ role: "user", parts: preamble }, { role: "user", parts: [{ text: "add export csv" }] }] }
  expect(sessionOf(chatA)).toBe(sessionOf(chatA2))
  expect(sessionOf(chatA)).not.toBe(sessionOf(chatB))

  const s1 = sessionOf(chatA, { "x-magpie-session": "01a1cb56-5f3e-74d1-b7a9-b40be82a2ba4" })
  const s2 = sessionOf(chatA, { "x-magpie-session": "01a1c9cc-0757-70e3-990f-5a818d52b0cd" })
  expect(s1).not.toBe(s2)
  expect(sessionOf(chatA, { "x-magpie-session": "magpie-0123456789abcdef01234567" })).toBe(sessionOf(chatA))

  const subA = sessionOf(chatA, { "x-magpie-session": "01a1cb56-5f3e-74d1-b7a9-b40be82a2ba4", "x-magpie-subagent": "collab_spawn" })
  const subB = sessionOf(chatB, { "x-magpie-session": "01a1cb56-5f3e-74d1-b7a9-b40be82a2ba4", "x-magpie-subagent": "collab_spawn" })
  expect(subA).not.toBe(s1)
  expect(subA).not.toBe(subB)
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

test("DeepSeek Harness's @-path paragraph goes reworded, the rest as written (#1028)", () => {
  // word for word as DSH desktop 0.2.2-rc.2 puts it in every system prompt
  const dsh = "Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @\"...\" quotes a path containing spaces."
  const sys = "You are DeepSeek Harness.\n\n" + dsh + "\n\nBe brief."
  for (const req of [{ systemInstruction: { parts: [{ text: sys }] }, contents: [] }, { systemInstruction: sys, contents: [] }]) {
    const text = shape(req, "gemini-4-argon", "", "").systemInstruction.parts[0].text
    expect(text).not.toContain("Tokens prefixed with @")
    expect(text).toBe("You are DeepSeek Harness.\n\nWhen the user writes @ followed by a path, they are pointing at that file or folder. Relative paths start at the workspace root; absolute paths are host paths. A path ending in a slash is a folder, so list it if its contents matter; otherwise it is a file, so open it with the read tool before relying on it. Paths with spaces appear as @\"...\".\n\nBe brief.")
  }
  // a prompt that only mentions @ paths is left as it is
  const other = "Tokens prefixed with @ are paths. Be brief."
  expect(shape({ systemInstruction: { parts: [{ text: other }] }, contents: [] }, "gemini-4-argon", "", "").systemInstruction.parts[0].text).toBe(other)
  // the rewording and the zero-width breaks go together
  const both = shape({ systemInstruction: { parts: [{ text: "x-anthropic-billing-header: cc\n" + dsh }] }, contents: [] }, "gemini-3-flash", "", "").systemInstruction.parts[0].text
  expect(both).toContain("x-a​n​thropic")
  expect(both).toContain("When the user writes @ followed by a path")
})
