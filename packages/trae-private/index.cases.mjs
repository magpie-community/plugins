// bun test；登录、模型缓存和上游请求均使用本地测试数据。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import TraePrivateAuthPlugin, { _internal } from "./index.mjs"

const originalHome = process.env.TRAE_HOME
const originalCli = process.env.TRAE_PRIVATE_CLI
const originalFetch = globalThis.fetch
let fixture
const writeAuth = (overrides = {}) => {
  writeFileSync(join(fixture, "cli/auth.json"), JSON.stringify({ trae: {
    access_token: "fixture-access", refresh_token: "fixture-refresh", user_id: "fixture-user",
    expires_at: new Date(Date.now() + 3600e3).toISOString(),
    endpoints: { api_base_url: "https://upstream.invalid" }, ...overrides,
  } }))
}
// 测试里绝不触发真实 traecli：续期会起子进程去跑 CLI。
process.env.TRAE_PRIVATE_NO_AUTO_REFRESH = "1"
process.env.TRAE_PRIVATE_NO_LOGIN_BROWSER = "1"

beforeEach(() => {
  fixture = mkdtempSync(join(process.env.TMPDIR, "case-"))
  process.env.XDG_CONFIG_HOME = join(fixture, "config")
  mkdirSync(join(fixture, "cli"), { recursive: true })
  process.env.TRAE_HOME = fixture
  const dummyCli = join(fixture, process.platform === "win32" ? "traecli.exe" : "traecli")
  writeFileSync(dummyCli, "")
  process.env.TRAE_PRIVATE_CLI = dummyCli
  writeFileSync(join(fixture, "cli/models_cache.json"), JSON.stringify({ models: [
    { config_name: "kimi-k3", slug: "Kimi-K3", business_metadata: { variants: { standard_key: "kimi-k3__dev" } } },
    { config_name: "glm-v5", business_metadata: { uses_tob_raw_chat_surface: false } },
  ] }))
  writeAuth()
})
afterEach(() => {
  globalThis.fetch = originalFetch
  rmSync(fixture, { recursive: true, force: true })
})
afterAll(() => {
  if (originalHome === undefined) delete process.env.TRAE_HOME
  else process.env.TRAE_HOME = originalHome
  if (originalCli === undefined) delete process.env.TRAE_PRIVATE_CLI
  else process.env.TRAE_PRIVATE_CLI = originalCli
})

const {
  catalog,
  traeHome,
  parseBaseURL,
  authorizeLogin,
  parseCookieValue,
  cookieForHost,
  cliPath,
  absoluteDirError,
  webCookiePath,
  usageCookie,
  contextOf,
  quotaOf,
  fitBody,
  dropImages,
  truncateTools,
  sendable,
  messagesOf,
  partsOf,
  toolsOf,
  toolChoiceOf,
  chatBody,
  callsOf,
  usageOf,
  piece,
  collect,
  shortError,
  sse,
  streamResponse,
} = _internal

describe("partsOf / messagesOf", () => {
  test("字符串内容变成 text part", () => {
    expect(messagesOf({ messages: [{ role: "user", content: "你好" }] })).toEqual([
      { role: "user", content: [{ type: "text", text: "你好" }] },
    ])
  })

  test("image_url 按上游结构透传（对象 url）", () => {
    const url = "data:image/png;base64,AAAA"
    const out = messagesOf({
      messages: [{ role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url } }] }],
    })
    expect(out).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image_url", image_url: { url } },
        ],
      },
    ])
  })

  test("image_url 是字符串时归一化成 {url}", () => {
    const out = partsOf([{ type: "image_url", image_url: "https://x.test/a.png" }])
    expect(out).toEqual([{ type: "image_url", image_url: { url: "https://x.test/a.png" } }])
  })

  test("助手的 tool_calls 回填成上游的 function_call 结构", () => {
    const out = messagesOf({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_weather", arguments: { city: "北京" } } },
          ],
        },
      ],
    })
    expect(out).toEqual([
      {
        role: "assistant",
        content: [],
        tool_calls: [
          { index: 0, id: "call_1", type: "function", function_call: { name: "get_weather", arguments: '{"city":"北京"}' } },
        ],
      },
    ])
  })

  test("工具结果保留 tool_call_id", () => {
    const out = messagesOf({ messages: [{ role: "tool", tool_call_id: "call_1", content: "晴 25°C" }] })
    expect(out).toEqual([{ role: "tool", content: [{ type: "text", text: "晴 25°C" }], tool_call_id: "call_1" }])
  })

  test("input 字符串和空内容", () => {
    expect(messagesOf({ input: "hi" })).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }])
    expect(messagesOf({ messages: [{ role: "user", content: "" }, { role: "user", content: "x" }] })).toEqual([
      { role: "user", content: [{ type: "text", text: "x" }] },
    ])
  })
})

