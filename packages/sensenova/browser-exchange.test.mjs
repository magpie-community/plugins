// The browser sign-in's code exchange. The console's /oauth2/token refuses an
// authorization_code grant with no state, 400 invalid_request "one nonempty
// state required" (platform.sensenova.cn, 2026-11-26, a made-up code: the
// same request with a state gets past that check). The password sign-in's
// token host (signin.sensecore.cn) and the console's refresh_token grant
// don't ask for it. The fake answers the same way, and the browser capture
// is stood in for, so no Chromium starts.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { SenseNovaAuthPlugin, _internal } from "./index.mjs"
import { unseal } from "./lib/dpapi.mjs"
import { exchangeCode, refreshTokens } from "./lib/protocol.mjs"
import { fakeSenseNova, json, jwtOf } from "./fake.mjs"

const TOKEN_PATH = "/oauth2/token"
const saved = { capture: _internal.startLoginCapture, available: _internal.browserAvailable }

let f
afterEach(() => {
  f?.close()
  _internal.startLoginCapture = saved.capture
  _internal.browserAvailable = saved.available
})

// the console's token endpoint as it answers
const consoleToken = (r) => {
  if (r.form?.grant_type === "authorization_code" && !r.form?.state) {
    return json({ error: "invalid_request", error_description: "one nonempty state required" }, 400)
  }
  return json({
    access_token: jwtOf({ ext: { username: "nova-user" }, sub: "uid-1" }),
    refresh_token: "r-1",
    expires_in: 10800,
  })
}

test("the code is exchanged with the state it came back with", async () => {
  f = fakeSenseNova()
  f.route("POST " + TOKEN_PATH, consoleToken)
  const tokens = await exchangeCode({ code: "c-1", verifier: "v-1", state: "s-1" })
  expect(tokens.refresh_token).toBe("r-1")
  const form = f.seen.find((r) => r.path === TOKEN_PATH).form
  expect(form).toMatchObject({ grant_type: "authorization_code", code: "c-1", code_verifier: "v-1", state: "s-1" })
})

test("a refresh sends no state", async () => {
  f = fakeSenseNova()
  f.route("POST " + TOKEN_PATH, consoleToken)
  await refreshTokens("r-0")
  const form = f.seen.find((r) => r.path === TOKEN_PATH).form
  expect(form.grant_type).toBe("refresh_token")
  expect("state" in form).toBe(false)
})

test("a browser sign-in signs in with the state its authorize URL issued", async () => {
  f = fakeSenseNova()
  f.route("POST " + TOKEN_PATH, consoleToken)
  let issued = ""
  _internal.browserAvailable = () => true
  _internal.startLoginCapture = async ({ authorizeUrl, expectedState }) => {
    issued = new URL(authorizeUrl).searchParams.get("state")
    expect(expectedState).toBe(issued)
    return { result: Promise.resolve({ code: "c-2", state: issued, redirectUrl: "" }), close: async () => {} }
  }
  const p = await SenseNovaAuthPlugin({ client: { auth: { set: async () => {} } } }, { create_key: false })
  const out = await (await p.auth.methods[0].authorize({})).callback()
  expect(out.type).toBe("success")
  expect(out.accountId).toBe("nova-user")
  expect(await unseal(out.refresh)).toBe("r-1")
  expect(issued).toBeTruthy()
  expect(f.seen.find((r) => r.path === TOKEN_PATH).form.state).toBe(issued)
})
