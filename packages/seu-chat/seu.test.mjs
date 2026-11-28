import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import {
  CHAT_URL,
  MAX_PROMPT,
  MODELS,
  SeuClient,
  SeuError,
  cookieHeader,
  mergeSetCookie,
  modelsOf,
  parseCookieHeader,
} from "./seu.mjs"
import { fakeSeu } from "./testdata/fakeseu.mjs"

const COOKIES = { SESSION: "abc", OTHER: "1" }

test("modelsOf：内置表，options.models 覆盖并追加", () => {
  assert.deepEqual(modelsOf(), MODELS)
  const withX = modelsOf({ models: [{ id: "x", name: "X", code: 9 }] })
  assert.equal(withX.x.code, 9)
  assert.equal(withX["glm-5.3-flash"].code, 4)
  assert.equal("bad" in modelsOf({ models: [{ id: "bad" }] }), false)
})

test("cookieHeader / parseCookieHeader / mergeSetCookie", () => {
  assert.equal(cookieHeader({ a: "1", b: "2" }), "a=1; b=2")
  assert.deepEqual(parseCookieHeader("Cookie: a=1; b=2; junk"), { a: "1", b: "2" })
  assert.deepEqual(parseCookieHeader("a=1; b=2"), { a: "1", b: "2" })
  const res = new Response("", {
    headers: [["set-cookie", "b=2; Path=/"], ["set-cookie", "a=; Max-Age=0"]],
  })
  assert.deepEqual(mergeSetCookie({ a: "1", keep: "yes" }, res), { keep: "yes", b: "2" })
})

test("userInfo 读回姓名和学号", async () => {
  const fake = fakeSeu()
  const client = new SeuClient({ cookies: COOKIES, fetchImpl: fake.fetch })
  const who = await client.userInfo()
  assert.deepEqual(who, { name: "张三", uid: "21321xxxx", isadmin: false, apiKeyEndpoints: false })
  assert.equal(fake.calls[0].path, "/api/cas/userInfo")
  assert.match(fake.calls[0].headers.cookie, /SESSION=abc/)
  assert.equal(fake.calls[0].headers.referer, CHAT_URL)
})

test("ask：新对话、整段 prompt、modelCode，读完后删除对话", async () => {
  const fake = fakeSeu()
  const client = new SeuClient({ cookies: COOKIES, fetchImpl: fake.fetch })
  const r = await client.ask("你好", { modelCode: 4 })
  assert.deepEqual(r, { text: "Hello\nworld again", reasoning: "Let me think\nhard", conversationId: "conv-7f3a" })
  assert.deepEqual(JSON.parse(fake.calls[0].body), {
    conversationID: "",
    modelCode: 4,
    content: "你好",
    typeCode: 0,
    fileIds: [],
    enableSearch: false,
  })
  assert.equal(fake.calls[1].query.get("messageId"), "m-1")
  assert.equal(fake.calls[1].headers.accept, "text/event-stream")
  assert.equal(fake.calls[2].path, "/api/chat/del-conversation")
  assert.deepEqual(JSON.parse(fake.calls[2].body), { conversationID: "conv-7f3a" })
})

test("ask：onUpdate 的增量拼起来等于最终结果", async () => {
  const fake = fakeSeu()
  const client = new SeuClient({ cookies: COOKIES, fetchImpl: fake.fetch })
  const contents = []
  const reasonings = []
  await client.ask("你好", { modelCode: 4, onUpdate: (d) => {
    if (d.content) contents.push(d.content)
    if (d.reasoning) reasonings.push(d.reasoning)
  } })
  assert.equal(contents.join(""), "Hello\nworld again")
  assert.equal(reasonings.join(""), "Let me think\nhard")
})

test("ask：messageId 是对象也能用；没有 messageId 报中文错", async () => {
  const fake = fakeSeu({ post: { code: 0, response: { messageId: "m-2" } } })
  const client = new SeuClient({ cookies: COOKIES, fetchImpl: fake.fetch })
  await client.ask("你好", { modelCode: 4 })
  assert.equal(fake.calls[1].query.get("messageId"), "m-2")

  const fake2 = fakeSeu({ post: { code: 0, response: null } })
  await assert.rejects(
    new SeuClient({ cookies: COOKIES, fetchImpl: fake2.fetch }).ask("你好", { modelCode: 4 }),
    (e) => e.message === "ChatSEU 没有返回 messageId。",
  )
})

// GET 流的 messageId 是 calls[1]

test("ask：超过 MAX_PROMPT 直接 413，不发请求", async () => {
  const fake = fakeSeu()
  const client = new SeuClient({ cookies: COOKIES, fetchImpl: fake.fetch })
  await assert.rejects(client.ask("x".repeat(MAX_PROMPT + 1), { modelCode: 4 }), (e) => {
    assert.equal(e.code, "context_length_exceeded")
    assert.equal(e.status, 413)
    return true
  })
  assert.equal(fake.calls.length, 0)
})

