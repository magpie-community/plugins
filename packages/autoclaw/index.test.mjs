// The check-in mapping is magpie's contract (provider-plugins.md): every
// answer the upstream gives lands on one of its outcomes, and the plugin
// factory registers both providers with every hook check.mjs looks for.
import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AutoclawAuthPlugin, AutoclawCnAuthPlugin, _internal } from "./index.mjs"

const {
  checkinOutcome, signinConfig, bareToken, codeValue, tokenFields, refreshTokens, startLocalOAuth,
  autoclawRewriteBody, unflag, unflagged, explained, FLAGGED, OFFICIAL_SYSTEM_PROMPT, REFUSED_HINT,
} = _internal

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const jwt = (claims) => `${b64url({ alg: "none" })}.${b64url(claims)}.sig`

test("both providers register with models and every hook", async () => {
  for (const [Plugin, id, api] of [
    [AutoclawAuthPlugin, "autoclaw", "https://autoglm-api.autoglm.ai"],
    [AutoclawCnAuthPlugin, "autoclaw-cn", "https://autoglm-api.zhipuai.cn"],
  ]) {
    const hooks = await Plugin({ client: { auth: { set: async () => {} } } })
    expect(hooks.auth.provider).toBe(id)
    expect(hooks.auth.loader).toBeFunction()
    expect(hooks.auth.usage).toBeFunction()
    expect(hooks.auth.checkin).toBeFunction()
    expect(hooks.auth.methods[0].prompts.length).toBeGreaterThan(0)
    const cfg = {}
    await hooks.config(cfg)
    expect(cfg.provider[id].api).toBe(api)
    expect(Object.keys(cfg.provider[id].models).length).toBeGreaterThan(0)
  }
})

test("checkinOutcome maps every upstream answer onto the contract", () => {
  expect(checkinOutcome({ success: true, reward_points: 400, continuous_days: 7 })).toEqual({
    outcome: "claimed", credit: 400, streak: 7, message: "已签到 +400 · 连续 7 天",
  })
  expect(checkinOutcome({ already_completed: true, reward_points: 200 })).toEqual({
    outcome: "done", credit: 200,
  })
  expect(checkinOutcome(null)).toEqual({ outcome: "failed", message: "签到接口无响应" })
  expect(checkinOutcome({ success: false, message: "风控拦截" })).toEqual({
    outcome: "failed", message: "风控拦截",
  })
})

test("signinConfig: plugin options over the file, the file over the default", () => {
  const home = mkdtempSync(join(tmpdir(), "autoclaw-cfg-"))
  const prev = process.env.XDG_CONFIG_HOME
  try {
    process.env.XDG_CONFIG_HOME = home
    // no file, no options: auto-signing stays off, left to the native switch
    expect(signinConfig(undefined)).toEqual({ signin: true, signinOnUsage: false, signinHour: null })

    mkdirSync(join(home, "magpie"), { recursive: true })
    const file = join(home, "magpie", "autoclaw.json")
    writeFileSync(file, JSON.stringify({ signin: false, signinHour: 8 }))
    expect(signinConfig(undefined)).toEqual({ signin: false, signinOnUsage: false, signinHour: 8 })
    expect(signinConfig({ signin: true, signinOnUsage: true })).toEqual({
      signin: true, signinOnUsage: true, signinHour: 8,
    })
    // a broken file reads as no file
    writeFileSync(file, "{ not json")
    expect(signinConfig(undefined)).toEqual({ signin: true, signinOnUsage: false, signinHour: null })
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})

test("the JWT's exp is the token's truth, with the 10-minute skew", () => {
  const access = jwt({ exp: 2_000_000_000 })
  expect(bareToken(`Bearer ${access}`)).toBe(access)
  expect(tokenFields({ access_token: `Bearer ${access}`, refresh_token: "Bearer r1" })).toEqual({
    access, refresh: "r1", expires: 2_000_000_000_000 - 10 * 60 * 1000,
  })
  expect(codeValue("123456")).toBe(123456)
  expect(codeValue("12a45")).toBe("12a45")
})

// The request path, against a fake upstream: which headers the chat request
// carries, how a wrong host's 401 rotates to the other one, and when the host
// is told the sign-in is dead.
test("loader().fetch signs with X-Authorization and rotates hosts on 401", async () => {
  const realFetch = globalThis.fetch
  const calls = []
  let mode = "ok" // ok | first-401 | all-401
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) })
    if (mode === "first-401") { mode = "ok"; return new Response("{}", { status: 401 }) }
    if (mode === "all-401") return new Response("{}", { status: 401 })
    return new Response("ok")
  }
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } })
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "Bearer a1" }))

    // The chat path goes to the upstream, signed by X-Authorization, not Authorization
    await loader.fetch("x", { headers: { Authorization: "Bearer old" } })
    expect(calls.at(-1).url).toBe("https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw/v1/chat/completions")
    expect(calls.at(-1).headers.get("X-Authorization")).toBe("Bearer a1")
    expect(calls.at(-1).headers.get("Authorization")).toBe(null)

    // A 401 from the home host retries the other one, which answers
    mode = "first-401"
    calls.length = 0
    expect((await loader.fetch("x")).status).toBe(200)
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["autoglm-api.autoglm.ai", "autoglm-api.zhipuai.cn"])

    // Both hosts refusing the token answers 401 with the sign-in marker
    mode = "all-401"
    const refused = await loader.fetch("x")
    expect(refused.status).toBe(401)
    expect(refused.headers.get("X-Magpie-Sign-In")).toBe("expired")
  } finally {
    globalThis.fetch = realFetch
  }
})

// AutoClaw's 2.1.0 chat gateway answers 406 with an empty body to a chat that
// hasn't the official prefix first or that carries max_tokens.
// autoclawRewriteBody puts a chat in that shape, once, whatever it is handed.
test("autoclawRewriteBody prefixes the system prompt and drops max_tokens", () => {
  const chat = (messages, rest = {}) => JSON.stringify({ model: "zai_glm-5.3-flash", messages, ...rest })

  // the caller's own system message keeps its words, behind the prefix
  const one = autoclawRewriteBody(chat([{ role: "system", content: "Be terse." }, { role: "user", content: "hi" }], { max_tokens: 32000 }))
  expect(one.messages[0].content).toBe(`${OFFICIAL_SYSTEM_PROMPT}\n\nBe terse.`)
  expect(one.max_tokens).toBeUndefined()
  expect(one.messages.length).toBe(2)

  // …and the prefix goes on once, however often the rewrite runs
  expect(autoclawRewriteBody(JSON.stringify(one)).messages[0].content).toBe(one.messages[0].content)

  // a chat that opens without a system message gets the smallest one
  expect(autoclawRewriteBody(chat([{ role: "user", content: "hi" }])).messages).toEqual([
    { role: "system", content: OFFICIAL_SYSTEM_PROMPT },
    { role: "user", content: "hi" },
  ])

  // the newer spelling goes with max_tokens
  expect(autoclawRewriteBody(chat([{ role: "user", content: "hi" }], { max_completion_tokens: 10 })).max_completion_tokens).toBeUndefined()

  // anything that isn't a JSON chat is left for the caller to pass through
  expect(autoclawRewriteBody("not json")).toBe(null)
  expect(autoclawRewriteBody(JSON.stringify({ model: "zai_auto" }))).toBe(null)
})

// FLAGGED is the words AutoClaw refuses a chat for: it reads the system
// prompt only, minds no case, and matches the shortest run of them ("You are
// Claude Code" and "Codex CLI" are two separate ones). Each pair was sent to
// the live gateway: the left side is a 406, the right side answers.
test("every flagged line's replacement is one the gateway still takes", () => {
  expect(FLAGGED.length).toBeGreaterThan(0)
  for (const [re, to] of FLAGGED) {
    expect(to).not.toMatch(new RegExp(re.source, "i"))
    expect(unflagged(to)).toBe(to)
  }
  expect(unflagged("You are Claude Code, Anthropic's official CLI for Claude.")).not.toMatch(/You are Claude Code/)
  expect(unflagged("Codex CLI is an open source project.")).not.toMatch(/Codex CLI/)
})

// ZCode (#245) and pi (#236) answered 406 on the CN managed gateway. The
// fixtures are each reporter's identity line, byte for byte. #245's probes
// found the gateway matching "You are ZCode" in any case, anywhere in the
// text; pi's line wasn't probed, so its rewrite breaks "inside pi, a coding
// agent harness" as a whole while keeping pi's name for the model.
test("ZCode's and pi's identity lines are rewritten", () => {
  const zcode = "You are ZCode, an interactive coding agent"
  expect(unflagged(zcode)).toBe("You are the ZCode agent, an interactive coding agent")
  expect(unflagged("Note: you are zcode here.")).toBe("Note: You are the ZCode agent here.")
  for (const t of ["You are ZCode.", "you are zcode", `Intro.\n${zcode}.`]) {
    expect(unflagged(t)).not.toMatch(/You are ZCode/i)
  }

  const pi = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files."
  expect(unflagged(pi)).toBe("You are an expert coding assistant operating inside the pi coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.")
  expect(unflagged(pi)).not.toMatch(/inside pi|pi, a coding agent harness/i)

  // the same text in, the same text out: a cached prompt prefix stays put
  expect(unflagged(unflagged(pi))).toBe(unflagged(pi))
  expect(unflagged(unflagged(zcode))).toBe(unflagged(zcode))

  // Claude Code's line is left to its own entry, exactly as before
  expect(unflagged("You are Claude Code, Anthropic's official CLI for Claude.")).toBe("You are the Claude Code CLI, Anthropic's official CLI for Claude.")
})

