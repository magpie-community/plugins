import { execFile } from "node:child_process"
import { createHash } from "node:crypto"

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

// parseStored is what a stored value says, "unknown" when it isn't the
// shape agy writes.
export function parseStored(raw, now = Date.now()) {
  let value = String(raw ?? "").trim()
  const fp = createHash("sha256").update(value).digest("hex").slice(0, 32)
  if (value.startsWith("go-keyring-base64:")) {
    value = Buffer.from(value.slice("go-keyring-base64:".length), "base64").toString("utf8")
  } else if (value.startsWith("go-keyring-encoded:")) {
    value = Buffer.from(value.slice("go-keyring-encoded:".length), "hex").toString("utf8")
  }
  let stored
  try { stored = JSON.parse(value) } catch { return { state: "unknown" } }
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
  return { state: "present", fp, canRenew, expiresAt, expired: expiresAt > 0 && now >= expiresAt }
}

// readStoredSignIn reads agy's stored sign-in on this computer.
export async function readStoredSignIn({ platform = process.platform, exec = run, now = Date.now(), env = process.env } = {}) {
  // tests, and setups this reading doesn't fit, turn it off
  if (env.AGY_BRIDGE_STORED_SIGNIN === "skip") return { state: "unknown" }
  // agy signs in with these instead of a stored Google sign-in
  if (ENV_SIGN_INS.some((name) => env[name])) return { state: "unknown" }
  if (platform === "darwin") {
    const r = await exec("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", USER, "-w"])
    // 44: errSecItemNotFound
    if (r.code === 44) return { state: "missing" }
    if (r.code !== 0) return { state: "unknown" }
    return parseStored(r.stdout, now)
  }
  if (platform === "win32") {
    const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_SCRIPT])
    // the answer is the last line; anything PowerShell said before it isn't
    const out = r.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? ""
    if (r.code !== 0) return { state: "unknown" }
    if (out === "MISSING") return { state: "missing" }
    if (!out.startsWith("OK ")) return { state: "unknown" }
    // go-keyring on Windows stores the value's bytes as they are (UTF-8)
    return parseStored(Buffer.from(out.slice(3), "base64").toString("utf8"), now)
  }
  return { state: "unknown" }
}

// cannotSignIn is why a stored sign-in can't serve agy without a new
// Google sign-in, or "" when it may.
export function cannotSignIn(s) {
  if (s?.state === "missing") return "agy isn't signed in"
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

let cached = null
let reading = null

// storedSignIn is readStoredSignIn, shared for CACHE_MS and while one read
// is under way.
export async function storedSignIn({ read = readStoredSignIn, fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value
  if (!reading) {
    const r = Promise.resolve().then(() => read()).catch(() => ({ state: "unknown" })).then((value) => {
      if (reading === r) {
        cached = { at: Date.now(), value }
        reading = null
      }
      return value
    })
    reading = r
  }
  return reading
}

// storedSignInNow is the last read without waiting for one (null before
// the first), starting a new read when it is old: a request isn't held up
// by a keyring read (on Windows, PowerShell).
export function storedSignInNow({ read = readStoredSignIn } = {}) {
  if (!cached || Date.now() - cached.at >= CACHE_MS) storedSignIn({ read }).catch(() => {})
  return cached?.value ?? null
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
  cached = null
  reading = null
  if (clearDead) dead.clear()
}
