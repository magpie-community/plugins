// A Builder ID sign-in (kiro-cli's, the Kiro IDE's or one made here) has no
// profile of its own, and Kiro won't list one for it; as the built-in
// (magpie 40102f74, #422), it is asked with the service profile kiro-cli and
// the IDE use for Builder ID, so its own models are listed and served
// (magpie-community/plugins#16: a Kiro Student account was offered Auto
// alone, where the built-in listed claude-opus-5.5 and claude-sonnet-5.5).
import { test, expect, afterAll, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"

let plugin
beforeAll(async () => {
  // Bun reads HOME once, at start: run as HOME=$(mktemp -d) bun test, so
  // no real sign-in (~/.kiro, ~/.aws, kiro-cli's) is ever read or written
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ KiroAuthPlugin: plugin } = await import("./index.mjs"))
})
const offline = async () => { throw new Error("no network in tests") }
const real = globalThis.fetch
globalThis.fetch = offline
const cliDir = () =>
  process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "kiro-cli") : join(homedir(), ".local", "share", "kiro-cli")
const ideDir = () => join(homedir(), ".aws", "sso", "cache")
const clean = () => {
  rmSync(cliDir(), { recursive: true, force: true })
  rmSync(ideDir(), { recursive: true, force: true })
}
afterAll(() => {
  globalThis.fetch = real
  clean()
})
afterEach(() => {
  globalThis.fetch = offline
  clean()
})

const BUILDER_ID = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX"
const IDC = "arn:aws:codewhisperer:us-east-1:222222222222:profile/IDC"
const later = () => Date.now() + 60 * 60_000
const STUDENT = [
  { modelId: "auto", modelName: "auto", tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 64000 } },
  { modelId: "claude-opus-5.5", modelName: "claude-opus-5.5", tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 128000 } },
  { modelId: "claude-sonnet-5.5", modelName: "claude-sonnet-5.5", tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 64000 } },
]

// kiro is Kiro's API as a Builder ID sees it: no profile listed for it (a
// 403, or the profiles given), the models listed only under its service
// profile, and a chat refused with any other.
function kiro({ profiles } = {}) {
  const seen = { profiles: 0, listedWith: [], chatWith: [] }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === "/List-Available-Profiles") {
      seen.profiles++
      if (profiles) return Response.json({ profiles })
      return new Response(JSON.stringify({ message: "AWS Builder ID is not supported for this operation", reason: null }), { status: 403 })
    }
    if (url.pathname === "/List-Available-Models") {
      const p = url.searchParams.get("profileArn")
      seen.listedWith.push(p)
      if (p === BUILDER_ID || p === IDC) return Response.json({ defaultModel: { modelId: "auto" }, models: STUDENT })
      return new Response(JSON.stringify({ message: "profileArn is required for this request." }), { status: 400 })
    }
    if (url.pathname === "/generateAssistantResponse") {
      const b = JSON.parse(init.body)
      seen.chatWith.push([b.profileArn, b.conversationState.currentMessage.userInputMessage.modelId])
      return new Response(JSON.stringify({ message: "stop here" }), { status: 500 })
    }
    throw new Error("unexpected " + url)
  }
  return seen
}

const hooks = () => plugin({ client: { auth: { set: async () => {} } } })
const ask = async (h, auth, model) => {
  const l = await h.auth.loader(async () => auth)
  return l.fetch("https://kiro.invalid/v1/messages", { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) })
}

test("a Builder ID signed in here lists and serves its own models under Builder ID's profile", async () => {
  const seen = kiro()
  const h = await hooks()
  const auth = { type: "oauth", access: "t", refresh: "r", expires: later(), method: "idc", loginProvider: "BuilderId", region: "us-east-1",
    profileArn: "", clientId: "c", clientSecret: "s", accountId: "student@example.edu" }
  const list = await h.provider.models({ models: { auto: {} } }, { auth })
  expect(Object.keys(list)).toEqual(["auto", "claude-opus-5.5", "claude-sonnet-5.5"])
  await ask(h, auth, "claude-opus-5.5")
  expect(seen.profiles).toBe(0)
  expect(seen.listedWith).toEqual([BUILDER_ID])
  expect(seen.chatWith).toEqual([[BUILDER_ID, "claude-opus-5.5"]])
})

