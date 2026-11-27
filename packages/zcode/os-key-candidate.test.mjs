import { expect, mock, test } from "bun:test"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const oldKey = randomBytes(32).toString("base64url")
const activeKey = randomBytes(32).toString("base64url")
let credentialReads = 0

// both store readers share the read counter, so whichever platform runs the
// test sees the home entry first and the moved folder's second: a store CLI
// (secret-tool, security) prints the password itself, Windows' CredReadW
// wrapper prints the blob as base64 (the password UTF-16LE within)
mock.module("node:child_process", () => ({
  execFileSync() {
    const key = credentialReads++ === 0 ? oldKey : activeKey
    return key
  },
  execSync() {
    const key = credentialReads++ === 0 ? oldKey : activeKey
    return Buffer.from(key, "utf16le").toString("base64")
  },
}))

const home = mkdtempSync(join(tmpdir(), "zcode-home-"))
const moved = mkdtempSync(join(tmpdir(), "zcode-moved-"))
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

  const { ZCodeAuthPlugin } = await import("./index.mjs")
  const hooks = await ZCodeAuthPlugin({ client: {} })
  const method = hooks.auth.methods.find((item) => item.label === "ZCode app's sign-in")
  const result = await (await method.authorize()).callback()

  expect(result.type).toBe("success")
  expect(result.accountId).toBe("Bo")
  expect(result.access).toBe("id1.secret1")
})