// #466 (larrylinli): WorkBuddy renders a custom GLM model into ZCode's
// opening line, and the CN gateway answers 406 for "This conversation is
// powered by GLM-<version>" in any case. The fixture is the reporter's line
// byte for byte; each rewritten form was a 200 in the reporter's probes.
test("WorkBuddy's GLM opening line and CodeBuddy Code's identity line are rewritten", () => {
  const opening = "This conversation is powered by GLM-5.3 · AutoClaw 国内 (Zhipu)"
  expect(unflagged(opening)).toBe("This conversation is powered by the GLM-5.3 model · AutoClaw 国内 (Zhipu)")
  expect(unflagged("This conversation is powered by GLM-4")).toBe("This conversation is powered by the GLM-4 model")
  expect(unflagged("Intro.\nthis conversation is powered by glm-5.3.")).toBe("Intro.\nThis conversation is powered by the GLM-5.3 model.")
  expect(unflagged("This conversation is powered by GLM-4.5-Air.")).toBe("This conversation is powered by the GLM-4.5-Air model.")
  // what the gateway takes stays as written
  for (const t of [
    "This conversation is powered by GLM",
    "This conversation is powered by ChatGLM-5.3",
    "The conversation is powered by GLM-5.3",
    "You are powered by GLM-5.3",
  ]) expect(unflagged(t)).toBe(t)

  expect(unflagged("You are CodeBuddy Code.")).toBe("You are the CodeBuddy Code CLI.")
  expect(unflagged("you are codebuddy code, a CLI")).toBe("You are the CodeBuddy Code CLI, a CLI")
  expect(unflagged("You are CodeBuddy, an assistant")).toBe("You are CodeBuddy, an assistant")

  // the same text in, the same text out: a cached prompt prefix stays put
  expect(unflagged(unflagged(opening))).toBe(unflagged(opening))

  // unflag reaches the opening line in a WorkBuddy system message
  const messages = [
    { role: "system", content: `${opening}\n\nYou help the user.` },
    { role: "user", content: "This conversation is powered by GLM-5.3" },
  ]
  expect(unflag(messages)).toBe(true)
  expect(messages[0].content).toBe("This conversation is powered by the GLM-5.3 model · AutoClaw 国内 (Zhipu)\n\nYou help the user.")
  expect(messages[1].content).toBe("This conversation is powered by GLM-5.3")
})

// Hermes Agent 0.22.1 (Discord, 01huadalang, 10-30): every chat through
// AutoClaw 国内 was a 406. The fixtures are Hermes' own strings byte for
// byte: DEFAULT_SOUL_MD (hermes_cli/default_soul.py, the SOUL.md every
// install is seeded with, the same as DEFAULT_AGENT_IDENTITY) and
// HERMES_AGENT_HELP_GUIDANCE (agent/prompt_builder.py), unchanged to v0.22.5.
test("Hermes Agent's identity lines are rewritten", () => {
  const soul = "You are Hermes Agent, built by Nous Research. Be direct: match the length of your reply to the weight of the ask — a one-line question gets a one-line answer, and finished work gets a short report of what changed, what's verified, and what's left, never a replay of the process. No filler (\"Great question,\" \"I'd be happy to\"), no restating the request back, no re-summarizing what you already said, no narrating tool calls the user can see. Plain claims over adjectives; when unsure, say so plainly. Agree because it's right, not because the user said it. Depth is earned — give it when the user asks for detail, teaches, or the stakes demand it, not by default."
  const help = "You run on Hermes Agent (by Nous Research). When the user needs help with Hermes itself — configuring, setting up, using, extending, or troubleshooting it — or when you need to understand your own features, tools, or capabilities, the documentation at https://hermes-agent.nousresearch.com/docs is your authoritative reference and always holds the latest, most up-to-date information. The `hermes-agent` skill has the actual commands and proven workflows — load it with skill_view(name='hermes-agent') before configuring, modifying, or troubleshooting Hermes so you don't guess or invent workarounds."
  const opening = "You are the agent Hermes, built by Nous Research. Be direct:"
  expect(unflagged(soul).startsWith(opening)).toBe(true)
  expect(unflagged(soul)).toBe(opening + soul.slice("You are Hermes Agent, built by Nous Research. Be direct:".length))
  expect(unflagged(help).startsWith("You run on Hermes-Agent (by Nous Research). When the user needs help with Hermes itself")).toBe(true)
  // the older seeded SOUL.md and the bare name Hermes' own voice prompt uses
  expect(unflagged("You are Hermes Agent, an intelligent AI assistant created by Nous Research.")).toBe("You are the agent Hermes, an intelligent AI assistant created by Nous Research.")
  expect(unflagged("You are Hermes, a helpful AI assistant.")).toBe("You are the agent Hermes, a helpful AI assistant.")
  for (const t of [soul, help, "you are hermes agent", "Intro.\nYOU ARE HERMES."]) {
    expect(unflagged(t)).not.toMatch(/You are Hermes|Hermes Agent/i)
  }
  // a word that only starts with Hermes is someone else's
  expect(unflagged("You are Hermesian")).toBe("You are Hermesian")
  // the same text in, the same text out: a cached prompt prefix stays put
  expect(unflagged(unflagged(soul))).toBe(unflagged(soul))
  expect(unflagged(unflagged(help))).toBe(unflagged(help))

  // other agents magpie connects, from each one's own source
  expect(unflagged("You are Gemini CLI, an interactive CLI agent specializing in software engineering tasks.")).toBe("You are the Gemini CLI agent, an interactive CLI agent specializing in software engineering tasks.")
  expect(unflagged("You are Kimi Code CLI, an interactive general AI agent running on a user's computer.")).toBe("You are the Kimi Code CLI agent, an interactive general AI agent running on a user's computer.")
  expect(unflagged("You are goose, an autonomous AI agent created by AAIF (Agentic AI Foundation).")).toBe("You are the goose agent, an autonomous AI agent created by AAIF (Agentic AI Foundation).")
  expect(unflagged("You are a general-purpose AI agent called goose")).toBe("You are a general-purpose AI agent called goose")
})

test("CN loader sends Hermes' system prompt without its identity line", async () => {
  const soul = "You are Hermes Agent, built by Nous Research. Be direct: match the length of your reply to the weight of the ask — a one-line question gets a one-line answer, and finished work gets a short report of what changed, what's verified, and what's left, never a replay of the process. No filler (\"Great question,\" \"I'd be happy to\"), no restating the request back, no re-summarizing what you already said, no narrating tool calls the user can see. Plain claims over adjectives; when unsure, say so plainly. Agree because it's right, not because the user said it. Depth is earned — give it when the user asks for detail, teaches, or the stakes demand it, not by default."
  const help = "You run on Hermes Agent (by Nous Research). When the user needs help with Hermes itself — configuring, setting up, using, extending, or troubleshooting it — or when you need to understand your own features, tools, or capabilities, the documentation at https://hermes-agent.nousresearch.com/docs is your authoritative reference and always holds the latest, most up-to-date information. The `hermes-agent` skill has the actual commands and proven workflows — load it with skill_view(name='hermes-agent') before configuring, modifying, or troubleshooting Hermes so you don't guess or invent workarounds."
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) })
    return new Response("{}")
  }
  try {
    const hooks = await AutoclawCnAuthPlugin({ client: { auth: { set: async () => {} } } })
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "a1" }))
    const body = JSON.stringify({
      model: "zaicoding_glm-5.3",
      messages: [
        { role: "system", content: `${soul}\n\n${help}` },
        { role: "user", content: "You are Hermes Agent, right?" },
      ],
    })
    expect((await loader.fetch("x", { method: "POST", body })).status).toBe(200)
    const sent = calls.at(-1)
    expect(sent.url).toBe("https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions")
    expect(sent.body.messages[0].content.startsWith(`${OFFICIAL_SYSTEM_PROMPT}\n\nYou are the agent Hermes, built by Nous Research.`)).toBe(true)
    expect(sent.body.messages[0].content).not.toMatch(/You are Hermes|Hermes Agent/i)
    // the user's own words go as written
    expect(sent.body.messages[1].content).toBe("You are Hermes Agent, right?")
  } finally {
    globalThis.fetch = realFetch
  }
})

// Claude Code 2.1.30x opens its system prompt with the SDK identity line,
// not the CLI one. The CN gateway refuses "Claude Agent SDK" in any case,
// wherever it sits; the bare phrase is matched so "running on" variants and
// later mentions are covered too.
test("Claude Agent SDK's identity line is rewritten", () => {
  const sdk = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
  expect(unflagged(sdk)).toBe("You are a coding assistant.")
  expect(unflagged("You are a Claude agent, running on Anthropic's Claude Agent SDK.")).toBe("You are a Claude agent, running on the agent framework.")
  expect(unflagged("We build on the Claude Agent SDK; see docs.")).toBe("We build on the agent framework; see docs.")
  // the same text in, the same text out: a cached prompt prefix stays put
  expect(unflagged(unflagged(sdk))).toBe(unflagged(sdk))
})

