// The check-in mapping is magpie's contract (provider-plugins.md): every
// answer the upstream gives lands on one of its outcomes, and the plugin
// factory registers both providers with every hook check.mjs looks for.
import { expect, test, setSystemTime } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, statSync, utimesSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AutoclawAuthPlugin, AutoclawCnAuthPlugin, _internal } from "./index.mjs"

const {
  checkinOutcome, signinConfig, bareToken, codeValue, tokenFields, refreshTokens, startLocalOAuth,
  autoclawRewriteBody, unflag, unflagged, explained, FLAGGED, OFFICIAL_SYSTEM_PROMPT, REFUSED_HINT, dumpDefaultDir,
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
// 11-03: the same refusal caught the Fable harness's "You are powered by
// the model glm-5.3-flash[1m]." (42 x 406 in one day; probed: the line
// alone 406s, the rewritten form 200s), so a second rule rewrites that
// "powered by the model <version>" shape, context-tier bracket and all.
test("WorkBuddy's GLM opening line and CodeBuddy Code's identity line are rewritten", () => {
  const opening = "This conversation is powered by GLM-5.3 · AutoClaw 国内 (Zhipu)"
  expect(unflagged(opening)).toBe("This conversation is powered by the GLM-5.3 model · AutoClaw 国内 (Zhipu)")
  expect(unflagged("This conversation is powered by GLM-4")).toBe("This conversation is powered by the GLM-4 model")
  expect(unflagged("Intro.\nthis conversation is powered by glm-5.3.")).toBe("Intro.\nThis conversation is powered by the GLM-5.3 model.")
  expect(unflagged("This conversation is powered by GLM-4.5-Air.")).toBe("This conversation is powered by the GLM-4.5-Air model.")
  // the Fable harness's model line: probed 406 as written, 200 rewritten
  expect(unflagged("You are powered by the model glm-5.3-flash[1m].")).toBe("You are powered by the GLM-5.3-flash model.")
  expect(unflagged("Powered by the model GLM-4.5-Air.")).toBe("Powered by the GLM-4.5-Air model.")
  // what the gateway takes stays as written
  for (const t of [
    "This conversation is powered by GLM",
    "This conversation is powered by ChatGLM-5.3",
    "The conversation is powered by GLM-5.3",
    "You are powered by GLM-5.3",
    "You are powered by the GLM-5.3-flash model",
    "You are powered by the model claude-fable-5-1",
    "powered by the model 4.6-turbo",
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

// A table over every entry, so a later edit to one rule cannot silently
// break another (the 11-03 session's failing request carried three known
// lines at once, and only the missing one needed rewriting). Left side =
// what the harness opens with (or the reported line, byte for byte);
// right side = the form the gateway takes (probed, or the reporter's
// probe for that entry's original report). Idempotent on every row, so
// a cached prefix rewritten once stays put.
test("a system prompt carrying every known line at once comes out clean in one pass", () => {
  const lines = [
    ["You are Claude Code, Anthropic's official CLI for Claude.", "You are the Claude Code CLI, Anthropic's official CLI for Claude."],
    // 11-05: subagent prompts (fork/Explore) open with "an agent for", not
    // "You are Claude Code"; ten dumps that afternoon all carried this one line
    ["You are an agent for Claude Code, Anthropic's official CLI for Claude. Use the tools available to complete the task.", "You are an agent for the Claude Code CLI, Anthropic's official CLI for Claude. Use the tools available to complete the task."],
    ["Intro.\nYou are an agent for Claude Code, dispatched mid-task.", "Intro.\nYou are an agent for the Claude Code CLI, dispatched mid-task."],
    // the rewritten form must not grow a second CLI
    ["an agent for Claude Code CLI, ask it", "an agent for Claude Code CLI, ask it"],
    ["You are a Claude agent, built on Anthropic's Claude Agent SDK.", "You are a coding assistant."],
    ["We build on the Claude Agent SDK; see docs.", "We build on the agent framework; see docs."],
    ["You are an AI agent powered by DeepSeek Harness.", "You are an AI agent powered by DeepSeek-Harness."],
    ["You are Codex, OpenAI's coding agent.", "You are the Codex agent, OpenAI's coding agent."],
    ["Codex CLI is the tool you run.", "Codex command-line tool is the tool you run."],
    ["You are opencode, an AI coding agent.", "You are the opencode agent, an AI coding agent."],
    ["You are Cursor, a coding assistant.", "You are the Cursor agent, a coding assistant."],
    ["You are Cline, a coding assistant.", "You are the Cline agent, a coding assistant."],
    ["You are Qwen Code, an interactive CLI tool.", "You are the Qwen Code agent, an interactive CLI tool."],
    ["You are ZCode, an interactive coding agent", "You are the ZCode agent, an interactive coding agent"],
    ["operating inside pi, a coding agent harness.", "operating inside the pi coding agent harness."],
    ["This conversation is powered by GLM-5.3 · AutoClaw 国内 (Zhipu)", "This conversation is powered by the GLM-5.3 model · AutoClaw 国内 (Zhipu)"],
    ["You are powered by the model glm-5.3-flash[1m].", "You are powered by the GLM-5.3-flash model."],
    ["You are CodeBuddy Code.", "You are the CodeBuddy Code CLI."],
    ["You are Hermes Agent, built by Nous Research.", "You are the agent Hermes, built by Nous Research."],
    ["You run on Hermes Agent (by Nous Research).", "You run on Hermes-Agent (by Nous Research)."],
    ["You are Gemini CLI, an interactive CLI agent.", "You are the Gemini CLI agent, an interactive CLI agent."],
    ["You are Kimi Code CLI, an interactive AI agent.", "You are the Kimi Code CLI agent, an interactive AI agent."],
    ["You are goose, an autonomous AI agent.", "You are the goose agent, an autonomous AI agent."],
  ]
  for (const [inp, want] of lines) {
    expect(unflagged(inp)).toBe(want)
    // one pass of the whole table through one text, then that text again:
    // every row stays where its own rewrite put it
    expect(unflagged(unflagged(inp))).toBe(want)
  }
  // all lines at once, in one text: each rewritten, none twice
  const all = lines.map(([inp]) => inp).join("\n")
  const once = unflagged(all)
  expect(unflagged(once)).toBe(once)
  for (const [, want] of lines) expect(once).toContain(want)
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

// 11-04: the reporter's capture tool truncated the failing body at 256 KB and
// the refused sentence sat past the cut. The plugin sees the body it actually
// sends, so a 406 can dump the rewritten system prompt for diagnosis. The
// body is the user's conversation, so the dump is opt-in (AUTOCLAW_406_DUMP_DIR,
// or the plugin's dump406 option) and holds the system and developer messages
// only — never user, assistant or tool content. The dump must never break the
// 406 it documents.
test("a 406 dumps the system prompt, opt-in; the oldest dumps rot away by write time", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "autoclaw-test-")), "autoclaw-406")
  process.env.AUTOCLAW_406_DUMP_DIR = dir
  try {
    const refused406 = () => new Response(JSON.stringify({ error: { code: null, message: "406 Not Acceptable", type: "api_error" } }), { status: 406 })
    const line = "You are powered by the model glm-5.3-flash[1m]."
    // overseas path: the loader passes the body it actually sent — the rewritten one
    const raw = JSON.stringify({ model: "zai_glm-5.3-flash", messages: [{ role: "system", content: line }, { role: "user", content: "hi" }] })
    const sent = JSON.stringify(autoclawRewriteBody(raw))
    const refused = await explained(refused406(), sent, "autoclaw")
    expect(refused.status).toBe(406)
    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    const dumped = JSON.parse(readFileSync(join(dir, files[0]), "utf8"))
    expect(dumped.model).toBe("zai_glm-5.3-flash")
    // the refusal is about the system prompt: the user's words are not in it
    expect(dumped.messages).toHaveLength(1)
    expect(dumped.messages[0].role).toBe("system")
    expect(dumped.messages[0].content).toBe(`${OFFICIAL_SYSTEM_PROMPT}\n\nYou are powered by the GLM-5.3-flash model.`)
    expect(dumped.messages[0].content).not.toMatch(/powered by the model glm/i)
    expect(JSON.stringify(dumped)).not.toContain('"hi"')

    // ten at most: an eleventh refusal drops the oldest. The pre-placed file's
    // name sorts after every new one while its write time is older, so only
    // rotation by write time removes it (a name sort would keep it and drop
    // the newest dump instead). It carries the dump name's shape, since only
    // the dump's own files rotate.
    const old = join(dir, "autoclaw-406-9999-12-31T00-00-00-000Z-zzzzzzzz-autoclaw.json")
    writeFileSync(old, JSON.stringify({ model: "m", messages: [{ role: "system", content: "pre-existing" }] }))
    const past = new Date(Date.now() - 60_000)
    utimesSync(old, past, past)
    // the first dump is older than every refusal below, by its write time:
    // a file system whose times are coarser than these writes (WSL2's ext4
    // on a busy box) would otherwise tie it with them, and rotation could
    // drop a refusal in its place
    const firstDump = join(dir, files[0])
    const later = new Date(past.getTime() + 1_000)
    utimesSync(firstDump, later, later)
    // the directory is the user's to point anywhere: foreign files — a
    // settings.json, a non-dump anything — survive every refusal untouched
    writeFileSync(join(dir, "settings.json"), "{}")
    writeFileSync(join(dir, "keep-me.txt"), "not a dump")
    for (let i = 0; i < 10; i++) {
      await explained(refused406(), JSON.stringify({ model: "m", messages: [{ role: "system", content: `refusal ${i}` }] }), "autoclaw-cn")
    }
    const left = readdirSync(dir)
    expect(left).toContain("settings.json")
    expect(left).toContain("keep-me.txt")
    expect(left).not.toContain("autoclaw-406-9999-12-31T00-00-00-000Z-zzzzzzzz-autoclaw.json")
    const dumps = left.filter((f) => f.startsWith("autoclaw-406-"))
    expect(dumps).toHaveLength(10)
    const said = dumps.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).messages[0].content).sort()
    expect(said).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `refusal ${i}`))

    // the dump is 0600 in a 0700 directory (real modes exist off Windows)
    if (process.platform !== "win32") {
      const newest = dumps.at(-1)
      expect(statSync(join(dir, newest)).mode & 0o777).toBe(0o600)
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    }

    // a non-406 leaves no file, and a dump failure never breaks the 406
    await explained(new Response('{"x":1}', { status: 502 }), JSON.stringify({ model: "m", messages: [{ role: "system", content: "x" }] }), "autoclaw")
    expect(readdirSync(dir)).toHaveLength(12)
    // a directory that cannot be created: the path runs through a regular
    // file (kept outside the dump dir, so the count above stays clean)
    const blocker = join(mkdtempSync(join(tmpdir(), "autoclaw-test-")), "blocker")
    writeFileSync(blocker, "a file, not a directory")
    process.env.AUTOCLAW_406_DUMP_DIR = join(blocker, "beneath")
    const still = await explained(refused406(), JSON.stringify({ model: "m", messages: [{ role: "system", content: "x" }] }), "autoclaw")
    expect(still.status).toBe(406)
    expect(readdirSync(dir)).toHaveLength(12)
  } finally { delete process.env.AUTOCLAW_406_DUMP_DIR }
})

