import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { accountsDir, currentHome, dropHome, homeOf, newHome, tokenFile } from "./account.mjs"

// What agy's own sign-in looks like on this computer, read without running
// agy. agy keeps its Google token in the system keyring through go-keyring,
// under service "gemini" and user "antigravity": on macOS a generic
// password `security` wrote (so `security` reads it back without a prompt),
// on Windows the generic credential "gemini:antigravity" in Credential
// Manager. The value is JSON (on macOS behind "go-keyring-base64:"):
//   {"token":{"access_token","refresh_token","expiry","expires_in","token_type"},
//    "auth_method":"consumer","id_token_email":…}
//
// Why this exists: an agy that isn't signed in, or whose sign-in Google no
// longer takes, starts its own Google sign-in when it runs, and on Windows
// it opens the browser through ShellExecuteW, which no BROWSER or PATH
// shim can stop. The usage refresh ran agy every few minutes, and a
// signed-out agy opened the browser 235 times in one day
// (JZGiVvkSOA75376 on X). So agy is not run for background work while
// this says it can't be signed in.
//
// state:
//   "missing"  no sign-in is stored: agy is not signed in.
//   "present"  one is: fp tells this sign-in from the next (a hash, never
//              the token), canRenew whether it has a refresh token, and
//              expiresAt when its access token ends (0: not said).
//   "unknown"  it couldn't be read (another OS, a locked keychain, a
//              format agy may change to): nothing is concluded from it.

const SERVICE = "gemini"
const USER = "antigravity"
const READ_TIMEOUT_MS = 10_000
// A sign-in is read again after this long; reading it on Windows starts
// PowerShell, so a burst of requests and listings shares one read.
const CACHE_MS = 30_000
// Sign-ins agy takes from its environment rather than the keyring: a Gemini
// or Google API key, Application Default Credentials, Vertex AI.
const ENV_SIGN_INS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "AGY_ADC_AUTH", "GOOGLE_GENAI_USE_VERTEXAI"]

