import assert from "node:assert/strict"
import { test } from "node:test"
import { backgroundBlocked, cannotSignIn, emailOf, forgetStoredSignIn, heldByAnother, isDead, noteDead, parseStored, readStoredSignIn, signedInEmail, storedEmail, storedSignIn, storedSignInNow, storedToken } from "../signin.mjs"

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

test("an account of agy's own is held by another only when both emails are known and differ", () => {
  const b = parseStored(b64(stored({ access_token: "a", refresh_token: "r" }, { id_token_email: "B@example.com" })), NOW)
  assert.doesNotMatch(JSON.stringify(b), /example/)
  assert.equal(heldByAnother(b, "a@example.com"), true)
  assert.equal(heldByAnother(b, " b@EXAMPLE.com "), false)
  assert.equal(heldByAnother(b, ""), false)
  assert.equal(heldByAnother(parseStored(b64(stored({ access_token: "a" }, { id_token_email: "" })), NOW), "a@example.com"), false)
  assert.equal(heldByAnother({ state: "unknown" }, "a@example.com"), false)
  assert.equal(heldByAnother({ state: "missing" }, "a@example.com"), false)
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

test("macOS: a login keychain this process doesn't search (a LaunchDaemon) is out of reach, not a missing sign-in", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-kc-"))
  try {
    const dir = path.join(home, "Library", "Keychains")
    const env = { HOME: home }
    const mac = (find, list, listCode = 0) => async (_file, args) => args[0] === "list-keychains" ? { code: listCode, stdout: list } : { code: find, stdout: "" }
    const system = '    "/Library/Keychains/System.keychain"\n'
    const login = `    "${dir}/login.keychain-db"\n` + system
    // no login keychain at all: nothing is out of reach
    assert.equal((await readStoredSignIn({ platform: "darwin", exec: mac(44, system), env })).state, "missing")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "login.keychain-db"), "")
    assert.equal((await readStoredSignIn({ platform: "darwin", exec: mac(44, login), env })).state, "missing")
    for (const code of [44, 36]) {
      const s = await readStoredSignIn({ platform: "darwin", exec: mac(code, system), env })
      assert.equal(s.state, "unreachable", String(code))
      assert.match(cannotSignIn(s), /LaunchDaemon[\s\S]*magpie daemon install[\s\S]*Add another Google account/)
    }
    // a search list it can't read concludes nothing new
    assert.equal((await readStoredSignIn({ platform: "darwin", exec: mac(44, "", 1), env })).state, "missing")
    assert.equal((await readStoredSignIn({ platform: "darwin", exec: mac(51, ""), env })).state, "unknown")
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
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

// Archivemylife on X: the account showed as "API key", and signing in to
// another Google account looked like nothing happened. A sign-in names the
// account by the email agy stored; the cached read still doesn't carry it.
// tmr11235 on X (v0.1.4520): agy's own sign-in, taken again after the
// account was removed, was listed as "API key". A stored sign-in that
// doesn't name its account is named by who Google says its token is for.
test("signedInEmail asks Google who a sign-in is for when agy's doesn't say", async () => {
  const mac = (raw) => async () => ({ code: 0, stdout: b64(raw) })
  const asked = []
  const google = (reply, status = 200) => async (url, init) => {
    asked.push([url, init.headers.Authorization])
    return new Response(JSON.stringify(reply), { status })
  }
  const named = stored({ access_token: "a" })
  assert.equal(await signedInEmail({ platform: "darwin", exec: mac(named), env: {} }, { fetch: google({ email: "other@example.com" }) }), "someone@example.com")
  assert.equal(asked.length, 0, "a sign-in that names its account isn't asked about")
  const unnamed = stored({ access_token: "tok" }, { id_token_email: undefined })
  assert.equal(await signedInEmail({ platform: "darwin", exec: mac(unnamed), env: {} }, { fetch: google({ email: "who@example.com" }) }), "who@example.com")
  assert.deepEqual(asked, [["https://www.googleapis.com/oauth2/v2/userinfo", "Bearer tok"]])
  assert.equal(await signedInEmail({ platform: "darwin", exec: mac(unnamed), env: {} }, { fetch: google({ error: "x" }, 401) }), "")
  assert.equal(await signedInEmail({ platform: "darwin", exec: mac(unnamed), env: {} }, { fetch: async () => { throw new Error("offline") } }), "")
  assert.equal(await signedInEmail({ platform: "darwin", exec: async () => ({ code: 44, stdout: "" }), env: {} }, { fetch: google({ email: "who@example.com" }) }), "")
})

test("storedEmail is the Google account agy's keyring is signed in to, on macOS and Windows", async () => {
  const value = stored({ access_token: "a", refresh_token: "r", expiry: "2026-11-12T00:00:00Z" })
  assert.equal(emailOf(b64(value)), "someone@example.com")
  assert.equal(emailOf(value), "someone@example.com")
  assert.equal(emailOf(stored({ access_token: "a" }, { id_token_email: undefined })), "")
  assert.equal(emailOf("garbage"), "")
  const mac = (code, stdout = "") => async () => ({ code, stdout })
  assert.equal(await storedEmail({ platform: "darwin", exec: mac(0, b64(value) + "\n"), env: {} }), "someone@example.com")
  assert.equal(await storedEmail({ platform: "darwin", exec: mac(44), env: {} }), "")
  assert.equal(await storedEmail({ platform: "darwin", exec: async () => { throw new Error("no security") }, env: {} }), "")
  assert.equal(await storedEmail({ platform: "win32", exec: mac(0, "OK " + Buffer.from(value).toString("base64") + "\r\n"), env: {} }), "someone@example.com")
  assert.equal(await storedEmail({ platform: "darwin", exec: mac(0, b64(value)), env: { AGY_BRIDGE_STORED_SIGNIN: "skip" } }), "")
})

test("Linux: agy's own sign-in is read from its token file, and no file concludes nothing (#1502)", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-linux-"))
  try {
    const exec = async () => { throw new Error("no keyring tool is run on Linux") }
    assert.equal((await readStoredSignIn({ platform: "linux", exec, env: { HOME: home } })).state, "unknown")
    const value = stored({ access_token: "a", refresh_token: "r", expiry: "2026-11-12T00:00:00Z" })
    const file = path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, value)
    const s = await readStoredSignIn({ platform: "linux", exec, now: NOW, env: { HOME: home } })
    assert.equal(s.state, "present")
    assert.equal(s.canRenew, true)
    assert.equal((await storedToken({ platform: "linux", exec, env: { HOME: home } }))?.token?.refresh_token, "r")
    assert.equal(await storedEmail({ platform: "linux", exec, env: { HOME: home } }), "someone@example.com")
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
