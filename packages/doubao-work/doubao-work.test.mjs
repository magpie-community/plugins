import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { App, Page, copies } from "./cdp.mjs"
import { Doubao, APPS, NEW_TASK, CLOUD, MENU, READ, STATE, MODELS, idFor, tableFrom, records, installed, binary, choose, dataDir, owns, isChat, usageOf } from "./doubao.mjs"
import { Streamer, sse, completion } from "./openai.mjs"
import { flatten, parse, heldFrom } from "./prompt.mjs"
import { _internal as I } from "./index.mjs"

let n = 0
const ids = () => "call_" + ++n

// ---- prompt ----

test("flatten writes system, tools and every turn, calls and results by name", () => {
  const p = flatten({
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "How long is main.go?" }, { type: "image_url", image_url: { url: "data:," } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: '{"command":"wc -l main.go"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "412 main.go" },
    ],
    tools: [{ type: "function", function: { name: "Bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } } } }],
  })
  expect(p).toContain("Be brief.")
  expect(p).toContain("## Bash\nRun a command")
  expect(p).toContain('<tool_call>{"name":"Bash","arguments":{"command":"wc -l main.go"}}</tool_call>')
  expect(p).toContain("[tool result of Bash]\n412 main.go")
  expect(p).toContain("[image omitted")
  expect(p.indexOf("[user]")).toBeLessThan(p.indexOf("[assistant]"))
})

test("tool_choice none leaves the tools out; a named one is required", () => {
  const tools = [{ type: "function", function: { name: "Read", parameters: {} } }]
  const msgs = [{ role: "user", content: "hi" }]
  expect(flatten({ messages: msgs, tools, tool_choice: "none" })).not.toContain("<tool_call>")
  expect(flatten({ messages: msgs, tools, tool_choice: { type: "function", function: { name: "Read" } } })).toContain("You must call the tool Read now.")
  expect(flatten({ messages: msgs })).not.toContain("# Tools")
})

test("parse reads calls, keeps a block it can't read as text, and reads an unclosed last call", () => {
  const r = parse('Looking.\n<tool_call>{"name":"Read","arguments":{"path":"a"}}</tool_call>\n<tool_call>```json\n{"name":"Bash","parameters":{"command":"ls"}}\n```</tool_call>', ids)
  expect(r.calls.map((c) => [c.function.name, JSON.parse(c.function.arguments)])).toEqual([["Read", { path: "a" }], ["Bash", { command: "ls" }]])
  expect(r.text).toBe("Looking.")
  expect(parse("<tool_call>not json</tool_call>", ids)).toMatchObject({ calls: [], text: "<tool_call>not json</tool_call>" })
  expect(parse('<tool_call>{"name":"Read","arguments":{"path":"b"}}', ids).calls[0].function.arguments).toBe('{"path":"b"}')
  expect(parse("plain answer", ids)).toMatchObject({ calls: [], text: "plain answer" })
})

test("heldFrom holds a tail that could start a call", () => {
  expect(heldFrom("abc")).toBe(3)
  expect(heldFrom("abc <tool")).toBe(4)
  expect(heldFrom("abc <tool_call>{")).toBe(4)
  expect(heldFrom("a < b")).toBe(5)
})

// ---- openai ----

test("Streamer shows text up to a call and gives calls at the end", () => {
  const s = new Streamer()
  expect(s.update({ text: "Let me ", reasoning: "think" })).toEqual({ reasoning: "think", content: "Let me " })
  expect(s.update({ text: "Let me look.<tool", reasoning: "think more" })).toEqual({ reasoning: " more", content: "look." })
  expect(s.update({ text: 'Let me look.<tool_call>{"name":"Read","arguments":{}}</tool_call>' })).toEqual({})
  const f = s.finish({ text: 'Let me look.<tool_call>{"name":"Read","arguments":{}}</tool_call>\n' }, ids)
  expect(f.content).toBe("")
  expect(f.calls[0].function.name).toBe("Read")
})

test("Streamer: a '<' that isn't a call is shown at the end", () => {
  const s = new Streamer()
  expect(s.update({ text: "1 <" })).toEqual({ content: "1 " })
  expect(s.finish({ text: "1 <" }, ids)).toEqual({ content: "<", calls: [] })
})

const events = async (res) =>
  (await res.text())
    .split("\n\n")
    .filter(Boolean)
    .map((l) => l.replace(/^data: /, ""))
    .map((l) => (l === "[DONE]" ? l : JSON.parse(l)))

test("sse streams reasoning, content, tool_calls, finish and usage", async () => {
  const res = await sse({
    id: "x",
    model: "auto",
    newId: ids,
    promptTokens: () => 100,
    ask: async (on) => {
      on({ text: "", reasoning: "hmm" })
      on({ text: "Reading.", reasoning: "hmm" })
      return { text: 'Reading.<tool_call>{"name":"Read","arguments":{"path":"x"}}</tool_call>', reasoning: "hmm" }
    },
  })
  expect(res.headers.get("content-type")).toBe("text/event-stream")
  const ev = await events(res)
  const deltas = ev.filter((e) => e !== "[DONE]" && e.choices?.length).map((e) => e.choices[0])
  expect(deltas.map((d) => d.delta.reasoning_content).filter(Boolean).join("")).toBe("hmm")
  expect(deltas.map((d) => d.delta.content).filter(Boolean).join("")).toBe("Reading.")
  expect(deltas.find((d) => d.delta.tool_calls).delta.tool_calls[0]).toMatchObject({ index: 0, type: "function", function: { name: "Read", arguments: '{"path":"x"}' } })
  expect(deltas.at(-1).finish_reason).toBe("tool_calls")
  expect(ev.find((e) => e.usage).usage.prompt_tokens).toBe(100)
  expect(ev.at(-1)).toBe("[DONE]")
})

test("sse throws a failure that comes before the reply, and streams one after it", async () => {
  const boom = Object.assign(Error("not signed in"), { code: "doubao_signed_out" })
  await expect(sse({ id: "x", model: "auto", ask: async () => { throw boom } })).rejects.toBe(boom)
  const res = await sse({ id: "x", model: "auto", ask: async (on) => { on({ text: "par" }); throw Error("cut off") } })
  const ev = await events(res)
  expect(ev.at(-1).error.message).toBe("cut off")
})

test("sse cancel aborts the ask", async () => {
  let seen
  const res = await sse({
    id: "x",
    model: "auto",
    ask: (on, signal) =>
      new Promise((_, reject) => {
        seen = signal
        on({ text: "a" })
        signal.addEventListener("abort", () => reject(signal.reason))
      }),
  })
  await res.body.cancel()
  expect(seen.aborted).toBe(true)
})

test("completion gives a whole message", () => {
  const c = completion({ id: "x", model: "auto", final: { text: '<tool_call>{"name":"Read","arguments":{"path":"y"}}</tool_call>', reasoning: "r" }, promptTokens: 5, newId: ids })
  expect(c.choices[0]).toMatchObject({ finish_reason: "tool_calls", message: { content: null, reasoning_content: "r" } })
  expect(c.usage.prompt_tokens).toBe(5)
})

// ---- doubao adapter ----

test("usageOf adds Doubao's prompt counts", () => {
  expect(usageOf('{"system_prompt":6423,"messages":111175,"skills":0,"tools":0,"total_window_size":256000}')).toBe(117598)
  expect(usageOf("")).toBe(0)
  expect(usageOf("nope")).toBe(0)
})

test("on Windows a running copy of the app never blocks: Chromium keeps one copy per profile there", async () => {
  if (process.platform === "win32") return expect(copies("C:\\x.exe")).toEqual([])
  const child = Bun.spawn(["/bin/sleep", "30"])
  try {
    let seen = []
    for (let i = 0; i < 50 && !seen.length; i++) { seen = copies("/bin/sleep"); if (!seen.length) await Bun.sleep(20) }
    expect(seen.length).toBeGreaterThan(0)
    expect(copies("/bin/sleep", "win32")).toEqual([])
  } finally {
    child.kill()
  }
})

// withEnv runs fn with the variables the app lookup reads unset.
const withEnv = (fn) => {
  const keys = ["DOUBAO_WORK_APP", "DOUBAO_WORK_HOME", "LOCALAPPDATA"]
  const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  for (const k of keys) delete process.env[k]
  try {
    return fn()
  } finally {
    for (const k of keys) {
      if (was[k] === undefined) delete process.env[k]
      else process.env[k] = was[k]
    }
  }
}
const only = (...paths) => (p) => paths.includes(p)

test("the app is found on macOS and Windows, or where DOUBAO_WORK_APP says", () =>
  withEnv(() => {
    // nothing installed: 豆包工作's own place, so the error names it
    expect(binary("darwin", "/Users/u", only())).toBe("/Applications/DoubaoWork.app/Contents/MacOS/DoubaoWork")
    // neither app has a Linux build
    expect(binary("linux", "/home/u", () => true)).toBe("")
    // Windows: the per-user install's own exe, not Application\<name>.exe's launcher
    expect(binary("win32", "C:\\Users\\u", only())).toBe("C:\\Users\\u\\AppData\\Local\\DoubaoWork\\Application\\app\\DoubaoWork.exe")
    const old = "C:\\Users\\u\\AppData\\Local\\Doubao\\Application\\app\\Doubao.exe"
    expect(binary("win32", "C:\\Users\\u", only(old))).toBe(old)
    expect(dataDir("win32", "C:\\Users\\u")).toBe("C:\\Users\\u\\AppData\\Local\\magpie-doubao-work")
    process.env.LOCALAPPDATA = "D:\\Local"
    expect(binary("win32", "C:\\Users\\u", only())).toBe("D:\\Local\\DoubaoWork\\Application\\app\\DoubaoWork.exe")
    expect(choose("win32", "C:\\Users\\u", only()).dataDir).toBe("D:\\Local\\magpie-doubao-work\\doubaowork")
    expect(dataDir("win32", "C:\\Users\\u")).toBe("D:\\Local\\magpie-doubao-work")
    process.env.DOUBAO_WORK_APP = "/opt/doubao"
    expect(binary("linux")).toBe("/opt/doubao")
    expect(choose("darwin", "/Users/u").app.name).toBe("豆包")
    process.env.DOUBAO_WORK_APP = "/opt/DoubaoWork.app/Contents/MacOS/DoubaoWork"
    expect(choose("darwin", "/Users/u").app.name).toBe("豆包工作")
  }))

// #917 (sinoyster): only 豆包工作 at its own path, no Doubao.app
test("a Mac with only 豆包工作 drives 豆包工作 (#917)", () =>
  withEnv(() => {
    const work = "/Applications/DoubaoWork.app/Contents/MacOS/DoubaoWork"
    const c = choose("darwin", "/Users/u", only(work))
    expect(c.binary).toBe(work)
    expect(c.app.name).toBe("豆包工作")
    // its own profile, port and model list, apart from 豆包's
    expect(c.dataDir).toBe("/Users/u/Library/Application Support/magpie-doubao-work/doubaowork")
    // ~/Applications too
    const mine = "/Users/u/Applications/DoubaoWork.app/Contents/MacOS/DoubaoWork"
    expect(binary("darwin", "/Users/u", only(mine))).toBe(mine)
    // with both installed, 豆包工作 is the one, until someone signed in to 豆包 through the plugin
    const old = "/Applications/Doubao.app/Contents/MacOS/Doubao"
    expect(binary("darwin", "/Users/u", only(work, old))).toBe(work)
    expect(binary("darwin", "/Users/u", only(old))).toBe(old)
    const signedIn = "/Users/u/Library/Application Support/magpie-doubao-work/profile"
    const c2 = choose("darwin", "/Users/u", only(work, old, signedIn))
    expect(c2.binary).toBe(old)
    expect(c2.dataDir).toBe("/Users/u/Library/Application Support/magpie-doubao-work")
    // a 豆包 profile with 豆包 gone: 豆包工作
    expect(binary("darwin", "/Users/u", only(work, signedIn))).toBe(work)
  }))

// An install the user put outside %LOCALAPPDATA% — another drive — is named
// by the uninstall record Windows keeps for it, the one place that knows the
// folder the user chose.
test("a Windows install the default place does not hold is found through its uninstall record", () =>
  withEnv(() => {
    const text = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DoubaoWork",
      "    DisplayName    REG_SZ    豆包工作",
      '    DisplayIcon    REG_SZ    "D:\\Apps\\DoubaoWork\\icon.ico,0"',
      "    DisplayVersion    REG_SZ    2.25.18",
      '    UninstallString    REG_SZ    "D:\\Apps\\DoubaoWork\\uninstall.exe"',
      "",
      "HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git",
      "    DisplayName    REG_SZ    Git",
      '    InstallLocation    REG_SZ    "C:\\Program Files\\Git"',
      "",
    ].join("\r\n")
    // the folder is the one the installer chose; InstallLocation, when it is
    // there, names it outright, and the icon's ",0" is not part of the path
    expect(records(text)).toEqual([
      { name: "豆包工作", root: "D:\\Apps\\DoubaoWork" },
      { name: "Git", root: "C:\\Program Files\\Git" },
    ])
    const bin = "D:\\Apps\\DoubaoWork\\app\\DoubaoWork.exe"
    expect(installed(APPS[0], "win32", () => text)).toEqual([bin])
    // the program is app\<exe>: the exe beside it is a launcher
    expect(installed(APPS[0], "win32", () => text)[0]).not.toBe("D:\\Apps\\DoubaoWork\\DoubaoWork.exe")
    // other programs' records are not the app, and macOS has no such records
    expect(installed(APPS[1], "win32", () => text)).toEqual([])
    expect(installed(APPS[0], "darwin", () => text)).toEqual([])
    // a DisplayName that took the version into it still counts, by its folder
    const versioned = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DoubaoWork",
      "    DisplayName    REG_SZ    豆包工作 2.25.18",
      '    UninstallString    REG_SZ    "D:\\Apps\\DoubaoWork\\uninstall.exe"',
    ].join("\n")
    expect(installed(APPS[0], "win32", () => versioned)).toEqual([bin])
    // InstallLocation is the folder the installer wrote into, ahead of the icon
    const both = versioned.replace('    UninstallString', '    InstallLocation    REG_SZ    "D:\\Apps\\DoubaoWork"\n    UninstallString')
    expect(installed(APPS[0], "win32", () => both)).toEqual([bin])
    // choose takes it once the default place is empty: the app still is 豆包工作
    const c = choose("win32", "C:\\Users\\u", only(bin), () => [bin])
    expect(c.binary).toBe(bin)
    expect(c.app.name).toBe("豆包工作")
    expect(c.dataDir).toBe("C:\\Users\\u\\AppData\\Local\\magpie-doubao-work\\doubaowork")
  }))