// The gateway reads the system prompt, not the chat: the caller's own words
// in a user or assistant message stay as they are.
test("unflag rewrites system and developer messages only", () => {
  const messages = [
    { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude." },
    { role: "developer", content: [{ type: "text", text: "You are Cursor" }] },
    { role: "user", content: "You are Codex" },
    { role: "assistant", content: [{ type: "text", text: "Codex CLI is what I use" }] },
    { role: "system", content: [{ type: "text", text: "You are ZCode, an interactive coding agent" }] },
    { role: "user", content: "You are ZCode, an interactive coding agent" },
    { role: "tool", content: "operating inside pi, a coding agent harness" },
  ]
  expect(unflag(messages)).toBe(true)
  expect(messages[0].content).toBe("You are the Claude Code CLI, Anthropic's official CLI for Claude.")
  expect(messages[1].content[0].text).toBe("You are the Cursor agent")
  expect(messages[2].content).toBe("You are Codex")
  expect(messages[3].content[0].text).toBe("Codex CLI is what I use")
  expect(messages[4].content[0].text).toBe("You are the ZCode agent, an interactive coding agent")
  expect(messages[5].content).toBe("You are ZCode, an interactive coding agent")
  expect(messages[6].content).toBe("operating inside pi, a coding agent harness")
  // nothing left to change the second time
  expect(unflag(messages)).toBe(false)
})

// explained is res with REFUSED_HINT on a 406 — the one refusal the gateway
// gives no words for — and the sign-in marked kept, so magpie doesn't read a
// refusal as a lapsed account.
test("explained adds the way out to a 406 and keeps the sign-in", async () => {
  const refused = await explained(new Response(JSON.stringify({ error: { code: null, message: "406 Not Acceptable", type: "api_error" } }), { status: 406, headers: { "content-type": "application/json" } }))
  expect(refused.status).toBe(406)
  expect(refused.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await refused.json()).error.message).toBe(`406 Not Acceptable — ${REFUSED_HINT}`)

  // an answer that isn't a refusal is passed through, and its body with it
  const ok = await explained(new Response('{"choices":[]}', { status: 200 }))
  expect(ok.status).toBe(200)
  expect(await ok.text()).toBe('{"choices":[]}')
})

test("overseas loader().fetch drops X-Harness-Type and explains 406", async () => {
  const realFetch = globalThis.fetch
  const calls = []
  let status = 200
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) })
    if (status === 406) return new Response(JSON.stringify({ error: { code: null, message: "406 Not Acceptable", type: "api_error" } }), { status: 406 })
    return new Response("ok")
  }
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } })
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "a1" }))
    const body = JSON.stringify({
      model: "zai_glm-5.3-flash",
      max_tokens: 32000,
      messages: [
        { role: "system", content: "You are an AI agent powered by DeepSeek Harness." },
        { role: "user", content: "hi" },
      ],
    })

    expect((await loader.fetch("x", { method: "POST", body })).status).toBe(200)
    const sent = calls.at(-1)
    expect(sent.body.max_tokens).toBeUndefined()
    expect(sent.body.messages[0].content.startsWith(OFFICIAL_SYSTEM_PROMPT)).toBe(true)
    expect(sent.body.messages[0].content).not.toMatch(/DeepSeek Harness/)
    expect(sent.headers.get("X-Harness-Type")).toBe(null)
    expect(sent.headers.get("User-Agent")).toBe("OpenAI/JS 6.26.0")

    status = 406
    const refused = await loader.fetch("x", { method: "POST", body })
    expect(refused.status).toBe(406)
    expect(refused.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect((await refused.json()).error.message).toContain(REFUSED_HINT)
  } finally {
    globalThis.fetch = realFetch
  }
})


test("CN loader rewrites the Claude Agent SDK identity and explains its 406", async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) })
    return new Response(JSON.stringify({ error: { code: null, message: "406 Not Acceptable", type: "api_error" } }), { status: 406 })
  }
  try {
    const hooks = await AutoclawCnAuthPlugin({ client: { auth: { set: async () => {} } } })
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "a1" }))
    const body = JSON.stringify({
      model: "zaicoding_glm-5.3",
      messages: [
        { role: "system", content: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
        { role: "user", content: "hi" },
      ],
    })

    const refused = await loader.fetch("x", { method: "POST", body })
    expect(refused.status).toBe(406)
    expect(refused.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect((await refused.json()).error.message).toContain(REFUSED_HINT)

    const sent = calls.at(-1)
    expect(sent.url).toBe("https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions")
    expect(sent.body.messages[0].content.startsWith(OFFICIAL_SYSTEM_PROMPT)).toBe(true)
    expect(sent.body.messages[0].content).not.toMatch(/Claude Agent SDK/i)
    expect(sent.headers.get("X-Authorization")).toBe("Bearer a1")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("refreshTokens orders hosts by the token's source_id and falls back on 400002", async () => {
  const realFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) })
    const { pathname } = url
    if (pathname === "/userapi/v1/refresh") return Response.json({ code: 400002, msg: "need agent refresh" })
    if (pathname === "/userapi/v1/agent-refresh") {
      return Response.json({ code: 0, msg: "ok", data: { access_token: "a2", refresh_token: "r2", expires_in: 3600 } })
    }
    throw new Error(`unexpected request ${pathname}`)
  }
  try {
    // An agent (SMS) token tries the CN host first, and its /refresh answers 400002
    // the expiry is read off the clock while refreshTokens runs: it is
    // between the clock before and after, not the clock read again later
    const before = Date.now()
    const out = await refreshTokens(jwt({ source_id: "agent", device_id: "dev-1" }), [])
    const after = Date.now()
    expect(requests.map((r) => `${new URL(r.url).origin}${r.url.pathname}`)).toEqual([
      "https://autoglm-api.zhipuai.cn/userapi/v1/refresh",
      "https://autoglm-api.zhipuai.cn/userapi/v1/agent-refresh",
    ])
    expect(requests[0].body.device_id).toBe("dev-1")
    const { expires, ...tokens } = out
    expect(tokens).toEqual({ access: "a2", refresh: "r2" })
    expect(expires).toBeGreaterThanOrEqual(before + 3600_000 - 600_000)
    expect(expires).toBeLessThanOrEqual(after + 3600_000 - 600_000)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("refreshTokens tries the oversea host first and marks a dead token expired", async () => {
  const realFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    requests.push(url)
    return new Response(JSON.stringify({ code: 401001, msg: "invalid_grant" }), { status: 401 })
  }
  try {
    let threw
    try { await refreshTokens(jwt({ source_id: "google" }), []) } catch (e) { threw = e }
    expect(threw).toBeInstanceOf(Error)
    expect(threw.signIn).toBe("expired")
    // A web token belongs to the oversea host; its 401 stops the rotation there
    expect(requests.map((u) => u.origin)).toEqual(["https://autoglm-api.autoglm.ai"])
  } finally {
    globalThis.fetch = realFetch
  }
})

// A 401 whose body isn't an envelope (a gateway's plain text) must still tell
// the host the sign-in is dead, or the user isn't offered to sign in again.
test("refreshTokens marks a non-envelope 401 as expired too", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("Unauthorized", { status: 401 })
  try {
    let threw
    try { await refreshTokens(jwt({ source_id: "google" }), []) } catch (e) { threw = e }
    expect(threw).toBeInstanceOf(Error)
    expect(threw.message).toContain("non-envelope response (HTTP 401)")
    expect(threw.signIn).toBe("expired")
  } finally {
    globalThis.fetch = realFetch
  }
})

// The local OAuth server against a fake upstream and a real listener: the
// callback only accepts the state the authorize page handed out, and the
// legacy /callback catch-all is gone.
test("the OAuth callback takes only the state the authorize page handed out", async () => {
  const realFetch = globalThis.fetch
  const upstream = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    // The plugin's own local server stays real; only the upstream is faked
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init)
    upstream.push({ url, body: JSON.parse(String(init?.body ?? "{}")) })
    if (url.pathname === "/userapi/overseasv1/google-oauth-url") {
      return Response.json({ code: 0, msg: "ok", data: { oauth_url: "https://accounts.google.test/o/auth2/auth?state=st-123&client_id=c" } })
    }
    if (url.pathname === "/userapi/overseasv1/google-oauth-login") {
      return Response.json({ code: 0, msg: "ok", data: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "r1", user_id: "u1" } })
    }
    if (url.pathname === "/userapi/v1/user-profile") {
      return Response.json({ code: 0, msg: "ok", data: { user_name: "Tester" } })
    }
    throw new Error(`unexpected request ${url.pathname}`)
  }
  try {
    const session = await startLocalOAuth("google", () => {})
    const port = Number(/127\.0\.0\.1:(\d+)\//.exec(session.instructions)[1])
    expect(session.url).toBe(`http://127.0.0.1:${port}/`)
    expect((await realFetch(session.url)).status).toBe(200)
    const local = (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init)

    // The guide page's Continue hands out the authorize URL, and the state in it
    const openAuth = await (await local("/open-auth", { method: "POST" })).json()
    expect(openAuth.url).toContain("state=st-123")

    // A forged state is turned away without ending the session…
    const evil = await local("/auth/callback-google?code=evil&state=attacker")
    expect(evil.status).toBe(200)
    expect(await evil.text()).toContain("state 不匹配")

    // …and the old /callback catch-all no longer answers
    expect((await local("/callback?code=evil&state=st-123")).status).toBe(404)

    // …while the real one still signs in with exactly the code it was given
    const good = await local("/auth/callback-google?code=good-code&state=st-123")
    expect(await good.text()).toContain("授权成功")
    const result = await session.callback()
    expect(result.type).toBe("success")
    expect(result.accountId).toBe("Tester")
    const login = upstream.find((u) => u.url.pathname === "/userapi/overseasv1/google-oauth-login")
    expect(login.body.code).toBe("good-code")
    expect(login.body.state).toBe("st-123")

    // The session's port is released once the callback returns
    let refused = false
    try { await local("/") } catch { refused = true }
    expect(refused).toBe(true)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("CN's managed gateway gets AutoClaw's official body and headers", async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init, headers: new Headers(init?.headers) })
    return Response.json({ id: "x", object: "chat.completion", created: 1, model: "zai_auto-fast", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] })
  }
  try {
    const factory = await makePlugin("autoclaw-cn")
    const hooks = await factory({ client: { auth: { set: async () => {} } } }, {})
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "a1" }))
    const res = await loader.fetch("x", { body: JSON.stringify({ model: "zai_auto-fast", stream: false, max_tokens: 12, stream_options: { include_usage: true }, messages: [{ role: "system", content: "mine" }, { role: "user", content: "hi" }] }) })
    const sent = JSON.parse(calls[0].init.body)
    expect(calls[0].url).toBe("https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions")
    expect(sent.model).toBe("zai_auto-fast")
    expect(sent.stream).toBe(false)
    expect(sent.max_tokens).toBeUndefined()
    expect(sent.messages).toHaveLength(2)
    expect(sent.messages[0].content).toBe("You are AutoClaw. Answer the user directly and concisely.\n\nmine")
    expect(sent.messages[0].role).toBe("system")
    expect(sent.messages[1]).toMatchObject({ role: "user", content: "hi" })
    expect(calls[0].headers.get("x-request-model")).toBe("zai_auto-fast")
    expect(calls[0].headers.get("x-client-type")).toBe("pc")
    expect(calls[0].headers.get("x-agent-id")).toBe("main")
    expect(calls[0].headers.get("x-authorization")).toBe("Bearer a1")
    expect(res.headers.get("content-type")).toContain("application/json")
    const reply = await res.json()
    expect(reply.model).toBe("zai_auto-fast")
  } finally { globalThis.fetch = realFetch }
})

