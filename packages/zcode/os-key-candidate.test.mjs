import { afterAll, expect, mock, test } from "bun:test"
import * as cp from "node:child_process"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import { join } from "node:path"

const oldKey = randomBytes(32).toString("base64url")
const activeKey = randomBytes(32).toString("base64url")
let credentialReads = 0

// bun test runs every package's files in one process, and a module mock
// stays for the whole run: a mock that answered every execFileSync with a
// key broke inkstone's fake browser, doubao-work's process list and agy's
// smoke test in the root run. So both mocks pass through to the real
// functions, and fake only while this file's test runs (`faking`).
//
// Both store readers share the read counter, so whichever platform runs the
// test sees the home entry first and the moved folder's second: a store CLI
// (secret-tool, security) prints the password itself, Windows' CredReadW
// wrapper prints the blob as base64 (the password UTF-16LE within).
let faking = false
const { execFileSync: realExecFileSync, execSync: realExecSync } = cp
function execFileSync(...args) {
  if (!faking) return realExecFileSync(...args)
  return credentialReads++ === 0 ? oldKey : activeKey
}
function execSync(...args) {
  if (!faking) return realExecSync(...args)
  const key = credentialReads++ === 0 ? oldKey : activeKey
  return Buffer.from(key, "utf16le").toString("base64")
}
mock.module("node:child_process", () => ({ ...cp, default: { ...cp, execFileSync, execSync }, execFileSync, execSync }))

// bun's os.homedir() keeps the home the process started with, so the plugin
// would read the real ~/.zcode and never the store this test writes. homedir
// reads HOME (USERPROFILE) when called, as Node's does, so other packages see
// the started home again once the environment is put back.
const started = os.homedir()
const homedir = () => (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) || started
mock.module("node:os", () => ({ ...os, default: { ...os, homedir }, homedir }))

const outside = { ...process.env }
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in outside)) delete process.env[key]
  Object.assign(process.env, outside)
})

const home = mkdtempSync(join(os.tmpdir(), "zcode-home-"))
const moved = mkdtempSync(join(os.tmpdir(), "zcode-moved-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.LOCALAPPDATA = join(home, "LocalAppData")
delete process.env.ZCODE_CREDENTIAL_SECRET
delete process.env.ZCODE_CREDENTIAL_SECRET_FILE

function enc2(text, key) {
  const iv = randomBytes(12)
  const rawKey = Buffer.from(key, "base64url")
  const cipher = createCipheriv("aes-256-gcm", rawKey, iv)
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()])
  const payload = [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".")
  return `enc:v2:os:${createHash("sha256").update(rawKey).digest("hex").slice(0, 24)}:${payload}`
}

test("a moved ZCode data folder uses the matching credential-store entry", async () => {
  const homeStore = join(home, ".zcode", "v2")
  const activeStore = join(moved, ".zcode", "v2")
  mkdirSync(homeStore, { recursive: true })
  mkdirSync(activeStore, { recursive: true })
  writeFileSync(join(homeStore, "setting.json"), JSON.stringify({ dataBaseDir: moved }))
  writeFileSync(join(homeStore, "credentials.json"), "{}")

  const key = "account-provider:coding-plan:account:zai-individual-coding-plan:account:u1:api-key"
  const credentials = {
    [key]: enc2("id1.secret1", activeKey),
    zcodejwttoken: enc2("Bearer j1", activeKey),
    "oauth:zai:user_info": enc2(JSON.stringify({ id: "u9", displayName: "Bo" }), activeKey),
  }
  writeFileSync(join(activeStore, "credentials.json"), JSON.stringify(credentials))

  faking = true
  let result
  try {
    const { ZCodeAuthPlugin } = await import("./index.mjs")
    const hooks = await ZCodeAuthPlugin({ client: {} })
    const method = hooks.auth.methods.find((item) => item.label === "ZCode app's sign-in")
    result = await (await method.authorize()).callback()
  } finally {
    faking = false
  }

  expect(result.type).toBe("success")
  expect(result.accountId).toBe("Bo")
  expect(result.access).toBe("id1.secret1")
})
