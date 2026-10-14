// The Amp plugin with a fake amp CLI (AMP_BIN) and a fake bridge: no real
// Amp is started and nothing is billed.
import { afterAll, beforeEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AmpAuthPlugin, _internal } from "./index.mjs"

const { ampError, availableEfforts, listModels, nearest, parseCalls, readUsage, repairArgs, transcript } = _internal

const root = mkdtempSync(join(tmpdir(), "amp-plugin-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const OPTIONS = `Models
  moonshotai/kimi-k3 (Kimi K3)
  zhipuai/glm-5.3 (GLM-5.3)
  openai/gpt-6-luna (GPT-6 Luna)
  acme/gpt-6-luna (Acme Luna)

Built-in tools
  Read
  edit_file
`

const USAGE = `Signed in as someone@example.com (someone)
**Individual credits:** $68.60 remaining (set up auto-reload to avoid running out) - https://ampcode.com/settings

# Run \`amp usage --details\` for more detailed information.
`

// fakeAmp puts an amp on AMP_BIN that prints what a script says for each
// subcommand
function fakeAmp({ usage = USAGE, usageExit = 0, runner = "" } = {}) {
  const bin = mkdtempSync(join(root, "bin-"))
  const p = join(bin, "amp")
  writeFileSync(join(bin, "options.txt"), OPTIONS)
  writeFileSync(join(bin, "usage.txt"), usage)
  writeFileSync(
    p,
    `#!/bin/sh
case "$1" in
  plugins) cat "${join(bin, "options.txt")}" ;;
  usage) cat "${join(bin, "usage.txt")}"; exit ${usageExit} ;;
  --no-tui) ${runner || 'echo "no runner here" >&2; exit 3'} ;;
  *) echo "unexpected: $*" >&2; exit 9 ;;
esac
`,
  )
  chmodSync(p, 0o755)
  process.env.AMP_BIN = p
}

beforeEach(() => {
  process.env.MAGPIE_AMP_DIR = mkdtempSync(join(root, "dir-"))
  _internal.reset()
  fakeAmp()
})

// ---- the transcript and the calls in a reply ------------------------------------

test("a reply's calls are read with any attributes, and its text before them", () => {
  const r = parseCalls(`Running the tests first.
<amp_call id="x" name="bash">{"command": "uv run pytest"}</amp_call>
<amp_call name="read">{"path": "a.py"}</amp_call>`)
  expect(r.content).toBe("Running the tests first.")
  expect(r.calls).toEqual([
    { name: "bash", raw: '{"command": "uv run pytest"}' },
    { name: "read", raw: '{"path": "a.py"}' },
  ])
})

test("a reply is cut where it makes up a result or a turn", () => {
  const r = parseCalls(`<amp_call name="bash">{"command":"ls"}</amp_call>
