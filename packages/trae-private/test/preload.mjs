// 在任何生产模块导入前隔离环境；仅使用构造的身份和显式 mock。
import { afterEach, beforeEach, mock } from "bun:test"
import * as fs from "node:fs"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
const root = mkdtempSync(join(tmpdir(), "trae-provider-test-"))
const fsOriginal = { ...fs }
const roots = [resolve(root), fsOriginal.realpathSync(root)]
const inside = (path) => {
  const full = resolve(String(path))
  if (!roots.some((dir) => full === dir || full.startsWith(dir + sep))) throw new Error("Test isolation: file access outside owned temporary root")
}
mock.module("node:fs", () => {
  const guarded = { ...fsOriginal }
  for (const name of ["readFileSync", "writeFileSync", "mkdirSync", "mkdtempSync", "rmSync", "chmodSync", "realpathSync", "existsSync"]) {
    guarded[name] = (path, ...args) => { inside(path); return fsOriginal[name](path, ...args) }
  }
  guarded.existsSync = (path) => {
    if (resolve(String(path)) !== resolve(import.meta.dir, "../index.mjs")) inside(path)
    return fsOriginal.existsSync(path)
  }
  guarded.renameSync = (from, to) => { inside(from); inside(to); return fsOriginal.renameSync(from, to) }
  return guarded
})
const envKeys = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "TMPDIR", "TMP", "TEMP", "TRAE_HOME", "APPDATA", "LOCALAPPDATA"]
function isolate(dir) {
  process.env.TRAE_PRIVATE_APP_ID = "fixture-app-id"
  for (const key of envKeys) {
    process.env[key] = join(dir, key)
    mkdirSync(process.env[key], { recursive: true })
  }
}
isolate(root)
let caseRoot
beforeEach(() => {
  caseRoot = mkdtempSync(join(root, "case-"))
  isolate(caseRoot)
})
afterEach(() => {
  rmSync(caseRoot, { recursive: true, force: true })
  isolate(root)
})
for (const key of Object.keys(process.env)) {
  if (key.startsWith("TRAE_PRIVATE_")) delete process.env[key]
}
process.env.TRAE_PRIVATE_NO_AUTO_REFRESH = "1"
process.env.TRAE_PRIVATE_NO_LOGIN_BROWSER = "1"
const blocked = () => { throw new Error("Test isolation: explicitly inject a mock for external I/O") }
globalThis.fetch = blocked
globalThis.WebSocket = class { constructor() { blocked() } }
mock.module("node:os", () => ({
  homedir: () => process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME,
  tmpdir: () => process.env.TMPDIR,
}))
mock.module("node:child_process", () => ({ spawn: blocked, execFile: blocked }))
mock.module("node:net", () => ({ createServer: blocked, connect: blocked, createConnection: blocked }))
mock.module("node:http", () => ({ request: blocked, get: blocked, createServer: blocked }))
mock.module("node:https", () => ({ request: blocked, get: blocked }))
mock.module("node:tls", () => ({ connect: blocked }))
Bun.spawn = blocked
Bun.spawnSync = blocked
Bun.connect = blocked
Bun.listen = blocked
process.once("exit", () => rmSync(root, { recursive: true, force: true }))
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  rmSync(root, { recursive: true, force: true })
  process.exit(signal === "SIGINT" ? 130 : 143)
})

