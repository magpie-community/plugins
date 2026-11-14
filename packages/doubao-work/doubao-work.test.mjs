import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { App, Page, copies, portIn } from "./cdp.mjs"
import { Doubao, NEW_TASK, CLOUD, MENU, LIST, SEND, READ, STATE, MODELS, EFFORT, idFor, tableFrom, listOf, lookup, effortFor, rateIn, APPS, binary, choose, dataDir, installedAt, hintsWin, hintsMac, owns, isChat, usageOf, QUOTA, quotaOf, rateOf } from "./doubao.mjs"
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

// ul3140773077392 on X: 豆包工作 installed in D:\Apps\DoubaoWork
test("an install outside the usual place is found from what the system knows", () =>
  withEnv(() => {
    const exe = "D:\\Apps\\DoubaoWork\\Application\\app\\DoubaoWork.exe"
    const hints = ['"D:\\Apps\\DoubaoWork\\Application\\uninstall.exe" /allusers', "D:\\Apps\\DoubaoWork\\Application\\icon.ico,0"]
    let asked = 0
    const find = () => (asked++, hints)
    expect(binary("win32", "C:\\Users\\u", only(exe), find)).toBe(exe)
    expect(choose("win32", "C:\\Users\\u", only(exe), find).app.name).toBe("豆包工作")
    // the usual place wins and the system is not asked
    const usual = "C:\\Users\\u\\AppData\\Local\\DoubaoWork\\Application\\app\\DoubaoWork.exe"
    asked = 0
    expect(binary("win32", "C:\\Users\\u", only(usual, exe), find)).toBe(usual)
    expect(asked).toBe(0)
    // a running copy's path, an InstallLocation folder with a trailing slash, an App Paths exe
    expect(installedAt(APPS[0], ["D:\\Apps\\DoubaoWork\\"], "win32")).toContain(exe)
    expect(installedAt(APPS[0], ["E:\\x\\DoubaoWork\\app\\DoubaoWork.exe"], "win32")[0]).toBe("E:\\x\\DoubaoWork\\app\\DoubaoWork.exe")
    // 豆包's hints never give 豆包工作's binary
    expect(installedAt(APPS[0], ["D:\\Apps\\Doubao\\Application\\icon.ico"], "win32").every((p) => p.endsWith("DoubaoWork.exe"))).toBe(true)
    // macOS: a bundle Spotlight or ps found
    const mac = "/Volumes/Data/Apps/DoubaoWork.app/Contents/MacOS/DoubaoWork"
    expect(binary("darwin", "/Users/u", only(mac), () => ["/Volumes/Data/Apps/DoubaoWork.app", "/Volumes/Data/Apps/Doubao.app"])).toBe(mac)
    expect(installedAt(APPS[1], ["/Volumes/Data/Apps/DoubaoWork.app"], "darwin")).toEqual([])
    // a finder that finds nothing or throws leaves the usual answer
    expect(binary("win32", "C:\\Users\\u", only(), () => [])).toBe(usual)
  }))

test("the Windows and macOS finders read the system's answer and survive its failure", () => {
  expect(hintsWin(() => '["D:\\\\Apps\\\\DoubaoWork\\\\Application\\\\icon.ico,0"]')).toEqual(["D:\\Apps\\DoubaoWork\\Application\\icon.ico,0"])
  expect(hintsWin(() => '"D:\\\\one"')).toEqual(["D:\\one"])
  expect(hintsWin(() => { throw Error("no powershell") })).toEqual([])
  expect(hintsWin(() => "not json")).toEqual([])
  const run = (cmd) => (cmd.endsWith("mdfind") ? "/Volumes/D/DoubaoWork.app\n" : "/Volumes/E/Doubao.app/Contents/MacOS/Doubao\n")
  const got = hintsMac(run)
  expect(got).toContain("/Volumes/D/DoubaoWork.app")
  expect(got).toContain("/Volumes/E/Doubao.app/Contents/MacOS/Doubao")
  expect(hintsMac(() => { throw Error("x") })).toBeInstanceOf(Array)
})

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