// #245's surface: ZCode through autoclaw-cn's managed gateway. The system
// text that leaves carries no "You are ZCode"; the user's own words do.
test("CN's managed gateway gets ZCode's and pi's lines rewritten", async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) })
    return Response.json({ id: "x", object: "chat.completion", created: 1, model: "zaicoding_glm-5.3", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] })
  }
  try {
    const factory = await makePlugin("autoclaw-cn")
    const hooks = await factory({ client: { auth: { set: async () => {} } } }, {})
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "a1" }))
    const zcode = "You are ZCode, an interactive coding agent"
    const pi = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files."
    for (const system of [zcode, pi]) {
      await loader.fetch("x", { body: JSON.stringify({ model: "zaicoding_glm-5.3", stream: false, messages: [{ role: "system", content: system }, { role: "user", content: system }] }) })
      const sent = calls.at(-1).body
      expect(calls.at(-1).url).toBe("https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions")
      expect(sent.messages[0].content).toBe(`${OFFICIAL_SYSTEM_PROMPT}\n\n${unflagged(system)}`)
      expect(sent.messages[0].content).not.toMatch(/You are ZCode|inside pi, a coding agent harness/i)
      expect(sent.messages[1].content).toBe(system)
    }
  } finally { globalThis.fetch = realFetch }
})

function makePlugin(id) {
  return _internal.makePluginForTest({
    providerId: id,
    providerName: id,
    homeHost: id === "autoclaw-cn" ? "https://autoglm-api.zhipuai.cn" : "https://autoglm-api.autoglm.ai",
    loginMethod: { type: "oauth", label: "test", authorize: async () => ({}) },
  })
}

test("CN preserves string and array system content", async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push(JSON.parse(String(init?.body)))
    return Response.json({ ok: true })
  }
  try {
    const factory = makePlugin("autoclaw-cn")
    const hooks = await factory({ client: { auth: { set: async () => {} } } }, {})
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "a1" }))
    await loader.fetch("x", { body: JSON.stringify({ model: "zai_auto", messages: [{ role: "system", content: [{ type: "text", text: "PARTSYS" }] }, { role: "user", content: "hi" }] }) })
    expect(calls[0].messages[0].content).toEqual([
      { type: "text", text: "You are AutoClaw. Answer the user directly and concisely." },
      { type: "text", text: "PARTSYS" },
    ])
    await loader.fetch("x", { body: JSON.stringify({ model: "zai_auto", messages: [{ role: "system", content: "mine" }, { role: "user", content: "hi" }] }) })
    expect(calls[1].messages[0].content).toBe("You are AutoClaw. Answer the user directly and concisely.\n\nmine")
    await loader.fetch("x", { body: JSON.stringify({ model: "zai_auto", messages: [{ role: "system", content: "You are Claude Code" }] }) })
    expect(calls[2].messages[0].content).toBe("You are AutoClaw. Answer the user directly and concisely.\n\nYou are the Claude Code CLI")
  } finally { globalThis.fetch = realFetch }
})

test("CN managed catalog uses variant objects and overseas keeps its limits", async () => {
  const factory = makePlugin("autoclaw-cn")
  const cn = await factory({ client: { auth: { set: async () => {} } } }, {})
  const cfg = { provider: {} }
  await cn.config(cfg)
  expect(Object.keys(cfg.provider["autoclaw-cn"].models.zai_auto.variants)).toEqual(["low", "high", "max"])
  expect(cfg.provider["autoclaw-cn"].models.zai_auto.variants.max).toEqual({ reasoningEffort: "max" })
  expect(Object.keys(cfg.provider["autoclaw-cn"].models)).toEqual(["zai_auto", "zai_auto-fast", "zaicoding_glm-5.3", "zai_glm-5.3-flash"])

  const overseas = await makePlugin("autoclaw")({ client: { auth: { set: async () => {} } } }, {})
  const oc = { provider: {} }
  await overseas.config(oc)
  expect(Object.keys(oc.provider.autoclaw.models)).toEqual(["zai_auto", "zai_auto-fast", "zaicoding_glm-5.3", "zai_glm-5.3-flash"])
  expect(oc.provider.autoclaw.models.zai_auto.limit).toEqual({ context: 200000, output: 32000 })
  expect(oc.provider.autoclaw.models["zaicoding_glm-5.3"].limit).toEqual({ context: 1000000, output: 131072 })
})

test("CN passes SSE through and marks 401 expired", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/chat/completions")) {
      if (String(init?.body).includes("STREAM")) return new Response("data: {\"ok\":true}\n\n", { headers: { "content-type": "text/event-stream" } })
      return new Response("{}", { status: 401 })
    }
    return Response.json({ ok: true })
  }
  try {
    const factory = makePlugin("autoclaw-cn")
    const hooks = await factory({ client: { auth: { set: async () => {} } } }, {})
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "a1" }))
    const stream = await loader.fetch("x", { body: JSON.stringify({ model: "zai_auto", stream: true, messages: [{ role: "user", content: "STREAM" }] }) })
    expect(await stream.text()).toBe("data: {\"ok\":true}\n\n")
    const expired = await loader.fetch("x", { body: JSON.stringify({ model: "zai_auto", messages: [{ role: "user", content: "x" }] }) })
    expect(expired.status).toBe(401)
    expect(expired.headers.get("X-Magpie-Sign-In")).toBe("expired")
  } finally { globalThis.fetch = realFetch }
})