describe("toolsOf / toolChoiceOf / chatBody", () => {
  const toolsReq = {
    model: "kimi-k3",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: { name: "get_weather", description: "查天气", parameters: { type: "object", properties: {} } },
      },
    ],
  }

  test("parameters 序列化成字符串", () => {
    expect(toolsOf(toolsReq)).toEqual([
      { type: "function", function: { name: "get_weather", description: "查天气", parameters: '{"type":"object","properties":{}}' } },
    ])
  })

  test("tool_choice 字符串透传、对象映射成 required", () => {
    expect(toolChoiceOf("auto")).toBe("auto")
    expect(toolChoiceOf("none")).toBe("none")
    expect(toolChoiceOf("required")).toBe("required")
    expect(toolChoiceOf({ type: "function", function: { name: "get_weather" } })).toBe("required")
    expect(toolChoiceOf(undefined)).toBeUndefined()
  })

  test("chatBody：对象 tool_choice 不原样发给上游；已知模型用 wire 名", () => {
    const body = chatBody({ ...toolsReq, tool_choice: { type: "function", function: { name: "get_weather" } } }, "s1")
    expect(body.tool_choice).toBe("required")
    expect(body.model_name).toBe("kimi-k3__dev")
    expect(body.config_name).toBe("kimi-k3")
    expect(body.session_id).toBe("s1")
    // 没有 tools 时不带 tool_choice
    const plain = chatBody({ model: "kimi-k3", messages: [{ role: "user", content: "hi" }], tool_choice: "auto" }, "s2")
    expect("tool_choice" in plain).toBe(false)
    expect("tools" in plain).toBe(false)
  })

  test("指定函数时只提供该工具", () => {
    const body = chatBody({ ...toolsReq,
      tools: [...toolsReq.tools, { type: "function", function: { name: "other" } }],
      tool_choice: { type: "function", function: { name: "get_weather" } },
    }, "s")
    expect(body.tool_choice).toBe("required")
    expect(body.tools.map((t) => t.function.name)).toEqual(["get_weather"])
  })
})

describe("callsOf", () => {
  test("上游 function_call 转成 chat completions 的 function", () => {
    const data = {
      tool_calls: [
        { index: 0, id: "call_abc", type: "function", function_call: { name: "get_weather", arguments: '{"city":"北京"}' } },
      ],
    }
    expect(callsOf(data)).toEqual([
      { index: 0, id: "call_abc", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } },
    ])
  })

  test("partial_arguments 兜底；首帧缺 id 补 call_<index>，续帧不带 id/name", () => {
    const seen = new Set()
    const out = callsOf({ tool_calls: [{ function_call: { name: "f", partial_arguments: '{"a":' } }] }, seen)
    // 空 id 会让 ai-sdk 配不上工具结果。
    expect(out).toEqual([{ index: 0, id: "call_0", type: "function", function: { name: "f", arguments: '{"a":' } }])
    const next = callsOf({ tool_calls: [{ function_call: { partial_arguments: '1}' } }] }, seen)
    expect(next).toEqual([{ index: 0, type: "function", function: { arguments: '1}' } }])
    expect(callsOf({})).toEqual([])
    expect(callsOf(null)).toEqual([])
  })

  test("只有工具名的首帧不制造参数", () => {
    expect(callsOf({ tool_calls: [{ function_call: { name: "f" } }] })[0].function.arguments).toBe("")
  })
})

describe("usageOf", () => {
  test("token 映射，含缓存和推理明细", () => {
    expect(
      usageOf({ prompt_tokens: 17, completion_tokens: 73, total_tokens: 90, cache_read_input_tokens: 5, reasoning_tokens: 70 }),
    ).toEqual({
      prompt_tokens: 17,
      completion_tokens: 73,
      total_tokens: 90,
      prompt_tokens_details: { cached_tokens: 5 },
      completion_tokens_details: { reasoning_tokens: 70 },
    })
  })

  test("缺 total 时按 input+output 补；没有数字返回 null", () => {
    expect(usageOf({ prompt_tokens: 3, completion_tokens: 4 })?.total_tokens).toBe(7)
    expect(usageOf({})).toBeNull()
    expect(usageOf(null)).toBeNull()
  })
})

