// The package's own Trae-account sign-in, as a fallback credential source.
//
// This is the plugin's only credential source. `magpie plugin login
// trae-agent` opens Trae's own authorization page in the browser, the same
// page the Trae IDE uses, and a local loopback server receives the
// credential. The sign-in is stored under "trae-agent" in Magpie's
// plugin-auth.json — this package's own entry, never another app's or
// plugin's.
//
// The flow mirrors the Trae IDE's device sign-in (no PKCE, no scopes, no
// client secret): an authorize URL carrying client/device parameters, a
// callback that delivers userJwt + userInfo as query values, and renewal by
// the device-bound ExchangeToken call signed with a P-256 key generated at
// sign-in time.

import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { cpus, homedir, networkInterfaces, release } from "node:os"
import { dirname, join } from "node:path"
import { findTraeApp } from "./trae-api.mjs"

export const SIGN_IN_TIMEOUT = 10 * 60 * 1000

// The client id is Trae's own: iCubeApp.authConfig.TRAE.stable in the IDE's
// product.json, read from the local install. The renewal hosts are Trae's
// account hosts, global first with CN as a fallback.
const AUTH_HOSTS = ["https://growsg-normal.trae.ai", "https://grow-normal.trae.cn"]

function traeProductId() {
  const candidates = []
  const found = findTraeApp()
  if (found) candidates.push(found)
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
    candidates.push(join(local, "Programs", "Trae", "Trae.exe"))
    candidates.push(join(process.env.ProgramFiles || "C:\\Program Files", "Trae", "Trae.exe"))
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Trae.app/Contents/MacOS/Trae")
  } else {
    candidates.push(join(homedir(), ".local", "share", "trae", "Trae"))
  }
  for (const app of candidates) {
    try {
      const dir =
        process.platform === "darwin" && app.includes(".app/")
          ? join(app.slice(0, app.indexOf(".app/") + 4), "Contents", "Resources")
          : join(dirname(app), "resources")
      const product = JSON.parse(readFileSync(join(dir, "app", "product.json"), "utf8"))
      const id = product?.iCubeApp?.authConfig?.TRAE?.stable
      if (typeof id === "string" && id) return id
    } catch {
      // try the next candidate
    }
  }
  return ""
}

function osVersion() {
  if (process.platform === "win32") return `Windows 11 ${release()}`
  if (process.platform === "darwin") return `macOS ${release()}`
  return `Linux ${release()}`
}

function osName() {
  return process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux"
}

function cpuBrand() {
  return (cpus()[0]?.model || "unknown").split(" ")[0]
}

// machineIdOf makes a stable 32-hex machine id like Trae's own telemetry id
// when the caller has none to reuse.
function machineIdOf() {
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list || []) {
      if (nic?.mac && nic.mac !== "00:00:00:00:00:00") {
        return createHash("sha256").update(nic.mac).digest("hex")
      }
    }
  }
  return createHash("sha256").update(randomBytes(32)).digest("hex")
}

// deviceProof signs the renewal request the way the IDE does: ECDSA P-256
// SHA-256 over the joined request lines, base64 DER.
function deviceProof(privateKeyPem, clientId, refreshToken, path) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = randomBytes(8).toString("hex")
  const message = ["POST", path, clientId, refreshToken, timestamp, nonce].join("\n")
  const signature = createSign("sha256").update(message).sign(privateKeyPem, "base64")
  return { DeviceProof: { Signature: signature, Timestamp: timestamp, Nonce: nonce } }
}

async function postJson(url, body) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, json, text }
  } finally {
    clearTimeout(timer)
  }
}

function parseQueryJson(url, key) {
  const raw = url.searchParams.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function listenLoopback(onRequest) {
  return new Promise((resolve, reject) => {
    const server = createServer(onRequest)
    const timer = setTimeout(() => {
      server.close()
      reject(new Error("no free loopback port"))
    }, 5000)
    server.once("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    server.listen(0, "127.0.0.1", () => {
      clearTimeout(timer)
      resolve({ server, port: server.address().port })
    })
  })
}

