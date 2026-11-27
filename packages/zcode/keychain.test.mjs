// ZCode 3.18 keeps its enc:v2:os key in the system's keychain, another
// app's secret: reading it puts up a prompt ("magpie-bun wants to use …
// ZCode Credential Encryption"). 0.1.72 read it for every request, model
// list and usage card of a ZCode app's sign-in, and a no (or a cancel, or
// no answer) rested five minutes before the next prompt, so the prompt came
// back again and again, after ZCode had quit too (@heyedisonwong on X).
// The keychain is read only while the user adds the sign-in, once, and the
// key it gives is kept with the sign-in.
import { afterAll, expect, mock, setSystemTime, test } from "bun:test"
import * as cp from "node:child_process"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import { join } from "node:path"

// the store's readers, faked only while this file's tests run (see
// os-key-candidate.test.mjs: bun keeps a module mock for the whole run):
// `security` and `secret-tool` print the key, Windows' CredReadW wrapper
// its UTF-16LE blob as base64; "deny" is the user's no to the prompt
let faking = false
let answer = "deny"
let storeKey = ""
let reads = 0
const { execFileSync: realExecFileSync, execSync: realExecSync } = cp
const denied = () => Object.assign(new Error("security: SecKeychainSearchCopyNext: User canceled the operation."), { status: 128, stderr: "" })
function execFileSync(cmd, ...rest) {
  if (!faking || !["security", "secret-tool"].includes(cmd)) return realExecFileSync(cmd, ...rest)
  reads++
  if (answer === "deny") throw denied()
  return storeKey + "\n"
}
function execSync(command, ...rest) {
  if (!faking || !String(command).startsWith("powershell")) return realExecSync(command, ...rest)
  reads++
  if (answer === "deny") throw denied()
  return Buffer.from(storeKey, "utf16le").toString("base64")
}
mock.module("node:child_process", () => ({ ...cp, default: { ...cp, execFileSync, execSync }, execFileSync, execSync }))

const started = os.homedir()
const homedir = () => (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) || started
mock.module("node:os", () => ({ ...os, default: { ...os, homedir }, homedir }))

const outside = { ...process.env }
afterAll(() => {
  faking = false
  setSystemTime()
  for (const key of Object.keys(process.env)) if (!(key in outside)) delete process.env[key]
  Object.assign(process.env, outside)
})

const home = mkdtempSync(join(os.tmpdir(), "zcode-keychain-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.LOCALAPPDATA = join(home, "LocalAppData")
delete process.env.ZCODE_CREDENTIAL_SECRET
delete process.env.ZCODE_CREDENTIAL_SECRET_FILE

const store = join(home, ".zcode", "v2")
const KEY = "account-provider:coding-plan:account:zai-individual-coding-plan:account:u1:api-key"
function enc2(text, key) {
  const raw = Buffer.from(key, "base64url")
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", raw, iv)
  const data = Buffer.concat([c.update(text, "utf8"), c.final()])
  const payload = [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".")
  return `enc:v2:os:${createHash("sha256").update(raw).digest("hex").slice(0, 24)}:${payload}`
}
// zcodeHas writes ZCode 3.18's credentials, locked with key
function zcodeHas(key, { plan = "id1.secret1", jwt = "j1" } = {}) {
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, "setting.json"), "{}")
  const values = { [KEY]: plan, zcodejwttoken: `Bearer ${jwt}`, "oauth:zai:user_info": JSON.stringify({ id: "u9", displayName: "Bo" }) }
  writeFileSync(join(store, "credentials.json"), JSON.stringify(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, enc2(v, key)]))))
}

async function plugin() {
  const mod = await import("./index.mjs")
  const hooks = await mod.ZCodeAuthPlugin({ client: {} })
  return { ...mod, hooks, signIn: hooks.auth.methods.find((m) => m.label === "ZCode app's sign-in") }
}

// everything that reads a sign-in on its own, as magpie calls it: the
// provider's loader and each request (stateOf), the models and the usage
// card (stateOf, then giftSignIn), the daily check-in (stateOf), over half
// an hour, past the five minutes 0.1.72 rested a no for
async function backgroundReads(_internal, auth) {
  const t0 = Date.now()
  let s
  try {
    for (let i = 0; i < 7; i++) {
      setSystemTime(new Date(t0 + i * 6 * 60_000))
      s = _internal.stateOf(auth)
      _internal.giftSignIn(s, false)
    }
  } finally {
    setSystemTime()
  }
  return s
}

test("a ZCode app's sign-in added before 3.18's key was kept never reads the keychain", async () => {
  const { _internal } = await plugin()
  zcodeHas(randomBytes(32).toString("base64url"))
  const auth = { type: "oauth", access: "id0.secret0", refresh: JSON.stringify({ source: "zcode", key: "id0.secret0", jwt: "j0", site: "zai" }), accountId: "Bo", uid: "u9" }
  faking = true
  answer = "deny"
  reads = 0
  let s
  try {
    s = await backgroundReads(_internal, auth)
  } finally {
    faking = false
  }
  expect(reads).toBe(0)
  // it keeps what it saved, and says how to follow ZCode again
  expect(s).toMatchObject({ key: "id0.secret0", jwt: "j0" })
  const card = _internal.giftSignIn({ ..._internal.stateOf(auth), jwt: "" }, false)
  expect(card.display).toContain("read only when you add this sign-in")
})

test("a no to the keychain prompt is asked once, when the user adds the sign-in, and never again on its own", async () => {
  const { _internal, signIn } = await plugin()
  zcodeHas(randomBytes(32).toString("base64url"))
  faking = true
  answer = "deny"
  reads = 0
  let got
  try {
    got = await (await signIn.authorize()).callback()
    expect(reads).toBe(1)
    const auth = { type: "oauth", access: "id0.secret0", refresh: JSON.stringify({ source: "zcode", key: "id0.secret0", jwt: "j0" }), accountId: "Bo" }
    await backgroundReads(_internal, auth)
  } finally {
    faking = false
  }
  expect(reads).toBe(1)
  expect(got.type).toBe("failed")
  // Windows' Credential Manager asks no one: there is no no to say
  if (process.platform !== "win32") expect(got.error).toContain("didn't give ZCode's key")
})

test("the key the sign-in read is kept with it: after a restart requests follow ZCode with no keychain read", async () => {
  const { _internal, signIn } = await plugin()
  const key = randomBytes(32).toString("base64url")
  zcodeHas(key)
  faking = true
  answer = "key"
  storeKey = key
  reads = 0
  let got
  try {
    got = await (await signIn.authorize()).callback()
  } finally {
    faking = false
  }
  expect(reads).toBe(1)
  expect(got).toMatchObject({ type: "success", accountId: "Bo", access: "id1.secret1" })
  const kept = JSON.parse(got.refresh)
  expect(kept.osKey).toBe(key)
  const auth = { ...got, type: "oauth" }

  // magpie restarts (no key in memory), ZCode renews its session
  _internal.osKeys.clear()
  zcodeHas(key, { jwt: "j2" })
  faking = true
  answer = "deny"
  let s
  try {
    s = await backgroundReads(_internal, auth)
    // ZCode made a new key: the sign-in keeps what it saved, and asks nothing
    zcodeHas(randomBytes(32).toString("base64url"), { jwt: "j3" })
    expect(_internal.stateOf(auth)).toMatchObject({ key: "id1.secret1", jwt: "j1" })
  } finally {
    faking = false
  }
  expect(s).toMatchObject({ key: "id1.secret1", jwt: "j2", osKey: key })
  expect(reads).toBe(1)
})