// "dump406": "false" in plugins.json is the option OFF, not on: only a real
// boolean true arms the default directory.
test("the dump406 option takes a boolean, not any truthy value", async () => {
  const fake = mkdtempSync(join(tmpdir(), "autoclaw-dumpopt-"))
  const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE, oldXdg = process.env.XDG_CONFIG_HOME, oldDump = process.env.AUTOCLAW_406_DUMP_DIR
  delete process.env.AUTOCLAW_406_DUMP_DIR
  delete process.env.XDG_CONFIG_HOME
  process.env.HOME = fake
  process.env.USERPROFILE = fake
  const refused406 = () => new Response("{}", { status: 406 })
  const body = JSON.stringify({ model: "m", messages: [{ role: "system", content: "opted" }] })
  try {
    for (const bad of ["false", "true", 1, "yes"]) {
      await explained(refused406(), body, "autoclaw", { dump406: bad })
      expect(existsSync(dumpDefaultDir())).toBe(false)
    }
    await explained(refused406(), body, "autoclaw", { dump406: true })
    expect(readdirSync(dumpDefaultDir())).toHaveLength(1)
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg
    if (oldDump === undefined) delete process.env.AUTOCLAW_406_DUMP_DIR; else process.env.AUTOCLAW_406_DUMP_DIR = oldDump
    rmSync(join(fake, ".config"), { recursive: true, force: true })
  }
})

// Off by default: without the env and without the option, a 406 writes
// nothing anywhere. The dump406 option turns it on at the default directory.
test("a 406 dumps nothing unless the dump is opted into, and the option uses the default dir", async () => {
  const fake = mkdtempSync(join(tmpdir(), "autoclaw-dumpopt-"))
  const oldHome = process.env.HOME, oldProfile = process.env.USERPROFILE, oldXdg = process.env.XDG_CONFIG_HOME, oldDump = process.env.AUTOCLAW_406_DUMP_DIR
  delete process.env.AUTOCLAW_406_DUMP_DIR
  delete process.env.XDG_CONFIG_HOME
  process.env.HOME = fake
  process.env.USERPROFILE = fake
  const refused406 = () => new Response("{}", { status: 406 })
  const body = JSON.stringify({ model: "m", messages: [{ role: "system", content: "opted" }] })
  try {
    expect(existsSync(dumpDefaultDir())).toBe(false)
    const refused = await explained(refused406(), body, "autoclaw")
    expect(refused.status).toBe(406)
    expect(existsSync(dumpDefaultDir())).toBe(false)
    // the option arms the default directory
    await explained(refused406(), body, "autoclaw", { dump406: true })
    expect(readdirSync(dumpDefaultDir())).toHaveLength(1)
    // an empty XDG_CONFIG_HOME is no value: it falls through to HOME
    process.env.XDG_CONFIG_HOME = ""
    process.env.HOME = join(fake, "home2")
    await explained(refused406(), body, "autoclaw", { dump406: true })
    expect(readdirSync(join(process.env.HOME, ".config/magpie/autoclaw-406"))).toHaveLength(1)
    expect(existsSync(join(fake, "magpie/autoclaw-406"))).toBe(false)
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg
    if (oldDump === undefined) delete process.env.AUTOCLAW_406_DUMP_DIR; else process.env.AUTOCLAW_406_DUMP_DIR = oldDump
  }
})