// authorize runs the browser sign-in. Magpie opens result.url, shows
// result.instructions, and awaits result.callback() — resolved here when the
// loopback callback delivers the credential, or the sign-in times out.
export async function authorize() {
  const clientId = process.env.MAGPIE_TRAE_CLIENT_ID || traeProductId()
  if (!clientId) {
    throw new Error("Trae's install was not found; set MAGPIE_TRAE_APP to its executable (or MAGPIE_TRAE_CLIENT_ID).")
  }
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const machineId = machineIdOf()
  const deviceId = randomUUID()

  // Step 1: listen first, so the authorize URL can carry the real port.
  let handle = null
  let outcomeResolve = null
  const outcome = new Promise((resolve) => {
    outcomeResolve = resolve
  })
  const { server, port } = await listenLoopback((req, res) => {
    if (handle) handle(req, res)
  })
  const timer = setTimeout(() => {
    server.close()
    outcomeResolve({
      error: new Error("Trae sign-in timed out; try magpie plugin login trae-agent again."),
    })
  }, SIGN_IN_TIMEOUT)

  // Step 2: build the URL and hand it to Magpie; the callback promise below
  // resolves when the browser hits /authorize.
  handle = (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1")
    if (url.pathname !== "/authorize") {
      res.writeHead(404).end()
      return
    }
    const userJwt = parseQueryJson(url, "userJwt")
    const userInfo = parseQueryJson(url, "userInfo")
    const access = String(userJwt?.Token || "")
    const refresh = String(userJwt?.RefreshToken || "")
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(
      access && refresh
        ? "<html><body><h3>Trae sign-in complete.</h3><p>You can close this page and go back to Magpie.</p></body></html>"
        : "<html><body><h3>Trae sign-in failed.</h3><p>The page did not deliver a credential; try again.</p></body></html>",
    )
    clearTimeout(timer)
    server.close()
    if (!access || !refresh) {
      outcomeResolve({ error: new Error("The authorization page returned no credential.") })
      return
    }
    outcomeResolve({
      auth: {
        type: "oauth",
        access,
        refresh,
        expires: Number(userJwt?.TokenExpireAt || 0) || Date.now() + 13 * 24 * 60 * 60 * 1000,
        accountId: String(userInfo?.UserID || ""),
        clientId,
        deviceId,
        machineId,
        devicePublicKey: publicKeyPem,
        devicePrivateKey: privateKeyPem,
      },
    })
  }

  const params = new URLSearchParams({
    login_version: "1",
    auth_from: "trae",
    login_channel: "native_ide",
    plugin_version: "trae-handoff-1.0",
    auth_type: "local",
    client_id: clientId,
    redirect: "0",
    login_trace_id: randomUUID(),
    auth_callback_url: `http://127.0.0.1:${port}/authorize`,
    hide_saas_login: "false",
    machine_id: machineId,
    device_id: deviceId,
    x_device_id: deviceId,
    x_machine_id: machineId,
    x_device_brand: "unknown",
    x_device_type: process.platform,
    x_os_version: osVersion(),
    x_device_cpu: cpuBrand(),
    x_app_version: "3.5.51",
    x_app_type: "stable",
  })

  return {
    url: `https://www.trae.ai/authorization?${params}`,
    instructions:
      "Sign in to Trae in the browser (the same account as the Trae IDE) and approve the sign-in; it finishes here by itself.",
    method: "auto",
    callback: async () => {
      const result = await outcome
      if (result.error) throw result.error
      return { ...result.auth, type: "success" }
    },
  }
}

async function refresh(auth) {
  if (!auth?.refresh) return undefined
  const path = "/trae/api/v3/oauth/ExchangeToken"
  const clientId = auth.clientId || process.env.MAGPIE_TRAE_CLIENT_ID || traeProductId()
  if (!clientId) {
    console.error("trae sign-in refresh failed: Trae client id not found")
    return undefined
  }
  let lastError = "no host answered"
  for (const host of AUTH_HOSTS) {
    const proof = deviceProof(auth.devicePrivateKey, clientId, auth.refresh, path)
    const body = {
      ClientID: clientId,
      ClientSecret: "",
      RefreshToken: auth.refresh,
      DeviceInfo: {
        DeviceID: auth.deviceId,
        MachineID: auth.machineId,
        PlatformCode: "IDE_PC",
        DeviceType: "PC",
        ClientVersion: "3.5.51",
        DevicePublicKey: auth.devicePublicKey,
        DeviceBrand: "unknown",
        DeviceCPU: cpuBrand(),
        OSInfo: osName(),
        OSVersion: osVersion(),
      },
      ...proof,
      IDEVersion: "3.5.51",
    }
    const res = await postJson(`${host}${path}`, body)
    const result = res.json?.Result
    if (res.status === 200 && result?.Token && result?.RefreshToken) {
      return {
        access: String(result.Token),
        refresh: String(result.RefreshToken),
        expires: Number(result.TokenExpireAt || 0) || Date.now() + 13 * 24 * 60 * 60 * 1000,
      }
    }
    lastError = `${res.status} ${String(res.text || "").slice(0, 120)}`
  }
  console.error(`trae sign-in refresh failed: ${lastError}`)
  return undefined
}

// ownSigninFlow is what index.mjs wires into auth.methods / auth.refresh.
export const ownSigninFlow = { authorize, refresh }