describe("piece", () => {
  test("output 帧取出正文、推理和工具调用", () => {
    const p = piece({
      event: "output",
      data: {
        response: "你好",
        reasoning_content: "think",
        tool_calls: [{ index: 0, id: "c1", function_call: { name: "f", arguments: "{}" } }],
        finish_reason: null,
      },
    })
    expect(p.text).toBe("你好")
    expect(p.reasoning).toBe("think")
    expect(p.calls).toHaveLength(1)
  })

  test("progress_notice 和 metadata/timing_cost/extra_info 不是内容", () => {
    expect(piece({ event: "progress_notice", data: ";Processing_1_x" })).toEqual({})
    expect(piece({ event: "metadata", data: { model: "m" } })).toEqual({})
    expect(piece({ event: "timing_cost", data: { name: "llm_raw_chat_v2" } })).toEqual({})
    expect(piece({ event: "extra_info", data: { content: "{}" } })).toEqual({})
  })

  test("排队事件不是内容，哪怕 data 是字符串", () => {
    for (const event of ["queue_begin", "request_wait_in_queue", "queue_end", "queue_position"]) {
      expect(piece({ event, data: { queue_position: 3 } })).toEqual({})
      expect(piece({ event, data: "排队中，前面还有 3 人" })).toEqual({})
    }
  })

  test("没见过的事件不会把字符串 data 漏进正文", () => {
    expect(piece({ event: "some_future_event", data: "不该出现的文本" })).toEqual({})
    expect(piece({ event: "", data: null })).toEqual({})
  })

  test("event: error 转成错误，并截取 origin err 之后的人话", () => {
    const p = piece({
      event: "error",
      data: { code: 4001, error: "biz error: rpc error: …, origin err = app is not found\nstack…" },
    })
    expect(p.error).toBe("app is not found")
  })

  test("error 是字符串或躺在普通帧的 error 字段里也算错误", () => {
    expect(piece({ event: "error", data: "boom" }).error).toBe("boom")
    expect(piece({ event: "output", data: { error: "biz error: origin err = quota exhausted" } }).error).toBe(
      "quota exhausted",
    )
  })

  test("内容安全拦截转成错误", () => {
    const p = piece({ event: "content_security", data: { hit_rule_name: "rule-42", action_type: "block", execute_point: "input" } })
    expect(p.error).toContain("拦截")
    expect(p.error).toContain("rule-42")
    // 不带事件名但长着安全事件的样子也一样处理
    expect(piece({ event: "notice", data: { hit_rule_name: "r" } }).error).toContain("拦截")
  })

  test("done 的正常 finish 透传，异常 finish 转成错误", () => {
    expect(piece({ event: "done", data: { finish_reason: "stop" } })).toMatchObject({ finish: "stop" })
    expect(piece({ event: "done", data: { finish_reason: "tool_calls" } })).toMatchObject({ finish: "tool_calls" })
    const bad = piece({ event: "done", data: { finish_reason: "risk_intercept" } })
    expect(bad.error).toContain("risk_intercept")
  })

  test("token_usage 帧只给 usage", () => {
    const p = piece({ event: "token_usage", data: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })
    expect(p.usage?.total_tokens).toBe(3)
    expect(p.text).toBeUndefined()
  })
})

describe("sse + collect", () => {
  const streamOf = (text) =>
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text))
        c.close()
      },
    })

  test("sse 解析事件名、多行 data 和 CRLF", async () => {
    const events = []
    for await (const ev of sse(streamOf('event: output\r\ndata: {"response":"a",\r\ndata: "b":true}\r\n\r\nevent: done\ndata: {"finish_reason":"stop"}\n\n')))
      events.push(ev)
    expect(events).toEqual([
      { event: "output", data: { response: "a", b: true } },
      { event: "done", data: { finish_reason: "stop" } },
    ])
  })

  test("collect 拼接正文并按 index 合并工具调用分片", async () => {
    const head = { event: "output", data: { response: "你", tool_calls: null } }
    const rest = (async function* () {
      yield { event: "output", data: { response: "好", tool_calls: [{ index: 0, id: "c1", function_call: { name: "f", arguments: '{"a":' } }] } }
      yield { event: "output", data: { response: "", tool_calls: [{ index: 0, function_call: { arguments: '1}' } }] } }
      yield { event: "token_usage", data: { prompt_tokens: 1, completion_tokens: 2 } }
      yield { event: "done", data: { finish_reason: "tool_calls" } }
    })()
    const all = await collect(head, rest)
    expect(all.text).toBe("你好")
    expect(all.calls).toEqual([{ index: 0, id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }])
    expect(all.finish).toBe("tool_calls")
    expect(all.usage?.prompt_tokens).toBe(1)
    expect(all.error).toBe("")
  })

  test("collect 中途出错要保留错误，不被已有正文吞掉", async () => {
    const head = { event: "output", data: { response: "半截" } }
    const rest = (async function* () {
      yield { event: "content_security", data: { hit_rule_name: "r1" } }
    })()
    const all = await collect(head, rest)
    expect(all.error).toContain("拦截")
  })

  test("首帧只有工具名，后续参数仍是有效 JSON", async () => {
    const all = await collect({ event: "output", data: { tool_calls: [{ index: 0, id: "c", function_call: { name: "f" } }] } },
      (async function* () {
        yield { event: "output", data: { tool_calls: [{ index: 0, function_call: { arguments: '{"q":"test"}' } }] } }
        yield { event: "done", data: { finish_reason: "tool_calls" } }
      })())
    expect(JSON.parse(all.calls[0].function.arguments)).toEqual({ q: "test" })
    expect(all.error).toBe("")
  })

  test("EOF 前没有结束事件是失败；done 帧的尾部正文仍保留", async () => {
    const partial = await collect({ event: "output", data: { response: "半截" } }, (async function* () {})())
    expect(partial.error).toContain("中断")
    const complete = await collect({ event: "output", data: { response: "前" } },
      (async function* () { yield { event: "done", data: { response: "后", finish_reason: "stop" } } })())
    expect(complete.text).toBe("前后")
    expect(complete.error).toBe("")
  })

  test("无参数工具只在完成后补空对象", async () => {
    const all = await collect({ event: "output", data: { tool_calls: [{ function_call: { name: "f" } }] } },
      (async function* () { yield { event: "done", data: { finish_reason: "tool_calls" } } })())
    expect(all.calls[0].function.arguments).toBe("{}")
  })
})

