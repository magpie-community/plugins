import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = import.meta.dir
const script = join(dir, "bin", "agent-office.mjs")
// Other marketplace tests temporarily remove node from PATH. Resolve once
// and use an absolute executable; Bun-only machines still test the CLI.
const nodeExecutable = Bun.which("node") || ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"].find(existsSync)
const tmps = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agent-office-cli-")); tmps.push(d); return d }
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }) })

const SECRET = "SECRET-CLI-PROMPT"
function homeWithSession() {
  const h = tmp()
  const project = join(h, ".claude", "projects", "-tmp-cli-project")
  mkdirSync(project, { recursive: true })
  const timestamp = new Date().toISOString()
  writeFileSync(join(project, "s1.jsonl"), [
    JSON.stringify({ type: "user", sessionId: "s1", cwd: "/tmp/cli-project", timestamp, message: { role: "user", content: SECRET } }),
    JSON.stringify({ type: "assistant", sessionId: "s1", cwd: "/tmp/cli-project", timestamp, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }),
  ].join("\n"))
  return h
}

function envFor(home) {
  const cfg = tmp()
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: cfg, XDG_CACHE_HOME: join(home, ".cache") }
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "DSH_HOME", "PI_CODING_AGENT_DIR", "OMP_HOME", "OMP_CONFIG_DIR", "KIMI_CODE_HOME", "KIMI_CONFIG_DIR", "GROK_HOME", "GROK_CONFIG_DIR", "COPILOT_HOME", "COPILOT_CONFIG_DIR", "QODER_CONFIG_DIR", "QODERCN_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "MAGPIE_AGENT_OFFICE_PAGE", "WMAD_OMP_SESSIONS_DIR"]) delete env[k]
  return env
}

function run(args, home) {
  const r = Bun.spawnSync({ cmd: [process.execPath, script, ...args], cwd: dir, env: envFor(home), stdout: "pipe", stderr: "pipe" })
  expect(r.exitCode).toBe(0)
  return new TextDecoder().decode(r.stdout)
}

async function startServer(extra = []) {
  const proc = Bun.spawn({ cmd: [process.execPath, script, "--no-open", "--port", "0", "--hours", "1", ...extra], cwd: dir, env: envFor(homeWithSession()), stdout: "pipe", stderr: "pipe" })
  const reader = proc.stdout.getReader()
  let out = ""
  let timeout
  try {
    const url = await Promise.race([
      (async () => {
        while (true) {
          const r = await reader.read()
          if (r.done) throw new Error("CLI exited before printing URL: " + out + await new Response(proc.stderr).text())
          out += new TextDecoder().decode(r.value)
          const match = out.match(/http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\//)
          if (match) return match[0]
        }
      })(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("CLI startup timed out: " + out)), 8000) }),
    ])
    return { url, origin: new URL(url).origin, proc, stop: async () => { proc.kill(); await proc.exited; reader.releaseLock() } }
  } catch (err) {
    proc.kill()
    await proc.exited
    throw err
  } finally { clearTimeout(timeout) }
}

function post(server, value, headers = {}) {
  return fetch(server.url + "api/options", { method: "POST", headers: { origin: server.origin, "content-type": "application/json", ...headers }, body: JSON.stringify(value) })
}

// Use raw HTTP so the client cannot normalize a forged Host into a safe one.
function rawGet(server, host, path = new URL(server.url).pathname + "api/sessions") {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: new URL(server.url).port, path, headers: { Host: host } }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => { body += chunk })
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on("error", reject)
    req.end()
  })
}

test("--json prints the same snapshot and honours --private", () => {
  const h = homeWithSession()
  const snap = JSON.parse(run(["--json", "--hours", "1"], h))
  expect(snap.text).toBe(true)
  expect(snap.sessions.length).toBe(1)
  expect(snap.sessions[0].project).toBe("cli-project")
  expect(snap.sessions[0].title).toBe(SECRET)
  expect(snap.sessions[0].query).toBe(SECRET)

  const priv = JSON.parse(run(["--json", "--hours", "1", "--private"], h))
  expect(priv.text).toBe(false)
  expect(priv.sessions[0].query).toBe("")
  expect(priv.sessions[0].messages).toEqual([])
  expect(JSON.stringify(priv)).not.toContain(SECRET)
})

test("the authenticated standalone page, bridge, live data and JSON options work", async () => {
  const s = await startServer()
  try {
    const ping = await (await fetch(s.url + "api/ping")).json()
    expect(ping.name).toBe("agent-office")
    expect(ping.version).toBe("0.2.0")
    const page = await fetch(s.url)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('src="_magpie/bridge.js"')
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'")
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    expect(page.headers.get("referrer-policy")).toBe("no-referrer")
    expect(await (await fetch(s.url + "app.js")).text()).toContain("live.js?t=")
    const bridge = await (await fetch(s.url + "_magpie/bridge.js")).text()
    expect(bridge).toContain(new URL(s.url).pathname + "api/options")
    expect(bridge).toContain('"Content-Type": "application/json"')
    const live = await fetch(s.url + "live.js?t=123")
    expect(live.headers.get("cross-origin-resource-policy")).toBe("same-origin")
    expect(live.headers.get("cache-control")).toBe("no-store")
    expect(await live.text()).toContain(SECRET)
    expect((await (await fetch(s.url + "api/sessions")).json()).sessions[0].query).toBe(SECRET)
    const updated = await post(s, { text: false, scanner: { days: 0 }, __proto__: null })
    expect(updated.status).toBe(200)
    expect((await updated.json()).text).toBe(false)
    expect((await (await fetch(s.url + "api/options")).json()).scanner.days).toBe(1 / 24)
    expect(await (await fetch(s.url + "live.js")).text()).not.toContain(SECRET)
    expect(JSON.stringify(await (await fetch(s.url + "api/sessions")).json())).not.toContain(SECRET)
  } finally { await s.stop() }
})

