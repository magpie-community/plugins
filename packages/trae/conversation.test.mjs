// One conversation keeps one session_id: Trae counts a conversation by the
// session its requests name, so a request naming a new session each time is
// counted as a conversation of its own — one user send that takes several
// steps shows up in the usage detail as several rows, each under no title.
// The session comes from magpie's (or OpenCode's) session for the request
// when it names one, else from the chat's first user message.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, sse, signedIn } from "./fake.mjs"

let f
afterEach(() => f?.close())

const { SESSION } = _internal

// ask sends a chat as magpie's host does: the chat.headers hook is told the
// session, then the loader's fetch with what it added, and the request Trae
// was sent is read back. auth is the sign-in the loader asks for, which is
// what a group of accounts answers with, one of them per request.
async function ask(chat, { session = "", provider = "trae-cn", auth = signedIn() } = {}) {
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const out = { headers: {} }
  await hooks["chat.headers"]({ sessionID: session, model: { providerID: provider, id: "glm-5" }, provider: { info: { id: provider } } }, out)
  const opts = await hooks.auth.loader(async () => auth)
  const res = await opts.fetch(opts.baseURL + "/chat/completions", {
    method: "POST",
    headers: new Headers(out.headers),
    body: JSON.stringify(chat),
  })
  expect(res.status).toBe(200)
  return { sent: f.seen.at(-1), out }
}

const chat = (...messages) => ({ model: "glm-5", stream: true, messages })
const user = (t) => ({ role: "user", content: [{ type: "text", text: t }] })
const assistant = (t) => ({ role: "assistant", content: [{ type: "text", text: t }] })
const call = { role: "assistant", content: [], tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] }
const result = { role: "tool", tool_call_id: "c1", content: "a.go" }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const serve = () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["done", {}]]))
}

test("one send's steps carry one session_id; each request still has its own", async () => {
  serve()
  const first = await ask(chat(user("fix the bug")))
  const called = await ask(chat(user("fix the bug"), call))
  const answered = await ask(chat(user("fix the bug"), call, result))
  const ids = [first, called, answered].map((x) => x.sent.json.session_id)
  expect(ids[0]).toMatch(UUID)
  expect(new Set(ids).size).toBe(1)
  // request_id is the request's own: each step has one of its own
  const reqs = [first, called, answered].map((x) => x.sent.json.request_id)
  expect(new Set(reqs).size).toBe(3)
  for (const r of reqs) expect(r).toMatch(UUID)
  // the session header itself goes no further
  for (const x of [first, called, answered]) expect(x.sent.headers.get(SESSION)).toBe(null)
})

test("the next user message and another conversation are other sessions", async () => {
  serve()
  const first = await ask(chat(user("fix the bug")))
  const next = await ask(chat(user("fix the bug"), assistant("ok"), user("and then?")))
  expect(next.sent.json.session_id).toBe(first.sent.json.session_id)
  const other = await ask(chat(user("something else")))
  expect(other.sent.json.session_id).not.toBe(first.sent.json.session_id)
})

test("the session magpie names wins over the chat's own first message", async () => {
  serve()
  const named = await ask(chat(user("hi")), { session: "ses_1" })
  const again = await ask(chat(user("hi"), assistant("ok"), user("more")), { session: "ses_1" })
  expect(again.sent.json.session_id).toBe(named.sent.json.session_id)
  // the same words under another session are another conversation
  const other = await ask(chat(user("hi")), { session: "ses_2" })
  expect(other.sent.json.session_id).not.toBe(named.sent.json.session_id)
  // and the session header is not sent to Trae
  expect(named.sent.headers.get(SESSION)).toBe(null)
})

test("nothing names a conversation: a fresh session per request, as before", async () => {
  serve()
  const one = await ask(chat({ role: "system", content: "be brief" }))
  const two = await ask(chat({ role: "system", content: "be brief" }))
  expect(one.sent.json.session_id).not.toBe(two.sent.json.session_id)
})

test("two accounts of one conversation are two conversations to Trae", async () => {
  serve()
  const named = await ask(chat(user("hi")), { session: "ses_1", auth: signedIn() })
  const other = await ask(chat(user("hi")), { session: "ses_1", auth: signedIn({ uid: "u-2", accountId: "Bob" }) })
  expect(other.sent.json.session_id).not.toBe(named.sent.json.session_id)
  // each account's own conversation keeps its own id, so failing over
  // back mid-conversation doesn't split it
  const again = await ask(chat(user("hi"), assistant("ok"), user("more")), { session: "ses_1", auth: signedIn() })
  expect(again.sent.json.session_id).toBe(named.sent.json.session_id)
  // and the same holds when the conversation is named by the chat itself
  const first = await ask(chat(user("fix the bug")), { auth: signedIn() })
  const onOther = await ask(chat(user("fix the bug")), { auth: signedIn({ uid: "u-2", accountId: "Bob" }) })
  expect(onOther.sent.json.session_id).not.toBe(first.sent.json.session_id)
  // an account named by its name alone (no uid) is one of its own too
  const namedOnly = await ask(chat(user("hi")), { session: "ses_1", auth: signedIn({ uid: "", accountId: "Bob" }) })
  expect(namedOnly.sent.json.session_id).not.toBe(named.sent.json.session_id)
})

