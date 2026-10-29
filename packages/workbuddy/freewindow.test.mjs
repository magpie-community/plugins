// The free model's daily token window: what WorkBuddy AI refuses a chat on
// long before a free plan's credits are spent, and which the credit meter
// does not show. Every figure here is one measured on a real account; see
// freeWindowOf for the readings and how each was checked.
import { test, expect, beforeAll } from "bun:test"
import { tmpdir } from "node:os"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

let _internal
beforeAll(async () => {
  // as usage.test.mjs: run with HOME=$(mktemp -d) bun test
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ _internal } = await import("./index.mjs"))
})

// a row of magpie's usage ledger (usage.Record), as the plugin reads it
// pad stands in for a real row's request fields (conversation, client, price,
// error text), so a row can be made as fat as a ledger's own and a handful of
// them can outgrow one 64 KiB chunk, as they do in a live ledger
const row = (t, { status = 200, in: inp = 0, cache = 0, out = 0, err = "", model = "deepseek-v4.1-flash", account = "me@example.com", provider = "workbuddy-ai", pad = "" } = {}) => ({
  provider,
  providerAccount: account,
  model,
  t,
  status,
  in: inp,
  cache_read: cache,
  out,
  err,
  ...(pad ? { pad } : {}),
})
const iso = (s) => new Date(s).toISOString()
const at = (s) => Date.parse(s)

// enough padding to make a row a live ledger's size
const FAT = "x".repeat(1400)

// the vendor's words before the reset it names
const TIMEOUT_BEFORE_RESET = "WorkBuddy AI: usage exceeds frequency limit, but don't worry, your usage will reset at "

// the refusal WorkBuddy AI sends when the window is spent
const refusal = (reset, account = "me@example.com") =>
  row(`2026-10-20T19:47:41+08:00`, {
    status: 429,
    account,
    err: `WorkBuddy AI: usage exceeds frequency limit, but don't worry, your usage will reset at ${reset} UTC+8, alternatively, you can switch to the other models to continue using it.`,
  })

test("a window counts in + cache_read + out", () => {
  const rows = [row("2026-10-20T19:53:48+08:00", { in: 1_000_000, cache: 4_000_000, out: 100_000 }), row("2026-10-20T20:00:00+08:00", { in: 500_000, cache: 2_000_000 })]
  const w = _internal.freeWindowOf(rows, "me@example.com", at("2026-10-20T21:00:00+08:00"))
  expect(w.amount).toBe(7_600_000)
  expect(w.used).toBeCloseTo(7.6, 6)
  expect(w.resetsAt).toBe(iso("2026-10-21T19:53:48+08:00"))
  expect(w.span).toBe(86400)
  expect(w.limit).toBe(1e8)
  expect(w.unit).toBe("tokens")
  expect(w.display).toBe("7.6M / 100M")
  expect(w.models).toEqual(["deepseek-v4.1-flash", "deepseek-v4.1-flash-sg"])
})

// reading in + out alone is 20x too small and never reaches a cap, so a
// window read that way looks empty while it is full
test("cache_read alone can fill a window", () => {
  const w = _internal.freeWindowOf([row("2026-10-20T19:53:48+08:00", { in: 200, cache: 99_000_000, out: 300 })], "me@example.com", at("2026-10-20T21:00:00+08:00"))
  expect(w.used).toBeGreaterThan(98)
  expect(w.used).toBeLessThanOrEqual(100)
})

// the reset a refusal names is the old window's end; the new one starts at
// the next request, which a real account made 68 minutes later
test("a new window opens at the next request, not at the reset instant", () => {
  const rows = [
    row("2026-10-16T15:40:03+08:00", { in: 60_000_000 }),
    row("2026-10-17T08:00:00+08:00", { in: 40_000_000 }),
    refusal("2026-10-17 08:00:13"),
    row("2026-10-17T09:08:00+08:00", { in: 1_000 }),
  ]
  const w = _internal.freeWindowOf(rows, "me@example.com", at("2026-10-17T10:00:00+08:00"))
  expect(w.resetsAt).toBe(iso("2026-10-18T09:08:00+08:00"))
  expect(w.amount).toBe(1_000)
})