// PowerShell reads the credential through CredReadW. CREDENTIALW is
// Flags, Type, TargetName, Comment, LastWritten (8 bytes),
// CredentialBlobSize, CredentialBlob: the blob's size and pointer offsets
// follow the pointer size.
export const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace MagpieAgy -Name Cred -MemberDefinition @'
[DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
[DllImport("advapi32.dll", EntryPoint = "CredFree")]
public static extern void CredFree(IntPtr cred);
'@
$p = [IntPtr]::Zero
if (-not [MagpieAgy.Cred]::CredRead('${SERVICE}:${USER}', 1, 0, [ref]$p)) {
  $e = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($e -eq 1168) { 'MISSING' } else { "ERROR $e" }
  exit 0
}
try {
  $ptr = [IntPtr]::Size
  $sizeAt = 8 + 2 * $ptr + 8
  $blobAt = $sizeAt + 4
  if ($blobAt % $ptr) { $blobAt += $ptr - ($blobAt % $ptr) }
  $size = [Runtime.InteropServices.Marshal]::ReadInt32($p, $sizeAt)
  $blob = [Runtime.InteropServices.Marshal]::ReadIntPtr($p, $blobAt)
  $bytes = New-Object byte[] $size
  if ($size -gt 0) { [Runtime.InteropServices.Marshal]::Copy($blob, $bytes, 0, $size) }
  'OK ' + [Convert]::ToBase64String($bytes)
} finally { [MagpieAgy.Cred]::CredFree($p) }
`

function run(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: READ_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" },
        (error, stdout) => resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: String(stdout ?? "") }))
    } catch {
      resolve({ code: -1, stdout: "" })
    }
  })
}

// decodeStored is a stored value's JSON as go-keyring wrote it, or null
// when it isn't that.
function decodeStored(raw) {
  let value = String(raw ?? "").trim()
  if (value.startsWith("go-keyring-base64:")) {
    value = Buffer.from(value.slice("go-keyring-base64:".length), "base64").toString("utf8")
  } else if (value.startsWith("go-keyring-encoded:")) {
    value = Buffer.from(value.slice("go-keyring-encoded:".length), "hex").toString("utf8")
  }
  try { return JSON.parse(value) } catch { return null }
}

// parseStored is what a stored value says, "unknown" when it isn't the
// shape agy writes. It says nothing of who: the account's email isn't kept
// with the cached read (storedEmail reads it when a sign-in names it). who
// is a hash of it, "" when it names none: heldByAnother tells an account of
// agy's own from the one agy holds now by it.
export function parseStored(raw, now = Date.now()) {
  const fp = createHash("sha256").update(String(raw ?? "").trim()).digest("hex").slice(0, 32)
  const stored = decodeStored(raw)
  if (!stored) return { state: "unknown" }
  // a Gemini API key needs no Google sign-in
  if (typeof stored?.api_key === "string" && stored.api_key !== "") return { state: "unknown" }
  const token = stored?.token
  if (!token || typeof token !== "object") return { state: "unknown" }
  const canRenew = typeof token.refresh_token === "string" && token.refresh_token !== ""
  const hasAccess = typeof token.access_token === "string" && token.access_token !== ""
  if (!canRenew && !hasAccess) return { state: "missing" }
  const at = Date.parse(token.expiry ?? "")
  // Go's zero time (0001-01-01) is "doesn't end"
  const expiresAt = Number.isFinite(at) && at > 0 ? at : 0
  return { state: "present", fp, canRenew, expiresAt, expired: expiresAt > 0 && now >= expiresAt, who: whoOf(emailOf(raw)) }
}

// whoOf is an email's hash: what a cached read keeps of who it is for.
export function whoOf(email) {
  const e = typeof email === "string" ? email.trim().toLowerCase() : ""
  return e ? createHash("sha256").update(e).digest("hex").slice(0, 32) : ""
}

// heldByAnother says agy's own sign-in (stored, a storedSignIn read) is
// for another Google account than saved, the email an account of agy's own
// was saved as; false when it is the same, or when either can't be told.
// agy holds one Google account in its keyring: an account saved as agy's
// own before agy was signed in to another (Switch to another Google account
// before 0.1.67, a sign-in in a terminal) is no longer there, and its usage
// and requests would be the other one's (ownsh1p on X: two accounts, both
// showing the first one's balance).
export function heldByAnother(stored, saved) {
  const now = stored?.state === "present" && typeof stored.who === "string" ? stored.who : ""
  const was = whoOf(saved)
  return Boolean(now && was && now !== was)
}

// ownerUnknown says agy's own sign-in (stored, a storedSignIn read, null
// before the first) can't say which Google account it is: not read yet,
// unreadable, or stored without id_token_email. agy 1.5.18 writes that
// field (StoredToken.IDTokenEmail, omitempty) only when Google's answer
// carried an id token (RememberIDToken), and the value keeps no id token
// to read it from instead: a terminal sign-in left one without it, and
// agy ran as a banned account under every account of agy's own (#1599).
// Unknown is not "the account's own".
export function ownerUnknown(stored) {
  if (stored?.state === "present") return !stored.who
  return stored?.state !== "missing" && stored?.state !== "unreachable"
}

// notHeldError is what an account heldByAnother is told.
export function notHeldError(saved) {
  return `agy is signed in to another Google account now, not to ${saved}: agy holds one Google account, so ` +
    `${saved}'s usage and requests would be the other account's. Sign ${saved} in again with "Add another Google ` +
    `account" to use both.`
}

// unknownOwnerError is what an account of agy's own is told when agy's
// sign-in can't say whose it is (ownerUnknown) and another account of
// agy's own is here, with no sign-in kept for it.
export function unknownOwnerError(saved) {
  const who = saved || "this account"
  return `agy's sign-in on this computer doesn't say which Google account it is, and another account here uses it ` +
    `too, so ${who}'s usage and requests could be another account's. Sign ${who} in again with "Add another ` +
    `Google account" to give it a sign-in of its own.`
}

// ---- an account of agy's own, kept --------------------------------------
//
// agy holds one Google account (heldByAnother). An account of agy's own
// that agy held once is kept: while agy holds it, its stored sign-in (the
// same JSON agy writes) is copied into a home of its own, keptHome(email),
// as the token file agy keeps there (account.mjs). When agy holds another
// account later (a sign-in in a terminal), that account's usage, models
// and requests run in its kept home, with its own sign-in, the way an
// account added with "Add another Google account" runs: agy itself, or the
// quota read agy makes, and nothing else (ownsh1p on X: 为什么不能两个都显示
// 额度). A kept sign-in Google no longer takes says to sign in again, as
// before. agy's own keyring is only read, never written.

