import assert from "node:assert/strict"
import { test } from "node:test"
import { backgroundBlocked, cannotSignIn, forgetStoredSignIn, isDead, noteDead, parseStored, readStoredSignIn, storedSignIn, storedSignInNow } from "../signin.mjs"

const NOW = Date.parse("2026-11-13T00:00:00Z")
const stored = (token, extra = {}) => JSON.stringify({ token, auth_method: "consumer", id_token_email: "someone@example.com", ...extra })
const b64 = (s) => "go-keyring-base64:" + Buffer.from(s).toString("base64")

test("reads what agy's keyring value says, on macOS (base64) and Windows (raw JSON)", () => {
  const renewable = stored({ access_token: "a", refresh_token: "r", expiry: "2026-11-12T13:00:00Z", token_type: "Bearer" })
  for (const raw of [b64(renewable), renewable]) {
    const s = parseStored(raw, NOW)
    assert.equal(s.state, "present")
    assert.equal(s.canRenew, true)
    assert.equal(s.expired, true)
    assert.match(s.fp, /^[0-9a-f]{32}$/)
    assert.doesNotMatch(JSON.stringify(s), /someone|"a"|"r"/)
    // an ended access token with a refresh token is how a working agy looks
    assert.equal(cannotSignIn(s), "")
  }
  assert.notEqual(parseStored(renewable, NOW).fp, parseStored(stored({ refresh_token: "r2" }), NOW).fp)
})

test("an ended sign-in with nothing to renew it, or no token at all, can't sign agy in", () => {
  const ended = parseStored(b64(stored({ access_token: "a", expiry: "2026-11-12T00:00:00Z" })), NOW)
  assert.equal(ended.state, "present")
  assert.match(cannotSignIn(ended), /expired/)
  const live = parseStored(stored({ access_token: "a", expiry: "2026-11-14T00:00:00Z" }), NOW)
  assert.equal(cannotSignIn(live), "")
  // Go's zero time: doesn't end
  const zero = parseStored(stored({ access_token: "a", expiry: "0001-01-01T00:00:00Z" }), NOW)
  assert.equal(zero.expired, false)
  assert.equal(cannotSignIn(zero), "")
  assert.equal(parseStored(stored({ access_token: "", refresh_token: "" }), NOW).state, "missing")
  assert.match(cannotSignIn({ state: "missing" }), /isn't signed in/)
})

test("a value of another shape, or an API key, concludes nothing", () => {
  for (const raw of ["", "garbage", b64("not json"), JSON.stringify({ hello: 1 }), stored(undefined, { api_key: "k" }), stored({}, { api_key: "k" })]) {
    const s = parseStored(raw, NOW)
    assert.equal(s.state, "unknown", raw)
    assert.equal(cannotSignIn(s), "")
  }
})

test("readStoredSignIn asks each system's keyring the way go-keyring stores it", async () => {
  const value = stored({ access_token: "a", refresh_token: "r", expiry: "2026-11-12T00:00:00Z" })
  const calls = []
  const mac = (code, stdout = "") => async (file, args) => { calls.push([file, ...args]); return { code, stdout } }
  assert.equal((await readStoredSignIn({ platform: "darwin", exec: mac(44), env: {} })).state, "missing")
  assert.deepEqual(calls[0], ["/usr/bin/security", "find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"])
  assert.equal((await readStoredSignIn({ platform: "darwin", exec: mac(51), env: {} })).state, "unknown")
  assert.equal((await readStoredSignIn({ platform: "darwin", exec: mac(0, b64(value) + "\n"), now: NOW, env: {} })).state, "present")
  const win = (stdout, code = 0) => async (file, args) => { calls.push([file, ...args]); return { code, stdout } }
  assert.equal((await readStoredSignIn({ platform: "win32", exec: win("MISSING\r\n"), env: {} })).state, "missing")
  assert.match(calls.at(-1).at(-1), /CredReadW[\s\S]*'gemini:antigravity'/)
  assert.equal((await readStoredSignIn({ platform: "win32", exec: win("WARNING: something\r\nMISSING\r\n"), env: {} })).state, "missing")
  assert.equal((await readStoredSignIn({ platform: "win32", exec: win("ERROR 5\r\n"), env: {} })).state, "unknown")
  assert.equal((await readStoredSignIn({ platform: "win32", exec: win("", 1), env: {} })).state, "unknown")
  const w = await readStoredSignIn({ platform: "win32", exec: win("OK " + Buffer.from(value).toString("base64") + "\r\n"), now: NOW, env: {} })
  assert.equal(w.state, "present")
  assert.equal(w.canRenew, true)
  assert.equal((await readStoredSignIn({ platform: "linux", exec: mac(0), env: {} })).state, "unknown")
  const before = calls.length
  for (const env of [{ AGY_BRIDGE_STORED_SIGNIN: "skip" }, { GEMINI_API_KEY: "k" }, { AGY_ADC_AUTH: "1" }]) {
    assert.equal((await readStoredSignIn({ platform: "darwin", exec: mac(44), env })).state, "unknown")
  }
  assert.equal(calls.length, before)
})

test("one read serves a burst; a dead sign-in blocks background runs until another is stored", async () => {
  forgetStoredSignIn({ dead: true })
  let reads = 0
  let value = { state: "present", fp: "one", canRenew: true, expiresAt: 0, expired: false }
  const read = async () => { reads++; return value }
  await Promise.all([storedSignIn({ read }), storedSignIn({ read }), storedSignIn({ read })])
  assert.equal(reads, 1)
  assert.equal(await backgroundBlocked({ read }), "")
  noteDead(value)
  assert.ok(isDead(value))
  assert.match(await backgroundBlocked({ read }), /no longer works/)
  value = { ...value, fp: "two" }
  assert.equal(await backgroundBlocked({ read, fresh: true }), "")
  value = { state: "missing" }
  assert.match(await backgroundBlocked({ read, fresh: true }), /isn't signed in/)
  forgetStoredSignIn({ dead: true })
  assert.equal(isDead({ state: "present", fp: "one" }), false)
})

test("storedSignInNow answers from the last read without waiting, and reads again when it is old", async () => {
  forgetStoredSignIn({ dead: true })
  let reads = 0
  let release
  const read = () => { reads++; return new Promise((r) => { release = r }) }
  assert.equal(storedSignInNow({ read }), null)
  assert.equal(storedSignInNow({ read }), null)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(reads, 1)
  release({ state: "missing" })
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(storedSignInNow({ read }), { state: "missing" })
  assert.equal(reads, 1)
  forgetStoredSignIn({ dead: true })
})
