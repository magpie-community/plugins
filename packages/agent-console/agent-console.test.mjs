// What the repository's root `bun test` checks for Agent Console, with no npm
// install: the package's shape and dependency split, that the magpie page reads
// nothing and reaches no network but its own navigation, that the bundles load
// only declared packages, and the gate's Origin/Host/key rules. The full suite
// (daemon, lifeline, PR #535 HTTP probes, terminal fallback) is vitest with npm
// dependencies: `npm ci --workspaces=false && npm test` in this folder; the root
// bunfig.toml keeps `bun test` out of it.
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { request } from "node:http"
import { createServer } from "node:net"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const dir = import.meta.dir
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
const read = (f) => readFileSync(join(dir, f), "utf8")

const RUNTIME = ["@agentclientprotocol/sdk", "ignore", "ws", "zod"]
const BUNDLED = ["@tanstack/react-virtual", "@xterm/addon-fit", "@xterm/xterm", "clsx", "dompurify", "highlight.js", "lucide-react", "marked", "react", "react-dom", "zustand"]

test("package.json: name, page, permissions and files", () => {
  expect(pkg.name).toBe("@magpie-community/page-agent-console")
  expect(pkg.type).toBe("module")
  expect(pkg.main).toBe("./index.mjs")
  expect(pkg.magpie.page.title).toBe("Agent Console")
  for (const f of [pkg.magpie.page.file, pkg.magpie.page.icon]) expect(existsSync(join(dir, f))).toBe(true)
  expect(pkg.magpie.icon.startsWith("data:image/svg+xml;base64,")).toBe(true)
  // the page makes no magpie.read
  expect(pkg.magpie.permissions).toEqual([])
  // the tarball: no tests, no sources, never the per-run session.js
  expect(pkg.files).not.toContain("page")
  expect(pkg.files).toContain("page/index.html")
  expect(pkg.files).toContain("page/boot.js")
  for (const f of pkg.files) expect(f.startsWith("test") || f.startsWith("web") || f === "daemon/src").toBe(false)
})

test("dependencies: only what runs, every version pinned, lockfile in step", () => {
  expect(Object.keys(pkg.dependencies).sort()).toEqual(RUNTIME)
  expect(Object.keys(pkg.optionalDependencies)).toEqual(["node-pty"])
  for (const name of BUNDLED) expect(pkg.devDependencies[name]).toBeDefined()
  const lock = JSON.parse(read("package-lock.json"))
  expect(lock.name).toBe(pkg.name)
  expect(lock.version).toBe(pkg.version)
  for (const kind of ["dependencies", "optionalDependencies", "devDependencies"]) {
    for (const [name, version] of Object.entries(pkg[kind])) {
      expect(version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/)
      expect(lock.packages[`node_modules/${name}`]?.version).toBe(version)
      expect(lock.packages[""][kind][name]).toBe(version)
    }
  }
  for (const name of BUNDLED) expect(lock.packages[`node_modules/${name}`].dev).toBe(true)
  // Claude Code is the user's own claude CLI: no Anthropic package is installed, locked or bundled
  const named = [...Object.keys(lock.packages), ...["dependencies", "optionalDependencies", "devDependencies"].flatMap((k) => Object.keys(pkg[k] ?? {}))]
  expect(named.filter((n) => n.includes("@anthropic-ai/"))).toEqual([])
  // (the one @anthropic-ai/ name left in the bundle is the install hint for the user's own claude)
  expect(read("daemon/dist/main.js").match(/@anthropic-ai\/[\w-]+/g)?.filter((n) => n !== "@anthropic-ai/claude-code") ?? []).toEqual([])
})

test("the daemon bundle and the host part import only builtins and declared packages", () => {
  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))
  const allowed = new Set([...RUNTIME, "node-pty"])
  const specs = (src) => [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"'./][^"']*)["']/g)].map((m) => m[1])
  const sources = ["daemon/dist/main.js", "index.mjs", "lib/gate.mjs", "lib/pathscan.mjs"].map(read)
  const seen = new Set(sources.flatMap(specs))
  expect(seen.size).toBeGreaterThan(5)
  for (const s of seen) {
    const name = s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]
    if (!builtins.has(s)) expect(allowed.has(name) ? name : `undeclared ${s}`).toBe(name)
  }
  // the UI packages are inside app/app.js, never loaded from node_modules
  for (const name of BUNDLED) expect(seen.has(name)).toBe(false)
  // node-pty is loaded lazily, so a missing or broken binary can only cost the terminal
  expect(read("daemon/dist/main.js")).not.toMatch(/from\s*["']node-pty["']/)
})

test("the page reads nothing from magpie and reaches no network", () => {
  const html = read("page/index.html")
  // the code, without its comments (they name the gate's URL)
  const boot = read("page/boot.js").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*.*?\*\//g, "")
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1])
  expect(scripts).toEqual(["_magpie/bridge.js", "session.js", "boot.js"])
  expect(html).not.toMatch(/<script(?![^>]*src=)[^>]*>/)
  expect(html).not.toMatch(/https?:\/\//)
  expect(boot).not.toMatch(/magpie\??\.read\s*\(/)
  expect(boot).not.toMatch(/\.options\??\.(get|set)\b/)
  for (const api of ["fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "importScripts"]) expect(boot.includes(api)).toBe(false)
  // its one way out: navigating its own frame to the gate on 127.0.0.1
  expect([...boot.matchAll(/https?:\/\/[^"'`]+/g)].map((m) => m[0])).toEqual(["http://127.0.0.1:"])
  expect(boot).toContain('location.replace("http://127.0.0.1:" + session.port + "/open?"')
})

test("the host part is an OpenCode v1 server, as magpie loads a page's host part", async () => {
  const mod = await import(pathToFileURL(join(dir, "index.mjs")).href)
  expect(mod.default.id).toBe("agent-console")
  expect(typeof mod.default.server).toBe("function")
})

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

const get = (port, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = ""
      res.on("data", (c) => (body += c))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    r.on("error", reject)
    r.end()
  })

test("the gate: Host checked, any Origin refused, the token only in the # fragment", async () => {
  const { createGate } = await import(pathToFileURL(join(dir, "lib", "gate.mjs")).href)
  const port = await freePort()
  const key = "c".repeat(64)
  const token = "a".repeat(64)
  let opened = 0
  const gate = createGate({ port, key, token, ensureDaemon: async () => (opened++, { port: 45678 }) })
  await gate.listen()
  try {
    expect((await get(port, `/open?k=${key}`, { host: `evil.example:${port}` })).status).toBe(421)
    expect((await get(port, `/open?k=${key}`, { origin: "null" })).status).toBe(403)
    expect((await get(port, `/open?k=${key}`, { origin: "https://evil.example" })).status).toBe(403)
    expect((await get(port, "/open?k=wrong")).status).toBe(403)
    expect((await get(port, `/open?k=${token}`)).status).toBe(403)
    expect(opened).toBe(0)
    const ok = await get(port, `/open?k=${key}&theme=dark`)
    expect(ok.status).toBe(302)
    expect(ok.headers.location).toBe(`http://127.0.0.1:45678/?theme=dark#t=${token}`)
    expect(ok.headers["access-control-allow-origin"]).toBeUndefined()
    expect(ok.body).not.toContain(token)
  } finally {
    await gate.close()
  }
})
