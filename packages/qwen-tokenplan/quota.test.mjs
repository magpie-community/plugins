import { expect, test } from "bun:test"
import { QuotaError, readAllowance } from "./quota.mjs"
import { decryptCredential, CredentialError, findApiRoutes, findCliBundle } from "./credential.mjs"
import crypto from "node:crypto"

const now = Date.parse("2026-11-12T00:00:00Z")
const subscription = {
  specCode: "standard", startTime: Date.parse("2026-10-17T00:00:00Z"),
  endTime: Date.parse("2026-11-17T00:00:00Z"), status: "VALID", autoRenewFlag: false,
}
const config = { standard: { monthly: 80000 } }

 test("monthly usage becomes a quota window, with no invented five-hour limit", () => {
  const out = readAllowance(subscription, config, { per1MonthPercentage: 0.6375, per1MonthResetTime: subscription.endTime }, now)
  expect(out.plan).toBe("Token Plan (standard)")
  expect(out.until).toBe("2026-11-17T00:00:00.000Z")
  expect(out.renew).toBe("off")
  expect(out.windows).toHaveLength(1)
  expect(out.windows[0]).toMatchObject({ name: "Month", limit: 80000, amount: 51000, unit: "credits", resetsAt: "2026-11-17T00:00:00.000Z" })
  expect(out.balance).toBe("29000 credits")
  expect(JSON.stringify(out)).not.toContain("fiveHour")
  expect(JSON.stringify(out)).not.toContain("5 hours")
})

test("weekly quota remains usable when monthly usage is absent", () => {
  const out = readAllowance(subscription, { standard: { weekly: 1000 } }, { per1WeekPercentage: 0.25, per1WeekResetTime: subscription.endTime }, now)
  expect(out.windows[0]).toMatchObject({ amount: 250, limit: 1000, used: 25 })
})

test("invalid or inactive subscription is not reported as available", () => {
  expect(() => readAllowance({ ...subscription, status: "EXPIRED" }, config, { per1MonthPercentage: 0 }, now)).toThrow(QuotaError)
  expect(() => readAllowance(subscription, config, { per1MonthPercentage: 1.1, per1MonthResetTime: subscription.endTime }, now)).toThrow(QuotaError)
  expect(() => readAllowance(subscription, config, {}, now)).toThrow("monthly usage is not reported")
})

test("CLI credential decrypts with the same key derivation and never exposes it in errors", () => {
  const key = Buffer.from("test-key")
  const salt = crypto.randomBytes(32)
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", crypto.pbkdf2Sync(key, salt, 260000, 32, "sha256"), nonce)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ access_token: "test-only" })), cipher.final(), cipher.getAuthTag()])
  const token = decryptCredential(JSON.stringify({ version: 1, salt: salt.toString("base64"), nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64") }), key)
  expect(token).toBe("test-only")
  expect(() => decryptCredential("{bad", key)).toThrow(CredentialError)
  expect(() => decryptCredential("{}", key)).toThrow(CredentialError)
})

test("CLI route discovery requires the official bundle's Token Plan routes", () => {
  expect(() => findApiRoutes("/tmp/does-not-exist-qwen-cli")).toThrow(CredentialError)
})

test("CLI bundle discovery supports env overrides and fallback to null", () => {
  expect(findCliBundle([], { PATH: "" }, "linux", "/nonexistent-home")).toBeNull()
  expect(findCliBundle(["/nonexistent-root"], { PATH: "" }, "linux", "/nonexistent-home")).toBeNull()
})
