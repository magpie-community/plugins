// The cookie store: a synthetic Chromium v10 blob, decrypted with a known
// password, and the store lookup that finds the file.
//
// Every temp directory a test makes is removed before the test returns: these
// build whole cookie stores, and a test run must not leave one behind — the
// same point the sign-in copy itself makes.

import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { decryptValue, cookieStore, cookieStores, copyStore, profileDirs, readCookies, desktopSignIn, keychainPassword, safeStorageNames, SAFE_STORAGE } from "../src/cookie.mjs"

const HOST = "web.tabbit.com"
const PASSWORD = "test-password"

const made = []
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  made.push(dir)
  return dir
}
// withCleanup runs a test body and removes every temp directory it made.
function withCleanup(name, body) {
  return test(name, async (ctx) => {
    try {
      await body(ctx)
    } finally {
      for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

// seal makes the blob Chromium's own macOS encryption makes: AES-128-CBC
// under the keychain password, `v10`, a 32-byte SHA-256 of the host in
// front of the plaintext, and PKCS#7 padding.
function seal(plaintext, { password = PASSWORD, host = HOST } = {}) {
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1")
  const body = Buffer.concat([crypto.createHash("sha256").update(host).digest(), Buffer.from(plaintext, "utf8")])
  const pad = 16 - (body.length % 16)
  const padded = Buffer.concat([body, Buffer.alloc(pad, pad)])
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20))
  cipher.setAutoPadding(false)
  return Buffer.concat([Buffer.from("v10", "latin1"), cipher.update(padded), cipher.final()])
}

test("a v10 blob decrypts to the plaintext", () => {
  const token = "eyJhbGciOiJSUzI1NiJ9.payload.sig"
  assert.equal(decryptValue(seal(token), { password: PASSWORD }), token)
})

test("the wrong password does not yield a plausible value", () => {
  let value = null
  try {
    value = decryptValue(seal("hello"), { password: "wrong" })
  } catch {
    /* a wrong key usually throws on the padding */
  }
  assert.notEqual(value, "hello")
})

test("a blob that isn't v10 is refused", () => {
  assert.throws(() => decryptValue(Buffer.from("v20xxxx"), { password: PASSWORD }), /unsupported cookie encryption/)
})

test("profileDirs honours an explicit override first", () => {
  const dirs = profileDirs({ TABBIT_PROFILE_DIR: "/tmp/one" }, "/home/u")
  assert.equal(dirs[0], "/tmp/one")
})

withCleanup("cookieStore finds Default/Cookies under a profile root", () => {
  const root = tmp("tabbit-test-")
  fs.mkdirSync(path.join(root, "Default"), { recursive: true })
  fs.writeFileSync(path.join(root, "Default", "Cookies"), "")
  assert.equal(cookieStore([root]), path.join(root, "Default", "Cookies"))
  assert.equal(cookieStore([path.join(root, "missing")]), null)
})

withCleanup("copyStore copies the database and its WAL", () => {
  const root = tmp("tabbit-test-")
  const file = path.join(root, "Cookies")
  fs.writeFileSync(file, "db")
  fs.writeFileSync(file + "-wal", "wal")
  const copy = copyStore(file, tmp("tabbit-copy-"))
  assert.equal(fs.readFileSync(copy, "utf8"), "db")
  assert.equal(fs.readFileSync(copy + "-wal", "utf8"), "wal")
})

withCleanup("readCookies reads token and user_id back out of a real sqlite file", () => {
  let DatabaseSync
  try {
    DatabaseSync = globalThis.process.getBuiltinModule("node:sqlite").DatabaseSync
  } catch {
    return // older Node: the plugin says so at runtime too
  }
  const root = tmp("tabbit-test-")
  const file = path.join(root, "Cookies")
  const db = new DatabaseSync(file)
  db.exec("create table cookies(host_key text, name text, value text, encrypted_value blob)")
  db.prepare("insert into cookies values (?,?,?,?)").run(HOST, "token", "", seal("tok-123"))
  db.prepare("insert into cookies values (?,?,?,?)").run(HOST, "user_id", "u-1", Buffer.alloc(0))
  db.close()
  const rows = readCookies(file)
  const token = rows.find((r) => r.name === "token")
  assert.equal(decryptValue(token.encrypted, { password: PASSWORD }), "tok-123")
  assert.equal(rows.find((r) => r.name === "user_id").value, "u-1")
})

// storeWith builds a real cookie store holding `token` (or none), under a temp
// directory the caller's cleanup removes.
function storeWith(token) {
  let DatabaseSync
  try {
    DatabaseSync = globalThis.process.getBuiltinModule("node:sqlite").DatabaseSync
  } catch {
    return null
  }
  const root = tmp("tabbit-store-")
  const file = path.join(root, "Cookies")
  const db = new DatabaseSync(file)
  db.exec("create table cookies(host_key text, name text, value text, encrypted_value blob)")
  if (token) db.prepare("insert into cookies values (?,?,?,?)").run(HOST, "token", "", seal(token))
  db.prepare("insert into cookies values (?,?,?,?)").run(HOST, "user_id", "u-9", Buffer.alloc(0))
  db.close()
  return file
}

withCleanup("a successful desktop sign-in leaves no copy of the cookie store", async () => {
  const file = storeWith("tok-desktop")
  if (!file) return
  const parent = tmp("tabbit-parent-")
  const sign = await desktopSignIn({ store: file, password: PASSWORD, tmpParent: parent, platform: "darwin" })
  assert.match(sign.key, /token=tok-desktop/)
  assert.equal(sign.userId, "u-9")
  assert.deepEqual(fs.readdirSync(parent), [])
})

withCleanup("a failed desktop sign-in leaves no copy either", async () => {
  const file = storeWith(null)
  if (!file) return
  const parent = tmp("tabbit-parent-")
  await assert.rejects(() => desktopSignIn({ store: file, password: PASSWORD, tmpParent: parent, platform: "darwin" }), /not signed in/)
  assert.deepEqual(fs.readdirSync(parent), [])
})

// An international account's browser keeps the token under web.tabbit.ai,
// sealed with that host's hash (#833).
withCleanup("a browser signed in to web.tabbit.ai signs in there, and says so", async () => {
  let DatabaseSync
  try {
    DatabaseSync = globalThis.process.getBuiltinModule("node:sqlite").DatabaseSync
  } catch {
    return
  }
  const AI = "web.tabbit.ai"
  const root = tmp("tabbit-store-ai-")
  const file = path.join(root, "Cookies")
  const db = new DatabaseSync(file)
  db.exec("create table cookies(host_key text, name text, value text, encrypted_value blob)")
  db.prepare("insert into cookies values (?,?,?,?)").run(AI, "token", "", seal("tok-intl", { host: AI }))
  db.prepare("insert into cookies values (?,?,?,?)").run(AI, "user_id", "", seal("u-intl", { host: AI }))
  db.close()
  const sign = await desktopSignIn({ store: file, password: PASSWORD, tmpParent: tmp("tabbit-parent-"), platform: "darwin" })
  assert.match(sign.key, /^token=tok-intl; user_id=u-intl;/)
  assert.equal(sign.userId, "u-intl")
  assert.equal(sign.site, "https://web.tabbit.ai")
})

withCleanup("a browser signed in to web.tabbit.com still signs in there", async () => {
  const file = storeWith("tok-com")
  if (!file) return
  const sign = await desktopSignIn({ store: file, password: PASSWORD, tmpParent: tmp("tabbit-parent-"), platform: "darwin" })
  assert.match(sign.key, /token=tok-com/)
  assert.equal(sign.site, "https://web.tabbit.com")
})

test("the desktop method is macOS-only, and says so elsewhere", async () => {
  await assert.rejects(() => desktopSignIn({ store: "/nonexistent/Cookies", platform: "linux" }), /macOS-only/)
  await assert.rejects(() => desktopSignIn({ store: "/nonexistent/Cookies", platform: "win32" }), /macOS-only/)
})

// ---- The Keychain (shiqi_40904 on Discord: "Command failed: security
// find-generic-password -s Tabbit Browser Safe Storage -w"). The
// international build, Tabbit.app, keeps its password under "Tabbit Safe
// Storage"; only the China build, Tabbit Browser.app, uses "Tabbit Browser
// Safe Storage". A fake `security` stands in for the Keychain: nothing here
// reads this machine's.

// fakeSecurity answers like macOS's `security`: the password for a service it
// holds, exit 44 (errSecItemNotFound) for one it doesn't, or a fixed answer.
function fakeSecurity(items, { answer } = {}) {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    const service = args[args.indexOf("-s") + 1]
    if (answer) return { stdout: "", stderr: "", error: "", timedOut: false, ...answer(service) }
    if (service in items) return { status: 0, stdout: items[service] + "\n", stderr: "", error: "", timedOut: false }
    return { status: 44, stdout: "", stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.", error: "", timedOut: false }
  }
  return { run, calls }
}

// layoutStore builds a store where a build keeps it: `<root>/<dir>/Default/Cookies`.
function layoutStore(dir, token, { host = HOST, password = PASSWORD } = {}) {
  let DatabaseSync
  try {
    DatabaseSync = globalThis.process.getBuiltinModule("node:sqlite").DatabaseSync
  } catch {
    return null
  }
  const root = tmp("tabbit-layout-")
  const profile = path.join(root, dir)
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true })
  const file = path.join(profile, "Default", "Cookies")
  const db = new DatabaseSync(file)
  db.exec("create table cookies(host_key text, name text, value text, encrypted_value blob)")
  if (token) {
    db.prepare("insert into cookies values (?,?,?,?)").run(host, "token", "", seal(token, { host, password }))
    db.prepare("insert into cookies values (?,?,?,?)").run(host, "user_id", "", seal("u-" + token, { host, password }))
  }
  db.close()
  return { profile, file }
}

