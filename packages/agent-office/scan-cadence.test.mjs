// The host used to readdir+stat every session directory on every 1.5s tick
// (plugins#1374). A quiet tick must not walk cold trees. New files, writes
// to files already in the window, deletions, and time-based phases still
// show up. A content write does not bump the parent directory mtime (NTFS,
// and APFS/ext4 too); those files are re-statted when they are already
// known, and a periodic discovery walk finds one that was cold.
import { afterAll, expect, test } from "bun:test"
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createScanner } from "./lib/scan.mjs"

const roots = []
const tmp = () => { const root = mkdtempSync(join(tmpdir(), "office-cadence-")); roots.push(root); return root }
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

const line = (x) => JSON.stringify(x) + "\n"
const stamp = (ms) => new Date(ms).toISOString()
const user = (text, ms) => ({ type: "user", timestamp: stamp(ms), cwd: "/fixture", message: { role: "user", content: text } })
const done = (ms, id = "r1") => ({ type: "assistant", timestamp: stamp(ms), message: { id, role: "assistant", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: "text", text: "done" }] } })

function claudeSource(root, extra = {}) {
  return { root, kind: "claude", agent: "claude", depth: 1, match: (n) => n.endsWith(".jsonl"), ...extra }
}

function counting(root, extra = {}) {
  const reads = []
  const stats = []
  const scanner = createScanner({
    sources: [claudeSource(root)],
    days: 2,
    discoverEvery: extra.discoverEvery ?? 1e12,
    watch: extra.watch ?? false,
    readdirSync(path, opts) { reads.push(path); return readdirSync(path, opts) },
    scanStat(path) { stats.push(path); return statSync(path) },
    ...extra.scanner,
  })
  return {
    scanner,
    reads,
    stats,
  }
}

function seed(root, now) {
  const hotDir = join(root, "hot")
  const hot = join(hotDir, "live.jsonl")
  mkdirSync(hotDir, { recursive: true })
  writeFileSync(hot, line(user("live work", now - 4000)) + line(done(now - 3000)))
  utimesSync(hot, (now - 3000) / 1000, (now - 3000) / 1000)
  const coldFiles = []
  const age = (now - 20 * 86400e3) / 1000
  for (let i = 0; i < 12; i++) {
    const dir = join(root, `cold-${i}`)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "old.jsonl")
    writeFileSync(file, line(user(`old ${i}`, now - 20 * 86400e3)))
    utimesSync(file, age, age)
    utimesSync(dir, age, age)
    coldFiles.push(file)
  }
  return { hot, coldFiles }
}

test("a quiet tick does not readdir cold session directories or stat their files", () => {
  const now = Date.now()
  const root = tmp()
  const { hot } = seed(root, now)
  const { scanner, reads, stats } = counting(root)
  const first = scanner.scan(now)
  expect(first.map((s) => s.query)).toEqual(["live work"])
  expect(reads.filter((p) => p.split(/[\\/]/).some((part) => part.startsWith("cold-"))).length).toBe(12)
  reads.length = 0
  stats.length = 0
  expect(scanner.scan(now + 1500).map((s) => s.query)).toEqual(["live work"])
  expect(reads).toEqual([])
  const coldStats = stats.filter((p) => p.split(/[\\/]/).some((part) => part.startsWith("cold-")) && p.endsWith(".jsonl"))
  expect(coldStats).toEqual([])
  expect(stats).toContain(hot)
})

test("a new file, a deleted file, and an append to a known file show up without a full walk", () => {
  const now = Date.now()
  const root = tmp()
  const { hot, coldFiles } = seed(root, now)
  const { scanner, reads } = counting(root)
  expect(scanner.scan(now)).toHaveLength(1)
  reads.length = 0
  appendFileSync(hot, line(user("still going", now)))
  const appended = scanner.scan(now + 1000)
  expect(appended.map((s) => s.query)).toEqual(["still going"])
  expect(reads.filter((p) => p.split(/[\\/]/).some((part) => part.startsWith("cold-")))).toEqual([])

  const createdDir = join(root, "cold-0")
  const created = join(createdDir, "brand.jsonl")
  writeFileSync(created, line(user("brand new", now)))
  reads.length = 0
  const withNew = scanner.scan(now + 1200)
  expect(withNew.map((s) => s.query).sort()).toEqual(["brand new", "still going"])
  expect(reads).toContain(createdDir)
  expect(reads.filter((p) => p.split(/[\\/]/).includes("cold-1"))).toEqual([])

  unlinkSync(hot)
  reads.length = 0
  expect(scanner.scan(now + 1400).map((s) => s.query)).toEqual(["brand new"])
  expect(coldFiles.length).toBe(12)
})

