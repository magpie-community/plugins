import { afterEach, expect, test } from "bun:test"
import { AstraFlowPlugin } from "./index.mjs"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
const auth = { type: "api", key: "fixture-gemini", metadata: { region: "singapore", protocol: "gemini" } }

test("Gemini discovers only conversational generateContent models with isolated public ids", async () => {
  globalThis.fetch = async (url, init) => {
    expect(url).toBe("https://api-sg.umodelverse.ai/v1beta/models")
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fixture-gemini")
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe("fixture-gemini")
    return Response.json({ models: [
      { name: "models/gemini-fixture", displayName: "Fixture Gemini", supportedActions: ["generateContent"] },
      { baseModelId: "gemini-fixture", supportedActions: ["generateContent"] },
      { name: "models/gemini-image", supportedActions: ["generateContent"] },
      { name: "models/gemini-nano-banana-2.1", supportedActions: ["generateContent"] },
      { name: "models/embed-fixture", supportedActions: ["embedContent"] },
      { name: {}, supportedActions: ["generateContent"] },
    ] })
  }
  const hooks = await AstraFlowPlugin()
  const models = await hooks.provider.models({}, { auth })
  expect(Object.keys(models)).toEqual(["gemini-fixture@gemini"])
  expect(models["gemini-fixture@gemini"].api).toEqual({ id: "gemini-fixture", url: "https://api-sg.umodelverse.ai/v1beta", npm: "@ai-sdk/google" })
})

test("Gemini signs native generation and SSE without buffering or retrying responses", async () => {
  const hooks = await AstraFlowPlugin()
  const loader = await hooks.auth.loader(async () => auth)
  for (const [action, model] of [["generateContent", "gemini-fixture"], ["streamGenerateContent", "publishers/google/models/gemini-fixture"], ["generateContent", "publishers%2Fgoogle%2Fmodels%2Fgemini-fixture"]]) {
    const response = new Response("data: {\"candidates\":[]}\n\n", { headers: { "content-type": "text/event-stream" } })
    const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }], tools: [{ functionDeclarations: [{ name: "weather" }] }] })
    globalThis.fetch = async (request) => {
      expect(request.url).toBe(`${loader.baseURL}/models/${model}:${action}?alt=sse`)
      expect(request.headers.get("x-goog-api-key")).toBe("fixture-gemini")
      expect(request.headers.get("authorization")).toBe("Bearer fixture-gemini")
      expect(request.headers.has("x-api-key")).toBe(false)
      expect(request.redirect).toBe("error")
      expect(await request.text()).toBe(body)
      return response
    }
    const result = await loader.fetch(`${loader.baseURL}/models/${model}:${action}?alt=sse&key=caller`, {
      method: "POST", headers: { "x-goog-api-key": "caller", "x-api-key": "caller" }, body,
    })
    expect(result).toBe(response)
    expect(result.bodyUsed).toBe(false)
  }
  globalThis.fetch = () => { throw new Error("must not reach the network") }
  for (const url of ["https://evil.test/v1beta/models/gemini-fixture:generateContent", loader.baseURL + "/files", loader.baseURL + "/models/x:delete",
    loader.baseURL + "/models/x//y:generateContent", loader.baseURL + "/models/%2E%2E%2Ffiles:generateContent",
    loader.baseURL + "/models/x%252Fy:generateContent", loader.baseURL + "/models/x%:generateContent"]) {
    await expect(loader.fetch(url)).rejects.toThrow("outside the selected endpoint")
  }
})

test("Gemini follows REST pagination and generation methods, with empty pages and deduplicated ids", async () => {
  const pages = []
  globalThis.fetch = async (url, init) => {
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fixture-gemini")
    const page = new URL(url).searchParams.get("pageToken")
    pages.push(page)
    if (page === null) return Response.json({ models: [{ name: "models/google/gemini-fixture", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "second & page" })
    if (page === "second & page") return Response.json({ models: [], nextPageToken: "third" })
    expect(page).toBe("third")
    return Response.json({ models: [
      { baseModelId: "google/gemini-fixture", displayName: "Updated", supportedActions: ["generateContent"] },
      { name: "models/gemini-last", supportedGenerationMethods: ["generateContent"] },
      { name: "models/embedding-fixture", supportedGenerationMethods: ["embedContent"] },
    ] })
  }
  const h = await AstraFlowPlugin()
  const models = await h.provider.models({}, { auth })
  expect(Object.keys(models)).toEqual(["google/gemini-fixture@gemini", "gemini-last@gemini"])
  expect(models["google/gemini-fixture@gemini"].api.id).toBe("google/gemini-fixture")
  expect(pages).toEqual([null, "second & page", "third"])
})

test("Gemini invalid pagination and later-page failure never return a partial catalog", async () => {
  const h = await AstraFlowPlugin()
  for (const nextPageToken of [true, {}, "loop", "x".repeat(8193)]) {
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return Response.json({ models: [{ name: "models/gemini-fixture", supportedActions: ["generateContent"] }], nextPageToken })
    }
    await expect(h.provider.models({}, { auth })).rejects.toThrow("invalid or excessive pagination")
    expect(calls).toBe(nextPageToken === "loop" ? 2 : 1)
  }
  globalThis.fetch = async (url) => new URL(url).searchParams.has("pageToken") ? new Response("outage", { status: 503 }) :
    Response.json({ models: [{ name: "models/gemini-fixture", supportedActions: ["generateContent"] }], nextPageToken: "next" })
  await expect(h.provider.models({}, { auth })).rejects.toThrow("model list HTTP 503")
})