// the wiring, not just the helper: a 406 through either loader dumps the
// rewritten system prompt that loader actually sent
test("a 406 through either loader dumps the rewritten system prompt it sent", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "autoclaw-test-")), "autoclaw-406-wire")
  process.env.AUTOCLAW_406_DUMP_DIR = dir
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: null, message: "406 Not Acceptable", type: "api_error" } }), { status: 406 })
  try {
    const overseas = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } })
    const loader = await overseas.auth.loader(async () => ({ type: "oauth", access: "a1" }))
    const body = JSON.stringify({ model: "zai_glm-5.3-flash", messages: [{ role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude." }, { role: "user", content: "hi" }] })
    expect((await loader.fetch("x", { method: "POST", body })).status).toBe(406)
    let files = readdirSync(dir)
    expect(files).toHaveLength(1)
    let dumped = JSON.parse(readFileSync(join(dir, files[0]), "utf8"))
    expect(dumped.messages[0].content).toContain("You are the Claude Code CLI")
    expect(dumped.messages[0].content).not.toMatch(/You are Claude Code/)
    expect(JSON.stringify(dumped)).not.toContain('"hi"')

    // the CN managed channel dumps its own rewritten system too
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const cn = await AutoclawCnAuthPlugin({ client: { auth: { set: async () => {} } } })
    const cnLoader = await cn.auth.loader(async () => ({ type: "oauth", access: "a1" }))
    const cnBody = JSON.stringify({ model: "zaicoding_glm-5.3", messages: [{ role: "system", content: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }, { role: "user", content: "hi" }] })
    expect((await cnLoader.fetch("x", { method: "POST", body: cnBody })).status).toBe(406)
    files = readdirSync(dir)
    expect(files).toHaveLength(1)
    dumped = JSON.parse(readFileSync(join(dir, files[0]), "utf8"))
    expect(dumped.messages[0].content).toBe(`${OFFICIAL_SYSTEM_PROMPT}\n\nYou are a coding assistant.`)
  } finally {
    globalThis.fetch = realFetch
    delete process.env.AUTOCLAW_406_DUMP_DIR
  }
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

// 11-04: the same Fable line reached the gateway in both system-content
// shapes the 11-03/11-04 captures show — one text part in an array, and a
// plain string — and both answered 406 with it in. Through both loaders the
// line that leaves is the probed 200 form, wherever it sits and whatever
// case it is in.
test("both channels rewrite the model line in a string or a text part, mid-prompt too", async () => {
  const realFetch = globalThis.fetch
  const line = "You are powered by the model glm-5.3-flash[1m]."
  const want = "You are powered by the GLM-5.3-flash model."
  for (const [factory, host] of [
    [makePlugin("autoclaw-cn"), "https://autoglm-acceleration-api.zhipuai.cn"],
    [makePlugin("autoclaw"), "https://autoglm-api.autoglm.ai"],
  ]) {
    const calls = []
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) })
      return Response.json({ ok: true })
    }
    try {
      const hooks = await factory({ client: { auth: { set: async () => {} } } }, {})
      const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "a1" }))
      for (const content of [
        line,
        [{ type: "text", text: line }],
        [{ type: "text", text: "before" }, { type: "text", text: line }],
        `intro\n\n${line}\n\nnext`,
        "you are powered by the model glm-5.3-flash[1m].",
      ]) {
        await loader.fetch("x", { body: JSON.stringify({ model: "zai_glm-5.3-flash", messages: [{ role: "system", content }, { role: "user", content: "hi" }] }) })
        const sys = calls.at(-1).body.messages[0].content
        const text = Array.isArray(sys) ? sys.map((p) => p.text).join("\n") : sys
        expect(text).not.toMatch(/powered by (?!the GLM-[\w.-]+ model\b)/i)
        // the lowercase fixture keeps its own case through the rewrite, and
        // the gateway refuses case-insensitively — compare the wording only
        expect(text.toLowerCase()).toContain(want.toLowerCase())
        expect(text.startsWith("You are AutoClaw. Answer the user directly and concisely.")).toBe(true)
        // the user's own words still go as written
        expect(calls.at(-1).body.messages[1].content).toBe("hi")
      }
    } finally { globalThis.fetch = realFetch }
  }
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
    // 活动流水查询失败/无数据：活动行省略，余额照常
    if (u.includes("ledgers_std")) return Response.json({ code: 500001, msg: "服务异常" })
    return Response.json({ code: 0, data: null })
  }
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-usage-"))
  _internal.setUsageStatePath(join(dir, ".usage-state.json"))
  try {
    const hooks = await AutoclawAuthPlugin({ client: { auth: { set: async () => {} } } })
    const u = await hooks.auth.usage(async () => ({ type: "oauth", access: "a1" }))
    expect(u.balance).toBe("1,234 积分（赠送积分 500 · 会员积分 734）")
    // the prepaid wallet reading (magpie #3950): the balance as told, in its
    // unit, and no share invented - a first read has no spend window yet
    expect(u.windows.filter((w) => w.name !== "每日签到")).toEqual([
      { name: "积分余额", balance: 1234.4, unit: "积分" },
    ])
    expect(u.windows.some((w) => w.name === "活动积分")).toBe(false)
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
    expect(w.display).toBe("3,123 / 20,000 积分 · 今日 -3,123")
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
    expect(result.message).toContain("活动奖励未触发")
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
    expect(threw.message).toContain("无响应")
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


// ── 活动积分（0.2.16）──────────────────────────────────────────────────

// 真实流水条目形状（2026-11-06 真机抓包）。metadata 按事件类型有/无；
// expire 带顶层+metadata 的 wallet_scope 但没有 activity_id；debit 同。
const ledEntry = (o = {}) => ({
  id: String(o.id ?? 1),
  asset_type: "point",
  wallet_type: "earned",
  wallet_id: o.wallet ?? "wlt_a1",
  wallet_scope: o.scope ?? "campaign",
  mutation_type: o.type ?? "credit",
  amount: o.amount ?? 4000,
  description: o.desc ?? "AutoClaw Weekly Perks +4000 credits",
  occurred_at: "2026-11-06T01:00:11.16+08:00",
  ...(o.noMeta ? {} : { metadata: o.meta ?? {
    activity_id: o.act ?? "autoclaw_weekly_perks_20261013",
    event_type: "autoclaw_user_active",
    wallet_scope: o.scope ?? "campaign",
    reward_points: String(o.amount ?? 4000),
    grant_date: "2026-11-02",
    period_id: "454",
    wallet_instance_balance_after: "5000",
  } }),
})
const led = (entries, extra = {}) =>
  Response.json({ code: 0, msg: "SUCCESS", data: { entries, next_page_token: "", ...extra } })

// 活动测试统一路由：按 pathname 分支（"wallet_scope" 会撞 includes("wallet")）。
const campFetch = ({ total = 5000, ledger, calls = [], signin = null, complete = null } = {}) => (input, init) => {
  const url = new URL(String(input))
  if (url.pathname.endsWith("/wallets")) {
    return Response.json({ code: 0, data: { total_balance: total, wallets: [] } })
  }
  if (url.pathname === "/agent-assetmgr/api/v1/ledgers_std") {
    calls.push({ url, headers: new Headers(init?.headers) })
    return typeof ledger === "function" ? ledger(url) : led(ledger ?? [])
  }
  if (url.pathname.endsWith("/autoclaw-task-list")) {
    return typeof signin === "function" ? signin() : (signin ?? Response.json({ code: 0, data: [] }))
  }
  if (url.pathname.endsWith("/autoclaw-task-complete")) {
    return typeof complete === "function" ? complete() : (complete ?? signedTask(400, 1))
  }
  return Response.json({ code: 0, data: {} })
}
const campAuth = (tag, extra = {}) => ({
  type: "oauth", access: `at-camp-${tag}`, refresh: claimJwt(`camp-${tag}`),
  accountId: "测试账号", uid: `u-camp-${tag}`, ...extra,
})
const campHooks = async (client = { auth: { set: async () => {} } }) =>
  AutoclawAuthPlugin({ client }, {})

const campCleanup = (realFetch, dir) => {
  globalThis.fetch = realFetch
  _internal.clearCampaignLedger()
  if (dir) rmSync(dir, { recursive: true, force: true })
}

// A+B+C 全量：按实例对账的剩余、已领、过期，以及活动名标签。
test("campaign: the card names live campaign points, claims and expiries (A+B+C)", async () => {
  const realFetch = globalThis.fetch
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-camp-"))
  _internal.setUsageStatePath(join(dir, ".usage-state.json"))
  const calls = []
  globalThis.fetch = campFetch({
    total: 6800,
    calls,
    ledger: [
      ledEntry({ id: 1, wallet: "wlt_live", amount: 4000, desc: "AutoClaw Weekly Perks +4000 credits" }),
      ledEntry({ id: 2, wallet: "wlt_dead", amount: 10000, desc: "New-user credits (Day 1/7) +10000", act: "autoclaw_new_user_day_1_to_7_bonus_new_20260922" }),
      ledEntry({ id: 3, wallet: "wlt_dead", type: "debit", amount: -2289, noMeta: true }),
      ledEntry({ id: 4, wallet: "wlt_dead", type: "expire", amount: -7711, noMeta: true, desc: "活动积分到期失效" }),
    ],
  })
  try {
    const hooks = await campHooks()
    const u = await hooks.auth.usage(async () => campAuth("happy"))
    const row = u.windows.find((w) => w.name === "活动积分")
    expect(row).toBeDefined()
    expect(row.aside).toBe(true)
    expect(row.used).toBe(0)
    expect(row.balance).toBeUndefined()
    // Weekly Perks 实例活着：4000 − 0 − 0；新用户礼实例清零：不进剩余
    expect(row.display).toBe("剩 4,000（AutoClaw Weekly Perks） · 已领 14,000 · 过期 7,711（近期）")
    // 余额行保持干净的总额（绝不被活动标签污染）
    expect(u.balance).toBe("6,800 积分")
    // 请求契约：过滤参数 + 账号令牌 + 无 X-Authorization
    expect(calls.length).toBe(1)
    const q = calls[0].url.searchParams
    expect(q.get("biz_app_id")).toBe("autoclaw")
    expect(q.get("wallet_scope")).toBe("campaign")
    expect(calls[0].headers.get("Authorization")).toBe("Bearer at-camp-happy")
    expect(calls[0].headers.get("X-Channel")).toBe("AutoClaw4") // bizHeaders（同 fetchWallets）
    expect(calls[0].headers.get("X-Authorization")).toBeNull()
  } finally {
    campCleanup(realFetch, typeof dir !== "undefined" ? dir : undefined)
  }
})

// 服务端忽略过滤参数时（返回了 annual 条目），客户端必须再过滤。
test("campaign: a server that ignores wallet_scope is re-filtered client-side", async () => {
  const realFetch = globalThis.fetch
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-camp-"))
  _internal.setUsageStatePath(join(dir, ".usage-state.json"))
  globalThis.fetch = campFetch({
    total: 4000,
    ledger: [
      ledEntry({ id: 1, wallet: "wlt_c", amount: 4000, scope: "campaign" }),
      ledEntry({ id: 2, wallet: "wlt_d", amount: 400, scope: "annual", desc: "每日签到" }),
      ledEntry({ id: 3, wallet: "wlt_d", type: "debit", amount: -45, scope: "annual", noMeta: true }),
    ],
  })
  try {
    const hooks = await campHooks()
    const u = await hooks.auth.usage(async () => campAuth("refilter"))
    const row = u.windows.find((w) => w.name === "活动积分")
    expect(row.display).toBe("剩 4,000（AutoClaw Weekly Perks） · 已领 4,000 · 过期 0（近期）")
  } finally {
    campCleanup(realFetch, typeof dir !== "undefined" ? dir : undefined)
  }
})

// 没有活动历史（entries 空 / 全是别的 scope / 读取失败）→ 整行省略。
test("campaign: no campaign history or a failed read omits the row, never breaks the card", async () => {
  const realFetch = globalThis.fetch
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-camp-"))
  _internal.setUsageStatePath(join(dir, ".usage-state.json"))
  globalThis.fetch = campFetch({ total: 1000, ledger: [] })
  try {
    const hooks = await campHooks()
    const u1 = await hooks.auth.usage(async () => campAuth("empty"))
    expect(u1.windows.some((w) => w.name === "活动积分")).toBe(false)
    expect(u1.balance).toBe("1,000 积分")
    expect(u1.error).toBeUndefined()
    _internal.clearCampaignLedger()
    // 流水接口整体 500：余额照常
    globalThis.fetch = campFetch({ total: 1000, ledger: () => new Response("boom", { status: 500 }) })
    const u2 = await hooks.auth.usage(async () => campAuth("empty"))
    expect(u2.balance).toBe("1,000 积分")
    expect(u2.windows.some((w) => w.name === "活动积分")).toBe(false)
  } finally {
    campCleanup(realFetch, typeof dir !== "undefined" ? dir : undefined)
  }
})

// TTL 缓存：10 分钟内第二次 usage() 不再打流水；两个账号各查各的。
test("campaign: the ledger read is cached per account for 10 minutes", async () => {
  const realFetch = globalThis.fetch
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-camp-"))
  _internal.setUsageStatePath(join(dir, ".usage-state.json"))
  const calls = []
  globalThis.fetch = campFetch({
    total: 4000,
    calls,
    ledger: [ledEntry({ id: 1, wallet: "wlt_c", amount: 4000 })],
  })
  try {
    const hooks = await campHooks()
    const a = campAuth("cache-a")
    const b = campAuth("cache-b")
    await hooks.auth.usage(async () => a)
    await hooks.auth.usage(async () => a)
    await hooks.auth.usage(async () => b)
    const ledgerCalls = calls.filter((c) => c.url.pathname === "/agent-assetmgr/api/v1/ledgers_std").length
    expect(ledgerCalls).toBe(2) // a 一次 + b 一次
  } finally {
    campCleanup(realFetch, typeof dir !== "undefined" ? dir : undefined)
  }
})

// checkin 里 user-info 成功（活动可能刚到账）→ 缓存立即失效。
test("campaign: a checkin whose user-info reached the server invalidates the cache", async () => {
  const realFetch = globalThis.fetch
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-camp-"))
  _internal.setUsageStatePath(join(dir, ".usage-state.json"))
  const calls = []
  globalThis.fetch = campFetch({
    total: 4000,
    calls,
    signin: () => pendingTask(),
    ledger: [ledEntry({ id: 1, wallet: "wlt_c", amount: 4000 })],
  })
  try {
    const hooks = await campHooks()
    const auth = campAuth("invalidate")
    await hooks.auth.usage(async () => auth)
    await hooks.auth.checkin(async () => auth) // user-info code=0 → uiReached
    await hooks.auth.usage(async () => auth)
    const ledgerCalls = calls.filter((c) => c.url.pathname === "/agent-assetmgr/api/v1/ledgers_std").length
    expect(ledgerCalls).toBe(2) // 失效后重新拉取
  } finally {
    campCleanup(realFetch, typeof dir !== "undefined" ? dir : undefined)
  }
})

// 0.2.15 遗留 P0-2：CAS 把「已登出」当「未变」会覆盖用户凭证——现在必须跳过写回。
// 场景：task-list 401 → refresh 轮换 → CAS 复读时发现用户已登出（getAuth 返回 null）。
test("checkin: a logged-out account is never resurrected by the rotation write-back", async () => {
  const realFetch = globalThis.fetch
  const auth = campAuth("cas-logout")
  const sets = []
  globalThis.fetch = campFetch({
    total: 4000,
    ledger: [ledEntry({ id: 1, wallet: "wlt_c", amount: 4000 })],
  })
  const staleFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/userapi/v1/refresh") || url.includes("/agent-refresh")) {
      return Response.json({ code: 0, msg: "SUCCESS", data: { access_token: claimJwt("cas-logout-fresh"), refresh_token: "rt-cas-fresh" } })
    }
    return staleFetch(input)
  }
  try {
    let reads = 0
    const hooks = await campHooks({ auth: { set: async (o) => { sets.push(o); return { data: true } } } })
    const expiredTaskList = () => new Response("{}", { status: 401 })
    const prev = globalThis.fetch
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.includes("autoclaw-task-list")) return expiredTaskList()
      return prev(input)
    }
    let threw
    try { await hooks.auth.checkin(async () => (++reads === 1 ? auth : null)) } catch (e) { threw = e }
    expect(reads).toBeGreaterThanOrEqual(2) // CAS 复读确实发生了
    expect(sets.length).toBe(0) // 绝不复活已登出的记录
    expect(threw?.signIn ?? "none").toBe("none") // 不标 expired（用户已登出是用户的行为）
  } finally {
    campCleanup(realFetch, typeof dir !== "undefined" ? dir : undefined)
  }
})