test("未登录：302 是 signIn expired", async () => {
  const fake = fakeSeu({ post: new Response(JSON.stringify({ status: 302, message: "请重新登录" }), { status: 302 }) })
  const client = new SeuClient({ cookies: COOKIES, fetchImpl: fake.fetch })
  await assert.rejects(client.ask("你好", { modelCode: 4 }), (e) => {
    assert.equal(e.signIn, true)
    assert.equal(e.status, 401)
    return true
  })
})

test("aTrust 网关的 307：拦下并报成 seu_atrust，不是半截 HTML 的 502", async () => {
  const page = readFileSync(new URL("./testdata/atrust307.html", import.meta.url), "utf8")
  const fake = fakeSeu({ post: new Response(page, { status: 307 }) })
  const client = new SeuClient({ cookies: COOKIES, fetchImpl: fake.fetch })
  await assert.rejects(client.ask("你好", { modelCode: 4 }), (e) => {
    assert.equal(e.code, "seu_atrust")
    assert.equal(e.status, 502)
    assert.match(e.message, /aTrust/)
    assert.doesNotMatch(e.message, /<html>/)
    return true
  })
})

test("其它来源的 307：保留状态码与原文摘要", async () => {
  const fake = fakeSeu({ post: new Response("moved", { status: 307 }) })
  const client = new SeuClient({ cookies: COOKIES, fetchImpl: fake.fetch })
  await assert.rejects(client.ask("你好", { modelCode: 4 }), (e) => {
    assert.equal(e.code, "seu_error")
    assert.equal(e.status, 502)
    assert.match(e.message, /HTTP 307/)
    assert.match(e.message, /moved/)
    return true
  })
})

test("封号：200 + code 40301 是 403", async () => {
  const fake = fakeSeu({ post: { code: 40301, message: "账号已被封禁" } })
  const client = new SeuClient({ cookies: COOKIES, fetchImpl: fake.fetch })
  await assert.rejects(client.ask("你好", { modelCode: 4 }), (e) => {
    assert.equal(e.code, "seu_blocked")
    assert.equal(e.status, 403)
    return true
  })
})

test("业务失败：code≠0 带 message 的 502", async () => {
  const fake = fakeSeu({ post: { code: 500, message: "模型繁忙" } })
  const client = new SeuClient({ cookies: COOKIES, fetchImpl: fake.fetch })
  await assert.rejects(client.ask("你好", { modelCode: 4 }), (e) => {
    assert.equal(e.status, 502)
    assert.equal(e.message, "ChatSEU：模型繁忙")
    return true
  })
})

test("429", async () => {
  const fake = fakeSeu({ post: new Response("too many", { status: 429 }) })
  const client = new SeuClient({ cookies: COOKIES, fetchImpl: fake.fetch })
  await assert.rejects(client.ask("你好", { modelCode: 4 }), (e) => {
    assert.equal(e.code, "rate_limited")
    assert.equal(e.status, 429)
    return true
  })
})

test("回复里的 Set-Cookie 存回账号", async () => {
  const got = []
  const base = fakeSeu()
  const fake = {
    calls: base.calls,
    fetch: async (url, init) => {
      const res = await base.fetch(url, init)
      if (new URL(String(url)).searchParams.get("messageId"))
        return new Response(await res.clone().text(), { status: res.status, headers: [...res.headers, ["set-cookie", "JSESSIONID=abc; Path=/"]] })
      return res
    },
  }
  const client = new SeuClient({ cookies: { ...COOKIES }, fetchImpl: fake.fetch, onCookies: (c) => (got.push(c), c) })
  await client.ask("你好", { modelCode: 4 })
  const last = got[got.length - 1]
  assert.equal(last.JSESSIONID, "abc")
  // 下一次请求的 cookie 头带上新 cookie
  await client.userInfo()
  const cookieCall = base.calls.filter((c) => c.path === "/api/cas/userInfo").at(-1)
  assert.match(String(cookieCall.headers.cookie), /JSESSIONID=abc/)
})

