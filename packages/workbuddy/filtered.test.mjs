// WorkBuddy's safety filter refusing a reply it had begun (itspig, plugins
// #540): deepseek-v4.1-flash on copilot.tencent.com reasoned, said "Sorry,
// I can't respond to this question.", and ended finish_reason
// content_filter with 0 output tokens, all under a 200. The text is taken
// out, so the reply says nothing before content_filter: the refusal magpie
// asks the group's next member for.
import { expect, test } from "bun:test"
import { WorkBuddyAuthPlugin } from "./index.mjs"

const said = "Sorry, I can't respond to this question."

const chunk = (delta, finish = null, usage) =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "deepseek-v4.1-flash", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`

const zero = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

// pieces is a stream's bytes cut where the given cuts fall, as a server's
// writes may
function streamOf(text, cuts = 7) {
  const b = new TextEncoder().encode(text)
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < b.length; i += cuts) c.enqueue(b.slice(i, i + cuts))
      c.close()
    },
  })
}

async function through(upstream, cuts) {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes("/chat/completions")) return new Response(streamOf(upstream, cuts), { headers: { "content-type": "text/event-stream" } })
    return new Response("{}", { headers: { "content-type": "application/json" } })
  }
  try {
    const hooks = await WorkBuddyAuthPlugin({ client: {} })
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "access", uid: "uid", expires: Date.now() + 3600_000 }))
    const res = await loader.fetch("https://copilot.tencent.com/v2/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-v4.1-flash", stream: true, reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(200)
    return await res.text()
  } finally {
    globalThis.fetch = realFetch
  }
}

const contents = (out) =>
  out
    .split("\n\n")
    .filter((e) => e.startsWith("data: {"))
    .map((e) => JSON.parse(e.slice(6)).choices?.[0])
    .filter(Boolean)

for (const [name, text] of [
  ["in one delta", [chunk({ content: said })]],
  ["a few words at a time", [chunk({ content: "Sorry" }), chunk({ content: ", I can't" }), chunk({ content: " respond to this question." })]],
]) {
  for (const cuts of [7, 1 << 20]) {
    test(`the filter's text before content_filter is taken out, ${name}, ${cuts > 7 ? "whole" : "cut"}`, async () => {
      const upstream =
        chunk({ role: "assistant", reasoning_content: "" }) +
        chunk({ reasoning_content: "The user is asking" }) +
        chunk({ reasoning_content: " about it." }) +
        text.join("") +
        chunk({}, "content_filter", zero) +
        "data: [DONE]\n\n"
      const out = await through(upstream, cuts)
      expect(out).not.toContain("Sorry")
      const cs = contents(out)
      expect(cs.map((c) => c.delta.reasoning_content ?? "").join("")).toBe("The user is asking about it.")
      expect(cs.some((c) => typeof c.delta.content === "string" && c.delta.content)).toBe(false)
      expect(cs.at(-1).finish_reason).toBe("content_filter")
      expect(out.endsWith("data: [DONE]\n\n")).toBe(true)
    })
  }
}

test("the filter's text in the chunk that ends content_filter is taken out", async () => {
  const out = await through(chunk({ reasoning_content: "hm" }) + chunk({ content: said }, "content_filter", zero) + "data: [DONE]\n\n")
  expect(out).not.toContain("Sorry")
  expect(contents(out).at(-1).finish_reason).toBe("content_filter")
})

test("the same words as an answer that ends stop go through whole", async () => {
  const upstream = chunk({ reasoning_content: "hm" }) + chunk({ content: "Sorry" }) + chunk({ content: ", I can't respond to this question." }) + chunk({}, "stop") + "data: [DONE]\n\n"
  expect(await through(upstream)).toBe(upstream)
})

test("a reply that only begins like it goes through as it came", async () => {
  const upstream = chunk({ content: "Sorry" }) + chunk({ content: ", I can't find that file." }) + chunk({}, "stop") + "data: [DONE]\n\n"
  expect(await through(upstream)).toBe(upstream)
})

test("a reply cut off by content_filter after other words keeps them", async () => {
  const upstream = chunk({ content: "Here is the plan: " }) + chunk({ content: said }) + chunk({}, "content_filter") + "data: [DONE]\n\n"
  expect(await through(upstream)).toBe(upstream)
})

test("an answer's words are not held", async () => {
  // the first chunk that isn't the filter's goes out before the stream ends
  const enc = new TextEncoder()
  let push
  const body = new ReadableStream({ start: (c) => (push = c) })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) =>
    String(url).includes("/chat/completions")
      ? new Response(body, { headers: { "content-type": "text/event-stream" } })
      : new Response("{}", { headers: { "content-type": "application/json" } })
  try {
    const hooks = await WorkBuddyAuthPlugin({ client: {} })
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "access", uid: "uid", expires: Date.now() + 3600_000 }))
    const res = await loader.fetch("https://copilot.tencent.com/v2/chat/completions", { method: "POST", body: JSON.stringify({ model: "deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "hi" }] }) })
    const rd = res.body.getReader()
    push.enqueue(enc.encode(chunk({ content: "Hello" })))
    const { value } = await rd.read()
    expect(new TextDecoder().decode(value)).toContain("Hello")
    push.close()
  } finally {
    globalThis.fetch = realFetch
  }
})

// The last chunks copilot.tencent.com sent itspig, byte for byte (plugins
// #540, 2026-10-30): the filter's line comes with a newline on each side, in
// the chunk that ends content_filter.
const LITERAL =
  'data: {"choices":[{"delta":{"content":"","extra_fields":null,"function_call":null,"reasoning_content":" node","refusal":""},"finish_reason":null,"index":0,"logprobs":null}],"created":1793401068,"id":"c56c77084382622efa17c799396db5cf","model":"deepseek-v4.1-flash","object":"chat.completion.chunk","usage":null}\n\n' +
  'data: {"choices":[{"delta":{"content":"\\nSorry, I can\'t respond to this question.\\n","extra_fields":null,"function_call":null,"refusal":"","role":"assistant"},"finish_reason":"content_filter","index":0,"logprobs":null}],"created":0,"id":"c56c77084382622efa17c799396db5cf","model":"deepseek-v4.1-flash","object":"chat.completion.chunk","usage":null}\n\n' +
  "data: [DONE]\n\n"

for (const cuts of [1, 7, 1 << 20]) {
  test(`WorkBuddy's own refusal chunks, newlines and all, say nothing (cut every ${cuts} bytes)`, async () => {
    const out = await through(LITERAL, cuts)
    expect(out).not.toContain("Sorry")
    const cs = contents(out)
    expect(cs.map((c) => c.delta.reasoning_content ?? "").join("")).toBe(" node")
    expect(cs.some((c) => typeof c.delta.content === "string" && c.delta.content)).toBe(false)
    expect(cs.at(-1).finish_reason).toBe("content_filter")
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true)
  })
}

