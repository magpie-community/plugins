// The two ways in, with the app reader and Google's token endpoint mocked.
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const client = { auth: { set: async () => {} } }
const plugin = await _internal.createPlugin({ client }, { readUser: async () => null })

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const fakeJwt = (claims) => `${b64({ alg: "RS256" })}.${b64(claims)}.sig`

test("the app's sign-in needs a stored Warp account", async () => {
  const method = plugin.auth.methods.find((m) => m.label.includes("Warp app"))
  await expect(method.authorize()).rejects.toThrow(/isn't signed in/)
})

test("a refresh token is exchanged for an account", async () => {
  globalThis.fetch = async (url, init) => {
    expect(String(url)).toContain("securetoken.googleapis.com/v1/token")
    expect(String(init.body)).toContain("grant_type=refresh_token")
    expect(new URLSearchParams(init.body).get("refresh_token")).toBe("the-refresh-token")
    return Response.json({
      id_token: fakeJwt({ email: "w@warp.dev", exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: "rotated",
      expires_in: "3600",
    })
  }
  const method = plugin.auth.methods.find((m) => m.type === "api")
  const saved = await method.authorize({ key: "the-refresh-token" })
  expect(saved.type).toBe("success")
  expect(saved.accountId).toBe("w@warp.dev")
  expect(saved.refresh).toBe("rotated")
  expect(saved.expires).toBeGreaterThan(Date.now() + 59 * 60_000)
})

test("manual sign-in accepts its prompt's inputs and rejects absent values without a request", async () => {
  const method = plugin.auth.methods.find((m) => m.type === "api")
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    calls++
    expect(new URLSearchParams(init.body).get("refresh_token")).toBe("prompt-token")
    return Response.json({ id_token: fakeJwt({ email: "w@test.invalid" }) })
  }
  const key = method.prompts[0].key
  expect((await method.authorize({ [key]: " prompt-token " })).refresh).toBe("prompt-token")
  for (const inputs of [undefined, {}, { key: {} }, { refresh_token: " " }]) {
    await expect(method.authorize(inputs)).rejects.toThrow(/required/)
  }
  expect(calls).toBe(1)
})

test("the refresh hook rotates what Google gives", async () => {
  globalThis.fetch = async () =>
    Response.json({ id_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: "next", expires_in: "3600" })
  const out = await plugin.auth.refresh({ type: "oauth", access: "", refresh: "old" })
  expect(out.refresh).toBe("next")
  expect(out.access).toContain(".")
})

test("Google refusing the token says to sign in again", async () => {
  globalThis.fetch = async () => Response.json({ error: { message: "INVALID_REFRESH_TOKEN" } }, { status: 400 })
  await expect(plugin.auth.refresh({ type: "oauth", access: "", refresh: "dead" })).rejects.toThrow(/INVALID_REFRESH_TOKEN/)
})
