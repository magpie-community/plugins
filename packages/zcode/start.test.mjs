// A Start Plan request goes as the plugin zcode.z.ai serves the plan to
// (ARNO's "Freeflow", provider zcode-start) sends it: ZCode's headers, its
// three cached system blocks around the agent's own, the day in a
// <system-reminder> turn of its own, one cache mark in the turns, none on
// the tools and the sign-in's device id in metadata.user_id. A GLM Coding
// Plan or team request goes as the agent sent it. The requests go to a
// local Bun.serve that records them; nothing reaches z.ai or bigmodel.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { arch, homedir, release, tmpdir } from "node:os"
import { basename } from "node:path"
import { realpathSync } from "node:fs"

let ZCodeAuthPlugin, PROMPT
let server
const got = []
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ ZCodeAuthPlugin } = await import("./index.mjs"))
  PROMPT = (await import("./prompt.mjs")).default
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      got.push({ method: req.method, path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.text() })
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
})

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16)
const jwt = ["{}", JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
const DEVICE = "11111111-2222-4333-8444-555555555555"
const start = (site) => {
  const s = { site, device: DEVICE, jwt, plan: "Start Plan" }
  return { type: "oauth", access: jwt, refresh: JSON.stringify(s), expires: 0 }
}

// send makes a request as @ai-sdk/anthropic does, to the URL it was made for
async function send(auth, body, { url = "https://api.z.ai/api/anthropic/v1/messages", asRequest = false } = {}) {
  routeToFake()
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => auth, { id: "zcode" })
  const headers = { "content-type": "application/json", "x-api-key": "zcode", "anthropic-version": "2023-06-01", "user-agent": "ai-sdk/anthropic/3.0.81" }
  const res = asRequest
    ? await opts.fetch(new Request(url, { method: "POST", headers, body }))
    : await opts.fetch(url, { method: "POST", headers, body })
  expect(res.status).toBe(200)
  expect(got.length).toBe(1)
  return got[0]
}

// what the HTTP client adds on its own, whatever the plugin sets
const TRANSPORT = new Set(["host", "connection", "accept", "accept-encoding", "content-length"])
const own = (headers) => Object.fromEntries(Object.entries(headers).filter(([k]) => !TRANSPORT.has(k)))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const osVersion = `${process.platform} ${release()} ${arch()}`
const shell = process.env.SHELL || process.env.ComSpec ? basename(process.env.SHELL || process.env.ComSpec) : "unknown"
const day = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})()
const environment = (powered) =>
  [
    "# Environment",
    "You have been invoked in the following environment:",
    "- Primary working directory: " + process.cwd(),
    "- Is a git repository: no",
    "- Platform: " + process.platform,
    "- Shell: " + shell,
    "- OS Version: " + osVersion,
    ...(powered ? [`- You are powered by the model named ${powered}.`] : []),
  ].join("\n")
const eph = { type: "ephemeral" }
const zcodeSystem = (powered) => [
  { type: "text", text: PROMPT.cliPrefix, cache_control: eph },
  { type: "text", text: PROMPT.stableSections.join("\n\n"), cache_control: eph },
  { type: "text", text: "\n\n" + [PROMPT.beforeEnvironment, environment(powered), PROMPT.afterEnvironment].join("\n\n"), cache_control: eph },
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
const userID = JSON.stringify({ device_id: DEVICE, account_uuid: "", session_id: "" })

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
    "user-agent": "ZCode/3.14.3 ai-sdk/anthropic/3.0.81",
    "x-zcode-app-version": "3.14.3",
    "x-title": "Z Code@cli",
    "x-release-channel": "production",
    "x-client-language": o.locale,
    "x-client-timezone": o.timeZone,
    "x-zcode-agent": "glm",
    "x-platform": `${process.platform}-${process.arch}`,
    "x-os-category": { darwin: "macos", win32: "windows" }[process.platform] ?? "linux",
    "x-os-version": osVersion,
    "x-request-id": h["x-request-id"],
    "x-zcode-session-type": "main",
    "x-zcode-trace-id": h["x-zcode-trace-id"],
  })
  expect(h["x-api-key"]).toBeUndefined()
  expect(h["x-device-mid"]).toBeUndefined()
})