describe("streamResponse", () => {
  const framesOf = async (res) => {
    const text = await res.text()
    return text
      .split("\n\n")
      .filter((f) => f.startsWith("data:") && !f.includes("[DONE]"))
      .map((f) => JSON.parse(f.slice(5)))
  }
  const emptyRest = (async function* () {})()

  test("中途出错发 OpenAI 失败帧而不是把错误塞进正文", async () => {
    const rest = (async function* () {
      yield { event: "content_security", data: { hit_rule_name: "r1" } }
    })()
    const res = streamResponse("m", { event: "output", data: { response: "半截" } }, rest)
    const frames = await framesOf(res)
    expect(frames.some((f) => f.choices?.[0]?.delta?.content === "半截")).toBe(true)
    const err = frames.find((f) => f.error)
    expect(err?.error?.message).toContain("拦截")
    // 出错之后不再发正常的 finish 帧
    expect(frames.some((f) => f.choices?.[0]?.finish_reason)).toBe(false)
  })

  test("正常流以 done 的 finish_reason 收尾并带 usage", async () => {
    const rest = (async function* () {
      yield { event: "token_usage", data: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }
      yield { event: "done", data: { finish_reason: "tool_calls" } }
    })()
    const res = streamResponse("m", { event: "output", data: { response: "hi" } }, rest)
    const frames = await framesOf(res)
    const last = frames.at(-1)
    expect(last.choices[0].finish_reason).toBe("tool_calls")
    expect(last.usage?.total_tokens).toBe(3)
  })

  test("排队事件不会变成正文帧", async () => {
    const rest = (async function* () {
      yield { event: "request_wait_in_queue", data: "排队中，前面还有 2 人" }
      yield { event: "done", data: { finish_reason: "stop" } }
    })()
    const res = streamResponse("m", { event: "queue_begin", data: { queue_position: 2 } }, rest)
    const frames = await framesOf(res)
    const text = frames.map((f) => f.choices?.[0]?.delta?.content || "").join("")
    expect(text).toBe("")
    expect(frames.at(-1).choices[0].finish_reason).toBe("stop")
  })

  test("空流不伪造正常结束", async () => {
    const res = streamResponse("m", { event: "metadata", data: {} }, emptyRest)
    const frames = await framesOf(res)
    expect(frames.at(-1).error.message).toContain("中断")
    expect(frames.some((f) => f.choices?.[0]?.finish_reason)).toBe(false)
  })

  test("中途报错后立即结束，不继续发正文", async () => {
    let closed = false
    const rest = (async function* () {
      try {
        yield { event: "error", data: { error: "boom" } }
        yield { event: "output", data: { response: "不应出现" } }
      } finally { closed = true }
    })()
    const frames = await framesOf(streamResponse("m", { event: "output", data: { response: "前" } }, rest))
    expect(frames.some((f) => f.choices?.[0]?.delta?.content === "不应出现")).toBe(false)
    expect(frames.at(-1).error.message).toBe("boom")
    expect(closed).toBe(true)
  })

  test("仅有工具名的流式首帧不污染后续参数", async () => {
    const frames = await framesOf(streamResponse("m", { event: "output", data: {
      tool_calls: [{ index: 0, id: "c", function_call: { name: "f" } }],
    } }, (async function* () {
      yield { event: "output", data: { tool_calls: [{ index: 0, function_call: { arguments: '{"a":1}' } }] } }
      yield { event: "done", data: { finish_reason: "tool_calls" } }
    })()))
    const args = frames.flatMap((f) => f.choices?.[0]?.delta?.tool_calls ?? []).map((c) => c.function.arguments).join("")
    expect(JSON.parse(args)).toEqual({ a: 1 })
  })

  test("无参数工具流只在结束时补空对象", async () => {
    const frames = await framesOf(streamResponse("m", { event: "output", data: {
      tool_calls: [{ index: 0, id: "c", function_call: { name: "f" } }],
    } }, (async function* () { yield { event: "done", data: { finish_reason: "tool_calls" } } })()))
    const deltas = frames.flatMap((f) => f.choices?.[0]?.delta?.tool_calls ?? [])
    expect(deltas[0].function.arguments).toBe("")
    expect(deltas.map((c) => c.function.arguments).join("")).toBe("{}")
  })
})

