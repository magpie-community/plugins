// plugins#1670: a models listing saves the sign-in (client.auth.set) only
// when it changed. Each save has magpie read every sign-in again, and
// before magpie v0.1.4992 it listed every plugin again too, without end.
import { test, expect, afterAll, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let plugin, _internal
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ KiroAuthPlugin: plugin, _internal } = await import("./index.mjs"))
})
const offline = async () => { throw new Error("no network in tests") }
const real = globalThis.fetch
globalThis.fetch = offline
const realNow = Date.now
afterAll(() => (globalThis.fetch = real))
afterEach(() => {
  globalThis.fetch = offline
  Date.now = realNow
})

const US = "arn:aws:codewhisperer:us-east-1:333333333333:profile/US"
const EU = "arn:aws:codewhisperer:eu-central-1:333333333333:profile/EU"
const REFRESH = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"
const MODELS = { models: [{ modelId: "auto", modelName: "Auto" }, { modelId: "claude-sonnet-5.5", modelName: "Sonnet 5.5" }], defaultModel: { modelId: "auto" } }

// kiro lists MODELS, the profiles each region has, and renews a social
// sign-in to a new token
function kiro({ profiles = { "us-east-1": [US], "eu-central-1": [EU] } } = {}) {
  const seen = { refreshes: 0, profiles: 0, lists: 0 }
  globalThis.fetch = async (input) => {
    if (String(input) === REFRESH) {
      seen.refreshes++
      return Response.json({ accessToken: `new-${seen.refreshes}`, refreshToken: `r${seen.refreshes + 1}`, expiresIn: 3600 })
    }
    const url = new URL(String(input))
    const region = url.host.split(".")[1]
    if (url.pathname === "/List-Available-Profiles") {
      seen.profiles++
      return Response.json({ profiles: (profiles[region] ?? []).map((arn) => ({ arn })) })
    }
    if (url.pathname === "/List-Available-Models") {
      seen.lists++
      return Response.json(MODELS)
    }
    throw new Error("unexpected " + url)
  }
  return seen
}

// account lists the models as magpie does: each listing with the sign-in
// as last saved
async function account(stored) {
  const box = { stored, sets: [] }
  const h = await plugin({ client: { auth: { set: async (r) => { box.sets.push(r.body); box.stored = { ...r.body } } } } })
  box.list = () => h.provider.models({ models: {} }, { auth: box.stored })
  return box
}
const later = () => Date.now() + 60 * 60_000

test("listing models twice with an unchanged token saves nothing", async () => {
  const seen = kiro()
  const a = await account({ type: "oauth", access: "t", refresh: "r1", expires: later(), method: "social", region: "us-east-1", profileArn: US,
    accountId: "me@example.com (Google)", uid: "u1" })
  for (let i = 0; i < 2; i++) expect(Object.keys(await a.list())).toEqual(["auto", "claude-sonnet-5.5"])
  expect(a.sets).toEqual([])
  expect(seen.refreshes).toBe(0)
})

test("an Identity Center account's profiles are saved once, and listing again saves nothing", async () => {
  let now = realNow()
  Date.now = () => now
  const seen = kiro({ profiles: { "us-east-1": [US] } })
  const a = await account({ type: "oauth", access: "t", refresh: "r", expires: now + 10 * 3600_000, method: "idc", loginProvider: "Enterprise", region: "us-east-1",
    profileArn: "", clientId: "c", clientSecret: "s", accountId: "dev@corp.example (IAM Identity Center)" })
  await a.list()
  expect(a.sets.length).toBe(1)
  expect(a.sets[0]).toMatchObject({ profileArn: US, profiles: { "us-east-1": US } })
  // past the wait for the region with no profile: asked again, found none
  for (let i = 0; i < 3; i++) {
    now += 11 * 60_000
    await a.list()
  }
  expect(seen.profiles).toBeGreaterThan(2)
  expect(a.sets.length).toBe(1)
})

test("a sign-in near its end is renewed and saved once; the renewed one listed again saves nothing", async () => {
  const seen = kiro()
  const a = await account({ type: "oauth", access: "old", refresh: "r1", expires: Date.now() + 60_000, method: "social", region: "us-east-1", profileArn: US,
    accountId: "me@example.com (Google)", uid: "u1" })
  for (let i = 0; i < 3; i++) await a.list()
  expect(seen.refreshes).toBe(1)
  expect(a.sets.length).toBe(1)
  expect(a.sets[0]).toMatchObject({ access: "new-1", refresh: "r2" })
})
