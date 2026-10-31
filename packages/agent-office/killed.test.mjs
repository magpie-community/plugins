// An agent another agent ran and then interrupted: `claude -p` or `codex
// exec` started by a Bash tool and killed from the shell. Its session file
// ends mid-turn, so it read as at work and then stuck for good. The files in
// test/killed are what Claude Code 2.1.314 and Codex 0.165.0 really wrote
// when killed (SIGTERM and SIGKILL), cut to the lines that matter.
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readClaude, readCodex } from "./lib/readers.mjs"
import { createScanner } from "./lib/scan.mjs"

const dir = import.meta.dir
const fixture = (n) => readFileSync(join(dir, "test", "killed", n), "utf8")
const scope = {}
new Function("globalThis", readFileSync(join(dir, "page", "agents.js"), "utf8"))(scope)
new Function("globalThis", readFileSync(join(dir, "page", "model.js"), "utf8"))(scope)
const M = scope.AgentOfficeModel

const tmps = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agent-office-killed-")); tmps.push(d); return d }
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }) })

const TERM_ID = "24b647af-dbc4-404b-a97e-c05d30681179"
const KILL_ID = "a6139a3c-e585-4b7e-8a69-f58fef09c87e"

// a pid no process has: one that ran and ended
function deadPid() {
  const p = Bun.spawnSync([process.execPath, "-e", ""])
  return p.pid
}

// a Claude config folder with one session file, written `ago` ms before now,
// and the given process files
function claudeHome(file, id, procs, ago, now) {
  const h = tmp()
  const proj = join(h, "projects", "-Users-me-work")
  mkdirSync(proj, { recursive: true })
  const f = join(proj, id + ".jsonl")
  writeFileSync(f, fixture(file))
  const t = (now - ago) / 1000
  utimesSync(f, t, t)
  if (procs) {
    mkdirSync(join(h, "sessions"), { recursive: true })
    for (const p of procs) writeFileSync(join(h, "sessions", p.pid + ".json"), JSON.stringify({ pidDomain: process.platform, kind: "interactive", ...p }))
  }
  const src = [{ agent: "claude", kind: "claude", root: join(h, "projects"), depth: 1, match: (n) => n.endsWith(".jsonl"), live: join(h, "sessions") }]
  return { h, src }
}

test("the real files end mid-turn: on their own they read as at work", () => {
  expect(readClaude(fixture("claude-sigterm.jsonl")).phase).toBe("thinking")
  expect(readClaude(fixture("claude-sigkill.jsonl")).phase).toBe("tool")
  expect(readCodex(fixture("codex-sigterm.jsonl")).phase).toBe("tool")
})

test("a Claude Code session SIGTERMed (its process file gone) is stopped, not stuck", () => {
  const now = Date.now()
  // another Claude Code still runs: the folder keeps process files
  const { src } = claudeHome("claude-sigterm.jsonl", TERM_ID, [{ pid: process.pid, sessionId: "the-lead" }], 60e3, now)
  const [s] = createScanner({ sources: src }).scan(now)
  expect(s.id).toBe(TERM_ID)
  expect(s.phase).toBe("aborted")
  // hours later it is still stopped, on the sofa, never "stuck"
  const later = { ...s, source: "files", touched: s.touched }
  expect(M.state(later, now + 3600e3)).toEqual({ status: "done", sub: "stopped" })
})

test("a Claude Code session SIGKILLed (its process file left, the pid gone) is stopped", () => {
  const now = Date.now()
  const { src } = claudeHome("claude-sigkill.jsonl", KILL_ID, [{ pid: deadPid(), sessionId: KILL_ID }], 60e3, now)
  const [s] = createScanner({ sources: src }).scan(now)
  expect(s.phase).toBe("aborted")
  expect(s.pending).toEqual([])
})

test("a session whose process runs stays at work, however quiet", () => {
  const now = Date.now()
  const { src } = claudeHome("claude-sigkill.jsonl", KILL_ID, [{ pid: process.pid, sessionId: KILL_ID }], 30 * 60e3, now)
  const [s] = createScanner({ sources: src }).scan(now)
  expect(s.phase).toBe("tool")
})

test("a turn written a moment ago is not judged: the process may be starting", () => {
  const now = Date.now()
  const { src } = claudeHome("claude-sigterm.jsonl", TERM_ID, [{ pid: process.pid, sessionId: "the-lead" }], 2e3, now)
  expect(createScanner({ sources: src }).scan(now)[0].phase).toBe("thinking")
})

test("a folder that never held a process file says nothing (an agent that keeps none)", () => {
  const now = Date.now()
  for (const procs of [null, []]) {
    const { src } = claudeHome("claude-sigterm.jsonl", TERM_ID, procs, 60e3, now)
    expect(createScanner({ sources: src }).scan(now)[0].phase).toBe("thinking")
  }
})

test("once the folder has held one, the last Claude Code ending empties it: still judged", () => {
  const now = Date.now()
  const { h, src } = claudeHome("claude-sigterm.jsonl", TERM_ID, [{ pid: process.pid, sessionId: TERM_ID }], 60e3, now)
  const sc = createScanner({ sources: src })
  expect(sc.scan(now)[0].phase).toBe("thinking")
  rmSync(join(h, "sessions", process.pid + ".json"))
  expect(sc.scan(now + 1500)[0].phase).toBe("aborted")
})

test("a process file of another system's (WSL) is not asked about here", () => {
  const now = Date.now()
  const { src } = claudeHome("claude-sigkill.jsonl", KILL_ID, [{ pid: deadPid(), sessionId: KILL_ID, pidDomain: "elsewhere" }], 60e3, now)
  expect(createScanner({ sources: src }).scan(now)[0].phase).toBe("tool")
})

test("a stuck session the user clears leaves the office until it moves again", () => {
  const now = Date.now()
  const c = readCodex(fixture("codex-sigterm.jsonl"))
  const s = { ...c, key: "codex|" + c.id, source: "files", touched: now - 20 * 60e3, updated: now - 20 * 60e3 }
  const snap = { sessions: [s] }
  const [a] = M.agents(snap, now, { progress: false })
  expect([a.status, a.sub]).toEqual(["error", "stuck"])
  expect(M.clearable(a.status)).toBe(true)
  expect(M.agents(snap, now, { progress: false, cleared: { [a.key]: a.at } })).toEqual([])
  // its file moves: it is back
  const moved = { sessions: [{ ...s, touched: now }] }
  expect(M.agents(moved, now, { progress: false, cleared: { [a.key]: a.at } }).map((x) => x.key)).toEqual([a.key])
})

test("an agent at work can't be cleared", () => {
  const now = Date.now()
  const c = readCodex(fixture("codex-sigterm.jsonl"))
  const s = { ...c, key: "codex|" + c.id, source: "files", touched: now - 1000, updated: now - 1000 }
  const [a] = M.agents({ sessions: [s] }, now, {})
  expect(a.status).toBe("executing")
  expect(M.clearable(a.status)).toBe(false)
  expect(M.agents({ sessions: [s] }, now, { cleared: { [a.key]: a.at + 1 } }).length).toBe(1)
})
