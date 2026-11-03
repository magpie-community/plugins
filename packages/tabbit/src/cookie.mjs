// Reading the sign-in out of the Tabbit desktop app, without opening it.
//
// Tabbit Browser keeps the same Chromium cookie store every Chromium does:
//   macOS  ~/Library/Application Support/Tabbit Browser/Default/Cookies
// and protects the value with the platform's own key. The database is copied
// before it is read: a running browser holds a lock on a WAL, and reading the
// live file gives a half-written row. The copy is removed again in a finally:
// it holds every site's cookies, and a copy left behind each sign-in would
// leave that in the temp folder.
//
// macOS: `Tabbit Browser Safe Storage` in the login keychain holds the
// password, and a Chromium cookie is AES-128-CBC under
// PBKDF2-HMAC-SHA1(password, "saltysalt", 1003, 16 bytes) with a sixteen-space
// IV, prefixed `v10`, padded PKCS#7, and (on Chromium 24 and later) a 32-byte
// SHA-256 of the host in front of the plaintext.
//
// Only macOS is served here. Windows needs DPAPI and Linux a different store
// key, neither implemented; both use the paste method instead, and this says
// so rather than failing obscurely.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"

export const HOST = "web.tabbit.com"
const SAFE_STORAGE = "Tabbit Browser Safe Storage"

// profileDirs are the places Tabbit Browser has kept its profile, newest
// name first. The browser's own data directory is not the same as the
// user-data directory the old Tabbit client used, so both are listed.
export function profileDirs(env = process.env, home = os.homedir()) {
  const roots = [env.TABBIT_PROFILE_DIR, env.TABBIT_USER_DATA_DIR].filter(Boolean)
  if (process.platform === "darwin") {
    roots.push(
      path.join(home, "Library", "Application Support", "Tabbit Browser"),
      path.join(home, "Library", "Application Support", "Tabbit", "User Data"),
      path.join(home, "Library", "Application Support", "Tabbit"),
    )
  } else if (process.platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local")
    roots.push(path.join(local, "Tabbit Browser", "User Data"), path.join(local, "Tabbit", "User Data"))
  } else {
    const config = env.XDG_CONFIG_HOME || path.join(home, ".config")
    roots.push(path.join(config, "Tabbit Browser"), path.join(config, "Tabbit", "User Data"))
  }
  return [...new Set(roots)]
}

// cookieStore finds the SQLite file, preferring a profile called Default.
export function cookieStore(dirs = profileDirs()) {
  for (const dir of dirs) {
    for (const rel of [path.join("Default", "Cookies"), path.join("Network", "Cookies"), "Cookies"]) {
      const file = path.join(dir, rel)
      if (fs.existsSync(file)) return file
    }
  }
  return null
}

// copyStore copies the database (and its WAL, when present) to a temporary
// directory: sqlite reads the pair, and the live one is locked.
export function copyStore(file, tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tabbit-cookies-"))) {
  const copy = path.join(tmp, "Cookies")
  fs.copyFileSync(file, copy)
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, copy + suffix)
  }
  return copy
}

// keychainPassword asks the login keychain for the browser's storage
// password. A keychain that is locked, or a prompt the user dismisses,
// makes this throw and the caller falls back to a pasted value.
export function keychainPassword(service = SAFE_STORAGE) {
  const out = execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15_000,
  })
  const password = String(out).replace(/\r?\n$/, "")
  if (!password) throw new Error(`the keychain holds no password under "${service}"`)
  return password
}

// decryptValue turns one `encrypted_value` blob into text.
export function decryptValue(blob, { password, host = HOST } = {}) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  const prefix = buf.subarray(0, 3).toString("latin1")
  if (prefix !== "v10" && prefix !== "v11") throw new Error(`unsupported cookie encryption (${prefix})`)
  if (typeof password !== "string" || !password) throw new Error("a password is needed to decrypt a Chromium cookie")
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1")
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20))
  decipher.setAutoPadding(false)
  let plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()])
  const pad = plain[plain.length - 1]
  // PKCS#7 only ever strips 1..16 bytes; anything else means the key was wrong
  // and stripping would quietly corrupt the value.
  if (pad > 0 && pad <= 16 && pad <= plain.length) plain = plain.subarray(0, plain.length - pad)
  const hostHash = crypto.createHash("sha256").update(host).digest()
  if (plain.length > 32 && plain.subarray(0, 32).equals(hostHash)) plain = plain.subarray(32)
  return plain.toString("utf8")
}

// readCookies reads the wanted names for one host out of the copied store.
// node:sqlite is in Node 22 and later, which is what magpie's host and the
// plugin's own engines field ask for.
export function readCookies(store, { host = HOST, names = ["token", "user_id"] } = {}) {
  const { DatabaseSync } = require_node_sqlite()
  const db = new DatabaseSync(store, { readOnly: true })
  try {
    const rows = db
      .prepare("select name, value, encrypted_value from cookies where host_key = ? and name in (?, ?)")
      .all(host, names[0], names[1])
    return rows.map((row) => ({ name: row.name, value: row.value, encrypted: row.encrypted_value }))
  } finally {
    db.close()
  }
}

function require_node_sqlite() {
  // A static import of a built-in that older Node lacks would fail the whole
  // module; resolving it here lets the plugin load and say what is missing.
  const sqlite = globalThis.process?.getBuiltinModule?.("node:sqlite")
  if (!sqlite?.DatabaseSync) throw new Error("reading Tabbit's cookies needs Node 22 or later (node:sqlite)")
  return sqlite
}

// desktopSignIn returns the cookie header and what it belongs to, or throws
// with the reason a caller can show.
//
// `platform` and `tmpParent` are for the tests: the same code path runs with a
// fixture store under a temp parent the test can look into afterwards.
export function desktopSignIn({ dirs = profileDirs(), host = HOST, store, password, tmpParent, platform = process.platform } = {}) {
  if (platform !== "darwin") {
    throw new Error(`reading Tabbit Browser's cookies is macOS-only; on ${platform} paste the token instead`)
  }
  const file = store || cookieStore(dirs)
  if (!file) throw new Error(`no Tabbit Browser cookie store found; looked in ${dirs.join(", ")}`)
  const dir = fs.mkdtempSync(path.join(tmpParent ?? os.tmpdir(), "tabbit-cookies-"))
  try {
    const copy = copyStore(file, dir)
    const rows = readCookies(copy, { host })
    const token = rows.find((r) => r.name === "token")
    if (!token) throw new Error(`Tabbit Browser is not signed in to ${host}`)
    const secret = password ?? keychainPassword()
    const value = token.value?.startsWith("ey") ? token.value : decryptValue(token.encrypted, { password: secret, host })
    const uid = rows.find((r) => r.name === "user_id")
    const uidValue = uid?.value || (uid?.encrypted ? safeDecrypt(uid.encrypted, secret, host) : "")
    const header = [`token=${value}`, uidValue && `user_id=${uidValue}`, uidValue && `SAPISID=${uidValue}`, "managed=tab_browser"].filter(Boolean).join("; ")
    return { key: header, userId: uidValue, store: file }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function safeDecrypt(blob, password, host) {
  try {
    return decryptValue(blob, { password, host })
  } catch {
    return ""
  }
}

export const _internal = { safeDecrypt, SAFE_STORAGE }