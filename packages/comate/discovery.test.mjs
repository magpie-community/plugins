import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  credential,
  isComate,
  pidFile,
  portOf,
  readPort,
  readState,
  settingsFile,
  zulu,
} from "./discovery.mjs"

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "comate-discovery-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function put(path, text) {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text, "utf8")
}

function pidOptions(path, extra = {}) {
  return { platform: "darwin", pidPath: path, env: {}, ...extra }
}

test("settings paths follow Windows, macOS, and XDG conventions", () => {
  assert.equal(
    settingsFile({ platform: "win32", home: "C:\\Users\\dev", env: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" } }),
    "C:\\Users\\dev\\AppData\\Roaming\\Comate\\User\\settings.json",
  )
  assert.equal(
    settingsFile({ platform: "win32", home: "C:\\Users\\dev", env: { APPDATA: "relative\\roaming" } }),
    "C:\\Users\\dev\\AppData\\Roaming\\Comate\\User\\settings.json",
  )
  assert.equal(
    settingsFile({ platform: "darwin", home: "/Users/dev", env: {} }),
    "/Users/dev/Library/Application Support/Comate/User/settings.json",
  )
  assert.equal(
    settingsFile({ platform: "linux", home: "/home/dev", env: { XDG_CONFIG_HOME: "/portable/config" } }),
    "/portable/config/Comate/User/settings.json",
  )
  assert.equal(
    settingsFile({ platform: "linux", home: "/home/dev", env: { XDG_CONFIG_HOME: "relative/config" } }),
    "/home/dev/.config/Comate/User/settings.json",
  )
})

test("explicit settings and PID paths override platform discovery and must be absolute", () => {
  assert.equal(
    settingsFile({ platform: "win32", home: "C:\\Users\\dev", env: { COMATE_SETTINGS_PATH: "D:\\portable\\settings.json" }, settingsPath: "E:\\override\\settings.json" }),
    "E:\\override\\settings.json",
  )
  assert.equal(
    settingsFile({ platform: "darwin", home: "/home/dev", env: { COMATE_SETTINGS_PATH: "/portable/comate.json" } }),
    "/portable/comate.json",
  )
  assert.equal(
    pidFile({ platform: "win32", home: "C:\\Users\\dev", env: { COMATE_PID_PATH: "D:\\portable\\zulu.json" } }),
    "D:\\portable\\zulu.json",
  )
  assert.throws(
    () => settingsFile({ platform: "linux", home: "/home/dev", env: { COMATE_SETTINGS_PATH: "relative/settings.json" } }),
    { code: "COMATE_PATH_INVALID" },
  )
})

test("settings JSONC parsing preserves URL/comment text and accepts BOM and trailing commas", (t) => {
  const dir = tempDir(t)
  const path = join(dir, "settings.json")
  put(path, `\uFEFF{
    // local sign-in setting
    "baidu.comate.license": "test-only-license",
    "baidu.comate.username": "test-user",
    "reference": "https://example.invalid/a//b",
    "commentText": "/* this is text */",
    "nested": { "values": [1, 2,], },
  }`)

  assert.deepEqual(readState({ settingsPath: path, platform: "linux", env: {} }), {
    license: "test-only-license",
    username: "test-user",
  })
})

test("missing settings are absent; malformed settings yield a sanitized diagnostic", (t) => {
  const dir = tempDir(t)
  const missing = join(dir, "missing.json")
  assert.equal(readState({ settingsPath: missing, platform: "linux", env: {} }), null)

  const path = join(dir, "bad.json")
  put(path, `{"baidu.comate.license":"test-only-value", /* never show this */`)
  assert.throws(
    () => readState({ settingsPath: path, platform: "linux", env: {} }),
    (error) => error.code === "COMATE_SETTINGS_INVALID" && !error.message.includes("test-only-value"),
  )
})

test("PID metadata accepts a valid loopback port and rejects unsafe or malformed data", (t) => {
  const dir = tempDir(t)
  const path = join(dir, "zulu-serve.pid")
  const options = pidOptions(path)

  assert.equal(readPort(options), 0)
  put(path, `{
    // the service's local endpoint
    "pid": 42,
    "port": 8742,
    "host": "127.0.0.1",
  }`)
  assert.equal(readPort(options), 8742)

  put(path, `{"port": 8742, "host": "192.0.2.4"}`)
  assert.throws(() => readPort(options), { code: "COMATE_PID_HOST_INVALID" })

  put(path, `{"port": 8742.5}`)
  assert.throws(() => readPort(options), { code: "COMATE_PID_INVALID" })

  put(path, `{"pid": "not-a-process-id", "port": 8742}`)
  assert.throws(() => readPort(options), { code: "COMATE_PID_INVALID" })

  put(path, `{"port": 8742, /* test-only-marker */`)
  assert.throws(
    () => readPort(options),
    (error) => error.code === "COMATE_PID_INVALID" && !error.message.includes("test-only-marker"),
  )

  assert.throws(() => readPort(pidOptions(dir)), { code: "COMATE_PID_UNREADABLE" })
})

test("port selection prefers an explicit override, then PID metadata, auth, and fallback", (t) => {
  const dir = tempDir(t)
  const path = join(dir, "zulu-serve.pid")
  put(path, `{"port": 8301, "host": "localhost"}`)

  assert.equal(portOf({ port: 8401 }, pidOptions(path, { port: 8501, env: { COMATE_PORT: "8601" } })), 8501)
  assert.equal(portOf({ port: 8401 }, pidOptions(path, { env: { COMATE_PORT: "8601" } })), 8601)
  assert.equal(portOf({ port: 8401 }, pidOptions(path)), 8301)
  assert.equal(portOf({ port: 8401 }, pidOptions(join(dir, "missing.pid"))), 8401)
  assert.equal(portOf({ metadata: { port: 8402 } }, pidOptions(join(dir, "missing.pid"))), 8402)
  assert.equal(portOf({}, pidOptions(join(dir, "missing.pid"))), 8741)
  assert.throws(() => portOf({}, pidOptions(path, { port: 0 })), { code: "COMATE_PORT_INVALID" })
})

test("the service URL stays on IPv4 loopback", () => {
  assert.equal(zulu({ host: "remote.example", port: 9123 }, { port: 9124, env: {} }), "http://127.0.0.1:9124")
})

test("auth recognition is provider-specific while accepting a plain OpenCode API-key shape", () => {
  assert.equal(isComate({ type: "oauth", source: "comate" }), true)
  assert.equal(isComate({ type: "oauth", source: "comate-paste" }), true)
  assert.equal(isComate({ type: "oauth", source: "comate-other" }), false)
  assert.equal(isComate({ type: "oauth", source: "other" }), false)
  assert.equal(isComate({ type: "api", key: "test-only-license" }), true)
  assert.equal(isComate({ type: "api", key: "test-only-license", metadata: { source: "comate-paste" } }), true)
  assert.equal(isComate({ type: "api", key: "test-only-license", source: "other-provider" }), false)
})

test("desktop credentials re-read settings, while a pasted API credential uses its configured port", async (t) => {
  const dir = tempDir(t)
  const settingsPath = join(dir, "settings.json")
  const options = { platform: "linux", env: {}, settingsPath, pidPath: join(dir, "missing.pid") }
  put(settingsPath, `{"baidu.comate.license":"test-only-first","baidu.comate.username":"first"}`)

  assert.deepEqual(await credential(async () => ({ type: "oauth", source: "comate", accountId: "saved-user" }), options), {
    license: "test-only-first",
    port: 8741,
    who: "first",
  })
  put(settingsPath, `{"baidu.comate.license":"test-only-second","baidu.comate.username":"second"}`)
  assert.deepEqual(await credential(async () => ({ type: "oauth", source: "comate" }), options), {
    license: "test-only-second",
    port: 8741,
    who: "second",
  })

  assert.deepEqual(await credential(async () => ({ type: "api", key: "test-only-paste", metadata: { source: "comate-paste", port: 8123 } }), options), {
    license: "test-only-paste",
    port: 8123,
    who: "",
  })
  assert.deepEqual(await credential(async () => ({ type: "oauth", source: "comate-paste", access: "test-only-paste-oauth", port: 8124 }), options), {
    license: "test-only-paste-oauth",
    port: 8124,
    who: "",
  })
  assert.equal(await credential(async () => ({ type: "oauth", source: "unrelated" }), options), null)
})

test("only signed-out desktop state expires; malformed or unreadable settings keep sign-in and retain safe error codes", async (t) => {
  const dir = tempDir(t)
  const path = join(dir, "settings.json")
  const auth = async () => ({ type: "oauth", source: "comate" })

  await assert.rejects(
    credential(auth, { settingsPath: join(dir, "missing.json"), platform: "linux", env: {}, pidPath: join(dir, "missing.pid") }),
    (error) => error.signIn === "expired" && !error.message.includes("test-only"),
  )

  put(path, `{"baidu.comate.license":"test-only-value", /* malformed */`)
  await assert.rejects(
    credential(auth, { settingsPath: path, platform: "linux", env: {}, pidPath: join(dir, "missing.pid") }),
    (error) => error.signIn === "kept" && error.code === "COMATE_SETTINGS_INVALID" && error.message.includes("JSONC") && !error.message.includes("test-only-value"),
  )

  await assert.rejects(
    credential(auth, { settingsPath: dir, platform: "linux", env: {}, pidPath: join(dir, "missing.pid") }),
    (error) => error.signIn === "kept" && error.code === "COMATE_SETTINGS_UNREADABLE" && !error.message.includes("test-only"),
  )
})