test("the filter's line with its newlines in chunks of their own is taken out", async () => {
  const upstream = chunk({ reasoning_content: "hm" }) + chunk({ content: "\n" }) + chunk({ content: said }) + chunk({ content: "\n" }) + chunk({}, "content_filter", zero) + "data: [DONE]\n\n"
  const out = await through(upstream)
  expect(out).not.toContain("Sorry")
  expect(contents(out).some((c) => typeof c.delta.content === "string" && c.delta.content)).toBe(false)
  expect(contents(out).at(-1).finish_reason).toBe("content_filter")
})

test("the filter's line followed by more words goes through whole", async () => {
  const upstream = chunk({ content: `\n${said}\n` }) + chunk({ content: "But here is the answer." }) + chunk({}, "content_filter") + "data: [DONE]\n\n"
  expect(await through(upstream)).toBe(upstream)
})

test("a reply that opens with a newline and then answers goes through whole", async () => {
  const upstream = chunk({ content: "\n" }) + chunk({ content: "Hello" }) + chunk({}, "stop") + "data: [DONE]\n\n"
  expect(await through(upstream)).toBe(upstream)
})

// copilot.tencent.com puts "tool_calls": [] on every delta, text too, and
// "finish_reason": "" until the last (magpie f2c7536d7, ARNO on Discord).
// magpie's gateway drops the empty list (chatTidy) and writes the chunk
// back with its keys sorted, so itspig's paste, read off magpie, had
// neither. An empty list is no call: the refusal is still the filter's.
const WIRE =
  'data: {"choices":[{"delta":{"content":"","extra_fields":null,"function_call":null,"reasoning_content":" node","refusal":"","tool_calls":[]},"finish_reason":"","index":0,"logprobs":null}],"created":1793401068,"id":"c56c77084382622efa17c799396db5cf","model":"deepseek-v4.1-flash","object":"chat.completion.chunk","usage":null}\n\n' +
  'data: {"choices":[{"delta":{"content":"\\nSorry, I can\'t respond to this question.\\n","extra_fields":null,"function_call":null,"reasoning_content":"","refusal":"","role":"assistant","tool_calls":[]},"finish_reason":"content_filter","index":0,"logprobs":null}],"created":0,"id":"c56c77084382622efa17c799396db5cf","model":"deepseek-v4.1-flash","object":"chat.completion.chunk","usage":null}\n\n' +
  "data: [DONE]\n\n"

for (const cuts of [1, 7, 1 << 20]) {
  test(`the refusal with WorkBuddy's empty tool_calls on every delta says nothing (cut every ${cuts} bytes)`, async () => {
    const out = await through(WIRE, cuts)
    expect(out).not.toContain("Sorry")
    const cs = contents(out)
    expect(cs.map((c) => c.delta.reasoning_content ?? "").join("")).toBe(" node")
    expect(cs.at(-1).finish_reason).toBe("content_filter")
  })
}

test("the filter's line split over deltas that each carry an empty tool_calls is taken out", async () => {
  const d = (content, finish = "") => chunk({ content, reasoning_content: "", tool_calls: [] }, finish)
  const upstream = chunk({ role: "assistant", content: "", reasoning_content: "hm", tool_calls: [] }, "") + d("\n") + d("Sorry") + d(", I can't respond") + d(" to this question.") + d("\n") + d("", "content_filter") + "data: [DONE]\n\n"
  const out = await through(upstream)
  expect(out).not.toContain("Sorry")
  expect(contents(out).at(-1).finish_reason).toBe("content_filter")
})

test("empty tool_calls are stripped so reasoning stays one block (#1532)", async () => {
  const d = (reasoning, finish = null) => chunk({ reasoning_content: reasoning, tool_calls: [] }, finish)
  const upstream = d("The user ") + d("is asking ") + d("for an answer.") + chunk({ content: "ok" }, "stop") + "data: [DONE]\n\n"
  const out = await through(upstream)
  const cs = contents(out)
  expect(cs.slice(0, 3).every((c) => c.delta.tool_calls === undefined)).toBe(true)
  expect(cs.slice(0, 3).map((c) => c.delta.reasoning_content).join("")).toBe("The user is asking for an answer.")
  expect(out).not.toContain('"tool_calls":[]')
})

test("a real tool call still lets the reply through as it came", async () => {
  const upstream = chunk({ content: "", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "grep", arguments: "{}" } }] }) + chunk({ content: said }) + chunk({}, "content_filter") + "data: [DONE]\n\n"
  expect(await through(upstream)).toBe(upstream)
})
