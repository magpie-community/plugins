import { expect, test } from "bun:test"
import { createAlerter, stateOf } from "./lib/alerts.mjs"

const T0 = 1793196000000
const MIN = 60e3

// a session as snapshot() writes it, from an agent's own files (text on)
const files = (phase, extra = {}) => ({
  key: "claude|c1", source: "files", agent: "claude", session: "c1", cwd: "/Users/me/app", project: "app",
  title: "Fix failing test", query: "fix the failing test", model: "claude-opus-5",
  started: T0, updated: T0, touched: T0, phase, step: "Bash · bun test", reply: "", error: "",
  pendingSince: 0, turns: 2, ...extra,
})
// one only the gateway saw, as tracker.snapshot() gives it
const gateway = (extra = {}) => ({
  key: "cursor|g1", source: "gateway", agent: "cursor", session: "g1", cwd: "/tmp/p", project: "p",
  title: "", query: "", model: "m", started: T0, updated: T0, turns: 1, steps: 2, tools: true,
  inflight: 0, inflightSince: 0, turn: "user",
  last: { at: T0, outcome: "text", text: "done", step: "", toolNames: [] },
  ...extra,
})

// ---- the states, in step with the page ----------------------------------

test("stateOf reads a file session's phase the way the page does", () => {
  expect(stateOf(files("approval"), T0)).toEqual({ status: "waiting", sub: "approval" })
  expect(stateOf(files("ask"), T0)).toEqual({ status: "waiting", sub: "ask" })
  expect(stateOf(files("error"), T0)).toEqual({ status: "error", sub: "" })
  expect(stateOf(files("done"), T0)).toEqual({ status: "done", sub: "" })
  expect(stateOf(files("aborted"), T0)).toEqual({ status: "done", sub: "stopped" })
  expect(stateOf(files("tool", { touched: T0 + MIN }), T0 + 2 * MIN)).toEqual({ status: "executing", sub: "" })
  expect(stateOf(files("tool", { touched: T0 }), T0 + 11 * MIN)).toEqual({ status: "error", sub: "stuck" })
  expect(stateOf(files("thinking", { touched: T0 }), T0 + 11 * MIN)).toEqual({ status: "error", sub: "stuck" })
  expect(stateOf(files("thinking", { touched: T0 + MIN }), T0 + 2 * MIN)).toEqual({ status: "thinking", sub: "" })
})

test("stateOf works a gateway session out from its requests, as the page does", () => {
  expect(stateOf(gateway({ inflight: 1, inflightSince: T0 }), T0 + 4e3)).toEqual({ status: "thinking", sub: "" })
  expect(stateOf(gateway({ last: { at: T0, outcome: "error" } }), T0)).toEqual({ status: "error", sub: "" })
  expect(stateOf(gateway({ last: { at: T0, outcome: "ask" } }), T0)).toEqual({ status: "waiting", sub: "ask" })
  expect(stateOf(gateway({ last: { at: T0, outcome: "tools" } }), T0 + 30e3)).toEqual({ status: "executing", sub: "" })
  expect(stateOf(gateway({ last: { at: T0, outcome: "tools" } }), T0 + 91e3)).toEqual({ status: "waiting", sub: "approval" })
  expect(stateOf(gateway({ last: { at: T0, outcome: "tools" } }), T0 + 91e3, { approvalSec: 300 })).toEqual({ status: "executing", sub: "" })
  expect(stateOf(gateway(), T0)).toEqual({ status: "done", sub: "" })
})

// ---- what gets said -------------------------------------------------------

test("a wait is said when it begins, held while it stands, said again after the cooldown", () => {
  const a = createAlerter({ cooldownMin: 15 })
  const wait = files("approval", { touched: T0 })
  expect(a.tick([wait], T0 + 2 * MIN)).toEqual([expect.objectContaining({ type: "waiting", sub: "approval", since: 2 * MIN })])
  expect(a.tick([wait], T0 + 3 * MIN)).toEqual([])
  expect(a.tick([wait], T0 + 17 * MIN).length).toBe(1)
})

test("a wait that changes its mind — an approval become a question — is said again", () => {
  const a = createAlerter()
  a.tick([files("approval", { touched: T0 })], T0 + MIN)
  const said = a.tick([files("ask", { touched: T0 + 2 * MIN })], T0 + 2 * MIN)
  expect(said.length).toBe(1)
  expect(said[0].sub).toBe("ask")
})