test("Kimi K3.1 Pro and Kimi K3.1 Pro 高速 are two models, and an unspellable suffix never merges two rows", () => {
  expect(idFor("Kimi K3.1 Pro 高速")).toBe("kimi-k3.1-pro-fast")
  const t = tableFrom([{ label: "Kimi K3.1 Pro" }, { label: "Kimi K3.1 Pro 高速" }, { label: "星火 4.0 快" }, { label: "星火 4.0 慢" }])
  expect(Object.values(t).map((m) => m.label)).toEqual(["Kimi K3.1 Pro", "Kimi K3.1 Pro 高速", "星火 4.0 快", "星火 4.0 慢"])
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
    v: 2,
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
    v: 2,
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
      if (expr === LIST) return typeof steps.list === "function" ? steps.list() : steps.list ?? { error: "no list step" }
      if (expr === QUOTA) return steps.quota ?? { error: "no quota step" }
      if (expr === SEND) return steps.send ?? false
      if (expr === READ) return reads.length > 1 ? reads.shift() : reads[0]
      if (expr.includes("推理强度")) return steps.effort ?? ""
      if (expr.includes("chat_input_action_model")) return typeof steps.model === "function" ? steps.model(expr) : steps.model ?? ""
      if (expr.includes("insertContent")) return 10
      throw Error("unexpected eval")
    },
    async key(k) { keys.push(k) },
    async call(method, params) { calls.push(method); return steps.call?.(method, params) ?? {} },
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
    expect(fs.existsSync(path.join(dir, "port"))).toBe(false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// #1117: on Windows a second launch handed itself to the copy already up
// on the plugin's profile, and start waited on a port nothing listened on
test("App waits for its own copy on that copy's port instead of starting another", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-"))
  try {
    const bin = path.join(dir, "app.exe")
    fs.writeFileSync(bin, "")
    fs.writeFileSync(path.join(dir, "port"), "1111")
    const spawned = []
    const own = `"${bin}" --remote-debugging-port=4321 --user-data-dir=${path.join(dir, "profile")}`
    let ready = false
    setTimeout(() => (ready = true), 600)
    const app = new App({
      binary: bin, dataDir: dir, owns, platform: "win32",
      // a copy the user opened on their own profile doesn't count on Windows
      others: () => [`"${bin}"`, own],
      spawn: (...a) => { spawned.push(a); return { unref() {} } },
      fetchImpl: async (url) => {
        if (!String(url).includes(":4321/") || !ready) throw Error("refused")
        return Response.json([{ type: "page", url: "doubao://doubao-chat/chat" }])
      },
    })
    expect(await app.start({ timeout: 5000 })).toBe(4321)
    expect(spawned.length).toBe(0)
    expect(fs.readFileSync(path.join(dir, "port"), "utf8")).toBe("4321")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("copies lists the binary's own processes only", () => {
  expect(copies("/no/such/binary-" + Date.now())).toEqual([])
  const wmi = ["C:\\D\\Doubao.exe --remote-debugging-port=5 --user-data-dir=C:\\p", "C:\\D\\Doubao.exe --type=renderer --user-data-dir=C:\\p", "", "\"C:\\D\\Doubao.exe\""].join("\r\n")
  let asked
  expect(copies("C:\\D\\Doubao.exe", "win32", (cmd, args) => { asked = [cmd, args.at(-1)]; return wmi })).toEqual(["C:\\D\\Doubao.exe --remote-debugging-port=5 --user-data-dir=C:\\p", "\"C:\\D\\Doubao.exe\""])
  expect(asked[0]).toBe("powershell.exe")
  expect(asked[1]).toContain("Name='Doubao.exe'")
  expect(copies("C:\\D\\Doubao.exe", "win32", () => { throw Error("no wmi") })).toEqual([])
  expect(portIn("x --remote-debugging-port=9222 y")).toBe(9222)
  expect(portIn("x")).toBe(0)

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

test("a model the app added since the last read is found at once, and a made-up one opens the menu once a minute at most (#1048)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-models-"))
  // the list was read minutes ago, before Doubao added Kimi
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({
    v: 2,
    at: Date.now(),
    models: { auto: MODELS.auto, "doubao-2.1-lite": MODELS["doubao-2.1-lite"] },
  }))
  const rows = [{ label: "自动" }, { label: "豆包 2.1 Lite" }, { label: "Kimi K3.1 Pro" }, { label: "GLM 5.3 Flash" }]
  const page = fakePage([], { steps: { menu: { rows } } })
  const d = new Doubao({ app: { start: async () => 1, dataDir: dir }, openPage: async () => page, poll: 1 })
  const menus = () => page.calls.filter((c) => c === MENU).length
  expect(await d.known("doubao-2.1-lite")).toBe(true)
  expect(menus()).toBe(0)
  expect(await d.known("kimi-k3.1-pro")).toBe(true)
  expect(menus()).toBe(1)
  expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8")).models)).toContain("glm-5.3-flash")
  // a made-up name in the same minute doesn't open the menu again
  expect(await d.known("gpt-9")).toBe(false)
  expect(menus()).toBe(1)
  d.missAt -= 61000
  expect(await d.known("gpt-9")).toBe(false)
  expect(menus()).toBe(2)
  expect(await d.known("gpt-10")).toBe(false)
  expect(menus()).toBe(2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("a menu that can't be read leaves the model unknown, not the list emptied (#1048)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-models-"))
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ v: 2, at: Date.now(), models: { auto: MODELS.auto } }))
  const page = fakePage([], { steps: { menu: { error: "no model menu" } } })
  const d = new Doubao({ app: { start: async () => 1, dataDir: dir }, openPage: async () => page, poll: 1 })
  expect(await d.known("kimi-k3")).toBe(false)
  expect(Object.keys(d.modelList())).toEqual(["auto"])
  fs.rmSync(dir, { recursive: true, force: true })
})

