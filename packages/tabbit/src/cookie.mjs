// Reading the sign-in out of the Tabbit desktop app, without opening it.
//
// Tabbit ships as two macOS builds, each a Chromium fork with its own data
// directory and its own Keychain item (read out of 1.16.27's framework: both
// builds carry the same code, and a flag set at start-up picks the names):
//   Tabbit.app          com.tabbit-ai.Tabbit     (international, tabbit.ai)
//     ~/Library/Application Support/Tabbit/Default/Cookies
//     Keychain service "Tabbit Safe Storage", account "Tabbit"
//   Tabbit Browser.app  com.tab-browser.Tabbit   (China, tabbit.com)
//     ~/Library/Application Support/Tabbit Browser/Default/Cookies
//     Keychain service "Tabbit Browser Safe Storage", account "Tabbit Browser"
// Each store is read with its own build's item first and the other's after,
// so a store in a place this doesn't know still finds its key.
//
// The database is copied before it is read: a running browser holds a lock
// on a WAL, and reading the live file gives a half-written row. The copy is
// removed again in a finally: it holds every site's cookies, and a copy left
// behind each sign-in would leave that in the temp folder.
//
// A Chromium cookie on macOS is AES-128-CBC under
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
import { execFile } from "node:child_process"

// The two sites a Tabbit account can belong to (see SITES in api.mjs), the
// Chinese one first. A browser signed in to either keeps the token under
// that site's host, so the host it was found under names the account's site.
export const HOSTS = ["web.tabbit.com", "web.tabbit.ai"]
export const HOST = HOSTS[0]
// The Keychain services the two builds keep their storage password under.
export const SAFE_STORAGE = { intl: "Tabbit Safe Storage", cn: "Tabbit Browser Safe Storage" }

// profileDirs are the places Tabbit keeps its profile: the China build's
// "Tabbit Browser" and the international build's "Tabbit" (with the old
// client's "Tabbit/User Data").
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

// cookieStores lists every SQLite file found, one per profile root, each
// preferring a profile called Default.
export function cookieStores(dirs = profileDirs()) {
  const found = []
  for (const dir of dirs) {
    for (const rel of [path.join("Default", "Cookies"), path.join("Network", "Cookies"), "Cookies"]) {
      const file = path.join(dir, rel)
      if (fs.existsSync(file)) {
        found.push(file)
        break
      }
    }
  }
  return [...new Set(found)]
}

// cookieStore is the first of them.
export function cookieStore(dirs = profileDirs()) {
  return cookieStores(dirs)[0] ?? null
}

// safeStorageNames is the Keychain services to try for one store, its own
// build's first: a path through a "Tabbit Browser" folder is the China
// build's, anything else the international one's.
export function safeStorageNames(store = "") {
  const parts = String(store).split(/[\\/]+/)
  return parts.includes("Tabbit Browser") ? [SAFE_STORAGE.cn, SAFE_STORAGE.intl] : [SAFE_STORAGE.intl, SAFE_STORAGE.cn]
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

// runSecurity runs macOS's `security` with the arguments as separate argv
// entries (no shell, so a name with spaces is one argument). It never
// rejects: the caller reads the exit status. The timeout leaves the user time
// to answer the Keychain prompt; magpie waits ten minutes for a sign-in.
export function runSecurity(args, { timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    execFile("security", args, { encoding: "utf8", timeout, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      resolve({
        status: error ? (typeof error.code === "number" ? error.code : null) : 0,
        timedOut: Boolean(error?.killed),
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "").trim(),
        error: error && typeof error.code !== "number" && !error.killed ? String(error.message ?? error) : "",
      })
    })
  })
}

// What `security` exits with is the low byte of the OSStatus.
const NOT_FOUND = 44 // errSecItemNotFound (-25300)
const CANCELED = 128 // errSecUserCanceled (-128)
const AUTH_FAILED = 51 // errSecAuthFailed (-25293): the prompt was denied
const NO_UI = 36 // errSecInteractionNotAllowed (-25308): locked, no prompt possible

