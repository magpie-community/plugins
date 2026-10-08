// The two ways in: the Warp app's own sign-in (a DPAPI-encrypted file only
// a Windows Warp makes — the test home has none) and a pasted refresh
// token, exchanged with Google as magpie's refresh hook does.
import { afterAll, afterEach, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as os from "node:os"

// the plugin reads the Warp app's file under the real home; point that
// somewhere empty before it loads
const emptyHome = mkdtempSync(join(tmpdir(), "warp-signin-"))
mock.module("node:os", () => ({ ...os, homedir: () => emptyHome }))
const { WarpAuthPlugin } = await import("./index.mjs")

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
afterAll(() => rmSync(emptyHome, { recursive: true, force: true }))

const client = { auth: { set: async () => {} } }
const plugin = await WarpAuthPlugin({ client })

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const fakeJwt = (claims) => `${b64({ alg: "RS256" })}.${b64(claims)}.sig`

test("the app's sign-in needs the file a Windows Warp makes", async () => {
  const method = plugin.auth.methods.find((m) => m.label.includes("Warp app"))
  await expect(method.authorize()).rejects.toThrow(/isn't signed in/)
})

test("a refresh token is exchanged for an account", async () => {
  globalThis.fetch = async (url, init) => {
    expect(String(url)).toContain("securetoken.googleapis.com/v1/token")
    expect(String(init.body)).toContain("grant_type=refresh_token")
    return Response.json({
      id_token: fakeJwt({ email: "w@warp.dev", exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: "rotated",
      expires_in: "3600",
    })
  }
  const method = plugin.auth.methods.find((m) => m.type === "api")
  const saved = await method.authorize("the-refresh-token")
  expect(saved.type).toBe("success")
  expect(saved.accountId).toBe("w@warp.dev")
  expect(saved.refresh).toBe("rotated")
  expect(saved.expires).toBeGreaterThan(Date.now() + 59 * 60_000)
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
