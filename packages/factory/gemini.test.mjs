// yetone/magpie#2080: Gemini's models go to Factory's own route,
// /api/llm/g/v1/generate, as magpie's built-in sends them (buildGemini,
// factoryDroidGoogle in internal/provider/factory_client.go).
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
const droid = "You are Droid, an AI software engineering agent built by Factory."

async function loaded(auth = { type: "oauth", access: "factory-token", expires: Date.now() + 3_600_000, activeOrganizationId: "org_A" }) {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), ...init })
    return new Response('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]}}]}\n\n', { headers: { "content-type": "text/event-stream" } })
  }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  return { l: await hooks.auth.loader(async () => auth), seen }
}

// the request magpie's gateway hands a plugin's @ai-sdk/google model
const request = {
  contents: [{ role: "user", parts: [{ text: "hi" }, { inlineData: { mimeType: "image/png", data: "aW1n" } }] }],
  systemInstruction: { role: "user", parts: [{ text: "Be brief." }, { text: "Use tools." }] },
  generationConfig: { maxOutputTokens: 512, thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
  tools: [{ functionDeclarations: [{ name: "Read", parameters: { type: "object" } }] }],
}

test("a Gemini model goes to /api/llm/g/v1/generate, the model in the body, x-api-provider google", async () => {
  const { l, seen } = await loaded()
  const res = await l.fetch("https://api.factory.ai/api/llm/g/v1/models/gemini-4-argon:streamGenerateContent?alt=sse", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": "placeholder", "content-length": "1" },
    body: JSON.stringify(request),
  })
  expect(seen[0].url).toBe("https://api.factory.ai/api/llm/g/v1/generate")
  const sent = JSON.parse(seen[0].body)
  expect(sent.model).toBe("gemini-4-argon")
  expect(sent.systemInstruction).toEqual({ parts: [{ text: droid + "\nBe brief.\nUse tools." }] })
  for (const k of ["contents", "generationConfig", "tools"]) expect(sent[k]).toEqual(request[k])
  const h = seen[0].headers
  expect(h.get("x-api-provider")).toBe("google")
  expect(h.get("authorization")).toBe("Bearer factory-token")
  expect(h.get("x-goog-api-key")).toBeNull()
  expect(h.get("x-api-key")).toBeNull()
  expect(h.get("content-length")).toBeNull()
  expect(h.get("OpenAI-Platform")).toBeNull()
  expect(await res.text()).toContain('"text":"ok"')
})

test("a Gemini request with no system instruction gets droid's line, one droid opened already goes on as it is", async () => {
  const { l, seen } = await loaded()
  const at = "https://api.factory.ai/api/llm/g/v1/models/gemini-3.5-flash:streamGenerateContent?alt=sse"
  await l.fetch(at, { method: "POST", body: JSON.stringify({ contents: request.contents }) })
  expect(JSON.parse(seen[0].body).systemInstruction).toEqual({ parts: [{ text: droid }] })
  const own = { contents: request.contents, systemInstruction: { parts: [{ text: droid + "\nmine" }, { inlineData: { mimeType: "image/png", data: "eA==" } }] } }
  await l.fetch(at, { method: "POST", body: JSON.stringify(own) })
  expect(JSON.parse(seen[1].body)).toEqual({ ...own, model: "gemini-3.5-flash" })
  // a string instruction and parts other than text keep their place after the line
  await l.fetch(at, { method: "POST", body: JSON.stringify({ contents: request.contents, systemInstruction: "Plain." }) })
  expect(JSON.parse(seen[2].body).systemInstruction).toEqual({ parts: [{ text: droid + "\nPlain." }] })
  await l.fetch(at, { method: "POST", body: JSON.stringify({ contents: request.contents, systemInstruction: { parts: [{ text: "A" }, { inlineData: { mimeType: "image/png", data: "eA==" } }] } }) })
  expect(JSON.parse(seen[3].body).systemInstruction).toEqual({ parts: [{ text: droid + "\nA" }, { inlineData: { mimeType: "image/png", data: "eA==" } }] })
})

test("an EU org's Gemini request goes to Factory's EU region's generate route", async () => {
  const { l, seen } = await loaded({ type: "oauth", access: "factory-token", expires: Date.now() + 3_600_000, activeOrganizationId: "org_A", region: "eu" })
  await l.fetch("https://api.factory.ai/api/llm/g/v1/models/gemini-3.8-flash:streamGenerateContent?alt=sse", { method: "POST", body: JSON.stringify(request) })
  expect(new URL(seen[0].url).pathname).toBe("/api/llm/g/v1/generate")
  expect(seen[0].url.startsWith("https://api.factory.ai/")).toBe(false)
})

// Gemini's route has no tool-output adaptation of its own: every refused
// phrase in its parts is escaped before the request leaves.
test("Gemini tool output and system instruction escape every refused phrase", async () => {
  const { l, seen } = await loaded()
  const env = "You have been invoked in the following environment:"
  const pi = "You are an expert coding assistant operating inside pi, a coding agent harness."
  const body = {
    contents: [{ role: "user", parts: [{ functionResponse: { name: "Read", response: { text: env + " / " + pi } } }] }],
    systemInstruction: { role: "user", parts: [{ text: env }] },
  }
  await l.fetch("https://api.factory.ai/api/llm/g/v1/models/gemini-4-argon:streamGenerateContent?alt=sse", { method: "POST", body: JSON.stringify(body) })
  const sent = JSON.parse(seen[0].body)
  const part = sent.contents[0].parts[0].functionResponse.response.text
  expect(part).toBe("\\u0059ou have been invoked in the following environment: / \\u0059ou are an expert coding assistant operating inside pi, a coding agent harness.")
  expect(sent.systemInstruction.parts[0].text).toContain("\\u0059ou have been invoked")
  expect(JSON.stringify(sent)).not.toContain(env)
  expect(JSON.stringify(sent)).not.toContain(pi)
})
