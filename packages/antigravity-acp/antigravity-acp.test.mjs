// The plugin's tests, as bun:test (so the repository's `bun test` runs them):
// no download, no Google — the ACP server is faked by test/fake-acp-server.mjs
// behind AGY_ACP_BIN, and the sign-in it keeps is faked in a temporary
// AGY_ACP_HOME. Exercises the config, sign-in, models, usage, and the
// streaming / tool-call / non-streaming fetch paths end to end, plus the
// failure paths: a refused prompt (a lost sign-in), a refusal after the reply
// started, a server that dies under the request, and where the plugin lets
// the server work.
import { test, expect, afterAll } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginPath = path.join(here, "index.mjs")

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-test-"))
process.env.AGY_ACP_HOME = home
process.env.AGY_ACP_AUTH_DIR = path.join(home, ".gemini", "antigravity-acp")
fs.mkdirSync(process.env.AGY_ACP_AUTH_DIR, { recursive: true })
fs.writeFileSync(path.join(process.env.AGY_ACP_AUTH_DIR, "settings.json"), JSON.stringify({ auth: { type: "oauth-personal" } }))
fs.writeFileSync(path.join(process.env.AGY_ACP_AUTH_DIR, "acp_token.json"), JSON.stringify({ refresh_token: "x", email: "me@example.com" }))

// the fake server as an executable the launcher accepts (a shebang wrapper;
// it needs a POSIX shell, so on Windows every test is skipped). Each test
// starts a bun child cold, so a busy CI box gets 30 s instead of bun's 5 s
const onPosix = process.platform === "win32" ? test.skip : (name, fn, timeout = 30_000) => test(name, fn, timeout)
const bin = path.join(home, "bin")
fs.mkdirSync(bin, { recursive: true })
const wrapper = path.join(bin, "agy_acp_server.par")
fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, "test", "fake-acp-server.mjs")}" "$@"\n`, { mode: 0o755 })
process.env.AGY_ACP_BIN = wrapper

const { AntigravityAcpPlugin, _internal } = await import(pluginPath)

const logs = []
const plugin = await AntigravityAcpPlugin({
  client: {
    app: { log: async (o) => logs.push(String(o?.body?.message ?? o?.message ?? "")) },
    tui: { showToast: async (o) => logs.push(`toast: ${String(o?.body?.message ?? o?.message ?? "")}`) },
  },
  // magpie's own folder, as the host passes it — never to become the
  // server's cwd (that one holds auth.json)
  directory: path.join(home, "magpie-config"),
})

const loaderOptions = await plugin.auth.loader(async () => ({ type: "oauth", refresh: "x" }))
const URL_ = "https://antigravity-acp.invalid/v1/chat/completions"
const chat = (body) =>
  loaderOptions.fetch(URL_, { method: "POST", headers: {}, body: JSON.stringify({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "hello" }], ...body }) })

onPosix("config registers the provider with fallback models", async () => {
  const cfg = {}
  await plugin.config(cfg)
  const p = cfg.provider["antigravity-acp"]
  expect(p?.npm).toBe("@ai-sdk/openai-compatible")
  expect(p?.models?.["gemini-3.8-flash"]).toBeTruthy()
})

onPosix("resolveLaunch finds AGY_ACP_BIN", () => {
  const found = _internal.resolveLaunch()
  expect(found?.command).toBe(wrapper)
  expect(found?.source).toBe("env")
})

onPosix("sign-in with the current Google account", async () => {
  const method = plugin.auth.methods[1]
  const a = await method.authorize()
  expect(a.method).toBe("auto")
  const r = await a.callback()
  expect(r.type).toBe("success")
  expect(r.refresh).toBe("managed-by-the-acp-server")
  expect(r.accountId).toBe("me@example.com")
})

onPosix("models: the fake's effort-qualified ids, folded into families", async () => {
  const models = await plugin.provider.models({ id: "antigravity-acp", models: {} }, { auth: { type: "oauth", refresh: "x" } })
  const flash = models["gemini-3.8-flash"]
  expect(flash?.variants?.low?.reasoningEffort).toBe("low")
  expect(flash?.variants?.medium?.reasoningEffort).toBe("medium")
  expect(flash?.variants?.high?.reasoningEffort).toBe("high")
  const pro = models["gemini-3.1-pro"]
  expect(pro?.variants?.low).toBeTruthy()
  expect(pro?.variants?.high).toBeTruthy()
  expect(pro?.variants?.medium).toBeUndefined()
  expect(models["gemini-3.8-flash-low"]).toBeUndefined()
})