test("the plugin asks Doubao's menu again for a model its list lacks, and names the models it has (#1048)", async () => {
  let table = { auto: MODELS.auto }
  const asked = []
  const doubao = {
    modelList: () => table,
    known: async (model) => {
      asked.push(model)
      table = { auto: MODELS.auto, "kimi-k3": { label: "Kimi K3", name: "Kimi K3" } }
      return !!table[model]
    },
    ask: async () => ({ text: "ok", reasoning: "" }),
  }
  const loader = await I.createPlugin({ doubao, newId: ids }).auth.loader(async () => ({}))
  expect((await loader.fetch(req({ model: "doubao-work/kimi-k3", messages: [{ role: "user", content: "hi" }] }))).status).toBe(200)
  const r = await loader.fetch(req({ model: "gpt-9", messages: [] }))
  expect(r.status).toBe(404)
  expect((await r.json()).error.message).toBe("没有模型 gpt-9。豆包工作的模型有：auto、kimi-k3。")
  expect(asked).toEqual(["kimi-k3", "gpt-9"])
  // a model the list has never asks the menu
  expect((await loader.fetch(req({ model: "auto", messages: [{ role: "user", content: "hi" }] }))).status).toBe(200)
  expect(asked).toEqual(["kimi-k3", "gpt-9"])
})

