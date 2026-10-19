// The check-in mapping is magpie's contract (provider-plugins.md): every
// answer the upstream gives lands on one of its outcomes, and the plugin
// factory registers both providers with every hook check.mjs looks for.
import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
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

// Claude Code 2.1.30x opens its system prompt with the SDK identity line,
// not the CLI one. The CN gateway refuses "Claude Agent SDK" in any case,
// wherever it sits; the bare phrase is matched so "running on" variants and
// later mentions are covered too.
test("Claude Agent SDK's identity line is rewritten", () => {
  const sdk = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
  for (const t of [
    sdk,
    "You are a Claude agent, running on Anthropic's Claude Agent SDK.",
    "Using the Claude Agent SDK is fine.",
  ]) {
    expect(unflagged(t)).not.toMatch(/Claude Agent SDK/i)
  }
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
    expect(sent.headers.get("User-Agent")).toMatch(/^AutoClaw\//)

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