// #254: two sign-ins can share AutoClaw's default display name. The
// usage-path signing (signinOnUsage) is remembered per sign-in, by uid or
// by the refresh token when an old account has none, never per provider,
// so the second account of a provider is still signed in that day.
test("signinOnUsage signs every account, also two with the same name", async () => {
  const realFetch = globalThis.fetch
  const signed = []
  const done = new Set()
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const who = new Headers(init?.headers).get("Authorization")
    if (url.includes("autoclaw-task-complete")) {
      signed.push(who)
      done.add(who)
      return Response.json({ code: 0, data: { success: true, reward_points: 400 } })
    }
    if (url.includes("autoclaw-task-list")) {
      return Response.json({ code: 0, data: [{ task_id: "daily_signin", status: done.has(who) ? "completed" : "pending", reward_points: 400 }] })
    }
    return Response.json({ code: 0, data: { total_balance: 1000, wallets: [] } })
  }
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-usage-"))
  _internal.setUsageStatePath(join(dir, ".usage-state.json"))
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } }, { signin: true, signinOnUsage: true })
    const accounts = [
      { type: "oauth", access: "a1", refresh: "r1", accountId: "AutoClaw用户", uid: "u1" },
      { type: "oauth", access: "a2", refresh: "r2", accountId: "AutoClaw用户", uid: "u2" },
      { type: "oauth", access: "a3", refresh: "r3", accountId: "AutoClaw用户" },
      { type: "oauth", access: "a4", refresh: "r4", accountId: "AutoClaw用户" },
    ]
    for (const a of accounts) {
      const u = await hooks.auth.usage(async () => a)
      expect(u.windows.find((w) => w.name === "每日签到").display).toBe("今日已签 ✓ +400")
    }
    expect(signed).toEqual(["Bearer a1", "Bearer a2", "Bearer a3", "Bearer a4"])
    expect(_internal.signinAccountKey("autoclaw", accounts[0])).toBe("autoclaw|uid:u1")
    expect(_internal.signinAccountKey("autoclaw", accounts[2])).not.toBe(_internal.signinAccountKey("autoclaw", accounts[3]))
  } finally {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

// #376 (moxuanchen): the credits are a bare balance, with no limit and no
// amount used; as a used: 0 window the card read "500 积分 · 剩余 100%"
test("usage: the credit balance and its wallets are the balance, never a window with a share", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const u = String(input)
    if (u.includes("wallets")) return Response.json({ code: 0, data: { total_balance: 1234.4, wallets: [
      { display_name: "赠送积分", balance: 500 }, { display_name: "会员积分", balance: 734.4 }, { display_name: "空", balance: 0 },
    ] } })
    return Response.json({ code: 0, data: null })
  }
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-usage-"))
  _internal.setUsageStatePath(join(dir, ".usage-state.json"))
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } })
    const u = await hooks.auth.usage(async () => ({ type: "oauth", access: "a1" }))
    expect(u.balance).toBe("1234 积分（赠送积分 500 · 会员积分 734）")
    // the prepaid wallet reading (magpie #3950): the balance as told, in its
    // unit, and no share invented - a first read has no spend window yet
    expect(u.windows.filter((w) => w.name !== "每日签到")).toEqual([
      { name: "积分余额", balance: 1234.4, unit: "积分" },
    ])
  } finally {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

// #367 (menhouran): the overseas gateway refuses X-Tm "linux" only beside a
// non-official fingerprint. The official AutoClaw 2.0.3 client sends "linux"
// (managedPlatform() in its main.cjs: darwin mac, win32 win, else
// process.platform) with channel "official", version 2.0.3 and a signed
// X-Auth-*; 0.2.7's "linux-x64" was a bypass, not what it sends.
test("X-Tm is the official client's platform id: mac, win, and linux as is", () => {
  const { platformTm, bizHeaders } = _internal
  expect(platformTm("darwin")).toBe("mac")
  expect(platformTm("win32")).toBe("win")
  expect(platformTm("linux")).toBe("linux")
  expect(bizHeaders("t")["X-Tm"]).toBe(platformTm(process.platform))
})

test("the overseas chat carries the official AutoClaw 2.0.3 fingerprint", async () => {
  const { platformTm, md5Hex, stainlessOs, stainlessArch } = _internal
  const realFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (input, init) => { sent.push({ url: String(input), headers: new Headers(init?.headers) }); return new Response("{}") }
  const body = (text) => JSON.stringify({ model: "zai_glm-5.3-flash", messages: [{ role: "system", content: "sys" }, { role: "user", content: text }] })
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } })
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "a1" }))
    const before = Math.floor(Date.now() / 1000)
    await loader.fetch("x", {
      method: "POST",
      headers: { "Authorization": "Bearer caller", "User-Agent": "ai-sdk/openai-compatible", "X-Stainless-Lang": "python", "X-Harness-Type": "x" },
      body: body("hi"),
    })
    const after = Math.floor(Date.now() / 1000)
    const h = sent[0].headers
    expect(sent[0].url).toBe("https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw/v1/chat/completions")
    expect(h.get("X-Channel")).toBe("official")
    expect(h.get("X-Version")).toBe("2.0.3")
    expect(h.get("X-Tm")).toBe(platformTm(process.platform))
    expect(h.get("X-Product")).toBe("autoclaw")
    expect(h.get("X-Lang")).toBe("en")
    expect(h.get("X-Client-Type")).toBe("pc")
    expect(h.get("x_trace_id")).toBe("autoclaw-desktop")
    expect(h.get("X-Auth-Appid")).toBe("100003")
    const ts = Number(h.get("X-Auth-TimeStamp"))
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
    expect(h.get("X-Auth-Sign")).toBe(md5Hex(`100003&${h.get("X-Auth-TimeStamp")}&38d2391985e2369a5fb8227d8e6cd5e5`))
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(h.get("X-Request-Id")).toMatch(uuid)
    expect(h.get("X-Trace-Id")).toBe(h.get("X-Request-Id"))
    expect(h.get("X-Session-Id")).toMatch(uuid)
    expect(h.get("X-Request-Model")).toBe("zai_glm-5.3-flash")
    expect(h.get("X-Authorization")).toBe("Bearer a1")
    expect(h.get("Authorization")).toBeNull()
    expect(h.get("X-Harness-Type")).toBeNull()
    expect(h.get("User-Agent")).toBe("OpenAI/JS 6.26.0")
    expect(h.get("X-Stainless-Lang")).toBe("js")
    expect(h.get("X-Stainless-Package-Version")).toBe("6.26.0")
    expect(h.get("X-Stainless-OS")).toBe(stainlessOs(process.platform))
    expect(h.get("X-Stainless-Arch")).toBe(stainlessArch(process.arch))
    expect(h.get("X-Stainless-Runtime")).toBe("node")
    expect(h.get("X-Stainless-Runtime-Version")).toBe("v24.18.0")

    // one conversation keeps its session id across turns, and a new one gets another
    await loader.fetch("x", { method: "POST", body: JSON.stringify({ model: "zai_glm-5.3-flash", messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }, { role: "assistant", content: "yo" }, { role: "user", content: "more" }] }) })
    await loader.fetch("x", { method: "POST", body: body("another chat") })
    expect(sent[1].headers.get("X-Session-Id")).toBe(h.get("X-Session-Id"))
    expect(sent[2].headers.get("X-Session-Id")).not.toBe(h.get("X-Session-Id"))
    expect(sent[1].headers.get("X-Request-Id")).not.toBe(h.get("X-Request-Id"))
  } finally {
    globalThis.fetch = realFetch
  }
})

test("on Linux the official fingerprint says linux, x64 and arm64 alike", () => {
  const { setOfficialChatHeaders } = _internal
  for (const arch of ["x64", "arm64"]) {
    const h = setOfficialChatHeaders(new Headers(), { accessToken: "a1", model: "m", sessionId: "s", platform: "linux", arch })
    expect(h.get("X-Tm")).toBe("linux")
    expect(h.get("X-Stainless-OS")).toBe("Linux")
    expect(h.get("X-Stainless-Arch")).toBe(arch)
    expect(h.get("X-Channel")).toBe("official")
  }
  const mac = setOfficialChatHeaders(new Headers(), { accessToken: "a1", model: "m", sessionId: "s", platform: "darwin", arch: "arm64" })
  expect(mac.get("X-Tm")).toBe("mac")
  expect(mac.get("X-Stainless-OS")).toBe("MacOS")
  const win = setOfficialChatHeaders(new Headers(), { accessToken: "a1", model: "m", sessionId: "s", platform: "win32", arch: "x64" })
  expect(win.get("X-Tm")).toBe("win")
  expect(win.get("X-Stainless-OS")).toBe("Windows")
})

// plugins#274: the CN managed gateway answers a spent quota with a 403 whose
// body says so (code 810000); the same token's next request gets as far as
// the model check, so it is the quota, not the sign-in
const SPENT = { code: 810000, message: "GLM-5.3 免费额度已用完,开通连续包月会员继续使用" }

test("CN chat: a 403 for a spent quota is a 429 with the gateway's words, and the sign-in is kept", async () => {
  const realFetch = globalThis.fetch
  let answer = () => Response.json(SPENT, { status: 403 })
  globalThis.fetch = async () => answer()
  try {
    const hooks = await AutoclawCnAuthPlugin({ client: { auth: { set: async () => {} } } })
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "a1" }))
    const body = JSON.stringify({ model: "zaicoding_glm-5.3", messages: [{ role: "user", content: "hi" }] })
    const spent = await loader.fetch("x", { method: "POST", body })
    expect(spent.status).toBe(429)
    expect(spent.headers.get("X-Magpie-Sign-In")).toBe("kept")
    const e = (await spent.json()).error
    expect(e.message).toBe("AutoClaw: GLM-5.3 免费额度已用完,开通连续包月会员继续使用")
    expect(e.code).toBe(810000)

    // any other 403, and a 401, is still the sign-in
    for (const [status, raw] of [[403, ""], [403, '{"code":401,"message":"token invalid"}'], [401, JSON.stringify(SPENT)]]) {
      answer = () => new Response(raw, { status })
      const dead = await loader.fetch("x", { method: "POST", body })
      expect(dead.status).toBe(401)
      expect(dead.headers.get("X-Magpie-Sign-In")).toBe("expired")
    }
  } finally {
    globalThis.fetch = realFetch
  }
})

test("overseas chat: a spent quota on the first host isn't asked of the second, and isn't the sign-in", async () => {
  const realFetch = globalThis.fetch
  const urls = []
  let answer = () => Response.json(SPENT, { status: 403 })
  globalThis.fetch = async (input) => {
    urls.push(String(input))
    return answer()
  }
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } })
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "a1" }))
    const body = JSON.stringify({ model: "zai_glm-5.3-flash", messages: [{ role: "user", content: "hi" }] })
    const spent = await loader.fetch("x", { method: "POST", body })
    expect(spent.status).toBe(429)
    expect(spent.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect(urls.length).toBe(1)

    // both hosts refusing the token is still the sign-in
    urls.length = 0
    answer = () => new Response("forbidden", { status: 403 })
    const dead = await loader.fetch("x", { method: "POST", body })
    expect(dead.status).toBe(401)
    expect(dead.headers.get("X-Magpie-Sign-In")).toBe("expired")
    expect(urls.length).toBe(2)
  } finally {
    globalThis.fetch = realFetch
  }
})

// 小八 (Discord, 2026-10-23): a banned AutoClaw account answers every route
// with exactly these bytes. It is the account, not an expired sign-in:
// magpie must keep the token and show the vendor's words.
const BANNED = '{"code":410004,"message":"The account has been banned"}'

test("bannedSaid reads the code or message field, never the whole body", () => {
  const { bannedSaid } = _internal
  expect(bannedSaid(JSON.parse(BANNED))).toBe("The account has been banned")
  expect(bannedSaid({ code: 410004 })).toBe("account refused (code 410004)")
  expect(bannedSaid({ code: 1, msg: "账号已被封禁" })).toBe("账号已被封禁")
  expect(bannedSaid({ error: { message: "账号异常，请联系客服" } })).toBe("账号异常，请联系客服")
  // a true expiry, and "banned" outside the code/message fields, are not a ban
  expect(bannedSaid({ code: 401, message: "token invalid" })).toBe("")
  expect(bannedSaid({ code: 401001, msg: "invalid_grant", detail: "The account has been banned" })).toBe("")
  expect(bannedSaid({ code: 401, message: "token expired" })).toBe("")
})

