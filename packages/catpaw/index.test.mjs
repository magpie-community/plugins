import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { CatPawAuthPlugin, _internal } from "./index.mjs"
import { fakeCatPaw } from "./fake.mjs"
import capturedRound from "./testdata/captured-round.json"
import capturedTurn from "./testdata/captured-turn.json"
import issue605 from "./testdata/issue-605.json"

// every test runs against the fake upstream in fake.mjs: no network, no real
// token ever leaves this process. The upstream base is monkey-patched because
// CatPaw's is a module constant (the origin is fixed by the vendor).

let fake
let plugin
let saved = {}
let tmpDir
const client = { auth: { set: async ({ body }) => (saved = body) } }
const getAuth = async () => saved

beforeAll(async () => {
  fake = fakeCatPaw()
  tmpDir = mkdtempSync(join(tmpdir(), "catpaw-auth-test-"))
  // point the desktop auth path at a fake auth.json
  const authPath = join(tmpDir, "auth.json")
  writeFileSync(authPath, JSON.stringify({ auth: { accessToken: fake.state.token }, account: { uid: "u1", name: "Tester" } }))
  process.env.CATPAW_AUTH_PATH = authPath
  // the credit balance is a separate host in the vendor; point it at the fake
  process.env.CATPAW_BALANCE_URL = `${fake.url}/api/gateway/credit/balance`
  // replace the origin with the fake server
  // the plugin reads ORIGIN at call time only inside gatewayHeaders/fetch, so
  // monkey-patching the global fetch to route to the fake works: we swap the
  // global fetch for one that rewrites the URL host to the fake server
  const realFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const patched = url.replace("https://ai.catpaw.meituan.com", fake.url).replace("https://catx.nocode.cn", fake.url)
    return realFetch(patched, init)
  }
  plugin = await CatPawAuthPlugin({ client })
})

afterAll(() => {
  fake.server.stop(true)
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  fake.state.reset()
  saved = { type: "oauth", access: fake.state.token, expires: 0, source: "desktop", accountId: "Tester" }
})

describe("config", () => {
  test("lists the desktop client's models", async () => {
    const cfg = {}
    await plugin.config(cfg)
    expect(cfg.provider.catpaw.name).toBe("妙手 CatPaw")
    const ids = Object.keys(cfg.provider.catpaw.models)
    expect(ids).toContain("longcat-2.0")
    expect(ids).toContain("kimi-k3")
    expect(ids).toContain("glm-5.3-flash")
    // no modalities and no invented limit: the text-only conversation prompt
    // takes no images, and the client publishes no per-model windows
    expect(cfg.provider.catpaw.models["longcat-2.0"].modalities).toBeUndefined()
    expect(cfg.provider.catpaw.models["longcat-2.0"].limit).toBeUndefined()
  })
})

describe("sign-in methods", () => {
  test("reads the desktop client's auth.json live", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("桌面端"))
    expect(method).toBeTruthy()
    const flow = method.authorize()
    expect(flow.method).toBe("auto")
    const result = await flow.callback()
    expect(result.type).toBe("success")
    expect(result.access).toBe(fake.state.token)
    expect(result.source).toBe("desktop")
    expect(result.uid).toBe("u1")
  })

  test("manual paste works through the host's authorize → callback contract", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("Paste"))
    const flow = await method.authorize({ token: "pasted-token" })
    expect(flow.method).toBe("auto")
    expect(typeof flow.callback).toBe("function")
    const result = await flow.callback()
    expect(result.type).toBe("success")
    expect(result.access).toBe("pasted-token")
    expect(await method.authorize({ token: "" })).toMatchObject({ type: "failed" })
  })

  test("web sign-in: login-config names the entry, poll-token hands the token once claimed", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("Web sign-in"))
    expect(method).toBeTruthy()
    const flow = await method.authorize()
    expect(flow.method).toBe("auto")
    expect(flow.url).toContain("state=")
    expect(flow.url).toContain("sid=")
    expect(flow.url).toContain("redirect=")
    // the sid is not claimed yet: arm it one poll in (the callback polls
    // every second, so the token appears on its second pass)
    const sid = new URL(flow.url).searchParams.get("sid")
    const cb = flow.callback()
    await new Promise((r) => setTimeout(r, 1200))
    fake.state.webSids.set(sid, "web-cat-token")
    const result = await cb
    expect(result.type).toBe("success")
    expect(result.access).toBe("web-cat-token")
    expect(result.source).toBe("web")
    expect(result.accountId).toBe("网页用户")
    expect(result.uid).toBe("42")
    expect(fake.state.pollCalls).toBeGreaterThanOrEqual(2)
    expect(fake.state.currentUserCalls).toBe(1)
  })
})

