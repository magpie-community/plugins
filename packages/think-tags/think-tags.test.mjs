import * as mod from "./think-tags.middleware.js"
import { check } from "../../scripts/middleware.mjs"
import { expect, test } from "bun:test"

check(import.meta.dir, mod)

// #176: the reply in Kane-Kuroneko's yetone/magpie#2634, as its bytes were
// (magpie's internal/gateway/think_code_test.go): thinking that writes the
// close tag out as an inline-code example, then the answer.
const exampleClose = "<think>开始分析。使用 `<think>...</think>` 标签。\n继续分析。</think>\n最终正文。"

// streamed runs text through strip as a Chat stream of the given deltas,
// then a finish, and gives back the text that came out
function streamed(parts) {
  const ctx = { protocol: "chat", stream: true, options: {}, state: {} }
  let out = ""
  const evs = parts.map((p) => ({ choices: [{ index: 0, delta: { content: p } }] }))
  evs.push({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
  for (const ev of evs) {
    const r = mod.onEvent(ev, ctx) ?? ev
    out += r.choices[0].delta.content ?? ""
  }
  return out
}

// anthropic is streamed for an Anthropic stream's text deltas
function anthropic(parts) {
  const ctx = { protocol: "anthropic", stream: true, options: {}, state: {} }
  let out = ""
  for (const p of parts) {
    const ev = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } }
    out += (mod.onEvent(ev, ctx) ?? ev).delta.text
  }
  return out
}

const chars = (s) => Array.from(s)
// a byte a delta: each UTF-8 byte its own piece (as a Latin-1 character),
// read back as UTF-8 once joined
const bytes = (s) => Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b))
const utf8 = (s) => new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0)))

test("#176: a </think> in inline code doesn't end the block, whole", () => {
  expect(streamed([exampleClose])).toBe("最终正文。")
  expect(anthropic([exampleClose])).toBe("最终正文。")
  const ctx = { protocol: "chat", options: {}, state: {}, status: 200 }
  expect(mod.onResponse({ choices: [{ message: { content: exampleClose } }] }, ctx).choices[0].message.content).toBe("最终正文。")
  expect(mod.onResponse({ content: [{ type: "text", text: exampleClose }] }, ctx).content[0].text).toBe("最终正文。")
  expect(mod.onResponse({ output: [{ type: "message", content: [{ type: "output_text", text: exampleClose }] }] }, ctx).output[0].content[0].text).toBe("最终正文。")
})

test("#176: a character a delta", () => {
  expect(streamed(chars(exampleClose))).toBe("最终正文。")
  expect(anthropic(chars(exampleClose))).toBe("最终正文。")
})

test("#176: a byte a delta", () => {
  expect(utf8(streamed(bytes(exampleClose)))).toBe("最终正文。")
  expect(utf8(anthropic(bytes(exampleClose)))).toBe("最终正文。")
})

// magpie's TestChatThinkCloseInCode, the answer each leaves
const more = [
  ["a double-backtick span", ["<think>a ``x`</think>`` b</think>c"], "c"],
  ["a fenced block", chars("<think>like\n```xml\n</think>\n```\nso</think>\nok"), "ok"],
  ["a span ends with its line", ["<think>a `b\n</think>\nok"], "ok"],
  ["backticks after the close", chars("<think>a</think>\n`x` y"), "`x` y"],
  ["a close tag split by a chunk", ["<think>a `", "x` b</th", "ink>c"], "c"],
  ["backticks held at the end stay thinking", ["<think>a ``"], ""],
]
for (const [name, parts, want] of more) {
  test(name, () => {
    expect(streamed(parts)).toBe(want)
    expect(anthropic(parts)).toBe(want)
  })
}

test("a whole reply with a close only in code keeps its text", () => {
  const ctx = { protocol: "chat", options: {}, state: {}, status: 200 }
  const t = "<think>use `</think>` here"
  expect(mod.onResponse({ choices: [{ message: { content: t } }] }, ctx)).toBeUndefined()
  expect(mod.onResponse({ choices: [{ message: { content: "<think>like\n```\n</think>\n```\n</think>\n\nok" } }] }, ctx).choices[0].message.content).toBe("ok")
})