// The default place stays the first choice, and the records are not read for
// the app it holds: no reg.exe run for the common install.
test("the default place is taken before any uninstall record is read", () =>
  withEnv(() => {
    const own = "C:\\Users\\u\\AppData\\Local\\DoubaoWork\\Application\\app\\DoubaoWork.exe"
    const asked = []
    const c = choose("win32", "C:\\Users\\u", only(own), (app) => {
      asked.push(app.name)
      return []
    })
    expect(c.binary).toBe(own)
    expect(asked).not.toContain("豆包工作")
  }))

test("both apps' chat pages are the plugin's", () => {
  // 豆包工作 2.36.3's DevTools list, from the real app
  expect(owns([{ url: "doubaowork://doubaowork-login/login?forceLogin=1" }, { url: "doubaowork://doubaowork-chat/chat" }])).toBe(true)
  expect(owns([{ url: "doubaowork://doubaowork-launcher/chat?viewId=101" }, { url: "doubaowork://doubaowork-background/" }])).toBe(false)
  expect(isChat("chrome://doubaowork-chat/chat")).toBe(true)
  expect(isChat("https://doubaowork-chat/chat")).toBe(false)
})

test("owns knows Doubao's chat page", () => {
  expect(owns([{ url: "doubao://doubao-chat/chat" }])).toBe(true)
  expect(owns([{ url: "chrome://newtab" }, { url: "https://doubao-chat/chat" }])).toBe(false)
})