<amp_result id="1">a.py</amp_result>
<amp_call name="bash">{"command":"rm -rf /"}</amp_call>`)
  expect(r.calls.map((c) => c.raw)).toEqual(['{"command":"ls"}'])
})

test("arguments are made one JSON object, or null", () => {
  expect(repairArgs('{"a": 1}')).toBe('{"a":1}')
  expect(repairArgs('```json\n{"a": 1}\n```')).toBe('{"a":1}')
  expect(repairArgs(JSON.stringify(JSON.stringify({ a: 1 })))).toBe('{"a":1}')
  expect(repairArgs("[1, 2]")).toBeNull()
  expect(repairArgs("")).toBeNull()
  expect(repairArgs("not json")).toBeNull()
})

test("each request's prompt starts with the one before's", () => {
  const first = [
    { role: "system", content: "be brief" },
    { role: "user", content: "fix it" },
  ]
  const second = [
    ...first,
    { role: "assistant", content: "Looking.", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "a.py" },
  ]
  const a = transcript(first)
  const b = transcript(second)
  const tail = "\n\nWrite the assistant's next turn."
  expect(b.startsWith(a.slice(0, -tail.length))).toBe(true)
  expect(b).toContain('<amp_call id="c1" name="bash">{"command":"ls"}</amp_call>')
  expect(b).toContain('<amp_result id="c1">\na.py\n</amp_result>')
  expect(a).not.toContain("be brief")
})

test("an image is said to be left out", () => {
  const p = transcript([{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:," } }] }])
  expect(p).toContain("what is this\n[image omitted]")
})

// ---- efforts and errors ------------------------------------------------------------

test("a refused effort is answered with the nearest the model takes, the higher of two as near", () => {
  expect(availableEfforts('Reasoning effort "medium" is not supported by model "moonshotai/kimi-k3". Available efforts: low, high, max')).toEqual(["low", "high", "max"])
  expect(nearest("medium", ["low", "high", "max"])).toBe("high")
  expect(nearest("low", ["none", "high"])).toBe("high")
  expect(nearest("minimal", ["none", "high"])).toBe("none")
  expect(nearest("xhigh", ["low", "high", "max"])).toBe("max")
  expect(nearest("low", ["low", "high"])).toBe("low")
})

test("generate's failures are read as the vendor's message and a status", () => {
  const e = ampError('AI inference request failed (500): {"ok":false,"error":"404 Model not found, inaccessible, and/or not deployed"}')
  expect(e.message).toBe("404 Model not found, inaccessible, and/or not deployed")
  expect(e.status).toBe(404)
  expect(ampError('AI inference request failed (400): {"ok":false,"error":"Invalid request body"}').status).toBe(400)
  expect(ampError("something else").status).toBe(502)
})

// ---- models, sign-in and usage --------------------------------------------------------

test("models are offered by their own name, unless two providers share it", () => {
  expect(listModels(OPTIONS)).toEqual([
    { full: "moonshotai/kimi-k3", name: "Kimi K3", id: "kimi-k3" },
    { full: "zhipuai/glm-5.3", name: "GLM-5.3", id: "glm-5.3" },
    { full: "openai/gpt-6-luna", name: "GPT-6 Luna", id: "openai/gpt-6-luna" },
    { full: "acme/gpt-6-luna", name: "Acme Luna", id: "acme/gpt-6-luna" },
  ])
})

test("the account's models come from amp, with an effort for each variant", async () => {
  const hooks = await AmpAuthPlugin({})
  const models = await hooks.provider.models({ models: {} }, { auth: { type: "api", key: "amp-cli" } })
  expect(Object.keys(models)).toEqual(["kimi-k3", "glm-5.3", "openai/gpt-6-luna", "acme/gpt-6-luna"])
  expect(Object.keys(models["kimi-k3"].variants)).toEqual(["low", "medium", "high", "xhigh", "max"])
  expect(models["kimi-k3"].capabilities.toolcall).toBe(true)
})

test("the credits left and who is signed in are read from amp usage", () => {
  expect(readUsage(USAGE)).toEqual({ user: "someone@example.com", plan: "Individual credits", balance: "$68.60" })
  expect(readUsage("Not signed in")).toEqual({ user: "", plan: "", balance: "" })
})

test("signing in takes the amp CLI's account and keeps no key of Amp's", async () => {
  const hooks = await AmpAuthPlugin({})
  const a = await hooks.auth.methods[0].authorize()
  expect(a.instructions).toBe("Amp is signed in as someone@example.com.")
  expect(await a.callback()).toEqual({ type: "success", key: "amp-cli", metadata: { email: "someone@example.com" } })
  expect(await hooks.auth.usage()).toEqual({ plan: "Individual credits", user: "someone@example.com", balance: "$68.60", windows: [], signIn: "kept" })
})

test("an amp nobody is signed in to says to sign in", async () => {
  fakeAmp({ usage: "Error: not logged in\n", usageExit: 1 })
  const hooks = await AmpAuthPlugin({})
  await expect(hooks.auth.methods[0].authorize()).rejects.toThrow("Amp isn't signed in: run `amp login` (Error: not logged in)")
  expect((await hooks.auth.usage()).error).toContain("amp login")
})

test("no amp CLI is said, not tried", async () => {
  const { HOME, PATH } = process.env
  process.env.AMP_BIN = ""
  process.env.PATH = "/nonexistent"
  process.env.HOME = root
  try {
    const hooks = await AmpAuthPlugin({})
    await expect(hooks.auth.methods[0].authorize()).rejects.toThrow("the amp CLI isn't installed")
  } finally {
    Object.assign(process.env, { HOME, PATH })
  }
})

// ---- a chat completion through a fake bridge -------------------------------------------

// fakeBridge serves /health and /generate as bridge.ts does; answer(request,
// n) gives each generate's result, or throws a message for a 502
function fakeBridge(answer) {
  const asked = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== "Bearer amb-test") return Response.json({ error: "key" }, { status: 401 })
      const path = new URL(req.url).pathname
      if (path === "/health") return Response.json({ ok: true, version: _internal.BRIDGE_VERSION, thread: "T-1" })
      const body = await req.json()
      asked.push(body)
      try {
        return Response.json({ result: await answer(body, asked.length) })
      } catch (e) {
        return Response.json({ error: e.message }, { status: 502 })
      }
    },
  })
  const d = process.env.MAGPIE_AMP_DIR
  writeFileSync(join(d, "key"), "amb-test")
  writeFileSync(join(d, "port"), String(server.port))
  return { asked, stop: () => server.stop(true) }
}

async function chat(body) {
  const hooks = await AmpAuthPlugin({})
  const o = await hooks.auth.loader(async () => ({ type: "api", key: "amp-cli" }))
  return o.fetch(o.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify(body) })
}

const TOOLS = [{ type: "function", function: { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } } } }]

test("a turn with tools is asked for as text, and its <amp_call> blocks are its tool calls", async () => {
  const b = fakeBridge(() => 'Running the tests.\n<amp_call name="bash">{"command": "uv run pytest"}</amp_call>')
  try {
    const r = await chat({ model: "kimi-k3", messages: [{ role: "user", content: "fix it" }], tools: TOOLS, max_tokens: 500000 })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.choices[0].finish_reason).toBe("tool_calls")
    expect(j.choices[0].message.content).toBe("Running the tests.")
    expect(j.choices[0].message.tool_calls[0].function).toEqual({ name: "bash", arguments: '{"command":"uv run pytest"}' })
    expect(b.asked[0].model).toBe("moonshotai/kimi-k3")
    expect(b.asked[0].reasoningEffort).toBe("low")
    expect(b.asked[0].maxTokens).toBe(128000)
    expect(b.asked[0].schema).toBeUndefined()
    expect(b.asked[0].system).toContain("### bash")
  } finally {
    b.stop()
  }
})

test("an empty answer is asked again as an object, and a model text keeps failing is asked for one first", async () => {
  const b = fakeBridge((req) => (req.schema ? { content: "", tool_calls: [{ name: "bash", arguments: { command: "ls" } }] } : ""))
  const ask = () => chat({ model: "kimi-k3", messages: [{ role: "user", content: "fix it" }], tools: TOOLS, stream: true })
  try {
    const r = await ask()
    const sse = await r.text()
    expect(r.headers.get("content-type")).toBe("text/event-stream")
    expect(sse).toContain('"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"')
    expect(sse).toContain('"finish_reason":"tool_calls"')
    expect(sse.trimEnd().endsWith("data: [DONE]")).toBe(true)
    // one empty answer isn't enough to stop asking for text first
    await ask()
    _internal.reset() // read back from the folder, as after a restart
    await ask()
    expect(b.asked.map((a) => !!a.schema)).toEqual([false, true, false, true, true])
  } finally {
    b.stop()
  }
})

test("an answer object inference turns away as text is asked again as text", async () => {
  const d = process.env.MAGPIE_AMP_DIR
  writeFileSync(join(d, "models.json"), JSON.stringify({ "moonshotai/kimi-k3": { object: [5, 0], text: [0, 5] } }))
  let reply = "All tests pass."
  const b = fakeBridge((req) => {
    if (req.schema) throw new Error('AI inference request failed (500): {"ok":false,"error":"AI object inference returned text instead of only the requested object"}')
    return reply
  })
  const ask = () => chat({ model: "kimi-k3", messages: [{ role: "user", content: "fix it" }], tools: TOOLS }).then((r) => r.json())
  try {
    const j = await ask()
    expect(j.choices[0].message).toEqual({ role: "assistant", content: "All tests pass." })
    expect(j.choices[0].finish_reason).toBe("stop")
    // a final answer is neither way's failure
    expect(JSON.parse(readFileSync(join(d, "models.json"), "utf8"))["moonshotai/kimi-k3"]).toEqual({ object: [5, 0], text: [0, 5] })
    // a call written in text is the object's failure and the text's success
    reply = 'Checking.\n<amp_call name="bash">{"command":"ls"}</amp_call>'
    expect((await ask()).choices[0].message.tool_calls[0].function.name).toBe("bash")
    expect(JSON.parse(readFileSync(join(d, "models.json"), "utf8"))["moonshotai/kimi-k3"]).toEqual({ object: [5, 1], text: [1, 5] })
    expect(b.asked.map((a) => !!a.schema)).toEqual([true, false, true, false])
  } finally {
    b.stop()
  }
})

test("an effort the model doesn't take is learned and asked again at the nearest", async () => {
  const b = fakeBridge((req) => {
    if (req.reasoningEffort === "medium") throw new Error('AI inference request failed (500): {"ok":false,"error":"Reasoning effort \\"medium\\" is not supported by model \\"moonshotai/kimi-k3\\". Available efforts: low, high, max"}')
    return "OK"
  })
  try {
    const r = await chat({ model: "kimi-k3", messages: [{ role: "user", content: "hi" }], reasoning_effort: "medium" })
    expect((await r.json()).choices[0].message.content).toBe("OK")
    expect(b.asked.map((a) => a.reasoningEffort)).toEqual(["medium", "high"])
    // and the next request goes at it straight away
    await chat({ model: "kimi-k3", messages: [{ role: "user", content: "hi" }], reasoning_effort: "medium" })
    expect(b.asked.map((a) => a.reasoningEffort)).toEqual(["medium", "high", "high"])
  } finally {
    b.stop()
  }
})

test("a model Amp doesn't serve is a 404 magpie can fall back from", async () => {
  const b = fakeBridge(() => {
    throw new Error('AI inference request failed (500): {"ok":false,"error":"404 Model not found, inaccessible, and/or not deployed"}')
  })
  try {
    const r = await chat({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }], stream: true })
    expect(r.status).toBe(404)
    expect(r.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect((await r.json()).error.message).toContain("Model not found")
  } finally {
    b.stop()
  }
})

test("a model not in the seed is looked up in amp's list", async () => {
  const b = fakeBridge(() => "OK")
  try {
    await chat({ model: "acme/gpt-6-luna", messages: [{ role: "user", content: "hi" }] })
    await chat({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }] })
    expect(b.asked.map((a) => a.model)).toEqual(["acme/gpt-6-luna", "zhipuai/glm-5.3"])
  } finally {
    b.stop()
  }
})

// ---- starting the runner -----------------------------------------------------------------

// RUNNER stands in for `amp --no-tui` with the bridge loaded: it serves what
// bridge.ts serves, from the folder the package set up
const RUNNER = join(root, "runner.mjs")
writeFileSync(
  RUNNER,
  `import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const d = process.env.MAGPIE_AMP_DIR
