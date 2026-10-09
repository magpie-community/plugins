import { afterEach, expect, test } from "bun:test"
import { _internal as w } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`
const custom = jwt({ uid: "anonymous-user", aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit" })

for (const failure of ["network", "timeout", "503", "429", "malformed"]) {
  test(`refresh retries via Warp's proxy after ${failure}, preserving the form`, async () => {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push([String(url), init.body])
      expect(init.redirect).toBe("error")
      if (calls.length === 1) {
        if (failure === "network") throw new TypeError("network failure")
        if (failure === "timeout") throw new DOMException("timeout", "TimeoutError")
        if (failure === "malformed") return new Response("bad gateway", { status: 502 })
        return Response.json({ error: { message: "temporary" } }, { status: Number(failure) })
      }
      return Response.json({ id_token: "new-id", refresh_token: "rotated", expires_in: "3600" })
    }
    expect((await w.exchange("original-refresh")).refresh).toBe("rotated")
    expect(calls.length).toBe(2)
    expect(new URL(calls[0][0]).hostname).toBe("securetoken.googleapis.com")
    expect(new URL(calls[1][0]).pathname).toBe("/proxy/token")
    expect(new URL(calls[1][0]).hostname).toBe("app.warp.dev")
    expect(calls[1][1]).toBe(calls[0][1])
    expect(new URLSearchParams(calls[1][1]).get("refresh_token")).toBe("original-refresh")
  })
}

test("definitive refresh rejection is not retried and never echoes the secret", async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return Response.json({ error: { message: "INVALID_REFRESH_TOKEN: secret-refresh" } }, { status: 400 })
  }
  try { await w.exchange("secret-refresh"); throw new Error("expected rejection") }
  catch (error) {
    expect(error.signIn).toBe("expired")
    expect(error.message).not.toContain("secret-refresh")
  }
  expect(calls).toBe(1)
})

test("both token services being unreachable does not expire a sign-in", async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error("synthetic network failure") }
  const error = await w.exchange("refresh").catch((error) => error)
  expect(error.status).toBe(503)
  expect(error.signIn).toBeUndefined()
  expect(calls).toBe(2)
})

test("anonymous app custom tokens are recognized and exchanged for renewable credentials", async () => {
  const access = jwt({ sub: "anonymous-user", exp: Math.floor(Date.now() / 1000) + 3600, firebase: { sign_in_provider: "anonymous" } })
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    const form = new URLSearchParams(init.body)
    if (calls.length === 1) {
      expect(new URL(url).pathname).toBe("/proxy/customToken")
      expect(form.get("token")).toBe(custom)
      expect(form.get("returnSecureToken")).toBe("true")
      expect(form.has("refresh_token")).toBe(false)
      return Response.json({ idToken: access, refreshToken: "renewable", expiresIn: "3600" })
    }
    expect(new URL(url).hostname).toBe("securetoken.googleapis.com")
    expect(form.get("refresh_token")).toBe("renewable")
    return Response.json({ id_token: access, refresh_token: "renewed", expires_in: "3600" })
  }
  const p = await w.createPlugin({ client: { auth: { set: async () => {} } } }, { readUser: async () => ({
    email: "", local_id: "anonymous-user", anonymous_user_type: "NativeClientAnonymousUser", linked_at: null,
    id_token: { id_token: "expired", refresh_token: custom, expiration_time: "2000-01-01T00:00:00Z" },
  }) })
  const login = await p.auth.methods[0].authorize()
  expect(login.instructions).toContain("anonymous")
  const saved = await login.callback()
  expect(saved).toMatchObject({ accountId: "anonymous-user", refresh: "renewable", metadata: { anonymous: true, uid: "anonymous-user" } })
  expect((await p.auth.refresh(saved)).refresh).toBe("renewed")
  expect(calls.length).toBe(2)
})

test("custom-token rejection is an explicit login failure rather than a refresh request", async () => {
  globalThis.fetch = async () => Response.json({ error: { message: "INVALID_CUSTOM_TOKEN" } }, { status: 400 })
  await expect(w.exchange(custom)).rejects.toMatchObject({ status: 401, signIn: "expired" })
})
