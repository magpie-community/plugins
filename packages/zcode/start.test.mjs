// A Start Plan request goes as the plugin zcode.z.ai serves the plan to
// (ARNO's "Freeflow", provider zcode-start) sends it: ZCode's headers, its
// three cached system blocks with the agent's own at the end of the third
// (#343), the day in a
// <system-reminder> turn of its own, one cache mark in the turns, none on
// the tools and the sign-in's device id in metadata.user_id. A GLM Coding
// Plan or team request goes as the agent sent it, but for that device id,
// which ZCode puts on every request (#387). The requests go to a
// local Bun.serve that records them; nothing reaches z.ai or bigmodel.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { arch, homedir, release, tmpdir } from "node:os"
import { basename } from "node:path"
import { realpathSync } from "node:fs"

let ZCodeAuthPlugin, PROMPT, _internal
let server
const got = []
let answer = null // what the fake answers instead, when set
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ ZCodeAuthPlugin, _internal } = await import("./index.mjs"))
  PROMPT = (await import("./prompt.mjs")).default
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      got.push({ method: req.method, path: new URL(req.url).pathname, query: new URL(req.url).search, headers: Object.fromEntries(req.headers), body: await req.text() })
      if (answer) return answer()
      return Response.json({ type: "message", content: [] })
    },
  })
})
afterAll(() => server?.stop(true))

// the plugin's requests to the plans go to the fake; anything else fails
const real = globalThis.fetch
const HOSTS = ["https://zcode.z.ai", "https://api.z.ai", "https://open.bigmodel.cn"]
function routeToFake() {
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const host = HOSTS.find((h) => url.startsWith(h + "/"))
    if (!host) throw new Error("no network in tests: " + url)
    return real(`http://127.0.0.1:${server.port}/${new URL(host).host}${url.slice(host.length)}`, init)
  }
}
afterEach(() => {
  globalThis.fetch = real
  got.length = 0
  answer = null
})

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16)
const jwt = ["{}", JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
const DEVICE = "11111111-2222-4333-8444-555555555555"
const start = (site) => {
  const s = { site, device: DEVICE, jwt, plan: "Start Plan" }
  return { type: "oauth", access: jwt, refresh: JSON.stringify(s), expires: 0 }
}

// send makes a request as @ai-sdk/anthropic does, to the URL it was made for
// place is what magpie tells the fetch of where the agent works, as its
// headers: {dir, git}
async function send(auth, body, { url = "https://api.z.ai/api/anthropic/v1/messages", asRequest = false, place = {}, extra = {}, requests = 1 } = {}) {
  routeToFake()
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => auth, { id: "zcode" })
  const headers = { "content-type": "application/json", "x-api-key": "zcode", "anthropic-version": "2023-06-01", "user-agent": "ai-sdk/anthropic/3.0.81", ...extra }
  if (place.dir !== undefined) headers["x-magpie-work-dir"] = place.dir
  if (place.git !== undefined) headers["x-magpie-work-git"] = place.git
  const res = asRequest
    ? await opts.fetch(new Request(url, { method: "POST", headers, body }))
    : await opts.fetch(url, { method: "POST", headers, body })
  expect(res.status).toBe(200)
  expect(got.length).toBe(requests)
  const messages = got.filter((r) => r.path.endsWith("/messages"))
  expect(messages.length).toBe(1)
  return messages[0]
}

// what the HTTP client adds on its own, whatever the plugin sets
const TRANSPORT = new Set(["host", "connection", "accept", "accept-encoding", "content-length"])
const own = (headers) => Object.fromEntries(Object.entries(headers).filter(([k]) => !TRANSPORT.has(k)))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const osVersion = `${process.platform} ${release()} ${arch()}`
const day = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})()
// the environment section: the agent's folder and git repository only as
// magpie told them (where), never the plugin's own process.cwd() (#86)
const environment = (powered, where = []) =>
  [
    "# Environment",
    "You have been invoked in the following environment:",
    ...where,
    "- Platform: " + process.platform,
    "- OS Version: " + osVersion,
    ...(powered ? [`- You are powered by the model named ${powered}.`] : []),
  ].join("\n")
