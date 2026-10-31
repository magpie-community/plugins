// The host side of Agent Office. magpie loads this module in its plugin host
// (a Bun process that lives while magpie runs), so it does two things there:
//
//  1. Every second and a half it reads the session files the agents write
//     themselves — Claude Code's, Codex's, DeepSeek Harness's, Gemini CLI's,
//     Qwen Code's, Pi's, omp's, Qoder's, WorkBuddy's, CodeBuddy's — and so
//     knows what each one is really doing, whatever model it talks to:
//     thinking, running a tool, waiting for an approval or an answer, done,
//     stopped, failed (lib/scan.mjs, lib/readers.mjs).
//  2. As an asynchronous gateway hook it also sees the requests that pass
//     magpie, so an agent whose files it can't read (Cursor, OpenCode,
//     Copilot, Kimi, …) still shows while it works through magpie
//     (lib/track.mjs). It returns no body: no request changes.
//
// It writes what it knows to page/live.js, beside the page, which the page
// loads again every second (the page has no network; its own files it may
// load). Only what changed is written. Nothing leaves this computer.
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createTracker } from "./lib/track.mjs"
import { createScanner } from "./lib/scan.mjs"

const here = dirname(fileURLToPath(import.meta.url))
// the page's folder, where live.js goes; a test points this elsewhere so it
// never touches a real install's
const PAGE = process.env.MAGPIE_AGENT_OFFICE_PAGE || join(here, "page")
const LIVE = join(PAGE, "live.js")
const PREFIX = "globalThis.AgentOfficeLive = "
const EVERY = 1500

// the package's own name, so plugins.json's spec is found however it was
// written: @magpie-community/page-agent-office, QingJ01/magpie-agent-office,
// a folder, or the short name alone
let packageName = ""
let packageOptions = {}
try {
  const own = JSON.parse(readFileSync(join(here, "package.json"), "utf8"))
  packageName = own.name || ""
  packageOptions = own.magpie?.options || {}
} catch {}
const ownDir = (() => { try { return realpathSync(here) } catch { return here } })()

let tracker = null
let scanner = null
let timer = null
let ticking = null
let last = ""
// fail closed: until an install's options are read, or a request carries
// them, no prompt, reply or command is written
let options = { text: false }

function track(opts) {
  const o = { text: opts?.text !== false, remote: opts?.remote === true }
  if (tracker && tracker.options.text === o.text && tracker.options.remote === o.remote) return tracker
  const was = tracker
  tracker = createTracker(o)
  if (was) for (const [k, s] of was.sessions) tracker.sessions.set(k, s)
  return tracker
}

// a session as the page wants it, from the agent's own files
function fromFiles(s, text) {
  return {
    key: s.key, source: "files", agent: s.agent, session: s.id, cwd: s.cwd, project: s.project,
    // with text off the title falls back to the folder and the step to the
    // tool's name: a prompt and a command line can both carry secrets
    title: text ? (s.title || s.project || "") : (s.project || ""),
    query: text ? s.query : "", model: s.model,
    started: s.started, updated: Math.max(s.updated || 0, s.touched || 0), touched: s.touched,
    phase: s.phase || "done", step: text ? s.step : (s.stepName || ""), reply: text ? s.reply : "", error: text ? s.error : "",
    pendingSince: s.pending?.[0]?.at || 0, turns: s.turns,
    // the workbench's extra facts: a child session, its recent words, and
    // what this session used today. Words are dropped with text off.
    subagent: s.subagent === true, parent: s.parent || "", profile: s.profile || "",
    messages: text && Array.isArray(s.messages) ? s.messages.slice(-8) : [],
    tokensToday: Number(s.tokensToday) || 0, turnsToday: Number(s.turnsToday) || 0,
    context: Number(s.context) || 0, contextWindow: Number(s.contextWindow) || 0,
  }
}