describe("真实入口与本地模拟上游", () => {
  const request = (extra = {}) => JSON.stringify({ model: "kimi-k3", messages: [{ role: "user", content: "fixture" }], stream: false, ...extra })
  const loader = async () => {
    const signed = await _internal.signInAt({ baseURL: "https://upstream.invalid" }, fixture)
    return (await TraePrivateAuthPlugin()).auth.loader(async () => signed)
  }
  const wire = (...events) => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")
  const responseOf = (text, cancel = () => {}) => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(text)) }, cancel,
  }), { headers: { "content-type": "text/event-stream" } })

  test("首个业务错误关闭仍然打开的上游", async () => {
    let cancelled = false, signal
    globalThis.fetch = async (_, init) => {
      signal = init.signal
      return responseOf(wire(["error", { error: "fixture failure" }]), () => { cancelled = true })
    }
    const res = await (await loader()).fetch("https://gateway.invalid/v1/chat/completions", { body: request() })
    expect(res.status).toBe(502)
    expect((await res.json()).error.message).toBe("fixture failure")
    expect(cancelled).toBe(true)
    expect(signal.aborted).toBe(true)
  })

  test("取消下游时中断正在等待的上游读取", async () => {
    let cancelled = false, signal
    globalThis.fetch = async (_, init) => {
      signal = init.signal
      return responseOf(wire(["output", { response: "hello" }]), () => { cancelled = true })
    }
    const res = await (await loader()).fetch("https://gateway.invalid/v1/chat/completions", { body: request({ stream: true }) })
    const reader = res.body.getReader()
    await reader.read()
    await reader.read()
    const pending = reader.read()
    await reader.cancel()
    expect((await pending).done).toBe(true)
    expect(cancelled).toBe(true)
    expect(signal.aborted).toBe(true)
  })

  test("等待首个事件时也能取消", async () => {
    let cancelled = false, entered
    const started = new Promise((resolve) => { entered = resolve })
    globalThis.fetch = async () => {
      entered()
      return new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { "content-type": "text/event-stream" } })
    }
    const outer = new AbortController()
    const pending = (await loader()).fetch("https://gateway.invalid/v1/chat/completions", { body: request(), signal: outer.signal })
    await started
    outer.abort()
    expect((await pending).status).toBe(502)
    expect(cancelled).toBe(true)
  })

  test("非流式入口拒绝没有结束事件的半截回答", async () => {
    globalThis.fetch = async () => new Response(wire(["output", { response: "半截" }]), { headers: { "content-type": "text/event-stream" } })
    const res = await (await loader()).fetch("https://gateway.invalid/v1/chat/completions", { body: request() })
    expect(res.status).toBe(502)
    expect((await res.json()).error.message).toContain("中断")
  })

  test("流式入口拒绝没有结束事件的半截回答", async () => {
    globalThis.fetch = async () => new Response(wire(["output", { response: "半截" }]), { headers: { "content-type": "text/event-stream" } })
    const res = await (await loader()).fetch("https://gateway.invalid/v1/chat/completions", { body: request({ stream: true }) })
    const body = await res.text()
    expect(body).toContain("半截")
    expect(body).toContain("结束事件前中断")
    expect(body).not.toContain('"finish_reason":"stop"')
  })

  test("首个事件前的读取异常返回错误响应", async () => {
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(c) { c.error(new Error("fixture read failure")) },
    }), { headers: { "content-type": "text/event-stream" } })
    const res = await (await loader()).fetch("https://gateway.invalid/v1/chat/completions", { body: request() })
    expect(res.status).toBe(502)
  })

  test("首个事件后的读取异常发错误帧", async () => {
    let reads = 0
    globalThis.fetch = async () => new Response(new ReadableStream({
      pull(c) {
        if (!reads++) c.enqueue(new TextEncoder().encode(wire(["output", { response: "前" }])))
        else c.error(new Error("fixture read failure"))
      },
    }), { headers: { "content-type": "text/event-stream" } })
    const res = await (await loader()).fetch("https://gateway.invalid/v1/chat/completions", { body: request({ stream: true }) })
    const body = await res.text()
    expect(body).toContain("读取私有化 TRAE 响应失败")
    expect(body).not.toContain('"finish_reason":"stop"')
  })

  test("不注册当前插件不支持的模型，也不保留它的旧配置", async () => {
    const plugin = await TraePrivateAuthPlugin()
    const config = { provider: { "trae-private": { models: { "glm-v5": { name: "old" } } } } }
    await plugin.config(config)
    expect(config.provider["trae-private"].models["glm-v5"]).toBeUndefined()
    expect(config.provider["trae-private"].models["kimi-k3"]).toBeDefined()
    expect((await plugin.provider.models({ models: {} }))["glm-v5"]).toBeUndefined()
  })

  test("指定不存在的工具时拒绝请求，不降级成任意工具", async () => {
    globalThis.fetch = async () => { throw new Error("不应访问上游") }
    const res = await (await loader()).fetch("https://gateway.invalid/v1/chat/completions", { body: request({
      tools: [{ type: "function", function: { name: "other" } }],
      tool_choice: { type: "function", function: { name: "missing" } },
    }) })
    expect(res.status).toBe(400)
  })

  test("过期凭据不报告刷新成功；CLI 更新后可直接恢复", async () => {
    const plugin = await TraePrivateAuthPlugin()
    const signed = await _internal.signInAt({ baseURL: "https://upstream.invalid" }, fixture)
    const fetcher = await plugin.auth.loader(async () => signed)
    writeAuth({ expires_at: "2000-01-01T00:00:00Z" })
    const error = await plugin.auth.refresh(signed).catch((e) => e)
    expect(error.message).toContain("过期")
    expect(error.signIn).toBe("kept")
    const expired = await fetcher.fetch("https://gateway.invalid/v1/chat/completions", { body: request() })
    expect(expired.status).toBe(401)
    expect(expired.headers.get("X-Magpie-Sign-In")).toBe("kept")
    writeAuth({ access_token: "fixture-new" })
    const renewed = await plugin.auth.refresh(signed)
    expect(renewed.access).toBe("fixture-new")
    expect(await plugin.auth.refresh(renewed)).toBeUndefined()
    let authorization
    globalThis.fetch = async (_, init) => {
      authorization = init.headers.Authorization
      return responseOf(wire(["output", { response: "OK" }], ["done", { finish_reason: "stop" }]))
    }
    expect((await fetcher.fetch("https://gateway.invalid/v1/chat/completions", { body: request() })).status).toBe(200)
    expect(authorization).toBe("Cloud-IDE-JWT fixture-new")
  })

  test("本机注销后不继续使用 Magpie 保存的旧凭据", async () => {
    const fetcher = await loader()
    rmSync(join(fixture, "cli/auth.json"))
    const res = await fetcher.fetch("https://gateway.invalid/v1/chat/completions", { body: request() })
    expect(res.status).toBe(401)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  })
})