test("each build's store asks its own Keychain item first", () => {
  assert.deepEqual(safeStorageNames("/Users/u/Library/Application Support/Tabbit/Default/Cookies"), ["Tabbit Safe Storage", "Tabbit Browser Safe Storage"])
  assert.deepEqual(safeStorageNames("/Users/u/Library/Application Support/Tabbit Browser/Default/Cookies"), ["Tabbit Browser Safe Storage", "Tabbit Safe Storage"])
  assert.deepEqual(SAFE_STORAGE, { intl: "Tabbit Safe Storage", cn: "Tabbit Browser Safe Storage" })
})

test("the service name reaches security as one argument", async () => {
  const { run, calls } = fakeSecurity({ "Tabbit Browser Safe Storage": "pw" })
  assert.equal(await keychainPassword(["Tabbit Browser Safe Storage"], { run }), "pw")
  assert.deepEqual(calls[0], ["find-generic-password", "-s", "Tabbit Browser Safe Storage", "-w"])
})

test("a service the Keychain doesn't hold moves on to the next name", async () => {
  const { run, calls } = fakeSecurity({ "Tabbit Safe Storage": "intl-pw" })
  assert.equal(await keychainPassword(["Tabbit Browser Safe Storage", "Tabbit Safe Storage"], { run }), "intl-pw")
  assert.equal(calls.length, 2)
})