test("a list never read from the menu is read when the plugin lists models, once a minute at most", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-models-"))
  const labels = ["自动", "豆包 2.1 Lite", "豆包 2.1 Pro", "DeepSeek V4.1 Flash", "Kimi K3.1 Pro", "Kimi K3.1 Pro 高速", "Kimi K3", "GLM 5.3", "GLM 5.3 Flash", "DeepSeek V4 Pro"]
  const page = fakePage([], { steps: { menu: { rows: labels.map((label) => ({ label })) } } })
  const d = new Doubao({ app: { start: async () => 1, running: async () => 1, dataDir: dir }, openPage: async () => page, poll: 1 })
  const p = I.createPlugin({ doubao: d })
  const listed = await p.provider.models({}, {})
  expect(Object.values(listed).map((m) => m.name)).toEqual(labels)
  await p.provider.models({}, {})
  expect(page.calls.filter((c) => c === MENU).length).toBe(1)
  // a menu that fails is not asked again within the minute
  const bad = fakePage([], { steps: { menu: { error: "no model menu" } } })
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-models-"))
  const d2 = new Doubao({ app: { start: async () => 1, running: async () => 1, dataDir: dir2 }, openPage: async () => bad, poll: 1 })
  await d2.ensureList(); await d2.ensureList()
  expect(bad.calls.filter((c) => c === MENU).length).toBe(1)
  expect(Object.keys(d2.modelList())).toEqual(Object.keys(MODELS))
  // an app never started by the plugin (no data folder) is not opened
  const d3 = new Doubao({ app: { start: async () => { throw new Error("opened") }, dataDir: path.join(dir, "none") }, openPage: async () => page })
  await d3.ensureList()
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir2, { recursive: true, force: true })
})

test("picking a model from the full list presses that row in the app", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-models-"))
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ v: 2, at: Date.now(), models: tableFrom([{ label: "自动" }, { label: "Kimi K3.1 Pro 高速" }, { label: "DeepSeek V4 Pro" }]) }))
  const page = fakePage([{ sends: 1, reply: true, text: "ok", reasoning: "", finished: true, reason: "succeed" }])
  const d = new Doubao({ app: { start: async () => 1, dataDir: dir }, openPage: async () => page, poll: 1 })
  expect(Object.keys(d.modelList())).toEqual(["auto", "kimi-k3.1-pro-fast", "deepseek-v4-pro"])
  await d.ask("x", { model: "kimi-k3.1-pro-fast" })
  expect(page.calls.some((c) => c.includes('"Kimi K3.1 Pro 高速"'))).toBe(true)
  fs.rmSync(dir, { recursive: true, force: true })
})

// quota/summary as the app's page answered it for a 标准套餐 account
const SUMMARY = { status: 200, body: { data: { current_subscription: { display: { product_name: "个人订阅", short_name: "标准套餐" } }, window_limit_section: { entitlement_count: 1, usage_exhausted: false, window_limit_groups: [{ feature_group: "general", window_limits: [{ end_time: 0, item_type: 0, less_than_one_percent: false, start_time: 0, used_percent: 0, window_type: 2 }] }] } }, code: 0 } }