// a window never refused still ends 24h after its first request
test("an unrefused window lapses 24h after its first request", () => {
  const rows = [row("2026-10-19T19:52:24+08:00", { in: 90_000_000 }), row("2026-10-19T23:00:00+08:00", { in: 2_000_000 })]
  expect(_internal.freeWindowOf(rows, "me@example.com", at("2026-10-20T19:00:00+08:00")).amount).toBe(92_000_000)
  // lapsed: nothing is exhausted, so no window is reported
  expect(_internal.freeWindowOf(rows, "me@example.com", at("2026-10-20T20:00:00+08:00"))).toBeNull()
})

// the paid id draws on the same window, so its rows are in this one
test("-sg counts in the same window as the free id", () => {
  const rows = [row("2026-10-20T19:53:48+08:00", { in: 50_000_000 }), row("2026-10-20T20:00:00+08:00", { in: 10_000, model: "deepseek-v4.1-flash-sg" })]
  const w = _internal.freeWindowOf(rows, "me@example.com", at("2026-10-20T21:00:00+08:00"))
  expect(w.amount).toBe(50_010_000)
  expect(w.models).toEqual(["deepseek-v4.1-flash", "deepseek-v4.1-flash-sg"])
})

test("other accounts, other models and the China build are left out", () => {
  const rows = [
    row("2026-10-20T19:53:48+08:00", { in: 1_000 }),
    row("2026-10-20T19:54:00+08:00", { in: 9_000_000, account: "other@example.com" }),
    row("2026-10-20T19:55:00+08:00", { in: 9_000_000, model: "glm-5.3-flash" }),
    row("2026-10-20T19:56:00+08:00", { in: 9_000_000, model: "kimi-k2.6" }),
    row("2026-10-20T19:57:00+08:00", { in: 9_000_000, provider: "workbuddy" }),
  ]
  expect(_internal.freeWindowOf(rows, "me@example.com", at("2026-10-20T21:00:00+08:00")).amount).toBe(1_000)
})

// a refusal carries no tokens: it neither counts nor opens a window
test("a 429 neither counts nor opens a window", () => {
  const rows = [row("2026-10-20T19:53:48+08:00", { in: 100 }), row("2026-10-20T22:00:00+08:00", { status: 429, in: 5_000, err: "429 usage exceeds frequency limit" })]
  const w = _internal.freeWindowOf(rows, "me@example.com", at("2026-10-20T23:00:00+08:00"))
  expect(w.amount).toBe(100)
  expect(w.resetsAt).toBe(iso("2026-10-21T19:53:48+08:00"))
})

// a refusal with no readable reset time is no edge; the 24h span still ends
// the window
test("a refusal that names no reset falls back to the 24h span", () => {
  const rows = [
    row("2026-10-20T10:00:00+08:00", { in: 99_000_000 }),
    row("2026-10-20T12:00:00+08:00", { status: 429, err: "WorkBuddy AI: usage exceeds frequency limit" }),
    row("2026-10-21T11:00:00+08:00", { in: 1_000 }),
  ]
  const w = _internal.freeWindowOf(rows, "me@example.com", at("2026-10-21T12:00:00+08:00"))
  expect(w.resetsAt).toBe(iso("2026-10-22T11:00:00+08:00"))
  expect(w.amount).toBe(1_000)
})

test("nothing to read yields no window, not a made-up one", () => {
  expect(_internal.freeWindowOf([], "me@example.com")).toBeNull()
  expect(_internal.freeWindowOf(null, "me@example.com")).toBeNull()
  expect(_internal.freeWindowOf([row("2026-10-20T19:53:48+08:00")], "nobody@example.com")).toBeNull()
  expect(_internal.freeWindowOf([row("2026-10-20T19:53:48+08:00", { status: 429, err: "429 usage exceeds frequency limit" })], "me@example.com")).toBeNull()
})

