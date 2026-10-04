// A sign-in WorkBuddy 5.6 seals at rest ({$wbEncrypted: 1, envelope}) is
// opened through the app's own Electron runtime; a plain one (credential
// protection off, the default) is read exactly as it always was. The sealed
// path is proved here against a field this file seals itself, with the
// protector key handed to the reader directly, so no real sign-in, key or
// secret is read, and no token is ever printed.
//
// This machine's own install is proved separately, read-only and opt-in, in
// live-readonly.test.mjs (WORKBUDDY_LIVE=1).
import { afterEach, beforeAll, expect, test } from "bun:test"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { mkdirSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { realpathSync } from "node:fs"
import { _internal } from "./index.mjs"

let home
beforeAll(() => {
  // Bun reads HOME once, at start: run as HOME=$(mktemp -d) bun test, so no
  // real sign-in is ever read
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  home = homedir()
})
afterEach(() => {
  _internal.electronFound.clear()
  _internal.atRestKeys.clear()
})

const {
  isEncryptedWorkBuddyValue, parseWrappedField, buildAuthenticatedContextAad, openAuthField,
  parseAtRestPayload, base64Of, readDesktop, desktopFile, rootPaths, drivePaths,
  ELECTRON_BIN_ENV, atRestKeys, SITES,
} = _internal

// sealForTest writes one field the way the app does, so the reader can be
// proved without a real key.
function sealForTest(key, plaintext, suite = 1) {
  const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16)
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 })
  cipher.setAAD(buildAuthenticatedContextAad(keyId, suite))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()])
  const inner = { suite, keyId, nonce: nonce.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }
  return { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(inner), "utf8").toString("base64") }
}

const keyFor = (secret) => createHash("sha256").update(secret, "utf8").digest()
const idOf = (key) => createHash("sha256").update(key).digest("hex").slice(0, 16)

// writeDesktop puts a sign-in where the plugin reads it, under the test's HOME.
function writeDesktop(info, site = SITES.workbuddy) {
  const path = desktopFile(site)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify(info))
  return path
}

// ---- telling a sealed value from a plain one --------------------------------

test("a sealed value is told from a plain one, and from an ordinary object", () => {
  expect(isEncryptedWorkBuddyValue({ $wbEncrypted: 1, envelope: "e30=" })).toBe(true)
  // a plain token, an ordinary object and a marker without its envelope are not sealed
  expect(isEncryptedWorkBuddyValue("eyJhbGciOiJSUzI1NiJ9.e30.sig")).toBe(false)
  expect(isEncryptedWorkBuddyValue({})).toBe(false)
  expect(isEncryptedWorkBuddyValue({ $wbEncrypted: 1 })).toBe(false)
  expect(isEncryptedWorkBuddyValue({ $wbEncrypted: 1, envelope: "" })).toBe(false)
  expect(isEncryptedWorkBuddyValue({ $wbEncrypted: 2, envelope: "e30=" })).toBe(false)
  expect(isEncryptedWorkBuddyValue(null)).toBe(false)
  expect(isEncryptedWorkBuddyValue([{ $wbEncrypted: 1, envelope: "e30=" }])).toBe(false)
})

// ---- the envelope's own shape ----------------------------------------------

test("only the format WorkBuddy 5.6 writes is accepted", () => {
  const key = keyFor("secret-in-memory")
  const sealed = sealForTest(key, "a-token")
  const parts = parseWrappedField(sealed)
  expect(parts.suite).toBe(1)
  expect(parts.keyId).toBe(idOf(key))
  expect(parts.nonce.length).toBe(12)
  expect(parts.authTag.length).toBe(16)
  // a wrapper whose envelope isn't JSON, one missing a part and one whose
  // nonce is the wrong length are all refused, not guessed at
  expect(parseWrappedField({ $wbEncrypted: 1, envelope: Buffer.from("not json", "utf8").toString("base64") })).toBeUndefined()
  expect(parseWrappedField({ $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify({ suite: 1, keyId: idOf(key) }), "utf8").toString("base64") })).toBeUndefined()
  const short = JSON.parse(Buffer.from(sealed.envelope, "base64").toString("utf8"))
  short.nonce = Buffer.alloc(8).toString("base64")
  expect(parseWrappedField({ $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(short), "utf8").toString("base64") })).toBeUndefined()
  // and a suite that isn't an integer, or a keyId that isn't 16 hex
  short.nonce = randomBytes(12).toString("base64")
  short.suite = 1.5
  expect(parseWrappedField({ $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(short), "utf8").toString("base64") })).toBeUndefined()
  short.suite = 1
  short.keyId = "not-a-key-id"
  expect(parseWrappedField({ $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(short), "utf8").toString("base64") })).toBeUndefined()
})