// 0.2.15 遗留 P0-3：额度用尽的 403 不是登录失效——不烧 RT、不标 expired。
test("checkin: a quota-exhausted 403 at task-list keeps the sign-in and never refreshes", async () => {
  const realFetch = globalThis.fetch
  let refreshes = 0
  globalThis.fetch = campFetch({
    total: 4000,
    ledger: [ledEntry({ id: 1, wallet: "wlt_c", amount: 4000 })],
  })
  const staleFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("autoclaw-task-list")) {
      return new Response(String.raw`{"code":810000,"message":"GLM-5.3 免费额度已用完,请购买充值"}`, { status: 403 })
    }
    if (url.includes("/userapi/v1/refresh") || url.includes("/agent-refresh")) refreshes++
    return staleFetch(input)
  }
  try {
    const hooks = await campHooks()
    let threw
    try { await hooks.auth.checkin(async () => campAuth("quota403")) } catch (e) { threw = e }
    expect(threw).toBeInstanceOf(Error)
    expect(threw.message).toContain("额度已用完")
    expect(threw.signIn).toBe("kept") // 登录保留，不是 expired
    expect(refreshes).toBe(0) // 不烧 RT
  } finally {
    campCleanup(realFetch, typeof dir !== "undefined" ? dir : undefined)
  }
})

