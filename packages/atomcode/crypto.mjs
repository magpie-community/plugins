// In-memory signing engine for AtomGit CodingPlan (AtomCode v1 signing protocol).
// Reverse-engineered from official atomcode-codingplan-crypto/src/versions/v1.rs
// Eliminates the need for any local background daemons or external relay scripts.

import crypto from "node:crypto"

// 32-byte Master Secret seed recovered from atomcode binary (.rdata XOR blocks b1 and b2)
export const MASTER_SEED = Buffer.from(
  "e97250f05303162c8ecd68c688b2f55c1d81e508d243d88466472e7f54637123",
  "hex"
)

export const SIGNING_ALGORITHM = "v1"
export const CLIENT_VERSION = "5.0.9"
export const HKDF_INFO = Buffer.from("atomcode-signing-v1", "utf-8")

/**
 * Standard RFC 5869 HKDF-SHA256 Extract and Expand.
 * Pure in-memory implementation compatible with Bun, Node.js, and Edge environments.
 */
export function hkdfSha256(ikm, salt, info, length = 32) {
  // 1. Extract: PRK = HMAC-Hash(salt, IKM)
  const saltBuf = salt && salt.length > 0 ? salt : Buffer.alloc(32)
  const prk = crypto.createHmac("sha256", saltBuf).update(ikm).digest()

  // 2. Expand: T(1) = HMAC-Hash(PRK, info || 0x01)
  let t = Buffer.alloc(0)
  let okm = Buffer.alloc(0)
  let i = 0
  while (okm.length < length) {
    i++
    t = crypto
      .createHmac("sha256", prk)
      .update(Buffer.concat([t, info, Buffer.from([i])]))
      .digest()
    okm = Buffer.concat([okm, t])
  }
  return okm.subarray(0, length)
}

/**
 * Derives the hourly signing key for a given timestamp and optional token.
 */
export function deriveSigningKey(timestampSec, accountToken = "") {
  const windowHour = Math.floor(timestampSec / 3600)
  const saltBuf = Buffer.alloc(16)
  saltBuf.writeBigUInt64LE(BigInt(windowHour), 0)
  if (accountToken) {
    const tokenHash = crypto.createHash("sha256").update(accountToken).digest()
    for (let i = 0; i < 8; i++) {
      saltBuf[8 + i] = tokenHash[i]
    }
  }
  return hkdfSha256(MASTER_SEED, saltBuf, HKDF_INFO, 32)
}

/**
 * Generates the Canonical String according to v1.rs:
 * {version}\n{method}\n{path}\n{nonce}\n{timestamp}\n{bodySha256Hex}
 */
export function buildCanonicalString({
  method = "POST",
  path = "/v1/chat/completions",
  nonce,
  timestamp,
  body,
}) {
  const bodyBuf =
    typeof body === "string"
      ? Buffer.from(body, "utf-8")
      : Buffer.from(body || "")
  const bodySha256 = crypto.createHash("sha256").update(bodyBuf).digest("hex")
  return `${SIGNING_ALGORITHM}\n${method.toUpperCase()}\n${path}\n${nonce}\n${timestamp}\n${bodySha256}`
}

/**
 * Signs an outgoing HTTP request and returns the required authentication headers.
 */
export function signRequest({
  method = "POST",
  url = "https://llm-api.atomgit.com/v1/chat/completions",
  body,
  token = "",
  timestamp = Math.floor(Date.now() / 1000),
  nonce = crypto.randomBytes(16).toString("hex"),
  sessionId = crypto.randomUUID(),
}) {
  let path = "/v1/chat/completions"
  try {
    const parsed = new URL(url)
    path = parsed.pathname + parsed.search
  } catch {}

  const signingKey = deriveSigningKey(timestamp, token)
  const canonical = buildCanonicalString({
    method,
    path,
    nonce,
    timestamp,
    body,
  })

  const rawSig = crypto
    .createHmac("sha256", signingKey)
    .update(canonical, "utf-8")
    .digest("hex")

  return {
    "x-atomcode-session-id": sessionId,
    "X-AtomCode-Sig": `v1:${rawSig}`,
    "X-AtomCode-Ts": String(timestamp),
    "X-AtomCode-Nonce": nonce,
    "X-AtomCode-Alg": SIGNING_ALGORITHM,
    "X-AtomCode-Ver": CLIENT_VERSION,
  }
}

export default {
  MASTER_SEED,
  SIGNING_ALGORITHM,
  CLIENT_VERSION,
  HKDF_INFO,
  hkdfSha256,
  deriveSigningKey,
  buildCanonicalString,
  signRequest,
}
