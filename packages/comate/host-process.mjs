import { spawn } from "node:child_process"
import { accessSync, constants, existsSync } from "node:fs"
import { delimiter, resolve } from "node:path"
import { createInterface } from "node:readline"

export function findMagpieHost(env = process.env) {
  const candidates = [
    env.MAGPIE_HOST ? resolve(env.MAGPIE_HOST) : "",
    env.MAGPIE_CHECKOUT ? resolve(env.MAGPIE_CHECKOUT, "internal/plugin/host.js") : "",
  ].filter(Boolean)
  return candidates.find((path) => existsSync(path)) ?? ""
}

export const MAGPIE_HOST = findMagpieHost()

export function findBun(env = process.env) {
  const names = process.platform === "win32" ? ["bun.exe", "bun"] : ["bun"]
  const candidates = [env.MAGPIE_BUN, ...String(env.PATH ?? "").split(delimiter).flatMap((dir) => names.map((name) => resolve(dir, name)))].filter(Boolean)
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK)
      return path
    } catch {}
  }
  return ""
}

export class MagpieHost {
  constructor({ bun, host = MAGPIE_HOST, cwd, env = process.env, timeoutMs = 30_000 }) {
    if (!bun) throw new Error("Bun is required to run Magpie's production plugin host")
    if (!host || !existsSync(host)) {
      throw new Error("Magpie's production plugin host was not found; set MAGPIE_HOST or MAGPIE_CHECKOUT")
    }
    this.timeoutMs = timeoutMs
    this.nextID = 1
    this.pending = new Map()
    this.stderr = ""
    this.child = spawn(bun, ["run", host], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on("line", (line) => this.#message(line))
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-16_384)
    })
    this.child.on("error", (error) => this.#rejectAll(error))
    this.child.on("exit", (code, signal) => {
      if (this.pending.size) this.#rejectAll(new Error(`Magpie host exited (${code ?? signal}): ${this.stderr}`))
    })
    this.exited = new Promise((resolve) => this.child.once("exit", resolve))
  }

  #message(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    pending.receive(message)
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) pending.fail(error)
    this.pending.clear()
  }

  #request(method, params, receive) {
    const id = this.nextID++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Magpie host ${method} timed out after ${this.timeoutMs} ms: ${this.stderr}`))
      }, this.timeoutMs)
      const finish = (fn, value) => {
        clearTimeout(timer)
        this.pending.delete(id)
        fn(value)
      }
      this.pending.set(id, {
        receive: (message) => receive(message, (error, value) => finish(error ? reject : resolve, error ?? value)),
        fail: (error) => finish(reject, error),
      })
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
        if (error) finish(reject, error)
      })
    })
  }

  call(method, params = {}) {
    return this.#request(method, params, (message, done) => {
      if (message.error) return done(new Error(message.error.message || `${method} failed`))
      if (Object.hasOwn(message, "result")) return done(null, message.result)
    })
  }

  fetch(params) {
    let head = null
    return this.#request("fetch", params, (message, done) => {
      if (message.error) return done(new Error(message.error.message || "plugin fetch failed"))
      if (message.event === "head") {
        head = { status: message.status, headers: message.headers ?? {}, body: [] }
        return
      }
      if (message.event === "chunk") {
        if (!head) return done(new Error("plugin fetch sent a body chunk before its headers"))
        head.body.push(Buffer.from(message.data ?? "", "base64"))
        return
      }
      if (Object.hasOwn(message, "result")) {
        if (!head) return done(new Error("plugin fetch ended without response headers"))
        return done(null, {
          status: head.status,
          headers: head.headers,
          body: Buffer.concat(head.body),
        })
      }
    })
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.lines.close()
    this.child.stdin.end()
    await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 1_000))])
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM")
    await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 1_000))])
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL")
  }
}