test("base64Of reads only what round-trips at the length asked for", () => {
  const twelve = randomBytes(12).toString("base64")
  expect(base64Of(twelve, 12)?.length).toBe(12)
  expect(base64Of(twelve, 16)).toBeUndefined()
  expect(base64Of("")).toBeUndefined()
  expect(base64Of("!!!not base64!!!")).toBeUndefined()
})

// ---- the AAD the app's own builder writes ----------------------------------

test("the authenticated-context AAD is the app's own framing", () => {
  const keyId = "0123456789abcdef"
  const aad = buildAuthenticatedContextAad(keyId, 1)
  // WB-AAD\0, the version byte, then length-prefixed "WBEV1" and "sym-v1",
  // the suite as 4 bytes big-endian, the length-prefixed key id, and the
  // trailing context bytes -?the app's own buildAuthenticatedContextAad.
  const expected = Buffer.concat([
    Buffer.from("WB-AAD\0", "ascii"),
    Buffer.from([1]),
    Buffer.from([0, 0, 0, 5]), Buffer.from("WBEV1", "ascii"),
    Buffer.from([0, 0, 0, 6]), Buffer.from("sym-v1", "ascii"),
    Buffer.from([0, 0, 0, 1]),
    Buffer.from([0, 0, 0, 16]), Buffer.from(keyId, "utf8"),
    Buffer.from([2, 0, 0]),
  ])
  expect(aad.equals(expected)).toBe(true)
})

// ---- opening a field ------------------------------------------------------

test("a sealed field opens with the key its id names, and only that key", () => {
  const key = keyFor("secret-in-memory")
  const other = keyFor("another-install")
  const sealed = sealForTest(key, "the-access-token")
  const parts = parseWrappedField(sealed)
  expect(openAuthField(key, parts)).toBe("the-access-token")
  // a key from another install does not open it, and neither does a tampered
  // ciphertext: both come back undefined, never a wrong token
  expect(openAuthField(other, parts)).toBeUndefined()
  const tampered = { ...parts, ciphertext: Buffer.from(parts.ciphertext) }
  tampered.ciphertext[0] ^= 0x01
  expect(openAuthField(key, tampered)).toBeUndefined()
})

test("the at-rest payload is taken only as the app's own rules allow", () => {
  const secret = randomBytes(32).toString("base64")
  expect(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: secret }))).toBe(secret)
  // a version that isn't 1, a secret that isn't 32 bytes, an all-zero secret
  // and something that isn't JSON at all are refused
  expect(parseAtRestPayload(JSON.stringify({ version: 2, atRestSecretKey: secret }))).toBeUndefined()
  expect(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: randomBytes(16).toString("base64") }))).toBeUndefined()
  expect(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(32).toString("base64") }))).toBeUndefined()
  expect(parseAtRestPayload("not json")).toBeUndefined()
})

// ---- the desktop sign-in, plain and sealed ---------------------------------

test("a plain sign-in is read as it always was", async () => {
  writeDesktop({ auth: { accessToken: "plain-access", refreshToken: "plain-refresh", expiresAt: Date.now() + 3600_000, domain: "www.codebuddy.cn", tokenType: "Bearer" },
    account: { uid: "u-plain", nickname: "Traveller" } })
  const d = await readDesktop(SITES.workbuddy)
  expect(d.access).toBe("plain-access")
  expect(d.refresh).toBe("plain-refresh")
  expect(d.uid).toBe("u-plain")
  expect(d.name).toBe("Traveller")
  expect(d.domain).toBe("www.codebuddy.cn")
})

test("a sealed sign-in opens through the key its envelope names", async () => {
  const key = keyFor("secret-in-memory")
  atRestKeys.set(SITES.workbuddy.id, { keyId: idOf(key), key })
  writeDesktop({ auth: { accessToken: sealForTest(key, "sealed-access"), refreshToken: sealForTest(key, "sealed-refresh"), expiresAt: Date.now() + 3600_000, domain: "www.codebuddy.cn" },
    account: { uid: "3a9a6c38", nickname: "Traveller" } })
  const d = await readDesktop(SITES.workbuddy)
  expect(d.access).toBe("sealed-access")
  expect(d.refresh).toBe("sealed-refresh")
  expect(d.uid).toBe("3a9a6c38")
  expect(d.name).toBe("Traveller")
})

test("a sealed sign-in with no key reachable is signed out, not taken as plain", async () => {
  const key = keyFor("another-install")
  // the key this reader holds names a different id, as an install that was
  // resealed would: the envelopes are not opened, and no half-read sign-in
  // is handed on
  atRestKeys.set(SITES.workbuddy.id, { keyId: idOf(keyFor("the-old-install")), key: keyFor("the-old-install") })
  writeDesktop({ auth: { accessToken: sealForTest(key, "elsewhere-access"), refreshToken: sealForTest(key, "elsewhere-refresh") },
    account: { uid: "u-sealed" } })
  expect(await readDesktop(SITES.workbuddy)).toBeNull()
})