test("the plugin tells the plan's allowance from quota/summary instead of 暂无额度数据", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-quota-"))
  const page = fakePage([], { steps: { quota: SUMMARY } })
  const d = new Doubao({ app: { start: async () => 1, running: async () => 1, dataDir: dir }, openPage: async () => page, poll: 1 })
  const p = I.createPlugin({ doubao: d })
  const u = await p.auth.usage(async () => ({}))
  expect(u).toEqual({ plan: "标准套餐", windows: [{ name: "额度", used: 0 }] })
  // a window with times is named by its span and says when it resets
  const w = quotaOf({ body: { data: { window_limit_section: { window_limit_groups: [{ window_limits: [
    { start_time: 1000, end_time: 1000 + 5 * 3600000, used_percent: 42.5 },
    { start_time: 1000, end_time: 1000 + 7 * 86400000, used_percent: 8 }] }] } } } })
  expect(w.windows).toEqual([{ name: "5 小时", used: 42.5, resetsAt: 1000 + 5 * 3600000 }, { name: "每周", used: 8, resetsAt: 1000 + 7 * 86400000 }])
  // an exhausted plan reads 100%
  expect(quotaOf({ body: { data: { window_limit_section: { usage_exhausted: true, window_limit_groups: [{ window_limits: [{ used_percent: 99 }] }] } } } }).windows[0].used).toBe(100)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("a quota that can't be read says why and keeps the sign-in", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-quota-"))
  const mk = (quota, dataDir = dir) => I.createPlugin({ doubao: new Doubao({ app: { start: async () => 1, running: async () => 1, dataDir }, openPage: async () => fakePage([], { steps: { quota } }), poll: 1 }) })
  for (const [quota, want] of [[{ status: 401, body: null }, "过期"], [{ status: 200, body: {} }, "没有额度数据"], [{ error: "Failed to fetch" }, "Failed to fetch"]]) {
    const u = await mk(quota).auth.usage(async () => ({}))
    expect(u.signIn).toBe("kept")
    expect(u.error).toContain(want)
  }
  // an app the plugin never started is not opened for a usage read
  const u = await mk(SUMMARY, path.join(dir, "none")).auth.usage(async () => ({}))
  expect(u.error).toContain("还没有登录")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("a model's multiple is read from its menu row and given as rate", () => {
  expect(rateOf(["2x 额度"])).toBe(2)
  expect(rateOf(["×0.5"])).toBe(0.5)
  expect(rateOf(["消耗 1.5 倍"])).toBe(1.5)
  expect(rateOf(["256K 上下文", "V4.1"])).toBe(0)
  expect(rateOf([])).toBe(0)
  const table = tableFrom([{ label: "自动" }, { label: "Kimi K3.1 Pro", lines: ["x2"] }, { label: "GLM 5.3", lines: ["0.5倍额度"] }, { label: "DeepSeek V4 Pro", lines: ["推理强度"] }])
  expect(table.auto.rate).toBeUndefined()
  expect(table["kimi-k3.1-pro"].rate).toBe(2)
  expect(table["glm-5.3"].rate).toBe(0.5)
  const out = I.models(table)
  expect(out["kimi-k3.1-pro"].rate).toBe(2)
  expect("rate" in out["deepseek-v4-pro"]).toBe(false)
})

// ---- the model list from brief_list ----

// LIST's reply as the 豆包工作 app's page got it on 2026-11-13 (icons left
// out, as LIST leaves them out)
const BRIEF = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "testdata", "brief-list-2026-11-13.json"), "utf8"))
const WORK = ["自动", "豆包 2.1 Lite", "豆包 2.1 Pro", "DeepSeek V4.1 Flash", "Kimi K3.1 Pro", "Kimi K3.1 Pro 高速", "Kimi K3", "GLM 5.3", "GLM 5.3 Flash", "DeepSeek V4 Pro"]

test("listOf reads 工作任务's models, Doubao's ids and 推理强度 from brief_list", () => {
  const rows = listOf(BRIEF)
  expect(rows.map((r) => r.label)).toEqual(WORK)
  const flash = rows.find((r) => r.label === "DeepSeek V4.1 Flash")
  expect(flash).toMatchObject({ key: "person-deepseek-v4-1-flash-261017", efforts: ["低", "中", "高", "极高", "最高"], effort: "高" })
  expect(rows.find((r) => r.label === "GLM 5.3").efforts).toEqual(["低", "高", "最高"])
  const t = tableFrom(rows)
  expect(Object.keys(t)).toEqual(["auto", "doubao-2.1-lite", "doubao-2.1-pro", "deepseek-v4.1-flash", "kimi-k3.1-pro", "kimi-k3.1-pro-fast", "kimi-k3", "glm-5.3", "glm-5.3-flash", "deepseek-v4-pro"])
  expect(t.auto).toMatchObject({ label: "自动", key: "9" })
  // a request may name a model by the plugin's id, Doubao's own id or its name
  expect(lookup(t, "person-deepseek-v4-1-flash-261017").label).toBe("DeepSeek V4.1 Flash")
  expect(lookup(t, "Kimi K3.1 Pro 高速").key).toBe("person-kimi-k3-1-pro-highspeed-261111")
  expect(lookup(t, "gpt-9")).toBe(null)
  // a reply that failed, or has no 工作任务, is no list
  expect(listOf({ status: 200, code: 710010702, msg: "系统错误" })).toBe(null)
  expect(listOf({ conf: { mode_list: { item_list: [{ mode_id: "1", name: "快速", agent_mode: 0, conversation_mode_list: ["chat"] }] }, model_list: { item_list: [{ name: "快速", model_item_key: "1" }] } } })).toBe(null)
  // a 工作任务 that lists only the keys it supports takes them from the shared list
  const shared = { conf: { mode_list: { item_list: [{ mode_id: "3", agent_mode: 1, support_models: [{ model_item_key: "b" }] }] }, model_list: { item_list: [{ name: "A", model_item_key: "a" }, { name: "B", model_item_key: "b" }] } } }
  expect(listOf(shared).map((r) => r.label)).toEqual(["B"])
})

