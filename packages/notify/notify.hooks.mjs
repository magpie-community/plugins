// notify as magpie's asynchronous gateway hooks (package.json magpie.hooks):
// a push to your phone or team chat when an agent's turn is over — the
// model answered and asked for no more tools — after the turn ran long
// enough to be worth one, or when it ended in a failure.
//
// onRequest marks when a turn opens (the user's own words reach the model,
// not a tool's result) and changes nothing. onResponse reads the finished
// reply; when it closes a turn that ran at least minMinutes, it hands the
// message to the channels and returns at once. Nothing here throws, and
// nothing is awaited on the request's path: a broken channel must never
// touch the request.
import { hasTools, opensTurn, ending } from "./turn.mjs"
import { send, usable } from "./channels.mjs"

// open turns by conversation: key -> { start, agent, model, cwd }
const turns = new Map()
// last notification by conversation, for the cooldown
const sentAt = new Map()
const MAX_TURNS = 500
const STALE = 24 * 3600 * 1000

let now = () => Date.now()
let pending = new Set()

export const defaults = {
  channels: [],
  minMinutes: 3,
  cooldownSeconds: 30,
  errors: true,
  agents: [],
  allOrigins: false,
  includeText: false,
  maxTextLength: 200,
  lang: "en",
}

const words = {
  en: { done: "done", failed: "failed", turn: "Turn", in: "in", took: "took", project: "Project", model: "Model", min: "min", s: "s" },
  zh: { done: "完成", failed: "失败", turn: "任务", in: "在", took: "用时", project: "项目", model: "模型", min: "分钟", s: "秒" },
}

const names = {
  claude: "Claude Code", "claude-desktop": "Claude Desktop", codex: "Codex", gemini: "Gemini CLI", opencode: "OpenCode",
  qwen: "Qwen Code", crush: "Crush", goose: "Goose", cursor: "Cursor", kimi: "Kimi Code", pi: "Pi", droid: "Droid",
}

export function options(raw) {
  const o = { ...defaults, ...(raw && typeof raw === "object" ? raw : {}) }
  o.channels = (Array.isArray(o.channels) ? o.channels : o.channels ? [o.channels] : []).filter(usable)
  o.agents = Array.isArray(o.agents) ? o.agents.map(String) : typeof o.agents === "string" && o.agents ? o.agents.split(",").map((s) => s.trim()) : []
  o.minMinutes = Math.max(0, Number(o.minMinutes) || 0)
  o.cooldownSeconds = Math.max(0, Number(o.cooldownSeconds) || 0)
  o.maxTextLength = Math.max(0, Math.min(2000, Number(o.maxTextLength) || 0))
  if (!words[o.lang]) o.lang = "en"
  return o
}

// the conversation a request belongs to: magpie's own id when it has one,
// else the agent in its folder
const keyOf = (ctx) => ctx?.session ? `s:${ctx.session}` : ctx?.agent && ctx?.cwd ? `a:${ctx.agent}|${ctx.cwd}` : ""

// a request from the user's own agents on this computer, unless allOrigins
const ownOrigin = (ctx, o) => o.allOrigins || ctx?.origin == null || ctx.origin === "local" || ctx.origin === "magpie-key"

function prune(t) {
  for (const [k, v] of turns) if (t - v.start > STALE) turns.delete(k)
  while (turns.size > MAX_TURNS) turns.delete(turns.keys().next().value)
  for (const [k, v] of sentAt) if (t - v > STALE) sentAt.delete(k)
}

export function onRequest(body, ctx) {
  try {
    const o = options(ctx?.options)
    if (!o.channels.length || !ownOrigin(ctx, o)) return undefined
    if (o.agents.length && !o.agents.includes(ctx?.agent ?? "")) return undefined
    if (!hasTools(body, ctx?.protocol)) return undefined
    const key = keyOf(ctx)
    if (!key) return undefined
    const t = now()
    if (opensTurn(body, ctx.protocol) || !turns.has(key)) {
      // a new turn, or one that began before magpie saw it: from here
      turns.delete(key)
      turns.set(key, { start: t, agent: ctx.agent ?? "", model: ctx.model ?? body?.model ?? "", cwd: ctx.cwd ?? "" })
      prune(t)
    }
    if (ctx.state) ctx.state.notify = { key }
  } catch {}
  return undefined
}

export function onResponse(reply, ctx) {
  try {
    const key = ctx?.state?.notify?.key
    if (!key) return
    const turn = turns.get(key)
    if (!turn) return
    const o = options(ctx.options)
    const failed = ctx.success === false
    const end = failed ? { done: true, text: "" } : ending(reply, ctx.protocol)
    if (!end.done) { ctx.report?.("skipped"); return }
    turns.delete(key)
    if (failed && !o.errors) { ctx.report?.("skipped"); return }
    const t = now()
    const ms = t - turn.start
    if (ms < o.minMinutes * 60_000) { ctx.report?.("skipped"); return }
    if (t - (sentAt.get(key) ?? -Infinity) < o.cooldownSeconds * 1000) { ctx.report?.("skipped"); return }
    sentAt.set(key, t)
    const m = message({ ...turn, model: ctx.model ?? turn.model }, ms, !failed, end.text, o)
    const job = Promise.all(o.channels.map((c) => send(c, m)))
      .then((rs) => ctx.report?.(rs.some((r) => r.ok) ? "ready" : "unavailable"))
      .catch(() => {})
      .finally(() => pending.delete(job))
    pending.add(job)
  } catch {}
  return
}

export function duration(ms, w) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} ${w.s}`
  const min = Math.round(s / 60)
  return `${min} ${w.min}`
}

export function message(turn, ms, ok, text, o) {
  const w = words[o.lang]
  const agent = names[turn.agent] ?? (turn.agent || "Agent")
  const project = turn.cwd ? turn.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : ""
  const title = `${ok ? "✅" : "❌"} ${agent} ${ok ? w.done : w.failed}${project ? ` · ${project}` : ""}`
  const lines = [`${w.took} ${duration(ms, w)}`]
  if (turn.model) lines.push(`${w.model}: ${turn.model}`)
  if (o.includeText && text && o.maxTextLength) {
    const flat = text.replace(/\s+/g, " ").trim()
    if (flat) lines.push("", flat.length > o.maxTextLength ? `${flat.slice(0, o.maxTextLength)}…` : flat)
  }
  return {
    title, body: lines.join("\n"), ok,
    event: { kind: ok ? "done" : "failed", agent: turn.agent, model: turn.model, project, seconds: Math.round(ms / 1000) },
  }
}

// for tests: forget every turn, pin the clock, and wait for sends in flight
export function reset(clock) {
  turns.clear(); sentAt.clear(); pending = new Set()
  now = clock ?? (() => Date.now())
}
export const settled = () => Promise.all([...pending])
