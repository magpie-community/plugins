import { afterEach, beforeEach, expect, test } from "bun:test"
import { AntigravityAuthPlugin, _internal } from "./index.mjs"
import { auth, fake, real, reset } from "./fake.mjs"

beforeEach(() => reset())
afterEach(() => (globalThis.fetch = real))

const sse = (...chunks) =>
  new Response(chunks.map((c) => "data: " + JSON.stringify({ response: c, traceId: "t" }) + "\r\n\r\n").join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

const models = {
  models: {
    "gemini-3-flash": { displayName: "Gemini 3 Flash" },
    "gemini-2.5-flash": { displayName: "Gemini 2.5 Flash" },
    "claude-opus-4-6-thinking": { displayName: "Claude Opus 4.6 (Thinking)" },
  },
}

const REDIR_A = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA"
const REDIR_B = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB"

test("plugin registers the antigravity search hook signed in as antigravity", async () => {
  const p = await AntigravityAuthPlugin({})
  expect(p.search?.antigravity).toBeDefined()
  expect(p.search.antigravity.auth).toBe("antigravity")
  expect(typeof p.search.antigravity.execute).toBe("function")
})

test("search rejects an empty query and a missing sign-in", async () => {
  const p = await AntigravityAuthPlugin({})
  await expect(p.search.antigravity.execute({ query: "   " }, { getAuth: async () => auth() })).rejects.toThrow("query is required")
  await expect(p.search.antigravity.execute({ query: "bun" }, { getAuth: async () => null })).rejects.toThrow("not signed in")
})

test("search calls Antigravity with googleSearch, returns URIs unchanged, deduplicates, and trims to count", async () => {
  const seen = fake({
    fetchAvailableModels: models,
    streamGenerateContent: () =>
      sse(
        { candidates: [{ content: { role: "model", parts: [{ thought: true, text: "thinking" }, { text: "Bun 1.4.4 " }] } }] },
        {
          candidates: [
            {
              content: { role: "model", parts: [{ text: "is latest." }] },
              finishReason: "STOP",
              groundingMetadata: {
                webSearchQueries: ["latest bun version"],
                groundingChunks: [
                  { web: { uri: REDIR_A, title: "github.com" } },
                  { web: { uri: REDIR_A, title: "github.com duplicate" } },
                  { web: { uri: REDIR_B, title: "bun.sh" } },
                ],
                groundingSupports: [
                  { segment: { text: "Bun 1.4.4 was released." }, groundingChunkIndices: [0] },
                  { segment: { text: "See release notes on GitHub." }, groundingChunkIndices: [1] },
                  { segment: { text: "Install via bun.sh." }, groundingChunkIndices: [2] },
                ],
              },
            },
          ],
        },
      ),
  })

  const p = await AntigravityAuthPlugin({})
  const pages = await p.search.antigravity.execute({ query: "latest bun version", count: 5 }, { getAuth: async () => auth() })

  expect(seen.map((s) => s.name)).toEqual(["loadCodeAssist", "fetchAvailableModels", "streamGenerateContent"])
  const req = seen.find((s) => s.name === "streamGenerateContent")
  expect(req.json.model).toBe("gemini-3-flash")
  expect(req.json.request.tools).toEqual([{ googleSearch: {} }])
  expect(req.json.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: false, thinkingLevel: "minimal" })
  expect(pages).toEqual([
    {
      title: "github.com",
      url: REDIR_A,
      text: "Bun 1.4.4 was released.\nSee release notes on GitHub.",
    },
    {
      title: "bun.sh",
      url: REDIR_B,
      text: "Install via bun.sh.",
    },
  ])

  const one = await p.search.antigravity.execute({ query: "latest bun version", count: 1 }, { getAuth: async () => auth() })
  expect(one).toHaveLength(1)
  expect(one[0].url).toBe(REDIR_A)
})

test("search carries numeric status and retryAfter when Antigravity refuses", async () => {
  fake({
    fetchAvailableModels: models,
    streamGenerateContent: () =>
      new Response(JSON.stringify({ error: { code: 429, message: "rate limited" } }), {
        status: 429,
        headers: { "retry-after": "12" },
      }),
  })
  const p = await AntigravityAuthPlugin({})
  let caught
  try {
    await p.search.antigravity.execute({ query: "news" }, { getAuth: async () => auth() })
  } catch (e) {
    caught = e
  }
  expect(caught).toBeDefined()
  expect(caught.status).toBe(429)
  expect(caught.retryAfter).toBe("12")
  expect(caught.message).toContain("rate limited")
})

test("whole preserves groundingMetadata from an earlier SSE chunk", async () => {
  const res = sse(
    {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Answer" }] },
          groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }] },
        },
      ],
    },
    {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "" }] },
          finishReason: "STOP",
          groundingMetadata: { webSearchQueries: ["example"], groundingChunks: [] },
        },
      ],
      usageMetadata: { totalTokenCount: 10 },
    },
  )
  const full = await _internal.whole(res)
  expect(full.candidates[0].groundingMetadata).toEqual({
    webSearchQueries: ["example"],
    groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }],
  })
})

test("search skips an exhausted Flash model and turns thinking off on Gemini 2.5", async () => {
  const seen = fake({
    fetchAvailableModels: {
      models: {
        "gemini-3-flash": { displayName: "Gemini 3 Flash", quotaInfo: {} },
        "gemini-2.5-flash": { displayName: "Gemini 2.5 Flash", quotaInfo: { remainingFraction: 0.8 } },
      },
    },
    streamGenerateContent: () =>
      sse({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "Answer." }] },
            finishReason: "STOP",
            groundingMetadata: {
              groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }],
            },
          },
        ],
      }),
  })

  const p = await AntigravityAuthPlugin({})
  const pages = await p.search.antigravity.execute({ query: "example" }, { getAuth: async () => auth() })

  const req = seen.find((s) => s.name === "streamGenerateContent")
  expect(req.json.model).toBe("gemini-2.5-flash")
  expect(req.json.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: false, thinkingBudget: 0 })
  expect(pages).toEqual([{ title: "Example", url: "https://example.com", text: "Answer." }])
})