// ---- models ----

test("idFor names a model from what its menu row says", () => {
  expect(idFor("自动")).toBe("auto")
  expect(idFor("豆包 2.1 Lite")).toBe("doubao-2.1-lite")
  expect(idFor("豆包 2.2 Turbo")).toBe("doubao-2.2-turbo")
  expect(idFor("DeepSeek V4.1 Flash")).toBe("deepseek-v4.1-flash")
  expect(idFor("Kimi K3.1 Pro")).toBe("kimi-k3.1-pro")
  expect(idFor("GLM 5.3")).toBe("glm-5.3")
  expect(idFor("星火 4.0")).toBe("model-4.0")
  expect(idFor("")).toBe("auto")
  expect(idFor("纯中文模型").startsWith("model-")).toBe(true)
})

test("tableFrom keeps every model row, and falls back when nothing was read", () => {
  const t = tableFrom([{ label: "自动" }, { label: "GLM 5.3" }, { label: "GLM 5.3" }, { label: "" }])
  expect(Object.keys(t)).toEqual(["auto", "glm-5.3"])
  expect(Object.keys(tableFrom([])).sort()).toEqual(Object.keys(MODELS).sort())
})

test("models.json is read first, and discover rewrites it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-models-"))
  const file = path.join(dir, "models.json")
  fs.writeFileSync(file, JSON.stringify({
    at: Date.now(),
    models: { auto: MODELS.auto, "glm-5.3": { label: "GLM 5.3", name: "GLM 5.3" } },
  }))
  const page = fakePage([], { steps: { menu: { rows: [{ label: "自动" }, { label: "DeepSeek V4.1 Flash" }] } } })
  const d = new Doubao({ app: { start: async () => 1, dataDir: dir }, openPage: async () => page, poll: 1 })
  // the file wins over the built-in list, without opening the app
  expect(Object.keys(d.modelList())).toEqual(["auto", "glm-5.3"])
  const table = await d.discover()
  expect(Object.keys(table)).toEqual(["auto", "deepseek-v4.1-flash"])
  expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).models)).toEqual(["auto", "deepseek-v4.1-flash"])
  // and the rewritten file is what the next start reads
  expect(Object.keys(new Doubao({ app: { start: async () => 1, dataDir: dir } }).modelList())).toEqual(["auto", "deepseek-v4.1-flash"])
  fs.rmSync(dir, { recursive: true, force: true })
})

