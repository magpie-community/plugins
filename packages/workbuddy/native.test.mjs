// WorkBuddy serves the Claude models on Anthropic's Messages API at
// <endpoint>/v1/messages, beside chat completions at <endpoint>/v2. On
// 2026-10-24, with a real account, /v3/config's cli agent models were each
// asked on /v1/messages: claude-opus-5.5, claude-sonnet-5.5, claude-opus-5
// and claude-opus-4.8-1m answered in Anthropic's stream; glm-5.3,
// deepseek-v4.1-flash, gpt-5.5 and kimi-k3-1 did not.
//
// The point of the route is effort: a chat carries reasoning_effort and
// WorkBuddy's chat endpoint answers at about the same length whatever it is
// (median output tokens over 4 runs: low 3884, max 5144, a nonsense value
// 5715), while Messages carries output_config.effort and max is honored
// there (median 30850 at max against 5748 at low, 4 runs each).
import { expect, test } from "bun:test"
import { WorkBuddyAuthPlugin, _internal } from "./index.mjs"

const { isMessages, nativeOf, SITES, modelOf, API_MESSAGES, API_CHAT } = _internal
const site = SITES.workbuddy

test("the Claude models are served on Messages, the rest on chat", () => {
  for (const m of ["claude-opus-5.5", "claude-sonnet-5.5", "claude-opus-5", "claude-opus-4.8-1m"])
    expect(nativeOf(site, m)).toBe(true)
  for (const m of ["glm-5.3", "glm-5.3-flash", "deepseek-v4.1-flash", "gpt-5.6-sol", "kimi-k3-1", "hy3", "minimax-m3"])
    expect(nativeOf(site, m)).toBe(false)
  // the international build serves them the same way
  expect(nativeOf(SITES["workbuddy-ai"], "claude-opus-5.5")).toBe(true)
  expect(nativeOf(SITES["workbuddy-ai"], "glm-5.3")).toBe(false)
})

test("a model's api is Messages for a Claude model, chat otherwise", () => {
  const claude = modelOf(site, { id: "workbuddy" }, { id: "claude-opus-5.5", name: "Claude-Opus-5.5", context: 1000000 })
  expect(claude.api.npm).toBe("@ai-sdk/anthropic")
  expect(claude.api.url).toBe("https://copilot.tencent.com/v1")

  const glm = modelOf(site, { id: "workbuddy" }, { id: "glm-5.3", name: "GLM-5.3", context: 1000000 })
  expect(glm.api.npm).toBe("@ai-sdk/openai-compatible")
  expect(glm.api.url).toBe("https://copilot.tencent.com/v2")
})

test("isMessages goes by the URL, and by the body when there is none", () => {
  expect(isMessages("https://copilot.tencent.com/v1/messages", "")).toBe(true)
  expect(isMessages("https://copilot.tencent.com/v2/chat/completions", "")).toBe(false)
  expect(isMessages(new URL("https://copilot.tencent.com/v1/messages?beta=true"), "")).toBe(true)

  // no URL: Anthropic's system blocks, or a tool with input_schema
  const sys = JSON.stringify({ system: [{ type: "text", text: "x" }], messages: [] })
  expect(isMessages("", sys)).toBe(true)
  const tools = JSON.stringify({ tools: [{ name: "Read", input_schema: { type: "object" } }], messages: [] })
  expect(isMessages("", tools)).toBe(true)
  const chat = JSON.stringify({ tools: [{ type: "function", function: { name: "Read", parameters: {} } }], messages: [] })
  expect(isMessages("", chat)).toBe(false)
  expect(isMessages("", "not json")).toBe(false)
})

test("a chat request still goes as it did", async () => {
  // the rewrite the chat endpoint needs is not applied to a Messages body
  const { withSystem } = _internal
  const chat = JSON.stringify({
    model: "glm-5.3", max_completion_tokens: 4096, stream: true,
    messages: [{ role: "user", content: "hi" }],
  })
  const out = JSON.parse(withSystem(chat))
  expect(out.max_tokens).toBe(4096)
  expect(out.max_completion_tokens).toBeUndefined()
  expect(out.messages[0].role).toBe("system")
})

test("a Claude model lists max though the config stops at xhigh", async () => {
  // WorkBuddy's /v3/config lists claude-opus-5.5 as low/medium/high/xhigh
  // (2026-10-24); the Messages endpoint takes max anyway
  const config = JSON.stringify({
    data: {
      agents: [{ name: "cli", models: ["claude-opus-5.5", "glm-5.3"] }],
      models: [
        { id: "claude-opus-5.5", name: "Claude-Opus-5.5", supportsReasoning: true, maxInputTokens: 1000000,
          reasoning: { supportedEfforts: ["low", "medium", "high", "xhigh"] } },
        { id: "glm-5.3", name: "GLM-5.3", supportsReasoning: true, maxInputTokens: 1000000,
          reasoning: { supportedEfforts: ["low", "high", "xhigh"] } },
      ],
    },
  })
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response(config)
  let out
  try {
    out = await _internal.liveModels(site, { access: "a", uid: "u" })
  } finally {
    globalThis.fetch = real
  }
  const by = Object.fromEntries(out.map((m) => [m.id, m.efforts]))
  expect(by["claude-opus-5.5"]).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
  // a model on chat keeps what the config says: its endpoint takes no max
  expect(by["glm-5.3"]).toEqual(["none", "low", "high", "xhigh"])
})

test("the plugin still loads and names both providers", async () => {
  const client = { app: { log: async () => {} }, auth: { set: async () => {} } }
  const hooks = await WorkBuddyAuthPlugin({ client, directory: "/tmp", worktree: "/tmp" })
  expect(hooks.auth.provider).toBe("workbuddy")
  const config = {}
  await hooks.config(config)
  // the site's own list has no Claude in it (those come from /v3/config once
  // signed in), so the config's are all chat; a Claude one is Messages
  expect(config.provider.workbuddy.models["glm-5.3"].api).toBeUndefined()
  expect(config.provider.workbuddy.npm).toBe("@ai-sdk/openai-compatible")
  const withClaude = _internal.configModels({ ...site, models: [["claude-opus-5.5", "Claude-Opus-5.5", 1000000, ["low", "max"]]] })
  expect(withClaude["claude-opus-5.5"].api.npm).toBe("@ai-sdk/anthropic")
  expect(withClaude["claude-opus-5.5"].api.url).toBe("https://copilot.tencent.com/v1")
})