describe("chat", () => {
  test("round → event → turn, cumulative frames diffed to deltas", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    // the deltas build up the answer
    expect(text).toContain('"content":"你"')
    expect(text).toContain('"content":"好"')
    expect(text).toContain('"content":"，"')
    expect(text).toContain('"content":"收到"')
    // reasoning is diffed too
    expect(text).toContain('"reasoning_content":"思"')
    expect(text).toContain('"reasoning_content":"考"')
    // the stream ends with stop + [DONE]
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain("data: [DONE]")
    // the conversation machine ran all three steps in order
    expect(fake.state.rounds).toBe(1)
    expect(fake.state.events).toBe(1)
    expect(fake.state.turns).toBe(1)
    expect(fake.state.conversations[0].prompt).toBe("hi")
    expect(fake.state.conversations[0].modelType).toBe(77)
  })

  test("non-stream returns the full answer", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "kimi-k3", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    const answer = await res.json()
    expect(answer.model).toBe("kimi-k3")
    expect(answer.choices[0].message.content).toBe("你好，收到")
    expect(answer.choices[0].message.reasoning_content).toBe("思考")
    expect(answer.choices[0].finish_reason).toBe("stop")
    expect(fake.state.conversations[0].modelType).toBe(83)
  })

  test("multi-turn messages flatten into one prompt", async () => {
    const loader = await plugin.auth.loader(getAuth)
    await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        stream: false,
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "q2" },
        ],
      }),
    })
    expect(fake.state.conversations[0].prompt).toContain("[System Instructions]\nbe terse")
    expect(fake.state.conversations[0].prompt).toContain("[User]\nq1")
    expect(fake.state.conversations[0].prompt).toContain("[Assistant]\na1")
    expect(fake.state.conversations[0].prompt).toContain("[User]\nq2")
  })

  test("a single user message passes as-is", async () => {
    const loader = await plugin.auth.loader(getAuth)
    await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "auto", stream: false, messages: [{ role: "user", content: "just this" }] }),
    })
    expect(fake.state.conversations[0].prompt).toBe("just this")
    expect(fake.state.conversations[0].modelType).toBe(0)
  })

  test("an SSE error frame surfaces as an error chunk", async () => {
    fake.state.turnError = "sse-error"
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    const text = await res.text()
    expect(text).toContain('"error"')
    expect(text).toContain("vendor broke")
  })

  test("a tool request is answered with parsed tool_calls (non-stream)", async () => {
    const callText = JSON.stringify({ tool_calls: [{ name: "Bash", arguments: { command: "ls" } }] })
    fake.state.turnFramesQueue = [
      [
        { message: { content: [{ type: "text", text: callText }] } },
        { message: { content: [{ type: "text", text: callText }] }, finished: true },
      ],
    ]
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        messages: [{ role: "user", content: "list the files" }],
        tools: [{ type: "function", function: { name: "Bash", description: "run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.choices[0].finish_reason).toBe("tool_calls")
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("Bash")
    expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)).toEqual({ command: "ls" })
    // the instruction rode in the flattened prompt
    expect(fake.state.conversations.at(-1).prompt).toContain("Bash")
    expect(fake.state.rounds).toBe(1)
  })

  test("tool results ride as text instead of a 400", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        messages: [
          { role: "user", content: "list the files" },
          { role: "assistant", tool_calls: [{ id: "c1", function: { name: "Bash", arguments: "{\"command\":\"ls\"}" } }] },
          { role: "tool", tool_call_id: "c1", content: "a.txt" },
        ],
        tools: [{ type: "function", function: { name: "Bash" } }],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.choices[0].message.content).toBeTruthy()
    expect(fake.state.conversations.at(-1).prompt).toContain("Tool result")
  })

  test("tool_choice=required retries once when the reply has no call", async () => {
    const callText = JSON.stringify({ tool_calls: [{ name: "Bash", arguments: { command: "ls" } }] })
    fake.state.turnFramesQueue = [
      [{ message: { content: [{ type: "text", text: "我直接说明一下" }] }, finished: true }],
      [{ message: { content: [{ type: "text", text: callText }] }, finished: true }],
    ]
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        messages: [{ role: "user", content: "run ls" }],
        tools: [{ type: "function", function: { name: "Bash" } }],
        tool_choice: "required",
      }),
    })
    const body = await res.json()
    expect(fake.state.rounds).toBe(2)
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("Bash")
  })

  test("tool_choice none keeps the plain passthrough", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "Bash" } }],
        tool_choice: "none",
      }),
    })
    expect(res.status).toBe(200)
    expect(fake.state.rounds).toBe(1)
    expect(fake.state.conversations.at(-1).prompt).not.toContain("Available tools")
  })

  test("a streaming tool request synthesizes tool_calls deltas", async () => {
    const callText = JSON.stringify({ tool_calls: [{ name: "Bash", arguments: { command: "ls" } }] })
    fake.state.turnFramesQueue = [
      [
        { message: { content: [{ type: "text", text: callText }] } },
        { message: { content: [{ type: "text", text: callText }] }, finished: true },
      ],
    ]
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        messages: [{ role: "user", content: "list the files" }],
        tools: [{ type: "function", function: { name: "Bash" } }],
        stream: true,
      }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"tool_calls"')
    expect(text).toContain('"finish_reason":"tool_calls"')
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true)
  })

  test("a streaming tool request with a prose reply streams content, not tool_calls", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "Bash" } }],
        stream: true,
      }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    // deltas流式逐字输出，逐字断言而不是拼好的整句
    expect(text).toContain("收到")
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).not.toContain('"tool_calls"')
  })

  test("streaming + tool_choice=required + prose twice: the retry runs, then text goes out as text", async () => {
    fake.state.turnFramesQueue = [
      [{ message: { content: [{ type: "text", text: "我直接说明" }] }, finished: true }],
      [{ message: { content: [{ type: "text", text: "我还是直接说明吧" }] }, finished: true }],
    ]
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        messages: [{ role: "user", content: "run ls" }],
        tools: [{ type: "function", function: { name: "Bash" } }],
        stream: true,
        tool_choice: "required",
      }),
    })
    const text = await res.text()
    expect(fake.state.rounds).toBe(2)
    expect(text).toContain("我还是直接说明吧")
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).not.toContain('"tool_calls"')
    // the failed first reply rides along so the retry can refer to it
    const second = fake.state.conversations.at(-1).prompt
    expect(second).toContain("我直接说明")
    expect(second).toContain("did not include a valid tool call")
  })

  test("a truncated JSON head in streaming still flushes as content", async () => {
    fake.state.turnFramesQueue = [
      [
        { message: { content: [{ type: "text", text: '{"tool_calls":[{"name":"Bash"' }] } },
        { message: { content: [{ type: "text", text: '{"tool_calls":[{"name":"Bash"' }] }, finished: true },
      ],
    ]
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        messages: [{ role: "user", content: "list files" }],
        tools: [{ type: "function", function: { name: "Bash" } }],
        stream: true,
      }),
    })
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).not.toContain('"finish_reason":"tool_calls"')
  })

  test("multiple calls in one reply all come out", async () => {
    const callText = JSON.stringify({ tool_calls: [{ name: "Bash", arguments: { command: "ls" } }, { name: "Bash", arguments: { command: "pwd" } }] })
    fake.state.turnFramesQueue = [
      [
        { message: { content: [{ type: "text", text: callText }] } },
        { message: { content: [{ type: "text", text: callText }] }, finished: true },
      ],
    ]
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        messages: [{ role: "user", content: "ls and pwd" }],
        tools: [{ type: "function", function: { name: "Bash" } }],
      }),
    })
    const body = await res.json()
    expect(body.choices[0].message.tool_calls.length).toBe(2)
    expect(JSON.parse(body.choices[0].message.tool_calls[1].function.arguments)).toEqual({ command: "pwd" })
  })

  test("an unknown tool name is dropped, not answered as text", async () => {
    const callText = JSON.stringify({ tool_calls: [{ name: "TotallyUnknown", arguments: {} }] })
    fake.state.turnFramesQueue = [
      [
        { message: { content: [{ type: "text", text: callText }] } },
        { message: { content: [{ type: "text", text: callText }] }, finished: true },
      ],
    ]
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "Bash" } }],
      }),
    })
    const body = await res.json()
    expect(body.choices[0].finish_reason).toBe("stop")
    expect(body.choices[0].message.content).toContain("TotallyUnknown")
  })

  test("a drifted name case is matched back to the declaration", async () => {
    const callText = JSON.stringify({ tool_calls: [{ name: "bash", arguments: { command: "ls" } }] })
    fake.state.turnFramesQueue = [
      [
        { message: { content: [{ type: "text", text: callText }] } },
        { message: { content: [{ type: "text", text: callText }] }, finished: true },
      ],
    ]
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        messages: [{ role: "user", content: "ls" }],
        tools: [{ type: "function", function: { name: "Bash" } }],
      }),
    })
    const body = await res.json()
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("Bash")
  })

  test("a named tool_choice whose reply calls another tool gets the retry", async () => {
    const wrongText = JSON.stringify({ tool_calls: [{ name: "Unknown", arguments: {} }] })
    const rightText = JSON.stringify({ tool_calls: [{ name: "Bash", arguments: { command: "ls" } }] })
    fake.state.turnFramesQueue = [
      [{ message: { content: [{ type: "text", text: wrongText }] } }, { message: { content: [{ type: "text", text: wrongText }] }, finished: true }],
      [{ message: { content: [{ type: "text", text: rightText }] } }, { message: { content: [{ type: "text", text: rightText }] }, finished: true }],
    ]
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        messages: [{ role: "user", content: "run ls" }],
        tools: [{ type: "function", function: { name: "Bash" } }],
        tool_choice: { type: "function", function: { name: "Bash" } },
      }),
    })
    const body = await res.json()
    expect(fake.state.rounds).toBe(2)
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("Bash")
  })

  test("a bare object without arguments is an answer, not a call", async () => {
    fake.state.turnFramesQueue = [
      [
        { message: { content: [{ type: "text", text: '{"name":"Bash"}' }] } },
        { message: { content: [{ type: "text", text: '{"name":"Bash"}' }] }, finished: true },
      ],
    ]
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "Bash" } }],
      }),
    })
    const body = await res.json()
    expect(body.choices[0].finish_reason).toBe("stop")
    expect(body.choices[0].message.content).toContain('"name":"Bash"')
  })

  test("a quoted example inside prose is not a call", async () => {
    fake.state.turnFramesQueue = [
      [
        { message: { content: [{ type: "text", text: '可以用 Bash，例如 {"name":"Bash","arguments":{"command":"rm -rf x"}} 之类' }] } },
        { message: { content: [{ type: "text", text: '可以用 Bash，例如 {"name":"Bash","arguments":{"command":"rm -rf x"}} 之类' }] }, finished: true },
      ],
    ]
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "Bash" } }],
      }),
    })
    const body = await res.json()
    expect(body.choices[0].finish_reason).toBe("stop")
    expect(body.choices[0].message.content).toContain("例如")
  })

  test("a call missing a required arg is dropped", async () => {
    const callText = JSON.stringify({ tool_calls: [{ name: "Bash", arguments: {} }] })
    fake.state.turnFramesQueue = [
      [
        { message: { content: [{ type: "text", text: callText }] } },
        { message: { content: [{ type: "text", text: callText }] }, finished: true },
      ],
    ]
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }],
      }),
    })
    const body = await res.json()
    expect(body.choices[0].finish_reason).toBe("stop")
    expect(body.choices[0].message.content).toContain("tool_calls")
  })

  test("a call JSON split across cumulative frames still becomes a call", async () => {
    // frame 1 cuts mid-token — the head-hold in the streaming tool path
    // exists for exactly this shape
    const whole = JSON.stringify({ tool_calls: [{ name: "Bash", arguments: { command: "ls" } }] })
    fake.state.turnFramesQueue = [
      [
        { message: { content: [{ type: "text", text: whole.slice(0, 19) }] } },
        { message: { content: [{ type: "text", text: whole }] }, finished: true },
      ],
    ]
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "longcat-2.0",
        messages: [{ role: "user", content: "list files" }],
        tools: [{ type: "function", function: { name: "Bash" } }],
        stream: true,
      }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"finish_reason":"tool_calls"')
    expect(text).toContain('"name":"Bash"')
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true)
  })

  test("the keep-alive interval is torn down when the agent cancels mid-turn", async () => {
    fake.state.turnFramesQueue = [
      [
        { message: { content: [{ type: "text", text: "你" }] } },
        { message: { content: [{ type: "text", text: "你好" }] }, finished: true },
      ],
    ]
    fake.state.turnDelayMs = 400
    let created = 0
    let cleared = 0
    const origSet = globalThis.setInterval
    const origClear = globalThis.clearInterval
    globalThis.setInterval = (fn, ms) => {
      created++
      return origSet(fn, ms)
    }
    globalThis.clearInterval = (t) => {
      cleared++
      return origClear(t)
    }
    try {
      const loader = await plugin.auth.loader(getAuth)
      const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          model: "longcat-2.0",
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "function", function: { name: "Bash" } }],
          stream: true,
        }),
      })
      const reader = res.body.getReader()
      await reader.read() // the role frame, then cancel mid-turn
      await reader.cancel()
      // the next delta arrives after the fake's delay; the push that hits a
      // cancelled stream is where the interval must be cleared
      await new Promise((r) => setTimeout(r, 800))
      expect(created).toBeGreaterThanOrEqual(1)
      expect(cleared).toBeGreaterThanOrEqual(created)
    } finally {
      globalThis.setInterval = origSet
      globalThis.clearInterval = origClear
    }
  })

  test("tool results ride as text, images are refused", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const toolRes = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", messages: [{ role: "user", content: "hi" }, { role: "tool", content: "result" }] }),
    })
    expect(toolRes.status).toBe(200)
    const imgRes = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", messages: [{ role: "user", content: [{ type: "image", image_url: { url: "data:image/png;base64,AAAA" } }] }] }),
    })
    expect(imgRes.status).toBe(400)
    expect((await imgRes.json()).error.message).toContain("cannot take images")
  })

  test("the OpenAI image shapes (image_url, input_image) are refused too", async () => {
    const loader = await plugin.auth.loader(getAuth)
    for (const type of ["image_url", "input_image"]) {
      const res = await loader.fetch(`${fake.url}/api/agent/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          model: "longcat-2.0",
          messages: [{ role: "user", content: [{ type: "text", text: "看这张图" }, { type, image_url: { url: "https://example.com/x.png" } }] }],
        }),
      })
      expect(res.status).toBe(400)
      expect((await res.json()).error.message).toContain("cannot take images")
    }
  })

  test("unknown model is rejected", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "not-a-model", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(400)
  })

  test("a web sign-in spends its own token, without any auth.json on the machine", async () => {
    // the desktop file moves away entirely: the web sign-in must not need it
    const was = process.env.CATPAW_AUTH_PATH
    process.env.CATPAW_AUTH_PATH = join(tmpDir, "absent-web-test.json")
    // sign in through the web flow itself: the sid is claimed, poll-token
    // hands out its token, and that account is what chats
    const webMethod = plugin.auth.methods.find((m) => m.label.includes("Web sign-in"))
    const flow = await webMethod.authorize()
    const sid = new URL(flow.url).searchParams.get("sid")
    fake.state.webSids.set(sid, "web-tok-1")
    const signedIn = await flow.callback()
    expect(signedIn.type).toBe("success")
    saved = { type: "oauth", access: signedIn.access, refresh: "", expires: 0, accountId: signedIn.accountId, name: signedIn.accountId, source: "web" }
    try {
      const loader = await plugin.auth.loader(getAuth)
      const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "longcat-2.0", stream: false, messages: [{ role: "user", content: "hi" }] }),
      })
      expect(res.status).toBe(200)
      // the request went out under the web account's token, not the
      // desktop file's, and the card shows the web account's name
      expect(fake.state.conversations[0].token).toBe("web-tok-1")
      // the conversation body fields are the client's captured protocol
      expect(fake.state.conversations[0].permissionMode).toBe(capturedRound.bodyProtocol.permissionMode)
      const usage = await plugin.auth.usage(getAuth)
      expect(usage.error).toBeUndefined()
      expect(usage.user).toBe("网页用户")
      expect(usage.windows[0].display).toContain("credit")
    } finally {
      process.env.CATPAW_AUTH_PATH = was
    }
  })

  test("the desktop account and a web account never cross: A's request is not spent on B", async () => {
    // the desktop file holds the fake's own token; account A signed in on
    // the web with a different one — A's chat must carry A's token
    const webMethod = plugin.auth.methods.find((m) => m.label.includes("Web sign-in"))
    const flow = await webMethod.authorize()
    const sid = new URL(flow.url).searchParams.get("sid")
    fake.state.webSids.set(sid, "acct-A-token")
    const signedIn = await flow.callback()
    expect(signedIn.type).toBe("success")
    saved = { type: "oauth", access: signedIn.access, refresh: "", expires: 0, accountId: signedIn.accountId, name: signedIn.accountId, source: "web" }
    const loader = await plugin.auth.loader(getAuth)
    await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(fake.state.conversations[0].token).toBe("acct-A-token")
  })

  test("a refused token says 401", async () => {
    saved = { type: "oauth", access: "gone", expires: 0, source: "manual" }
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(401)
    const answer = await res.json().catch(() => null)
    expect(answer?.error?.message ?? "").toMatch(/round 失败/)
  })

  test("only chat completions are served", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/embeddings", { method: "POST", body: "{}" })
    expect(res.status).toBe(404)
  })
})

describe("usage", () => {
  // the credit endpoint takes `X-Auth-Token`, not the conversation gateway's
  // `Cookie: X-Passport-Token`: sending the cookie there answers 401 / code
  // 4010, which magpie reads as the sign-in having expired
  test("reads the credit balance with X-Auth-Token", async () => {
    const usage = await plugin.auth.usage(getAuth)
    // a clean read says nothing about the sign-in: that absence is what lets
    // magpie clear a lapse (a "kept" here would leave the mark on forever)
    expect(usage.signIn).toBeUndefined()
    expect(usage.windows[0].display).toBe("1134.67 credit")
    expect(usage.plan).toBe("体验版")
    expect(fake.state.balanceCalls).toBe(1)
  })

  test("a refused token says the sign-in expired", async () => {
    saved = { type: "oauth", access: "not-the-token", expires: 0, source: "manual" }
    const usage = await plugin.auth.usage(getAuth)
    expect(usage.signIn).toBe("expired")
    expect(usage.error).toContain("重新登录")
  })

  test("a missing desktop file is not the sign-in expiring", async () => {
    const was = process.env.CATPAW_AUTH_PATH
    process.env.CATPAW_AUTH_PATH = join(tmpDir, "absent.json")
    try {
      const usage = await plugin.auth.usage(getAuth)
      expect(usage.signIn).toBe("kept")
      expect(usage.error).toContain("未找到妙手登录态文件")
    } finally {
      process.env.CATPAW_AUTH_PATH = was
    }
  })
})

describe("captured protocol", () => {
  test("gatewayHeaders matches the captured client headers key for key", () => {
    // _internal doesn't expose gatewayHeaders directly; build one through
    // the only place its shape is fully visible — reconstruct from source is
    // fragile, so compare against the exported header set instead
    const captured = capturedRound.headers
    const ours = _internal.gatewayHeadersForTest("tok")
    // every header the client sent, our request sends too — with the same
    // value where the value is a constant, and the same shape where it is
    // per-request random (the trace ids)
    // the base set (what gatewayHeaders returns) plus what fetch adds and
    // what the round route's extraHeaders carry — together they must cover
    // every header the client sent
    const roundExtras = { "m-spanid": "0.2", "m-spanname": "conversation.round" }
    const combined = { accept: "application/json, text/plain, */*", ...ours, ...roundExtras }
    for (const [key, value] of Object.entries(captured)) {
      const lower = key.toLowerCase()
      if (lower === "m-host") {
        // the client machine's LAN IP: deliberately not sent (see index.mjs)
        expect(ours).not.toHaveProperty("m-host")
        continue
      }
      if (["accept-encoding", "content-length"].includes(lower)) continue // transport-level
      const oursKey = Object.keys(combined).find((k) => k.toLowerCase() === lower)
      expect(oursKey, key).toBeTruthy()
      if (["m-traceid", "x-request-id", "x-trace-id"].includes(lower)) {
        expect(String(combined[key])).toMatch(/^[0-9a-f-]{32,36}$/)
      } else {
        expect(String(combined[oursKey]), key).toBe(String(value))
      }
    }
    expect(ours["m-traceid"]).toBe(ours["x-trace-id"])
  })

  test("the round body carries the captured protocol fields", async () => {
    const loader = await plugin.auth.loader(getAuth)
    await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "longcat-2.0", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    const sent = fake.state.conversations[0]
    expect(sent.permissionMode).toBe(capturedRound.bodyProtocol.permissionMode)
    // source/mode are not the capture's any more: the gateway turned the
    // captured CatPawCLI off (plugins#605), see the "source" tests below
    expect(sent.source).toBe(issue605.served.source)
    expect(sent.mode).toBe(issue605.served.mode)
  })

  test("the captured turn request carries the same permissionMode", () => {
    expect(capturedTurn.bodyProtocol.permissionMode).toBe(capturedRound.bodyProtocol.permissionMode)
    expect(capturedRound.headers["user-agent"]).toBe(capturedTurn.headers["user-agent"])
  })
})

describe("source (plugins#605)", () => {
  const chat = async (stream) => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "glm-5.3-flashx", stream, messages: [{ role: "user", content: "hi" }] }),
    })
    return { status: res.status, text: await res.text() }
  }

  test("the fake refuses CatPawCLI with the reporter's exact bytes", async () => {
    // the fake's refusal, fed through the plugin's own round error format,
    // is the reporter's line word for word (minus magpie's "妙手 CatPaw: ")
    const res = await fetch("https://ai.catpaw.meituan.com/api/agent/conversation/round", {
      method: "POST",
      headers: _internal.gatewayHeaders(fake.state.token),
      body: JSON.stringify({ conversationId: "c", source: "CatPawCLI", mode: "CLI" }),
    })
    const body = await res.json()
    expect(res.status).toBe(issue605.upstreamStatus)
    expect(body).toEqual(issue605.upstream)
    expect(`妙手 CatPaw: 妙手 round 失败：HTTP ${res.status} code=${body.code} msg=${body.msg}`).toBe(issue605.reported)
  })

  test("a chat no longer meets the reporter's refusal: round and turn both name CatX/CATX_APP", async () => {
    for (const stream of [true, false]) {
      fake.state.reset()
      const { status, text } = await chat(stream)
      expect(text).not.toContain(issue605.upstream.msg)
      expect(status).toBe(200)
      expect(text).toContain("收到")
      expect(fake.state.conversations[0].source).toBe("CatX")
      expect(fake.state.conversations[0].mode).toBe("CATX_APP")
      expect(fake.state.turnBodies).toHaveLength(1)
      expect(fake.state.turnBodies[0].source).toBe("CatX")
      expect(fake.state.turnBodies[0].mode).toBe("CATX_APP")
    }
  })

  test("the headers stay the captured client's: only the body's source changed", () => {
    const ours = _internal.gatewayHeaders("t")
    expect(ours["m-appkey"]).toBe(capturedRound.headers["m-appkey"])
    expect(ours["x-agent-version"]).toBe(capturedTurn.headers["x-agent-version"])
    expect(ours["User-Agent"]).toBe(capturedRound.headers["user-agent"])
  })

  test("if the gateway turns the source off again, the user reads its words", async () => {
    fake.state.disabledSources.add(_internal.BODY_IDENTITY.source)
    const { text } = await chat(true)
    expect(text).toContain(`妙手 round 失败：HTTP 200 code=400 msg=source 不存在或未启用: ${_internal.BODY_IDENTITY.source}`)
    expect(fake.state.turns).toBe(0)
  })
})

describe("models the vendor added (the desktop client asks the gateway for its list)", () => {
  const chatWith = async (model) => {
    const loader = await plugin.auth.loader(getAuth)
    return loader.fetch("https://ai.catpaw.meituan.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
  }
  beforeEach(() => _internal.forgetLive())

  test("the list is asked the way the client asks it", async () => {
    await plugin.provider.models({ models: {} }, { auth: saved })
    expect(fake.state.modelTypeCalls).toEqual([{ tenant: "CatDesk", scene: "CATX_APP", env: "EXTERNAL" }])
  })

  test("a listed model the table lacks is offered, under its table id when it has one", async () => {
    const cfg = {}
    await plugin.config(cfg)
    const got = await plugin.provider.models({ models: cfg.provider.catpaw.models }, { auth: saved })
    expect(got["longcat-2.5"]).toEqual({ name: "LongCat-2.5 (限时免费)", rate: 0, free: true })
    expect(Object.keys(got)).toContain("longcat-2.0")
    expect(got["longcat-2.0"].name).toBe("LongCat-2.0 (限时免费)")
    // the user's own custom model (negative id) is not the gateway's to serve
    expect(Object.keys(got)).not.toContain("my-own-model")
  })

  test("a table model takes the list's multiplier; the user's own value stays", async () => {
    const got = await plugin.provider.models({ models: { "kimi-k3": { name: "Kimi-K3" } } }, { auth: saved })
    expect(got["kimi-k3"]).toEqual({ name: "Kimi-K3", rate: 1.5 })
    const own = await plugin.provider.models({ models: { "kimi-k3": { name: "Kimi-K3", rate: 9 } } }, { auth: saved })
    expect(own["kimi-k3"].rate).toBe(9)
  })

  test("the multiplier is read as the client reads it, and a missing one is not 0", () => {
    const row = (extendedInfo) => ({ modelTypeId: 5, modelTypeName: "X-1", extendedInfo })
    expect(_internal.liveModels([row({ rateMultiplier: "2x" })])["x-1"].rate).toBe(2)
    expect(_internal.liveModels([row(JSON.stringify({ rateMultiplier: 0.5 }))])["x-1"].rate).toBe(0.5)
    expect("rate" in _internal.liveModels([row({})])["x-1"]).toBe(false)
    expect("rate" in _internal.liveModels([row({ rateMultiplier: "abc" })])["x-1"]).toBe(false)
    expect(_internal.liveModels([row({ shortName: "X One", marketingCopy: "新,限时免费" })])["x-1"]).toEqual({ name: "X One (新、限时免费)", type: 5, image: false, free: true })
  })

  test("a chat on the new model sends the listed modelType", async () => {
    const res = await chatWith("longcat-2.5")
    expect(res.status).toBe(200)
    expect(fake.state.conversations.at(-1).modelType).toBe(120)
  })

  test("a table model costs no list request", async () => {
    const res = await chatWith("kimi-k3")
    expect(res.status).toBe(200)
    expect(fake.state.modelTypeCalls).toEqual([])
    expect(fake.state.conversations.at(-1).modelType).toBe(83)
  })

  test("the list is read once in five minutes", async () => {
    await chatWith("longcat-2.5")
    await chatWith("longcat-2.5")
    expect(fake.state.modelTypeCalls.length).toBe(1)
  })

  test("a model neither the table nor the list has is still refused, naming what is known", async () => {
    const res = await chatWith("not-a-model")
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain("longcat-2.5")
  })

  test("when the list cannot be read the table stands", async () => {
    fake.state.modelTypesFail = true
    const cfg = {}
    await plugin.config(cfg)
    const got = await plugin.provider.models({ models: cfg.provider.catpaw.models }, { auth: saved })
    expect(Object.keys(got).sort()).toEqual(Object.keys(cfg.provider.catpaw.models).sort())
    expect((await chatWith("longcat-2.5")).status).toBe(400)
    expect((await chatWith("glm-5.3")).status).toBe(200)
  })
})

describe("helpers", () => {
  test("model type mapping", () => {
    expect(_internal.modelTypeOf("longcat-2.0")).toBe(77)
    expect(_internal.modelTypeOf("kimi-k3")).toBe(83)
    expect(_internal.modelTypeOf("unknown")).toBe(77)
  })
})