const eph = { type: "ephemeral" }
// zcodeSystem is ZCode's three blocks, the agent's own system texts (own)
// joined to the end of the third
const zcodeSystem = (powered, where, own = []) => [
  { type: "text", text: PROMPT.cliPrefix, cache_control: eph },
  { type: "text", text: PROMPT.stableSections.join("\n\n"), cache_control: eph },
  { type: "text", text: "\n\n" + [PROMPT.beforeEnvironment, environment(powered, where), PROMPT.afterEnvironment, ...own].join("\n\n"), cache_control: eph },
]
const reminder = {
  role: "user",
  content: [
    {
      type: "text",
      text:
        "<system-reminder>As you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is " +
        day +
        ".\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.</system-reminder>",
    },
  ],
}
// the device, and the conversation as x-session-id names it; the agent named none
const userID = () => JSON.stringify({ device_id: DEVICE, account_uuid: "", session_id: _internal.sessionOf("", DEVICE) })

// a request as OpenCode's @ai-sdk/anthropic makes one, cache marks and all
const agentBody = {
  model: "GLM-5.3-Flash",
  max_tokens: 32000,
  thinking: { type: "enabled", budget_tokens: 16000 },
  system: [
    { type: "text", text: "You are opencode, an agent.", cache_control: eph },
    { type: "text", text: "" },
    { type: "text", text: "Project instructions.", cache_control: eph },
  ],
  messages: [
    { role: "user", content: [{ type: "text", text: "hi", cache_control: eph }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }, { type: "tool_use", id: "t1", name: "read", input: { path: "a" }, cache_control: eph }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }, { type: "text", text: "and now?" }] },
  ],
  tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" }, cache_control: eph }],
  metadata: { other: "kept" },
  stream: true,
}

const AGENT_OWN = ["You are opencode, an agent.", "Project instructions."]

// #343 (fordlyn): zcode.z.ai answers a Start Plan request whose system has
// a fourth block with 405 {"code":3012,"msg":"request has been blocked due
// to unusual activity."}, and every agent sends a system prompt. ZCode's
// ContextBuilder joins every dynamic system section into its third block
// and never sends more than three, so the agent's text goes there too.
test("a Start Plan request's system is ZCode's three blocks, the agent's text at the end of the third (#343)", async () => {
  const cases = [
    ["x", ["x"]],
    [[{ type: "text", text: "x", cache_control: eph }], ["x"]],
    [[{ type: "text", text: "a" }, { type: "text", text: "" }, { type: "text", text: "  " }, { type: "text", text: "b", cache_control: eph }], ["a", "b"]],
    ["s".repeat(32 * 1024), ["s".repeat(32 * 1024)]],
  ]
  for (const [system, own] of cases) {
    got.length = 0
    const r = await send(start("zai"), JSON.stringify({ model: "GLM-5.3", max_tokens: 8, system, messages: [{ role: "user", content: "hi" }] }))
    const b = JSON.parse(r.body)
    expect(b.system.length).toBe(3)
    expect(b.system).toEqual(zcodeSystem("zai-api/GLM-5.3", undefined, own))
    // the first two are ZCode's byte for byte; the third ends with the agent's
    expect(sha(b.system[0].text)).toBe("46dd360a22c87a92")
    expect(sha(b.system[1].text)).toBe("49bda31511fc9670")
    expect(b.system[2].text.endsWith(PROMPT.afterEnvironment + "\n\n" + own.join("\n\n"))).toBe(true)
  }
  // with no system of the agent's, the third block ends where ZCode's does
  got.length = 0
  const r = await send(start("zai"), JSON.stringify({ model: "GLM-5.3", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }))
  expect(JSON.parse(r.body).system).toEqual(zcodeSystem("zai-api/GLM-5.3"))
})