const key = readFileSync(join(d, "key"), "utf8").trim()
const version = /const VERSION = '([^']+)'/.exec(readFileSync(join(d, ".amp", "plugins", "magpie-bridge.ts"), "utf8"))[1]
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  if (req.headers.get("authorization") !== "Bearer " + key) return new Response("no", { status: 401 })
  const path = new URL(req.url).pathname
  if (path === "/health") return Response.json({ ok: true, version, thread: "" })
  if (path === "/stop") { setTimeout(() => process.exit(0), 10); return Response.json({ ok: true }) }
  return Response.json({ result: "OK from " + process.cwd() })
} })
writeFileSync(join(d, "port"), String(server.port))
`,
)

test.skipIf(process.platform === "win32")("with no bridge answering, amp --no-tui is started in the folder with the bridge", async () => {
  fakeAmp({ runner: `exec "${process.execPath}" "${RUNNER}"` })
  const d = process.env.MAGPIE_AMP_DIR
  const r = await chat({ model: "kimi-k3", messages: [{ role: "user", content: "hi" }] })
  const port = readFileSync(join(d, "port"), "utf8")
  const key = readFileSync(join(d, "key"), "utf8")
  try {
    expect(r.status).toBe(200)
    expect((await r.json()).choices[0].message.content).toBe(`OK from ${realpathSync(d)}`)
    expect(readFileSync(join(d, ".amp", "plugins", "magpie-bridge.ts"), "utf8")).toBe(readFileSync(new URL("./bridge.ts", import.meta.url), "utf8"))
    expect(Number(readFileSync(join(d, "runner.pid"), "utf8"))).toBeGreaterThan(0)
    expect(statSync(join(d, "key")).mode & 0o777).toBe(0o600)
    expect(existsSync(join(d, "start.lock"))).toBe(false)
  } finally {
    await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { authorization: `Bearer ${key}` } }).catch(() => {})
  }
})

// oldRunner stands in for a runner this package started in the folder before:
// a process whose command line has the folder's runner id
function oldRunner(id) {
  const d = process.env.MAGPIE_AMP_DIR
  writeFileSync(join(d, "runner-id"), id)
  const p = Bun.spawn(["sh", "-c", "sleep 30; true", "sh", "--no-tui", "--runner-id", id])
  writeFileSync(join(d, "runner.pid"), String(p.pid))
  return p
}

test.skipIf(process.platform === "win32")("a runner of the folder's that still runs is waited for, not started again", async () => {
  // its bridge's process is between two starts: the port is one nobody answers
  const d = process.env.MAGPIE_AMP_DIR
  const marker = join(d, "started")
  fakeAmp({ runner: `touch "${marker}"; exit 1` })
  writeFileSync(join(d, "key"), "amb-test")
  const old = oldRunner("magpie-test0001")
  writeFileSync(join(d, "port"), "1")
  let b
  const later = setTimeout(() => (b = fakeBridge(() => "OK")), 500)
  try {
    const r = await chat({ model: "kimi-k3", messages: [{ role: "user", content: "hi" }] })
    expect(r.status).toBe(200)
    expect(existsSync(marker)).toBe(false)
    expect(readFileSync(join(d, "runner.pid"), "utf8")).toBe(String(old.pid))
  } finally {
    clearTimeout(later)
    b?.stop()
    old.kill()
  }
})

test.skipIf(process.platform === "win32")("a runner of the folder's whose bridge never answers is stopped, and another started", async () => {
  fakeAmp({ runner: `exec "${process.execPath}" "${RUNNER}"` })
  const d = process.env.MAGPIE_AMP_DIR
  const old = oldRunner("magpie-test0002")
  const wait = _internal.WAITS.runner
  _internal.WAITS.runner = 300
  try {
    const r = await chat({ model: "kimi-k3", messages: [{ role: "user", content: "hi" }] })
    expect(r.status).toBe(200)
    expect(await Promise.race([old.exited.then(() => "stopped"), new Promise((ok) => setTimeout(() => ok("running"), 3000))])).toBe("stopped")
    expect(readFileSync(join(d, "runner.pid"), "utf8")).not.toBe(String(old.pid))
  } finally {
    _internal.WAITS.runner = wait
    old.kill()
    const port = readFileSync(join(d, "port"), "utf8")
    const key = readFileSync(join(d, "key"), "utf8")
    await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST", headers: { authorization: `Bearer ${key}` } }).catch(() => {})
  }
})

test("a runner that stops at once says what it printed", async () => {
  fakeAmp({ runner: `echo "Error: You are not logged in. Run amp login." >&2; exit 1` })
  const r = await chat({ model: "kimi-k3", messages: [{ role: "user", content: "hi" }] })
  expect(r.status).toBe(503)
  expect((await r.json()).error.message).toBe("amp --no-tui stopped (1): Error: You are not logged in. Run amp login.")
})

test("GPT and GLM models are asked for an object first", async () => {
  const b = fakeBridge((req) => (req.schema ? { content: "", tool_calls: [{ name: "bash", arguments: { command: "ls" } }] } : "Sorry, I can't run commands in this session."))
  try {
    const j = await (await chat({ model: "openai/gpt-6-luna", messages: [{ role: "user", content: "fix it" }], tools: TOOLS })).json()
    expect(j.choices[0].message.tool_calls[0].function.name).toBe("bash")
    expect(b.asked.map((a) => !!a.schema)).toEqual([true])
  } finally {
    b.stop()
  }
})

test("only the sentence before a call is asked again as an object", async () => {
  const b = fakeBridge((req) => (req.schema ? { content: "Fixing them:", tool_calls: [{ name: "bash", arguments: { command: "ls" } }] } : "All my tests pass. Fixing them:"))
  try {
    const j = await (await chat({ model: "kimi-k3", messages: [{ role: "user", content: "fix it" }], tools: TOOLS })).json()
    expect(j.choices[0].message.tool_calls[0].function.name).toBe("bash")
    await chat({ model: "kimi-k3", messages: [{ role: "user", content: "fix it" }], tools: TOOLS })
    expect(b.asked.map((a) => !!a.schema)).toEqual([false, true, false, true])
  } finally {
    b.stop()
  }
})

test("an empty answer whose object is refused is asked for text once more", async () => {
  const replies = ["", "All 22 tests pass."]
  const b = fakeBridge((req) => {
    if (req.schema) throw new Error('AI inference request failed (500): {"ok":false,"error":"AI object inference returned text instead of only the requested object"}')
    return replies.shift()
  })
  try {
    const j = await (await chat({ model: "kimi-k3", messages: [{ role: "user", content: "fix it" }], tools: TOOLS })).json()
    expect(j.choices[0].message.content).toBe("All 22 tests pass.")
    expect(b.asked.map((a) => !!a.schema)).toEqual([false, true, false])
  } finally {
    b.stop()
  }
})

test("calls written into an object's content are read back, and only calls of the request's tools", () => {
  const { salvage } = _internal
  // GLM-5.3, asked for an object
  const glm = `Now I'll create the two files.<tool_call>tool_calls</arg_key><arg_value>[{"name": "write", "arguments": {"path": "stats.py", "content": "x = [1]\\n"}}, {"name": "bash", "arguments": {"command": "ls"}}]</arg_value></tool_call>`
  expect(salvage(glm, ["write", "bash"])).toEqual({
    content: "Now I'll create the two files.",
    calls: [
      { name: "write", raw: '{"path":"stats.py","content":"x = [1]\\n"}' },
      { name: "bash", raw: '{"command":"ls"}' },
    ],
  })
  // GLM's own format, whole
  expect(salvage("Listing.<tool_call>bash<arg_key>command</arg_key><arg_value>ls -la</arg_value></tool_call>", ["bash"])).toEqual({
    content: "Listing.",
    calls: [{ name: "bash", raw: '{"command":"ls -la"}' }],
  })
  expect(salvage('<amp_call name="bash">{"command":"ls"}</amp_call>', ["bash"]).calls).toEqual([{ name: "bash", raw: '{"command":"ls"}' }])
  // a list in a final answer, of names that aren't tools
  expect(salvage('The users are [{"name": "ann", "arguments": {}}].', ["bash"])).toBeNull()
  expect(salvage("All tests pass.", ["bash"])).toBeNull()
})

