// 0.2.0 sends nothing: every way in answers with where Antigravity went.
import { afterEach, expect, test } from "bun:test"
import { AntigravityAuthPlugin, RETIRED } from "./index.mjs"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function noNetwork() {
  const asked = []
  globalThis.fetch = async (u) => {
    asked.push(String(u))
    throw new Error("no request may leave the plugin")
  }
  return asked
}

test("a request is answered 410, retired, naming agy-cli, with nothing sent", async () => {
  const asked = noNetwork()
  const p = await AntigravityAuthPlugin({})
  const signedIn = async () => ({ type: "oauth", refresh: "rt|proj", access: "at", expires: Date.now() + 3600e3, accountId: "a@example.com" })
  const l = await p.auth.loader(signedIn)
  const res = await l.fetch("https://daily-cloudcode-pa.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse", { method: "POST", body: "{}" })
  expect(res.status).toBe(410)
  const j = await res.json()
  expect(j.error.status).toBe("ModelDeprecated")
  // magpie's modelRetired reads "model … has been retired"
  expect(j.error.message).toMatch(/model.{0,80}has been retired/i)
  expect(j.error.message).toContain("@magpie-community/opencode-agy-cli-auth")
  expect(j.error.message).toContain("Antigravity (local agy CLI)")
  expect(asked).toEqual([])
})

test("signing in is turned away with the same words", async () => {
  const asked = noNetwork()
  const p = await AntigravityAuthPlugin({})
  expect(p.auth.methods).toHaveLength(1)
  await expect(p.auth.methods[0].authorize({})).rejects.toThrow(RETIRED)
  expect(asked).toEqual([])
})

test("no models, usage or search, and the provider stays listed as retired", async () => {
  const asked = noNetwork()
  const p = await AntigravityAuthPlugin({})
  const cfg = { provider: { antigravity: { models: { "gemini-3-flash": {} } } } }
  await p.config(cfg)
  expect(cfg.provider.antigravity.models).toEqual({})
  expect(cfg.provider.antigravity.name).toBe("Antigravity (retired)")
  expect(await p.provider.models({ models: { x: {} } }, { auth: { type: "oauth", refresh: "rt|p" } })).toEqual({})
  expect(p.auth.usage).toBeUndefined()
  expect(p.search).toBeUndefined()
  expect(asked).toEqual([])
})