test("no item under any name says to open Tabbit and sign in", async () => {
  const { run } = fakeSecurity({})
  await assert.rejects(
    () => keychainPassword(["Tabbit Safe Storage", "Tabbit Browser Safe Storage"], { run }),
    (e) => /isn't in the login keychain/.test(e.message) && /“Tabbit Safe Storage” and “Tabbit Browser Safe Storage”/.test(e.message) && /open Tabbit, sign in there/.test(e.message) && /Paste Tabbit token/.test(e.message) && !/Command failed/.test(e.message),
  )
})

for (const [status, name] of [[128, "cancelled"], [51, "denied"]]) {
  test(`a Keychain prompt the user ${name} says to click Allow, and asks nothing more`, async () => {
    const { run, calls } = fakeSecurity({}, { answer: () => ({ status, stderr: "security: SecKeychainSearchCopyNext: User canceled the operation." }) })
    await assert.rejects(() => keychainPassword(["Tabbit Safe Storage", "Tabbit Browser Safe Storage"], { run }), /was denied; try again and click Allow/)
    assert.equal(calls.length, 1)
  })
}

test("an unanswered prompt, a locked keychain and anything else each say what happened", async () => {
  let r = fakeSecurity({}, { answer: () => ({ status: null, timedOut: true }) })
  await assert.rejects(() => keychainPassword(["Tabbit Safe Storage"], { run: r.run }), /got no answer in time/)
  r = fakeSecurity({}, { answer: () => ({ status: 36 }) })
  await assert.rejects(() => keychainPassword(["Tabbit Safe Storage"], { run: r.run }), /keychain is locked/)
  r = fakeSecurity({}, { answer: () => ({ status: 1, stderr: "security: something odd" }) })
  await assert.rejects(() => keychainPassword(["Tabbit Safe Storage"], { run: r.run }), /reading “Tabbit Safe Storage” from the login keychain failed \(security: something odd\)/)
})