export function snapshot(now = Date.now()) {
  const text = options.text !== false
  const sessions = []
  const seen = new Set()
  const fileAgents = new Set()
  if (scanner) {
    for (const s of scanner.scan(now)) {
      fileAgents.add(s.agent)
      if (seen.has(s.key)) continue
      seen.add(s.key)
      sessions.push(fromFiles(s, text))
    }
  }
  // what only the gateway saw: an agent whose files aren't read here
  if (tracker) {
    for (const g of tracker.snapshot(now).sessions) {
      if (seen.has(g.key) || fileAgents.has(g.agent)) continue
      seen.add(g.key)
      sessions.push({ ...g, source: "gateway" })
    }
  }
  return { v: 2, written: now, text, sessions }
}

export function write(now = Date.now()) {
  timer = null
  let body
  try { body = JSON.stringify(snapshot(now)) } catch { return }
  // only a change is written; the time alone is no change
  const same = body.replace(/"written":\d+,/, "")
  if (same === last) return
  last = same
  try {
    mkdirSync(PAGE, { recursive: true })
    const tmp = LIVE + ".tmp"
    writeFileSync(tmp, PREFIX + body + ";\n")
    renameSync(tmp, LIVE)
  } catch {}
}

function soon() {
  if (timer) return
  timer = setTimeout(write, 200)
  timer.unref?.()
}

// the files are read from the moment the host loads this module
export function start(opts = {}) {
  options = { ...options, ...opts }
  if (!scanner) scanner = createScanner({ days: 2, max: 40, ...(opts.scanner || {}) })
  if (!ticking) {
    write()
    ticking = setInterval(write, EVERY)
    ticking.unref?.()
  }
}

export function stop() {
  if (ticking) clearInterval(ticking)
  ticking = null
}

export async function onRequest(body, ctx) {
  // keep the loaded options when a request carries none: text:false must
  // not turn back into text:true because a field was missing
  options = { ...options, ...(ctx.options || {}) }
  start()
  const key = track(options).request(body, ctx, Date.now())
  ctx.state.office = key
  if (key) soon()
  ctx.report?.("skipped")
  return undefined
}

export async function onResponse(reply, ctx) {
  if (!ctx.state?.office) return
  if (track(options).response(reply, ctx, Date.now(), ctx.success === true)) soon()
}

// a spec as magpie writes it, or a package name, or a path to this folder
function matchSpec(spec) {
  const raw = String(spec || "").trim()
  if (!raw) return false
  const pathLike = raw.startsWith("/") || raw.startsWith(".") || raw.startsWith("~") || raw.startsWith("file:")
  if (pathLike) {
    let p = raw.replace(/^file:\/\//, "").replace(/^file:/, "")
    if (p === "~" || p.startsWith("~/")) p = join(process.env.HOME || "", p === "~" ? "" : p.slice(2))
    try { return realpathSync(resolve(p)) === ownDir } catch { return false }
  }
  // an npm spec keeps a tag or version after its last @; a scheme's @ is
  // left alone
  let clean = raw.split("#")[0]
  if (!clean.includes("://")) {
    const at = clean.lastIndexOf("@")
    if (at > 0) clean = clean.slice(0, at)
  }
  const names = new Set([packageName, packageName.replace(/^@[^/]+\//, ""), "page-agent-office", "magpie-agent-office", "agent-office"].filter(Boolean))
  if (names.has(clean)) return true
  return names.has(clean.split(/[/:]/).filter(Boolean).pop() || "")
}

function readOptions() {
  const cfg = process.env.XDG_CONFIG_HOME || join(process.env.HOME || "", ".config")
  // magpie starts the host in its config folder, which covers portable and
  // overridden installs; the XDG path stays as the fallback
  for (const file of [join(process.cwd(), "plugins.json"), join(cfg, "magpie", "plugins.json")]) {
    let list
    try { list = JSON.parse(readFileSync(file, "utf8")) } catch { continue }
    const me = (list.plugins || []).find((p) => matchSpec(p?.spec))
    // the config this host runs with decides; a file without our entry is
    // not a reason to consult another magpie's
    return me ? { ...packageOptions, ...(me.options || {}) } : null
  }
  return null
}

// read what the plugin's options say about text, then start: a host that
// loads this module starts watching at once, before any request
const loaded = readOptions()
if (loaded) options = { text: false, ...loaded }
if (!process.env.MAGPIE_AGENT_OFFICE_PAGE) start()
