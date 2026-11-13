import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { ComateAuthPlugin, _internal } from "./index.mjs"

// Every test runs against an in-process fake of comate.baidu.com: global
// fetch is swapped for a router, so nothing reaches the network. The shapes
// are the ones the Comate extension's code reads (BaiduComate.comate 4.14.1:
// comate-engine/server.js and zulu-cli/bundle/index.js).

const LICENSE = "lic-abc+/=1"
let realFetch
let calls
let upstream

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const sse = (frames) =>
  new Response(frames.map((f) => (typeof f === "string" ? f : `data:${JSON.stringify(f)}`) + "\n\n").join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
const answer = (detail) => ({ content: { type: "ANSWER", detail } })

function defaults() {
  return {
    models: [
      { modelId: "auto", displayName: "Auto", provider: null, requestType: "COMATE_DEFAULT_MODE" },
      { modelId: "ernie-x", displayName: "ERNIE X", provider: "BAIDU", supportThinking: true, supportEffort: true, maxContextWindow: 128000, ratio: 1 },
    ],
    conversation: () => json({ code: 200, data: { id: 41 } }),
    task: () => json({ code: 200, data: { taskId: 42 } }),
    execute: () => sse([":heartbeat", answer({ reasoningDelta: "想" }), answer({ delta: "\n你好" }), answer({ delta: "，世界" }), { content: { type: "TOKEN_USAGE", detail: { usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 } } } }, answer({ delta: "", end: true })]),
    valid: () => json({ status: "OK", data: true }),
  }
}

beforeEach(() => {
  _internal.forgetLive()
  calls = []
  upstream = defaults()
  realFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url)
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ path: url.pathname, search: url.search, headers: init.headers ?? {}, body })
    expect(url.origin).toBe("https://comate.baidu.com")
    const p = url.pathname
    if (p === "/api/v2/api/models/available") return json({ status: "OK", data: { reason: "PASS", models: upstream.models } })
    if (p === "/api/aidevops/autocomate/rest/autowork/v2/conversation") return upstream.conversation(body)
    if (p === "/api/aidevops/autocomate/rest/autowork/v2/task") return upstream.task(body)
    if (p === "/api/aidevops/autocomate/rest/autowork/v2/execute") return upstream.execute(body)
    if (p.startsWith("/api/key/valid/")) return upstream.valid(decodeURIComponent(p.slice("/api/key/valid/".length)))
    if (upstream.route) return upstream.route(url, init)
    return json({ status: "NOT_FOUND" }, 404)
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
})

async function provider(auth = { type: "oauth", access: LICENSE, refresh: "", expires: 0 }) {
  const plugin = await ComateAuthPlugin()
  return plugin.auth.loader(async () => auth)
}

const chat = (p, body) => p.fetch("https://comate.baidu.com/chat/completions", { method: "POST", body: JSON.stringify(body) })

async function readSSE(res) {
  const text = await res.text()
  return text
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .map((d) => (d === "[DONE]" ? d : JSON.parse(d)))
}

