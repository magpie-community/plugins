import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTracker, outcomeOf, replyOf } from "./lib/track.mjs"
import { readClaude, readCodex, readDsh, readGemini, readPi, toolLine } from "./lib/readers.mjs"
import { createScanner } from "./lib/scan.mjs"
import * as F from "./test/fixtures.mjs"

const dir = import.meta.dir
const page = join(dir, "page")
const read = (f) => readFileSync(join(page, f), "utf8")
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))

// the page's classic scripts, as the page loads them
const scope = {}
new Function("globalThis", read("agents.js"))(scope)
new Function("globalThis", read("scene.js"))(scope)
new Function("globalThis", read("model.js"))(scope)
const M = scope.AgentOfficeModel
const A = scope.AgentOfficeAgents
const { NAV, BLOCKERS, DESKS, SOFA, ZONE_SPOTS } = scope.AgentOfficeScene

// every point of a way, sampled, is on a floor one may stand on
const walkable = (pts) => {
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1]
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 0.1)
    for (let k = 0; k <= n; k++) {
      const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n
      if (!NAV.freeAt(x, y)) return `blocked at ${x.toFixed(2)},${y.toFixed(2)}`
    }
  }
  return ""
}
const inside = ([x, y], [bx, by, bw, bd]) => x >= bx && x <= bx + bw && y >= by && y <= by + bd

const tmps = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agent-office-")); tmps.push(d); return d }
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }) })

// ---- the package --------------------------------------------------------