test("overseas chat: a banned account is a 403 with the vendor's words, the sign-in kept, the second host not asked", async () => {
  const realFetch = globalThis.fetch
  const urls = []
  let answer = () => new Response(BANNED, { status: 403, headers: { "content-type": "application/json" } })
  globalThis.fetch = async (input) => {
    urls.push(String(input))
    return answer()
  }
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } })
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "a1" }))
    const body = JSON.stringify({ model: "zai_glm-5.3-flash", messages: [{ role: "user", content: "hi" }] })
    const banned = await loader.fetch("x", { method: "POST", body })
    expect(banned.status).toBe(403)
    expect(banned.headers.get("X-Magpie-Sign-In")).toBe("kept")
    const e = (await banned.json()).error
    expect(e.message).toBe("AutoClaw: The account has been banned")
    expect(e.type).toBe("permission_error")
    expect(e.code).toBe(410004)
    expect(urls.length).toBe(1)

    // a token both hosts refuse as expired is still the sign-in
    urls.length = 0
    answer = () => new Response('{"code":401,"message":"token expired"}', { status: 401 })
    const dead = await loader.fetch("x", { method: "POST", body })
    expect(dead.status).toBe(401)
    expect(dead.headers.get("X-Magpie-Sign-In")).toBe("expired")
    expect(urls.length).toBe(2)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("CN chat: a banned account is a 403 with the vendor's words, and the sign-in is kept", async () => {
  const realFetch = globalThis.fetch
  let answer = () => new Response(BANNED, { status: 403 })
  globalThis.fetch = async () => answer()
  try {
    const hooks = await AutoclawCnAuthPlugin({ client: { auth: { set: async () => {} } } })
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "a1" }))
    const body = JSON.stringify({ model: "zaicoding_glm-5.3", messages: [{ role: "user", content: "hi" }] })
    const banned = await loader.fetch("x", { method: "POST", body })
    expect(banned.status).toBe(403)
    expect(banned.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect((await banned.json()).error.message).toBe("AutoClaw: The account has been banned")

    answer = () => new Response('{"code":401,"message":"token invalid"}', { status: 403 })
    const dead = await loader.fetch("x", { method: "POST", body })
    expect(dead.status).toBe(401)
    expect(dead.headers.get("X-Magpie-Sign-In")).toBe("expired")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("refreshTokens keeps a banned account's sign-in and says why", async () => {
  const realFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (input) => {
    requests.push(String(input))
    return new Response(BANNED, { status: 403 })
  }
  try {
    let threw
    try { await refreshTokens(jwt({ source_id: "google" }), []) } catch (e) { threw = e }
    expect(threw).toBeInstanceOf(Error)
    expect(threw.message).toBe("AutoClaw: The account has been banned")
    expect(threw.signIn).toBe("kept")
    expect(requests.length).toBe(1)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("refreshTokens keeps the sign-in for a ban without an envelope code", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{"message":"The account has been banned"}', { status: 403 })
  try {
    let threw
    try { await refreshTokens(jwt({ source_id: "google" }), []) } catch (e) { threw = e }
    expect(threw.message).toBe("AutoClaw: The account has been banned")
    expect(threw.signIn).toBe("kept")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("usage and check-in of a banned account say the ban and keep the sign-in", async () => {
  const realFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (input) => {
    urls.push(String(input))
    return new Response(BANNED, { status: 403 })
  }
  try {
    for (const plugin of [AutoclawAuthPlugin, AutoclawCnAuthPlugin]) {
      const hooks = await plugin({ client: { auth: { set: async () => {} } } }, {})
      const u = await hooks.auth.usage(async () => ({ type: "oauth", access: "a1", refresh: "r1" }))
      expect(u.error).toBe("AutoClaw: The account has been banned")
      expect(u.signIn).toBe("kept")
      urls.length = 0
      let threw
      try { await hooks.auth.checkin(async () => ({ type: "oauth", access: "a1", refresh: "r1" })) } catch (e) { threw = e }
      expect(threw.message).toBe("AutoClaw: The account has been banned")
      expect(threw.signIn).toBe("kept")
      expect(urls.some((u) => u.includes("autoclaw-task-complete"))).toBe(false)
    }
  } finally {
    globalThis.fetch = realFetch
  }
})

// plugins#437 (tmuer): AutoClaw's CN gateway answers 500 {"message":"parse
// response failed"} to each of these, the reporter's own fragments sent
// straight to it. What an agent's history can hold of them is put right
// before it goes; what reads right goes as it was.
test("the shapes AutoClaw's gateway can't read go put right, on both channels (#437)", async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) })
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] })
  }
  const history = [
    { role: "user", content: "hi" },
    { role: "assistant", content: null },
    { role: "assistant", content: "a", reasoning_content: "think" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "exec" } }] },
    { role: "tool", tool_call_id: "c1", content: "done" },
    { role: "assistant", tool_calls: [{ id: "c2", type: "function", function: { name: "read", arguments: { path: "a.txt" } } }] },
    { role: "tool", tool_call_id: "c2", content: "x" },
    { role: "assistant", content: "", tool_calls: [{ id: "c3", type: "function", function: { name: "glob", arguments: "{\"p\":\"*\"}" } }] },
  ]
  try {
    for (const make of [AutoclawCnAuthPlugin, AutoclawAuthPlugin]) {
      const hooks = await make({ client: { auth: { set: async () => {} } } })
      const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "a1" }))
      for (const tools of ["x", []]) {
        const res = await loader.fetch("x", { method: "POST", body: JSON.stringify({ model: "zaicoding_glm-5.3", tools, tool_choice: "auto", messages: history }) })
        expect(res.status).toBe(200)
        const { body } = calls.at(-1)
        expect("tools" in body).toBe(false)
        expect("tool_choice" in body).toBe(false)
        const m = body.messages.slice(1) // after the system prompt the plugin puts first
        expect(m[1]).toEqual({ role: "assistant", content: "" })
        expect(m[2]).toEqual({ role: "assistant", content: "a" })
        expect(m[3].content).toBe("")
        expect(m[3].tool_calls[0].function).toEqual({ name: "exec", arguments: "{}" })
        expect(m[5].tool_calls[0].function.arguments).toBe("{\"path\":\"a.txt\"}")
        expect(m[7]).toEqual(history[7]) // read right: as it was
      }
      // a list of tools goes as it was
      const tools = [{ type: "function", function: { name: "exec", parameters: { type: "object", properties: {} } } }]
      await loader.fetch("x", { method: "POST", body: JSON.stringify({ model: "zaicoding_glm-5.3", tools, tool_choice: "auto", messages: [{ role: "user", content: "hi" }] }) })
      expect(calls.at(-1).body.tools).toEqual(tools)
      expect(calls.at(-1).body.tool_choice).toBe("auto")
    }
  } finally {
    globalThis.fetch = realFetch
  }
})