onPosix("streaming reply with the effort's variant, thought, usage and [DONE]", async () => {
  const res = await chat({ stream: true, model: "gemini-3.8-flash", reasoning_effort: "high" })
  expect(res.status).toBe(200)
  expect(String(res.headers.get("content-type"))).toContain("text/event-stream")
  const body = await res.text()
  // the model chosen from the effort lands in the reply text, so the
  // assertion doubles as a check that the variant was set on the session
  expect(body).toContain("from fake at gemini-3.8-flash-high")
  expect(body).toContain('"finish_reason":"stop"')
  expect(body).toContain("[DONE]")
  expect(body).not.toContain("gemini-3.8-flash-low")
})

onPosix("client tool called through the bridge, delivered as tool_calls", async () => {
  const res = await chat({
    stream: true,
    model: "gemini-3.1-pro",
    tools: [{ type: "function", function: { name: "bash", description: "run a command", parameters: { type: "object", properties: { command: { type: "string" } } } } }],
    messages: [{ role: "user", content: "USE_TOOL please" }],
  })
  const body = await res.text()
  expect(body).toContain('"tool_calls"')
  expect(body).toContain('"finish_reason":"tool_calls"')
  const call = JSON.parse(body.split("\n").find((l) => l.includes("tool_calls"))?.replace(/^data: /, "") ?? "{}")
  const tc = call.choices?.[0]?.delta?.tool_calls?.[0]
  expect(tc?.function?.name).toBe("bash")
  const args = JSON.parse(tc.function.arguments)
  expect(args.command).toBe("echo hi")
  expect(args._from).toBe("fake-acp")
})

onPosix("non-streaming reply with usage", async () => {
  const res = await chat({
    stream: false,
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{\"command\":\"ls\"}" } }] },
      { role: "tool", tool_call_id: "c1", name: "bash", content: "file.txt" },
    ],
  })
  const data = await res.json()
  expect(data.object).toBe("chat.completion")
  expect(data.choices?.[0]?.finish_reason).toBe("stop")
  expect(String(data.choices?.[0]?.message?.content)).toContain("Hello")
  expect(data.usage?.total_tokens).toBe(15)
})

onPosix("a refused prompt (-32000) fails the request and marks the sign-in expired", async () => {
  let err
  try {
    await chat({ messages: [{ role: "user", content: "AUTHFAIL" }] })
  } catch (e) {
    err = e
  }
  expect(err).toBeDefined()
  expect(String(err.message)).toMatch(/signed in again/)
  expect(err.signIn).toBe("expired")
})

onPosix("a refusal after the reply started rides as the reply's tail", async () => {
  const res = await chat({ stream: true, messages: [{ role: "user", content: "FAILMID" }] })
  expect(res.status).toBe(200)
  const body = await res.text()
  expect(body).toContain("partial")
  expect(body).toContain("[Antigravity: authentication required]")
  expect(body).toContain("[DONE]")
})

onPosix("a server that dies under the request is retried once on a fresh one", async () => {
  const res = await chat({ stream: false, messages: [{ role: "user", content: "DIEONCE" }] })
  expect(res.status).toBe(200)
  const data = await res.json()
  expect(String(data.choices?.[0]?.message?.content)).toContain("Hello")
  expect(fs.existsSync(path.join(home, "died-once"))).toBe(true)
})

onPosix("the server works in the plugin's own workspace, never magpie's folder", async () => {
  await chat({ stream: false })
  const cwd = fs.readFileSync(path.join(home, "last-cwd"), "utf8")
  expect(cwd).toBe(path.join(_internal.runtimeRoot(), "workspace"))
  expect(cwd).not.toBe(path.join(home, "magpie-config"))
})

onPosix("pid files live in the plugin's runtime root, not ~/.gemini", async () => {
  await chat({ stream: false })
  const run = path.join(_internal.runtimeRoot(), "run")
  expect(fs.existsSync(path.join(run, `magpie-acp-pids-${process.pid}.json`))).toBe(true)
  const listed = fs.readdirSync(process.env.AGY_ACP_AUTH_DIR)
  expect(listed.filter((f) => f.startsWith("magpie-acp-pids"))).toEqual([])
})

