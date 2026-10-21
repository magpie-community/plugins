import { expect, test } from "bun:test"
import { DongleyaAuthPlugin, _internal } from "./index.mjs"

test("normalizes a pasted sign-in token", () => {
  expect(_internal.cleanToken(" Bearer eyJabc ")).toBe("eyJabc")
  expect(_internal.cleanToken("a b")).toBe("")
})

test("maps Dongleya finish reasons to chat completions", () => {
  expect(_internal.mapFinish("completed")).toBe("stop")
  expect(_internal.mapFinish("content_filter")).toBe("content_filter")
})

test("reads a Dongleya SSE event", () => {
  expect(_internal.parseSseBlock('event: text-delta\ndata: {"type":"text-delta","delta":"OK"}')).toEqual({
    type: "text-delta",
    delta: "OK",
  })
})

test("builds the Dongleya request with system text, images and reasoning", () => {
  const request = _internal.buildDongleyaRequest(
    {
      model: "deepseek-v4.1-flash-1017",
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "Answer briefly." },
        {
          role: "user",
          content: [
            { type: "text", text: "Say OK." },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    },
    "eureka_test",
  )
  expect(request.sessionId).toBe("eureka_test")
  expect(request.extra).toEqual({
    model: "deepseek-v4.1-flash-1017",
    reasoningEffort: "high",
  })
  expect(request.messages[0].content).toContain("Answer briefly.")
  expect(request.messages[0].content).toContain("Say OK.")
  expect(request.images).toEqual([{ base64: "AAAA", mimeType: "image/png" }])
})

test("writes an OpenAI chat completion chunk", () => {
  const chunk = _internal.completionChunk("id", 1, "auto", { content: "OK" })
  expect(chunk.object).toBe("chat.completion.chunk")
  expect(chunk.choices[0].delta.content).toBe("OK")
})

test("finds an artifact in a tool result and turns its HTML into a local file", () => {
  const ids = _internal.collectArtifactIds({
    type: "tool-result",
    output: { success: true, artifactId: "ws_test", path: "demo/index.html" },
  })
  expect([...ids]).toEqual(["ws_test"])
  const files = _internal.artifactFiles({
    id: "ws_test",
    title: "纸上的弹球场",
    data: {
      html: "<!doctype html><title>demo</title>",
      workspace: { entry: "纸上的弹球场/纸上的弹球场.html" },
    },
  })
  expect(files.title).toBe("纸上的弹球场")
  expect(files.files[0].name).toBe("纸上的弹球场.html")
  expect(files.files[0].bytes.toString("utf8")).toContain("<!doctype html>")
})

test("loads the OpenCode provider hooks", async () => {
  const hooks = await DongleyaAuthPlugin({
    client: {},
    directory: process.cwd(),
  })
  expect(hooks.auth.provider).toBe("dongleya")
  expect(typeof hooks.auth.loader).toBe("function")
  expect(typeof hooks.provider.models).toBe("function")
  expect(hooks.auth.methods.map((method) => method.type)).toEqual(["api", "oauth"])
  const config = { provider: {} }
  await hooks.config(config)
  expect(config.provider.dongleya.npm).toBe("@ai-sdk/openai-compatible")
  expect(config.provider.dongleya.models.auto).toBeDefined()
})
