import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { TAGS, Assembler, decodeText, readSSE, splitThink, tagTail } from "./sse.mjs"

const THINK = readFileSync(new URL("./testdata/think.sse", import.meta.url), "utf8")

test("decodeText 把 [line] 和 [space] 还原", () => {
  assert.equal(decodeText("a[line]b[space]c"), "a\nb c")
})

test("splitThink 分开思考与正文", () => {
  assert.deepEqual(splitThink("<思考内容>想[line]一想</思考内容>答案"), { reasoning: "想\n一想", text: "答案" })
  assert.deepEqual(splitThink("没有标签"), { reasoning: "", text: "没有标签" })
  assert.deepEqual(splitThink("<思考内容>还没结束"), { reasoning: "还没结束", text: "" })
})

test("tagTail 找出可能是半个标签的尾巴", () => {
  assert.equal(tagTail("abc<思考"), "<思考")
  assert.equal(tagTail("abc[li"), "[li")
  assert.equal(tagTail("abc"), "")
  assert.equal(tagTail("abc</思考内容>"), "")
  for (const tag of TAGS) assert.equal(tagTail("abc" + tag), "")
})

test("readSSE 读出 metadata、默认消息、注释，并在返回 false 时停下", async () => {
  const seen = []
  await readSSE(new Response(THINK), (ev) => {
    seen.push(ev)
    return true
  })
  assert.deepEqual(seen, [
    { event: "metadata", id: "conv-7f3a", data: '{"rounds":1}' },
    { event: "", id: "", data: "<思考内" },
    { event: "", id: "", data: "容>Let me think[line]hard</思考" },
    { event: "", id: "", data: "内容>Hello[line]world[space]again" },
    { event: "heartbeat", id: "", data: "ping" },
    { event: "", id: "", data: "[DONE]" },
  ])

  // onEvent 返回 false 即停止并取消流
  const seen2 = []
  await readSSE(new Response(THINK), (ev) => {
    seen2.push(ev)
    return false
  })
  assert.equal(seen2.length, 1)
})

test("readSSE 在 signal 中止时取消流并以 AbortError 拒绝", async () => {
  let cancelled = false
  const body = new ReadableStream({
    pull(c) {
      c.enqueue(new TextEncoder().encode("data: x\n\n"))
    },
    cancel() {
      cancelled = true
    },
  })
  const ctl = new AbortController()
  const reading = readSSE(new Response(body), () => {
    ctl.abort()
    return true
  }, { signal: ctl.signal })
  await assert.rejects(reading, (e) => e.name === "AbortError")
  assert.equal(cancelled, true)
})

test("Assembler 把跨片的思考标签拼回，分别放出 reasoning 和 content", () => {
  const a = new Assembler()
  const out = []
  for (const data of ["<思考内", "容>Let me think[line]hard</思考", "内容>Hello[line]world[space]again"]) out.push(a.push(data))
  out.push(a.flush())
  assert.deepEqual(out[0], {})
  assert.deepEqual(out[1], { reasoning: "Let me think\nhard" })
  assert.deepEqual(out[2], { content: "Hello\nworld again" })
  assert.deepEqual(out[3], {})
  assert.equal(a.reasoning, "Let me think\nhard")
  assert.equal(a.text, "Hello\nworld again")
})

test("Assembler 在串尾的半个标签由 flush 放出", () => {
  const a = new Assembler()
  // 正文 abc 先放出；尾巴 [sp 可能长成 [space]，扣住
  assert.deepEqual(a.push("abc[sp"), { content: "abc" })
  assert.deepEqual(a.flush(), { content: "[sp" })
  assert.equal(a.text, "abc[sp")
})

test("Assembler 没有思考标签时就是正文", () => {
  const a = new Assembler()
  assert.deepEqual(a.push("你"), { content: "你" })
  assert.deepEqual(a.push("好"), { content: "好" })
})

test("idleMs：两个事件间超时就 reject seu_stream_stalled；heartbeat 算活动", async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const enc = new TextEncoder()
  const mk = (pieces) =>
    new Response(
      new ReadableStream({
        async start(c) {
          for (const p of pieces) {
            c.enqueue(enc.encode(p))
            await sleep(60)
          }
          c.close()
        },
      }),
    )
  // 只有 heartbeat，间隔 60ms < idleMs 150 → 不该超时，流正常结束
  await readSSE(mk(["event: heartbeat\ndata: ping\n\n", "event: heartbeat\ndata: ping\n\n"]), () => true, { idleMs: 150 })
  // 一个事件后停住 → 150ms 内没有新事件 → reject
  const stalled = new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode("data: a\n\n")) } }))
  await assert.rejects(readSSE(stalled, () => true, { idleMs: 120 }), (e) => {
    assert.equal(e.code, "seu_stream_stalled")
    assert.equal(e.status, 504)
    return true
  })
})
