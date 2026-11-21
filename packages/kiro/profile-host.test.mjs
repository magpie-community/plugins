// A profile ARN's region and a sign-in's region go into the host every
// token and request is sent to. One read from a file (an imported list,
// the Kiro IDE's kiro-auth-token.json, kiro-cli's database, a saved
// sign-in) is taken only in the shape Kiro gives it: an ARN that isn't one
// is dropped and Kiro is asked for the profile, a profile's region outside
// Kiro's own falls back, and a region that isn't one is refused before any
// request (plugins#1132 review).
import { test, expect, afterAll, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

let plugin, internal
beforeAll(async () => {
  // Bun reads HOME once, at start: run as HOME=$(mktemp -d) bun test, so
  // no real sign-in is ever read or written
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ KiroAuthPlugin: plugin, _internal: internal } = await import("./index.mjs"))
})
const offline = async () => { throw new Error("no network in tests") }
const real = globalThis.fetch
globalThis.fetch = offline
const ideDir = () => join(homedir(), ".aws", "sso", "cache")
afterAll(() => {
  globalThis.fetch = real
  rmSync(ideDir(), { recursive: true, force: true })
})
afterEach(() => {
  globalThis.fetch = offline
  rmSync(ideDir(), { recursive: true, force: true })
})

const CRAFTED = "arn:aws:codewhisperer:attacker.example/#:1:profile/X"
const PROFILE = "arn:aws:codewhisperer:us-east-1:111111111111:profile/TEST"
const later = () => new Date(Date.now() + 3600e3).toISOString()
const kiroHost = (h) => h.endsWith(".kiro.dev") || h.endsWith(".amazonaws.com")

// every request's host noted; Kiro answers each as if it were the one asked
function kiro() {
  const hosts = []
  globalThis.fetch = async (url) => {
    hosts.push(new URL(String(url)).host)
    return Response.json({ profiles: [{ arn: PROFILE }], userInfo: { email: "x@y.z" }, subscriptionInfo: { subscriptionTitle: "KIRO FREE" }, models: [] })
  }
  return hosts
}
const hooks = () => plugin({ client: { auth: { set: async () => {} } } })

test("an imported profileArn doesn't pick the host: it is dropped and Kiro asked for the profile", async () => {
  const hosts = kiro()
  const h = await hooks()
  const [got] = await h.auth.import([JSON.stringify([{ email: "u@gmail.com", provider: "Google", refreshToken: "r", accessToken: "a",
    expiresAt: later(), profileArn: CRAFTED }])])
  expect(hosts.length).toBeGreaterThan(0)
  expect(hosts.every(kiroHost)).toBe(true)
  expect(got).toMatchObject({ type: "success", profileArn: PROFILE })
})

test("the Kiro IDE's file with a malformed profileArn sends nothing outside Kiro", async () => {
  mkdirSync(ideDir(), { recursive: true })
  writeFileSync(join(ideDir(), "kiro-auth-token.json"), JSON.stringify({ accessToken: "t", refreshToken: "r", expiresAt: later(),
    authMethod: "social", provider: "Google", profileArn: CRAFTED }))
  expect((await internal.readIDE()).profile).toBe("")
  const hosts = kiro()
  const h = await hooks()
  await h.provider.models({ models: { auto: {} } }, { auth: { type: "oauth", source: "kiro-ide", access: "", refresh: "", expires: 0 } })
  expect(hosts.length).toBeGreaterThan(0)
  expect(hosts.every(kiroHost)).toBe(true)
})

test("a saved sign-in's malformed profileArn sends a request nowhere outside Kiro", async () => {
  const hosts = kiro()
  const h = await hooks()
  const stored = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3600e3, method: "social", region: "us-east-1", profileArn: CRAFTED, accountId: "u@gmail.com (Google)" }
  const l = await h.auth.loader(async () => stored)
  await l.fetch("https://kiro.invalid/v1/messages", { method: "POST", body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }) })
  expect(hosts.length).toBeGreaterThan(0)
  expect(hosts.every(kiroHost)).toBe(true)
})

test("a region that isn't one is refused before the refresh is sent", async () => {
  mkdirSync(ideDir(), { recursive: true })
  writeFileSync(join(ideDir(), "kiro-auth-token.json"), JSON.stringify({ accessToken: "t", refreshToken: "r", expiresAt: "2020-01-01T00:00:00Z",
    authMethod: "social", provider: "Google", region: "attacker.example/#" }))
  const hosts = kiro()
  const e = await internal.refresh(await internal.readIDE()).catch((e) => e)
  expect(e.message).toContain("isn't an AWS region")
  expect(hosts).toEqual([])
})

test("only Kiro's own regions are taken from a profile", () => {
  expect(internal.regionOf(CRAFTED, "us-east-1")).toBe("us-east-1")
  expect(internal.regionOf("arn:aws:codewhisperer:us-west-2:111111111111:profile/X", "eu-west-1")).toBe("eu-central-1")
  expect(internal.regionOf("arn:aws:codewhisperer:eu-central-1:111111111111:profile/X", "us-east-1")).toBe("eu-central-1")
  expect(internal.regionOf(PROFILE, "eu-central-1")).toBe("us-east-1")
})
