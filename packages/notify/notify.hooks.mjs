// notify as magpie's asynchronous gateway hooks (package.json magpie.hooks):
// a push to your phone or team chat when an agent's turn is over — the
// model answered and asked for no more tools — after the turn ran long
// enough to be worth one, or when it ended in a failure.
//
// onRequest marks when a turn opens (the user's own words reach the model,
// not a tool's result) and changes nothing. A conversation is the session
// plus its first user message, so a subagent sharing its parent's session is
// a conversation of its own, and never sends a push. onResponse reads the finished
// reply; when it closes a turn that ran at least minMinutes, it hands the
// message to the channels and returns at once. Nothing here throws, and
// nothing is awaited on the request's path: a broken channel must never
// touch the request.
import { hasTools, opensTurn, ending, firstWords, compacting, continued, background, subagent } from "./turn.mjs"
import { send, usable } from "./channels.mjs"

// open conversations: key -> { key, base, start, seen, agent, model, cwd, busy, waiting, nested, failed, background, compactedAt }
//   base     the session (or agent and folder) the conversation runs in
//   seen     when magpie last saw a request or reply of it
//   busy     requests of it whose onResponse hasn't come yet
//   waiting  its last reply asked for a tool, so the agent is running one now
//   nested   it first showed up while another top-level conversation in the
//            same session was busy or waiting: a subagent, which never pushes
//   failed   { at, timer } while a failure push is held back
//   background  the tool_use_ids of the Claude Code background agents it
//            launched that haven't reported back: the turn isn't over
//            until they have
//   compactedAt  when it last asked for a compaction summary, so the
//            conversation that goes on from the summary can find it
const turns = new Map()
// the newest top-level conversation per base, for requests that carry no
// user message to tell them apart (a Responses request continuing by id)
const latest = new Map()
// last notification by conversation, for the cooldown
const sentAt = new Map()
const MAX_TURNS = 500
const STALE = 24 * 3600 * 1000
// a conversation unseen this long no longer makes a new one nested: the agent
// was quit mid-tool, or its reply was dropped
const ACTIVE = 15 * 60 * 1000
// a background agent may run long with no word from its parent
const BACKGROUND = 2 * 3600 * 1000

let now = () => Date.now()
let later = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t }
let cancel = (t) => clearTimeout(t)
let pending = new Set()

export const defaults = {
  channels: [],
  minMinutes: 3,
  cooldownSeconds: 30,
  errors: true,
  failureHoldSeconds: 60,
  agents: [],
  allOrigins: false,
  includeText: false,
  maxTextLength: 200,
  lang: "en",
}

const words = {
  en: { done: "done", failed: "failed", took: "took", model: "Model", h: "h", min: "min", s: "s" },
  zh: { done: "完成", failed: "失败", took: "用时", model: "模型", h: "小时", min: "分钟", s: "秒" },
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
  o.failureHoldSeconds = Math.max(0, Math.min(600, Number(o.failureHoldSeconds ?? defaults.failureHoldSeconds) || 0))
  o.maxTextLength = Math.max(0, Math.min(2000, Number(o.maxTextLength) || 0))
  if (!words[o.lang]) o.lang = "en"
  return o
}

// where a request runs: magpie's session id when it has one, else the agent
// in its folder. Claude Code's subagents share their parent's session.
const baseOf = (ctx) => ctx?.session ? `s:${ctx.session}` : ctx?.agent && ctx?.cwd ? `a:${ctx.agent}|${ctx.cwd}` : ""