onPosix("the session is closed over the wire when its request ends", async () => {
  await chat({ stream: false })
  // the fake advertises sessionCapabilities.close: {}, so the plugin sends
  // session/close as a real request; the fake records what it got. The
  // request rides the stdin pipe, so the record may lag the reply a little
  let closed = ""
  for (let i = 0; i < 40 && !closed; i++) {
    await new Promise((r) => setTimeout(r, 50))
    try { closed = fs.readFileSync(path.join(home, "closed-sessions"), "utf8") } catch {}
  }
  expect(closed.trim()).not.toBe("")
})

// ACP's capability is an object: omitted or null means the server can't close
for (const [label, flag] of [["omitted", "FAKE_NO_CLOSE"], ["null", "FAKE_CLOSE_NULL"]]) {
  onPosix(`no session/close is sent when the server's close capability is ${label}`, async () => {
    const conn = new _internal.AcpConnection({ command: wrapper, args: [], cwd: home, env: { ...process.env, [flag]: "1" } })
    conn.start()
    try {
      await conn.initialize()
      expect(conn.canClose).toBe(false)
      const session = await conn.newSession(home, [], 5_000)
      const file = path.join(home, "closed-sessions")
      fs.rmSync(file, { force: true })
      conn.closeSession(session.sessionId)
      await new Promise((r) => setTimeout(r, 300))
      expect(fs.existsSync(file)).toBe(false)
    } finally {
      conn.kill()
    }
  })
}

onPosix("requests that arrive together share one server", async () => {
  _internal.shutdown()
  const spawns = path.join(home, "spawns")
  fs.rmSync(spawns, { force: true })
  const replies = await Promise.all([chat({ stream: false }), chat({ stream: false }), chat({ stream: false })])
  for (const r of replies) expect(r.status).toBe(200)
  expect(fs.readFileSync(spawns, "utf8").trim().split("\n")).toHaveLength(1)
})

onPosix("a long history is cut from its oldest end; the instructions stay", () => {
  const filler = "x".repeat(1000)
  const messages = [{ role: "system", content: "KEEP-ME" }]
  for (let i = 0; i < 600; i++) messages.push({ role: i % 2 ? "assistant" : "user", content: `m${i} ${filler}` })
  messages.push({ role: "user", content: "last" })
  const { markdown } = _internal.buildPrompt({ messages })
  expect(markdown.length).toBeLessThanOrEqual(400_000)
  expect(markdown).toContain("KEEP-ME")
  expect(markdown).toContain("[older context truncated]")
  expect(markdown).toContain("m599 ")
  expect(markdown).not.toContain("m0 ")
})

onPosix("a timed-out call is cancelled alone; the server lives on", async () => {
  const conn = new _internal.AcpConnection({ command: wrapper, args: [], cwd: home })
  conn.start()
  try {
    await conn.initialize()
    const session = await conn.newSession(home, [], 5_000)
    // HANG never answers; the 300ms wait runs out with killOnTimeout false
    const hang = conn.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "HANG" }] }, 300, false)
    await expect(hang.promise).rejects.toThrow(/didn't answer session\/prompt/)
    // the server is still with us and answers the next request
    expect(conn.live).toBe(true)
    const next = await conn.newSession(home, [], 5_000)
    expect(next.sessionId).toBeTruthy()
  } finally {
    conn.kill()
  }
})

onPosix("usage reads the quota the prompt answered with", async () => {
  await chat({ stream: false })
  const u = await plugin.auth.usage(async () => ({ type: "oauth", refresh: "x" }))
  expect(u.plan).toBe("ultra")
  expect(u.windows?.[0]?.name).toBe("Antigravity quota")
  expect(u.windows[0].used).toBe(10)
})

onPosix("refresh leaves the sign-in to the server", async () => {
  const nothing = await plugin.auth.refresh({ type: "oauth", refresh: "x" })
  expect(nothing).toBeUndefined()
})

test("projectModels folds families, keeps one-offs", () => {
  const projected = _internal.projectModels([
    { modelId: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)" },
    { modelId: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)" },
    { modelId: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
    { modelId: "gemini-3.7-flash-tiered", name: "Gemini 3.7 Flash (Tiered)" },
  ])
  const ids = projected.map((m) => m.id)
  expect(ids).toContain("gemini-3.7-flash")
  expect(ids).toContain("gemini-3.7-flash-tiered")
})

afterAll(async () => {
  // the pooled servers hold the workspace open; let them go, wait for the
  // kills to land, then take the temporary home with us
  _internal.shutdown()
  await new Promise((r) => setTimeout(r, 500))
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})