// The spend window rides on local balance deltas (the upstream has no points
// ledger): a drop is spend, and ANY rise over the last balance opens a new
// cycle - a check-in often lands after a spend, and waiting to pass the old
// peak would under-count the cycle. The Beijing-day sums keep the day's view.
test("balanceObserve: spend, top-up, and the day's sums", () => {
  const { balanceObserve, setUsageStatePath, beijingDayOf } = _internal
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-usage-"))
  setUsageStatePath(join(dir, ".usage-state.json"))
  const K = "test-" + Math.random().toString(36).slice(2)
  try {
    // fresh sight: the peak is where tracking starts, nothing spent yet
    expect(balanceObserve(K, 1000)).toEqual({ peak: 1000, used: 0, daySpent: 0, dayGained: 0 })
    // a drop is spend against the peak
    expect(balanceObserve(K, 900)).toEqual({ peak: 1000, used: 100, daySpent: 100, dayGained: 0 })
    // a rise opens a new cycle: used resets, the gain adds up
    expect(balanceObserve(K, 1100)).toEqual({ peak: 1100, used: 0, daySpent: 100, dayGained: 200 })
    // further drops spend against the new peak
    expect(balanceObserve(K, 1050)).toEqual({ peak: 1100, used: 50, daySpent: 150, dayGained: 200 })
    // the review's case: spend 500, then a check-in +200 lands BELOW the old
    // peak — the cycle still reopens (used 0), and the day keeps the 500
    const K2 = K + "-2"
    balanceObserve(K2, 1000)
    balanceObserve(K2, 500)
    expect(balanceObserve(K2, 700)).toEqual({ peak: 700, used: 0, daySpent: 500, dayGained: 200 })
    // a drained pool is the most common cycle: 0 is a real reading, not
    // "never seen" — the check-in that follows reopens the cycle from zero
    const K3 = K + "-3"
    balanceObserve(K3, 1000)
    balanceObserve(K3, 0)
    expect(balanceObserve(K3, 200)).toEqual({ peak: 200, used: 0, daySpent: 1000, dayGained: 200 })
    expect(beijingDayOf()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The window as the card sees it: nothing on a fresh sight, then the cycle's
// share with the day's sums; a check-in below the old peak reopens the cycle.
test("usage: the spend window across two reads, and a check-in that reopens the cycle", async () => {
  const realFetch = globalThis.fetch
  let balance = 20000
  globalThis.fetch = async (input) => {
    const u = String(input)
    if (u.includes("wallets")) return Response.json({ code: 0, data: { total_balance: balance, wallets: [] } })
    if (u.includes("autoclaw-task-list")) {
      return Response.json({ code: 0, data: [{ task_id: "daily_signin", status: "completed", reward_points: 200 }] })
    }
    return Response.json({ code: 0, data: null })
  }
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-usage-"))
  _internal.setUsageStatePath(join(dir, ".usage-state.json"))
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } })
    const auth = { type: "oauth", access: "a1", refresh: "r1", uid: "spend-1" }
    // fresh sight: the peak is set, no spend window yet, the wallet as told
    const first = await hooks.auth.usage(async () => auth)
    expect(first.windows.find((w) => w.name === "本轮消耗")).toBeUndefined()
    expect(first.windows.find((w) => w.name === "积分余额")).toEqual({ name: "积分余额", balance: 20000, unit: "积分" })
    // the pool drains 3123: the window carries the share and the day's spend
    balance = 16877
    const second = await hooks.auth.usage(async () => auth)
    expect(second.windows.find((w) => w.name === "积分余额")?.balance).toBe(16877)
    const w = second.windows.find((x) => x.name === "本轮消耗")
    // display only: the share is spend since the last rise, not what is left
    expect(w.aside).toBe(true)
    expect(w.used).toBe(15.6)
    expect(w.remaining).toBe(84.4)
    expect(w.amount).toBe(3123)
    expect(w.limit).toBe(20000)
    expect(w.display).toBe("3123 / 20000 积分 · 今日 -3123")
    // a check-in +200 lands below the old peak and still reopens the cycle
    balance = 17077
    const third = await hooks.auth.usage(async () => auth)
    expect(third.windows.find((x) => x.name === "本轮消耗")).toBeUndefined()
  } finally {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── login event claim（user-info → 活动奖励；每日签到仍是 task-complete）──

const claimJwt = (deviceId) => jwt({ device_id: deviceId, exp: Math.floor(Date.now() / 1000) + 86400, source_id: "autoclaw" })
const claimAuth = (deviceId, extra = {}) => ({
  type: "oauth", access: `at-${deviceId}`, refresh: claimJwt(deviceId),
  accountId: "测试账号", uid: `u-${deviceId}`, ...extra,
})
const okUserInfo = () => Response.json({ code: 0, msg: "SUCCESS", data: { uid: "u1", daily_check_included: false, daily_check_in_completed_on_request: false } })
const pendingTask = (reward = 400) => Response.json({ code: 0, data: [{ task_id: "daily_signin", status: "pending", reward_points: reward }] })
const completedTask = (reward = 400) => Response.json({ code: 0, data: [{ task_id: "daily_signin", status: "completed", reward_points: reward }] })
const signedTask = (reward = 400, streak = 1) => Response.json({ code: 0, data: { success: true, reward_points: reward, continuous_days: streak } })

// 桌面端指纹是这次修复的全部前提：极简头同样 code=0 却不发奖励（#3681）。
// 这个测试直接检查线上请求，任何一处头/令牌/设备号回退都会变红。
test("checkin: user-info carries the desktop fingerprint, the current access token and the login device id", async () => {
  const realFetch = globalThis.fetch
  const seen = []
  const auth = claimAuth("qc-fingerprint")
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.includes("/userapi/v1/user-info")) {
      seen.push({ host: new URL(url).host, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) })
      return okUserInfo()
    }
    if (url.includes("/userapi/v1/refresh") || url.includes("/agent-refresh")) throw new Error("access token 可用时不该花 refresh token")
    if (url.includes("autoclaw-task-list")) return completedTask()
    return Response.json({ code: 0, data: {} })
  }
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } }, {})
    const result = await hooks.auth.checkin(async () => auth)
    expect(result.outcome).toBe("done")
    const ui = seen[0]
    expect(ui).toBeDefined()
    expect(ui.headers.get("X-Channel")).toBe("AutoClaw20")
    expect(ui.headers.get("X-Version")).toBe("2.2.0")
    expect(ui.headers.get("X-Tm")).toBe("win-x64")
    expect(ui.headers.get("X-Product")).toBe("autoclaw")
    expect(ui.headers.get("User-Agent")).toBe("AutoClaw/2.2.0 (win-x64)")
    expect(ui.headers.get("Authorization")).toBe(`Bearer ${auth.access}`)
    expect(ui.body.device_id).toBe("qc-fingerprint")
    expect(seen.every((s) => !String(s.headers.get("Authorization")).includes("undefined"))).toBe(true)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("checkin: user-info runs before task-complete and the daily credit comes from task-complete", async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (url.includes("/userapi/v1/user-info")) return okUserInfo()
    if (url.includes("/userapi/v1/refresh") || url.includes("/agent-refresh")) throw new Error("不该刷新")
    if (url.includes("autoclaw-task-list")) return pendingTask(999) // 故意与签到奖励不同，验证 credit 来源
    if (url.includes("autoclaw-task-complete")) return signedTask(400, 3)
    return Response.json({ code: 0, data: {} })
  }
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } }, {})
    const result = await hooks.auth.checkin(async () => claimAuth("qc-order"))
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(400)
    expect(result.streak).toBe(3)
    expect(calls.findIndex((c) => c.includes("/userapi/v1/user-info"))).toBeLessThan(
      calls.findIndex((c) => c.includes("autoclaw-task-complete")),
    )
    expect(calls.some((c) => c.includes("/userapi/v1/refresh"))).toBe(false)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("checkin: task-list already completed → done, without calling task-complete", async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (url.includes("/userapi/v1/user-info")) return okUserInfo()
    if (url.includes("autoclaw-task-list")) return completedTask()
    return Response.json({ code: 0, data: {} })
  }
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } }, {})
    const result = await hooks.auth.checkin(async () => claimAuth("qc-done"))
    expect(result.outcome).toBe("done")
    expect(result.credit).toBe(400)
    expect(calls.some((c) => c.includes("autoclaw-task-complete"))).toBe(false)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("checkin: user-info rejected on host[0] is retried on host[1]", async () => {
  const realFetch = globalThis.fetch
  const hosts = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/userapi/v1/user-info")) {
      const host = new URL(url).host
      hosts.push(host)
      return host === "autoglm-api.autoglm.ai"
        ? Response.json({ code: 410000, msg: "用户未登录" })
        : okUserInfo()
    }
    if (url.includes("autoclaw-task-list")) return pendingTask()
    if (url.includes("autoclaw-task-complete")) return signedTask()
    return Response.json({ code: 0, data: {} })
  }
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } }, {})
    const result = await hooks.auth.checkin(async () => claimAuth("qc-hostfallback"))
    expect(hosts).toEqual(["autoglm-api.autoglm.ai", "autoglm-api.zhipuai.cn"])
    expect(result.outcome).toBe("claimed")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("checkin: a user-info network failure never blocks the daily signin and is reported", async () => {
  const realFetch = globalThis.fetch
  const hosts = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/userapi/v1/user-info")) {
      const host = new URL(url).host
      hosts.push(host)
      if (host === "autoglm-api.autoglm.ai") throw new TypeError("fetch failed")
      return Response.json({ code: 410000, msg: "用户未登录" })
    }
    if (url.includes("autoclaw-task-list")) return pendingTask()
    if (url.includes("autoclaw-task-complete")) return signedTask()
    return Response.json({ code: 0, data: {} })
  }
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } }, {})
    const result = await hooks.auth.checkin(async () => claimAuth("qc-campaignfail"))
    expect(hosts).toEqual(["autoglm-api.autoglm.ai", "autoglm-api.zhipuai.cn"])
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(400)
    expect(result.message).toContain("登录活动奖励未触发")
  } finally {
    globalThis.fetch = realFetch
  }
})

// 两个 host 都查不到任务时绝不能报 inactive：那会把当天判死（#3326）。
test("checkin: both task-list hosts failing throws (failed), never misreports inactive", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/userapi/v1/user-info")) return okUserInfo()
    if (url.includes("autoclaw-task-list")) return new Response('{"message":"oops"}', { status: 500 })
    return Response.json({ code: 0, data: {} })
  }
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } }, {})
    let threw
    try { await hooks.auth.checkin(async () => claimAuth("qc-tasklistfail")) } catch (e) { threw = e }
    expect(threw).toBeInstanceOf(Error)
    expect(threw.message).toContain("task-list")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("checkin: an expired access token is refreshed once, then the whole round is retried", async () => {
  const realFetch = globalThis.fetch
  const freshAccess = claimJwt("qc-fresh-token")
  const auth = claimAuth("qc-expired")
  const sets = []
  let stage = "old"
  let refreshes = 0
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/userapi/v1/refresh") || url.includes("/agent-refresh")) {
      refreshes++
      stage = "new"
      return Response.json({ code: 0, msg: "SUCCESS", data: { access_token: freshAccess, refresh_token: "rt-qc-fresh" } })
    }
    if (url.includes("/userapi/v1/user-info")) return stage === "new" ? okUserInfo() : Response.json({ code: 410000, msg: "用户未登录" })
    if (url.includes("autoclaw-task-list")) return stage === "new" ? pendingTask() : new Response("{}", { status: 401 })
    if (url.includes("autoclaw-task-complete")) return signedTask(400, 2)
    return Response.json({ code: 0, data: {} })
  }
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async (o) => { sets.push(o); return { data: true } } } } }, {})
    const result = await hooks.auth.checkin(async () => auth)
    expect(refreshes).toBe(1)
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(400)
    expect(sets.length).toBe(1)
    expect(sets[0].path.id).toBe("autoclaw")
    expect(sets[0].body.refresh).toBe("rt-qc-fresh")
    expect(sets[0].body.access).toBe(freshAccess)
    expect(sets[0].body.accountId).toBe(auth.accountId)
    expect(sets[0].body.uid).toBe(auth.uid)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("checkin: a dead refresh token with an expired access token fails with signIn expired", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/userapi/v1/refresh") || url.includes("/agent-refresh")) {
      return Response.json({ code: 400002, msg: "invalid_grant: token has been revoked" })
    }
    if (url.includes("/userapi/v1/user-info")) return Response.json({ code: 410000, msg: "用户未登录" })
    if (url.includes("autoclaw-task-list")) return new Response("{}", { status: 401 })
    return Response.json({ code: 0, data: {} })
  }
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } }, {})
    let threw
    try { await hooks.auth.checkin(async () => claimAuth("qc-deadrt")) } catch (e) { threw = e }
    expect(threw).toBeInstanceOf(Error)
    expect(threw.signIn).toBe("expired")
  } finally {
    globalThis.fetch = realFetch
  }
})