test("a nested directory that appears later is found, and untouched old branches are not listed", () => {
  const now = Date.now()
  const root = tmp()
  const oldDay = join(root, "2024", "01", "01")
  const today = join(root, "2026", "11", "20")
  mkdirSync(oldDay, { recursive: true })
  mkdirSync(today, { recursive: true })
  const codex = (id, text, ms) => [
    line({ timestamp: stamp(ms), type: "session_meta", payload: { id, cwd: "/fixture", timestamp: stamp(ms) } }),
    line({ timestamp: stamp(ms), type: "event_msg", payload: { type: "user_message", message: text } }),
  ].join("")
  const oldFile = join(oldDay, "rollout-old.jsonl")
  const live = join(today, "rollout-live.jsonl")
  const age = (now - 30 * 86400e3) / 1000
  writeFileSync(oldFile, codex("old", "ancient", now - 30 * 86400e3))
  writeFileSync(live, codex("live", "today", now - 2000))
  utimesSync(oldFile, age, age)
  for (const dir of [oldDay, join(root, "2024", "01"), join(root, "2024")]) utimesSync(dir, age, age)
  const reads = []
  const scanner = createScanner({
    sources: [{ root, kind: "codex", agent: "codex", depth: 3, match: (n) => n.startsWith("rollout-") && n.endsWith(".jsonl") }],
    days: 2,
    discoverEvery: 1e12,
    watch: false,
    readdirSync(path, opts) { reads.push(path); return readdirSync(path, opts) },
  })
  expect(scanner.scan(now).map((s) => s.query)).toEqual(["today"])
  reads.length = 0
  const nextDay = join(root, "2026", "11", "21")
  mkdirSync(nextDay)
  writeFileSync(join(nextDay, "rollout-next.jsonl"), codex("next", "tomorrow", now))
  const got = scanner.scan(now + 1500)
  expect(got.map((s) => s.query).sort()).toEqual(["today", "tomorrow"])
  expect(reads.some((p) => p.split(/[\\/]/).includes("2024"))).toBe(false)
  expect(reads.some((p) => p.endsWith(join("2026", "11")))).toBe(true)
})

test("a content write on a cold file does not show up until the discovery walk, because the parent mtime stays put", () => {
  const now = Date.now()
  const root = tmp()
  const { coldFiles } = seed(root, now)
  const { scanner, reads } = counting(root, { discoverEvery: 10_000 })
  expect(scanner.scan(now).map((s) => s.query)).toEqual(["live work"])
  const cold = coldFiles[3]
  const parent = join(cold, "..")
  const dirBefore = statSync(parent).mtimeMs
  appendFileSync(cold, line(user("woken", now)))
  expect(statSync(parent).mtimeMs).toBe(dirBefore)
  reads.length = 0
  expect(scanner.scan(now + 1500).some((s) => s.query === "woken")).toBe(false)
  expect(reads.filter((p) => p.split(/[\\/]/).some((part) => part.startsWith("cold-")))).toEqual([])
  const found = scanner.scan(now + 10_000)
  expect(found.some((s) => s.query === "woken")).toBe(true)
})

test("a watched append stats the active file and not the cold files beside it, and a new file there is still found", () => {
  const now = Date.now()
  const root = tmp()
  const dir = join(root, "proj")
  mkdirSync(dir, { recursive: true })
  const active = join(dir, "live.jsonl")
  writeFileSync(active, line(user("live work", now - 4000)) + line(done(now - 3000)))
  utimesSync(active, (now - 3000) / 1000, (now - 3000) / 1000)
  const cold = []
  const age = (now - 20 * 86400e3) / 1000
  for (let i = 0; i < 8; i++) {
    const file = join(dir, `old-${i}.jsonl`)
    writeFileSync(file, line(user(`old ${i}`, now - 20 * 86400e3)))
    utimesSync(file, age, age)
    cold.push(file)
  }
  let listener = null
  const stats = []
  const scanner = createScanner({
    sources: [claudeSource(root)],
    days: 2,
    discoverEvery: 1e12,
    watch(watched, opts, cb) {
      expect(watched).toBe(root)
      expect(opts.recursive).toBe(true)
      listener = cb
      return { on() {}, unref() {}, close() { listener = null } }
    },
    scanStat(path) { stats.push(path); return statSync(path) },
  })
  expect(scanner.scan(now).map((s) => s.query)).toEqual(["live work"])
  const coldStats = () => stats.filter((p) => cold.includes(p))

  stats.length = 0
  appendFileSync(active, line(user("still going", now)))
  listener("change", join("proj", "live.jsonl"))
  expect(scanner.scan(now + 1500).map((s) => s.query)).toEqual(["still going"])
  expect(coldStats()).toEqual([])
  expect(stats).toContain(active)

  stats.length = 0
  appendFileSync(active, line(user("again", now + 1500)))
  listener("change", join("proj", "live.jsonl"))
  expect(scanner.scan(now + 3000).map((s) => s.query)).toEqual(["again"])
  expect(coldStats()).toEqual([])

  const created = join(dir, "brand.jsonl")
  writeFileSync(created, line(user("brand new", now + 3000)))
  listener("change", join("proj", "brand.jsonl"))
  expect(scanner.scan(now + 4500).map((s) => s.query).sort()).toEqual(["again", "brand new"])
  scanner.close()
  expect(listener).toBe(null)
})