test("an object whose calls are in its content answers with them", async () => {
  const b = fakeBridge(() => ({ content: 'Creating it.<tool_call>tool_calls</arg_key><arg_value>[{"name": "bash", "arguments": {"command": "ls"}}]</arg_value></tool_call>', tool_calls: [] }))
  try {
    const j = await (await chat({ model: "glm-5.3", messages: [{ role: "user", content: "fix it" }], tools: TOOLS })).json()
    expect(j.choices[0].message.content).toBe("Creating it.")
    expect(j.choices[0].message.tool_calls[0].function).toEqual({ name: "bash", arguments: '{"command":"ls"}' })
  } finally {
    b.stop()
  }
})

test("the bridge makes another billing thread when its own was deleted", async () => {
  // bridge.ts itself, with a fake amp: the thread in <dir>/thread was
  // deleted in Amp, as `amp threads delete` does
  const dir = mkdtempSync(join(root, "bridge-"))
  writeFileSync(join(dir, "key"), "k")
  writeFileSync(join(dir, "thread"), "T-gone")
  const before = process.env.MAGPIE_AMP_DIR
  process.env.MAGPIE_AMP_DIR = dir
  const { default: bridge } = await import("./bridge.ts")
  if (before === undefined) delete process.env.MAGPIE_AMP_DIR
  else process.env.MAGPIE_AMP_DIR = before
  const asked = []
  let made = 0
  bridge({
    logger: { log() {} },
    getBuiltinAgent: () => ({ createThread: async () => ({ id: `T-new${++made}` }) }),
    ai: {
      generate: async (r) => {
        asked.push(r.threadID)
        if (r.prompt === "other") throw new Error("request failed (500): something else")
        if (r.threadID === "T-gone") throw new Error(`Failed to create thread-actors thread: 500 {"error":"Failed to create thread actor: Thread not found: T-gone"}`)
        return "OK"
      },
    },
  })
  const generate = (prompt) =>
    fetch(`http://127.0.0.1:${readFileSync(join(dir, "port"), "utf8")}/generate`, {
      method: "POST",
      headers: { authorization: "Bearer k" },
      body: JSON.stringify({ model: "google/gemini-3.8-flash", prompt }),
    })
  const r = await generate("hi")
  expect(r.status).toBe(200)
  expect(await r.json()).toEqual({ result: "OK" })
  expect(asked).toEqual(["T-gone", "T-new1"])
  expect(readFileSync(join(dir, "thread"), "utf8")).toBe("T-new1")
  // another failure is not asked again, and keeps the thread
  const e = await generate("other")
  expect(e.status).toBe(502)
  expect(asked).toEqual(["T-gone", "T-new1", "T-new1"])
  expect(made).toBe(1)
})
