// onemezao (Discord): a Builder ID account on Kiro Pro for students was
// answered 429 USER_REQUEST_RATE_EXCEEDED on claude-haiku-5.5 through the
// plugin, and by kiro-cli too, while the Kiro IDE went on working on the
// same account. The plugin called as kiro-cli; it now calls as the Kiro IDE
// 1.4.121 does, with the values read from the IDE's own extension.js: the
// AWS SDK for JavaScript's user agent with the IDE's "KiroIDE-<version>-
// <machine id>-KAS/<version> acp-client/kiro-ide" (one machine id per
// install, never a random one per request), origin AI_EDITOR, its
// x-amzn-kiro-* headers, and one conversationId for a whole session.
import { test, expect, afterAll, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let plugin
beforeAll(async () => {
  // Bun reads HOME once, at start: run as HOME=$(mktemp -d) bun test, so
  // no real sign-in is ever read or written
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ KiroAuthPlugin: plugin } = await import("./index.mjs"))
})
const offline = async () => { throw new Error("no network in tests") }
const real = globalThis.fetch
globalThis.fetch = offline
afterAll(() => (globalThis.fetch = real))
afterEach(() => (globalThis.fetch = offline))

const BUILDER_ID = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX"
const later = () => Date.now() + 60 * 60_000
// the reporter's sign-in: Builder ID, made here
const AUTH = { type: "oauth", access: "t", refresh: "r", expires: later(), method: "idc", loginProvider: "BuilderId", region: "us-east-1",
  profileArn: BUILDER_ID, clientId: "c", clientSecret: "s", accountId: "student@example.edu" }

// kiro records each chat call's headers and body, and answers it 500 so
// the request ends there
function kiro() {
  const chats = []
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === "/generateAssistantResponse") {
      chats.push({ headers: Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v])), body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ message: "stop here" }), { status: 500 })
    }
    throw new Error("unexpected " + url)
  }
  return chats
}

const ask = async (headers, content = "hi") => {
  const h = await plugin({ client: { auth: { set: async () => {} } } })
  const l = await h.auth.loader(async () => AUTH)
  return l.fetch("https://kiro.invalid/v1/messages", { method: "POST", headers,
    body: JSON.stringify({ model: "claude-haiku-5.5", messages: [{ role: "user", content }] }) })
}

const APP = /^KiroIDE-1\.4\.121-[0-9a-f]{64}-KAS\/0\.66\.89 acp-client\/kiro-ide$/

test("a chat call names itself as the Kiro IDE does, the same on every call", async () => {
  const chats = kiro()
  await ask({ "X-Magpie-Conversation": "s1" })
  await ask({ "X-Magpie-Conversation": "s2" })
  const [a, b] = chats.map((c) => c.headers)
  const ua = a["user-agent"]
  expect(ua).toMatch(/^aws-sdk-js\/1\.0\.0 ua\/2\.1 os\/[\w.-]+#[\w.#-]+ lang\/js md\/nodejs#24\.22\.1 api\/kiroruntime#1\.0\.0 m\/N /)
  expect(ua.slice(ua.indexOf("KiroIDE-"))).toMatch(APP)
  expect(a["x-amz-user-agent"].replace(/^aws-sdk-js\/1\.0\.0 /, "")).toMatch(APP)
  expect(ua).not.toContain("aws-sdk-rust")
  expect(ua).not.toContain("AmazonQ-For-CLI")
  // one install, one machine id: no random suffix per request
  expect(b["user-agent"]).toBe(ua)
  expect(b["x-amz-user-agent"]).toBe(a["x-amz-user-agent"])
  expect(a["x-amzn-kiro-client-attribution"]).toBe("kiro-ide")
  expect(a["x-amzn-kiro-agent-mode"]).toBe("vibe")
  expect(a["x-amzn-kiro-attempt"]).toBe("1;max=3")
  expect(a["amz-sdk-request"]).toBe("attempt=1; max=3")
  // the IDE says a Builder ID token's kind
  expect(a.tokentype).toBe("SSO_OIDC")
  expect(a.authorization).toBe("Bearer t")
})

test("a chat call's messages come from the IDE (AI_EDITOR), and the agent mode is a header, not a field", async () => {
  const chats = kiro()
  await ask({ "X-Magpie-Conversation": "s1" })
  const { body } = chats[0]
  expect(body.conversationState.currentMessage.userInputMessage.origin).toBe("AI_EDITOR")
  expect(body.conversationState.currentMessage.userInputMessage.modelId).toBe("claude-haiku-5.5")
  expect(body.profileArn).toBe(BUILDER_ID)
  expect("agentMode" in body).toBe(false)
})

test("one session keeps one conversationId; another session, or none, has its own", async () => {
  const chats = kiro()
  await ask({ "X-Magpie-Conversation": "session-A" }, "first")
  await ask(new Headers({ "x-magpie-conversation": "session-A" }), "second")
  await ask({ "X-Magpie-Conversation": "session-B" })
  await ask({})
  await ask({})
  const ids = chats.map((c) => c.body.conversationState.conversationId)
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(ids[1]).toBe(ids[0])
  expect(ids[2]).not.toBe(ids[0])
  // a call that names no session is a conversation of its own each time
  expect(new Set(ids.slice(2)).size).toBe(3)
  // the session's own name never goes to Kiro
  for (const c of chats) expect(JSON.stringify(c)).not.toContain("session-A")
})

test("magpie's session header names the session when no conversation is said", async () => {
  const chats = kiro()
  await ask({ "X-Magpie-Session": "named" })
  await ask({ "X-Magpie-Session": "named" })
  expect(chats[1].body.conversationState.conversationId).toBe(chats[0].body.conversationState.conversationId)
})