test("a healthy watcher finds a new directory on the discovery tick without restatting cold files", () => {
  const now = Date.now()
  const root = tmp()
  const { coldFiles } = seed(root, now)
  let listener = null
  const stats = []
  const scanner = createScanner({
    sources: [claudeSource(root)],
    days: 2,
    discoverEvery: 15_000,
    watch(watched, opts, cb) {
      expect(watched).toBe(root)
      expect(opts.recursive).toBe(true)
      listener = cb
      return { on() {}, unref() {}, close() { listener = null } }
    },
    scanStat(path) { stats.push(path); return statSync(path) },
  })
  expect(scanner.scan(now).map((s) => s.query)).toEqual(["live work"])
  stats.length = 0
  expect(scanner.scan(now + 15_000).map((s) => s.query)).toEqual(["live work"])
  expect(stats.filter((p) => coldFiles.includes(p))).toEqual([])
  expect(listener).toEqual(expect.any(Function))

  const createdDir = join(root, "fresh")
  mkdirSync(createdDir)
  writeFileSync(join(createdDir, "new.jsonl"), line(user("appeared", now + 15_000)))
  stats.length = 0
  // The watch event for this create is dropped. The discovery tick still
  // has to notice the new directory from its parent's stamp.
  const found = scanner.scan(now + 30_000)
  expect(found.map((s) => s.query).sort()).toEqual(["appeared", "live work"])
  expect(stats.filter((p) => coldFiles.includes(p))).toEqual([])
  scanner.close()
})

test("a watcher is unref'd, and after it errors discovery still finds new and cold files", () => {
  const now = Date.now()
  const root = tmp()
  const { coldFiles } = seed(root, now)
  const handle = { unrefs: 0, onError: null, closed: false }
  let listener = null
  const scanner = createScanner({
    sources: [claudeSource(root)],
    days: 2,
    discoverEvery: 15_000,
    watch(watched, opts, cb) {
      expect(watched).toBe(root)
      expect(opts.recursive).toBe(true)
      listener = cb
      return {
        on(event, fn) { if (event === "error") handle.onError = fn },
        unref() { handle.unrefs++ },
        close() { handle.closed = true; listener = null },
      }
    },
  })
  expect(scanner.scan(now).map((s) => s.query)).toEqual(["live work"])
  expect(handle.unrefs).toBe(1)
  expect(typeof handle.onError).toBe("function")
  handle.onError(new Error("emfile"))
  expect(handle.closed).toBe(true)
  expect(listener).toBe(null)

  const createdDir = join(root, "fresh")
  mkdirSync(createdDir)
  writeFileSync(join(createdDir, "new.jsonl"), line(user("after error", now)))
  expect(scanner.scan(now + 1500).map((s) => s.query).sort()).toEqual(["after error", "live work"])

  const cold = coldFiles[2]
  appendFileSync(cold, line(user("woken", now + 1500)))
  expect(scanner.scan(now + 3000).some((s) => s.query === "woken")).toBe(false)
  expect(scanner.scan(now + 15_000).some((s) => s.query === "woken")).toBe(true)
  scanner.close()
})