test("a Start Plan request's body is dressed as ZCode's", async () => {
  const r = await send(start("zai"), JSON.stringify(agentBody))
  const b = JSON.parse(r.body)
  expect(b).toEqual({
    model: "GLM-5.3-Flash",
    max_tokens: 32000,
    thinking: { type: "enabled", budget_tokens: 16000 },
    system: [
      ...zcodeSystem("zai-api/GLM-5.3-Flash"),
      { type: "text", text: "You are opencode, an agent." },
      { type: "text", text: "Project instructions." },
    ],
    messages: [
      reminder,
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }, { type: "tool_use", id: "t1", name: "read", input: { path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }, { type: "text", text: "and now?", cache_control: eph }] },
    ],
    tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }],
    metadata: { other: "kept", user_id: userID },
    stream: true,
  })
  // the blocks' texts, by the plugin's hashes
  expect(sha(b.system[0].text)).toBe("46dd360a22c87a92")
  expect(sha(b.system[1].text)).toBe("49bda31511fc9670")
  const dyn = b.system[2].text
  expect(dyn.startsWith("\n\n" + PROMPT.beforeEnvironment + "\n\n# Environment\n")).toBe(true)
  expect(dyn.endsWith("\n\n" + PROMPT.afterEnvironment)).toBe(true)
  expect(sha(dyn.slice(2, 2 + 3065))).toBe("bbdc66b399d297ff")
  expect(sha(dyn.slice(dyn.length - 1915))).toBe("1732b7f098a925d7")
  expect(JSON.parse(b.metadata.user_id)).toEqual({ device_id: DEVICE, account_uuid: "", session_id: "" })
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
    system: [...zcodeSystem("bigmodel-api/GLM-5.2"), { type: "text", text: "  Be brief.  " }],
    messages: [reminder, { role: "user", content: [{ type: "text", text: "hello", cache_control: eph }] }],
    metadata: { user_id: userID },
  })
})

test("a Start Plan body with no model has no powered-by line; a blank system adds nothing", async () => {
  const r = await send(start("zai"), JSON.stringify({ system: "   ", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }))
  expect(JSON.parse(r.body)).toEqual({
    system: zcodeSystem(""),
    messages: [reminder, { role: "user", content: [{ type: "text", text: "x", cache_control: eph }] }],
    metadata: { user_id: userID },
  })
})

test("a Start Plan request made as a Request, its body a stream, is dressed too", async () => {
  const r = await send(start("zai"), JSON.stringify(agentBody), { asRequest: true })
  expect(r.headers["x-title"]).toBe("Z Code@cli")
  expect(JSON.parse(r.body).system.slice(0, 3)).toEqual(zcodeSystem("zai-api/GLM-5.3-Flash"))
  expect(Number(r.headers["content-length"])).toBe(Buffer.byteLength(r.body))
})

// the GLM Coding Plan and team seats: as the agent sent it, as 0.1.6 sent it
const agentText = JSON.stringify(agentBody)
const sentAsIs = (r, key, path) => {
  expect(r.path).toBe(path)
  expect(r.body).toBe(agentText)
  expect(own(r.headers)).toEqual({
    authorization: "Bearer " + key,
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "user-agent": "ai-sdk/anthropic/3.0.81",
  })
}

test("a GLM Coding Plan key's request goes as the agent sent it", async () => {
  sentAsIs(await send({ type: "api", key: "one.secret", metadata: { site: "zai" } }, agentText), "one.secret", "/api.z.ai/api/anthropic/v1/messages")
  got.length = 0
  sentAsIs(await send({ type: "api", key: "two.secret", metadata: { site: "bigmodel" } }, agentText, { url: "https://open.bigmodel.cn/api/anthropic/v1/messages" }), "two.secret", "/open.bigmodel.cn/api/anthropic/v1/messages")
})

test("a team seat's request goes as the agent sent it, ZCode's token or not", async () => {
  const s = { site: "zai", base: "https://api.z.ai/api/anthropic", key: "team.secret", token: "tok", org: "o1", project: "p1", jwt, device: DEVICE }
  const auth = { type: "oauth", access: s.key, refresh: JSON.stringify(s), expires: 0 }
  sentAsIs(await send(auth, agentText), "team.secret", "/api.z.ai/api/anthropic/v1/messages")
})