test("ask picks a model that only the menu knows about", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-models-"))
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({
    at: Date.now(),
    models: { auto: MODELS.auto, "glm-5.3": { label: "GLM 5.3", name: "GLM 5.3" } },
  }))
  const page = fakePage([{ sends: 1, reply: true, text: "ok", reasoning: "", finished: true, reason: "succeed" }])
  const d = new Doubao({ app: { start: async () => 1, dataDir: dir }, openPage: async () => page, poll: 1 })
  await d.ask("x", { model: "glm-5.3" })
  expect(page.calls.some((c) => c.includes('"GLM 5.3"'))).toBe(true)
  fs.rmSync(dir, { recursive: true, force: true })
})

function fakePage(reads, { signedIn = true, steps = {} } = {}) {
  const calls = []
  const keys = []
  return {
    calls,
    keys,
    closed: false,
    async eval(expr) {
      calls.push(expr)
      if (expr === STATE) return { signedIn, name: "yetone", sends: 0 }
      if (expr === NEW_TASK) return steps.newTask ?? ""
      if (expr === CLOUD) return steps.cloud ?? ""
      if (expr === MENU) return steps.menu ?? { rows: [] }
      if (expr === READ) return reads.length > 1 ? reads.shift() : reads[0]
      if (expr.includes("chat_input_action_model")) return steps.model ?? ""
      if (expr.includes("insertContent")) return 10
      throw Error("unexpected eval")
    },
    async key(k) { keys.push(k) },
  }
}