test("fixed public URLs and guessed tokens cannot expose sessions or the bridge", async () => {
  const s = await startServer()
  try {
    for (const path of ["/", "/live.js", "/api/sessions", "/api/options", "/_magpie/bridge.js", "/" + "0".repeat(64) + "/live.js"]) {
      const res = await fetch(s.origin + path)
      expect(res.status).toBe(404)
      const body = await res.text()
      expect(body).not.toContain(SECRET)
      expect(body).not.toContain(new URL(s.url).pathname)
    }
    const other = await startServer()
    try {
      expect(new URL(other.url).pathname).not.toBe(new URL(s.url).pathname)
      expect((await fetch(other.origin + new URL(s.url).pathname + "live.js")).status).toBe(404)
    } finally { await other.stop() }
  } finally { await s.stop() }
})

test("hostile no-cors POST cannot enable text before a cross-origin live script load", async () => {
  const s = await startServer(["--private"])
  try {
    // The original exploit targets fixed URLs, without a JSON content type.
    expect((await fetch(s.origin + "/api/options", { method: "POST", headers: { origin: "https://evil.example", "content-type": "text/plain" }, body: '{"text":true}' })).status).toBe(404)
    // Defense in depth: even knowledge of the capability cannot bypass Origin.
    for (const origin of ["https://evil.example", "null", "http://127.0.0.1:1", s.origin + ".evil.example"]) {
      expect((await post(s, { text: true }, { origin })).status).toBe(403)
    }
    expect((await fetch(s.url + "api/options", { method: "POST", headers: { "content-type": "application/json" }, body: '{"text":true}' })).status).toBe(403)
    const script = await fetch(s.url + "live.js", { headers: { "sec-fetch-site": "cross-site" } })
    expect(script.status).toBe(403)
    expect(await script.text()).not.toContain(SECRET)
    expect((await fetch(s.origin + "/live.js")).status).toBe(404)
    const snap = await (await fetch(s.url + "api/sessions")).json()
    expect(snap.text).toBe(false)
    expect(JSON.stringify(snap)).not.toContain(SECRET)
    // A legitimate same-origin request still enables text.
    expect((await post(s, { text: true })).status).toBe(200)
    expect(await (await fetch(s.url + "live.js")).text()).toContain(SECRET)
  } finally { await s.stop() }
})

test("options POST requires JSON and validates payloads without changing privacy", async () => {
  const s = await startServer(["--private"])
  try {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      expect((await post(s, { text: true }, { "content-type": type })).status).toBe(415)
    }
    expect((await fetch(s.url + "api/options", { method: "POST", headers: { origin: s.origin }, body: '{"text":true}' })).status).toBe(415)
    expect((await fetch(s.url + "api/options", { method: "POST", headers: { origin: s.origin, "content-type": "application/json" }, body: "{" })).status).toBe(400)
    for (const payload of [null, [], "text", { text: "true" }, { remote: 1 }]) expect((await post(s, payload)).status).toBe(400)
    expect((await fetch(s.url + "api/options", { method: "PUT" })).status).toBe(405)
    expect((await (await fetch(s.url + "api/options")).json()).text).toBe(false)
    expect(await (await fetch(s.url + "live.js")).text()).not.toContain(SECRET)
    expect((await post(s, { text: true }, { "content-type": "application/json; charset=utf-8" })).status).toBe(200)
  } finally { await s.stop() }
})

test("DNS rebinding Host headers are rejected and never enter CSP", async () => {
  const s = await startServer()
  try {
    const port = new URL(s.url).port
    for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1:${Number(port) + 1}`, `localhost:${Number(port) + 1}`, `127.0.0.1.evil.example:${port}`, `127.0.0.2:${port}`]) {
      const res = await rawGet(s, host)
      expect(res.status).toBe(403)
      expect(res.body).not.toContain(SECRET)
      expect(res.headers["content-security-policy"]).toContain("script-src 'self'")
      expect(res.headers["content-security-policy"]).not.toContain(host)
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const res = await rawGet(s, host)
      expect(res.status).toBe(200)
      expect(res.body).toContain(SECRET)
    }
  } finally { await s.stop() }
})

test("an occupied port fails clearly; help and executable require Bun", async () => {
  const s = await startServer()
  try {
    const second = Bun.spawn({ cmd: [process.execPath, script, "--no-open", "--port", new URL(s.url).port], cwd: dir, env: envFor(homeWithSession()), stdout: "pipe", stderr: "pipe" })
    expect(await second.exited).toBe(1)
    expect(await new Response(second.stderr).text()).toContain("Use --port 0 or another port")
    expect((await fetch(s.url + "api/ping")).status).toBe(200)
    expect(readFileSync(script, "utf8").split("\n")[0]).toBe("#!/usr/bin/env bun")
    const help = Bun.spawnSync({ cmd: [process.execPath, script, "--help"], cwd: dir })
    expect(new TextDecoder().decode(help.stderr)).toContain("Requires Bun 1.2+")
    expect(new TextDecoder().decode(help.stderr)).not.toContain("next free one")
    if (nodeExecutable) {
      const node = Bun.spawnSync({ cmd: [nodeExecutable, script, "--no-open"], cwd: dir, env: envFor(homeWithSession()) })
      expect(node.exitCode).toBe(1)
      expect(new TextDecoder().decode(node.stderr)).toContain("requires Bun 1.2+")
      expect(new TextDecoder().decode(node.stderr)).not.toContain("ReferenceError")
    }
  } finally { await s.stop() }
})
