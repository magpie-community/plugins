// Read the official QianWen CLI's stored sign-in, without a CLI subprocess
// or a host-specific bridge. No credential material is logged or returned.
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"

export class CredentialError extends Error {}

function run(command, args, env = process.env) {
  try {
    return execFileSync(command, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim()
  } catch {
    return ""
  }
}

// Matches the official CLI's machine-derived AES key. It is used only to
// decrypt its own credential file; never send this key to the vendor.
function fingerprint(platform = process.platform) {
  const parts = []
  if (platform === "win32") {
    parts.push(run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]).match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1] || "")
    parts.push(run("wmic", ["csproduct", "get", "UUID", "/value"]).match(/UUID=(.+)/)?.[1]?.trim() || "")
    parts.push(run("wmic", ["cpu", "get", "ProcessorId", "/value"]).match(/ProcessorId=(.+)/)?.[1]?.trim() || "")
  } else if (platform === "darwin") {
    const out = run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"])
    parts.push(out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] || "")
    parts.push(out.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/)?.[1] || "")
    parts.push(run("sysctl", ["-n", "machdep.cpu.brand_string"]))
    parts.push(run("sysctl", ["-n", "kern.uuid"]))
  } else {
    for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const value = fs.readFileSync(file, "utf8").trim()
        if (value) { parts.push(value); break }
      } catch {}
    }
    for (const name of ["product_uuid", "product_serial", "board_serial"]) {
      const file = `/sys/class/dmi/id/${name}`
      try { parts.push(fs.readFileSync(file, "utf8").trim()) } catch {}
    }
    const addresses = run("ifconfig", []).toLowerCase().match(/(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/g) || []
    const usable = addresses.filter((a) => a !== "00:00:00:00:00:00")
    if (usable.length) parts.push(usable.sort()[0])
    if (os.machine()) parts.push(os.machine())
  }
  const joined = parts.filter(Boolean).join("|")
  if (!joined) throw new CredentialError("cannot read the CLI's machine identity; run qianwen auth login")
  return crypto.createHash("sha256").update(joined).digest()
}

export function decryptCredential(envelope, key = fingerprint()) {
  let value
  try { value = JSON.parse(envelope) } catch { throw new CredentialError("CLI credential is invalid; run qianwen auth login") }
  if (!value || value.version !== 1 || typeof value.salt !== "string" || typeof value.nonce !== "string" || typeof value.ciphertext !== "string") {
    throw new CredentialError("CLI credential is invalid; run qianwen auth login")
  }
  try {
    const payload = Buffer.from(value.ciphertext, "base64")
    if (payload.length <= 16) throw new Error("short ciphertext")
    const decipher = crypto.createDecipheriv("aes-256-gcm",
      crypto.pbkdf2Sync(key, Buffer.from(value.salt, "base64"), 260000, 32, "sha256"),
      Buffer.from(value.nonce, "base64"))
    decipher.setAuthTag(payload.subarray(payload.length - 16))
    const credential = JSON.parse(Buffer.concat([decipher.update(payload.subarray(0, payload.length - 16)), decipher.final()]).toString("utf8"))
    if (!credential || typeof credential.access_token !== "string" || !credential.access_token) throw new Error("missing access token")
    return credential.access_token
  } catch {
    throw new CredentialError("CLI credential could not be decrypted; run qianwen auth login")
  }
}

function cliRoots(env = process.env, platform = process.platform, home = os.homedir()) {
  const candidates = []
  if (env.QWEN_HOME) candidates.push(env.QWEN_HOME)
  if (env.QIANWEN_HOME) candidates.push(env.QIANWEN_HOME)
  if (env.QIANWEN_CLI_HOME) candidates.push(env.QIANWEN_CLI_HOME)
  if (platform === "win32" && env.APPDATA) candidates.push(path.join(env.APPDATA, "qianwen"))
  candidates.push(path.join(home, ".qianwen"))
  return [...new Set(candidates)]
}