withCleanup("the international build signs in with its Tabbit Safe Storage item (the report)", async () => {
  const s = layoutStore("Tabbit", "tok-intl-app", { host: "web.tabbit.ai", password: "intl-pw" })
  if (!s) return
  const { run, calls } = fakeSecurity({ "Tabbit Safe Storage": "intl-pw" })
  const sign = await desktopSignIn({ dirs: [s.profile], run, tmpParent: tmp("tabbit-parent-"), platform: "darwin" })
  assert.match(sign.key, /^token=tok-intl-app; user_id=u-tok-intl-app;/)
  assert.equal(sign.site, "https://web.tabbit.ai")
  assert.equal(calls[0][2], "Tabbit Safe Storage")
})

withCleanup("the China build signs in with its Tabbit Browser Safe Storage item", async () => {
  const s = layoutStore("Tabbit Browser", "tok-cn-app", { password: "cn-pw" })
  if (!s) return
  const { run, calls } = fakeSecurity({ "Tabbit Browser Safe Storage": "cn-pw" })
  const sign = await desktopSignIn({ dirs: [s.profile], run, tmpParent: tmp("tabbit-parent-"), platform: "darwin" })
  assert.match(sign.key, /^token=tok-cn-app;/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2], "Tabbit Browser Safe Storage")
})

withCleanup("with both builds installed, the one that is signed in is read", async () => {
  const cn = layoutStore("Tabbit Browser", null)
  const intl = layoutStore("Tabbit", "tok-second", { host: "web.tabbit.ai", password: "intl-pw" })
  if (!cn || !intl) return
  assert.deepEqual(cookieStores([cn.profile, intl.profile]), [cn.file, intl.file])
  const { run } = fakeSecurity({ "Tabbit Safe Storage": "intl-pw" })
  const sign = await desktopSignIn({ dirs: [cn.profile, intl.profile], run, tmpParent: tmp("tabbit-parent-"), platform: "darwin" })
  assert.match(sign.key, /^token=tok-second;/)
  assert.equal(sign.store, intl.file)
})

withCleanup("no store and no sign-in each say to open Tabbit and sign in", async () => {
  const missing = path.join(tmp("tabbit-none-"), "Tabbit")
  await assert.rejects(() => desktopSignIn({ dirs: [missing], platform: "darwin", run: fakeSecurity({}).run }), /open Tabbit, sign in there, and try again/)
  const s = layoutStore("Tabbit", null)
  if (!s) return
  await assert.rejects(() => desktopSignIn({ dirs: [s.profile], platform: "darwin", run: fakeSecurity({}).run, tmpParent: tmp("tabbit-parent-") }), /not signed in to web\.tabbit\.com or web\.tabbit\.ai; open Tabbit, sign in there/)
})