test("中途 abort：上游被取消，对话仍被删除", async () => {
  let cancelled = false
  const enc = new TextEncoder()
  const makeBody = () =>
    new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('event: metadata\nid: conv-abort\ndata: {"rounds":1}\n\n'))
        c.enqueue(enc.encode("data: 部分\n\n"))
      },
      pull() {
        // 挂起，等 cancel
      },
      cancel() {
        cancelled = true
      },
    })
  // 函数形式：每个请求拿全新流；夹具 tee 分支的 cancel 不会传播到源流
  const fake = fakeSeu({ stream: () => new Response(makeBody(), { status: 200, headers: { "content-type": "text/event-stream" } }) })
  const client = new SeuClient({ cookies: COOKIES, fetchImpl: fake.fetch })
  const ctl = new AbortController()
  await assert.rejects(
    client.ask("你好", { modelCode: 4, signal: ctl.signal, onUpdate: (d) => {
      if (d.content) ctl.abort()
    } }),
    (e) => e.name === "AbortError",
  )
  // cancel 回调是异步的，给它一个 tick
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(cancelled, true)
  assert.equal(fake.calls.some((c) => c.path === "/api/chat/del-conversation"), true)
})

test("SeuError 的默认值", () => {
  const e = new SeuError(" boom ")
  assert.equal(e.name, "SeuError")
  assert.equal(e.code, "seu_error")
  assert.equal(e.status, 502)
  assert.equal(e.signIn, false)
})

test("真实录制的回复能完整解析", async (t) => {
  const real = new URL("./testdata/real.sse", import.meta.url)
  if (!existsSync(real)) return t.skip("没有 testdata/real.sse（还没跑过 node probe.mjs chat）")
  const fake = fakeSeu({ stream: new Response(readFileSync(real, "utf8"), { status: 200, headers: { "content-type": "text/event-stream" } }) })
  const client = new SeuClient({ cookies: COOKIES, fetchImpl: fake.fetch })
  const r = await client.ask("你好", { modelCode: 4 })
  assert.ok(r.text.length > 0)
  assert.ok(!r.text.includes("[line]"))
  assert.ok(!r.text.includes("[space]"))
  assert.ok(!r.text.includes("<思考内容>"))
  assert.equal(r.conversationId, "0d3e8751-7405-4bdb-8555-df3b40948f82")
})

test("aTrust 307 在 SSE 步也报 seu_atrust", async () => {
  const page = readFileSync(new URL("./testdata/atrust307.html", import.meta.url), "utf8")
  const fetchImpl = async (url) =>
    String(url).includes("messageId=")
      ? new Response(page, { status: 307 })
      : new Response(JSON.stringify({ code: 0, response: "m1" }), { status: 200, headers: { "content-type": "application/json" } })
  const client = new SeuClient({ cookies: COOKIES, fetchImpl })
  await assert.rejects(client.ask("你好", { modelCode: 4 }), (e) => {
    assert.equal(e.code, "seu_atrust")
    return true
  })
})

test("响应头迟迟不来：connect 超时后抛 seu_timeout（504），不是无限等", async () => {
  const slow = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)))
  const client = new SeuClient({ cookies: COOKIES, fetchImpl: slow, timeouts: { connect: 80, stream: 1000 } })
  const t0 = Date.now()
  await assert.rejects(client.ask("你好", { modelCode: 4 }), (e) => {
    assert.equal(e.code, "seu_timeout")
    assert.equal(e.status, 504)
    assert.equal(e.retryAfter, 0)
    return true
  })
  assert.ok(Date.now() - t0 < 1000)
})

test("SSE 流中途停止发事件：stream 总超时后抛 seu_timeout", async () => {
  const stalled = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("event: metadata\nid: c1\ndata: {}\n\n")) } })
  const fetchImpl = async (url) =>
    String(url).includes("messageId=")
      ? new Response(stalled, { status: 200, headers: { "content-type": "text/event-stream" } })
      : new Response(JSON.stringify({ code: 0, response: "m1" }), { status: 200, headers: { "content-type": "application/json" } })
  const client = new SeuClient({ cookies: COOKIES, fetchImpl, timeouts: { connect: 1000, stream: 150 } })
  await assert.rejects(client.ask("你好", { modelCode: 4 }), (e) => {
    assert.equal(e.code, "seu_timeout")
    return true
  })
})

test("429 带 retryAfter: 60", async () => {
  const fake = fakeSeu({ post: new Response("", { status: 429 }) })
  const client = new SeuClient({ cookies: COOKIES, fetchImpl: fake.fetch })
  await assert.rejects(client.ask("你好", { modelCode: 4 }), (e) => {
    assert.equal(e.retryAfter, 60)
    return true
  })
})

test("客户端取消：上游请求被中止、对话尽力删除", async () => {
  const ctl = new AbortController()
  const fake = fakeSeu({ post: { code: 0, response: "m1" } })
  const client = new SeuClient({ cookies: COOKIES, fetchImpl: fake.fetch })
  const p = client.ask("你好", { modelCode: 4, signal: ctl.signal, onUpdate: () => ctl.abort() })
  await assert.rejects(p, (e) => e.name === "AbortError")
  assert.ok(fake.calls.some((c) => c.path === "/api/chat/del-conversation"), "删对话被调用过")
})