test("the prompt texts are the plugin's, byte for byte", () => {
  expect(sha(PROMPT.cliPrefix)).toBe("46dd360a22c87a92")
  expect(PROMPT.cliPrefix).toBe("You are ZCode, an interactive coding agent")
  expect(PROMPT.stableSections.length).toBe(2)
  expect(sha(PROMPT.stableSections[0])).toBe("3f21ff9a88a03a76")
  expect(PROMPT.stableSections[0].length).toBe(1211)
  expect(sha(PROMPT.stableSections[1])).toBe("39a1e86c93452c01")
  expect(PROMPT.stableSections[1].length).toBe(1100)
  expect(sha(PROMPT.stableSections.join("\n\n"))).toBe("49bda31511fc9670")
  expect(PROMPT.stableSections.join("\n\n").length).toBe(2313)
  expect(sha(PROMPT.beforeEnvironment)).toBe("bbdc66b399d297ff")
  expect(PROMPT.beforeEnvironment.length).toBe(3065)
  expect(sha(PROMPT.afterEnvironment)).toBe("1732b7f098a925d7")
  expect(PROMPT.afterEnvironment.length).toBe(1915)
})

test("a Start Plan request carries ZCode's headers, and only those", async () => {
  const r = await send(start("zai"), JSON.stringify(agentBody))
  expect(r.path).toBe("/zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages")
  const h = own(r.headers)
  expect(h["x-request-id"]).toMatch(UUID)
  expect(h["x-zcode-trace-id"]).toMatch(UUID)
  expect(h["x-request-id"]).not.toBe(h["x-zcode-trace-id"])
  const o = Intl.DateTimeFormat().resolvedOptions()
  expect(h).toEqual({
    authorization: "Bearer " + jwt,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "http-referer": "https://zcode.z.ai",
    "user-agent": "ZCode/3.16.3 ai-sdk/anthropic/3.0.81",
    "x-zcode-app-version": "3.16.3",
    "x-title": "Z Code@cli",
    "x-release-channel": "production",
    "x-client-language": o.locale,
    "x-client-timezone": o.timeZone,
    "x-zcode-agent": "glm",
    "x-platform": `${process.platform}-${process.arch}`,
    "x-os-category": { darwin: "macos", win32: "windows" }[process.platform] ?? "linux",
    "x-os-version": release(),
    "x-request-id": h["x-request-id"],
    "x-zcode-session-type": "main",
    "x-zcode-trace-id": h["x-zcode-trace-id"],
    "x-zcode-query-source": "main_turn",
    // the conversation, as ZCode names it; the agent told none (#387)
    "x-session-id": _internal.sessionOf("", DEVICE),
  })
  expect(h["x-api-key"]).toBeUndefined()
  expect(h["x-device-mid"]).toBeUndefined()
})

// What Claude Code sends magpie, which magpie's gateway passes on to a
// provider without an account of its own, as a plugin's is: its betas,
// x-app, its SDK's x-stainless-* and ?beta=true. ZCode sends none of it.
const CLAUDE_CODE = {
  "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27",
  "anthropic-dangerous-direct-browser-access": "true",
  "x-app": "cli",
  "x-claude-code-session-id": "0b6f0c55-5e3a-4c55-9d0e-6c7c1f3a2b11",
  "x-stainless-lang": "js",
  "x-stainless-package-version": "0.60.0",
  "x-stainless-os": "MacOS",
  "x-stainless-arch": "arm64",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v24.3.0",
  "x-stainless-retry-count": "0",
  "x-stainless-timeout": "600",
  accept: "application/json, text/event-stream",
  "accept-language": "*",
  "sec-fetch-mode": "cors",
}

test("a Start Plan request from Claude Code goes with ZCode's headers alone, without ?beta=true", async () => {
  for (const asRequest of [false, true]) {
    got.length = 0
    const r = await send(start("zai"), JSON.stringify(agentBody), { url: "https://api.z.ai/api/anthropic/v1/messages?beta=true", asRequest, extra: CLAUDE_CODE })
    expect(r.path).toBe("/zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages")
    expect(r.query).toBe("")
    const h = own(r.headers)
    for (const k of Object.keys(CLAUDE_CODE)) if (!TRANSPORT.has(k)) expect(h[k]).toBeUndefined()
    expect(Object.keys(h).sort()).toEqual(
      ["authorization", "anthropic-version", "content-type", "http-referer", "user-agent", "x-zcode-app-version", "x-title", "x-release-channel", "x-client-language", "x-client-timezone", "x-zcode-agent", "x-platform", "x-os-category", "x-os-version", "x-request-id", "x-zcode-session-type", "x-zcode-trace-id", "x-zcode-query-source", "x-session-id"].sort(),
    )
    expect(r.headers.accept).not.toBe(CLAUDE_CODE.accept)
  }
})

