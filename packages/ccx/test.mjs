import { createServer } from "node:http"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"

export async function serve(router) {
  const server = createServer(async (req, res) => {
    const body = []
    for await (const b of req) body.push(b)
    try { await router(req, res, Buffer.concat(body).toString()) } catch (e) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: String(e) }))
    }
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

export function html(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ccx fixture</title></head><body>${body}</body></html>`
}

export function json(res, value, status = 200, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers })
  res.end(JSON.stringify(value))
}

export function text(res, value, status = 200) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" })
  res.end(value)
}

export function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

export async function rpc(bun, script, input, { timeoutMs = 90000 } = {}) {
  const child = spawn(bun, [script], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, BUN_BE_BUN: "1" } })
  let output = ""
  let errors = ""
  const lines = []
  let buffer = ""
  const waiters = []
  child.stdout.on("data", (chunk) => {
    output += chunk
    buffer += chunk
    for (;;) {
      const end = buffer.indexOf("\n")
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      try { lines.push(JSON.parse(line)) } catch {}
      for (const w of [...waiters]) {
        if (lines.some(w.match)) {
          clearTimeout(w.timer)
          waiters.splice(waiters.indexOf(w), 1)
          w.resolve(lines.find(w.match))
        }
      }
    }
  })
  child.stderr.on("data", (chunk) => { errors += chunk })
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n")
  const next = (match) => {
    const found = lines.find(match)
    if (found) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const w = { match, resolve, timer: null }
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w)
        if (i >= 0) waiters.splice(i, 1)
        reject(new Error(`RPC timeout. stdout=${output}\nstderr=${errors}`))
      }, timeoutMs)
      waiters.push(w)
    })
  }
  const call = async (id, method, params) => {
    send({ id, method, params })
    const answer = await next((x) => x.id === id && (x.result !== undefined || x.error))
    if (answer.error) throw new Error(answer.error.message)
    return answer.result
  }
  const stop = async () => {
    child.stdin.end()
    await Promise.race([new Promise((r) => child.once("exit", r)), delay(5000)])
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
  }
  return { child, send, next, call, stop, output: () => output, errors: () => errors }
}

export async function tempRoot(prefix = "ccx-test-") {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function removeTempRoot(path) {
  if (!path.startsWith(join(tmpdir(), "ccx-test-"))) throw new Error("not a test root")
  await rm(path, { recursive: true, force: true, maxRetries: 4 })
}