const PASTE = "or use “Paste Tabbit token” instead"

// keychainPassword asks the login keychain for the browser's storage
// password, trying each service in turn. An item that isn't there moves on
// to the next name; a prompt the user turned down stops at once and says so.
export async function keychainPassword(names = [SAFE_STORAGE.intl, SAFE_STORAGE.cn], { run = runSecurity } = {}) {
  for (const service of names) {
    const r = await run(["find-generic-password", "-s", service, "-w"])
    if (r.status === 0) {
      const password = String(r.stdout).replace(/\r?\n$/, "")
      if (password) return password
      continue
    }
    if (r.status === NOT_FOUND) continue
    if (r.timedOut) {
      throw new Error(`macOS asked for Keychain access to “${service}” and got no answer in time; try again and click Allow (or Always Allow), ${PASTE}`)
    }
    if (r.status === CANCELED || r.status === AUTH_FAILED) {
      throw new Error(`Keychain access to “${service}” was denied; try again and click Allow (or Always Allow) when macOS asks, ${PASTE}`)
    }
    if (r.status === NO_UI) {
      throw new Error(`the login keychain is locked and macOS can't ask for “${service}” right now; unlock it and try again, ${PASTE}`)
    }
    const why = r.stderr || r.error || `security exited with ${r.status}`
    throw new Error(`reading “${service}” from the login keychain failed (${why}), ${PASTE}`)
  }
  throw new Error(
    `Tabbit's password isn't in the login keychain (looked for ${names.map((n) => `“${n}”`).join(" and ")}); open Tabbit, sign in there, and try again, ${PASTE}`,
  )
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
// with the reason a caller can show, and what to do about it.
//
// `platform`, `tmpParent` and `run` are for the tests: the same code path
// runs with a fixture store under a temp parent the test can look into
// afterwards, and a fake `security`.
export async function desktopSignIn({ dirs = profileDirs(), hosts = HOSTS, store, password, tmpParent, platform = process.platform, run } = {}) {
  if (platform !== "darwin") {
    throw new Error(`reading Tabbit's cookies is macOS-only; on ${platform} paste the token instead`)
  }
  const files = store ? [store] : cookieStores(dirs)
  if (!files.length) throw new Error(`Tabbit isn't installed here, or hasn't been opened yet (looked in ${dirs.join(", ")}); open Tabbit, sign in there, and try again, ${PASTE}`)
  for (const file of files) {
    const found = readToken(file, hosts, tmpParent)
    if (!found) continue
    const { rows, host } = found
    const token = rows.find((r) => r.name === "token")
    const uid = rows.find((r) => r.name === "user_id")
    const plain = token.value?.startsWith("ey") && (!uid || uid.value || !uid.encrypted?.length)
    const secret = plain ? "" : (password ?? (await keychainPassword(safeStorageNames(file), run ? { run } : undefined)))
    const value = token.value?.startsWith("ey") ? token.value : decryptValue(token.encrypted, { password: secret, host })
    const uidValue = uid?.value || (uid?.encrypted?.length ? safeDecrypt(uid.encrypted, secret, host) : "")
    const header = [`token=${value}`, uidValue && `user_id=${uidValue}`, uidValue && `SAPISID=${uidValue}`, "managed=tab_browser"].filter(Boolean).join("; ")
    return { key: header, userId: uidValue, store: file, site: `https://${host}` }
  }
  throw new Error(`Tabbit is not signed in to ${hosts.join(" or ")}; open Tabbit, sign in there, and try again, ${PASTE}`)
}

// readToken reads one store's token and user_id rows from a temporary copy,
// trying each host, and removes the copy before it returns.
function readToken(file, hosts, tmpParent) {
  const dir = fs.mkdtempSync(path.join(tmpParent ?? os.tmpdir(), "tabbit-cookies-"))
  try {
    const copy = copyStore(file, dir)
    for (const host of hosts) {
      const rows = readCookies(copy, { host })
      if (rows.some((r) => r.name === "token")) return { rows, host }
    }
    return null
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