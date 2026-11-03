// A fake of SenseNova's hosts for the tests: one local server standing in
// for the console, the IAM login and the token endpoint, which the plugin's
// ENDPOINTS are pointed at. route(method, path) answers a request; seen
// lists what came.
import { generateKeyPairSync } from "node:crypto"
import { _internal } from "./index.mjs"

export function fakeSenseNova() {
  const routes = new Map()
  const seen = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const text = await req.text()
      const r = { method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, text, url: url.pathname + url.search }
      if ((req.headers.get("content-type") ?? "").includes("x-www-form-urlencoded")) r.form = Object.fromEntries(new URLSearchParams(text))
      else if (text) try { r.json = JSON.parse(text) } catch {}
      seen.push(r)
      const h = routes.get(req.method + " " + url.pathname)
      if (!h) return new Response("no route " + req.method + " " + url.pathname, { status: 404 })
      return h(r)
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  const was = { ..._internal.ENDPOINTS }
  // the plugin appends its own paths to these: the token endpoint's
  // "/oauth2/token", the IAM login's "/iam/authn/...", the JWKS document's
  // "/.well-known/jwks.json"
  Object.assign(_internal.ENDPOINTS, {
    console: origin,
    iam: origin,
    token: origin + "/oauth2/token",
    jwks: origin + "/.well-known/jwks.json",
    api: origin,
  })
  return {
    origin,
    seen,
    route: (key, h) => routes.set(key, h),
    close() {
      server.stop(true)
      Object.assign(_internal.ENDPOINTS, was)
    },
  }
}

export const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } })

// a JWT as the console's tokens are, with the claims given
export const jwtOf = (claims) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".")

// a JWKS as the platform publishes it: the RSA key the password is sealed to
export const jwksOf = (kid = "public:hydra.openid.id-token") => ({
  keys: [{ kid, kty: "RSA", alg: "RSA-OAEP", use: "enc", n: jwkN, e: "AQAB" }],
})

// a 2048-bit RSA modulus, base64url, as a JWKS gives it
const jwkN = (() => {
  const jwk = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "jwk" })
  return jwk.n
})()