test("discover takes brief_list's list over the menu, so the 对话 menu's 快速 and 专家 are never the list", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-models-"))
  // the 豆包 app sitting on a 对话 page: its model menu is 快速 and 专家
  const page = fakePage([], { steps: { list: BRIEF, menu: { rows: [{ label: "快速" }, { label: "专家" }] } } })
  const d = new Doubao({ app: { start: async () => 1, dataDir: dir }, openPage: async () => page, poll: 1 })
  const t = await d.discover()
  expect(Object.values(t).map((m) => m.label)).toEqual(WORK)
  expect(page.calls.includes(MENU)).toBe(false)
  // brief_list failing falls back to the menu of a new work task, not the
  // page's current menu
  const p2 = fakePage([], { steps: { list: { status: 200, code: 710010702 }, menu: { rows: [{ label: "自动" }, { label: "Kimi K3" }] } } })
  const d2 = new Doubao({ app: { start: async () => 1, dataDir: dir }, openPage: async () => p2, poll: 1 })
  expect(Object.keys(await d2.discover())).toEqual(["auto", "kimi-k3"])
  expect(p2.calls.indexOf(NEW_TASK)).toBeGreaterThan(-1)
  expect(p2.calls.indexOf(NEW_TASK)).toBeLessThan(p2.calls.indexOf(MENU))
  fs.rmSync(dir, { recursive: true, force: true })
})

test("a models.json 0.1.9 wrote from the 对话 menu (快速, 专家) is read again from brief_list", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-models-"))
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ at: Date.now(), models: tableFrom([{ label: "快速" }, { label: "专家" }]) }))
  const page = fakePage([], { steps: { list: BRIEF } })
  const d = new Doubao({ app: { start: async () => 1, running: async () => 1, dataDir: dir }, openPage: async () => page, poll: 1 })
  const p = I.createPlugin({ doubao: d })
  const listed = await p.provider.models({}, {})
  expect(Object.values(listed).map((m) => m.name)).toEqual(WORK)
  expect(JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8")).v).toBe(2)
  fs.rmSync(dir, { recursive: true, force: true })
})

// #1117: listing models and reading usage brought Doubao up on Windows
// whenever magpie asked, with no request sent
test("models() and usage never start Doubao: they read from a window already open", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-closed-"))
  fs.mkdirSync(path.join(dir, "profile"))
  let started = 0
  const app = { start: async () => { started++; return 1 }, running: async () => 0, dataDir: dir }
  const page = fakePage([], { steps: { list: BRIEF, quota: SUMMARY } })
  const d = new Doubao({ app, openPage: async () => page, poll: 1 })
  const p = I.createPlugin({ doubao: d })
  const listed = await p.provider.models({}, {})
  expect(Object.keys(listed).length).toBeGreaterThan(0)
  const u = await p.auth.usage(async () => ({}))
  expect(u.signIn).toBe("kept")
  expect(u.error).toContain("没有打开")
  expect(started).toBe(0)
  // open, the same window is read for both
  app.running = async () => 1
  d.readAt = 0
  expect(Object.values(await p.provider.models({}, {})).map((m) => m.name)).toEqual(WORK)
  expect((await p.auth.usage(async () => ({}))).error).toBeUndefined()
  expect(started).toBe(0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("a models.json from an older version keeps its models until the list is read again", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-models-"))
  const table = tableFrom([{ label: "快速" }, { label: "自动" }, { label: "Kimi K3.1 Pro" }])
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ v: 1, at: Date.now(), models: table }))
  const d = new Doubao({ app: { start: async () => 1, running: async () => 0, dataDir: dir }, poll: 1 })
  expect(Object.keys(d.modelList())).toEqual(["auto", "kimi-k3.1-pro"])
  expect(d.tableAt).toBe(0)
  expect(await d.known("kimi-k3.1-pro")).toBe(true)
})