const fakeApp = { start: async () => 1 }

test("ask opens a task on 云电脑, sends, and follows the reply to its end", async () => {
  const page = fakePage([
    { sends: 0, reply: false },
    { sends: 1, reply: false },
    { sends: 1, reply: true, text: "Hel", reasoning: "", finished: false },
    { sends: 1, reply: true, text: "Hello", reasoning: "", finished: true, status: "Success", reason: "succeed:completion", usage: '{"messages":12}' },
  ])
  const d = new Doubao({ app: fakeApp, openPage: async () => page, poll: 1 })
  const seen = []
  const r = await d.ask("hi\nthere", { model: "doubao-2.1-lite", onUpdate: (x) => seen.push(x.text) })
  expect(r.text).toBe("Hello")
  expect(seen).toEqual(["Hel", "Hello"])
  expect(page.keys).toEqual(["Enter"])
  const order = page.calls.map((c) => (c === STATE ? "state" : c === NEW_TASK ? "new" : c === CLOUD ? "cloud" : c.includes("豆包 2.1 Lite") ? "model" : c.includes("insertContent") ? "fill" : "read"))
  expect(order.slice(0, 5)).toEqual(["state", "new", "cloud", "model", "fill"])
  expect(page.calls.find((c) => c.includes("insertContent"))).toContain('["hi","there"]')
})

test("ask refuses when Doubao is signed out, and a paid model with 403", async () => {
  const out = new Doubao({ app: fakeApp, openPage: async () => fakePage([], { signedIn: false }), poll: 1 })
  await expect(out.ask("x")).rejects.toMatchObject({ signIn: "expired", code: "doubao_signed_out" })
  const pro = new Doubao({ app: fakeApp, openPage: async () => fakePage([], { steps: { model: "upgrade" } }), poll: 1 })
  await expect(pro.ask("x", { model: "doubao-2.1-pro" })).rejects.toMatchObject({ status: 403, code: "doubao_upgrade" })
  const stuck = new Doubao({ app: fakeApp, openPage: async () => fakePage([], { steps: { cloud: "no 云电脑 in the mode menu" } }), poll: 1 })
  await expect(stuck.ask("x")).rejects.toMatchObject({ code: "doubao_ui" })
})

