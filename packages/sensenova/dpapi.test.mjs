// The credential seal: DPAPI on Windows, plaintext elsewhere — and a Windows
// session whose DPAPI refuses must still keep the account working (0.1.3
// stored plaintext, so falling back is the upgrade-safe behaviour).
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { _setCryptoForTests, seal, unseal } from "./lib/dpapi.mjs"

afterEach(() => _setCryptoForTests(null))

test("a Windows session whose DPAPI refuses stores the value as plaintext and says why", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: "win32", configurable: true })
  _setCryptoForTests({
    protect() {
      throw new Error("Access is denied")
    },
    unprotect() {
      throw new Error("Access is denied")
    },
  })
  const logs = []
  try {
    const stored = await seal("jwt-1", { log: (level, message) => logs.push([level, message]) })
    // 0.1.3 kept plaintext; a broken profile must not turn every refresh into
    // an error the host retries forever
    expect(stored).toBe("jwt-1")
    expect(await unseal(stored)).toBe("jwt-1")
    expect(logs.length).toBe(1)
    expect(logs[0][0]).toBe("warn")
    expect(logs[0][1]).toContain("DPAPI")
  } finally {
    if (platform) Object.defineProperty(process, "platform", platform)
  }
})

test("a working DPAPI still seals, and unseal reads it back", async () => {
  _setCryptoForTests({
    protect: (plain) => Buffer.from("sealed:" + plain, "utf8"),
    unprotect: (buf) => Buffer.from(String(buf).replace(/^sealed:/, ""), "utf8"),
  })
  const stored = await seal("jwt-2")
  expect(stored).toStartWith("dpapi:")
  expect(await unseal(stored)).toBe("jwt-2")
})

test("a plaintext value is returned as-is, so 0.1.3 records keep working", async () => {
  expect(await unseal("plain-jwt")).toBe("plain-jwt")
  expect(await unseal("")).toBe("")
})

test("a Windows session whose DPAPI cannot be loaded stores the value as plaintext and says why", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: "win32", configurable: true })
  _setCryptoForTests({ loadError: "crypt32.dll failed to load" })
  const logs = []
  try {
    const stored = await seal("jwt-3", { log: (level, message) => logs.push([level, message]) })
    // the same 0.1.3-safe outcome as an outright refusal: plaintext + a reason
    expect(stored).toBe("jwt-3")
    expect(await unseal(stored)).toBe("jwt-3")
    expect(logs.length).toBe(1)
    expect(logs[0][0]).toBe("warn")
    expect(logs[0][1]).toContain("could not be loaded")
  } finally {
    if (platform) Object.defineProperty(process, "platform", platform)
  }
})