test("effortFor takes the client's reasoning effort to the nearest 推理强度 the model has", () => {
  const five = ["低", "中", "高", "极高", "最高"]
  expect(effortFor("low", five)).toBe("低")
  expect(effortFor("medium", five)).toBe("中")
  expect(effortFor("high", five)).toBe("高")
  expect(effortFor("xhigh", five)).toBe("极高")
  expect(effortFor("max", five)).toBe("最高")
  expect(effortFor("minimal", five)).toBe("低")
  expect(effortFor("none", five)).toBe("低")
  // GLM 5.3 has 低, 高 and 最高: medium and xhigh go one up
  expect(effortFor("medium", ["低", "高", "最高"])).toBe("高")
  expect(effortFor("xhigh", ["低", "高", "最高"])).toBe("最高")
  // nothing asked, an unknown effort or a model without levels keeps Doubao's default
  expect(effortFor("", five)).toBe("")
  expect(effortFor("turbo", five)).toBe("")
  expect(effortFor("high", undefined)).toBe("")
})

test("ask picks the model and the 推理强度 the client asked for", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-models-"))
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ v: 2, at: Date.now(), models: tableFrom(listOf(BRIEF)) }))
  const ok = { sends: 1, reply: true, text: "ok", reasoning: "", finished: true, reason: "succeed" }
  const page = fakePage([ok])
  const d = new Doubao({ app: { start: async () => 1, dataDir: dir }, openPage: async () => page, poll: 1 })
  await d.ask("x", { model: "person-deepseek-v4-1-flash-261017", effort: "xhigh" })
  expect(page.calls).toContain(EFFORT("极高"))
  expect(page.calls.some((c) => c.includes('"DeepSeek V4.1 Flash"') && c.includes("chat_input_action_model") && !c.includes("推理强度"))).toBe(true)
  // the model before its effort: the effort menu is the picked model's
  const i = page.calls.findIndex((c) => c.includes('"DeepSeek V4.1 Flash"'))
  expect(i).toBeLessThan(page.calls.indexOf(EFFORT("极高")))
  // no effort asked: the model's own default (GLM 5.3's is 高), not the
  // level the last request left the app on
  const p2 = fakePage([ok])
  await new Doubao({ app: { start: async () => 1, dataDir: dir }, openPage: async () => p2, poll: 1 }).ask("x", { model: "glm-5.3" })
  expect(p2.calls).toContain(EFFORT("高"))
  // a model without levels presses nothing
  const p4 = fakePage([ok])
  await new Doubao({ app: fakeApp, openPage: async () => p4, poll: 1 }).ask("x", { model: "auto" })
  expect(p4.calls.some((c) => c.includes("推理强度"))).toBe(false)
  // an effort that can't be set fails the request instead of running another
  const p3 = fakePage([ok], { steps: { effort: "no 推理强度 in the model menu" } })
  await expect(new Doubao({ app: { start: async () => 1, dataDir: dir }, openPage: async () => p3, poll: 1 }).ask("x", { model: "kimi-k3", effort: "low" })).rejects.toThrow("推理强度")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("a model the list has and the app's menu doesn't loads the page again once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-models-"))
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ v: 2, at: Date.now(), models: tableFrom(listOf(BRIEF)) }))
  const ok = { sends: 1, reply: true, text: "ok", reasoning: "", finished: true, reason: "succeed" }
  let reloaded = false
  const steps = {
    call: (m) => { if (m === "Page.reload") reloaded = true },
    model: () => (reloaded ? "" : "no DeepSeek V4.1 Flash in the model menu"),
  }
  const page = fakePage([ok], { steps })
  const ev = page.eval
  page.eval = async (e) => (e === STATE ? { signedIn: true, name: "yetone", input: true, sends: 0 } : ev(e))
  const d = new Doubao({ app: { start: async () => 1, dataDir: dir }, openPage: async () => page, poll: 1 })
  await d.ask("x", { model: "deepseek-v4.1-flash" })
  expect(page.calls.filter((c) => c === "Page.reload").length).toBe(1)
  // still missing after the reload: said, and loaded once only
  reloaded = false
  const p2 = fakePage([ok], { steps: { call: () => {}, model: "no DeepSeek V4.1 Flash in the model menu" } })
  const ev2 = p2.eval
  p2.eval = async (e) => (e === STATE ? { signedIn: true, name: "yetone", input: true, sends: 0 } : ev2(e))
  await expect(new Doubao({ app: { start: async () => 1, dataDir: dir }, openPage: async () => p2, poll: 1 }).ask("x", { model: "deepseek-v4.1-flash" })).rejects.toThrow("no DeepSeek V4.1 Flash in the model menu")
  expect(p2.calls.filter((c) => c === "Page.reload").length).toBe(1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("the plugin offers each model's 推理强度 as variants and passes the client's reasoning_effort on", async () => {
  const table = tableFrom(listOf(BRIEF))
  const asked = []
  const p = I.createPlugin({ doubao: { modelList: () => table, ask: async (prompt, o) => { asked.push([o.model, o.effort]); return { text: "ok", reasoning: "" } } }, newId: ids })
  const listed = await p.provider.models({}, {})
  expect(Object.keys(listed["deepseek-v4.1-flash"].variants)).toEqual(["low", "medium", "high", "xhigh", "max"])
  expect(listed["glm-5.3"].variants).toEqual({ low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } })
  const loader = await p.auth.loader(async () => ({}))
  expect((await loader.fetch(req({ model: "doubao-work/deepseek-v4.1-flash", reasoning_effort: "xhigh", messages: [{ role: "user", content: "hi" }] }))).status).toBe(200)
  expect((await loader.fetch(req({ model: "person-kimi-k3-261111", messages: [{ role: "user", content: "hi" }] }))).status).toBe(200)
  expect(asked).toEqual([["deepseek-v4.1-flash", "xhigh"], ["person-kimi-k3-261111", ""]])
})

