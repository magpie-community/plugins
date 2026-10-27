// Signing in as the IDE does: trae.cn's authorization page sends the
// browser back to the callback on 127.0.0.1 with the token pair and the
// account, or, from its older page, a refresh token to exchange.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin } from "./index.mjs"
import { fakeTrae, json } from "./fake.mjs"

let f
afterEach(() => f?.close())

async function start() {
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const [method] = hooks.auth.methods
  expect(method.type).toBe("oauth")
  const a = await method.authorize()
  expect(a.method).toBe("auto")
  const u = new URL(a.url)
  expect(u.pathname).toBe("/authorization")
  const q = u.searchParams
  expect(q.get("client_id")).toBe("ono9krqynydwx5")
  expect(q.get("login_channel")).toBe("native_ide")
  // a Trae CN device in its clients' 16-digit shape (#194)
  expect(q.get("device_id")).toMatch(/^[1-9]\d{15}$/)
  expect(q.get("x_device_id")).toBe(q.get("device_id"))
  expect(q.get("machine_id")).toMatch(/^[0-9a-f]{32}$/)
  const cb = new URL(q.get("auth_callback_url"))
  expect(cb.hostname).toBe("127.0.0.1")
  expect(cb.pathname).toBe("/authorize")
  return { a, cb, q }
}

test("the callback's userJwt and userInfo are the sign-in, with the device the page was told", async () => {
  f = fakeTrae()
  const { a, cb, q } = await start()
  const jwt = { Token: "jwt-1", RefreshToken: "r-1", TokenExpireAt: Math.floor(Date.now() / 1000) + 7200, ClientID: "ono9krqynydwx5" }
  const info = { UserID: "u-1", ScreenName: "Ann", Region: "CN", Host: "https://api.trae.cn" }
  const url = new URL(cb)
  url.searchParams.set("userJwt", JSON.stringify(jwt))
  url.searchParams.set("userInfo", JSON.stringify(info))
  const res = await fetch(url)
  expect(res.status).toBe(200)
  expect(res.headers.get("access-control-allow-origin")).toBe("*")
  expect(await res.text()).toContain("signed in")
  const got = await a.callback()
  expect(got.type).toBe("success")
  expect(got.access).toBe("jwt-1")
  expect(got.refresh).toBe("r-1")
  expect(got.accountId).toBe("Ann")
  expect(got.uid).toBe("u-1")
  expect(got.expires).toBe(jwt.TokenExpireAt * 1000)
  expect(got.deviceId).toBe(q.get("device_id"))
  expect(got.machineId).toBe(q.get("machine_id"))
  expect(got.api).toBeUndefined() // api.trae.cn serves no models
})

test("a refresh token alone is exchanged for the pair", async () => {
  f = fakeTrae()
  f.route("POST /cloudide/api/v3/trae/oauth/ExchangeToken", () => json({ Result: {
    Token: "jwt-2", RefreshToken: "r-2", TokenExpireAt: Date.now() + 7200_000, UserInfo: JSON.stringify({ UserID: "u-2", ScreenName: "Bo" }),
  } }))
  const { a, cb } = await start()
  const url = new URL(cb)
  url.searchParams.set("refreshToken", "r-old")
  await fetch(url)
  const got = await a.callback()
  expect(got.type).toBe("success")
  expect(got.access).toBe("jwt-2")
  expect(got.refresh).toBe("r-2")
  expect(got.accountId).toBe("Bo")
  expect(f.seen[0].json).toEqual({ ClientID: "ono9krqynydwx5", RefreshToken: "r-old", ClientSecret: "-", UserID: "" })
})

test("a callback with an error fails the sign-in", async () => {
  f = fakeTrae()
  const { a, cb } = await start()
  const url = new URL(cb)
  url.searchParams.set("error", "access_denied")
  await fetch(url)
  expect(await a.callback()).toEqual({ type: "failed", error: "access_denied" })
})