test("an AWS sign-in whose profiles Kiro won't list for Builder ID takes Builder ID's profile", async () => {
  const seen = kiro()
  const h = await hooks()
  // moved from the built-in without its provider said
  const auth = { type: "oauth", access: "t", refresh: "r", expires: later(), method: "idc", region: "us-east-1", profileArn: "",
    clientId: "c", clientSecret: "s", accountId: "student@example.edu" }
  const list = await h.provider.models({ models: { auto: {} } }, { auth })
  expect(Object.keys(list)).toContain("claude-opus-5.5")
  expect(seen.profiles).toBe(1)
  expect(seen.listedWith).toEqual([BUILDER_ID])
})

test("Identity Center still has its profile listed", async () => {
  const seen = kiro({ profiles: [{ arn: IDC }] })
  const h = await hooks()
  const auth = { type: "oauth", access: "t", refresh: "r", expires: later(), method: "idc", loginProvider: "Enterprise", region: "us-east-1",
    profileArn: "", clientId: "c", clientSecret: "s", accountId: "dev@corp.example" }
  await h.provider.models({ models: { auto: {} } }, { auth })
  // asked in each credit region (region.test.mjs)
  expect(seen.profiles).toBe(2)
  expect(seen.listedWith).toEqual([IDC])
})

test("kiro-cli's Builder ID sign-in (its start URL, or none) is asked with Builder ID's profile", async () => {
  for (const start of ["https://view.awsapps.com/start", undefined]) {
    mkdirSync(cliDir(), { recursive: true })
    const db = new Database(join(cliDir(), "data.sqlite3"), { create: true })
    db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)")
    const token = { access_token: "t", refresh_token: "r", expires_at: new Date(later()).toISOString(), region: "us-east-1",
      ...(start ? { start_url: start } : {}) }
    db.prepare("INSERT INTO auth_kv VALUES (?, ?)").run("kirocli:odic:token", JSON.stringify(token))
    db.prepare("INSERT INTO auth_kv VALUES (?, ?)").run("kirocli:odic:device-registration", JSON.stringify({ client_id: "c", client_secret: "s" }))
    db.close()
    const seen = kiro()
    const h = await hooks()
    const list = await h.provider.models({ models: { auto: {} } }, { auth: { type: "oauth", source: "kiro-cli", access: "", refresh: "", expires: 0 } })
    expect(Object.keys(list)).toContain("claude-sonnet-5.5")
    expect(seen.profiles).toBe(0)
    expect(seen.listedWith).toEqual([BUILDER_ID])
    clean()
  }
})

test("the Kiro IDE's Builder ID sign-in is asked with Builder ID's profile", async () => {
  mkdirSync(ideDir(), { recursive: true })
  writeFileSync(join(ideDir(), "kiro-auth-token.json"), JSON.stringify({ accessToken: "t", refreshToken: "r",
    expiresAt: new Date(later()).toISOString(), authMethod: "IdC", provider: "BuilderId", region: "us-east-1", clientIdHash: "h" }))
  writeFileSync(join(ideDir(), "h.json"), JSON.stringify({ clientId: "c", clientSecret: "s" }))
  const seen = kiro()
  const h = await hooks()
  const list = await h.provider.models({ models: { auto: {} } }, { auth: { type: "oauth", source: "kiro-ide", access: "", refresh: "", expires: 0 } })
  expect(Object.keys(list)).toContain("claude-opus-5.5")
  expect(seen.profiles).toBe(0)
  expect(seen.listedWith).toEqual([BUILDER_ID])
})