// keptHome is the folder an account of agy's own is kept in: "own" and a
// hash of its email, so no random home id (hex) is ever one.
export function keptHome(email, env) {
  const who = whoOf(email)
  return who ? homeOf("own" + who.slice(0, 24), env) : null
}

export function isKeptId(id) {
  return typeof id === "string" && id.startsWith("own")
}

// keptFor is email's kept home when its token file is a sign-in for that
// account that can be renewed, else null.
export function keptFor(email, env) {
  const home = keptHome(email, env)
  if (!home) return null
  let raw
  try { raw = fs.readFileSync(tokenFile(home), "utf8") } catch { return null }
  const s = parseStored(raw)
  return s.state === "present" && s.canRenew && s.who === whoOf(email) ? home : null
}

// keptOthers says a kept home holds a sign-in for another account than
// email: another account of agy's own has been here.
export function keptOthers(email, env) {
  const who = whoOf(email)
  let ids = []
  try { ids = fs.readdirSync(accountsDir(env)) } catch { return false }
  for (const id of ids) {
    const home = isKeptId(id) ? homeOf(id, env) : null
    if (!home) continue
    let raw
    try { raw = fs.readFileSync(tokenFile(home), "utf8") } catch { continue }
    const s = parseStored(raw)
    if (s.state === "present" && s.who && s.who !== who) return true
  }
  return false
}

// homeForOwn copies agy's own sign-in, the one email (or, unnamed, the
// one just signed in) is, into a new account home (account.mjs): { id,
// home }, or null when it can't. A second account of agy's own would
// share agy's one keyring with the first (#1599), so it is saved as an
// account with a home of its own instead. agy's keyring is only read.
export async function homeForOwn(email, opts = {}) {
  let account = null
  try {
    const v = await readStoredValue({ ...opts, home: null })
    if (!("raw" in v)) return null
    const s = parseStored(v.raw)
    const value = decodeStored(v.raw)
    if (s.state !== "present" || !s.canRenew || !value?.token) return null
    if (s.who && email && s.who !== whoOf(email)) return null
    account = newHome(opts.env)
    const file = tokenFile(account.home)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.magpie-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
    fs.renameSync(tmp, file)
    return account
  } catch {
    if (account) dropHome(account.home)
    return null
  }
}

// The keyring read (fp) each account was last kept from, by email.
const keptFrom = new Map()

// keepOwn keeps email's sign-in from agy's keyring when stored (the
// keyring's read, storedSignIn) is that account's. Never throws.
export async function keepOwn(email, stored, opts = {}) {
  try {
    const who = whoOf(email)
    if (!who || stored?.state !== "present" || stored.who !== who || !stored.canRenew) return false
    const key = who
    if (keptFrom.get(key) === stored.fp) return false
    const v = await readStoredValue({ ...opts, home: null })
    if (!("raw" in v)) return false
    const now = parseStored(v.raw)
    const value = decodeStored(v.raw)
    if (now.state !== "present" || now.who !== who || !now.canRenew || !value?.token) return false
    const home = keptHome(email, opts.env)
    const file = tokenFile(home)
    const text = JSON.stringify(value)
    let had = null
    try { had = fs.readFileSync(file, "utf8") } catch {}
    if (had !== text) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.chmodSync(home, 0o700)
      // agy in that home reads (and renews) the file: it never sees half
      const tmp = `${file}.magpie-${process.pid}-${Date.now()}`
      fs.writeFileSync(tmp, text, { mode: 0o600 })
      fs.renameSync(tmp, file)
    }
    keptFrom.set(key, stored.fp)
    return true
  } catch {
    return false
  }
}

// emailOf is the Google account a stored value is signed in to, "" when
// it doesn't say.
export function emailOf(raw) {
  const email = decodeStored(raw)?.id_token_email
  return typeof email === "string" ? email.trim().slice(0, 200) : ""
}

