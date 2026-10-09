import { expect, test } from "bun:test"
import { createCipheriv } from "node:crypto"
import { join } from "node:path"
import { _internal } from "./index.mjs"

const user = { email: "test@example.invalid", local_id: "test", id_token: { id_token: "fake", refresh_token: "fake-refresh" } }
const json = Buffer.from(JSON.stringify(user))
const absent = () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }) }
const encrypt = (plain) => {
  const iv = Buffer.alloc(12, 7)
  const cipher = createCipheriv("aes-256-gcm", Buffer.from("https://releases.warp.dev/channel_versions.json").subarray(0, 32), iv)
  return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()])
}

test("platform context follows the host and its shell", () => {
  expect(_internal.platformInfo("darwin", {})).toEqual({ category: "macOS", shell: "zsh" })
  expect(_internal.platformInfo("linux", { SHELL: "/usr/bin/fish" })).toEqual({ category: "Linux", shell: "fish" })
  expect(_internal.platformInfo("win32", {})).toEqual({ category: "Windows", shell: "powershell" })
})

test("macOS reads the stable GUI Keychain service and User account", async () => {
  const readUser = _internal.createUserReader({ platform: "darwin", home: "/empty", read: () => { throw new Error("must not read a file") }, run: async (cmd, args) => {
    expect(cmd).toBe("/usr/bin/security")
    expect(args).toEqual(["find-generic-password", "-s", "dev.warp.Warp-Stable", "-a", "User", "-w"])
    return { code: 0, stdout: json }
  } })
  expect(await readUser()).toEqual(user)
})

test("macOS reports missing and inaccessible keychains without exposing output", async () => {
  const missing = _internal.createUserReader({ platform: "darwin", run: async () => ({ code: 44, stdout: Buffer.alloc(0) }) })
  expect(await missing()).toBeNull()
  const locked = _internal.createUserReader({ platform: "darwin", run: async () => ({ code: 1, stdout: Buffer.from("do-not-expose-token") }) })
  await expect(locked()).rejects.toThrow(/unlock the keychain/)
})

test("Linux reads Secret Service using Warp's exact attributes", async () => {
  const readUser = _internal.createUserReader({ platform: "linux", read: () => { throw new Error("no file expected") }, run: async (cmd, args) => {
    expect(cmd).toBe("secret-tool")
    expect(args).toEqual(["lookup", "service", "dev.warp.Warp", "key", "User"])
    return { code: 0, stdout: json }
  } })
  expect(await readUser()).toEqual(user)
})

test("Linux decrypts Warp's disk fallback under XDG_STATE_HOME", async () => {
  const readUser = _internal.createUserReader({ platform: "linux", home: "/unused", env: { XDG_STATE_HOME: "/sandbox/state" }, run: async () => { throw new Error("secret-tool not installed") }, read: (path) => {
    expect(path).toBe(join("/sandbox/state", "warp-terminal", "dev.warp.Warp-User"))
    return encrypt(json)
  } })
  expect(await readUser()).toEqual(user)
})

test("Linux default state directory and missing login are handled", async () => {
  const readUser = _internal.createUserReader({ platform: "linux", home: "/sandbox/home", env: {}, run: async () => ({ code: 1, stdout: Buffer.alloc(0) }), read: (path) => {
    expect(path).toBe(join("/sandbox/home", ".local", "state", "warp-terminal", "dev.warp.Warp-User"))
    return absent()
  } })
  expect(await readUser()).toBeNull()
})

test("Linux fallback authenticates the ciphertext and rejects truncation", () => {
  const blob = encrypt(json)
  blob[15] ^= 1
  expect(() => _internal.linuxUser(blob)).toThrow()
  expect(() => _internal.linuxUser(Buffer.alloc(10))).toThrow(/truncated/)
})

test("Windows honors LOCALAPPDATA and passes encrypted bytes on stdin", async () => {
  let decrypts = 0, blob = Buffer.from("encrypted-v1")
  const readUser = _internal.createUserReader({ platform: "win32", home: "/wrong", env: { LOCALAPPDATA: "/redirected/it's-local" }, read: (path) => {
    expect(path).toBe(join("/redirected/it's-local", "warp", "Warp", "data", "dev.warp.Warp-User"))
    return blob
  }, run: async (cmd, args, script) => {
    decrypts++
    expect(cmd).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    expect(args.slice(-2)).toEqual(["-Command", "-"])
    expect(script).toContain(blob.toString("base64"))
    expect(script).not.toContain("it's-local")
    expect(script).toContain("OpenStandardOutput().Write")
    return { code: 0, stdout: json }
  } })
  expect(await readUser()).toEqual(user)
  expect(await readUser()).toEqual(user)
  expect(decrypts).toBe(1)
  blob = Buffer.from("encrypted-v2")
  await readUser()
  expect(decrypts).toBe(2)
  await readUser(true)
  expect(decrypts).toBe(3)
})

test("client version follows Warp's environment, with a validated explicit override", () => {
  const native = "v0.2026.10.09.08.27.stable_01", override = "v0.2026.10.10.08.27.stable_01"
  expect(_internal.clientVersion({ WARP_CLIENT_VERSION: native })).toBe(native)
  expect(_internal.clientVersion({ WARP_CLIENT_VERSION: native, MAGPIE_WARP_CLIENT_VERSION: override })).toBe(override)
  expect(_internal.clientVersion({ WARP_CLIENT_VERSION: native + "\r\ninjected: value" })).toBe(_internal.clientVersion({}))
})

test("Windows absent file never spawns PowerShell", async () => {
  const readUser = _internal.createUserReader({ platform: "win32", home: "/empty", env: {}, read: absent, run: async () => { throw new Error("must not spawn") } })
  expect(await readUser()).toBeNull()
})