// 0.2.15 遗留 P0-1：刷新成功后的重试再遇 401，绝不能把健康账号标成 expired。
test("checkin: a second 401 right after a successful renewal degrades to a retryable failure", async () => {
  const realFetch = globalThis.fetch
  const auth = campAuth("reexpired")
  const sets = []
  let oldReads = 0
  let stage = "old"
  globalThis.fetch = campFetch({
    total: 4000,
    ledger: [ledEntry({ id: 1, wallet: "wlt_c", amount: 4000 })],
  })
  const staleFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/userapi/v1/refresh") || url.includes("/agent-refresh")) {
      stage = "new"
      return Response.json({ code: 0, msg: "SUCCESS", data: { access_token: claimJwt("reexpired-fresh"), refresh_token: "rt-reexpired-fresh" } })
    }
    if (url.includes("autoclaw-task-list")) return new Response("{}", { status: 401 }) // 两个阶段都 401
    return staleFetch(input)
  }
  try {
    const hooks = await campHooks({ auth: { set: async (o) => { sets.push(o); return { data: true } } } })
    let threw
    try { await hooks.auth.checkin(async () => (++oldReads <= 2 ? auth : null)) } catch (e) { threw = e }
    expect(threw).toBeInstanceOf(Error)
    expect(threw.signIn).toBeUndefined() // 关键：不能带 expired
    expect(sets.length).toBe(1) // 刷新已写回，账号仍是健康的
  } finally {
    campCleanup(realFetch, typeof dir !== "undefined" ? dir : undefined)
  }
})

// 0.2.15 遗留 P1-4：混合 host 失败必须保住 expired 标记。两种顺序都测：
// ① 401 在前、网络错在后（401 自带标记）；② 网络错在前、401 在后
// （标记只能靠 expiredErr 单独保存——这是它的存在意义）。
test("checkin: a mixed host failure keeps the expired marker and refreshes, in both orders", async () => {
  const realFetch = globalThis.fetch
  for (const order of ["expired-first", "network-first"]) {
    const auth = campAuth(`mixedfail-${order}`)
    let refreshes = 0
    globalThis.fetch = campFetch({ total: 4000, ledger: [ledEntry({ id: 1, wallet: "wlt_c", amount: 4000 })] })
    const staleFetch = globalThis.fetch
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.includes("autoclaw-task-list")) {
        const host = new URL(String(input)).host
        const first = host === "autoglm-api.autoglm.ai"
        const isExpiredTurn = order === "expired-first" ? first : !first
        return isExpiredTurn ? new Response("{}", { status: 401 }) : (() => { throw new Error("ECONNRESET") })()
      }
      if (url.includes("/userapi/v1/refresh") || url.includes("/agent-refresh")) {
        refreshes++
        return Response.json({ code: 0, msg: "SUCCESS", data: { access_token: claimJwt(`mixedfail-${order}-fresh`), refresh_token: `rt-mixedfail-${order}-fresh` } })
      }
      return staleFetch(input)
    }
    try {
      const hooks = await campHooks()
      let threw
      try { await hooks.auth.checkin(async () => auth) } catch (e) { threw = e }
      expect(refreshes).toBe(1) // expired 标记没丢 → 刷新发生了
      expect(threw?.message ?? "").not.toBeUndefined()
    } finally {
      _internal.clearRefreshGates()
      campCleanup(realFetch, typeof dir !== "undefined" ? dir : undefined)
    }
  }
})

// 0.2.15 遗留 P1-5 姐妹案：主 host 空 []、备用 host 有任务 → 必须用备用 host 签上。
test("checkin: an empty task list on host[0] still finds the task on host[1]", async () => {
  const realFetch = globalThis.fetch
  const auth = campAuth("emptyfirst")
  globalThis.fetch = campFetch({ total: 4000, ledger: [ledEntry({ id: 1, wallet: "wlt_c", amount: 4000 })] })
  const staleFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("autoclaw-task-list")) {
      const host = new URL(String(input)).host
      return host === "autoglm-api.autoglm.ai"
        ? Response.json({ code: 0, data: [] })
        : pendingTask()
    }
    if (url.includes("autoclaw-task-complete")) return signedTask(400, 2)
    return staleFetch(input)
  }
  try {
    const hooks = await campHooks()
    const r = await hooks.auth.checkin(async () => auth)
    expect(r.outcome).toBe("claimed")
    expect(r.credit).toBe(400)
  } finally {
    campCleanup(realFetch, typeof dir !== "undefined" ? dir : undefined)
  }
})

// 0.2.15 遗留 P1-6：user-info 失败时 done 路径也要说「活动没触发」。
test("campaign: a done checkin still reports when the login event never reached the server", async () => {
  const realFetch = globalThis.fetch
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-camp-"))
  _internal.setUsageStatePath(join(dir, ".usage-state.json"))
  globalThis.fetch = campFetch({
    total: 4000,
    signin: () => completedTask(),
    ledger: [ledEntry({ id: 1, wallet: "wlt_c", amount: 4000 })],
  })
  const staleFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/userapi/v1/user-info")) return Response.json({ code: 410000, msg: "用户未登录" })
    return staleFetch(input)
  }
  try {
    const hooks = await campHooks()
    const r = await hooks.auth.checkin(async () => campAuth("donenote"))
    expect(r.outcome).toBe("done")
    expect(r.message).toContain("活动奖励未触发")
  } finally {
    campCleanup(realFetch, typeof dir !== "undefined" ? dir : undefined)
  }
})

// 0.2.15 遗留 P1-8：401 带 code:0 的怪响应不算「活动已触发」（假成功）。
test("campaign: a 401 with a zero code is not a reached login event", async () => {
  const realFetch = globalThis.fetch
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-camp-"))
  _internal.setUsageStatePath(join(dir, ".usage-state.json"))
  globalThis.fetch = campFetch({
    total: 4000,
    signin: () => completedTask(),
    ledger: [ledEntry({ id: 1, wallet: "wlt_c", amount: 4000 })],
  })
  const staleFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/userapi/v1/user-info")) return Response.json({ code: 0, msg: "SUCCESS" }, { status: 401 })
    return staleFetch(input)
  }
  try {
    const hooks = await campHooks()
    const r = await hooks.auth.checkin(async () => campAuth("fakeok"))
    expect(r.outcome).toBe("done")
    expect(r.message).toContain("活动奖励未触发") // 假成功被识破：活动其实没触发
  } finally {
    campCleanup(realFetch, dir)
  }
})

// fmtPoints：确定性三位分组（不依赖 locale）。
test("campaign: numbers are grouped in threes, deterministically", () => {
  expect(_internal.fmtPoints(0)).toBe("0")
  expect(_internal.fmtPoints(999)).toBe("999")
  expect(_internal.fmtPoints(1000)).toBe("1,000")
  expect(_internal.fmtPoints(14000)).toBe("14,000")
  expect(_internal.fmtPoints(1234567)).toBe("1,234,567")
  expect(_internal.fmtPoints(1234.6)).toBe("1,235")
})

// 聚合的数字边界：字符串金额、缺失 metadata、未知 mutation_type。
// mutation_type 大小写不敏感（服务端约定小写，防御性归一后照算）。
test("campaign: the breakdown survives weird entries without miscounting", () => {
  const b = _internal.campaignBreakdown([
    ledEntry({ id: 1, wallet: "w1", amount: "4000" }), // 字符串金额（防御）
    ledEntry({ id: 2, wallet: "w1", type: "debit", amount: -1000, noMeta: true }),
    ledEntry({ id: 3, wallet: "w2", amount: 500, type: "Credit" }), // 大小写归一后照算
    ledEntry({ id: 4, wallet: "w3", type: "refund", amount: -99, noMeta: true }), // 未知类型 → 忽略
    ledEntry({ id: 5, wallet: "w4", type: "expire", amount: -800, noMeta: true, desc: "活动积分到期失效" }),
    { id: "6", mutation_type: "credit", amount: "not-a-number", wallet_id: "w5", metadata: { wallet_scope: "campaign" } }, // 非数字 → 忽略
    null,
    "junk",
  ])
  expect(b.claimed).toBe(4500)
  expect(b.expired).toBe(800)
  expect(b.remaining).toBe(3500) // w1: 4000−1000 = 3000；w2: 500 → 3500
  expect(b.labels).toEqual(["AutoClaw Weekly Perks"])
})


// ── yetone #774 review：作者亲测「改坏也不红」的缺件 ──────────────────────────