// readStoredValue reads agy's keyring value on this computer: { raw }, or
// { state } when there is none ("missing"), it can't be read ("unknown"),
// or this process can't reach the keychain it is in ("unreachable").
async function readStoredValue({ platform = process.platform, exec = run, env = process.env, home = currentHome() } = {}) {
  // an account with a home of its own (account.mjs): agy keeps its
  // sign-in in a file there, the same JSON
  if (home) {
    try {
      return { raw: await fs.promises.readFile(tokenFile(home), "utf8") }
    } catch (error) {
      return { state: error?.code === "ENOENT" ? "missing" : "unknown" }
    }
  }
  // tests, and setups this reading doesn't fit, turn it off
  if (env.AGY_BRIDGE_STORED_SIGNIN === "skip") return { state: "unknown" }
  // agy signs in with these instead of a stored Google sign-in
  if (ENV_SIGN_INS.some((name) => env[name])) return { state: "unknown" }
  if (platform === "darwin") {
    const r = await exec("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", USER, "-w"])
    if (r.code === 0) return { raw: r.stdout }
    if (await loginKeychainOutOfReach({ exec, env })) return { state: "unreachable" }
    // 44: errSecItemNotFound
    return { state: r.code === 44 ? "missing" : "unknown" }
  }
  if (platform === "win32") {
    const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_SCRIPT])
    // the answer is the last line; anything PowerShell said before it isn't
    const out = r.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? ""
    if (r.code !== 0) return { state: "unknown" }
    if (out === "MISSING") return { state: "missing" }
    if (!out.startsWith("OK ")) return { state: "unknown" }
    // go-keyring on Windows stores the value's bytes as they are (UTF-8)
    return { raw: Buffer.from(out.slice(3), "base64").toString("utf8") }
  }
  // Linux and the rest: with no keyring to reach (Docker, a NAS, a
  // headless box) agy keeps its sign-in in the same file an account's own
  // home has (#1502). No file says nothing: it may be in a keyring.
  const own = env.HOME || (env === process.env ? os.homedir() : "")
  if (own) {
    try {
      return { raw: await fs.promises.readFile(tokenFile(own), "utf8") }
    } catch {}
  }
  return { state: "unknown" }
}

// loginKeychainOutOfReach says this process runs outside the user's
// login session on macOS: their login keychain, where agy keeps its
// sign-in, is not among the keychains it searches. A LaunchDaemon run as
// the user (mayne_wong on X) searches only System.keychain, so the
// keyring read finds nothing (44) while the window, in the login session,
// finds agy signed in: the gateway answered "agy isn't signed in", and
// signing in again said it was. agy, run there, can't read it either.
// false when it can't tell.
async function loginKeychainOutOfReach({ exec, env }) {
  const home = env.HOME || (env === process.env ? os.homedir() : "")
  if (!home) return false
  const dir = path.join(home, "Library", "Keychains")
  if (!fs.existsSync(path.join(dir, "login.keychain-db")) && !fs.existsSync(path.join(dir, "login.keychain"))) return false
  const r = await exec("/usr/bin/security", ["list-keychains"])
  if (r.code !== 0) return false
  const searched = [...String(r.stdout ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1])
  return searched.length > 0 && !searched.some((k) => k.startsWith(dir + path.sep))
}

// OUT_OF_REACH is what an account of agy's own is told when its sign-in
// is out of reach (loginKeychainOutOfReach), with no copy kept in a file.
export const OUT_OF_REACH = "this magpie runs outside your macOS login session (as a LaunchDaemon), where your " +
  "login keychain, which holds agy's sign-in, can't be read. Run magpie as your own service instead " +
  "(`magpie daemon install`, or the magpie app), or sign the account in with \"Add another Google account\", " +
  "which keeps its sign-in in a file this magpie can read"

// readStoredSignIn reads agy's stored sign-in on this computer.
export async function readStoredSignIn({ now = Date.now(), ...opts } = {}) {
  const v = await readStoredValue(opts)
  return "raw" in v ? parseStored(v.raw, now) : v
}

