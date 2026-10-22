// bun test；登录、模型缓存和上游请求均使用本地测试数据。
import "./nonet.mjs"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import TraePrivateAuthPlugin, { _internal } from "./index.mjs"

let fixture
let upstreamFetch
const options = { appId: "fixture-app" }
const cachedModels = [
  { config_name: "raw-model", slug: "Raw Model", business_metadata: { variants: { standard_key: "raw-model__standard" } } },
  { config_name: "unsupported-model", business_metadata: { uses_tob_raw_chat_surface: false } },
]
const writeModels = (models = cachedModels) => {
  writeFileSync(join(fixture, "cli/models_cache.json"), JSON.stringify({ models }))
}
const savedAuth = (extra = {}) => ({
  type: "oauth", access: "fixture-stored", refresh: "", expires: 0, uid: "fixture-user",
  source: "trae-private-cli", baseURL: "https://upstream.invalid", appId: "fixture-app", ...extra,
})
const plugin = (extra = {}) => _internal.createPlugin({ ...options, ...extra }, (...args) => upstreamFetch(...args))
const writeAuth = (overrides = {}) => {
  writeFileSync(join(fixture, "cli/auth.json"), JSON.stringify({ trae: {
    access_token: "fixture-access", refresh_token: "fixture-refresh", user_id: "fixture-user",
    expires_at: new Date(Date.now() + 3600e3).toISOString(),
    endpoints: { api_base_url: "https://upstream.invalid" }, ...overrides,
  } }))
}
beforeAll(() => {
  const sessions = join(import.meta.dir, "../../.sandbox/trae-private")
  mkdirSync(sessions, { recursive: true })
  fixture = mkdtempSync(join(sessions, "test-"))
  mkdirSync(join(fixture, "cli"))
  options.traeHome = fixture
})
beforeEach(() => {
  writeAuth()
  writeModels()
  upstreamFetch = async () => { throw new Error("Unexpected upstream request") }
})
afterAll(() => {
  rmSync(fixture, { recursive: true })
})

