// magpie-community/plugins#1310: Codex (and Cindy's pi) on Factory's Gemini
// models were refused with content_policy_rejected, while magpie's own model
// test of the same model passed. The test is a bare "hi"; Codex's request
// carries its prompt and tools. magpie hands the plugin a Responses or chat
// request for a Gemini model translated to Gemini's generateContent, and
// geminiBody passed its system instruction, user turns and tool
// descriptions on unadapted: the wording 0.1.52 to 0.1.54 change for
// Factory's other routes ("harness", pi's and dsh's identity lines, Claude
// Code's) reached Factory as the client wrote it. The model id is not it:
// the gateway sends the bare id ("factory/" is magpie's own prefix), as the
// reporter's screenshot's sent model shows.
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { FactoryAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
const droid = "You are Droid, an AI software engineering agent built by Factory."
const at = "https://api.factory.ai/api/llm/g/v1/models/gemini-4-hydrogen:streamGenerateContent?alt=sse"
const responses = "https://api.factory.ai/api/llm/o/v1/responses"

async function loaded() {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: init.body })
    return new Response('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]}}]}\n\n', { headers: { "content-type": "text/event-stream" } })
  }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => ({ type: "oauth", access: "t", expires: Date.now() + 3_600_000, activeOrganizationId: "org_A" }))
  return async (url, body) => {
    await l.fetch(url, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })
    return { url: seen.at(-1).url, body: JSON.parse(seen.at(-1).body) }
  }
}

// Codex 0.162.0's real first request (magpie's internal/gateway
// testdata/workdir/codex-0.162.0.json) as magpie's gateway builds it for
// gemini-4-hydrogen (buildCodeAssistSent, the envelope's request)
const CODEX = readFileSync(new URL("./testdata/codex-0.162.0-gemini.json", import.meta.url), "utf8")

test("Codex's real request for a Gemini model reaches Factory with its prompt adapted", async () => {
  expect(JSON.parse(CODEX).systemInstruction.parts[0].text).toContain("provided by the harness")
  const send = await loaded()
  const { url, body } = await send(at, CODEX)
  expect(url).toBe("https://api.factory.ai/api/llm/g/v1/generate")
  expect(body.model).toBe("gemini-4-hydrogen")
  const si = body.systemInstruction.parts[0].text
  expect(si.startsWith(droid + "\nYou are a coding agent running in the Codex CLI")).toBe(true)
  expect(si).toContain("context provided by the runtime, such as files in the workspace.")
  expect(JSON.stringify(body)).not.toMatch(/\bharness\b/)
  // the user's turn and the tools go on as Codex sent them otherwise
  const before = JSON.parse(CODEX)
  expect(body.contents).toEqual(before.contents)
  expect(body.tools[0].functionDeclarations.map((d) => d.name)).toEqual(before.tools[0].functionDeclarations.map((d) => d.name))
})

test("a client's prompt reads the same to Factory on the Gemini route as on the Responses route", async () => {
  const send = await loaded()
  const prompts = [
    "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.",
    "You are an expert coding assistant operating inside pi, a coding agent harness.\nBe brief.",
    "You are an AI agent powered by DeepSeek Harness.\nYou are a coding agent powered by the gemini-4-hydrogen model.\nThe browser provides no implicit DOM, route, or screenshot context.",
    "You are Claude Code, Anthropic's official CLI for Claude.\nThe exception is external work the harness cannot track.",
  ]
  for (const prompt of prompts) {
    const r = await send(responses, { model: "gpt-5.1-codex", instructions: prompt, input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] })
    const g = await send(at, { contents: [{ role: "user", parts: [{ text: "hi" }] }], systemInstruction: { role: "user", parts: [{ text: prompt }] } })
    expect(g.body.systemInstruction).toEqual({ parts: [{ text: r.body.instructions }] })
    expect(g.body.systemInstruction.parts[0].text).not.toMatch(/\bharness\b|DeepSeek Harness|Claude Code/i)
  }
})

test("Gemini tool descriptions and user turns are adapted as on Factory's other routes", async () => {
  const send = await loaded()
  const summary = "The conversation history before this point was compacted into the following summary:\n\n<summary>\nwe fixed the harness tests\n</summary>"
  const body = {
    contents: [
      { role: "user", parts: [{ text: summary }, { text: "fix the harness" }] },
      { role: "model", parts: [{ text: "the harness is fine" }] },
    ],
    systemInstruction: { parts: [{ text: "Be brief." }] },
    tools: [{ functionDeclarations: [
      { name: "Wake", description: "The exception is external work the harness cannot track", parametersJsonSchema: { type: "object", properties: { why: { type: "string", description: "what the harness waits on", enum: ["harness"] } } } },
      { name: "Read", parameters: { type: "object", properties: { path: { type: "string", description: "a harness file" } } } },
    ] }],
  }
  const { body: out } = await send(at, body)
  const [wake, read] = out.tools[0].functionDeclarations
  expect(wake.description).toBe("The exception is external work the runtime cannot track")
  expect(wake.parametersJsonSchema.properties.why).toEqual({ type: "string", description: "what the runtime waits on", enum: ["harness"] })
  expect(read.parameters.properties.path.description).toBe("a runtime file")
  // pi's summary opening reworded, the user's own words and the model's kept
  expect(out.contents[0].parts[0].text).toBe("Earlier conversation context is summarized below:\n\n<summary>\nwe fixed the harness tests\n</summary>")
  expect(out.contents[0].parts[1].text).toBe("fix the harness")
  expect(out.contents[1].parts[0].text).toBe("the harness is fine")
})