test("ask fails a reply that ended empty, and one that stopped growing", async () => {
  const empty = new Doubao({ app: fakeApp, openPage: async () => fakePage([{ sends: 1, reply: true, text: "", reasoning: "", finished: true, status: "Failed", reason: "fail:risk" }]), poll: 1 })
  await expect(empty.ask("x")).rejects.toMatchObject({ code: "doubao_failed", status: 502 })
  const idle = new Doubao({ app: fakeApp, openPage: async () => fakePage([{ sends: 1, reply: true, text: "a", reasoning: "", finished: false }]), poll: 1, idle: 20 })
  await expect(idle.ask("x")).rejects.toMatchObject({ code: "doubao_timeout" })
})

test("requests run one at a time", async () => {
  let open = 0
  let most = 0
  const page = fakePage([{ sends: 1, reply: true, text: "ok", reasoning: "", finished: true, reason: "succeed" }])
  const ev = page.eval.bind(page)
  page.eval = async (e) => {
    if (e === NEW_TASK) { open++; most = Math.max(most, open) }
    if (e === READ) { await new Promise((r) => setTimeout(r, 5)); open-- }
    return ev(e)
  }
  const d = new Doubao({ app: fakeApp, openPage: async () => page, poll: 1 })
  await Promise.all([d.ask("a"), d.ask("b"), d.ask("c")])
  expect(most).toBe(1)
})

test("an aborted ask stops", async () => {
  const d = new Doubao({ app: fakeApp, openPage: async () => fakePage([{ sends: 1, reply: true, text: "a", reasoning: "", finished: false }]), poll: 5 })
  const ac = new AbortController()
  const p = d.ask("x", { signal: ac.signal })
  setTimeout(() => ac.abort(), 20)
  await expect(p).rejects.toBeDefined()
})

// ---- cdp ----