const {
  quotaOf,
  usageSourceOf,
  readCookie,
  sessionPost,
  sameOriginPath,
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
    model: "raw-model",
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
    const body = chatBody({ ...toolsReq, tool_choice: { type: "function", function: { name: "get_weather" } } }, "s1",
      [{ id: "raw-model", wire: "raw-model__standard" }])
    expect(body.tool_choice).toBe("required")
    expect(body.model_name).toBe("raw-model__standard")
    expect(body.config_name).toBe("raw-model")
    expect(body.session_id).toBe("s1")
    // 没有 tools 时不带 tool_choice
    const plain = chatBody({ model: "raw-model", messages: [{ role: "user", content: "hi" }], tool_choice: "auto" }, "s2")
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

  test("partial_arguments 兜底；首帧缺 id 时补 call_<index>，续帧不再带 id 与 name", () => {
    const seen = new Set()
    const first = callsOf({ tool_calls: [{ function_call: { name: "f", partial_arguments: '{"a":' } }] }, seen)
    // 空 id 会让 ai-sdk 配不上工具结果，所以首帧就补一个。
    expect(first).toEqual([{ index: 0, id: "call_0", type: "function", function: { name: "f", arguments: '{"a":' } }])

    const next = callsOf({ tool_calls: [{ function_call: { partial_arguments: '1}' } }] }, seen)
    expect(next).toEqual([{ index: 0, type: "function", function: { arguments: '1}' } }])

    // upstream 自己带 id 时用它，不覆盖。
    expect(callsOf({ tool_calls: [{ id: "real-id", function_call: { name: "f" } }] }, new Set())[0].id).toBe("real-id")
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
  const request = (extra = {}) => JSON.stringify({ model: "raw-model", messages: [{ role: "user", content: "fixture" }], stream: false, ...extra })
  const loader = async () => plugin().auth.loader(async () => savedAuth())
  const wire = (...events) => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")
  const responseOf = (text, cancel = () => {}) => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(text)) }, cancel,
  }), { headers: { "content-type": "text/event-stream" } })

  test("首个业务错误关闭仍然打开的上游", async () => {
    let cancelled = false, signal
    upstreamFetch = async (_, init) => {
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
    upstreamFetch = async (_, init) => {
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
    upstreamFetch = async () => {
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
    upstreamFetch = async () => new Response(wire(["output", { response: "半截" }]), { headers: { "content-type": "text/event-stream" } })
    const res = await (await loader()).fetch("https://gateway.invalid/v1/chat/completions", { body: request() })
    expect(res.status).toBe(502)
    expect((await res.json()).error.message).toContain("中断")
  })

  test("流式入口拒绝没有结束事件的半截回答", async () => {
    upstreamFetch = async () => new Response(wire(["output", { response: "半截" }]), { headers: { "content-type": "text/event-stream" } })
    const res = await (await loader()).fetch("https://gateway.invalid/v1/chat/completions", { body: request({ stream: true }) })
    const body = await res.text()
    expect(body).toContain("半截")
    expect(body).toContain("结束事件前中断")
    expect(body).not.toContain('"finish_reason":"stop"')
  })

  test("首个事件前的读取异常返回错误响应", async () => {
    upstreamFetch = async () => new Response(new ReadableStream({
      start(c) { c.error(new Error("fixture read failure")) },
    }), { headers: { "content-type": "text/event-stream" } })
    const res = await (await loader()).fetch("https://gateway.invalid/v1/chat/completions", { body: request() })
    expect(res.status).toBe(502)
  })

  test("首个事件后的读取异常发错误帧", async () => {
    let reads = 0
    upstreamFetch = async () => new Response(new ReadableStream({
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
    const hooks = plugin()
    const config = { provider: { "trae-private": { models: { "unsupported-model": { name: "old" } } } } }
    await hooks.config(config)
    expect(config.provider["trae-private"].models["unsupported-model"]).toBeUndefined()
    expect(config.provider["trae-private"].models["raw-model"]).toBeDefined()
    expect((await hooks.provider.models({ models: {} }))["unsupported-model"]).toBeUndefined()
  })

  test("指定不存在的工具时拒绝请求，不降级成任意工具", async () => {
    upstreamFetch = async () => { throw new Error("不应访问上游") }
    const res = await (await loader()).fetch("https://gateway.invalid/v1/chat/completions", { body: request({
      tools: [{ type: "function", function: { name: "other" } }],
      tool_choice: { type: "function", function: { name: "missing" } },
    }) })
    expect(res.status).toBe(400)
  })

  test("过期凭据不报告刷新成功；CLI 更新后可直接恢复", async () => {
    const hooks = plugin()
    writeAuth({ expires_at: "2000-01-01T00:00:00Z" })
    const error = await hooks.auth.refresh(savedAuth()).catch((e) => e)
    expect(error.message).toContain("过期")
    expect(error.signIn).toBeUndefined()
    const fetcher = await loader()
    const expired = await fetcher.fetch("https://gateway.invalid/v1/chat/completions", { body: request() })
    expect(expired.status).toBe(401)
    expect(expired.headers.get("X-Magpie-Sign-In")).toBe("kept")
    writeAuth({ access_token: "fixture-new" })
    const renewed = await hooks.auth.refresh(savedAuth({ access: "fixture-old" }))
    expect(renewed.access).toBe("fixture-new")
    expect(await hooks.auth.refresh(savedAuth(renewed))).toBeUndefined()
    let authorization
    upstreamFetch = async (_, init) => {
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

describe("deployment configuration and account binding", () => {
  const body = JSON.stringify({ model: "raw-model", messages: [{ role: "user", content: "fixture" }], stream: false })

  test("unconfigured entry loads without inventing a provider or models", async () => {
    const hooks = await TraePrivateAuthPlugin({}, { traeHome: fixture })
    const config = {}
    await hooks.config(config)
    expect(config.provider).toBeUndefined()
    expect((await hooks.auth.methods[0].authorize()).error).toContain("appId")
  })

  test("missing cache has no deployment-specific fallback models", async () => {
    rmSync(join(fixture, "cli/models_cache.json"))
    const hooks = plugin()
    const config = {}
    await hooks.config(config)
    expect(config.provider).toBeUndefined()
    expect(await hooks.provider.models({ models: {} })).toEqual({})
    expect((await hooks.auth.methods[0].authorize()).error).toContain("No raw-chat models")
  })

  test("cache filters hidden, unavailable and incompatible models", async () => {
    writeModels([...cachedModels, null, { config_name: "hidden", visibility: "hidden" },
      { config_name: "not-api", supported_in_api: false }])
    expect(Object.keys(await plugin().provider.models({ models: {} }))).toEqual(["raw-model"])
  })

  test("endpoint has no fallback and accepts an explicit override", async () => {
    writeAuth({ endpoints: {} })
    expect((await plugin().auth.methods[0].authorize()).error).toContain("baseURL")
    const connected = await plugin({ baseURL: "https://private.example.test/prefix/" }).auth.methods[0].authorize()
    expect(connected.type).toBe("success")
    expect(connected.baseURL).toBe("https://private.example.test/prefix")
  })

  test("rejects unsafe endpoint forms in options and CLI login", async () => {
    for (const baseURL of ["http://private.example.test", "https://user:secret@private.example.test",
      "https://private.example.test/?token=secret", "https://private.example.test/#fragment"]) {
      expect(() => plugin({ baseURL })).toThrow()
      writeAuth({ endpoints: { api_base_url: baseURL } })
      const result = await plugin().auth.methods[0].authorize()
      expect(result.type).toBe("failed")
      expect(result.error).not.toContain("secret")
    }
  })

  test("sign-in binds the vendor identity, endpoint and app without copying the CLI refresh token", async () => {
    const hooks = plugin()
    const result = await hooks.auth.methods[0].authorize()
    expect(result.type).toBe("success")
    expect(result.uid).toBe("fixture-user")
    expect(result.accountId).toContain("https://upstream.invalid")
    expect(result.appId).toBe("fixture-app")
    expect(result.source).toBe("trae-private-cli")
    expect(result.refresh).toBe("")
    expect(JSON.stringify(result)).not.toContain("fixture-refresh")
    expect(await hooks.auth.refresh(savedAuth({ access: result.access, expires: result.expires }))).toBeUndefined()
  })

  test("CLI account and deployment changes require reconnecting, without contacting upstream", async () => {
    let requests = 0
    upstreamFetch = async () => { requests++; throw new Error("Unexpected upstream request") }
    const hooks = plugin()
    const fetcher = await hooks.auth.loader(async () => savedAuth())
    for (const change of [{ user_id: "other-user" }, { endpoints: { api_base_url: "https://other.invalid" } }]) {
      writeAuth(change)
      const response = await fetcher.fetch("https://gateway.invalid/v1/chat/completions", { body })
      expect(response.status).toBe(401)
      expect(response.headers.get("X-Magpie-Sign-In")).toBe("expired")
      expect((await hooks.auth.refresh(savedAuth()).catch((e) => e)).signIn).toBe("expired")
      expect((await hooks.provider.models({ models: {} }, { auth: savedAuth() }).catch((e) => e)).signIn).toBe("expired")
    }
    writeAuth()
    const changedApp = await plugin({ appId: "other-app" }).auth.loader(async () => savedAuth())
    expect((await changedApp.fetch("https://gateway.invalid/v1/chat/completions", { body })).status).toBe(401)
    expect(requests).toBe(0)
  })

  test("fetch checks the currently saved account and never accepts an unbound sign-in", async () => {
    let auth = savedAuth()
    const fetcher = await plugin().auth.loader(async () => auth)
    auth = savedAuth({ uid: "other-user" })
    expect((await fetcher.fetch("https://gateway.invalid/v1/chat/completions", { body })).status).toBe(401)
    auth = null
    expect((await fetcher.fetch("https://gateway.invalid/v1/chat/completions", { body })).status).toBe(401)
    auth = { type: "oauth", access: "unbound" }
    expect((await fetcher.fetch("https://gateway.invalid/v1/chat/completions", { body })).status).toBe(401)
  })

  test("explicit models and client headers support another deployment without a cache", async () => {
    rmSync(join(fixture, "cli/models_cache.json"))
    // The CLI has to have logged in to the same deployment: a token is only
    // meant for the origin that issued it.
    writeAuth({ endpoints: { api_base_url: "https://private.example.test" } })
    const hooks = plugin({ baseURL: "https://private.example.test/prefix/", models: [{
      id: "raw-model", name: "Custom", wire: "custom-wire", context: 64000, output: 8000, image: true,
    }], client: { ideVersionCode: "123", ideVersion: "1.2.3", version: "custom-cli", userAgent: "fixture-cli" } })
    const config = {}
    await hooks.config(config)
    expect(config.provider["trae-private"].api).toBe("https://private.example.test/prefix/v1")
    expect(config.provider["trae-private"].models["raw-model"].limit).toEqual({ context: 64000, output: 8000 })
    const models = await hooks.provider.models({ models: {} })
    expect(models["raw-model"].capabilities.input.image).toBe(true)
    let request
    upstreamFetch = async (url, init) => {
      request = { url, ...init }
      return new Response('event: output\ndata: {"response":"OK"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n',
        { headers: { "content-type": "text/event-stream" } })
    }
    const auth = await hooks.auth.methods[0].authorize()
    const fetcher = await hooks.auth.loader(async () => savedAuth(auth))
    const headers = {}
    await hooks["chat.headers"]({ model: { providerID: "trae-private" }, sessionID: "session-fixture" }, { headers })
    const res = await fetcher.fetch("https://gateway.invalid/v1/chat/completions", { body, headers })
    expect(res.status).toBe(200)
    expect(request.url).toBe("https://private.example.test/prefix/api/ide/v2/llm_raw_chat")
    expect(request.redirect).toBe("error")
    expect(request.headers["x-app-id"]).toBe("fixture-app")
    expect(request.headers["x-ide-version-code"]).toBe("123")
    expect(request.headers["x-ide-version"]).toBe("1.2.3")
    expect(request.headers.version).toBe("custom-cli")
    expect(request.headers["User-Agent"]).toBe("fixture-cli")
    expect(JSON.parse(request.body).model_name).toBe("custom-wire")
    expect(JSON.parse(request.body).session_id).toBe("session-fixture")
  })

  test("unknown models and invalid explicit catalogs fail before an upstream request", async () => {
    const fetcher = await plugin().auth.loader(async () => savedAuth())
    const response = await fetcher.fetch("https://gateway.invalid/v1/chat/completions", {
      body: JSON.stringify({ model: "unknown", messages: [{ role: "user", content: "hi" }] }),
    })
    expect(response.status).toBe(400)
    expect(() => plugin({ models: {} })).toThrow("array")
    expect(() => plugin({ models: [{}] })).toThrow("id")
    expect(() => plugin({ models: [{ id: "m", context: -1 }] })).toThrow("positive integer")
  })

  // 缓存里声明的窗口才是默认值：不替所有部署假定更大的数。
  test("缓存模型默认按 CLI 缓存声明的窗口，__max 档优先", async () => {
    writeModels([
      { config_name: "dev-only", context_window: 200000, business_metadata: { variants: { standard_key: "dev-only__dev" } } },
      { config_name: "with-max", context_window: 200000,
        business_metadata: { variants: { standard_key: "with-max__dev", max_key: "with-max__max", max_context_window: 1048566 } } },
      { config_name: "small", context_window: 184000 },
    ])
    const hooks = plugin()
    const config = {}
    await hooks.config(config)
    const models = config.provider["trae-private"].models
    expect(models["dev-only"].limit).toEqual({ context: 200000, output: 32000 })
    expect(models["with-max"].limit).toEqual({ context: 1048566, output: 32000 })
    expect(models["small"].limit.context).toBe(184000)
  })

  // 部署量过自己的端点能收更多时，打开开关按 limits.context 上报。
  test("开关打开后按 limits.context 上报，__max 声明仍优先", async () => {
    writeModels([
      { config_name: "dev-only", context_window: 200000 },
      { config_name: "with-max", context_window: 200000,
        business_metadata: { variants: { max_context_window: 1048566 } } },
    ])
    const on = _internal.createPlugin({ ...options, limits: { context: 900000 } },
      () => { throw new Error("no upstream") },
      { magpie: { option: (p, k) => (p === "trae-private" && k === "max-context-window" ? true : undefined) } })
    const cfg = {}
    await on.config(cfg)
    const models = cfg.provider["trae-private"].models
    expect(models["dev-only"].limit.context).toBe(900000)
    expect(models["with-max"].limit.context).toBe(1048566)
  })

  test("limits 覆盖缓存模型的上限，显式模型未给时沿用 limits", async () => {
    // 缓存没声明窗口时，limits.context 是回落值。
    const hooks = plugin({ limits: { context: 900000, output: 64000 } })
    const config = {}
    await hooks.config(config)
    expect(config.provider["trae-private"].models["raw-model"].limit).toEqual({ context: 900000, output: 64000 })
    const models = await hooks.provider.models({ models: {} })
    expect(models["raw-model"].limit).toEqual({ context: 900000, output: 64000 })

    rmSync(join(fixture, "cli/models_cache.json"))
    const explicit = plugin({ limits: { context: 500000 }, models: [{ id: "only-id" }] })
    const cfg = {}
    await explicit.config(cfg)
    expect(cfg.provider["trae-private"].models["only-id"].limit).toEqual({ context: 500000, output: 32000 })
    expect(() => plugin({ limits: { context: 0 } })).toThrow("positive integer")
    expect(() => plugin({ limits: { output: 1.5 } })).toThrow("positive integer")
    expect(() => plugin({ limits: [] })).toThrow("object")
  })

  // 供应商编辑器里的 Off/On 开关（auth.options），magpie 用 input.magpie.option 交过来。
  test("max-context-window 开关：关闭用缓存值，打开用 limits.context，__max 声明始终优先", async () => {
    writeModels([
      { config_name: "dev-only", context_window: 200000 },
      // 部署声明了 __max 档：那是它自己的权威值，开关不覆盖。
      { config_name: "with-max", context_window: 200000,
        business_metadata: { variants: { max_context_window: 1048566 } } },
      // 缓存里没有窗口时，关掉开关也不可能凭空造一个。
      { config_name: "no-window" },
    ])
    const build = (flag) => _internal.createPlugin({ ...options, limits: { context: 900000 } },
      () => { throw new Error("no upstream in this test") },
      flag === undefined
        ? undefined
        : { magpie: { option: (provider, key) => (provider === "trae-private" && key === "max-context-window" ? flag : undefined) } })

    const off = await build(false).provider.models({ models: {} })
    expect(off["dev-only"].limit.context).toBe(200000)
    expect(off["with-max"].limit.context).toBe(1048566)
    expect(off["no-window"].limit.context).toBe(900000)

    const on = await build(true).provider.models({ models: {} })
    expect(on["dev-only"].limit.context).toBe(900000)
    expect(on["with-max"].limit.context).toBe(1048566)

    // 没有 input（OpenCode 直接调用）时按声明的 default：关闭。
    const bare = await build(undefined).provider.models({ models: {} })
    expect(bare["dev-only"].limit.context).toBe(200000)
  })
})

// The endpoint refuses by request-body bytes; base64 images ride along in tool
// results every turn, so a long session hits the wall long before its window.
describe("request-body budget", () => {
  const img = (n) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(n)}` } })
  const limits = { bodyBytes: 9 * 1024 * 1024, toolResultKeep: 20000 }

  test("over budget drops older images, keeping the newest", () => {
    const body = { messages: [
      { role: "user", content: [img(4_000_000)] },
      { role: "user", content: [img(4_000_000)] },
      { role: "user", content: [img(4_000_000)] },
    ] }
    const notes = fitBody(body, limits)
    expect(notes.droppedImages).toBe(2)
    expect(body.messages[2].content.filter((p) => p.type === "image_url").length).toBe(1)
  })

  test("still over budget truncates oversized tool results", () => {
    const body = { messages: [{ role: "tool", content: [{ type: "text", text: "x".repeat(12_000_000) }] }] }
    const notes = fitBody(body, limits)
    expect(notes.truncatedTools).toBe(1)
    expect(body.messages[0].content[0].text.length).toBeLessThan(30_000)
  })

  test("within budget nothing is touched", () => {
    const body = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }, img(1000)] }] }
    const notes = fitBody(body, limits)
    expect(notes.droppedImages).toBe(0)
    expect(notes.truncatedTools).toBe(0)
    expect(body.messages[0].content.length).toBe(2)
  })

  test("a lone image inside the budget is kept", () => {
    const body = { messages: [{ role: "user", content: [img(1000)] }] }
    expect(dropImages(body.messages, 1)).toBe(0)
    expect(body.messages[0].content.length).toBe(1)
  })

  test("sendable leaves the bookkeeping behind", () => {
    const out = sendable({ config_name: "m", fitted: { droppedImages: 1 } })
    expect(out).not.toContain("fitted")
    expect(JSON.parse(out).config_name).toBe("m")
  })

  test("limits accept bodyBytes and toolResultKeep", () => {
    expect(() => plugin({ limits: { bodyBytes: 0 } })).toThrow("positive integer")
    expect(() => plugin({ limits: { toolResultKeep: -1 } })).toThrow("positive integer")
  })
})

// An administrator may raise or lower either allowance at any time.
describe("allowances an administrator changes", () => {
  const source = usageSourceOf({ cookieFile: "/tmp/c", quotaPath: "/q", usagePath: "/u" })
  const quota = (seat, paygo) => ({ user_model_quota: { seat_pool_currency_quota: seat, paygo_currency_quota: paygo } })
  const usage = (seatCost, overCost) => ({ user_usage_list: [
    { in_seat_detail: { chat_usage_details: seatCost ? [{ total_cost_currency: seatCost, display_name: "M" }] : [] } },
    { model_usage_detail_list: overCost ? [{ total_cost_currency: overCost }] : [] },
  ] })

  test("raised: the share falls and more is left", () => {
    const r = quotaOf(source, quota(2000, 200), usage(717.322, 0))
    expect(r.windows[0].used).toBeCloseTo(35.87, 1)
    expect(r.balance).toBe("1,282.68")
  })

  test("lowered under what is spent: caps at 100 and says how much is over", () => {
    const r = quotaOf(source, quota(500, 200), usage(717.322, 0))
    // magpie 允许 used 超过 100 表示超支，所以报真实比例而不是封顶。
    expect(r.windows[0].used).toBeCloseTo(143.46, 1)
    expect(r.windows[0].display).toContain("over")
  })

  test("one allowance set to 0 drops that window only", () => {
    const r = quotaOf(source, quota(1000, 0), usage(717.322, 0))
    expect(r.windows.length).toBe(1)
    expect(r.windows[0].name).toBe("Seat usage")
  })

  test("both removed says so rather than drawing an empty card", () => {
    const r = quotaOf(source, quota(0, 0), usage(717.322, 0))
    expect(r.windows).toEqual([])
    expect(r.error).toBeTruthy()
  })

  test("a missing quota block does not throw", () => {
    expect(() => quotaOf(source, {}, { user_usage_list: [] })).not.toThrow()
  })

  test("under a cent is rounding, not an overdraft", () => {
    // 200.009 对 200：差 0.009，是账单舍入。
    const quiet = quotaOf(source, quota(1000, 200), usage(717.322, 200.009))
    expect(quiet.windows[1].display).not.toContain("over")
    // 200.011 对 200：差 0.011，真的超了。
    const over = quotaOf(source, quota(1000, 200), usage(717.322, 200.011))
    expect(over.windows[1].display).toContain("over")
  })

  test("usage without config declares none instead of guessing endpoints", () => {
    expect(usageSourceOf(undefined)).toBe(null)
    expect(() => usageSourceOf({ cookiePath: "x" })).toThrow("cookieFile")
  })
})

// The cookie must never leave the deployment, and a value may contain "=".
describe("usage source and its cookie", () => {
  test('readCookie 把裸值整行当值，含 "=" 也算', () => {
    const dir = mkdtempSync(join(import.meta.dir, "../../.sandbox/trae-private/ck-"))
    const bare = join(dir, "bare")
    writeFileSync(bare, "abc=def==\n")
    // 裸值整行都是值：base64 填充自带 "="。
    expect(readCookie(bare, "S")).toBe("abc=def==")
    const named = join(dir, "named")
    writeFileSync(named, "S=abc=def==")
    // 只有显式的 "名字=" 前缀才被剥掉。
    expect(readCookie(named, "S")).toBe("abc=def==")
    expect(readCookie(join(dir, "missing"), "S")).toBe("")
  })

  test("a usage path must stay on the deployment origin", () => {
    const base = "https://corp.example"
    expect(sameOriginPath(base, "/a/b")).toBe("https://corp.example/a/b")
    // 这些都会把 cookie 送出去，必须拒。
    for (const bad of ["@evil.example/q", ".evil.example/u", "//evil.example/q", "http://evil.example/q", "a/b"]) {
      expect(() => sameOriginPath(base, bad)).toThrow()
    }
  })

  test("sessionPost refuses a redirect instead of following it", async () => {
    let seen
    const real = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      seen = { url, init }
      return new Response(JSON.stringify({ code: 0 }), { headers: { "content-type": "application/json" } })
    }
    try {
      await sessionPost("https://corp.example/q", "S", "v")
    } finally {
      globalThis.fetch = real
    }
    // 跳转会被跟到别的 host，所以必须显式拒绝。
    expect(seen.init.redirect).toBe("error")
    expect(seen.init.headers.Cookie).toBe("S=v")
  })

  test("usage without config says so; a missing cookie file says so too", async () => {
    const none = await plugin().auth.usage(async () => null)
    expect(none.windows).toEqual([])
    expect(none.error).toContain("usage option")

    const configured = plugin({ usage: { cookieFile: "/nonexistent/ck", quotaPath: "/q", usagePath: "/u" } })
    const missing = await configured.auth.usage(async () => null)
    expect(missing.windows).toEqual([])
    expect(missing.error).toContain("cookie")
    // 读不到时账号不该被判失效。
    expect(missing.signIn).toBe("kept")
  })

  test("usage requires its paths and cookieFile", () => {
    expect(() => plugin({ usage: { quotaPath: "/q", usagePath: "/u" } })).toThrow("cookieFile")
    expect(() => plugin({ usage: [] })).toThrow("object")
  })
})

// 排队事件的 data 里偶尔带 error 字段（上游的排队提示），在 error 判断之前
// 就要挡住，否则一次正常排队会被报成请求失败。
describe("queue events are not content and not failures", () => {
  test("a queue event carrying error is ignored", () => {
    const p = piece({ event: "queue_position", data: { error: "waiting in queue", position: 3 } })
    expect(p.error).toBeUndefined()
    expect(p.text).toBeUndefined()
    expect(p.done).toBeUndefined()
  })

  test("progress_notice is a heartbeat, not text", () => {
    expect(piece({ event: "progress_notice", data: ";Processing_…" })).toEqual({})
  })

  test("a real error event still fails", () => {
    expect(piece({ event: "error", data: { code: 4023, error: "unknown model" } }).error).toBeTruthy()
  })
})
