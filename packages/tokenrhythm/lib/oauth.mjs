// Loopback OAuth helper for TokenRhythm.
//
// One sign-in = one 127.0.0.1 listener on an ephemeral port. The authorize URL
// carries the PKCE challenge and state; the callback must return both on
// /oauth/callback exactly once. Everything is injectable enough for tests:
// origin can point at a local fake, openBrowser is supplied by the plugin.
import http from "node:http"
import { randomUUID } from "node:crypto"
import { buildAuthorizeUrl, pkce, TokenRhythmError, OAuthError } from "./tokenrhythm.mjs"

const RECEIPT = "<!doctype html><html><head><meta charset=\"utf-8\"><title>TokenRhythm sign-in</title></head><body style=\"font-family:system-ui,sans-serif;padding:2rem\"><h1>Sign-in complete</h1><p>You can close this window and return to Magpie.</p></body></html>"
const BAD = "<!doctype html><html><head><meta charset=\"utf-8\"><title>TokenRhythm sign-in</title></head><body style=\"font-family:system-ui,sans-serif;padding:2rem\"><h1>Sign-in failed</h1><p>Return to Magpie and try again.</p></body></html>"

function closeServer(server) {
  try { server.close() } catch { /* already closed */ }
  try { server.closeAllConnections?.() } catch { /* older node */ }
}

export async function startLoopbackLogin({ origin, timeoutMs = 300_000, installationId = randomUUID() } = {}) {
  const { state, verifier, challenge } = pkce()
  const server = http.createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string" || !address.port) {
    closeServer(server)
    throw new TokenRhythmError("could not bind the OAuth loopback port", { code: "OAUTH_LOOPBACK" })
  }
  const redirectUri = "http://127.0.0.1:" + address.port + "/oauth/callback"

  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  let settled = false
  const finish = (ok, value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    closeServer(server)
    if (ok) resolvePromise(value)
    else rejectPromise(value)
  }
  const timer = setTimeout(() => {
    finish(false, new TokenRhythmError("TokenRhythm sign-in timed out", { code: "OAUTH_TIMEOUT" }))
  }, Math.max(1_000, timeoutMs))
  timer.unref?.()
  server.unref?.()

  server.on("request", (req, res) => {
    const respond = (status, html, done) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      res.end(html, () => done())
    }
    let url
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1")
    } catch {
      respond(400, BAD, () => finish(false, new TokenRhythmError("OAUTH_BAD_CALLBACK", { code: "OAUTH_BAD_CALLBACK" })))
      return
    }
    if (url.pathname !== "/oauth/callback") {
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204)
        res.end()
      } else {
        respond(404, BAD, () => undefined)
      }
      return
    }
    if (req.method !== "GET") {
      respond(405, BAD, () => finish(false, new TokenRhythmError("OAUTH_BAD_CALLBACK", { code: "OAUTH_BAD_CALLBACK" })))
      return
    }
    const error = url.searchParams.get("error")
    if (error) {
      const code = "OAUTH_" + String(error).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 80)
      respond(400, BAD, () => finish(false, new OAuthError("TokenRhythm sign-in was refused: " + error, { code })))
      return
    }
    const states = url.searchParams.getAll("state")
    const codes = url.searchParams.getAll("code")
    if (states.length !== 1 || states[0] !== state) {
      respond(400, BAD, () => finish(false, new TokenRhythmError("OAuth state mismatch", { code: "OAUTH_STATE_MISMATCH" })))
      return
    }
    if (codes.length !== 1 || !codes[0]) {
      respond(400, BAD, () => finish(false, new TokenRhythmError("OAuth callback did not return a code", { code: "OAUTH_BAD_CALLBACK" })))
      return
    }
    respond(200, RECEIPT, () => finish(true, { code: codes[0], state }))
  })

  const url = buildAuthorizeUrl({ origin, redirectUri, state, challenge, installationId })
  return {
    url,
    redirectUri,
    state,
    verifier,
    installationId,
    promise,
    close() {
      finish(false, new TokenRhythmError("TokenRhythm sign-in cancelled", { code: "OAUTH_CANCELLED", cancelled: true }))
    },
  }
}