test("a sealed nickname opens to the name it holds, never the object", async () => {
  const key = keyFor("secret-in-memory")
  atRestKeys.set(SITES.workbuddy.id, { keyId: idOf(key), key })
  // the app seals the nickname too. It is opened, so the account is named as
  // the app names it -?and what comes back is the string, never the object
  // (an object as accountId would name the account "[object Object]").
  writeDesktop({ auth: { accessToken: sealForTest(key, "sealed-access") },
    account: { uid: "3a9a6c38", email: "someone@example.com", nickname: sealForTest(key, "sealed-nickname") } })
  const d = await readDesktop(SITES.workbuddy)
  expect(d.uid).toBe("3a9a6c38")
  expect(d.name).toBe("sealed-nickname")
  expect(typeof d.name).toBe("string")
})

test("a sealed nickname no key opens falls back to the plain id, never the object", async () => {
  const key = keyFor("another-install")
  // the envelope names a key this reader does not hold, so the nickname will
  // not open: the email, which sits in the file as plain text, names the
  // account instead
  atRestKeys.set(SITES.workbuddy.id, { keyId: idOf(keyFor("the-old-install")), key: keyFor("the-old-install") })
  writeDesktop({ auth: { accessToken: "plain-access" },
    account: { uid: "3a9a6c38", email: "someone@example.com", nickname: sealForTest(key, "unopenable") } })
  const d = await readDesktop(SITES.workbuddy)
  expect(d.name).toBe("someone@example.com")
  expect(typeof d.name).toBe("string")
})

test("with no nickname and no email, the uid names the account", async () => {
  writeDesktop({ auth: { accessToken: "plain-access" }, account: { uid: "3a9a6c38" } })
  expect((await readDesktop(SITES.workbuddy)).name).toBe("3a9a6c38")
})

test("a sign-in the app keeps with no account id is not read", async () => {
  writeDesktop({ auth: { accessToken: "plain-access" }, account: {} })
  expect(await readDesktop(SITES.workbuddy)).toBeNull()
})

test("a file that isn't there at all is signed out", async () => {
  expect(await readDesktop(SITES["workbuddy-ai"])).toBeNull()
})

// ---- finding the app's own binary ------------------------------------------

test("the app's binary is looked for where the installer puts it, on any drive", () => {
  const roots = rootPaths(SITES.workbuddy)
  expect(roots.some((p) => p.endsWith(join("WorkBuddy", "WorkBuddy.exe")))).toBe(true)
  // an install on D: is found too, which a ProgramFiles-only guess would miss
  const drives = drivePaths(SITES.workbuddy)
  expect(drives).toContain("D:\\Program Files\\WorkBuddy\\WorkBuddy.exe")
  expect(drives).toContain("C:\\Program Files\\WorkBuddy\\WorkBuddy.exe")
  // and each build is looked for under its own name, never the other's
  expect(drivePaths(SITES["workbuddy-ai"]).some((p) => p.includes("WorkBuddyAI.exe"))).toBe(true)
  expect(drivePaths(SITES["workbuddy-ai"]).some((p) => p.includes("WorkBuddy.exe"))).toBe(false)
})

test("a named binary wins when it is there, and a bad one never fails the search", async () => {
  const { findWorkBuddyElectron } = _internal
  const there = (p) => { try { return statSync(p).isFile() } catch { return false } }

  // a path that is really there is taken as given, even when it is not where
  // the installer would have put it (it must not be written anywhere near the
  // real install: the test's own HOME is used)
  const mine = join(home, "a-named-electron.exe")
  writeFileSync(mine, "")
  _internal.electronFound.clear()
  process.env[ELECTRON_BIN_ENV] = mine
  try {
    expect(await findWorkBuddyElectron(SITES.workbuddy)).toBe(mine)
  } finally {
    delete process.env[ELECTRON_BIN_ENV]
    _internal.electronFound.clear()
  }

  // a stale or wrong one is not fatal: the search carries on instead of
  // failing the sign-in, and an empty one is no different from unset
  for (const bad of [join(home, "not-there.exe"), "", "   "]) {
    _internal.electronFound.clear()
    process.env[ELECTRON_BIN_ENV] = bad
    try {
      const found = await findWorkBuddyElectron(SITES.workbuddy)
      // whatever this machine has (or nothing), the bad value was not returned
      expect(found).not.toBe(bad)
      expect(found === undefined || there(found)).toBe(true)
    } finally {
      delete process.env[ELECTRON_BIN_ENV]
      _internal.electronFound.clear()
    }
  }
})