test("a model's multiple is read from the menu of the task ask opened, and kept when the menu says none", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-models-"))
  const menu = { rows: [{ label: "自动", lines: [] }, { label: "Kimi K3", lines: ["0.65x"] }, { label: "Kimi K3.1 Pro 限时优惠 0.01x", lines: [] }] }
  const page = fakePage([], { steps: { list: BRIEF, menu } })
  const d = new Doubao({ app: { start: async () => 1, dataDir: dir }, openPage: async () => page, poll: 1 })
  const t = await d.discover({ inTask: true })
  expect(t["kimi-k3"].rate).toBe(0.65)
  expect(t["kimi-k3.1-pro"].rate).toBe(0.01)
  // Kimi K3.1 Pro 高速 is not Kimi K3.1 Pro's row
  expect(t["kimi-k3.1-pro-fast"].rate).toBeUndefined()
  expect(rateIn(menu.rows, "Kimi K3.1 Pro", listOf(BRIEF))).toBe(0.01)
  page.calls.length = 0
  const again = await new Doubao({ app: { start: async () => 1, dataDir: dir }, openPage: async () => fakePage([], { steps: { list: BRIEF, menu: { rows: [] } } }), poll: 1 }).discover({ inTask: true })
  expect(again["kimi-k3"].rate).toBe(0.65)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("ask sends with the send button, and with Enter only when there is none", async () => {
  const ok = { sends: 1, reply: true, text: "ok", reasoning: "", finished: true, reason: "succeed" }
  const page = fakePage([ok], { steps: { send: true } })
  await new Doubao({ app: fakeApp, openPage: async () => page, poll: 1 }).ask("x")
  expect(page.calls).toContain(SEND)
  expect(page.keys).toEqual([])
  const p2 = fakePage([ok])
  await new Doubao({ app: fakeApp, openPage: async () => p2, poll: 1 }).ask("x")
  expect(p2.keys).toEqual(["Enter"])
})