describe("the wire", () => {
  test("every agent request carries the license the way the client does", async () => {
    const p = await provider()
    const res = await chat(p, { model: "ernie-x", messages: [{ role: "user", content: "hi" }] })
    expect(res.status).toBe(200)
    const steps = calls.filter((c) => c.path.includes("/autowork/"))
    expect(steps.map((c) => c.path.split("/").pop())).toEqual(["conversation", "task", "execute"])
    for (const c of steps) {
      expect(c.headers["login-name"]).toBe(encodeURIComponent(LICENSE))
      expect(c.headers["Uuap-login-name"]).toBe(encodeURIComponent(LICENSE))
      expect(c.headers["X-Source"]).toBe("COMATE")
      expect(c.headers["plugin-version"]).toBe("zulucli-1.7.16")
      expect(c.headers["x-skip-fcnap"]).toBe("yes")
      expect(c.body).toMatchObject({ username: LICENSE, ide: "zulucli", ideVersion: "1.7.16", pluginVersion: "1.7.16" })
    }
    // one trace id across the turn's three steps
    expect(new Set(steps.map((c) => c.headers["X-Trace-Id"])).size).toBe(1)
  })

  test("execute names the task, the model and a custom agent with no Comate tools", async () => {
    const p = await provider()
    await chat(p, {
      model: "ernie-x",
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hi" },
      ],
    })
    const task = calls.find((c) => c.path.endsWith("/task")).body
    expect(task).toMatchObject({ conversationId: 41, agentInfo: { isProjectAgent: true } })
    const ex = calls.find((c) => c.path.endsWith("/execute")).body
    expect(ex).toMatchObject({
      conversationId: 41,
      taskId: 42,
      query: "hi",
      modelKey: "ernie-x",
      modelProvider: "BAIDU",
      thinkingEnabled: true,
      effort: "high",
      contextWindow: 128000,
      isUserQuery: true,
      isFirstQuery: true,
      agentVersion: 12,
      agentInfo: { isProjectAgent: true, agentPrompt: "Be brief.", tools: [] },
    })
    // a project agent goes without an agentId, as the client sends it
    expect("agentId" in ex).toBe(false)
  })

  test("the prompt sent upstream names neither magpie nor the vendor", async () => {
    const p = await provider()
    await chat(p, { model: "auto", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }, { role: "user", content: "again" }], tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }] })
    const ex = calls.find((c) => c.path.endsWith("/execute")).body
    const sent = JSON.stringify({ q: ex.query, a: ex.agentInfo })
    expect(sent).not.toMatch(/magpie|comate|文心|baidu/i)
  })
})

describe("answers", () => {
  test("non-streaming: deltas joined, leading newlines trimmed, reasoning and usage kept", async () => {
    const p = await provider()
    const res = await chat(p, { model: "ernie-x", messages: [{ role: "user", content: "hi" }] })
    const body = await res.json()
    expect(body.choices[0].message).toEqual({ role: "assistant", content: "你好，世界", reasoning_content: "想" })
    expect(body.choices[0].finish_reason).toBe("stop")
    expect(body.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 4 } })
  })

  test("streaming: OpenAI chunks, then stop and [DONE]", async () => {
    const p = await provider()
    const res = await chat(p, { model: "ernie-x", stream: true, messages: [{ role: "user", content: "hi" }] })
    expect(res.headers.get("content-type")).toBe("text/event-stream")
    const frames = await readSSE(res)
    expect(frames.at(-1)).toBe("[DONE]")
    const content = frames.filter((f) => f !== "[DONE]").map((f) => f.choices[0].delta.content ?? "").join("")
    expect(content).toBe("你好，世界")
    const reasoning = frames.filter((f) => f !== "[DONE]").map((f) => f.choices[0].delta.reasoning_content ?? "").join("")
    expect(reasoning).toBe("想")
    expect(frames.at(-2).choices[0].finish_reason).toBe("stop")
    expect(frames.at(-2).usage.total_tokens).toBe(13)
  })

  test("a JSON tool-call reply becomes OpenAI tool_calls", async () => {
    upstream.execute = () => sse([answer({ delta: '{"tool_calls":[{"name":"read","arguments":{"path":"a.txt"}}]}' })])
    const p = await provider()
    const tools = [{ type: "function", function: { name: "Read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }]
    const res = await chat(p, { model: "auto", messages: [{ role: "user", content: "read a.txt" }], tools })
    const body = await res.json()
    expect(body.choices[0].finish_reason).toBe("tool_calls")
    expect(body.choices[0].message.tool_calls[0].function).toEqual({ name: "Read", arguments: '{"path":"a.txt"}' })
    // the instruction rides in the agent's prompt and the query both
    const ex = calls.find((c) => c.path.endsWith("/execute")).body
    expect(ex.agentInfo.agentPrompt).toContain('{"tool_calls"')
    expect(ex.query).toContain("[User]\nread a.txt")
  })

  test("a forced tool_choice gets one retry with the failed reply in view", async () => {
    let n = 0
    upstream.execute = () => sse([answer({ delta: n++ === 0 ? "I will read it." : '{"tool_calls":[{"name":"Read","arguments":{"path":"a"}}]}' })])
    const p = await provider()
    const tools = [{ type: "function", function: { name: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } } }]
    const res = await chat(p, { model: "auto", stream: true, tool_choice: "required", messages: [{ role: "user", content: "go" }], tools })
    const frames = (await readSSE(res)).filter((f) => f !== "[DONE]")
    expect(frames.some((f) => f.choices[0].delta.tool_calls)).toBe(true)
    expect(frames.some((f) => f.choices[0].delta.content)).toBe(false)
    const second = calls.filter((c) => c.path.endsWith("/execute"))[1].body
    expect(second.query).toContain("[Assistant]\nI will read it.")
  })

  test("tool results and earlier calls are written into the query, not dropped", () => {
    const { query } = _internal.buildTurn(
      [
        { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "Read", arguments: '{"path":"a"}' } }] },
        { role: "tool", tool_call_id: "c1", content: "file body" },
      ],
      undefined,
      undefined,
    )
    expect(query).toContain('Tool call requested: Read {"path":"a"}')
    expect(query).toContain("[Tool result for c1]\nfile body")
  })

  test("images are refused, not dropped", async () => {
    const p = await provider()
    const res = await chat(p, { model: "auto", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }] })
    expect(res.status).toBe(400)
    expect(calls.length).toBe(0)
  })
})