// CAS：签到期间用户重新登录，旧轮换绝不能覆盖新记录。
test("checkin: a re-sign-in during the refresh is not clobbered by the rotation write", async () => {
  const realFetch = globalThis.fetch
  const auth = claimAuth("qc-resignin")
  const reauth = claimAuth("qc-resignin-new")
  const sets = []
  let stage = "old"
  let reads = 0
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/userapi/v1/refresh") || url.includes("/agent-refresh")) {
      stage = "new"
      return Response.json({ code: 0, msg: "SUCCESS", data: { access_token: claimJwt("qc-resignin-fresh"), refresh_token: "rt-qc-resignin-fresh" } })
    }
    if (url.includes("/userapi/v1/user-info")) return stage === "new" ? okUserInfo() : Response.json({ code: 410000, msg: "用户未登录" })
    if (url.includes("autoclaw-task-list")) return stage === "new" ? pendingTask() : new Response("{}", { status: 401 })
    if (url.includes("autoclaw-task-complete")) return signedTask()
    return Response.json({ code: 0, data: {} })
  }
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async (o) => { sets.push(o); return { data: true } } } } }, {})
    const getAuth = async () => (++reads === 1 ? auth : reauth)
    const result = await hooks.auth.checkin(getAuth)
    expect(result.outcome).toBe("claimed")
    expect(sets.length).toBe(0)
  } finally {
    globalThis.fetch = realFetch
  }
})

// 写回失败时，已花费的旧 RT 换出的新令牌必须留在内存供下一次续期取用。
test("checkin: a failed rotation write is remembered for the next renewal", async () => {
  const realFetch = globalThis.fetch
  const freshAccess = claimJwt("qc-persistfail-fresh")
  const auth = claimAuth("qc-persistfail")
  let stage = "old"
  let refreshes = 0
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/userapi/v1/refresh") || url.includes("/agent-refresh")) {
      refreshes++
      stage = "new"
      return Response.json({ code: 0, msg: "SUCCESS", data: { access_token: freshAccess, refresh_token: "rt-qc-persistfail-fresh" } })
    }
    if (url.includes("/userapi/v1/user-info")) return stage === "new" ? okUserInfo() : Response.json({ code: 410000, msg: "用户未登录" })
    if (url.includes("autoclaw-task-list")) return stage === "new" ? pendingTask() : new Response("{}", { status: 401 })
    if (url.includes("autoclaw-task-complete")) return signedTask()
    return Response.json({ code: 0, data: {} })
  }
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => { throw new Error("EACCES") } } } }, {})
    const result = await hooks.auth.checkin(async () => auth)
    expect(result.outcome).toBe("claimed")
    // 清掉 60 秒单飞缓存：这一步之后只有 rotatedMemo 能解释「不打网络」，
    // 删掉 rememberRotated 的改动会立刻让下面两个断言变红。
    _internal.clearRefreshGates()
    const before = refreshes
    const t = await hooks.auth.refresh(auth)
    expect(refreshes).toBe(before)
    expect(t.access).toBe(freshAccess)
    expect(t.refresh).toBe("rt-qc-persistfail-fresh")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("checkin: task-complete already_completed → done, not failed", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/userapi/v1/user-info")) return okUserInfo()
    if (url.includes("autoclaw-task-list")) return pendingTask()
    if (url.includes("autoclaw-task-complete")) {
      return Response.json({ code: 0, data: { success: false, already_completed: true, reward_points: 400 } })
    }
    return Response.json({ code: 0, data: {} })
  }
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } }, {})
    const result = await hooks.auth.checkin(async () => claimAuth("qc-already"))
    expect(result.outcome).toBe("done")
    expect(result.credit).toBe(400)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("checkin: a ban surfacing at task-list keeps the sign-in and propagates the ban", async () => {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (url.includes("/userapi/v1/user-info")) return okUserInfo()
    if (url.includes("autoclaw-task-list")) return new Response(BANNED, { status: 403 })
    return Response.json({ code: 0, data: {} })
  }
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } }, {})
    let threw
    try { await hooks.auth.checkin(async () => claimAuth("qc-ban")) } catch (e) { threw = e }
    expect(threw.message).toBe("AutoClaw: The account has been banned")
    expect(threw.signIn).toBe("kept")
    expect(calls.some((c) => c.includes("autoclaw-task-complete"))).toBe(false)
  } finally {
    globalThis.fetch = realFetch
  }
})

// 同一个一次性 RT 的并发续期只能打一次网络（单飞）；按创建时间过期会烧第二次。
test("checkin: two concurrent expired-token checkins share one refresh", async () => {
  const realFetch = globalThis.fetch
  const auth = claimAuth("qc-concurrent")
  let stage = "old"
  let refreshes = 0
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/userapi/v1/refresh") || url.includes("/agent-refresh")) {
      refreshes++
      stage = "new"
      return Response.json({ code: 0, msg: "SUCCESS", data: { access_token: claimJwt("qc-concurrent-fresh"), refresh_token: "rt-qc-concurrent-fresh" } })
    }
    if (url.includes("/userapi/v1/user-info")) return stage === "new" ? okUserInfo() : Response.json({ code: 410000, msg: "用户未登录" })
    if (url.includes("autoclaw-task-list")) return stage === "new" ? pendingTask() : new Response("{}", { status: 401 })
    if (url.includes("autoclaw-task-complete")) return signedTask()
    return Response.json({ code: 0, data: {} })
  }
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => ({ data: true }) } } }, {})
    const [a, b] = await Promise.all([
      hooks.auth.checkin(async () => auth),
      hooks.auth.checkin(async () => auth),
    ])
    expect(refreshes).toBe(1)
    expect(a.outcome).toBe("claimed")
    expect(b.outcome).toBe("claimed")
  } finally {
    globalThis.fetch = realFetch
  }
})

// Two accounts can carry the same display name (#254), so the ledger key is
// signinAccountKey - uid, or the refresh token when an old account has none -
// never the name. Both accounts here have NO uid on purpose: the pre-review
// key (uid ?? accountId ?? provider) fell back to the shared display name and
// read B's first sight as spend against A's peak; only the token-hash key
// keeps them apart.
test("usage: two same-name accounts keep separate ledgers", async () => {
  const realFetch = globalThis.fetch
  const balances = { a1: 1000, a2: 300 }
  globalThis.fetch = async (input, init) => {
    const u = String(input)
    if (u.includes("wallets")) {
      const who = new Headers(init?.headers).get("Authorization")
      return Response.json({ code: 0, data: { total_balance: balances[who.slice(-2)], wallets: [] } })
    }
    return Response.json({ code: 0, data: [] })
  }
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-usage-"))
  _internal.setUsageStatePath(join(dir, ".usage-state.json"))
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } })
    const a = { type: "oauth", access: "a1", refresh: "r1", accountId: "AutoClaw用户" }
    const b = { type: "oauth", access: "a2", refresh: "r2", accountId: "AutoClaw用户" }
    await hooks.auth.usage(async () => a)
    // B is a fresh sight of its own, not A's ledger: no window, not "used 700"
    const u = await hooks.auth.usage(async () => b)
    expect(u.windows.find((x) => x.name === "本轮消耗")).toBeUndefined()
    expect(u.windows.find((x) => x.name === "积分余额")?.balance).toBe(300)
    expect(u.balance).toBe("300 积分")
  } finally {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

// An unreadable total_balance (null / "" / not a number) is "unknown", never
// a drained pool: Number(null) is 0, which would record the whole cycle as
// spent and let routing shelve the account. The next good read starts clean.
test("usage: an unreadable total_balance is unknown, not a drained pool", async () => {
  const realFetch = globalThis.fetch
  let balance = null
  globalThis.fetch = async (input) => {
    const u = String(input)
    if (u.includes("wallets")) return Response.json({ code: 0, data: { total_balance: balance, wallets: [] } })
    return Response.json({ code: 0, data: [] })
  }
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-usage-"))
  _internal.setUsageStatePath(join(dir, ".usage-state.json"))
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } })
    const auth = { type: "oauth", access: "a1", refresh: "r1", uid: "null-1" }
    const bad = await hooks.auth.usage(async () => auth)
    expect(bad.error).toBe("积分响应异常")
    expect(bad.windows).toEqual([])
    // the ledger never saw the null: the next good read is a fresh sight
    balance = 990
    const good = await hooks.auth.usage(async () => auth)
    expect(good.error).toBeUndefined()
    expect(good.balance).toBe("990 积分")
    expect(good.windows.find((x) => x.name === "本轮消耗")).toBeUndefined()
    expect(good.windows.find((x) => x.name === "积分余额")?.balance).toBe(990)
  } finally {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  }
})