describe("shortError", () => {
  test("截取 origin err 之后的第一行", () => {
    expect(shortError("biz error: rpc error: code = X desc = Y., origin err = app is not found\nstack line")).toBe(
      "app is not found",
    )
    expect(shortError("plain message\nsecond")).toBe("plain message")
    expect(shortError("")).toBe("私有化 TRAE 没有返回可读错误")
  })
})

// CLI 缓存里的 context_window 只是 dev 档声明，raw chat 实际收约 1M。
describe("上下文窗口", () => {
  test("默认按缓存声明的窗口，不再替所有部署假定 1M", () => {
    expect(contextOf({ context_window: 200000 })).toBe(200000)
    expect(contextOf({ context_window: 184000 })).toBe(184000)
    // 队列里没有窗口时才回落到默认常量。
    expect(contextOf({})).toBe(1000000)
  })

  test("max 档优先，dev 档更大时用 dev", () => {
    expect(contextOf({ context_window: 200000, business_metadata: { variants: { max_context_window: 1048566 } } })).toBe(1048566)
    expect(contextOf({ context_window: 2000000 })).toBe(2000000)
    expect(contextOf({})).toBe(1000000)
  })

  test("catalog 把缓存里的模型按上限注册", () => {
    const models = catalog()
    expect(models.find((m) => m.id === "kimi-k3").context).toBe(1000000)
  })
})