test("one account's two conversations stay two", async () => {
  serve()
  const one = await ask(chat(user("fix the bug")), { session: "ses_1" })
  const two = await ask(chat(user("fix the bug")), { session: "ses_2" })
  expect(two.sent.json.session_id).not.toBe(one.sent.json.session_id)
})

test("the hook leaves other providers' requests alone", async () => {
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const out = { headers: {} }
  await hooks["chat.headers"]({ sessionID: "ses_1", model: { providerID: "trae-global" }, provider: { info: { id: "trae-global" } } }, out)
  expect(out.headers).toEqual({})
})

// baoguo on magpie's Discord: a conversation's session_id is the same after
// the plugin's process starts again (magpie restarts its plugins on every
// update), so Trae goes on counting it as the one conversation. Each run
// below is a process of its own, as a restarted plugin host is.
const { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, statSync } = await import("node:fs")
const { tmpdir } = await import("node:os")
const { join } = await import("node:path")

function idIn(env) {
  const code = `const { _internal } = await import(${JSON.stringify(new URL("./index.mjs", import.meta.url).href)}); console.log(_internal.conversationID(null, "ses_1", "u-1"))`
  const r = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, ...env }, stderr: "pipe" })
  expect(r.exitCode).toBe(0)
  return r.stdout.toString().trim()
}

test("a conversation keeps its session_id when the plugin's process starts again", () => {
  const dir = mkdtempSync(join(tmpdir(), "trae-salt-"))
  try {
    const file = join(dir, "magpie", "trae-session-salt")
    const one = idIn({ MAGPIE_TRAE_SESSION_SALT: file })
    expect(one).toMatch(UUID)
    expect(idIn({ MAGPIE_TRAE_SESSION_SALT: file })).toBe(one)
    // the salt is this machine's own, unreadable to anyone else
    expect(readFileSync(file, "utf8").trim()).toMatch(/^[0-9a-f]{32}$/)
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0)
    // another machine's (another file's) salt names it apart
    expect(idIn({ MAGPIE_TRAE_SESSION_SALT: join(dir, "other") })).not.toBe(one)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a salt file that isn't one is left alone, and each process has its own salt, as before", () => {
  const dir = mkdtempSync(join(tmpdir(), "trae-salt-"))
  try {
    const file = join(dir, "trae-session-salt")
    writeFileSync(file, "not a salt\n")
    const one = idIn({ MAGPIE_TRAE_SESSION_SALT: file })
    expect(one).toMatch(UUID)
    expect(idIn({ MAGPIE_TRAE_SESSION_SALT: file })).not.toBe(one)
    expect(readFileSync(file, "utf8")).toBe("not a salt\n")
    // a file that can't be made: the folder it would go in is a file
    const blocked = idIn({ MAGPIE_TRAE_SESSION_SALT: join(file, "salt") })
    expect(blocked).toMatch(UUID)
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      // one that can't be read
      const shut = join(dir, "shut")
      writeFileSync(shut, "0".repeat(32) + "\n")
      chmodSync(shut, 0)
      const a = idIn({ MAGPIE_TRAE_SESSION_SALT: shut })
      expect(idIn({ MAGPIE_TRAE_SESSION_SALT: shut })).not.toBe(a)
      chmodSync(shut, 0o600)
      expect(readFileSync(shut, "utf8")).toBe("0".repeat(32) + "\n")
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("processes starting at once on no salt yet all take the one that was made", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trae-salt-"))
  try {
    const env = { ...process.env, MAGPIE_TRAE_SESSION_SALT: join(dir, "trae-session-salt") }
    const code = `const { _internal } = await import(${JSON.stringify(new URL("./index.mjs", import.meta.url).href)}); console.log(_internal.conversationID(null, "ses_1", "u-1"))`
    const runs = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, "-e", code], { env, stdout: "pipe" }))
    const ids = await Promise.all(runs.map(async (p) => (await new Response(p.stdout).text()).trim()))
    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toMatch(UUID)
    // and no temp file is left beside it
    const { readdirSync } = await import("node:fs")
    expect(readdirSync(dir)).toEqual(["trae-session-salt"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
