// The walk's guards, tested as the pure helpers they are. The fake gives every
// host a single origin, so it cannot show a cookie crossing from one host to
// another, a downgrade of a *production* endpoint, or a walk that runs out of
// hops onto an off-site URL. These do, against the real endpoint values.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { allowedHost, newJar, cookieHeader, collectCookies, followUntil, ENDPOINTS } = _internal

const PROD = {
  console: "https://platform.sensenova.cn",
  iam: "https://iam.sensecoreapi.cn",
  token: "https://signin.sensecore.cn/oauth2/token",
  jwks: "https://signin.sensecore.cn/.well-known/jwks.json",
  api: "https://token.sensenova.cn/v1",
}

let was
afterEach(() => {
  if (was) Object.assign(ENDPOINTS, was)
  was = undefined
})

function production() {
  was = { ...ENDPOINTS }
  Object.assign(ENDPOINTS, PROD)
}

test("an endpoint authorises its own scheme, not merely its host", () => {
  production()
  expect(allowedHost("https://platform.sensenova.cn/oauth2/auth")).toBe(true)
  // the same host over http is a downgrade of it, not it. Matching the host
  // alone let this through the endpoint exemption, ahead of the https check
  // below — and the jar keys off .host too, so the session cookie would have
  // travelled in the clear. The fake never caught this because its endpoints
  // are 127.0.0.1, where the exemption doesn't match the name under test.
  expect(allowedHost("http://platform.sensenova.cn/continue")).toBe(false)
  expect(allowedHost("http://token.sensenova.cn/v1/models")).toBe(false)
  expect(allowedHost("http://signin.sensecore.cn/oauth2/token")).toBe(false)
})

test("the SenseTime domains are walkable and look-alikes are not", () => {
  production()
  expect(allowedHost("https://console.sensenova.cn/x")).toBe(true)
  expect(allowedHost("https://evil.example/?login_challenge=stolen")).toBe(false)
  // a suffix that reads like the domain is not the domain
  expect(allowedHost("https://sensenova.cn.evil.example/x")).toBe(false)
  expect(allowedHost("https://notsensecore.cn/x")).toBe(false)
  expect(allowedHost("not a url")).toBe(false)
})

test("a cookie goes back only to the host that set it", () => {
  const jar = newJar()
  const set = (url, line) => collectCookies(new Response(null, { headers: { "set-cookie": line } }), jar, url)
  set("https://platform.sensenova.cn/oauth2/auth", "hydra_session=s-1; Path=/")
  set("https://iam.sensecoreapi.cn/iam/login", "iam_csrf=c-9; Path=/")
  expect(cookieHeader(jar, "https://platform.sensenova.cn/callback")).toBe("hydra_session=s-1")
  expect(cookieHeader(jar, "https://iam.sensecoreapi.cn/iam/authn/v1/auth/nova/login")).toBe("iam_csrf=c-9")
  // neither leaks to the other, and a third host gets nothing at all
  expect(cookieHeader(jar, "https://evil.example/")).toBe("")
  // dropping the url is what once sent the IAM request out with no cookie: the
  // answer is an empty header, never every cookie in the jar
  expect(cookieHeader(jar, undefined)).toBe("")
})

test("a walk that runs out of hops does not hand back an off-site target", async () => {
  // the check inside the loop stops the fetching; the one after it has to stop
  // the *returning*. To reach it the off-site URL must arrive on the last hop,
  // so the loop has no iteration left in which to notice.
  production()
  let hops = 0
  let base = ""
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      hops++
      if (hops >= 8)
        return new Response(null, { status: 302, headers: { location: "https://evil.example/final?login_challenge=stolen" } })
      return new Response(null, { status: 302, headers: { location: `${base}/step` } })
    },
  })
  base = `http://127.0.0.1:${server.port}`
  Object.assign(ENDPOINTS, { console: base })
  try {
    await expect(followUntil(`${base}/start`, /login_challenge=/, newJar())).rejects.toThrow(
      "left the SenseNova hosts",
    )
    // it really did spend the whole budget before the last hop answered
    expect(hops).toBe(8)
  } finally {
    server.stop(true)
  }
})