// a short, stable hash (FNV-1a) of a conversation's first words
function hash(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

// magpie's request origins (gatewayOrigin): "local" is an agent on this
// computer with no gateway key; "gateway-key" is any named key, which may be
// someone else's; "remote" is another device. Only "local" counts as yours,
// unless allOrigins.
const ownOrigin = (ctx, o) => o.allOrigins || ctx?.origin == null || ctx.origin === "local"

function forget(key) {
  const t = turns.get(key)
  if (t?.failed) cancel(t.failed.timer)
  turns.delete(key)
}

function prune(t) {
  for (const [k, v] of turns) if (t - v.start > STALE) forget(k)
  while (turns.size > MAX_TURNS) forget(turns.keys().next().value)
  for (const [k, v] of latest) if (!turns.has(v)) latest.delete(k)
  for (const [k, v] of sentAt) if (t - v > STALE) sentAt.delete(k)
}

// a conversation that shows up while another top-level one in the same
// session is mid-request or running a tool is one that agent started: a
// subagent. Only a real session can say that; a base made of agent and folder
// is often reused by an unrelated conversation later.
const parentActive = (base, t) => base.startsWith("s:") &&
  [...turns.values()].some((v) => v.base === base && !v.nested &&
    (((v.busy > 0 || v.waiting) && t - v.seen < ACTIVE) || (v.background.size > 0 && t - v.seen < BACKGROUND)))

// the conversation a continued one goes on from: the one in its base that
// asked for a compaction summary most recently. A subagent's compaction is
// matched to the subagent, so it stays nested.
function compacted(base, t) {
  let best = null
  for (const v of turns.values()) if (v.base === base && v.compactedAt && t - v.compactedAt < ACTIVE && (!best || v.compactedAt > best.compactedAt)) best = v
  return best
}

export function onRequest(body, ctx) {
  try {
    const o = options(ctx?.options)
    if (!o.channels.length || !ownOrigin(ctx, o)) return undefined
    if (o.agents.length && !o.agents.includes(ctx?.agent ?? "")) return undefined
    const base = baseOf(ctx)
    if (!base) return undefined
    const first = firstWords(body, ctx?.protocol)
    const key = first ? `${base}#${hash(first)}` : latest.get(base) ?? `${base}#`
    const t = now()
    if (compacting(body, ctx?.protocol)) {
      // the summary is not the turn's answer: neither open nor close, but
      // remember which conversation is about to go on under new first words
      const c = turns.get(key)
      if (c) { c.compactedAt = t; c.seen = t }
      return undefined
    }
    if (!hasTools(body, ctx.protocol)) return undefined
    let turn = turns.get(key)
    const resumed = !turn && continued(body, ctx.protocol)
    if (resumed) {
      const old = compacted(base, t)
      if (old) {
        turns.delete(old.key)
        if (sentAt.has(old.key)) sentAt.set(key, sentAt.get(old.key))
        if (latest.get(base) === old.key) latest.set(base, key)
        old.key = key
        old.compactedAt = 0
        turns.set(key, old)
        turn = old
      }
    }
    if (turn?.failed) {
      // the agent retried, or the user went on after Esc: the failure was
      // not the end of the turn
      cancel(turn.failed.timer)
      turn.failed = null
    } else if (turn && !resumed && opensTurn(body, ctx.protocol) && !turn.nested) {
      turn.start = t // a new message from the user starts the turn over
    } else if (!turn) {
      const nested = subagent(body, ctx.protocol) || parentActive(base, t)
      turn = { key, base, start: t, seen: t, agent: ctx.agent ?? "", model: ctx.model ?? body?.model ?? "", cwd: ctx.cwd ?? "", busy: 0, waiting: false, nested, failed: null, background: new Set(), compactedAt: 0 }
      turns.set(key, turn)
      if (!nested) latest.set(base, key)
      prune(t)
    }
    const bg = background(body, ctx.protocol)
    for (const id of bg.launched) turn.background.add(id)
    for (const id of bg.stopped) turn.background.delete(id)
    turn.waiting = false
    turn.busy++
    turn.seen = t
    if (ctx.state) ctx.state.notify = { turn }
  } catch {}
  return undefined
}

export function onResponse(reply, ctx) {
  try {
    const turn = ctx?.state?.notify?.turn
    if (!turn) return
    turn.busy = Math.max(0, turn.busy - 1)
    turn.seen = now()
    const key = turn.key
    if (turns.get(key) !== turn) return
    const failed = ctx.success === false
    const end = failed ? { done: true, text: "" } : ending(reply, ctx.protocol)
    if (!end.done) { turn.waiting = true; return }
    // Claude Code's background agents are still at work: the main
    // conversation will be resumed when they stop, and that is the end
    if (!failed && turn.background.size > 0) return
    const o = options(ctx.options)
    if (turn.nested || (failed && !o.errors)) { forget(key); return }
    const model = ctx.model ?? turn.model
    if (!failed) { forget(key); notify(key, { ...turn, model }, now(), true, end.text, o); return }
    // agents retry 429s and 5xx on their own, and Esc arrives as a failure
    // too: hold the push, and drop it if the conversation goes on
    const at = now()
    const timer = later(() => {
      if (turns.get(turn.key) !== turn || turn.failed?.timer !== timer) return
      turns.delete(turn.key)
      notify(turn.key, { ...turn, model }, at, false, "", o)
    }, o.failureHoldSeconds * 1000)
    turn.failed = { at, timer }
  } catch {}
  return
}

function notify(key, turn, t, ok, text, o) {
  const ms = t - turn.start
  if (ms < o.minMinutes * 60_000) return
  if (now() - (sentAt.get(key) ?? -Infinity) < o.cooldownSeconds * 1000) return
  sentAt.set(key, now())
  const m = message(turn, ms, ok, text, o)
  const job = Promise.all(o.channels.map((c) => send(c, m)))
    .catch(() => {})
    .finally(() => pending.delete(job))
  pending.add(job)
}

export function duration(ms, w) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} ${w.s}`
  const min = Math.round(s / 60)
  if (min < 60) return `${min} ${w.min}`
  const h = Math.floor(min / 60), rest = min % 60
  return rest ? `${h} ${w.h} ${rest} ${w.min}` : `${h} ${w.h}`
}

export function message(turn, ms, ok, text, o) {
  const w = words[o.lang]
  const agent = names[turn.agent] ?? (turn.agent ? turn.agent[0].toUpperCase() + turn.agent.slice(1) : "Agent")
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

// for tests: forget every turn, pin the clock and the timers, and wait for
// sends in flight
export function reset(clock, timers) {
  for (const k of [...turns.keys()]) forget(k)
  latest.clear(); sentAt.clear(); pending = new Set()
  now = clock ?? (() => Date.now())
  later = timers?.later ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
  cancel = timers?.cancel ?? ((t) => clearTimeout(t))
}
export const settled = () => Promise.all([...pending])