test("a GLM Coding Plan request keeps the agent's query and headers", async () => {
  const r = await send({ type: "api", key: "one.secret", metadata: { site: "zai" } }, JSON.stringify(agentBody), { url: "https://api.z.ai/api/anthropic/v1/messages?beta=true", extra: { "anthropic-beta": "x-1" } })
  expect(r.query).toBe("?beta=true")
  expect(r.headers["anthropic-beta"]).toBe("x-1")
})

test("a Start Plan request's body is dressed as ZCode's", async () => {
  const r = await send(start("zai"), JSON.stringify(agentBody))
  const b = JSON.parse(r.body)
  expect(b).toEqual({
    model: "GLM-5.3-Flash",
    max_tokens: 32000,
    thinking: { type: "enabled", budget_tokens: 16000 },
    system: zcodeSystem("zai-api/GLM-5.3-Flash", undefined, ["You are opencode, an agent.", "Project instructions."]),
    messages: [
      reminder,
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }, { type: "tool_use", id: "t1", name: "read", input: { path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }, { type: "text", text: "and now?", cache_control: eph }] },
    ],
    tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }],
    metadata: { other: "kept", user_id: userID() },
    stream: true,
  })
  // the blocks' texts, by the plugin's hashes
  expect(sha(b.system[0].text)).toBe("46dd360a22c87a92")
  expect(sha(b.system[1].text)).toBe("49bda31511fc9670")
  const dyn = b.system[2].text
  expect(dyn.startsWith("\n\n" + PROMPT.beforeEnvironment + "\n\n# Environment\n")).toBe(true)
  expect(dyn.endsWith("\n\n" + PROMPT.afterEnvironment + "\n\nYou are opencode, an agent.\n\nProject instructions.")).toBe(true)
  expect(sha(dyn.slice(2, 2 + 3065))).toBe("bbdc66b399d297ff")
  expect(b.metadata.user_id).toBe(userID())
  // exactly one cache mark in the turns, and none on the tools
  expect((r.body.match(/cache_control/g) ?? []).length).toBe(4)
})

test("a BigModel sign-in's Start Plan names bigmodel-api; a string turn takes the cache mark", async () => {
  const body = { model: "GLM-5.2", max_tokens: 100, system: "  Be brief.  ", messages: [{ role: "user", content: "hello" }] }
  const r = await send(start("bigmodel"), JSON.stringify(body), { url: "https://open.bigmodel.cn/api/anthropic/v1/messages" })
  expect(r.path).toBe("/zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages")
  expect(JSON.parse(r.body)).toEqual({
    model: "GLM-5.2",
    max_tokens: 100,
    system: zcodeSystem("bigmodel-api/GLM-5.2", undefined, ["  Be brief.  "]),
    messages: [reminder, { role: "user", content: [{ type: "text", text: "hello", cache_control: eph }] }],
    metadata: { user_id: userID() },
  })
})

test("a Start Plan body with no model has no powered-by line; a blank system adds nothing", async () => {
  const r = await send(start("zai"), JSON.stringify({ system: "   ", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }))
  expect(JSON.parse(r.body)).toEqual({
    system: zcodeSystem(""),
    messages: [reminder, { role: "user", content: [{ type: "text", text: "x", cache_control: eph }] }],
    metadata: { user_id: userID() },
  })
})

test("a Start Plan request made as a Request, its body a stream, is dressed too", async () => {
  const r = await send(start("zai"), JSON.stringify(agentBody), { asRequest: true })
  expect(r.headers["x-title"]).toBe("Z Code@cli")
  expect(JSON.parse(r.body).system).toEqual(zcodeSystem("zai-api/GLM-5.3-Flash", undefined, AGENT_OWN))
  expect(Number(r.headers["content-length"])).toBe(Buffer.byteLength(r.body))
})