// review 1+2：auth.refresh 带 signinOnUsage 时，task-complete 的 403-quota
// 必须照常返回轮换后的令牌，绝不抛 signIn:expired（旧链路 maybeSignin 会把
// 403 标成登录失效，magpie 的 renewLocked 读到就登出账号、新令牌丢失）。
test("review#1: auth.refresh with signinOnUsage and a quota 403 at task-complete returns the rotated tokens", async () => {
  const realFetch = globalThis.fetch
  const freshAccess = claimJwt("rev-fresh")
  let refreshes = 0
  globalThis.fetch = (input) => {
    const url = String(input)
    if (url.includes("/refresh") || url.includes("/agent-refresh")) {
      refreshes++
      return Response.json({ code: 0, msg: "SUCCESS", data: { access_token: freshAccess, refresh_token: "rt-rev-fresh" } })
    }
    if (url.includes("/autoclaw-task-complete")) {
      return new Response(String.raw`{"code":810000,"message":"GLM-5.3 免费额度已用完"}`, { status: 403 })
    }
    return Response.json({ code: 0, data: {} })
  }
  try {
    const hooks = await AutoclawAuthPlugin(
      { client: { auth: { set: async () => ({ data: true }) } } },
      { signin: true, signinOnUsage: true },
    )
    const auth = claimAuth("rev-quota", { access: "at-rev-quota" })
    const t = await hooks.auth.refresh(auth)
    expect(t.refresh).toBe("rt-rev-fresh")
    expect(t.access).toBe(freshAccess)
    expect(refreshes).toBe(1)
  } finally {
    _internal.clearRefreshGates()
    _internal.clearRotatedMemo()
    globalThis.fetch = realFetch
  }
})

// 同一链路走 usage()：403-quota 不能把整张卡变成「积分查询失败」。
test("review#1: usage() with signinOnUsage and a quota 403 at task-complete still shows the balance", async () => {
  const realFetch = globalThis.fetch
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-rev-"))
  _internal.setUsageStatePath(join(dir, ".usage-state.json"))
  globalThis.fetch = (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/wallets")) return Response.json({ code: 0, data: { total_balance: 4000, wallets: [] } })
    if (url.pathname.endsWith("/autoclaw-task-list")) return Response.json({ code: 0, data: [{ task_id: "daily_signin", status: "pending", reward_points: 400 }] })
    if (url.pathname.endsWith("/autoclaw-task-complete")) {
      return new Response(String.raw`{"code":810000,"message":"GLM-5.3 免费额度已用完"}`, { status: 403 })
    }
    if (url.pathname === "/agent-assetmgr/api/v1/ledgers_std") return led([])
    return Response.json({ code: 0, data: {} })
  }
  try {
    const hooks = await AutoclawAuthPlugin(
      { client: { auth: { set: async () => ({ data: true }) } } },
      { signin: true, signinOnUsage: true },
    )
    const u = await hooks.auth.usage(async () => claimAuth("rev-usage", { access: "at-rev-usage" }))
    expect(u.error).toBeUndefined()
    expect(u.windows.some((w) => w.name === "积分余额")).toBe(true)
  } finally {
    _internal.clearCampaignLedger()
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

// review 4a：Windows 上 HOME 常未设，配置目录必须落到用户目录，不能是盘根
// （旧实现 `${HOME ?? ""}/.config/magpie` → C:\.config\magpie，任意本地用户可写）。
test("review#4: the magpie config dir falls back to USERPROFILE/homedir when HOME is unset", () => {
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, USERPROFILE: process.env.USERPROFILE }
  try {
    delete process.env.HOME
    delete process.env.XDG_CONFIG_HOME
    process.env.USERPROFILE = "C:\\Users\\Someone"
    const p = _internal.magpieCfgDir()
    expect(p).toBe("C:\\Users\\Someone/.config/magpie")
    expect(p).not.toBe("/.config/magpie")
    expect(p).not.toContain("C:\\.config")
    // USERPROFILE 也没有 → os.homedir()
    delete process.env.USERPROFILE
    const h = _internal.magpieCfgDir()
    expect(h.endsWith("/.config/magpie")).toBe(true)
    expect(h).not.toBe("/.config/magpie")
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
})

// review 4b：内存兜底里的 access token 过期后，绝不能继续喂给调用方——
// 必须拿兜底里的新 RT 走一次真刷新。
test("review#4: an expired rotated-memo entry is dropped and refreshed over the wire", async () => {
  const realFetch = globalThis.fetch
  const freshAccess = claimJwt("memo-fresh")
  const bodies = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.includes("/refresh") || url.includes("/agent-refresh")) {
      bodies.push(JSON.parse(String(init?.body ?? "{}")))
      return Response.json({ code: 0, msg: "SUCCESS", data: { access_token: freshAccess, refresh_token: "rt-memo-next" } })
    }
    return Response.json({ code: 0, data: {} })
  }
  try {
    _internal.clearRefreshGates()
    _internal.clearRotatedMemo()
    // 已花费的 RT → 一对令牌，但其中的 access 已经过期
    _internal.rememberRotated("rt-memo-spent", { access: claimJwt("memo-stale"), refresh: "rt-memo-live", expires: Date.now() - 1_000 })
    const t = await _internal.refreshShared("rt-memo-spent", [])
    expect(t.access).toBe(freshAccess)
    // 真的走了网络，而且用的是兜底里的新 RT（不是已花费的旧 RT）
    expect(bodies.length).toBe(1)
    expect(bodies[0].refresh_token).toBe("rt-memo-live")
    // 对照：未过期的兜底直接命中内存，不再打网络
    _internal.rememberRotated("rt-memo-spent-2", { access: claimJwt("memo-live"), refresh: "rt-memo-live-2", expires: Date.now() + 60_000 })
    const before = bodies.length
    const t2 = await _internal.refreshShared("rt-memo-spent-2", [])
    expect(bodies.length).toBe(before)
    expect(t2.refresh).toBe("rt-memo-live-2")
  } finally {
    _internal.clearRefreshGates()
    _internal.clearRotatedMemo()
    globalThis.fetch = realFetch
  }
})

// review 4c：refreshTokens 在首个 host 网络错误时必须继续试下一个 host
// （旧实现第一个 host 断连就整体中止，账号永远续不上期）。
test("review#4: a network failure on the first refresh host falls through to the next", async () => {
  const realFetch = globalThis.fetch
  const freshAccess = claimJwt("host-fb-fresh")
  const hosts = []
  globalThis.fetch = async (input) => {
    const u = new URL(String(input))
    hosts.push(u.host)
    if (u.host === "autoglm-api.autoglm.ai") throw new Error("ECONNRESET")
    return Response.json({ code: 0, msg: "SUCCESS", data: { access_token: freshAccess, refresh_token: "rt-host-fb" } })
  }
  try {
    _internal.clearRefreshGates()
    const rt = claimJwt("host-fb") // 非短信账号：GLOBAL 在前、CN 在后
    const t = await _internal.refreshTokens(rt, [])
    expect(hosts).toEqual(["autoglm-api.autoglm.ai", "autoglm-api.zhipuai.cn"])
    expect(t.access).toBe(freshAccess)
    expect(t.refresh).toBe("rt-host-fb")
  } finally {
    _internal.clearRefreshGates()
    globalThis.fetch = realFetch
  }
})

// review 4d：task-complete 的 403（额度用尽）在 checkin 里必须落成 failed、
// 不抛、不烧 RT——登录保留（dailySignin 不再把 HTTP 状态变成 signIn:expired）。
test("review#2: a 403 at task-complete ends the day as failed, keeps the sign-in and never refreshes", async () => {
  const realFetch = globalThis.fetch
  let refreshes = 0
  globalThis.fetch = campFetch({
    total: 4000,
    signin: () => pendingTask(),
    complete: () => new Response(String.raw`{"code":810000,"message":"GLM-5.3 免费额度已用完,请购买充值"}`, { status: 403 }),
    ledger: [ledEntry({ id: 1, wallet: "wlt_c", amount: 4000 })],
  })
  const staleFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/refresh") || url.includes("/agent-refresh")) refreshes++
    return staleFetch(input)
  }
  try {
    const hooks = await campHooks()
    let threw
    let result
    try { result = await hooks.auth.checkin(async () => campAuth("keep403")) } catch (e) { threw = e }
    expect(threw).toBeUndefined()
    expect(result.outcome).toBe("failed")
    expect(result.signIn).toBeUndefined()
    expect(refreshes).toBe(0)
  } finally {
    campCleanup(realFetch)
  }
})

