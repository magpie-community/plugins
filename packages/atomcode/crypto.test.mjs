import { expect, test } from "bun:test"
import {
  MASTER_SEED,
  SIGNING_ALGORITHM,
  CLIENT_VERSION,
  hkdfSha256,
  deriveSigningKey,
  buildCanonicalString,
  signRequest,
} from "./crypto.mjs"

test("crypto constants are valid", () => {
  expect(MASTER_SEED).toBeDefined()
  expect(MASTER_SEED.length).toBe(32)
  expect(SIGNING_ALGORITHM).toBe("v1")
  expect(CLIENT_VERSION).toBe("5.0.9")
})

test("hkdfSha256 matches RFC 5869 test vector 1", () => {
  const ikm = Buffer.from("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", "hex")
  const salt = Buffer.from("000102030405060708090a0b0c", "hex")
  const info = Buffer.from("f0f1f2f3f4f5f6f7f8f9", "hex")
  const okm = hkdfSha256(ikm, salt, info, 42)
  const expected = "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
  expect(Buffer.from(okm).toString("hex")).toBe(expected)
})

test("deriveSigningKey returns 32-byte key deterministic per hour", () => {
  const ts1 = 1793946000
  const ts2 = 1793946050
  const ts3 = 1793949600

  const k1 = deriveSigningKey(ts1, "token-1")
  const k2 = deriveSigningKey(ts2, "token-1")
  const k3 = deriveSigningKey(ts3, "token-1")

  expect(k1.length).toBe(32)
  expect(k1.equals(k2)).toBe(true)
  expect(k1.equals(k3)).toBe(false)
})

test("buildCanonicalString formats according to v1.rs spec", () => {
  const canonical = buildCanonicalString({
    method: "POST",
    path: "/v1/chat/completions",
    nonce: "test-nonce-123",
    timestamp: 1793946000,
    body: "{}",
  })

  expect(canonical).toContain("v1\nPOST\n/v1/chat/completions\ntest-nonce-123\n1793946000\n")
})

test("signRequest produces complete X-AtomCode headers", () => {
  const headers = signRequest({
    method: "POST",
    url: "https://llm-api.atomgit.com/v1/chat/completions",
    body: "{}",
    token: "mock-token",
    timestamp: 1793946000,
    nonce: "0123456789abcdef0123456789abcdef",
    sessionId: "mock-session-id",
  })

  expect(headers["X-AtomCode-Sig"]).toMatch(/^v1:[a-f0-9]{64}$/)
  expect(headers["X-AtomCode-Ts"]).toBe("1793946000")
  expect(headers["X-AtomCode-Nonce"]).toBe("0123456789abcdef0123456789abcdef")
  expect(headers["X-AtomCode-Alg"]).toBe("v1")
  expect(headers["X-AtomCode-Ver"]).toBe("5.0.9")
  expect(headers["x-atomcode-session-id"]).toBe("mock-session-id")
})