describe("refusals", () => {
  test("code 401 is a lost sign-in (401), before any stream", async () => {
    upstream.conversation = () => json({ code: 401, message: "当前License信息无效" })
    const p = await provider()
    const res = await chat(p, { model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] })
    expect(res.status).toBe(401)
    expect((await res.json()).error.message).toContain("当前License信息无效")
  })

  test("code 429 at conversation is over the limit (429)", async () => {
    upstream.conversation = () => json({ code: 429, message: "资源使用超过限制" })
    const p = await provider()
    const res = await chat(p, { model: "auto", messages: [{ role: "user", content: "hi" }] })
    expect(res.status).toBe(429)
  })

  test("QUOTA_EXCEED in the stream is a 429 when it comes first", async () => {
    upstream.execute = () => sse([{ content: { type: "QUOTA_EXCEED", detail: { message: "今日额度已用完" } } }])
    const p = await provider()
    const res = await chat(p, { model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] })
    expect(res.status).toBe(429)
    expect((await res.json()).error.message).toContain("今日额度已用完")
  })

  test("EXCEPTION after text is an error frame, then [DONE]", async () => {
    upstream.execute = () => sse([answer({ delta: "半句" }), { content: { type: "EXCEPTION", detail: { exceptionMsg: "boom" } } }])
    const p = await provider()
    const res = await chat(p, { model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] })
    const frames = await readSSE(res)
    expect(frames.at(-1)).toBe("[DONE]")
    expect(frames.at(-2).error.message).toContain("boom")
  })

  test("execute answering JSON instead of a stream is read as its refusal", async () => {
    upstream.execute = () => json({ code: 401, message: "当前License信息无效" })
    const p = await provider()
    const res = await chat(p, { model: "auto", messages: [{ role: "user", content: "hi" }] })
    expect(res.status).toBe(401)
  })

  test("an unknown model is a 400 naming the known ones", async () => {
    const p = await provider()
    const res = await chat(p, { model: "nope", messages: [{ role: "user", content: "hi" }] })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain("ernie-x")
  })

  test("no license is a 401 with no request made", async () => {
    const p = await provider({})
    const res = await chat(p, { model: "auto", messages: [{ role: "user", content: "hi" }] })
    expect(res.status).toBe(401)
    expect(calls.length).toBe(0)
  })
})