// #86 (Hipple): the plugin runs in magpie, so its process.cwd() is
// magpie's folder (C:\\Users\\<user>\\.config\\magpie), which the section
// said as the working directory, with "Is a git repository: no" whatever
// the folder, and magpie's shell. The folder and the repository are the
// agent's as magpie tells them, percent-encoded, and go to no vendor;
// what isn't told isn't said.
test("a Start Plan request says the agent's folder as magpie tells it, and no folder when not told (#86)", async () => {
  const dir = "C:\\Users\\me\\My Proj 中文 & <x>"
  let r = await send(start("zai"), JSON.stringify(agentBody), { place: { dir: encodeURIComponent(dir), git: "yes" } })
  expect(JSON.parse(r.body).system).toEqual(
    zcodeSystem("zai-api/GLM-5.3-Flash", ["- Primary working directory: " + dir, "- Is a git repository: yes"], AGENT_OWN),
  )
  expect(r.headers["x-magpie-work-dir"]).toBeUndefined()
  expect(r.headers["x-magpie-work-git"]).toBeUndefined()
  got.length = 0
  r = await send(start("zai"), JSON.stringify(agentBody), { place: { dir: encodeURIComponent("/Users/me/notes"), git: "no" } })
  expect(JSON.parse(r.body).system[2].text).toContain("- Primary working directory: /Users/me/notes\n- Is a git repository: no\n- Platform: ")
  got.length = 0
  // a folder whose repository magpie doesn't know: no git line
  r = await send(start("zai"), JSON.stringify(agentBody), { place: { dir: encodeURIComponent("/srv/x") } })
  expect(JSON.parse(r.body).system[2].text).toContain("- Primary working directory: /srv/x\n- Platform: ")
  got.length = 0
  // nothing told (an older magpie, an agent that says no folder): neither
  // line, and never the plugin's own folder or shell
  r = await send(start("zai"), JSON.stringify(agentBody), { place: { git: "yes" } })
  const text = JSON.parse(r.body).system[2].text
  expect(JSON.parse(r.body).system).toEqual(zcodeSystem("zai-api/GLM-5.3-Flash", undefined, AGENT_OWN))
  expect(text).not.toContain("Primary working directory")
  expect(text).not.toContain("Is a git repository")
  expect(text).not.toContain("- Shell:")
  expect(r.body).not.toContain(JSON.stringify(process.cwd()).slice(1, -1))
  expect(r.headers["x-magpie-work-git"]).toBeUndefined()
})

test("magpie's word on the folder goes to no vendor on a Coding Plan request either", async () => {
  sentAsIs(
    await send({ type: "api", key: "one.secret", metadata: { site: "zai" } }, agentText, { place: { dir: "%2Fx", git: "no" } }),
    "one.secret",
    "/api.z.ai/api/anthropic/v1/messages",
    _internal.keyDevice("one.secret"),
  )
})

// the GLM Coding Plan and team seats: as the agent sent it, as 0.1.6 sent
// it, but for metadata.user_id naming the account's device and x-session-id
// the conversation, one UUID in both, as ZCode's client does on every plan
// (#387); the agent named no session, so it is the device's
const agentText = JSON.stringify(agentBody)
const sentAsIs = (r, key, path, device) => {
  expect(r.path).toBe(path)
  const b = JSON.parse(r.body)
  const { "x-session-id": sid, ...h } = own(r.headers)
  expect(sid).toBe(_internal.sessionOf("", device))
  expect(JSON.parse(b.metadata.user_id)).toEqual({ device_id: device, account_uuid: "", session_id: sid })
  delete b.metadata.user_id
  expect(b).toEqual(agentBody)
  expect(h).toEqual({
    authorization: "Bearer " + key,
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "user-agent": "ai-sdk/anthropic/3.0.81",
  })
}

test("a GLM Coding Plan key's request goes as the agent sent it", async () => {
  sentAsIs(await send({ type: "api", key: "one.secret", metadata: { site: "zai" } }, agentText), "one.secret", "/api.z.ai/api/anthropic/v1/messages", _internal.keyDevice("one.secret"))
  got.length = 0
  sentAsIs(await send({ type: "api", key: "two.secret", metadata: { site: "bigmodel" } }, agentText, { url: "https://open.bigmodel.cn/api/anthropic/v1/messages" }), "two.secret", "/open.bigmodel.cn/api/anthropic/v1/messages", _internal.keyDevice("two.secret"))
})