test("the card reads a token count, not a credits count", () => {
  expect(_internal.tokensShort(99_971_831)).toBe("100.0M")
  expect(_internal.tokensShort(11_950_000)).toBe("11.9M")
  expect(_internal.tokensShort(812_400)).toBe("812k")
  expect(_internal.tokensShort(6)).toBe("6")
})

test("no ledger means no window rather than a guess", () => {
  // HOME is a temp dir in tests and no folder it reads holds a ledger
  expect(_internal.freeWindowRows("me@example.com", Date.now(), join(homedir(), "magpie-test-nowhere"), {}, homedir())).toBeNull()
})

// --- the review's points, each red on 33ca87f8 -------------------------

// point 1: an account refused under the cap read as 93% because the rest of
// its spending was on another machine. The refusal is the one exact signal
// there is: a 429 whose named reset is still ahead makes the window full.
test("an account refused under the cap reads full, not 93%", () => {
  const rows = [
    row("2026-10-18T19:47:00+08:00", { in: 62_000_000, cache: 30_000_000, out: 700_000 }),
    row("2026-10-18T19:52:00+08:00", { in: 92_962, model: "deepseek-v4.1-flash-sg" }),
    row("2026-10-18T19:52:04+08:00", { status: 429, err: `${TIMEOUT_BEFORE_RESET}2026-10-19 19:52:24 UTC+8, alternatively, you can switch to the other models to continue using it.` }),
  ]
  const w = _internal.freeWindowOf(rows, "me@example.com", at("2026-10-18T23:00:00+08:00"))
  expect(w.amount).toBe(1e8) // the rows sum to 92,792,962
  expect(w.used).toBe(100)
  expect(w.display).toBe("100.0M / 100M")
  expect(w.resetsAt).toBe(iso("2026-10-19T19:52:24+08:00"))
  expect(w.refused).toBe(true)
})

// the refusal belongs to its window: once its reset passes, the sum reads
test("a refusal whose reset has passed does not hold the next window full", () => {
  const rows = [
    row("2026-10-18T19:47:00+08:00", { in: 92_000_000 }),
    row("2026-10-18T19:52:04+08:00", { status: 429, err: `${TIMEOUT_BEFORE_RESET}2026-10-19 19:52:24 UTC+8, alternatively, you can switch to the other models to continue using it.` }),
    row("2026-10-19T20:00:00+08:00", { in: 1_000 }),
  ]
  const w = _internal.freeWindowOf(rows, "me@example.com", at("2026-10-19T21:00:00+08:00"))
  expect(w.amount).toBe(1_000)
  expect(w.refused).toBeUndefined()
})

// point 6: the offset is read from the refusal, and one that cannot be read
// is no edge at all rather than +08:00
test("the reset's offset is read from the text", () => {
  expect(_internal.windowOffset("reset at 2026-10-20 19:47:41 UTC+8")).toBe(480)
  expect(_internal.windowOffset("reset at 2026-10-20 19:47:41 UTC+08:00")).toBe(480)
  expect(_internal.windowOffset("reset at 2026-10-20 19:47:41 GMT-5")).toBe(-300)
  expect(_internal.windowOffset("reset at 2026-10-20 19:47:41 UTC+05:30")).toBe(330)
  expect(_internal.windowOffset("reset at 2026-10-20 19:47:41")).toBeNull()
  expect(_internal.windowReset("reset at 2026-10-20 19:47:41 UTC+8")).toBe(Date.parse("2026-10-20T19:47:41+08:00"))
  expect(Number.isNaN(_internal.windowReset("reset at 2026-10-20 19:47:41"))).toBe(true)
})