describe("models", () => {
  test("the account's list, read the way the CLI reads it", async () => {
    const plugin = await ComateAuthPlugin()
    const models = await plugin.provider.models({ models: {} }, { auth: { type: "oauth", access: LICENSE } })
    expect(models).toEqual({ auto: { name: "Auto" }, "ernie-x": { name: "ERNIE X", rate: 1 } })
    const c = calls.find((x) => x.path === "/api/v2/api/models/available")
    expect(c.body).toEqual({ username: LICENSE, type: "ZULU", rootRepo: "", submodules: [], zuluVersion: "1.7.16", source: "cli", ideType: "zulucli" })
  })

  test("a failed list leaves the configured models", async () => {
    upstream.models = null
    const plugin = await ComateAuthPlugin()
    expect(await plugin.provider.models({ models: { auto: { name: "Auto" } } }, { auth: { type: "oauth", access: LICENSE } })).toEqual({ auto: { name: "Auto" } })
  })

  test("config adds the provider with Auto and keeps the user's own models", async () => {
    const plugin = await ComateAuthPlugin()
    const config = { provider: { comate: { models: { mine: { name: "Mine" } } } } }
    await plugin.config(config)
    expect(config.provider.comate.models).toEqual({ auto: { name: "Auto" }, mine: { name: "Mine" } })
    expect(config.provider.comate.api).toBe("https://comate.baidu.com")
  })
})

describe("sign-in and usage", () => {
  test("web sign-in: the CLI's login page, then token, then license", async () => {
    let polls = 0
    upstream.route = (url, init) => {
      if (url.pathname === "/api/client/logout") return json({ status: "OK" })
      if (url.pathname === "/api/client/generate/token") return ++polls < 2 ? json({ status: "BAD_REQUEST", message: "未找到客户端信息" }, 400) : json({ status: "OK", data: "tok-1" })
      if (url.pathname === "/api/client/key") {
        expect(init.headers.token).toBe("tok-1")
        return json({ status: "OK", data: { key: LICENSE, displayName: "张三" } })
      }
    }
    const plugin = await ComateAuthPlugin()
    const flow = await plugin.auth.methods[0].authorize()
    const u = new URL(flow.url)
    expect(u.origin + u.pathname).toBe("https://comate.baidu.com/zh/login")
    expect(u.searchParams.get("track")).toBe("COMATE_CLI")
    const clientId = u.searchParams.get("clientId")
    expect(clientId).toMatch(/^[0-9a-f-]{36}$/)
    const done = await flow.callback()
    expect(done).toEqual({ type: "success", refresh: "", access: LICENSE, expires: 0, accountId: "张三", source: "web" })
    expect(calls.filter((c) => c.path === "/api/client/generate/token").every((c) => c.search === `?clientId=${clientId}`)).toBe(true)
  }, 15_000)

  test("a pasted license is checked first", async () => {
    upstream.valid = () => json({ status: "FORBIDDEN", message: "当前license无效", data: false })
    const plugin = await ComateAuthPlugin()
    const flow = await plugin.auth.methods[1].authorize({ license: " bad " })
    expect(await flow.callback()).toEqual({ type: "failed", error: "当前license无效" })
    expect(calls[0].path).toBe("/api/key/valid/bad")
  })

  test("usage: a refused license is expired, a held one has no sign-in mark", async () => {
    const plugin = await ComateAuthPlugin()
    const auth = async () => ({ type: "oauth", access: LICENSE })
    expect(await plugin.auth.usage(auth)).toEqual({ plan: "文心快码 Comate", windows: [] })
    upstream.valid = () => json({ status: "FORBIDDEN", message: "当前license无效", data: false })
    expect((await plugin.auth.usage(auth)).signIn).toBe("expired")
    upstream.valid = () => json({ status: "ERROR" }, 503)
    expect((await plugin.auth.usage(auth)).signIn).toBe("kept")
  })
})
