// BigModel's zhipu-client-sign channel, matching the ZCode 3.15.3 client. It
// serves opt-in -Signed model entries. The derived signing key is cached only
// in memory (and optionally in a 0600 file sealed with the credential HKDF).
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign as cryptoSign,
} from "node:crypto"
import { readFileSync, renameSync, writeFileSync } from "node:fs"

const UPSTREAM = "https://open.bigmodel.cn"
const HANDSHAKE_PATH = "/api/paas/c1f3a7e2/v2/client"
const KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT"
const APP_ID = "zcode"
const VERSION = "3.15.3"
const POW_NONCE_BYTES = 12 // 24 hex chars; plus an 8-hex counter = official 32-char candidate
const POW_COUNTER_WIDTH = 8

function hkdf(secret, info, length) {
  const prk = createHmac("sha256", KDF_SALT).update(secret).digest()
  const out = []
  let t = Buffer.alloc(0)
  for (let i = 1; Buffer.concat(out).length < length; i++) {
    t = createHmac("sha256", prk).update(Buffer.concat([t, Buffer.from(info), Buffer.from([i])])).digest()
    out.push(t)
  }
  return Buffer.concat(out).subarray(0, length)
}

function gcmOpen(key, blob, aad) {
  if (!(blob.length > 12 + 16)) throw new Error("cipher is too short")
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(blob.subarray(blob.length - 16))
  return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()])
}

function gcmSeal(key, plain, aad) {
  const nonce = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", key, nonce)
  c.setAAD(Buffer.from(aad))
  return Buffer.concat([nonce, c.update(plain), c.final(), c.getAuthTag()])
}

export function minePow(keyID, sessionID, ts) {
  const challenge = createHash("sha256")
    .update(`${keyID}\n${APP_ID}\n${sessionID}\n${ts}`)
    .digest("hex")
    .slice(0, 32)
  const prefix = randomBytes(POW_NONCE_BYTES).toString("hex")
  for (let counter = 0; counter <= 0xffffffff; counter++) {
    const candidate = `${prefix}${counter.toString(16).padStart(POW_COUNTER_WIDTH, "0")}`
    const digest = createHash("sha256").update(`${challenge}\n${candidate}`).digest()
    if (digest[0] === 0) return candidate
  }
  throw new Error("Unable to solve BigModel client proof of work")
}

function parseCredential(apiKey) {
  const parts = String(apiKey).split(".")
  if (parts.length === 3 && parts[2]) {
    try {
      const header = JSON.parse(Buffer.from(parts[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))
      const claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))
      if (header?.alg === "HS256" && header?.typ === "JWT" && header?.sign_type === "SIGN" && claims?.token_use === "project_access" && claims?.api_key) {
        return { apiKeyId: claims.api_key, credential: apiKey, secret: apiKey, handshakeField: "accessToken" }
      }
    } catch {}
  }
  const at = apiKey.indexOf(".")
  if (at > 0 && at === apiKey.lastIndexOf(".")) return { apiKeyId: apiKey.slice(0, at), credential: apiKey, secret: apiKey.slice(at + 1), handshakeField: "apiKey" }
  throw new Error("BigModel's sign key must be an API key or project access token")
}

function privateKeyFromDER(der) {
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" })
  if (key.asymmetricKeyType !== "ed25519") throw new Error("BigModel's sign key is not Ed25519")
  return key
}

function cacheKey(secret) {
  return hkdf(secret, "local-key-cache", 32)
}

function readKeyCache(path, keyID, secret, setKey) {
  if (!path) return
  let entry = {}
  try { entry = JSON.parse(readFileSync(path, "utf8")) ?? {} } catch { return }
  if (entry.keyId !== keyID || typeof entry.cipher !== "string" || !entry.cipher) return
  const der = gcmOpen(cacheKey(secret), Buffer.from(entry.cipher, "base64"), keyID)
  setKey(privateKeyFromDER(der), gcmSeal(cacheKey(secret), der, keyID))
}

function writeKeyCache(path, keyID, secret, key) {
  if (!path || !key) return
  const der = key.export({ format: "der", type: "pkcs8" })
  const blob = gcmSeal(cacheKey(secret), der, keyID)
  const raw = JSON.stringify({ keyId: keyID, savedAt: Date.now(), cipher: blob.toString("base64") })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, raw, { mode: 0o600 })
  renameSync(tmp, path)
}

export function createSigner({ apiKey, cachePath = "", fetchImpl = globalThis.fetch } = {}) {
  let keyID, secret, credential, handshakeField, key, sealedDER, inflight
  if (apiKey !== undefined) ({ apiKeyId: keyID, credential, secret, handshakeField } = parseCredential(apiKey))
  const setKey = (nextKey, sealed) => { key = nextKey; sealedDER = sealed }
  readKeyCache(cachePath, keyID, secret, setKey)

  async function handshake() {
    const ts = String(Date.now())
    const nonce = randomBytes(16).toString("hex")
    const mac = createHmac("sha256", hkdf(secret, "getSignKey_hmac", 32))
      .update(`get_sign_key\n${keyID}\n${ts}\n${nonce}`)
      .digest("base64")
    const res = await fetchImpl(UPSTREAM + HANDSHAKE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: credential },
      body: JSON.stringify({ [handshakeField]: credential, ts, nonce, sig: mac }),
      signal: AbortSignal.timeout(30_000),
    })
    const env = await res.json().catch(() => ({}))
    const cipher = env?.data?.privateCipher
    if (!res.ok || env?.code !== 200 || !cipher) throw new Error(`BigModel sign handshake: HTTP ${res.status} code ${env?.code ?? "none"}`)
    const plain = gcmOpen(hkdf(secret, "ed25519_priv", 32), Buffer.from(cipher, "base64"), keyID)
    const der = Buffer.from(plain.toString("utf8").trim(), "base64")
    key = privateKeyFromDER(der)
    sealedDER = gcmSeal(cacheKey(secret), der, keyID)
    writeKeyCache(cachePath, keyID, secret, key)
  }

  async function ensure() {
    if (key) return
    if (sealedDER) {
      key = privateKeyFromDER(gcmOpen(cacheKey(secret), sealedDER, keyID))
      return
    }
    inflight ??= handshake().finally(() => { inflight = undefined })
    await inflight
  }

  function reset() {
    key = undefined
    sealedDER = undefined
  }

  async function headers(sessionID) {
    await ensure()
    const ts = String(Date.now())
    const nonce = randomBytes(16).toString("hex")
    const payload = `${keyID}\n${ts}\n${VERSION}\n${sessionID}\n${nonce}`
    return {
      "X-Client-Ts": ts,
      "X-Client-Version": VERSION,
      "X-Client-Sig": cryptoSign(null, Buffer.from(payload), key).toString("base64"),
      "X-Session-Id": sessionID,
      "X-Client-Nonce": nonce,
      "X-App-Id": APP_ID,
      "X-Client-Pow": minePow(keyID, sessionID, ts),
    }
  }

  return { headers, reset, ensure, bind(nextKey) {
    ({ apiKeyId: keyID, credential, secret, handshakeField } = parseCredential(nextKey))
    reset()
  } }
}