// review 5：campaignCached 的注释说「失败不缓存」，实现也必须如此——
// 一次瞬时失败不能让活动行消失 10 分钟。
test("review#5: a ledger read failure is not cached — the next usage() retries the wire", async () => {
  const realFetch = globalThis.fetch
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-rev2-"))
  _internal.setUsageStatePath(join(dir, ".usage-state.json"))
  let calls = 0
  globalThis.fetch = campFetch({ total: 4000, ledger: () => { calls++; return new Response("boom", { status: 500 }) } })
  try {
    const hooks = await campHooks()
    const auth = campAuth("rev-retry")
    const u1 = await hooks.auth.usage(async () => auth)
    expect(u1.balance).toBe("4,000 积分")
    expect(u1.windows.some((w) => w.name === "活动积分")).toBe(false) // 第一次读失败 → 省略活动行
    expect(calls).toBe(2) // 两个 host 都试过，都失败
    const u2 = await hooks.auth.usage(async () => auth)
    expect(calls).toBe(4) // 失败未被缓存：第二次又重新打了两个 host
    expect(u2.error).toBeUndefined()
    expect(u2.balance).toBe("4,000 积分")
  } finally {
    campCleanup(realFetch, dir)
  }
})


// ── 代理审查修复（0.2.16 第三轮）：memo 全路径、缓存复活、note 追加 ──────────

// P1：refreshShared 成功即记 memo——auth.refresh 路径轮换后，>60s（gate 已清）
// 还持有旧 RT 的第二条记录必须拿到兜底令牌，而不是拿死 RT 打网络被判 expired。
test("agent: a stale RT holder gets the memo'd pair after the gate is swept", async () => {
  const realFetch = globalThis.fetch
  let rotations = 0
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/refresh") || url.includes("/agent-refresh")) {
      rotations++
      return Response.json({ code: 0, msg: "SUCCESS", data: { access_token: claimJwt(`memo-all-${rotations}`), refresh_token: `rt-all-${rotations}` } })
    }
    return Response.json({ code: 0, data: {} })
  }
  try {
    _internal.clearRefreshGates()
    _internal.clearRotatedMemo()
    const t1 = await _internal.refreshShared("rt-spent-0", [])
    expect(t1.refresh).toBe("rt-all-1")
    // 模拟 60 秒后 gate 被清理（不真等：直接清 gates，memo 保留）
    _internal.clearRefreshGates()
    // 另一条记录拿着同一个已花费的旧 RT 续期 → 命中 memo，零额外网络
    const t2 = await _internal.refreshShared("rt-spent-0", [])
    expect(t2.refresh).toBe("rt-all-1")
    expect(rotations).toBe(1)
  } finally {
    _internal.clearRefreshGates()
    _internal.clearRotatedMemo()
    globalThis.fetch = realFetch
  }
})

// P2：campaignCached 的在途读迟于失效返回时不得写回——checkin 刚删的缓存
// 不能被旧读复活（刚领的奖励要立即可见）。
test("agent: an in-flight ledger read that lands after invalidation is not re-cached", async () => {
  _internal.clearCampaignLedger()
  let release
  const pending = new Promise((r) => { release = r })
  const key = "agent|uid:resurrect"
  let loads = 0
  const slow = () => { loads++; return pending.then(() => ["old-entry"]) }
  const p = pendingRead(key, slow)
  // 在途期间：失效（checkin 里 user-info 到达时的行为）
  _internal.clearCampaignLedger()
  release()
  expect(await p).toEqual(["old-entry"]) // 在途的调用方照常拿到它要的数据
  // 缓存必须仍是空：下一次走 loader，而不是读被复活的旧条目
  const fresh = await pendingRead(key, () => Promise.resolve(["new-entry"]))
  expect(fresh).toEqual(["new-entry"])
  expect(loads).toBe(1) // 只有第一次真正加载；第二次用的是新 loader（说明没缓存旧值）
})
// 直接驱动 campaignCached（不经过 usage，避免多路径干扰）
function pendingRead(key, loader) {
  return _internal.campaignCached(key, loader)
}

// note 追加而非覆盖：签到成功消息必须保留，活动提示只接在后面。
test("agent: a claimed checkin keeps its own message and appends the campaign note", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = campFetch({
    total: 4000,
    signin: () => pendingTask(),
    complete: () => signedTask(400, 3),
  })
  const staleFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    // user-info 完全失败：登录事件没到服务端
    if (url.includes("/userapi/v1/user-info")) throw new Error("ECONNRESET")
    return staleFetch(input)
  }
  try {
    const hooks = await campHooks()
    const r = await hooks.auth.checkin(async () => campAuth("appendnote"))
    expect(r.outcome).toBe("claimed")
    expect(r.credit).toBe(400)
    // 两段都在：真实签到结果 + 活动提示（顺序固定）
    expect(r.message).toContain("已签到")
    expect(r.message).toContain("活动奖励未触发")
    expect(r.message.indexOf("已签到")).toBeLessThan(r.message.indexOf("活动奖励未触发"))
  } finally {
    campCleanup(realFetch)
  }
})

// 失败路径同样保留原因（不能被活动提示吞掉）。
test("agent: a failed checkin keeps its failure reason when the login event missed", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = campFetch({
    total: 4000,
    signin: () => pendingTask(),
    complete: () => new Response("boom", { status: 500 }),
  })
  const staleFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/userapi/v1/user-info")) throw new Error("ECONNRESET")
    return staleFetch(input)
  }
  try {
    const hooks = await campHooks()
    const r = await hooks.auth.checkin(async () => campAuth("appendfail"))
    expect(r.outcome).toBe("failed")
    expect(r.message).toContain("签到接口无响应") // 真实原因保留
    expect(r.message).toContain("活动奖励未触发")
  } finally {
    campCleanup(realFetch)
  }
})

// A2：md5Hex 已知向量——防止签名算法被换掉而测试仍绿（自证陷阱）。
test("agent: the request signature is real MD5, pinned by a known vector", () => {
  expect(_internal.md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72")
  expect(_internal.md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e")
  expect(_internal.md5Hex("100003&1700000000&38d2391985e2369a5fb8227d8e6cd5e5")).toHaveLength(32)
})

// A5：北京日界（UTC+8）——16:00Z 之后已经是北京的第二天。
test("agent: the signin day boundary is Beijing time, not UTC", () => {
  expect(_internal.beijingDayOf(new Date("2026-11-06T15:30:00Z"))).toBe("2026-11-06") // 北京 23:30
  expect(_internal.beijingDayOf(new Date("2026-11-06T16:30:00Z"))).toBe("2026-11-07") // 北京次日 00:30
  expect(_internal.beijingDayOf(new Date("2026-11-06T00:30:00Z"))).toBe("2026-11-06") // 北京 08:30
})

// C2：signinOnUsage 默认关——usage() 看到未签任务也绝不能自动签。
test("agent: usage() never signs in when signinOnUsage is off (the default)", async () => {
  const realFetch = globalThis.fetch
  const dir = mkdtempSync(join(tmpdir(), "autoclaw-ag2-"))
  _internal.setUsageStatePath(join(dir, ".usage-state.json"))
  const completes = []
  globalThis.fetch = campFetch({
    total: 5000,
    ledger: [],
    signin: () => pendingTask(),
    complete: () => { completes.push(1); return signedTask(400, 1) },
  })
  try {
    const hooks = await campHooks() // 默认 options
    const u = await hooks.auth.usage(async () => campAuth("defaultoff"))
    expect(completes.length).toBe(0) // 没打 task-complete
    expect(u.windows.find((w) => w.name === "每日签到")?.display).toBe("今日未签（+400）")
  } finally {
    campCleanup(realFetch, dir)
  }
})

// C12：maybeSignin 同日去重（北京日），且第二次调用不再打网络。
test("agent: maybeSignin signs once per Beijing day per account", async () => {
  const realFetch = globalThis.fetch
  let signs = 0
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/autoclaw-task-complete")) {
      signs++
      return Response.json({ code: 0, data: { success: true, reward_points: 400, continuous_days: 1 } })
    }
    return Response.json({ code: 0, data: {} })
  }
  try {
    const opts = { signin: true, signinOnUsage: true }
    const key = `agent-dedupe-${Date.now()}`
    await _internal.maybeSignin("at-x", "https://autoglm-api.autoglm.ai", opts, "usage", key)
    await _internal.maybeSignin("at-x", "https://autoglm-api.autoglm.ai", opts, "usage", key)
    expect(signs).toBe(1)
  } finally {
    globalThis.fetch = realFetch
  }
})


