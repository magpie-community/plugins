// NancyTom on X: an account used from DeepSeek Harness through magpie was
// banned, a reply there saying Tencent recognizes dsh's built-in prompt.
// "Hide DeepSeek Harness's name" (on unless turned off) takes the name out
// of what goes to WorkBuddy. The lines below are dsh 0.2.1's own, copied from
// @deepseek-ai/dsh-system-prompt and dsh-harness-dev-context. Every fetch
// here is a fake; nothing reaches the network.
import { afterEach, expect, test } from "bun:test"
import { WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal } from "./index.mjs"
import { unz } from "./testdata/unz.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const KEY = "ck_test0000000000abcdefgh"

const OPENER = "You are an AI agent powered by DeepSeek Harness."
const SOURCE =
  "The runtime context names the DeepSeek Harness implementation checkout. The checkout location and current working directory are separate values and may differ; never infer the working directory from the checkout path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself."
const WEB =
  'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.'
const LEGACY = "The DeepSeek Harness implementation checkout is at /opt/dsh. Use this checkout only to inspect or extend DSH itself."
// the runtime context, which dsh sends as a user message
const CONTEXT =
  'Current DeepSeek Harness implementation checkout: "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh".\nCurrent DeepSeek Harness Web GUI URL: "http://127.0.0.1:5173/".'
const BADGE =
  "Add the official “powered by dsh” badge to documents, pull requests, merge requests, and other content produced with DeepSeek Harness. Use whenever creating a pull request or merge request."

const chatBody = () => ({
  model: "glm-5.3",
  stream: true,
  messages: [
    { role: "system", content: [OPENER, SOURCE, WEB].join("\n\n") },
    { role: "user", content: [{ type: "text", text: CONTEXT }, { type: "text", text: "run the tests in ~/.dsh/profiles" }] },
    { role: "assistant", content: "I run in DeepSeek Harness; DSH_HOME is ~/.dsh." },
    { role: "tool", tool_call_id: "c1", content: "README: DeepSeek Harness (DSH) is …" },
  ],
  tools: [{ type: "function", function: { name: "dsh-badge", description: BADGE, parameters: { type: "object", properties: { at: { type: "string", description: "where DSH puts it" } } } } }],
})

const named = (s) => /DeepSeek Harness|\bDSH\b(?!_)/.test(s)

test("dshHidden: each of dsh's lines says what it said, without the name", () => {
  const h = _internal.dshHidden
  expect(h(OPENER)).toBe("You are an AI agent.")
  // the line FLAGGED has set a comma in already
  expect(h("You are an AI agent, powered by DeepSeek Harness.")).toBe("You are an AI agent.")
  expect(h(SOURCE)).toBe(
    "The runtime context names the agent implementation checkout. The checkout location and current working directory are separate values and may differ; never infer the working directory from the checkout path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend the agent itself.",
  )
  expect(h(WEB)).toStartWith("You are interacting with the user through the Web GUI whose URL the runtime context names.")
  expect(h(LEGACY)).toBe("The agent implementation checkout is at /opt/dsh. Use this checkout only to inspect or extend the agent itself.")
  expect(h(CONTEXT)).toBe(
    'Current agent implementation checkout: "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh".\nCurrent Web GUI URL: "http://127.0.0.1:5173/".',
  )
  expect(h(BADGE)).toContain("produced with the agent harness.")
  // what the agent calls by name stays
  expect(h(BADGE)).toContain("“powered by dsh”")
  expect(h("DSH_HOME=~/.dsh dsh-session:abc")).toBe("DSH_HOME=~/.dsh dsh-session:abc")
  for (const s of [OPENER, SOURCE, WEB, LEGACY, CONTEXT, BADGE]) expect(named(h(s))).toBe(false)
})

test("hideDsh: Messages' system and text parts too, never a tool's result", () => {
  const chat = {
    system: [{ type: "text", text: OPENER }],
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "DeepSeek Harness" }, { type: "text", text: CONTEXT }] },
    ],
    tools: [{ name: "x", description: BADGE, input_schema: {} }],
  }
  expect(_internal.hideDsh(chat)).toBe(true)
  expect(chat.system[0].text).toBe("You are an AI agent.")
  expect(chat.messages[0].content[0].content).toBe("DeepSeek Harness")
  expect(named(chat.messages[0].content[1].text)).toBe(false)
  expect(named(chat.tools[0].description)).toBe(false)
  expect(_internal.hideDsh({ messages: [{ role: "user", content: "hi" }] })).toBe(false)
})

function serve() {
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: unz(init?.body) })
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  }
  return sent
}

const magpieWith = (v) => ({ option: (provider, key) => (key in (v[provider] ?? {}) ? v[provider][key] : key === _internal.HIDE_DSH) })

for (const [plugin, site, url] of [
  [WorkBuddyAuthPlugin, "workbuddy", "https://copilot.tencent.com/v2/chat/completions"],
  [WorkBuddyAIAuthPlugin, "workbuddy-ai", "https://www.workbuddy.ai/v2/chat/completions"],
]) {
  test(`${site}: declares the switch, on by default`, async () => {
    const h = await plugin({ client: {} })
    const o = h.auth.options.find((x) => x.key === _internal.HIDE_DSH)
    expect(o.default).toBe(true)
    expect(o.label.length).toBeLessThanOrEqual(60)
    expect(o.description.length).toBeLessThanOrEqual(300)
    for (const l of ["zh", "zh-TW", "ja", "de"]) {
      expect(o.labels[l]).toBeTruthy()
      expect(o.descriptions[l]).toBeTruthy()
    }
  })

  for (const [how, magpie] of [
    ["on by default in magpie", magpieWith({})],
    ["with no magpie (OpenCode)", undefined],
  ]) {
    test(`${site}: ${how}, dsh's name doesn't go`, async () => {
      const sent = serve()
      const h = await plugin({ client: {}, magpie })
      const opts = await h.auth.loader(async () => ({ type: "api", key: KEY }), {})
      await opts.fetch(url, { method: "POST", body: JSON.stringify(chatBody()) })
      const out = JSON.parse(sent.at(-1).body)
      const said = JSON.stringify({ messages: out.messages.filter((m) => m.role !== "tool"), tools: out.tools })
      expect(named(said)).toBe(false)
      expect(out.messages[0].content).toStartWith("You are an AI agent.")
      // a tool's result is what a file said, and goes as it came
      expect(out.messages.find((m) => m.role === "tool").content).toBe("README: DeepSeek Harness (DSH) is …")
      expect(said).toContain("~/.dsh/profiles")
      expect(said).toContain("DSH_HOME")
    })
  }

  test(`${site}: turned off, the prompt goes as dsh wrote it (FLAGGED's comma aside)`, async () => {
    const sent = serve()
    const h = await plugin({ client: {}, magpie: magpieWith({ [site]: { [_internal.HIDE_DSH]: false } }) })
    const opts = await h.auth.loader(async () => ({ type: "api", key: KEY }), {})
    await opts.fetch(url, { method: "POST", body: JSON.stringify(chatBody()) })
    const out = JSON.parse(sent.at(-1).body)
    expect(out.messages[0].content).toContain("You are an AI agent, powered by DeepSeek Harness.")
    expect(out.messages[0].content).toContain("extend DSH itself")
  })
}