test("App reuses its own running app and never drives a port someone else took", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-"))
  try {
    fs.writeFileSync(path.join(dir, "port"), "4567")
    const bin = path.join(dir, "app")
    fs.writeFileSync(bin, "")
    const spawned = []
    const mk = (pages) =>
      new App({
        binary: bin,
        dataDir: dir,
        owns,
        spawn: (...a) => { spawned.push(a); return { unref() {} } },
        others: () => [],
        fetchImpl: async (url) => Response.json(String(url).includes(":4567/") ? pages : [{ type: "page", url: "doubao://doubao-chat/chat" }]),
      })
    expect(await mk([{ type: "page", url: "doubao://doubao-chat/chat" }]).start()).toBe(4567)
    expect(spawned.length).toBe(0)
    const port = await mk([{ type: "page", url: "https://example.com" }]).start({ timeout: 2000 })
    expect(port).not.toBe(4567)
    expect(spawned[0][1]).toEqual([`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(dir, "profile")}`])
    expect(fs.readFileSync(path.join(dir, "port"), "utf8")).toBe(String(port))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("App says at once that a copy the user opened keeps it from starting", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-"))
  try {
    const bin = path.join(dir, "app")
    fs.writeFileSync(bin, "")
    const spawned = []
    const mk = (others) =>
      new App({ binary: bin, dataDir: dir, owns, others: () => others, spawn: (...a) => { spawned.push(a); return { unref() {} } }, fetchImpl: async () => { throw Error("refused") } })
    await expect(mk([bin]).start({ timeout: 60000 })).rejects.toMatchObject({ code: "app_busy" })
    await expect(mk([`${bin} --type=gpu --user-data-dir=/elsewhere`]).start({ timeout: 60000 })).rejects.toMatchObject({ code: "app_busy" })
    expect(spawned.length).toBe(0)
    // its own copy, still starting, is waited for
    await expect(mk([`${bin} --user-data-dir=${path.join(dir, "profile")}`]).start({ timeout: 500 })).rejects.toMatchObject({ code: "app_start_timeout" })
    expect(spawned.length).toBe(1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("copies lists the binary's own processes only", () => {
  expect(copies("/no/such/binary-" + Date.now())).toEqual([])

})

test("waitSignedIn says the app not starting at once, and waits for a window still loading", async () => {
  const busy = new Doubao({ app: { start: async () => { throw Object.assign(Error("busy"), { code: "app_busy" }) } }, poll: 1 })
  await expect(busy.waitSignedIn({ timeout: 60000 })).rejects.toMatchObject({ code: "app_busy" })
  let n = 0
  const loading = new Doubao({ app: fakeApp, openPage: async () => (++n < 2 ? null : fakePage([])), poll: 1 })
  expect(await loading.waitSignedIn({ timeout: 60000 })).toMatchObject({ signedIn: true })
})

test("App says when the app is not installed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-"))
  try {
    const app = new App({ binary: path.join(dir, "nope"), dataDir: dir, owns, fetchImpl: async () => { throw Error("refused") } })
    await expect(app.start()).rejects.toMatchObject({ code: "app_missing" })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

class FakeWS {
  constructor(url) {
    this.url = url
    this.sent = []
    queueMicrotask(() => this.onopen?.())
  }
  send(s) {
    const m = JSON.parse(s)
    this.sent.push(m)
    queueMicrotask(() => {
      if (m.params?.expression === "throw") this.onmessage({ data: JSON.stringify({ id: m.id, result: { exceptionDetails: { exception: { description: "Error: boom\n at x" } } } }) })
      else this.onmessage({ data: JSON.stringify({ id: m.id, result: { result: { value: m.params?.expression === "1+1" ? 2 : null } } }) })
    })
  }
  close() { this.onclose?.() }
}

test("Page evaluates, turns page exceptions into errors, and fails calls once closed", async () => {
  const page = await Page.open(1, (t) => t.url.includes("chat"), {
    fetchImpl: async () => Response.json([{ type: "page", url: "doubao://doubao-chat/chat", webSocketDebuggerUrl: "ws://x" }]),
    WebSocketImpl: FakeWS,
  })
  expect(await page.eval("1+1")).toBe(2)
  await expect(page.eval("throw")).rejects.toThrow("page: Error: boom")
  await page.key("Enter", { keyCode: 13, text: "\r" })
  expect(page.ws.sent.filter((m) => m.method === "Input.dispatchKeyEvent").map((m) => m.params.type)).toEqual(["keyDown", "keyUp"])
  page.ws.close()
  await expect(page.eval("1+1")).rejects.toThrow("closed")
})

// ---- plugin ----

const req = (body) => new Request(I.BASE + "/chat/completions", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })

test("the plugin serves chat completions through Doubao, whole and streamed", async () => {
  const asked = []
  const doubao = {
    ask: async (prompt, { model, onUpdate }) => {
      asked.push({ prompt, model })
      onUpdate?.({ text: "Hi", reasoning: "" })
      return { text: "Hi there", reasoning: "", usage: '{"messages":42}' }
    },
  }
  const p = I.createPlugin({ doubao, newId: ids })
  const cfg = {}
  await p.config(cfg)
  expect(Object.keys(cfg.provider["doubao-work"].models)).toEqual(["auto", "doubao-2.1-lite", "doubao-2.1-pro"])
  for (const m of Object.values(cfg.provider["doubao-work"].models)) {
    expect(m.name).not.toContain("豆包工作")
    expect(m.modalities.input).toEqual(["text"])
  }
  const loader = await p.auth.loader(async () => ({}))
  const whole = await (await loader.fetch(req({ model: "doubao-2.1-lite", messages: [{ role: "user", content: "hello" }] }))).json()
  expect(whole.choices[0].message.content).toBe("Hi there")
  expect(whole.usage.prompt_tokens).toBe(42)
  expect(asked[0].model).toBe("doubao-2.1-lite")
  expect(asked[0].prompt).toContain("[user]\nhello")
  const streamed = await events(await loader.fetch(req({ model: "auto", stream: true, messages: [{ role: "user", content: "hello" }] })))
  expect(streamed.filter((e) => e.choices?.[0]?.delta?.content).map((e) => e.choices[0].delta.content).join("")).toBe("Hi there")
  expect((await loader.fetch(req({ model: "gpt-9", messages: [] }))).status).toBe(404)
  expect((await loader.fetch(new Request("https://elsewhere.example/v1/chat/completions", { method: "POST", body: "{}" }))).status).toBe(404)
})

test("the plugin lists the models models.json has, not only the built-in ones", async () => {
  const table = { auto: MODELS.auto, "glm-5.3": { label: "GLM 5.3", name: "GLM 5.3" } }
  const p = I.createPlugin({ doubao: { modelList: () => table, ask: async () => ({ text: "ok", reasoning: "" }) } })
  const cfg = {}
  await p.config(cfg)
  expect(Object.keys(cfg.provider["doubao-work"].models)).toEqual(["auto", "glm-5.3"])
  // a model the user declared keeps their settings
  const own = { provider: { "doubao-work": { models: { "glm-5.3": { name: "mine", limit: { context: 1000, output: 10 } } } } } }
  await p.config(own)
  expect(own.provider["doubao-work"].models["glm-5.3"].name).toBe("mine")
  expect(own.provider["doubao-work"].models.auto.name).toBe("自动")
  expect(Object.keys(await p.provider.models({}, {}))).toEqual(["auto", "glm-5.3"])
  const loader = await p.auth.loader(async () => ({}))
  expect((await loader.fetch(req({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }] }))).status).toBe(200)
  expect((await loader.fetch(req({ model: "gpt-9", messages: [] }))).status).toBe(404)
})

test("the plugin passes a sign-out on for re-sign-in and other failures as HTTP errors", async () => {
  const fail = (e) => I.createPlugin({ doubao: { ask: async () => { throw e } } })
  const out = await fail(Object.assign(Error("signed out"), { signIn: "expired" })).auth.loader(async () => ({}))
  await expect(out.fetch(req({ model: "auto", messages: [] }))).rejects.toMatchObject({ signIn: "expired" })
  const missing = await fail(Object.assign(Error("not installed"), { code: "app_missing" })).auth.loader(async () => ({}))
  expect((await missing.fetch(req({ model: "auto", stream: true, messages: [] }))).status).toBe(503)
  const busy = await fail(Object.assign(Error("busy"), { code: "app_busy" })).auth.loader(async () => ({}))
  const rb = await busy.fetch(req({ model: "auto", messages: [] }))
  expect(rb.status).toBe(503)
  expect((await rb.json()).error.message).toContain("退出豆包")
  const paid = await fail(Object.assign(Error("upgrade"), { code: "doubao_upgrade", status: 403 })).auth.loader(async () => ({}))
  const r = await paid.fetch(req({ model: "auto", messages: [] }))
  expect(r.status).toBe(403)
  expect((await r.json()).error.type).toBe("doubao_upgrade")
})

test("sign-in waits for the Doubao window's account", async () => {
  const mac = () => ({ app: { name: "豆包工作", download: "https://www.doubao.com/work" }, binary: "/Applications/DoubaoWork.app/Contents/MacOS/DoubaoWork" })
  const ok = I.createPlugin({ pick: mac, doubao: { waitSignedIn: async () => ({ signedIn: true, name: "yetone" }) } })
  const r = await (await ok.auth.methods[0].authorize()).callback()
  expect(r).toMatchObject({ type: "success", accountId: "豆包工作 · yetone" })
  const late = I.createPlugin({ pick: mac, doubao: { waitSignedIn: async () => null } })
  expect(await (await late.auth.methods[0].authorize()).callback()).toMatchObject({ type: "failed", error: expect.stringContaining("五分钟") })
  const busy = I.createPlugin({ pick: mac, doubao: { waitSignedIn: async () => { throw Object.assign(Error("busy"), { code: "app_busy" }) } } })
  const b = await (await busy.auth.methods[0].authorize()).callback()
  expect(b.type).toBe("failed")
  expect(b.error).toContain("退出豆包工作")
  const gone = I.createPlugin({ pick: mac, doubao: { waitSignedIn: async () => { throw Object.assign(Error("gone"), { code: "app_missing" }) } } })
  expect(await (await gone.auth.methods[0].authorize()).callback()).toMatchObject({ type: "failed", error: "没有找到豆包工作，请先安装：https://www.doubao.com/work" })
  const linux = I.createPlugin({ pick: () => ({ app: { name: "豆包工作" }, binary: "" }), doubao: { waitSignedIn: async () => ({ signedIn: true, name: "x" }) } })
  expect(await (await linux.auth.methods[0].authorize()).callback()).toMatchObject({ type: "failed", error: expect.stringContaining("没有 Linux 版") })
})

test("an abort between two polls stops the ask too", async () => {
  const ac = new AbortController()
  const page = fakePage([{ sends: 1, reply: true, text: "a", reasoning: "", finished: false }])
  const ev = page.eval.bind(page)
  page.eval = async (e) => {
    if (e === READ) ac.abort()
    return ev(e)
  }
  const d = new Doubao({ app: fakeApp, openPage: async () => page, poll: 1 })
  await expect(d.ask("x", { signal: ac.signal })).rejects.toBeDefined()
})