test("a page magpie serves, with a host part and no reads", () => {
  expect(pkg.name).toBe("@magpie-community/page-agent-office")
  expect(pkg.main).toBeUndefined()
  expect(pkg.magpie.page.file).toBe("page/index.html")
  expect(pkg.magpie.hooks).toBe("./office.hooks.mjs")
  expect(pkg.magpie.permissions).toEqual([])
  const html = read("index.html")
  expect(html).toContain('<script src="_magpie/bridge.js"></script>')
  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    expect(m[1]).toMatch(/\ssrc="/)
    expect(m[2].trim()).toBe("")
  }
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (m[1].startsWith("_magpie/")) continue
    expect(readdirSync(page)).toContain(m[1])
  }
  for (const f of ["index.html", "style.css", "agents.js", "model.js", "icons.js", "scene.js", "app.js", "icon.svg"]) expect(pkg.files).toContain(`page/${f}`)
  for (const f of ["page/icons", "lib", "office.hooks.mjs"]) expect(pkg.files).toContain(f)
  // screenshots are linked from GitHub: an install needs none of them
  expect(pkg.files).not.toContain("docs")
  expect(new Set(pkg.files).size).toBe(pkg.files.length)
  for (const m of readFileSync(join(dir, "README.md"), "utf8").matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    // badges and screenshots are remote: nothing relative ships in the install
    expect(m[1]).toMatch(/^https:\/\//)
    expect(m[1]).not.toMatch(/^docs\//)
  }
})

test("the page hides text itself when the switch is off", () => {
  const [a, b] = M.redact([
    { title: "SECRET-TITLE", project: "secret-project", query: "SECRET-QUERY", reply: "SECRET-REPLY", error: "SECRET-ERROR", step: "Bash · SECRET-CMD curl x", brand: { name: "Claude" }, agent: "claude" },
    { title: "SECRET-TITLE", project: "", query: "q", reply: "r", error: "e", step: "SECRET-CMD curl x", brand: { name: "Codex" }, agent: "codex" },
  ])
  expect(a).toMatchObject({ title: "secret-project", query: "", reply: "", error: "", step: "Bash" })
  expect(b).toMatchObject({ title: "Codex", query: "", reply: "", error: "", step: "" })
  expect(read("app.js")).toContain("M.redact")
})

test("the page reaches no clipboard API it cannot have", () => {
  const src = read("app.js")
  expect(src).not.toContain("navigator.clipboard")
  expect(src).not.toContain("execCommand")
})

test("the page reads nothing of magpie's and reaches no network", () => {
  for (const f of readdirSync(page).filter((f) => f.endsWith(".js") && f !== "live.js")) {
    const src = read(f)
    expect(src).not.toMatch(/magpie\.read\(/)
    expect(src).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts|new Worker/)
  }
})

test("every agent magpie knows, each with its own icon file", () => {
  const ids = Object.keys(A)
  expect(ids.length).toBeGreaterThanOrEqual(50)
  for (const id of ["claude", "codex", "gemini", "dsh", "grok", "agy", "cursor", "copilot", "opencode", "pi", "qwen", "kimi", "cline", "droid", "qoder", "workbuddy", "codebuddy", "zed", "hermes", "goose", "crush", "devin"]) {
    expect(A[id]).toBeDefined()
  }
  const icons = new Set(readdirSync(join(page, "icons")))
  let withIcon = 0
  for (const [id, a] of Object.entries(A)) if (a.icon) { expect(icons.has(a.icon)).toBe(true); withIcon++ }
  expect(withIcon).toBeGreaterThanOrEqual(50)
  expect(M.brand("claude")).toMatchObject({ name: "Claude Code", icon: "claudecode-color.svg" })
  expect(M.brand("codex").icon).toBe("codex-color.svg")
  expect(M.brand("dsh")).toMatchObject({ name: "DeepSeek Harness", icon: "deepseek-color.svg" })
  expect(M.brand("someone-new")).toMatchObject({ name: "someone-new", icon: "" })
})

// ---- the agents' own files ---------------------------------------------

test("Claude Code: a tool out, then done; a question; an interruption", () => {
  const r = readClaude(F.claudeRunning)
  expect(r).toMatchObject({ phase: "tool", step: "Edit · /Users/me/app/a.ts", title: "Fix failing test", query: "fix the failing test", model: "claude-opus-5", project: "app", turns: 1 })
  expect(r.pending.map((p) => p.id)).toEqual(["t2"])
  const d = readClaude(F.claudeDone)
  expect(d).toMatchObject({ phase: "done", reply: "Fixed: the date was parsed in UTC." })
  expect(d.pending).toEqual([])
  expect(readClaude(F.claudeAsks).phase).toBe("ask")
  expect(readClaude(F.claudeInterrupted).phase).toBe("aborted")
})

test("Codex: a running tool, an approval, done, aborted; its own prompts only", () => {
  const r = readCodex(F.codexRunning)
  expect(r).toMatchObject({ id: "019a-x", phase: "tool", model: "gpt-6.1-terra", project: "blog", query: "export the doc as markdown" })
  expect(r.step).toBe("exec · pandoc in.docx -o out.md")
  expect(readCodex(F.codexApproval)).toMatchObject({ phase: "approval", step: "shell · rm -rf dist" })
  expect(readCodex(F.codexDone)).toMatchObject({ phase: "done", reply: "Exported to out.md." })
  expect(readCodex(F.codexAborted).phase).toBe("aborted")
})

test("DeepSeek Harness: an approval asked, then an error", () => {
  const r = readDsh(F.dshApproval)
  expect(r).toMatchObject({ id: "session-d1", phase: "approval", title: "Deploy the site", model: "deepseek-flash", query: "deploy to cloudflare", project: "site" })
  expect(r.step).toBe("bash · wrangler pages deploy ./dist")
  expect(readDsh(F.dshError)).toMatchObject({ phase: "error", error: "429: usage limit reached" })
})

test("Gemini CLI and Pi", () => {
  expect(readGemini(F.geminiApproval)).toMatchObject({ phase: "approval", query: "align the chorus to 120 BPM", model: "gemini-3-pro" })
  expect(readPi(F.piDone)).toMatchObject({ phase: "done", reply: "Done: 12 tools, 5 ideas.", project: "notes" })
})

test("a tool line reads like what it does", () => {
  expect(toolLine("Bash", { command: "bun test" })).toBe("Bash · bun test")
  expect(toolLine("exec", 'text(await tools.exec_command({cmd:"rg -n foo"}))')).toBe("exec · rg -n foo")
  expect(toolLine("shell", { command: ["git", "status"] })).toBe("shell · git status")
})

test("the scanner reads each agent's folder, and only what changed", () => {
  const h = tmp()
  const cl = join(h, ".claude", "projects", "-Users-me-app")
  const cx = join(h, ".codex", "sessions", "2026", "10", "28")
  mkdirSync(cl, { recursive: true }); mkdirSync(cx, { recursive: true })
  writeFileSync(join(cl, "c1.jsonl"), F.claudeRunning)
  writeFileSync(join(cx, "rollout-2026-10-28T10-00-00-019a0000-0000-7000-8000-000000000001.jsonl"), F.codexApproval)
  const src = [
    { agent: "claude", kind: "claude", root: join(h, ".claude", "projects"), depth: 1, match: (n) => n.endsWith(".jsonl") },
    { agent: "codex", kind: "codex", root: join(h, ".codex", "sessions"), depth: 3, match: (n) => n.startsWith("rollout-") },
  ]
  const sc = createScanner({ sources: src, days: 2 })
  const now = Date.now()
  let got = sc.scan(now)
  expect(got.map((s) => [s.agent, s.phase]).sort()).toEqual([["claude", "tool"], ["codex", "approval"]])
  // the agent writes on: the scanner reads the file again
  writeFileSync(join(cl, "c1.jsonl"), F.claudeDone)
  got = sc.scan(now + 1000)
  expect(got.find((s) => s.agent === "claude").phase).toBe("done")
})

test("an active dsh session is decompressed only once per interval", () => {
  const h = tmp()
  const sd = join(h, "sessions", "--Users-me-site--", "session-z")
  mkdirSync(sd, { recursive: true })
  const file = join(sd, "session.v4.jsonl.zstd")
  const enc = (t) => new TextEncoder().encode(t)
  writeFileSync(file, Bun.zstdCompressSync(enc(F.dshApproval)))
  const sc = createScanner({
    sources: [{ agent: "dsh", kind: "dsh", root: join(h, "sessions"), depth: 2, match: (n) => n.endsWith(".zstd") }],
    days: 2,
    zstdEvery: 60000,
  })
  const now = Date.now()
  const orig = Bun.zstdDecompressSync
  let decodes = 0
  Bun.zstdDecompressSync = (...a) => { decodes++; return orig(...a) }
  try {
    let got = sc.scan(now)
    expect(decodes).toBe(1)
    expect(got[0].phase).toBe("approval")
    // the agent writes on: within the interval the last facts stand
    writeFileSync(file, Bun.zstdCompressSync(enc(F.dshError)))
    utimesSync(file, (now + 20000) / 1000, (now + 20000) / 1000)
    got = sc.scan(now + 1500)
    expect(decodes).toBe(1)
    expect(got[0].phase).toBe("approval")
    expect(got[0].touched).toBeGreaterThan(now)
    // once the interval has passed it reads the new state
    utimesSync(file, (now + 30000) / 1000, (now + 30000) / 1000)
    got = sc.scan(now + 62000)
    expect(decodes).toBe(2)
    expect(got[0].phase).toBe("error")
  } finally { Bun.zstdDecompressSync = orig }
})

// ---- walking -------------------------------------------------------------

test("a worker walks around the desks, not through them", () => {
  // from the airlock door to the far desk seat and to the sofa
  const door = [0.6, 2.6]
  for (const seat of [...DESKS.map((d) => d.seat), ...SOFA, ...ZONE_SPOTS]) {
    const pts = NAV.path(door, [seat[0], seat[1]])
    expect(pts.length).toBeGreaterThan(0)
    const floorPath = pts.filter(p => p[2] === undefined)
    const bad = walkable([[door[0], door[1]], ...floorPath])
    expect(bad).toBe("")
    // Boarding is tested separately: it approaches perpendicular to the seat.
    expect(pts[pts.length - 1].slice(0, 2)).toEqual([seat[0], seat[1]])
  }
  // no way crosses a desk's body
  const pts = NAV.path([0.6, 2.6], [11.4, 6.75])
  for (const [x, y] of pts) for (const b of BLOCKERS) expect(inside([x, y], b)).toBe(false)
})

test("a way is no longer than it has to be, and a straight line stays straight", () => {
  const direct = NAV.path([7.0, 8.6], [9.6, 8.6])
  expect(direct.length).toBe(1)
  const around = NAV.path([0.6, 2.6], [15.0, 11.0])
  expect(around.length).toBeGreaterThan(1)
  const len = (pts) => { let d = 0; let p = [0.6, 2.6]; for (const q of pts) { d += Math.hypot(q[0] - p[0], q[1] - p[1]); p = q } return d }
  // no wild detour: the straight line is 18.6
  expect(len(around)).toBeLessThan(18.6 * 1.9)
})

// ---- the page's model ---------------------------------------------------

const S = (phase, extra = {}) => ({ key: "claude|x", source: "files", agent: "claude", session: "x", phase, touched: 0, updated: 0, ...extra })

test("statuses come from the file's own phase", () => {
  const now = 1_000_000
  expect(M.state(S("tool", { touched: now - 5000 }), now)).toEqual({ status: "executing", sub: "" })
  expect(M.state(S("approval", { touched: now - 600e3 }), now)).toEqual({ status: "waiting", sub: "approval" })
  expect(M.state(S("ask"), now)).toEqual({ status: "waiting", sub: "ask" })
  expect(M.state(S("done"), now)).toEqual({ status: "done", sub: "" })
  expect(M.state(S("aborted"), now)).toEqual({ status: "done", sub: "stopped" })
  expect(M.state(S("error"), now)).toEqual({ status: "error", sub: "" })
  expect(M.state(S("thinking", { touched: now - 1000 }), now).status).toBe("thinking")
  // the model writing its answer: the file moves and there is text
  expect(M.state(S("thinking", { touched: now - 1000, reply: "So far…" }), now).status).toBe("replying")
  // a turn whose file hasn't moved for ten minutes is stuck
  expect(M.state(S("tool", { touched: now - 11 * 60e3 }), now)).toEqual({ status: "error", sub: "stuck" })
})

test("the office's agents, counts and resume commands", () => {
  const now = 10_000_000
  const list = M.agents(M.demo(now), now)
  expect(list.length).toBe(7)
  expect(M.counts(list)).toEqual({ needYou: 3, working: 2, done: 2 })
  expect(list.find((a) => a.title === "站点部署")).toMatchObject({ status: "waiting", sub: "approval" })
  expect(M.sorted(list)[0].status).toBe("waiting")
  expect(M.agents(M.demo(now), now + 7 * 3600e3, { hideAfter: "6h" }).every((a) => a.status !== "done")).toBe(true)
  expect(M.resume({ agent: "claude", session: "abc", cwd: "/a b" })).toBe("cd '/a b' && claude --resume abc")
  expect(M.resume({ agent: "codex", session: "019a", cwd: "/x" })).toBe("cd /x && codex resume 019a")
  expect(M.resume({ agent: "dsh", session: "session-1d68", cwd: "/x" })).toBe("cd /x && dsh --resume 1d68")
  expect(M.resume({ agent: "unknown", session: "x" })).toBe("")
})

test("sample agents sit beside real ones, never instead of them", () => {
  const now = 10_000_000
  const real = { sessions: [S("tool", { key: "claude|real", title: "real work", touched: now - 1000 })] }
  const both = M.merge(real, M.demo(now))
  expect(both.sessions[0].key).toBe("claude|real")
  expect(M.agents(both, now).some((a) => a.title === "real work")).toBe(true)
})

test("words, in English and Chinese", () => {
  expect(M.text("zh-CN").title).toBe("我的 Agent 在干嘛")
  expect(Object.keys(M.TEXT.zh).sort()).toEqual(Object.keys(M.TEXT.en).sort())
  for (const e of read("index.html").matchAll(/data-t="([^"]+)"/g)) expect(M.TEXT.en[e[1]]).toBeDefined()
  expect(M.ago(28 * 60e3, "zh")).toBe("28分钟前")
  expect(M.duration(130e3, "en")).toBe("2m 10s")
})

// ---- the host part --------------------------------------------------------

test("the host part writes what it reads, and changes no request", async () => {
  const out = tmp()
  process.env.MAGPIE_AGENT_OFFICE_PAGE = out
  const hook = await import("./office.hooks.mjs")
  const h = tmp()
  const cl = join(h, "projects", "-Users-me-app")
  mkdirSync(cl, { recursive: true })
  writeFileSync(join(cl, "c1.jsonl"), F.claudeRunning)
  hook.start({ text: true, scanner: { sources: [{ agent: "claude", kind: "claude", root: join(h, "projects"), depth: 1, match: (n) => n.endsWith(".jsonl") }] } })
  hook.stop()
  const c = { origin: "local", protocol: "anthropic", agent: "cursor", session: "cu1", cwd: "/x", model: "m", query: "hi", options: {}, state: {}, report() {} }
  expect(await hook.onRequest({ model: "m", tools: [{ name: "x" }], messages: [{ role: "user", content: "hi" }] }, c)).toBeUndefined()
  hook.write()
  const live = readFileSync(join(out, "live.js"), "utf8")
  const snap = JSON.parse(live.slice("globalThis.AgentOfficeLive = ".length).replace(/;\s*$/, ""))
  const claude = snap.sessions.find((s) => s.agent === "claude")
  expect(claude).toMatchObject({ source: "files", phase: "tool", title: "Fix failing test" })
  // an agent whose files aren't read shows from the gateway
  expect(snap.sessions.find((s) => s.agent === "cursor")?.source).toBe("gateway")
  expect(live).not.toMatch(/authorization|x-api-key/i)
})

test("the gateway part still reads replies in each API", () => {
  expect(outcomeOf(replyOf({ role: "assistant", content: [{ type: "text", text: "Which one?" }] }, "anthropic"))).toBe("ask")
  expect(outcomeOf(replyOf({ output: [{ type: "function_call", name: "shell", arguments: "{}" }] }, "responses"))).toBe("tools")
  const t = createTracker()
  expect(t.request({ model: "m", tools: [1], messages: [{ role: "user", content: "x" }] }, { origin: "remote", agent: "a", session: "s" }, 1)).toBeNull()
})

test("live.js is no file of the package's", () => {
  expect(pkg.files.some((f) => f.includes("live"))).toBe(false)
  expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("page/live.js")
})