// storedToken is agy's stored sign-in itself for the current account
// ({ token: { access_token, refresh_token, expiry }, auth_method, … }), or
// null when there is none or it can't be read. Only signedInEmail uses it,
// and it never writes it back: agy owns the sign-in. Usage never reads it:
// the quota is read through agy alone (usage.mjs).
export async function storedToken(opts) {
  try {
    const v = await readStoredValue(opts)
    if (!("raw" in v)) return null
    const stored = decodeStored(v.raw)
    return stored?.token && typeof stored.token === "object" ? stored : null
  } catch {
    return null
  }
}

// storedEmail is the Google account agy is signed in to on this computer,
// "" when it can't tell: a sign-in names its account by it.
export async function storedEmail(opts) {
  try {
    const v = await readStoredValue(opts)
    return "raw" in v ? emailOf(v.raw) : ""
  } catch {
    return ""
  }
}

// signedInEmail is storedEmail, else, for a sign-in that doesn't name its
// account (id_token_email), who Google says its access token is for: the
// userinfo agy itself asks at sign-in, with the token agy stored. "" when
// neither tells; a token that has ended is not renewed for it. An account
// saved without its email is listed as "API key" (tmr11235 on X), which
// it isn't.
export async function signedInEmail(opts = {}, { fetch: fetchFn = globalThis.fetch, timeoutMs = 5_000 } = {}) {
  const email = await storedEmail(opts)
  if (email) return email
  const access = (await storedToken(opts))?.token?.access_token
  if (typeof access !== "string" || !access) return ""
  try {
    const res = await fetchFn(USERINFO_URL, { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return ""
    const who = await res.json()
    return typeof who?.email === "string" && who.email.includes("@") ? who.email.trim().slice(0, 200) : ""
  } catch {
    return ""
  }
}

const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"

// cannotSignIn is why a stored sign-in can't serve agy without a new
// Google sign-in, or "" when it may.
export function cannotSignIn(s) {
  if (s?.state === "missing") return "agy isn't signed in"
  if (s?.state === "unreachable") return OUT_OF_REACH
  if (s?.state === "present" && !s.canRenew && s.expired) return "agy's sign-in has expired"
  return ""
}

// Sign-ins agy was found unable to use (a run it failed in a way only a
// new sign-in mends), by fp: agy isn't run in the background for them
// again; signing in again stores another and so another fp.
const dead = new Set()

export function noteDead(s) {
  if (s?.state === "present" && s.fp) dead.add(s.fp)
}

export function isDead(s) {
  return s?.state === "present" && dead.has(s.fp)
}

// The last read and the read under way, per account home ("" for agy's
// own sign-in).
const reads = new Map()

function readsOf(home) {
  const key = home ?? ""
  let r = reads.get(key)
  if (!r) reads.set(key, (r = { cached: null, reading: null }))
  return r
}

// storedSignIn is readStoredSignIn, shared for CACHE_MS and while one read
// is under way.
export async function storedSignIn({ read = readStoredSignIn, fresh = false } = {}) {
  const r = readsOf(currentHome())
  if (!fresh && r.cached && Date.now() - r.cached.at < CACHE_MS) return r.cached.value
  if (!r.reading) {
    const p = Promise.resolve().then(() => read()).catch(() => ({ state: "unknown" })).then((value) => {
      if (r.reading === p) {
        r.cached = { at: Date.now(), value }
        r.reading = null
      }
      return value
    })
    r.reading = p
  }
  return r.reading
}

// storedSignInNow is the last read without waiting for one (null before
// the first), starting a new read when it is old: a request isn't held up
// by a keyring read (on Windows, PowerShell).
export function storedSignInNow({ read = readStoredSignIn } = {}) {
  const r = readsOf(currentHome())
  if (!r.cached || Date.now() - r.cached.at >= CACHE_MS) storedSignIn({ read }).catch(() => {})
  return r.cached?.value ?? null
}

// backgroundBlocked is why agy must not be run for work nobody asked for
// (a usage read, a model listing): its sign-in can't serve it and running
// it would start a Google sign-in. "" when it may run.
export async function backgroundBlocked(opts) {
  const s = await storedSignIn(opts)
  return cannotSignIn(s) || (isDead(s) ? "agy's sign-in no longer works" : "")
}

// forgetStoredSignIn drops the cached read (after a sign-in, and in tests).
export function forgetStoredSignIn({ dead: clearDead = false } = {}) {
  reads.delete(currentHome() ?? "")
  if (clearDead) dead.clear()
}
