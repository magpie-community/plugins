import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { agyEnv, answerOf, handle, homeOfAuth, parseModels, promptOf, screenTail, tokenFile } from "./index.mjs"

describe("promptOf", () => {
  test("one user message is pasted as it is", () => {
    expect(promptOf([{ role: "user", content: "hi there" }])).toBe("hi there")
  })
  test("instructions and the conversation come before the last message", () => {
    const p = promptOf([
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "one" }] },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ])
    expect(p).toBe("Be brief.\n\nUser: one\n\nAssistant: two\n\nUser: three")
  })
  test("an image or a tool result is refused, not dropped", () => {
    expect(() => promptOf([{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }])).toThrow(/text only/)
    expect(() => promptOf([{ role: "user", content: "a" }, { role: "tool", content: "b" }])).toThrow(/tool/)
  })
  test("the last message is the user's", () => {
    expect(() => promptOf([{ role: "user", content: "a" }, { role: "assistant", content: "b" }])).toThrow(/user/)
  })
})

test("parseModels reads agy models' lines", () => {
  expect(parseModels("gemini-3.1-pro-low  Gemini 3.1 Pro (Low)\n\nclaude-sonnet-4-6  Claude Sonnet 4.6\nWarning: something\n")).toEqual([
    { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  ])
})

test("an account's agy runs in its home, its sign-in in a file", () => {
  const env = agyEnv("/h", { PATH: "/bin", HOME: "/real" }, "darwin")
  expect(env.HOME).toBe("/h")
  expect(env.SSH_CONNECTION).toBe("127.0.0.1 0 127.0.0.1 0")
  expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true")
  expect(agyEnv("/h", { agy_cli_disable_auto_update: "false" }, "darwin").AGY_CLI_DISABLE_AUTO_UPDATE).toBeUndefined()
  expect(agyEnv("C:\\h", {}, "win32").USERPROFILE).toBe("C:\\h")
})

test("an account's home is never a path out of its folder", () => {
  expect(homeOfAuth({ metadata: { agyHome: "../../etc" } })).toBeNull()
  expect(homeOfAuth({ key: "agy-tui:../x" })).toBeNull()
  expect(homeOfAuth({ key: "agy-tui:abcdef0123456789" })).toEndWith(path.join("magpie-agy-tui", "accounts", "abcdef0123456789"))
})

test("an error shows agy's warning, not its whole screen", () => {
  const screen = "  logo\n────\n> hi\n⚠ agent executor error: quota\nError ID: 1\n────────\n>\n────\n  ? for shortcuts"
  expect(screenTail(screen)).toBe("⚠ agent executor error: quota\nError ID: 1")
  expect(screenTail("a\nb\n  ? for shortcuts")).toBe("a\nb")
})

describe("answerOf", () => {
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tui-brain-"))
  const conv = (id, rows) => {
    const dir = path.join(brain, id, ".system_generated", "logs")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "transcript_full.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
  }
  conv("old", [{ type: "USER_INPUT", content: "the question" }, { type: "PLANNER_RESPONSE", content: "old answer" }])
  conv("other", [{ type: "USER_INPUT", content: "another question" }, { type: "PLANNER_RESPONSE", content: "not ours" }])
  conv("ours", [{ type: "USER_INPUT", content: "<USER_REQUEST>\nthe question\n</USER_REQUEST>" }, { type: "PLANNER_RESPONSE", content: "first" }, { type: "PLANNER_RESPONSE", content: "the answer" }])
  afterAll(() => fs.rmSync(brain, { recursive: true, force: true }))

  test("the turn's conversation is the new one with its words, and its last response", () => {
    expect(answerOf(brain, new Set(["old"]), "the question")).toEqual({ id: "ours", answer: "the answer" })
  })
  test("nothing before the turn is taken for it", () => {
    expect(answerOf(brain, new Set(["old", "ours"]), "the question")).toBeNull()
  })
})

// The real agy (AGY_TUI_TEST_AGY) in magpie's terminal (MAGPIE_EXE, a magpie
// with tui-helper), in an account home of a temp XDG_STATE_HOME, on an API
// key against a fake Gemini on loopback. Every other host goes to a proxy
// that isn't there, so nothing reaches the network and no account is used.
const agy = process.env.AGY_TUI_TEST_AGY
describe.skipIf(!agy || !process.env.MAGPIE_EXE)("the real agy", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tui-state-"))
  const id = "abcdef0123456789"
  const home = path.join(state, "magpie-agy-tui", "accounts", id)
  const brain = path.join(home, ".gemini", "antigravity-cli", "brain")
  const said = []
  let fake
  const saved = {}
  const set = (k, v) => { saved[k] = process.env[k]; process.env[k] = v }

  beforeAll(() => {
    fake = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url)
        if (req.method !== "POST" || !url.pathname.includes("streamGenerateContent")) return Response.json({ models: [] })
        const body = await req.json()
        let last = ""
        for (const c of body.contents ?? []) for (const p of c.parts ?? []) if (c.role === "user" && p.text) last = p.text
        said.push(last)
        const reply = last.includes("hello agy-tui") ? "pong from the fake" : last.includes("say nothing") ? null : "a title"
        if (reply === null) return new Response(JSON.stringify({ error: { code: 400, message: "the fake refused", status: "INVALID_ARGUMENT" } }), { status: 400, headers: { "Content-Type": "application/json" } })
        const chunk = {
          candidates: [{ content: { role: "model", parts: [{ text: reply }] }, finishReason: "STOP", index: 0 }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
        }
        return new Response(`data: ${JSON.stringify(chunk)}\r\n\r\n`, { headers: { "Content-Type": "text/event-stream" } })
      },
    })
    const ac = path.join(home, ".gemini", "antigravity-cli")
    fs.mkdirSync(path.join(home, ".gemini", "config"), { recursive: true })
    fs.mkdirSync(ac, { recursive: true })
    // the API key's provider; the workspace is trusted by the plugin, not here
    fs.writeFileSync(path.join(ac, "settings.json"), JSON.stringify({ modelProvider: "gemini" }))
    fs.writeFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), JSON.stringify({ mcpServers: {} }))
    // what the plugin checks for a signed-in account; agy here signs in
    // with the key
    fs.writeFileSync(tokenFile(home), "")
    const none = "http://127.0.0.1:9"
    set("XDG_STATE_HOME", state)
    set("AGY_PATH", agy)
    set("GEMINI_API_KEY", "fake-key")
    set("GOOGLE_GEMINI_BASE_URL", `http://127.0.0.1:${fake.port}`)
    for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) set(k, none)
    for (const k of ["NO_PROXY", "no_proxy"]) set(k, "127.0.0.1,localhost")
    set("LANG", "en_US.UTF-8")
  })
  afterAll(() => {
    fake?.stop(true)
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v)
    fs.rmSync(state, { recursive: true, force: true })
  })

  const ask = (content, stream) => handle(home, "agy-tui://local/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "gemini-3.1-pro-low", stream, messages: [{ role: "user", content }] }),
  })

  test("a message is typed into agy, and its answer comes back", async () => {
    const res = await ask("hello agy-tui", false)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.choices[0].message.content).toBe("pong from the fake")
    expect(said.some((s) => s.includes("hello agy-tui"))).toBe(true)
    // the turn's conversation is gone from the account's home
    expect(fs.existsSync(brain) ? fs.readdirSync(brain) : []).toEqual([])
  }, 180_000)

  test("streamed, the answer comes as chunks", async () => {
    const res = await ask("hello agy-tui, streamed", true)
    expect(res.status).toBe(200)
    const text = await res.text()
    const content = text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))).map((o) => o.choices?.[0]?.delta?.content ?? "").join("")
    expect(content).toBe("pong from the fake")
    expect(text.trim().endsWith("data: [DONE]")).toBe(true)
  }, 180_000)

  test("a turn agy answers with nothing is an error with what agy drew", async () => {
    const res = await ask("say nothing", false)
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.message).toMatch(/^agy answered nothing:\n⚠ .*the fake refused/)
    expect(body.error.message).not.toContain("────")
  }, 180_000)

  test("signed out, the account is told to sign in again", async () => {
    const res = await handle(path.join(state, "nobody"), "agy-tui://local/chat/completions", { body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) })
    expect(res.status).toBe(401)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  })
})