test("a team seat's request goes as the agent sent it, ZCode's token or not", async () => {
  const s = { site: "zai", base: "https://api.z.ai/api/anthropic", key: "seat.secret", token: "tok", org: "o1", project: "p1", jwt, device: DEVICE }
  const auth = { type: "oauth", access: s.key, refresh: JSON.stringify(s), expires: 0 }
  sentAsIs(await send(auth, agentText, { requests: 2 }), "seat.secret", "/api.z.ai/api/anthropic/v1/messages", DEVICE)
  expect(got.filter((r) => r.path.endsWith("/billing/balance"))).toHaveLength(1)
  expect(got.filter((r) => r.path.endsWith("/subscription/list"))).toHaveLength(0)
  got.length = 0
  sentAsIs(await send({ ...auth, refresh: JSON.stringify({ ...s, jwt: "" }) }, agentText), "seat.secret", "/api.z.ai/api/anthropic/v1/messages", DEVICE)
  expect(got).toHaveLength(1)
})

// magpie's provider.ZCodeRestrictedHint and provider.BlockedHint, word for word
const START_RESTRICTED = "ZCode's risk control blocked this account for unusual activity (code 3012); it rests, and the group's other providers are used. If the ZCode app fails on this account too, only ZCode support can lift the block"
const START_EDGE = "the provider's network firewall blocked requests from this IP; wait a while, or switch to another network or proxy"

test("the Start Plan's 3012 says ZCode blocked the account, and a block page the network (plugins#348, #425)", async () => {
  const ask = async (auth, url = "https://api.z.ai/api/anthropic/v1/messages") => {
    routeToFake()
    const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
    const opts = await hooks.auth.loader(async () => auth, { id: "zcode" })
    const res = await opts.fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "zcode" }, body: agentText })
    return { status: res.status, text: await res.text(), signIn: res.headers.get("x-magpie-sign-in") }
  }
  // zcode.z.ai's answer as plugins#348 has it, byte for byte: ZCode's
  // words with the code, then what they mean, never a network block
  answer = () => new Response('{ "code": 3012, "msg": "request has been blocked due to unusual activity.", "logid": "202610241036161d8571a39683011267ff" }', { status: 405, headers: { "content-type": "application/json" } })
  let r = await ask(start("zai"))
  expect(r.status).toBe(405)
  expect(JSON.parse(r.text)).toEqual({ type: "error", error: { type: "permission_error", message: "request has been blocked due to unusual activity. (405, code 3012) — " + START_RESTRICTED } })
  expect(r.text).not.toMatch(/network|IP\b|sends it as/)
  expect(r.signIn).toBe("kept")
  // a bare 405 is the same block
  answer = () => new Response("", { status: 405 })
  r = await ask(start("zai"))
  expect(JSON.parse(r.text).error.message).toBe("405 Method Not Allowed — " + START_RESTRICTED)
  // code 3012 under another status: the vendor's own words, then the hint
  answer = () => Response.json({ code: 3012, msg: "method not allowed" }, { status: 403 })
  r = await ask(start("zai"))
  expect(r.status).toBe(403)
  expect(JSON.parse(r.text).error.message).toBe("method not allowed (403, code 3012) — " + START_RESTRICTED)
  // the edge firewall's block page: its status, then the network's hint,
  // and none of the page's words
  answer = () => new Response("<html>Sorry, your request has been blocked due to unusual activity. errors.aliyun.com</html>", { status: 405, headers: { "content-type": "text/html" } })
  r = await ask(start("zai"))
  expect(r.status).toBe(405)
  expect(JSON.parse(r.text)).toEqual({ type: "error", error: { type: "permission_error", message: "405 Method Not Allowed — " + START_EDGE } })
  expect(r.text).not.toMatch(/request has been blocked/)
  // any other refusal of the Start Plan goes on as it came
  answer = () => Response.json({ type: "error", error: { type: "overloaded_error", message: "busy" } }, { status: 529 })
  r = await ask(start("zai"))
  expect(r.status).toBe(529)
  expect(JSON.parse(r.text).error.message).toBe("busy")
  // a GLM Coding Plan's 405 is not the Start Plan's, and says nothing of it
  answer = () => new Response("request has been blocked", { status: 405 })
  r = await ask({ type: "api", key: "one.secret", metadata: { site: "zai" } })
  expect(r.status).toBe(405)
  expect(r.text).toBe("request has been blocked")
})