test("a watch event names a cold file whose directory mtime did not move", () => {
  const now = Date.now()
  const root = tmp()
  const { coldFiles } = seed(root, now)
  let listener = null
  const watched = []
  const reads = []
  const scanner = createScanner({
    sources: [claudeSource(root)],
    days: 2,
    discoverEvery: 1e12,
    watch(dir, opts, cb) {
      watched.push(dir)
      expect(opts.recursive).toBe(true)
      listener = cb
      return { close() { listener = null }, unref() {} }
    },
    readdirSync(path, opts) { reads.push(path); return readdirSync(path, opts) },
  })
  expect(scanner.scan(now).map((s) => s.query)).toEqual(["live work"])
  expect(watched).toEqual([root])
  const cold = coldFiles[4]
  appendFileSync(cold, line(user("watched wake", now)))
  expect(typeof listener).toBe("function")
  reads.length = 0
  listener("change", join("cold-4", "old.jsonl"))
  const got = scanner.scan(now + 1500)
  expect(got.some((s) => s.query === "watched wake")).toBe(true)
  expect(reads.filter((p) => p.split(/[\\/]/).includes("cold-0"))).toEqual([])
  scanner.close()
  expect(listener).toBe(null)
})

test("cursor quiets to done on a later tick without walking cold directories", () => {
  const now = Date.now()
  const root = tmp()
  const active = join(root, "active")
  mkdirSync(active, { recursive: true })
  const chat = join(active, "c1.jsonl")
  writeFileSync(chat, [
    JSON.stringify({ role: "user", message: { role: "user", content: [{ type: "text", text: "Say ok." }] } }),
    JSON.stringify({ role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
  ].join("\n") + "\n")
  utimesSync(chat, (now - 5000) / 1000, (now - 5000) / 1000)
  for (let i = 0; i < 6; i++) {
    const dir = join(root, `cold-${i}`)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "old.jsonl")
    writeFileSync(file, JSON.stringify({ role: "user", message: { role: "user", content: [{ type: "text", text: "old" }] } }) + "\n")
    utimesSync(file, (now - 10 * 86400e3) / 1000, (now - 10 * 86400e3) / 1000)
  }
  const reads = []
  const scanner = createScanner({
    sources: [{ root, kind: "cursor", agent: "cursor-app", depth: 1, match: (n) => n.endsWith(".jsonl") }],
    days: 2,
    discoverEvery: 1e12,
    watch: false,
    readdirSync(path, opts) { reads.push(path); return readdirSync(path, opts) },
  })
  expect(scanner.scan(now)[0]).toMatchObject({ agent: "cursor-app", phase: "thinking", query: "Say ok." })
  expect(reads.filter((p) => p.split(/[\\/]/).some((part) => part.startsWith("cold-"))).length).toBe(6)
  reads.length = 0
  expect(scanner.scan(now + 30_000)[0]).toMatchObject({ phase: "done", query: "Say ok." })
  expect(reads).toEqual([])
})

test("a Claude session whose process disappeared is aborted on the next tick without a cold walk", () => {
  const now = Date.now()
  const root = tmp()
  const project = join(root, "projects", "app")
  const sessions = join(root, "sessions")
  mkdirSync(project, { recursive: true })
  mkdirSync(sessions, { recursive: true })
  const id = "11111111-2222-4333-8444-555555555555"
  const file = join(project, id + ".jsonl")
  writeFileSync(file, line(user("mid turn", now - 60e3)))
  utimesSync(file, (now - 60e3) / 1000, (now - 60e3) / 1000)
  writeFileSync(join(sessions, process.pid + ".json"), JSON.stringify({ pid: process.pid, sessionId: id, pidDomain: process.platform }))
  for (let i = 0; i < 4; i++) {
    const dir = join(root, "projects", `cold${i}`)
    mkdirSync(dir, { recursive: true })
    const old = join(dir, "old.jsonl")
    writeFileSync(old, line(user("old", now - 15 * 86400e3)))
    utimesSync(old, (now - 15 * 86400e3) / 1000, (now - 15 * 86400e3) / 1000)
  }
  const reads = []
  const scanner = createScanner({
    sources: [{ root: join(root, "projects"), kind: "claude", agent: "claude", depth: 1, match: (n) => n.endsWith(".jsonl"), live: sessions }],
    days: 2,
    discoverEvery: 1e12,
    watch: false,
    readdirSync(path, opts) { reads.push(path); return readdirSync(path, opts) },
  })
  expect(scanner.scan(now)[0]).toMatchObject({ id, phase: "thinking" })
  expect(reads.filter((p) => p.includes("cold")).length).toBe(4)
  unlinkSync(join(sessions, process.pid + ".json"))
  reads.length = 0
  expect(scanner.scan(now + 1500)[0]).toMatchObject({ id, phase: "aborted" })
  expect(reads.filter((p) => p.includes("cold"))).toEqual([])
})

test("the host arms the next tick only after this one finishes, and an unchanged office does not rewrite live.js", () => {
  const out = tmp()
  const home = tmp()
  const root = tmp()
  const proj = join(root, "app")
  mkdirSync(proj, { recursive: true })
  const file = join(proj, "c1.jsonl")
  const now = Date.now()
  writeFileSync(file, line(user("steady", now - 2000)) + line(done(now - 1000)))
  const hookUrl = pathToFileURL(join(import.meta.dir, "office.hooks.mjs")).href + "?cadence-host=" + Math.random()
  const code = `
    const { appendFileSync, readFileSync, statSync } = await import("node:fs")
    const hook = await import(${JSON.stringify(hookUrl)})
    const pending = []
    const setTimer = (fn, ms) => {
      const id = { fn, ms, cleared: false, unref() {} }
      pending.push(id)
      return id
    }
    const clearTimer = (id) => { if (id) id.cleared = true }
    hook.start({
      text: true, setTimer, clearTimer,
      scanner: { sources: [{ root: ${JSON.stringify(root)}, kind: "claude", agent: "claude", depth: 1, match: (n) => n.endsWith(".jsonl") }], watch: false, discoverEvery: 1e12 },
    })
    if (pending.length !== 1 || pending[0].ms < 1500) throw new Error("arm " + JSON.stringify(pending.map((id) => id.ms)))
    pending[0].fn()
    if (pending.length !== 2 || pending[1].ms < 1500) throw new Error("follow " + pending.length)
    hook.stop()
    if (!pending[1].cleared || pending.filter((id) => !id.cleared).length !== 1) throw new Error("stop left " + pending.filter((id) => !id.cleared).length)
    const livePath = ${JSON.stringify(join(out, "live.js"))}
    hook.write(5000)
    const first = readFileSync(livePath, "utf8")
    const written = statSync(livePath).mtimeMs
    if (!first.includes("steady")) throw new Error("missing steady")
    hook.write(9000)
    if (readFileSync(livePath, "utf8") !== first || statSync(livePath).mtimeMs !== written) throw new Error("rewrote unchanged live.js")
    appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(line(user("moved", now)))})
    hook.write(12000)
    const second = readFileSync(livePath, "utf8")
    if (second === first || !second.includes("moved")) throw new Error("missed a real change")
    const written2 = statSync(livePath).mtimeMs
    hook.write(20000)
    if (readFileSync(livePath, "utf8") !== second || statSync(livePath).mtimeMs !== written2) throw new Error("rewrote after the change settled")
    hook.stop()
    console.log("ok")
  `
  const r = spawnSync(process.execPath, ["-e", code], {
    env: { ...process.env, HOME: home, MAGPIE_AGENT_OFFICE_PAGE: out, MAGPIE_AGENT_OFFICE_WATCH: "0" },
    encoding: "utf8",
  })
  expect(r.stderr).toBe("")
  expect(r.stdout.trim()).toBe("ok")
  expect(r.status).toBe(0)
})

test("a null plugins.json does not kill the poll, and a later tick still publishes", () => {
  const root = tmp()
  const home = join(root, "home")
  const cfg = join(root, "cfg")
  const cache = join(root, "cache")
  const pkg = join(root, "pkg")
  const work = join(root, "work")
  mkdirSync(join(pkg, "page"), { recursive: true })
  mkdirSync(work, { recursive: true })
  cpSync(join(import.meta.dir, "lib"), join(pkg, "lib"), { recursive: true })
  cpSync(join(import.meta.dir, "office.hooks.mjs"), join(pkg, "office.hooks.mjs"))
  cpSync(join(import.meta.dir, "package.json"), join(pkg, "package.json"))
  const project = join(home, ".claude", "projects", "app")
  mkdirSync(project, { recursive: true })
  const session = join(project, "c1.jsonl")
  const now = Date.now()
  writeFileSync(session, line(user("steady", now - 2000)) + line(done(now - 1000)))
  const plugins = join(work, "plugins.json")
  const valid = JSON.stringify({ plugins: [{ spec: "@magpie-community/page-agent-office", options: { text: true } }] })
  writeFileSync(plugins, valid)
  const hookUrl = pathToFileURL(join(pkg, "office.hooks.mjs")).href
  const livePath = join(pkg, "page", "live.js")
  const code = `
    const pending = []
    globalThis.setTimeout = (fn, ms) => {
      const id = { fn, ms, cleared: false, unref() {} }
      pending.push(id)
      return id
    }
    globalThis.clearTimeout = (id) => { if (id && typeof id === "object") id.cleared = true }
    const hook = await import(${JSON.stringify(hookUrl)})
    const { appendFileSync, readFileSync, writeFileSync } = await import("node:fs")
    const polls = () => pending.filter((id) => id.ms >= 1500)
    if (polls().length !== 1 || polls()[0].cleared) throw new Error("arm " + pending.map((id) => id.ms + ":" + id.cleared).join(","))
    const livePath = ${JSON.stringify(livePath)}
    const live = () => readFileSync(livePath, "utf8")
    if (!live().includes("steady")) throw new Error("missing steady")
    writeFileSync(${JSON.stringify(plugins)}, "null\\n")
    appendFileSync(${JSON.stringify(session)}, ${JSON.stringify(line(user("moved", now)))})
    const before = pending.length
    let threw = false
    try { polls().at(-1).fn() } catch { threw = true }
    const armed = pending.slice(before).filter((id) => id.ms >= 1500 && !id.cleared)
    if (armed.length !== 1) throw new Error("rearm threw=" + threw + " added=" + pending.slice(before).map((id) => id.ms).join(","))
    if (!live().includes("moved")) throw new Error("null plugins.json skipped the tick: " + live())
    hook.stop()
    if (!armed[0].cleared) throw new Error("stop left the timer")
    const n = pending.length
    try { armed[0].fn() } catch {}
    if (pending.length !== n) throw new Error("stop armed another tick")
    console.log("ok")
  `
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: cfg,
    XDG_CACHE_HOME: cache,
    MAGPIE_AGENT_OFFICE_WATCH: "0",
  }
  delete env.MAGPIE_AGENT_OFFICE_PAGE
  delete env.MAGPIE_AGENT_OFFICE_INTERVAL
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "DSH_HOME", "PI_CODING_AGENT_DIR", "OMP_HOME", "KIMI_CODE_HOME", "GROK_HOME", "COPILOT_HOME", "CURSOR_DATA_DIR", "CURSOR_CONFIG_DIR"]) delete env[k]
  const r = spawnSync(process.execPath, ["-e", code], { cwd: work, env, encoding: "utf8" })
  expect(r.stderr).toBe("")
  expect(r.stdout.trim()).toBe("ok")
  expect(r.status).toBe(0)
})