export function findCliBundle(roots = [], env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.QWEN_CLI_BUNDLE && fs.existsSync(env.QWEN_CLI_BUNDLE)) return env.QWEN_CLI_BUNDLE
  if (env.QIANWEN_CLI_BUNDLE && fs.existsSync(env.QIANWEN_CLI_BUNDLE)) return env.QIANWEN_CLI_BUNDLE

  for (const root of roots) {
    const direct = path.join(root, "node_modules", "@qianwenai", "qianwen-cli", "dist", "bin", "qianwen.js")
    if (fs.existsSync(direct)) return direct
    for (const base of [path.join(root, "lib"), path.join(root, "node_modules")]) {
      const candidate = path.join(base, "node_modules", "@qianwenai", "qianwen-cli", "dist", "bin", "qianwen.js")
      if (fs.existsSync(candidate)) return candidate
    }
  }

  const binName = platform === "win32" ? "qianwen.cmd" : "qianwen"
  const pathDirs = (env.PATH || "").split(platform === "win32" ? ";" : ":")
  for (const dir of pathDirs) {
    if (!dir) continue
    const binPath = path.join(dir, binName)
    if (fs.existsSync(binPath)) {
      try {
        const real = fs.realpathSync(binPath)
        if (real.endsWith("qianwen.js") && fs.existsSync(real)) return real
        const candidate = path.join(path.dirname(real), "node_modules", "@qianwenai", "qianwen-cli", "dist", "bin", "qianwen.js")
        if (fs.existsSync(candidate)) return candidate
        const candidate2 = path.join(path.dirname(binPath), "..", "lib", "node_modules", "@qianwenai", "qianwen-cli", "dist", "bin", "qianwen.js")
        if (fs.existsSync(candidate2)) return candidate2
      } catch {}
    }
  }

  try {
    const npmRoot = run("npm", ["root", "-g"], env)
    if (npmRoot) {
      const candidate = path.join(npmRoot, "@qianwenai", "qianwen-cli", "dist", "bin", "qianwen.js")
      if (fs.existsSync(candidate)) return candidate
    }
  } catch {}

  const globals = [
    path.join(home, ".local", "lib", "node_modules", "@qianwenai", "qianwen-cli", "dist", "bin", "qianwen.js"),
    "/usr/local/lib/node_modules/@qianwenai/qianwen-cli/dist/bin/qianwen.js",
    "/usr/lib/node_modules/@qianwenai/qianwen-cli/dist/bin/qianwen.js",
    path.join(env.APPDATA || "", "npm", "node_modules", "@qianwenai", "qianwen-cli", "dist", "bin", "qianwen.js"),
    path.join(env.LOCALAPPDATA || "", "npm", "node_modules", "@qianwenai", "qianwen-cli", "dist", "bin", "qianwen.js"),
    path.join(env.ProgramFiles || "C:\\Program Files", "nodejs", "node_modules", "@qianwenai", "qianwen-cli", "dist", "bin", "qianwen.js")
  ]
  for (const g of globals) {
    if (g && fs.existsSync(g)) return g
  }
  return null
}

export function findCli(home = os.homedir(), env = process.env, platform = process.platform) {
  const roots = cliRoots(env, platform, home)
  let foundCredentials = false
  for (const root of roots) {
    const credentials = path.join(root, "credentials")
    let envelope
    try { envelope = fs.readFileSync(credentials, "utf8") } catch { continue }
    foundCredentials = true
    const access = decryptCredential(envelope)
    const bundle = findCliBundle(roots, env, platform, home)
    if (bundle) return { access, bundle }
    throw new CredentialError("the official QianWen CLI bundle is not installed; run npm install -g @qianwenai/qianwen-cli")
  }
  if (foundCredentials) {
    throw new CredentialError("the official QianWen CLI bundle is not installed; run npm install -g @qianwenai/qianwen-cli")
  }
  throw new CredentialError("no QianWen CLI sign-in found; run qianwen auth login")
}

// The route prefix is part of the installed official CLI's bundle. Read it
// there rather than duplicating a vendor-internal route in this package.
export function findApiRoutes(bundlePath) {
  let text
  try { text = fs.readFileSync(bundlePath, "utf8") } catch { throw new CredentialError("the QianWen CLI bundle could not be read") }
  const suffix = ".apikeyMgr./tokenplan/personal/api/v2/"
  const at = text.indexOf(`${suffix}subscription`)
  if (at < 0) throw new CredentialError("the installed QianWen CLI has no Token Plan quota API")
  let start = at
  while (start > 0 && !"\"'`".includes(text[start - 1])) start--
  const prefix = text.slice(start, at)
  if (!prefix || prefix.length > 64 || /[\s"'`]/.test(prefix)) throw new CredentialError("the installed QianWen CLI's quota route is invalid")
  return Object.fromEntries(["subscription", "quota-config", "usage"].map((name) => [name, `${prefix}${suffix}${name}`]))
}