// ── maintainer 第三轮 review（4 项）：日界测试、淘汰语义 ────────────────────

// 北京日界在 maybeSignin 里的使用（他亲手把 beijingDayOf() 改成 UTC 日后 90 测试
// 仍全绿）。用 bun 的 setSystemTime 停在「两套日界结论不同」的时刻，双向验证：
// ① 同一北京日、跨 UTC 日 → 绝不重签（UTC 版会签两次）；② 同一 UTC 日、
// 跨北京日 → 必须重签（UTC 版会断签）。
// 恢复必须用无参的 setSystemTime()：带参调用（含 setSystemTime(Date.now())）
// 只是把时钟冻结在另一个常量上，不会交还真实时间（review #4 实测，
// qoder 的 checkin 测试的 afterEach 也是这么做的）。
test("maintainer: maybeSignin dedupes by the Beijing day, in both directions", async () => {
  const realFetch = globalThis.fetch
  let signs = 0
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/autoclaw-task-complete")) {
      signs++
      return Response.json({ code: 0, data: { success: true, reward_points: 400, continuous_days: 1 } })
    }
    return Response.json({ code: 0, data: {} })
  }
  const opts = { signin: true, signinOnUsage: true }
  const host = "https://autoglm-api.autoglm.ai"
  const key = "bj-day"
  try {
    // 起点：北京 11-07 07:30（UTC 11-06 23:30）——UTC 日 11-06、北京日 11-07
    setSystemTime(new Date("2026-11-06T23:30:00Z"))
    await _internal.maybeSignin("at-bj", host, opts, "usage", key)
    expect(signs).toBe(1)
    // +1h：北京 11-07 08:30（UTC 11-07 00:30）——UTC 日翻了、北京日没翻 → 不重签
    setSystemTime(new Date("2026-11-07T00:30:00Z"))
    await _internal.maybeSignin("at-bj", host, opts, "usage", key)
    expect(signs).toBe(1)
    // +24h：北京 11-08 07:30（UTC 11-07 23:30）——北京日翻了、UTC 日没翻 → 必须重签
    setSystemTime(new Date("2026-11-07T23:30:00Z"))
    await _internal.maybeSignin("at-bj", host, opts, "usage", key)
    expect(signs).toBe(2)
  } finally {
    setSystemTime() // 无参 = 交还真实时钟（带参会冻结，见上）
    globalThis.fetch = realFetch
  }
})

// 淘汰只动「已定」条目：在途读被撕掉的话，它的结果无处写回（白打一次网络）。
// 100 个在途读占满缓存 → 插入第 101 条不得撕任何在途读 → 在途读完成后写回生效。
test("maintainer: cache eviction never evicts an in-flight read", async () => {
  _internal.clearCampaignLedger()
  const resolvers = []
  const inFlight = []
  try {
    for (let i = 0; i < 100; i++) {
      inFlight.push(_internal.campaignCached(`if-${i}`, () => new Promise((r) => resolvers.push(() => r([`v${i}`])))))
    }
    const v = await _internal.campaignCached("if-new", () => Promise.resolve(["new"]))
    expect(v).toEqual(["new"])
    // 放行所有在途读，并等它们自己的写成落定（不猜微任务跳数）
    for (const rel of resolvers) rel()
    await Promise.all(inFlight)
    let loads = 0
    const again = await _internal.campaignCached("if-0", () => { loads++; return Promise.resolve(["again"]) })
    expect(again).toEqual(["v0"]) // 读到的是写回的缓存值，不是新加载
    expect(loads).toBe(0)         // 若 if-0 被淘汰，这里会重新加载（loads=1 → 红）
  } finally {
    _internal.clearCampaignLedger()
  }
})

// 上限本身也要守卫（review #4：删掉 while (size >= MAX) 循环这条测试必须红）：
// 100 条已定 + 第 101 条 → 最旧的 cap-0 被挤出（读它要走网络），而新的头部还在。
// 注意 FIFO：读回 cap-0 又是一次插入，会把当时的次旧条目 cap-1 挤掉——
// 所以第二段断言选 cap-2（读 cap-0 时它还在）。
test("maintainer: a settled entry is evicted once the cache passes its cap", async () => {
  _internal.clearCampaignLedger()
  try {
    for (let i = 0; i < 100; i++) await _internal.campaignCached(`cap-${i}`, () => Promise.resolve([`v${i}`]))
    const v = await _internal.campaignCached("cap-new", () => Promise.resolve(["new"]))
    expect(v).toEqual(["new"])
    // cap-0 已被挤出：读它必须重新加载（loads=1）；这次重读又会挤掉下一旧的
    let loads0 = 0
    const first = await _internal.campaignCached("cap-0", () => { loads0++; return Promise.resolve(["v0-again"]) })
    expect(first).toEqual(["v0-again"])
    expect(loads0).toBe(1)
    // 刚插入的 cap-new 是最新条目，仍在缓存（loads=0）——证明淘汰只挤最旧的
    let loadsNew = 0
    const again = await _internal.campaignCached("cap-new", () => { loadsNew++; return Promise.resolve(["nope"]) })
    expect(again).toEqual(["new"])
    expect(loadsNew).toBe(0)
  } finally {
    _internal.clearCampaignLedger()
  }
})

// 进程时钟必须归还：setSystemTime(Date.now) 这类带参调用会把时钟冻在常量上，
// 全仓单进程跑测试时后面所有包基于时钟的等待会死等（CI 曾挂 55 分钟）。
// 守卫：上面的测试恢复后（无参 setSystemTime()），时钟必须照常流逝；
// 若有人改回带参恢复，这里会红。
test("maintainer: the fake clock never leaks into the rest of the suite", async () => {
  const t0 = Date.now()
  await Bun.sleep(60)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(40)
})

// 维护者最终 review 点名的缺口：dailySignin 的「HTTP 非 2xx 一律返回 null」
// 没有专属测试。最险的形状是「HTTP 500 但 body 里写着 success:true」——
// 谁要是把 `if (!res.ok) return null` 删了（或改成先读 body），这条必须红。
test("0.2.18: a 500 with success:true in the body is a failure, not a claimed sign-in", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    String.raw`{"code":0,"data":{"success":true,"reward_points":400}}`,
    { status: 500 },
  )
  try {
    // 直测 dailySignin：非 2xx → null（body 里写什么都一样）
    const r = await _internal.dailySignin("at-x", "https://autoglm-api.autoglm.ai")
    expect(r).toBeNull()
    // 经 checkinOutcome 的完整链路：null → failed，绝不落成 claimed
    expect(_internal.checkinOutcome(r).outcome).toBe("failed")
  } finally {
    globalThis.fetch = realFetch
  }
})

// 同族守卫：403 + success:true 同样必须失败（和维护者举的 500 是同一条 if 守住的）。
test("0.2.18: a 403 with success:true in the body is a failure too", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    String.raw`{"code":0,"data":{"success":true,"reward_points":400}}`,
    { status: 403 },
  )
  try {
    expect(await _internal.dailySignin("at-x", "https://autoglm-api.autoglm.ai")).toBeNull()
  } finally {
    globalThis.fetch = realFetch
  }
})

// 经 checkin 的端到端：task-list 正常返回任务，task-complete 回 500+success:true，
// 当天必须落成 failed（30 分钟后重试），绝不能记成已签。
test("0.2.18: a checkin whose task-complete answers 500 with success:true ends the day as failed", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = campFetch({
    total: 4000,
    ledger: [],
    signin: () => pendingTask(),
    complete: () => new Response(String.raw`{"code":0,"data":{"success":true,"reward_points":400}}`, { status: 500 }),
  })
  try {
    const hooks = await campHooks()
    const r = await hooks.auth.checkin(async () => campAuth("nonok500"))
    expect(r.outcome).toBe("failed")
    expect(r.credit).toBeUndefined()
    expect(r.message).toBe("签到接口无响应")
  } finally {
    campCleanup(realFetch)
  }
})