test("stop during a tick does not arm the next one", () => {
  const out = tmp()
  const home = tmp()
  const root = tmp()
  const proj = join(root, "app")
  mkdirSync(proj, { recursive: true })
  const file = join(proj, "c1.jsonl")
  const now = Date.now()
  writeFileSync(file, line(user("steady", now - 2000)) + line(done(now - 1000)))
  const hookUrl = pathToFileURL(join(import.meta.dir, "office.hooks.mjs")).href + "?cadence-stop=" + Math.random()
  const code = `
    const { statSync } = await import("node:fs")
    const hook = await import(${JSON.stringify(hookUrl)})
    const pending = []
    const setTimer = (fn, ms) => {
      const id = { fn, ms, cleared: false, unref() {} }
      pending.push(id)
      return id
    }
    const clearTimer = (id) => { if (id) id.cleared = true }
    let stopOnScan = false
    hook.start({
      text: true, setTimer, clearTimer,
      scanner: {
        sources: [{ root: ${JSON.stringify(root)}, kind: "claude", agent: "claude", depth: 1, match: (n) => n.endsWith(".jsonl") }],
        watch: false,
        discoverEvery: 1e12,
        scanStat(path) {
          if (stopOnScan) hook.stop()
          return statSync(path)
        },
      },
    })
    if (pending.length !== 1) throw new Error("arm " + pending.length)
    stopOnScan = true
    let threw = false
    try { pending[0].fn() } catch { threw = true }
    if (pending.length !== 1) throw new Error("stop rearmed " + pending.length + " threw=" + threw)
    console.log("ok")
  `
  const r = spawnSync(process.execPath, ["-e", code], {
    env: { ...process.env, HOME: home, MAGPIE_AGENT_OFFICE_PAGE: out, MAGPIE_AGENT_OFFICE_WATCH: "0" },
    encoding: "utf8",
  })
  expect(r.stderr).toBe("")
  expect(r.stdout.trim()).toBe("ok")
  expect(r.status).toBe(0)
})