test("a finished turn is said once, and only when a stretch of work ended", () => {
  const a = createAlerter({ minWorkSec: 60 })
  const t = T0
  expect(a.tick([files("tool", { touched: t })], t + 10e3)).toEqual([])      // at work
  const said = a.tick([files("done", { touched: t + 5 * MIN })], t + 5 * MIN)
  expect(said).toEqual([expect.objectContaining({ type: "done", since: 5 * MIN - 10e3 })])
  expect(a.tick([files("done", { touched: t + 5 * MIN })], t + 6 * MIN)).toEqual([])
  // a quick chat that never worked a minute is not worth a card
  const quick = createAlerter()
  quick.tick([files("thinking", { touched: t })], t)
  expect(quick.tick([files("done", { touched: t + 10e3 })], t + 10e3)).toEqual([])
})

test("a minimum of zero minutes is a choice, not a missing one", () => {
  const a = createAlerter({ minWorkSec: 0 })
  a.tick([files("thinking", { touched: T0 })], T0 + 1000)
  expect(a.tick([files("done", { touched: T0 + 4000 })], T0 + 4000).length).toBe(1)
})

test("a failure is said, held, and said again sooner than a wait", () => {
  const a = createAlerter({ errorMin: 5 })
  const bad = files("error", { touched: T0, error: "429: usage limit reached" })
  const first = a.tick([bad], T0 + MIN)
  expect(first).toEqual([expect.objectContaining({ type: "error", error: "429: usage limit reached" })])
  expect(a.tick([bad], T0 + 2 * MIN)).toEqual([])
  expect(a.tick([bad], T0 + 6 * MIN).length).toBe(1)
})

test("a session gone quiet mid-turn is said as stuck, and named for how long", () => {
  const a = createAlerter({ stuckMin: 10 })
  const quiet = files("thinking", { touched: T0 })
  expect(a.tick([quiet], T0 + 11 * MIN)).toEqual([expect.objectContaining({ type: "stuck", since: 11 * MIN })])
})

test("a card carries the resume command an agent has one of", () => {
  const a = createAlerter()
  const said = a.tick([files("ask", { touched: T0 })], T0 + MIN)
  expect(said[0].resume).toBe("cd /Users/me/app && claude --resume c1")
  expect(a.tick([gateway({ last: { at: T0, outcome: "ask" } })], T0 + MIN)[0].resume).toBe("")
})

test("a first sighting says a wait or a failure that stands, never a finish", () => {
  const a = createAlerter()
  expect(a.tick([files("approval", { touched: T0 })], T0 + MIN).length).toBe(1)
  expect(a.tick([files("error", { touched: T0 })], T0 + MIN).length).toBe(1)
  expect(a.tick([files("done", { touched: T0 })], T0 + MIN)).toEqual([])
})

test("a quiet hour holds every card but a failure", () => {
  const night = (h, m) => new Date(2026, 9, 30, h, m).getTime()
  const a = createAlerter({ quietHours: "23:00-08:00" })
  expect(a.tick([files("approval", { touched: night(23, 30) - MIN })], night(23, 30))).toEqual([])
  expect(a.tick([files("error", { touched: night(23, 30) - MIN })], night(23, 30)).length).toBe(1)
  expect(a.tick([files("approval", { touched: night(12, 0) - MIN })], night(12, 0)).length).toBe(1)
})

test("only the agents asked for are watched", () => {
  const a = createAlerter({ agents: "codex" })
  expect(a.tick([files("approval", { touched: T0 })], T0 + MIN)).toEqual([])
  expect(a.tick([files("approval", { key: "codex|x1", agent: "codex", session: "x1", touched: T0 })], T0 + MIN).length).toBe(1)
})

test("a recovery is said only when asked for", () => {
  const strict = createAlerter()
  strict.tick([files("error", { touched: T0 })], T0 + MIN)
  expect(strict.tick([files("thinking", { touched: T0 + 3 * MIN })], T0 + 3 * MIN)).toEqual([])
  const watching = createAlerter({ events: "recover" })
  watching.tick([files("error", { touched: T0 })], T0 + MIN)
  expect(watching.tick([files("thinking", { touched: T0 + 3 * MIN })], T0 + 3 * MIN)).toEqual([expect.objectContaining({ type: "recover" })])
})

test("a session the snapshot stopped carrying is forgotten", () => {
  const a = createAlerter()
  a.tick([files("approval", { touched: T0 })], T0 + MIN)
  for (let i = 0; i < 12; i++) a.tick([], T0 + 2 * MIN)
  // forgotten, so a wait that comes again is a new one, said at once
  expect(a.tick([files("approval", { touched: T0 + 3 * MIN })], T0 + 3 * MIN).length).toBe(1)
})
