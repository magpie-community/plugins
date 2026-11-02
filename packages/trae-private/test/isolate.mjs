// 子进程在导入插件前安装隔离；只允许临时目录和显式模拟的 I/O。
import fs from "node:fs"
import fsp from "node:fs/promises"
import childProcess from "node:child_process"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import http2 from "node:http2"
import { syncBuiltinESMExports } from "node:module"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(process.env.TRAE_TEST_ROOT || "")
if (!process.env.TRAE_TEST_ROOT || root === resolve(homedir()) || root === resolve(tmpdir())) {
  throw new Error("测试必须由 index.test.mjs 在专用临时目录启动")
}
const original = { ...fs }
const codeDir = resolve(fileURLToPath(new URL("..", import.meta.url)))
const codeFiles = new Set(["index.mjs", "test/cases.mjs", "test/isolate.mjs"].map((name) => resolve(codeDir, name)))
const isCode = (path) => codeFiles.has(resolve(path instanceof URL ? fileURLToPath(path) : String(path)))
const roots = [root, original.realpathSync(root)]
function inside(path) {
  const full = resolve(path instanceof URL ? fileURLToPath(path) : String(path))
  if (!roots.some((dir) => {
    const rel = relative(dir, full)
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  })) throw new Error("Test isolation: file access outside owned temporary root")
}
for (const name of ["readFileSync", "writeFileSync", "mkdirSync", "mkdtempSync", "rmSync", "readdirSync", "statSync", "chmodSync", "existsSync"]) {
  fs[name] = (path, ...args) => {
    if (name !== "readFileSync" || !isCode(path)) inside(path)
    return original[name](path, ...args)
  }
}
for (const name of ["readFile", "writeFile", "mkdir", "mkdtemp", "rm", "readdir", "stat", "chmod", "open"]) {
  const fn = fsp[name].bind(fsp)
  fsp[name] = async (path, ...args) => {
    if (name !== "readFile" || !isCode(path)) inside(path)
    return fn(path, ...args)
  }
}
fs.renameSync = (from, to) => { inside(from); inside(to); return original.renameSync(from, to) }
const blocked = () => { throw new Error("Test isolation: explicitly mock external I/O") }
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[name] = blocked
for (const mod of [http, https]) for (const name of ["request", "get"]) mod[name] = blocked
for (const name of ["connect", "createConnection"]) {
  const connect = net[name]
  net[name] = (...args) => {
    const host = typeof args[0] === "object" ? args[0]?.host : args[1]
    if (host !== "127.0.0.1") blocked()
    return connect(...args)
  }
}
tls.connect = blocked
http2.connect = blocked
const listen = net.Server.prototype.listen
net.Server.prototype.listen = function (...args) {
  const options = args[0]
  const host = typeof options === "object" ? options?.host : args[1]
  if (host !== "127.0.0.1") blocked()
  return listen.apply(this, args)
}
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || init?.redirect === "follow") blocked()
  return realFetch(input, { ...init, redirect: "error" })
}
globalThis.WebSocket = class { constructor() { blocked() } }
syncBuiltinESMExports()