// point 3: magpie keeps usage.jsonl in appdir.Config(), which is the folder
// the plugin host runs in — portable, or $XDG_CONFIG_HOME/magpie — and only
// ~/.config/magpie otherwise
test("the ledger is found through $XDG_CONFIG_HOME", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-xdg-"))
  try {
    const home = join(root, "home")
    const xdg = join(root, "xdg")
    mkdirSync(join(home, ".config", "magpie"), { recursive: true })
    mkdirSync(join(xdg, "magpie"), { recursive: true })
    writeFileSync(join(home, ".config", "magpie", "usage.jsonl"), JSON.stringify(row("2026-10-01T10:00:00+08:00", { in: 1 })) + "\n")
    writeFileSync(join(xdg, "magpie", "usage.jsonl"), JSON.stringify(row("2026-10-20T10:00:00+08:00", { in: 5_000_000 })) + "\n")
    const rows = _internal.freeWindowRows("me@example.com", at("2026-10-20T12:00:00+08:00"), join(root, "elsewhere"), { XDG_CONFIG_HOME: xdg }, home)
    expect(rows.map((r) => r.in)).toEqual([5_000_000])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the ledger is found through the folder the host runs in", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-cwd-"))
  try {
    writeFileSync(join(root, "usage.jsonl"), JSON.stringify(row("2026-10-20T10:00:00+08:00", { in: 7_000_000 })) + "\n")
    const rows = _internal.freeWindowRows("me@example.com", at("2026-10-20T12:00:00+08:00"), root, {}, join(root, "nohome"))
    expect(rows.map((r) => r.in)).toEqual([7_000_000])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// point 4: a heavy ledger runs to hundreds of MB, so the read starts at its
// end. Where it stops is the chain's business (see the probes below); with no
// edge in reach it goes back to an edge it can stand on, or to the file's end.
test("the read starts at the file's end", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-tail-"))
  try {
    const now = at("2026-10-20T20:00:00+08:00")
    const lines = []
    for (let i = 0; i < 3000; i++) lines.push(JSON.stringify(row(new Date(now - (2999 - i) * 3600_000).toISOString(), { in: i === 2999 ? 9_000_000 : 1 })))
    lines.push(JSON.stringify({ ...row(new Date(now).toISOString(), { in: 4 }), provider: "zcode" }))
    writeFileSync(join(root, "usage.jsonl"), lines.join("\n") + "\n" + '{"provider":"workbuddy-ai","t":"2026-10-20T')
    const rows = _internal.freeWindowRows("me@example.com", now, root, {}, join(root, "nohome"))
    expect(rows.every((r) => r.provider === "workbuddy-ai")).toBe(true)
    expect(rows.at(-1).in).toBe(9_000_000) // the newest row, and never the torn one
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- the next round: the read must stop on a pinned edge, not on an age --

// writeLedger puts rows into a fresh folder's usage.jsonl, one JSON line
// each, the last one whole — unless torn asks for a call still being written
function writeLedger(lines, torn = false) {
  const root = mkdtempSync(join(tmpdir(), "wb-window-"))
  writeFileSync(join(root, "usage.jsonl"), lines.join("\n") + "\n" + (torn ? '{"provider":"workbuddy-ai","t":"2026-10-' : ""))
  return root
}

// The window is a chain: it starts at the first request answered after the
// previous one ended, so where the window now began depends on every window
// before it. A read that stops after 48 hours hands freeWindowOf a first row
// that is usually in the middle of a window, and every window after it is
// shifted — the review's probe read 4% two hours before the account is
// refused. Two things stand at an edge exactly, and the read stops for both:
// a refusal whose reset can be read, and a gap of a day between two of this
// account's answered rows.
const AN_HOUR = 3600_000
const A_DAY = 86_400_000
// spread is rows served every hour from start to now, 4M each
function spread(start, now) {
  const rows = []
  for (let t = start; t <= now; t += AN_HOUR) rows.push(row(new Date(t).toISOString(), { cache: 4_000_000 }))
  return rows
}
// a ledger holding those rows, padded to a live ledger's row size, then
// another provider's 2000 rows after them, so this account's rows sit
// further back than one 64 KiB chunk and the 48h cutoff falls between them
function spreadLedger(rows, now) {
  const lines = rows.map((r) => JSON.stringify({ ...r, pad: FAT }))
  for (let i = 0; i < 2000; i++) lines.push(JSON.stringify(row(new Date(now - 3599_000 + i).toISOString(), { in: 1, provider: "zcode" })))
  return writeLedger(lines)
}

// a day of rows, and the account served every hour after them: the window is
// whatever the ledger's own chain makes of it, and the tail alone makes
// something else
test("a day of rows pins the chain where the whole ledger does", () => {
  const now = at("2026-10-20T20:00:00+08:00")
  // served hourly for a week before, then a gap of 5h, then hourly
  const rows = spread(now - 7 * A_DAY, now - 5 * AN_HOUR).concat(spread(now - 1 * AN_HOUR, now))
  const root = spreadLedger(rows, now)
  try {
    const whole = _internal.freeWindowOf(rows, "me@example.com", now)
    const read = _internal.freeWindowRows("me@example.com", now, root, {}, join(root, "nohome"))
    // the read goes past the 48h tail to the day before where the gap lets
    // the chain be read: the tail alone holds 41 of these rows
    expect(read.length).toBeGreaterThan(41)
    const w = _internal.freeWindowOf(read, "me@example.com", now)
    expect(w.amount).toBe(whole.amount)
    expect(w.resetsAt).toBe(whole.resetsAt)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// with a refusal to stand at, the chain is anchored exactly: the window
// opens at the first request answered after the reset it names
test("a refusal the read reaches pins the window exactly", () => {
  const now = at("2026-10-22T12:00:00+08:00")
  const rows = spread(now - 70 * AN_HOUR, now)
  // the window the 70h row opened was refused once its day ran out
  const reset = now - 70 * AN_HOUR + A_DAY
  const atReset = `${new Date(reset).toISOString().slice(0, 19).replace("T", " ")} UTC+0`
  const refused = [
    ...rows,
    row(new Date(now - 46 * AN_HOUR + 60_000).toISOString(), { status: 429, err: `${TIMEOUT_BEFORE_RESET}${atReset}, alternatively, you can switch to the other models to continue using it.` }),
  ].sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
  const root = spreadLedger(refused, now)
  try {
    const w = _internal.freeWindowOf(_internal.freeWindowRows("me@example.com", now, root, {}, join(root, "nohome")), "me@example.com", now)
    // the refusal names the window's end; the window holding now opened on
    // the span after it, and the rows read say the same as all of them
    const whole = _internal.freeWindowOf(refused, "me@example.com", now)
    expect(whole.amount).toBe(23 * 4_000_000)
    expect(w.amount).toBe(whole.amount)
    expect(w.resetsAt).toBe(whole.resetsAt)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// a gap of a day or more ends every window before it, so the row after the
// gap opens one: the second thing that pins the chain without a refusal
test("a gap of a day or more pins the chain too", () => {
  const now = at("2026-10-22T12:00:00+08:00")
  // served hourly until 50h ago, then nothing for 30h, then hourly since
  const rows = spread(now - 100 * AN_HOUR, now - 50 * AN_HOUR).concat(spread(now - 20 * AN_HOUR, now))
  const root = spreadLedger(rows, now)
  try {
    const whole = _internal.freeWindowOf(rows, "me@example.com", now)
    // the idle ended every window before it, so the window now is the one the
    // first row after it opened, 20h ago
    expect(whole.amount).toBe(21 * 4_000_000)
    expect(whole.resetsAt).toBe(iso(new Date(now - 20 * AN_HOUR + A_DAY)))

    const read = _internal.freeWindowRows("me@example.com", now, root, {}, join(root, "nohome"))
    const w = _internal.freeWindowOf(read, "me@example.com", now)
    // the read stops a day before the row after the idle: the 21 rows since
    // it, and the 25 of the day before the gap — not the 100 before them
    expect(read.length).toBe(46)
    expect(w.amount).toBe(whole.amount)
    expect(w.resetsAt).toBe(whole.resetsAt)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// The review's probe, unchanged: hourly rows for 70h, 4M of cache_read each,
// six days after the last of them is 2000 rows of another provider, and no
// refusal anywhere. With no edge to stand at there is no window chain to be
// read, so the whole ledger and the read agree — and a run of use with no gap
// and no refusal is exactly that: there is no window edge in it to find.
test("the review's probe: a run with no edge reads as the whole ledger", () => {
  const now = at("2026-10-22T12:00:00+08:00")
  // rows from two hours before the file's other rows, so the tail read alone
  // would still open the window mid-run
  const rows = spread(now - 70 * AN_HOUR, now - 1 * AN_HOUR)
  const root = spreadLedger(rows, now)
  try {
    const whole = _internal.freeWindowOf(rows, "me@example.com", now)
    const read = _internal.freeWindowRows("me@example.com", now, root, {}, join(root, "nohome"))
    const w = _internal.freeWindowOf(read, "me@example.com", now)
    expect(read.length).toBe(rows.length) // every row: no edge, so the file's start
    expect(w.amount).toBe(whole.amount)
    expect(w.resetsAt).toBe(whole.resetsAt)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// magpie appends the calls a client reports through POST
// /v1/magpie/usage/requests to the same ledger (#1874), dated where the
// client's call happened — a backfill reaching back on purpose
// (docs/integrating.md). Such a line is written at the file's end, so its
// time says nothing about where the read has got to: magpie's own index
// leaves it out of firstOwn for the same reason. It never carries
// providerAccount, so it is never a row of this account's either.
test("a backfilled row of a client's does not end the read", () => {
  const now = at("2026-10-22T12:00:00+08:00")
  const rows = spread(now - 70 * AN_HOUR, now - AN_HOUR)
  const reported = (t) => ({ t: new Date(t).toISOString(), agent: "myapp", provider: "openai", model: "gpt-5", in: 10, out: 5, status: 200, rid: "r1", source: "reported" })
  // one, dated a day and an hour ago, and a batch of 50 behind the same run
  for (const backfilled of [[reported(now - 25 * AN_HOUR)], Array.from({ length: 50 }, (_, i) => reported(now - (60 + i) * AN_HOUR))]) {
    const root = writeLedger([...rows, ...backfilled].map((r) => JSON.stringify(r)))
    try {
      const whole = _internal.freeWindowOf(rows, "me@example.com", now)
      const read = _internal.freeWindowRows("me@example.com", now, root, {}, join(root, "nohome"))
      const w = read && _internal.freeWindowOf(read, "me@example.com", now)
      // the card is there, and reads as the whole ledger does
      expect(w).not.toBeNull()
      expect(w.amount).toBe(whole.amount)
      expect(w.resetsAt).toBe(whole.resetsAt)
      // and none of them is this account's row
      expect(read.every((r) => r.providerAccount === "me@example.com")).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

// The chain is this account's own: a refusal of another account's, or of a
// paid model, says nothing about where this account's window opened
test("another account's refusal does not pin this account", () => {
  const now = at("2026-10-22T12:00:00+08:00")
  const rows = spread(now - 70 * AN_HOUR, now - 1 * AN_HOUR)
  const root = spreadLedger(
    [...rows, row(new Date(now - 30 * AN_HOUR).toISOString(), { status: 429, account: "b@example.com", err: `${TIMEOUT_BEFORE_RESET}2026-10-22 09:00:00 UTC+8, alternatively, you can switch to the other models to continue using it.` })].sort((a, b) => Date.parse(a.t) - Date.parse(b.t)),
    now,
  )
  try {
    const whole = _internal.freeWindowOf(rows, "me@example.com", now)
    const read = _internal.freeWindowRows("me@example.com", now, root, {}, join(root, "nohome"))
    // the other account's row is not this account's, and is not kept either
    expect(read.every((r) => r.providerAccount === "me@example.com")).toBe(true)
    const w = _internal.freeWindowOf(read, "me@example.com", now)
    expect(w.amount).toBe(whole.amount)
    expect(w.resetsAt).toBe(whole.resetsAt)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A ledger under one chunk used to line the chain up by luck: the file's
// first line was parsed and kept even after the loop had stopped on an older
// row, so a stray row far back opened the window and the answer was right by
// accident. It is kept only when the read runs to the file's start.
test("the file's first line is kept only when the read runs to the start", () => {
  const now = at("2026-10-20T20:00:00+08:00")
  const lines = [
    JSON.stringify(row(new Date(now - 20 * 3600_000).toISOString(), { in: 1 })), // the file's first line
    JSON.stringify(row(new Date(now - 10 * 3600_000).toISOString(), { in: 2 })),
    JSON.stringify(row(new Date(now - 60 * 60_000).toISOString(), { in: 3 })),
  ]
  const root = writeLedger(lines)
  try {
    const rows = _internal.freeWindowRows("me@example.com", now, root, {}, join(root, "nohome"))
    // with no edge in reach the read goes back to the start, and then the
    // first line is a row of the ledger like any other
    expect(rows.map((r) => r.in)).toEqual([1, 2, 3])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  // a day's gap stops the read with rows under it: the first line is under
  // that stop and is not kept
  const gap = at("2026-10-20T20:00:00+08:00")
  const stopped = writeLedger([
    JSON.stringify(row(new Date(gap - 90 * 3600_000).toISOString(), { in: 1 })), // under the stop
    JSON.stringify(row(new Date(gap - 80 * 3600_000).toISOString(), { in: 2 })), // the gap's earlier side
    JSON.stringify(row(new Date(gap - 50 * 3600_000).toISOString(), { in: 3 })), // 30h later: a window opens
    JSON.stringify(row(new Date(gap - 3600_000).toISOString(), { in: 4 })),
  ])
  try {
    const rows = _internal.freeWindowRows("me@example.com", gap, stopped, {}, join(stopped, "nohome"))
    // 3 and 4: the day before the gap's later row stopped the read, and the
    // first line, 10h under it, is not kept
    expect(rows.map((r) => r.in)).toEqual([3, 4])
  } finally {
    rmSync(stopped, { recursive: true, force: true })
  }
})

// The read must be bounded by what it can report, not by how busy the account
// is. A ledger of another provider's rows, with this account's only row 60
// days back, is read from its end and stops a day in: a lapsed window is
// nothing to report, and no row above the day can open one.
test("a ledger of another provider's rows is not read whole", () => {
  const now = at("2026-10-20T20:00:00+08:00")
  const lines = [JSON.stringify(row(new Date(now - 60 * 24 * 3600_000).toISOString(), { in: 5 }))]
  // a fortnight of another provider's rows, a minute apart: nine days of them
  // are past the day the read stops at
  for (let i = 0; i < 20000; i++) lines.push(JSON.stringify(row(new Date(now - (20000 - i) * 60_000).toISOString(), { in: 1, provider: "zcode" })))
  const root = writeLedger(lines)
  try {
    let chunks = 0
    const path = join(root, "usage.jsonl")
    const got = _internal.readLedgerTail(path, statSync(path), now, () => chunks++, "me@example.com")
    const all = Math.ceil(statSync(path).size / 65536)
    // the read stops a day into the file, so a tenth of it or so, never all
    expect(chunks).toBeLessThan(all / 4)
    expect(chunks).toBeGreaterThan(0)
    expect(got.rows.filter((r) => r.provider === "workbuddy-ai").length).toBeLessThan(3)
    expect(_internal.freeWindowOf(got.rows, "me@example.com", now)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// an account used would otherwise be read whole when that account has no
// refusal and only its own rows to go on: those rows stop the read, at the
// tail or where the chain is pinned
test("the read of an account's own rows still stops", () => {
  const now = at("2026-10-20T20:00:00+08:00")
  const lines = []
  for (let i = 6000; i >= 1; i--) lines.push(JSON.stringify(row(new Date(now - i * 60_000).toISOString(), { in: 1 })))
  const root = writeLedger(lines)
  try {
    let chunks = 0
    const path = join(root, "usage.jsonl")
    _internal.readLedgerTail(path, statSync(path), now, () => chunks++)
    // 6000 rows is ~2300 hours of 1-minute rows; only the last 48h + a day
    // of one-hour steps bear on the chain
    expect(chunks).toBeLessThan(800)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Two refusals in one chain: the oldest names a window that ended long ago and
// whose reset is behind us, the newest names one still running. pinned walks
// the rows oldest to newest and overwrites, so the newest refusal wins — it is
// nearer to now and its reset is the tighter bound on where the chain can be
// read from. The old `reset < newest` guard is gone; this pins what replaced it.
test("of two refusals in the chain, the newest one pins the read", () => {
  const now = at("2026-10-22T12:00:00+08:00")
  const at8 = (h) => `${new Date(now - h * AN_HOUR).toISOString().slice(0, 19).replace("T", " ")} UTC+8`
  const refusalAt = (h, reset) => row(new Date(now - h * AN_HOUR).toISOString(), { status: 429, err: `${TIMEOUT_BEFORE_RESET}${reset}, alternatively, you can switch to the other models to continue using it.` })
  // an old refusal whose reset lapsed 2 days ago, then a live one 6h back
  const old = refusalAt(54, at8(30))
  const live = refusalAt(6, at8(-18))
  const rows = [old, ...spread(now - 54 * AN_HOUR + AN_HOUR, now - 7 * AN_HOUR), live].sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
  expect(rows.at(-1)).toBe(live)
  // pinned's contract: latest first
  const got = _internal.pinned([...rows].reverse(), "me@example.com")
  const liveReset = at(at8(-18).replace(" UTC+8", "+08:00"))
  const oldReset = at(at8(30).replace(" UTC+8", "+08:00"))
  expect(got).toBe(liveReset - 86400_000)
  expect(got).not.toBe(oldReset - 86400_000)
})

// One unreadable row in the middle of the chain: pinned passes over it rather
// than ending the chain at it, so the bound is the same as the whole chain's.
// Swap `if (!Number.isFinite(t)) continue` back to `return Infinity` and this
// fails: the corrupt row becomes the bound, and the read would go back to the
// file's start instead of stopping where the clean chain stops.
test("a row whose time cannot be read is passed over", () => {
  const now = at("2026-10-22T12:00:00+08:00")
  // hourly for 100h, then nothing until 20h ago, then hourly: two runs a day
  // or more apart, so the row after the second gap pins the chain
  const clean = spread(now - 100 * AN_HOUR, now - 50 * AN_HOUR).concat(spread(now - 20 * AN_HOUR, now))
  const latestFirst = [...clean].sort((a, b) => Date.parse(b.t) - Date.parse(a.t))
  const bound = _internal.pinned(latestFirst, "me@example.com")
  // a real bound, not the "no edge, read from the start" 0: walked oldest to
  // newest, the first day-wide gap is the one before the 50h row, and that is
  // where the chain can first be read from
  expect(bound).not.toBe(0)
  expect(bound).toBe(now - 50 * AN_HOUR - A_DAY)
  // the same chain with one row in its middle carrying no readable t
  const holey = latestFirst.map((r) => (Date.parse(r.t) === now - 60 * AN_HOUR ? { ...r, t: "not-a-time" } : r))
  expect(holey.some((r) => r.t === "not-a-time")).toBe(true)
  // the same bound, not Infinity and not the 0 of a chain with no edge
  expect(_internal.pinned(holey, "me@example.com")).toBe(bound)
})