// 上游按请求体字节数 413，不是按 token。长会话里 base64 图片会被每轮全量回传。
describe("请求体预算", () => {
  const mkImg = (n) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(n)}` } })

  test("超预算先丢历史图片，保留最后一张", () => {
    const body = {
      messages: [
        { role: "user", content: [mkImg(4_000_000)] },
        { role: "user", content: [mkImg(4_000_000)] },
        { role: "user", content: [mkImg(4_000_000)] },
      ],
    }
    // 12MB 图片 > 9MB 预算：丢到只剩最后一张仍有 4MB，所以全部保留一张
    const notes = fitBody(body)
    expect(notes.droppedImages).toBe(2)
    // 丢掉的图留一句占位，不会变成空 content。
    expect(body.messages[0].content).toEqual([{ type: "text", text: "[image omitted: request-body limit]" }])
    expect(body.messages[1].content).toEqual([{ type: "text", text: "[image omitted: request-body limit]" }])
    expect(body.messages[2].content.filter((p) => p.type === "image_url").length).toBe(1)
  })

  test("仍然超预算时把超长工具结果截断", () => {
    const body = {
      messages: [
        { role: "tool", content: [{ type: "text", text: "x".repeat(12_000_000) }] },
      ],
    }
    const notes = fitBody(body)
    expect(notes.truncatedTools).toBe(1)
    expect(body.messages[0].content[0].text.length).toBeLessThan(30_000)
    expect(body.messages[0].content[0].text).toContain("trae-private")
  })

  test("预算内不动任何内容", () => {
    const body = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }, mkImg(1000)] }] }
    const notes = fitBody(body)
    expect(notes.droppedImages).toBe(0)
    expect(notes.truncatedTools).toBe(0)
    expect(body.messages[0].content.length).toBe(2)
  })

  test("只有一张图时预算内不丢它", () => {
    const body = { messages: [{ role: "user", content: [mkImg(1000)] }] }
    expect(dropImages(body.messages, 1)).toBe(0)
    expect(body.messages[0].content.length).toBe(1)
  })

  test("sendable 不带内部统计字段", () => {
    const out = sendable({ config_name: "m", fitted: { droppedImages: 1, bytes: 1 } })
    expect(out).not.toContain("fitted")
    expect(JSON.parse(out).config_name).toBe("m")
  })
})

// 管理员会随时加减这两档额度，卡片上的数必须跟着变，不能假设只增不减。
describe("额度被管理员调整", () => {
  const quota = (seat, paygo) => ({ user_model_quota: { seat_pool_currency_quota: seat, paygo_currency_quota: paygo } })
  const usage = (seatCost, overCost) => ({
    user_usage_list: [
      { in_seat_detail: { chat_usage_details: seatCost ? [{ total_cost_currency: seatCost, display_name: "GLM-5.3" }] : [] } },
      { model_usage_detail_list: overCost ? [{ total_cost_currency: overCost }] : [] },
    ],
  })

  test("额度被调大：百分比跟着变小", () => {
    const r = quotaOf(quota(2000, 200), usage(717.322, 0))
    expect(r.windows[0].used).toBeCloseTo(35.87, 1)
    expect(r.windows[0].limit).toBe(2000)
    expect(r.balance).toBe("1,282.68")
  })

  test("额度被调小到低于已用：封顶 100 并标出透支", () => {
    const r = quotaOf(quota(500, 200), usage(717.322, 0))
    // magpie 允许 used 超过 100 表示超支。
    expect(r.windows[0].used).toBeCloseTo(143.46, 1)
    expect(r.windows[0].over).toBeCloseTo(217.322, 2)
    expect(r.windows[0].display).toContain("超出")
  })

  test("某档被清零：那一档不显示，另一档照常", () => {
    const r = quotaOf(quota(1000, 0), usage(717.322, 0))
    expect(r.windows.length).toBe(1)
    expect(r.windows[0].name).toBe("基础用量")
  })

  test("两档都被收回：说明原因，不给空卡片", () => {
    const r = quotaOf(quota(0, 0), usage(717.322, 0))
    expect(r.windows).toEqual([])
    expect(r.error).toContain("额度")
  })

  test("额度字段整体缺失时不崩", () => {
    const r = quotaOf({}, { user_usage_list: [] })
    expect(r.windows).toEqual([])
    expect(r.error).toBeTruthy()
  })

  test("超出 0.01 元以内不算透支（账单浮点误差）", () => {
    const r = quotaOf(quota(1000, 200), usage(717.322, 200.004))
    expect(r.windows[1].over).toBeUndefined()
    expect(r.windows[1].display).not.toContain("超出")
  })
})

// 多账号：每个账号一个 traecli 目录，登录时填，magpie 按账号记住。
const readLocalOf = (home) => {
  const f = JSON.parse(readFileSync(join(home, "cli", "auth.json"), "utf8"))
  return { email: f.trae.user_email, token: f.trae.access_token }
}
const catalogOf = (home) => catalog(home)

describe("多账号", () => {
  test("目录留空回落到 TRAE_HOME，填了就用填的", () => {
    // 测试里 TRAE_HOME 指向 fixture，所以空值回落到它。
    expect(traeHome("")).toBe(realpathSync(process.env.TRAE_HOME))
    expect(traeHome("  ")).toBe(realpathSync(process.env.TRAE_HOME))
    const explicit = join(fixture, "explicit-home")
    expect(traeHome(explicit)).toBe(explicit)
  })

  test("两个账号读各自的 auth.json", () => {
    const a = join(fixture, "acct-a"), b = join(fixture, "acct-b")
    for (const [dir, email] of [[a, "a@x.com"], [b, "b@x.com"]]) {
      mkdirSync(join(dir, "cli"), { recursive: true })
      writeFileSync(join(dir, "cli", "auth.json"), JSON.stringify({ trae: {
        access_token: `token-${email}`, user_id: email, user_email: email,
        expires_at: new Date(Date.now() + 3600e3).toISOString(),
        endpoints: { api_base_url: "https://upstream.invalid" },
      } }))
      writeFileSync(join(dir, "cli", "models_cache.json"), JSON.stringify({ models: [
        { config_name: `model-${email}` },
      ] }))
    }
    // 同一时刻，两个目录给出不同的登录与不同的模型（各自部署开通的模型可能不同）。
    expect(readLocalOf(a).email).toBe("a@x.com")
    expect(readLocalOf(b).email).toBe("b@x.com")
    expect(catalogOf(a)[0].id).toBe("model-a@x.com")
    expect(catalogOf(b)[0].id).toBe("model-b@x.com")
  })

  test("cookie 按 origin、uid 与绝对目录分文件", () => {
    const one = { uid: "a@x.com", traeHome: fixture, baseURL: "https://upstream.invalid" }
    expect(webCookiePath(one)).not.toBe(webCookiePath({ ...one, uid: "b@x.com" }))
    expect(webCookiePath(one)).not.toBe(webCookiePath({ ...one, baseURL: "https://other.invalid" }))
    expect(webCookiePath(one)).not.toBe(webCookiePath({ ...one, traeHome: join(fixture, "other") }))
  })

  test("不信任未绑定身份的通用旧 cookie", () => {
    const { webCookie } = _internal
    const dir = _internal.magpieConfigDir()
    mkdirSync(dir, { recursive: true })
    const generic = join(dir, "trae-private-web-cookie")
    const prev = existsSync(generic) ? readFileSync(generic, "utf8") : null
    writeFileSync(generic, "generic-cookie-value\n", { mode: 0o600 })
    try {
      expect(webCookie("someone@x.com")).toBe("")
    } finally {
      if (prev === null) rmSync(generic, { force: true })
      else writeFileSync(generic, prev, { mode: 0o600 })
    }
  })
})

describe("Magpie 供应商登录", () => {
  const originalSpawn = _internal.spawnLogin
  const originalBrowser = _internal.launchDebugBrowser
  afterEach(() => {
    _internal.spawnLogin = originalSpawn
    _internal.launchDebugBrowser = originalBrowser
  })

  test("企业地址只接受 HTTPS", () => {
    expect(parseBaseURL("").error).toBeTruthy()
    expect(parseBaseURL("http://coding.example.test").error).toContain("HTTPS")
    expect(parseBaseURL("https://user:pass@coding.example.test").error).toBeTruthy()
    expect(parseBaseURL("https://coding.example.test/app/").base).toBe("https://coding.example.test/app")
  })

  test("traecli 目录按本机规则认绝对路径，相对路径不要", () => {
    expect(absoluteDirError("", false)).toBeTruthy()
    expect(absoluteDirError("", true)).toBeUndefined()
    expect(absoluteDirError("relative-dir", true)).toContain("绝对路径")
    expect(absoluteDirError(join(homedir(), ".trae-work"), false)).toBeUndefined()
  })

  test("TRAE_PRIVATE_CLI 优先于默认查找路径", () => {
    expect(cliPath()).toBe(process.env.TRAE_PRIVATE_CLI)
    expect(existsSync(cliPath())).toBe(true)
  })

  test("供应商页是 oauth 按钮加 Base URL，不再要 API key", async () => {
    const methods = (await TraePrivateAuthPlugin()).auth.methods
    expect(methods[0].type).toBe("oauth")
    expect(methods[0].prompts[0].key).toBe("baseURL")
    expect(methods.some((m) => m.type === "api")).toBe(false)
    expect(methods.map((m) => m.label)).not.toContain("同步用量卡片")
  })

  test("本机已有同一企业的登录时，点登录直接接入，不起 CLI", async () => {
    let spawned = 0
    _internal.spawnLogin = () => { spawned += 1; throw new Error("不应拉起 traecli") }
    const step = await authorizeLogin({ baseURL: "https://upstream.invalid" }, "")
    expect(spawned).toBe(0)
    expect(step.method).toBe("auto")
    const result = await step.callback()
    expect(result.type).toBe("success")
    expect(result.baseURL).toBe("https://upstream.invalid")
    expect(result.access).toBe("fixture-access")
  })

  test("没有登录时拉起 traecli，并在写下令牌后完成 Magpie 签入", async () => {
    rmSync(join(fixture, "cli/auth.json"))
    _internal.spawnLogin = () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => child.emit("close", 0)
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("Open https://login.invalid/sso\n"))
        writeAuth({ endpoints: { api_base_url: "https://coding.example.test" } })
        child.emit("close", 0)
      })
      return child
    }
    const step = await authorizeLogin({ baseURL: "https://coding.example.test" }, "")
    expect(step.url).toBe("https://login.invalid/sso")
    expect(step.method).toBe("auto")
    const result = await step.callback()
    expect(result.type).toBe("success")
    expect(result.baseURL).toBe("https://coding.example.test")
  })

  test("登录完成时从授权浏览器收下用量会话，不用粘贴", async () => {
    rmSync(join(fixture, "cli/auth.json"))
    let closed = false
    _internal.launchDebugBrowser = async () => ({
      port: 9,
      open: async () => {},
      cookies: async () => {
        await Promise.resolve()
        if (closed) throw new Error("browser closed")
        return [{ name: "X-Cloudide-Tob-Session", value: "sess-from-browser", domain: "coding.example.test" }]
      },
      stop: async () => { closed = true },
    })
    _internal.spawnLogin = () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => child.emit("close", 0)
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("Open https://login.invalid/sso\n"))
        writeAuth({ endpoints: { api_base_url: "https://coding.example.test" } })
        child.emit("close", 0)
      })
      return child
    }
    const step = await authorizeLogin({ baseURL: "https://coding.example.test" }, "")
    const result = await step.callback()
    expect(result.type).toBe("success")
    expect(result.quotaStatus).toBe("available")
    expect(usageCookie(result)).toBe("sess-from-browser")
    expect(closed).toBe(true)
    rmSync(webCookiePath(result), { force: true })
  })

  test("解析网页会话值，去掉名字和后续属性", () => {
    expect(parseCookieValue("")).toBe("")
    expect(parseCookieValue("abc=def")).toBe("abc=def")
    expect(parseCookieValue("X-Cloudide-Tob-Session=abc==")).toBe("abc==")
    expect(parseCookieValue("X-Cloudide-Tob-Session=abc; Path=/; HttpOnly")).toBe("abc")
    expect(cookieForHost(
      [{ name: "X-Cloudide-Tob-Session", value: "abc", domain: ".coding.example.test" }],
      "coding.example.test",
    )).toBe("abc")
  })

  test("不信任缺少绑定与 cookie 属性的旧 webSession", () => {
    expect(usageCookie({ webSession: "from-auth", accountId: "a@x.com" })).toBe("")
  })

})

