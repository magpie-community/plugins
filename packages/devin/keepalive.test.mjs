// Devin's prompt cache lasts 5 minutes, with no longer TTL to ask for. The
// devin CLI keeps it warm (cache_keepalive.rs): after a reply it sends the
// same GetChatMessage again every 285 s with "continue" at the end and
// max_tokens 1. The plugin does the same when its switch is on (off by
// default), and stops on the conversation's next request, a refusal, two
// misses in a row or its most pings (plugins#592, zelong77).
import { afterEach, beforeEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { DevinAuthPlugin, _internal } from "./index.mjs"

const { PB, frame, fields, buildMessages, build, keepalivePing, keepaliveKey, KEEPALIVE } = _internal
const dec = new TextDecoder()
const enc = new TextEncoder()
const hex = (b) => Buffer.from(b ?? []).toString("hex")
const realFetch = globalThis.fetch
const configs = new Uint8Array(readFileSync(join(import.meta.dir, "testdata", "model-configs.bin")))

// fake timers: each set is held until the test fires it
let clock
// and a clock (now), which a timer's firing moves on to its time
const fakeTimers = () => {
  const q = []
  const c = {
    t: 1_000_000,
    now: () => c.t,
    q,
    set(fn, ms) {
      const t = { fn, ms, cleared: false, fired: false, unrefd: false, unref: () => (t.unrefd = true) }
      q.push(t)
      return t
    },
    clear(t) {
      t.cleared = true
    },
    live: () => q.filter((t) => !t.cleared && !t.fired),
    async fire() {
      const [t] = q.filter((t) => !t.cleared && !t.fired)
      if (!t) throw new Error("no timer to fire")
      t.fired = true
      c.t += t.ms
      await t.fn()
    },
  }
  return c
}
beforeEach(() => {
  clock = fakeTimers()
  _internal.useTimers(clock)
})
afterEach(() => {
  _internal.stopAllKeepalive()
  _internal.useTimers()
  globalThis.fetch = realFetch
})

// unframe is a request's one message, gunzipped when it was
const unframe = (b) => {
  const d = b.subarray(5)
  return b[0] & 1 ? new Uint8Array(gunzipSync(d)) : d
}
const prompts = (msg) => fields(msg).filter((f) => f.num === 3)
const textOf = (p) => dec.decode(fields(p.data).find((g) => g.num === 3)?.data ?? new Uint8Array())
const isPing = (msg) => textOf(prompts(msg).at(-1)) === "continue"

const endFrame = (obj = {}) => {
  const b = enc.encode(JSON.stringify(obj))
  const out = new Uint8Array(5 + b.length)
  out[0] = 2
  new DataView(out.buffer).setUint32(1, b.length)
  out.set(b, 5)
  return out
}
// a reply of a word and its usage: input, cache write, cache read
const answer = ({ input = 10, write = 0, read = 0 } = {}) =>
  new Response(new Blob([frame(new PB().str(3, "ok").varint(5, 1).bytes(7, new PB().varint(2, input).varint(3, 1).varint(4, write).varint(5, read)).done()), endFrame()]))

// devin fakes Devin: the model configs, each real request's answer (a cache
// write and read by default) and each ping's from pings, in turn
let sent, pings, real
const devin = () => {
  sent = []
  pings = []
  real = () => answer({ write: 200, read: 9000 })
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.endsWith("/GetCliModelConfigs")) return new Response(configs)
    if (!u.endsWith("/GetChatMessage")) return new Response("", { status: 404 })
    const msg = unframe(init.body)
    const ping = isPing(msg)
    sent.push({ ping, msg })
    if (!ping) return real()
    const next = pings.shift() ?? (() => answer({ input: 3, read: 9200 }))
    return next()
  }
}
const pingsSent = () => sent.filter((s) => s.ping).length

const SERVER = "https://devin.test"
const auth = { type: "api", key: "k", metadata: { server: SERVER } }
// plugin is the loader's fetch with the switch on or off, and the plugin's
// options
const plugin = async (on, options) => {
  const hooks = await DevinAuthPlugin({ magpie: { option: (p, k) => on && p === "devin" && k === KEEPALIVE } }, options)
  const { fetch } = await hooks.auth.loader(async () => auth)
  return async (chat, headers = {}) => {
    const res = await fetch("https://server.codeium.com/devin/v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "swe-2", ...chat }) })
    expect(res.status).toBe(200)
    await res.text()
  }
}
const lead = (...more) => ({ messages: [{ role: "system", content: "You are the lead." }, { role: "user", content: "fix the build" }, ...more] })
const sub = { messages: [{ role: "system", content: "You are an explore subagent." }, { role: "user", content: "find the test files" }] }

test("a ping is the request, byte for byte, with \"continue\" at the end and max_tokens 1", () => {
  const mark = { type: "ephemeral" }
  const req = {
    model: "claude-haiku-5-5",
    max_tokens: 32000,
    system: [{ type: "text", text: "You are Claude Code.", cache_control: mark }],
    tools: [{ name: "Read", description: "Reads a file.", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "read a", cache_control: mark }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "A", cache_control: mark }] },
    ],
  }
  for (const msg of [buildMessages(req, "claude-haiku-5-5", "k"), build({ model: "swe-2", max_tokens: 500, messages: [{ role: "user", content: "hi" }] }, "swe-2", "k")]) {
    const ping = keepalivePing(msg)
    const was = fields(msg)
    const now = fields(ping)
    const last = was.findLastIndex((f) => f.num === 3)
    // every field as it was, the extra prompt after the last, field 8 apart
    const shape = (fs) => fs.map((f) => [f.num, f.wire, f.num === 8 ? "" : f.wire === 0 ? f.n : hex(f.data)])
    expect(shape(now)).toEqual(shape([...was.slice(0, last + 1), now[last + 1], ...was.slice(last + 1)]))
    // the extra prompt is the user's "continue", unmarked
    const extra = fields(now[last + 1].data)
    expect(extra.find((g) => g.num === 2).n).toBe(1)
    expect(dec.decode(extra.find((g) => g.num === 3).data)).toBe("continue")
    expect(extra.some((g) => g.num === 8)).toBe(false)
    // the sampling is the same but for max_tokens (field 2), now 1
    const sampling = (fs) => fields(fs.find((f) => f.num === 8).data).map((g) => [g.num, g.wire === 0 ? g.n : hex(g.data)])
    expect(sampling(now)).toEqual(sampling(was).map(([n, v]) => [n, n === 2 ? 1 : v]))
    expect(sampling(now).find(([n]) => n === 2)[1]).toBe(1)
  }
})

test("off by default: a reply schedules nothing", async () => {
  devin()
  const ask = await plugin(false)
  await ask(lead())
  expect(clock.q).toEqual([])
  expect(_internal.keeping()).toEqual([])
})

test("after a reply, pings every 285 s on unref'd timers, up to 6, each the request again", async () => {
  devin()
  const ask = await plugin(true)
  await ask(lead())
  expect(clock.live().map((t) => [t.ms, t.unrefd])).toEqual([[285_000, true]])
  // and they stop with the plugin host's process
  expect(process.listeners("exit").some((fn) => fn.name === "stopAllKeepalive")).toBe(true)
  for (let i = 1; i <= 6; i++) {
    await clock.fire()
    expect(pingsSent()).toBe(i)
  }
  // the sixth was the last
  expect(clock.live()).toEqual([])
  expect(_internal.keeping()).toEqual([])
  // each ping is the real request's prompts and one more
  const first = sent[0].msg
  for (const s of sent.slice(1)) {
    expect(prompts(s.msg).length).toBe(prompts(first).length + 1)
    expect(prompts(s.msg).slice(0, -1).map((p) => hex(p.data))).toEqual(prompts(first).map((p) => hex(p.data)))
  }
})

test("the interval and the most pings are the plugin's options", async () => {
  devin()
  const ask = await plugin(true, { cacheKeepaliveInterval: 120, cacheKeepaliveMaxPings: 2 })
  await ask(lead())
  expect(clock.live().map((t) => t.ms)).toEqual([120_000])
  await clock.fire()
  await clock.fire()
  expect(pingsSent()).toBe(2)
  expect(clock.live()).toEqual([])
  // out of range is the default
  expect(_internal.keepaliveSettings({ cacheKeepaliveInterval: 600, cacheKeepaliveMaxPings: 0 })).toEqual({ interval: 285_000, max: 6 })
})

test("the conversation's next request stops its pings, and its reply starts them again", async () => {
  devin()
  const ask = await plugin(true)
  await ask(lead())
  const [t1] = clock.live()
  // stopped when the request comes, not only when its reply starts new ones
  let stoppedBefore
  real = () => ((stoppedBefore = t1.cleared), answer({ write: 300, read: 9000 }))
  await ask(lead({ role: "assistant", content: "done" }, { role: "user", content: "thanks, now run the tests" }))
  expect(stoppedBefore).toBe(true)
  expect(t1.cleared).toBe(true)
  expect(clock.live().length).toBe(1)
  expect(_internal.keeping().length).toBe(1)
  expect(pingsSent()).toBe(0)
})

test("a subagent's request doesn't stop its lead's pings, nor the lead's its", async () => {
  devin()
  const ask = await plugin(true)
  const session = { "x-claude-code-session-id": "s1" }
  await ask(lead(), session)
  const [leadTimer] = clock.live()
  await ask(sub, { ...session, "x-claude-code-agent-id": "a1" })
  expect(leadTimer.cleared).toBe(false)
  expect(clock.live().length).toBe(2)
  const [, subTimer] = clock.live()
  await ask(lead({ role: "assistant", content: "done" }, { role: "user", content: "next" }), session)
  expect(leadTimer.cleared).toBe(true)
  expect(subTimer.cleared).toBe(false)
  // the same prefix under another agent id or session is another conversation
  const chat = lead()
  expect(keepaliveKey(chat, false, { "x-claude-code-agent-id": "a1" })).not.toBe(keepaliveKey(chat, false, { "x-claude-code-agent-id": "a2" }))
  expect(keepaliveKey(chat, false, { "x-claude-code-session-id": "s1" })).not.toBe(keepaliveKey(chat, false, { "x-claude-code-session-id": "s2" }))
  // and a turn's growing history, or a cache mark moving on, is the same one
  const req = (mark) => ({ system: [{ type: "text", text: "S", cache_control: mark }], messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: mark }] }] })
  expect(keepaliveKey(req({ type: "ephemeral" }), true, {})).toBe(keepaliveKey({ ...req(undefined), messages: [...req(undefined).messages, { role: "assistant", content: "x" }] }, true, {}))
})

for (const [name, reply] of [
  ["a usage limit (429)", () => new Response(endFrame({ error: { code: "resource_exhausted", message: "rate limit" } }))],
  ["a refused key (401)", () => new Response(JSON.stringify({ code: "unauthenticated", message: "bad key" }), { status: 401 })],
  ["no credit (402)", () => new Response("", { status: 402 })],
]) {
  test(`${name} stops the pings`, async () => {
    devin()
    const ask = await plugin(true)
    await ask(lead())
    pings.push(reply)
    await clock.fire()
    expect(pingsSent()).toBe(1)
    expect(clock.live()).toEqual([])
    expect(_internal.keeping()).toEqual([])
  })
}

test("two pings in a row that read under half their prompt from the cache stop them; a hit between keeps them going", async () => {
  devin()
  const ask = await plugin(true)
  await ask(lead())
  const miss = () => answer({ input: 9000, write: 9000, read: 200 })
  const hit = () => answer({ input: 3, read: 9200 })
  pings.push(miss, hit, miss, miss)
  await clock.fire() // miss
  await clock.fire() // hit
  await clock.fire() // miss
  expect(clock.live().length).toBe(1)
  await clock.fire() // miss again: stop
  expect(pingsSent()).toBe(4)
  expect(clock.live()).toEqual([])
  expect(_internal.keeping()).toEqual([])
})

test("a reply that read and wrote nothing of the cache has nothing to keep", async () => {
  devin()
  real = () => answer({ input: 500 })
  const ask = await plugin(true)
  await ask(lead())
  expect(clock.q).toEqual([])
})

test("turning the switch off stops every conversation's pings", async () => {
  devin()
  let on = true
  const hooks = await DevinAuthPlugin({ magpie: { option: () => on } })
  const { fetch } = await hooks.auth.loader(async () => auth)
  const ask = (chat) => fetch("https://server.codeium.com/devin/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "swe-2", ...chat }) }).then((r) => r.text())
  await ask(lead())
  await ask(sub)
  expect(clock.live().length).toBe(2)
  on = false
  await ask({ messages: [{ role: "user", content: "another conversation" }] })
  expect(clock.live()).toEqual([])
  expect(_internal.keeping()).toEqual([])
})

test("in OpenCode, the plugin's option cacheKeepalive turns it on", async () => {
  devin()
  const hooks = await DevinAuthPlugin({}, { cacheKeepalive: true })
  const { fetch } = await hooks.auth.loader(async () => auth)
  await (await fetch("https://server.codeium.com/devin/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "swe-2", ...lead() }) })).text()
  expect(clock.live().length).toBe(1)
})

test("the switch says its words in magpie's languages, off by default", async () => {
  const hooks = await DevinAuthPlugin({})
  const o = hooks.auth.options.find((x) => x.key === KEEPALIVE)
  expect(o.default).toBeUndefined()
  expect(Object.keys(o.labels)).toEqual(["zh", "zh-TW", "ja", "de"])
  expect(Object.keys(o.descriptions)).toEqual(["zh", "zh-TW", "ja", "de"])
  for (const d of [o.description, ...Object.values(o.descriptions)]) expect(d.length).toBeLessThanOrEqual(300)
})

// magpie.usage (plugins#592): each ping goes to magpie's request log, on
// the request's model and account, as the pings never pass its gateway
const reporting = async (calls, account = "devin#a1") => {
  const magpie = { option: (p, k) => p === "devin" && k === KEEPALIVE, account: (p) => (p === "devin" ? account : undefined), usage: (p, c) => (calls.push({ p, ...c }), true) }
  const hooks = await DevinAuthPlugin({ magpie })
  const { fetch } = await hooks.auth.loader(async () => auth)
  return async (chat) => (await fetch("https://server.codeium.com/devin/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "swe-2", ...chat }) })).text()
}

test("each ping is told to magpie, with its tokens, model and account; a failed one with why", async () => {
  devin()
  const calls = []
  const ask = await reporting(calls)
  await ask(lead())
  expect(calls).toEqual([]) // the real request is the gateway's to count
  pings.push(() => answer({ input: 3, read: 9200 }), () => new Response(JSON.stringify({ code: "unauthenticated", message: "bad key" }), { status: 401 }))
  await clock.fire()
  await clock.fire()
  expect(calls.length).toBe(2)
  const [ok, bad] = calls
  expect(ok).toMatchObject({ p: "devin", kind: KEEPALIVE, model: "swe-2", account: "devin#a1", input: 3, output: 1, cacheRead: 9200, cacheWrite: 0, status: 200 })
  expect(ok.error).toBeUndefined()
  expect(typeof ok.ms).toBe("number")
  expect(bad).toMatchObject({ kind: KEEPALIVE, model: "swe-2", status: 401 })
  expect(bad.error).toContain("bad key")
})

test("a ping cut short by the conversation's next request isn't told", async () => {
  devin()
  const calls = []
  const ask = await reporting(calls)
  await ask(lead())
  let held
  pings.push(() => new Promise((_, no) => (held = no)))
  const fired = clock.fire()
  await Bun.sleep(0)
  // the next request stops the conversation's pings, aborting the one out
  await ask(lead({ role: "assistant", content: "done" }, { role: "user", content: "next" }))
  held(new DOMException("aborted", "AbortError"))
  await fired
  expect(pingsSent()).toBe(1)
  expect(calls).toEqual([])
})

test("an older magpie, with no magpie.usage, is told nothing and the pings go on", async () => {
  devin()
  const ask = await plugin(true)
  await ask(lead())
  await clock.fire()
  expect(pingsSent()).toBe(1)
  expect(clock.live().length).toBe(1)
})

test("package.json gives magpie's Options editor the two settings' defaults", async () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8"))
  const { interval, max } = _internal.keepaliveSettings({})
  expect(pkg.magpie.options).toEqual({ cacheKeepaliveInterval: interval / 1000, cacheKeepaliveMaxPings: max })
})

// plugins#620 (zelong77): Claude Code Auto's permission check sends the
// history in its first user message, which grows on every check. Each
// check's key was new, so its older pings were never stopped and piled up.
// zelong77's offline repro, with its literal requests.
const check = {
  model: "claude-sonnet-5-5",
  max_tokens: 16,
  system: [{ type: "text", text: "Permission classifier" }],
  messages: [
    { role: "user", content: [{ type: "text", text: "History A", cache_control: { type: "ephemeral" } }] },
    { role: "user", content: [{ type: "text", text: "Evaluate operation" }] },
  ],
}
const grown = (req, text) => {
  const b = structuredClone(req)
  b.messages[0].content.push({ type: "text", text, cache_control: { type: "ephemeral" } })
  return b
}
const arrive = (req, headers) => {
  const id = keepaliveKey(req, true, headers)
  _internal.stopKeepalive(id)
  const msg = buildMessages(req, "claude-sonnet-5-5", "fake-key")
  _internal.scheduleKeepalive({ id, interval: 285000, max: 6 }, "fake-key", "https://example.invalid", msg)
  return id
}
const session = { "x-claude-code-session-id": "same-session", "x-claude-code-agent-id": "same-agent" }

for (const [name, headers] of [["with no session named", {}], ["in one session and agent", session]]) {
  test(`a permission check whose history grew replaces its pings, ${name} (plugins#620)`, () => {
    globalThis.fetch = () => {
      throw new Error("Network forbidden")
    }
    const oldKey = arrive(check, headers)
    arrive(check, headers)
    expect(_internal.keeping().length).toBe(1)
    const b = grown(check, "History B")
    expect(arrive(b, headers)).toBe(oldKey)
    expect(_internal.keeping()).toEqual([oldKey])
    expect(clock.live().length).toBe(1)
    // and again, from the grown one
    expect(arrive(grown(b, "History C"), headers)).toBe(oldKey)
    expect(clock.live().length).toBe(1)
  })
}

test("a first message whose last text grew is the same conversation (plugins#620)", () => {
  const a = { system: "S", messages: [{ role: "user", content: "History A" }] }
  const b = { system: "S", messages: [{ role: "user", content: "History A, then B" }] }
  const before = keepaliveKey(a, true, {})
  expect(keepaliveKey(b, true, {})).toBe(before)
})

test("conversations that really differ keep their own pings (plugins#620)", () => {
  // no session named: another first message is another conversation
  const a = { system: "S", messages: [{ role: "user", content: [{ type: "text", text: "History A" }] }] }
  const other = { system: "S", messages: [{ role: "user", content: [{ type: "text", text: "Something else" }] }] }
  const aKey = keepaliveKey(a, true, {})
  expect(keepaliveKey(other, true, {})).not.toBe(aKey)
  // one that only shares its first block's start isn't grown from it
  const shorter = { system: "S", messages: [{ role: "user", content: [{ type: "text", text: "History" }, { type: "text", text: "x" }] }] }
  expect(keepaliveKey(shorter, true, {})).not.toBe(aKey)
  // in one session: the lead, its permission check and a subagent
  const s = { "x-claude-code-session-id": "s1" }
  const leadReq = { system: "You are Claude Code.", tools: [{ name: "Bash" }], messages: [{ role: "user", content: "fix the build" }] }
  const keys = new Set([keepaliveKey(leadReq, true, s), keepaliveKey(check, true, s), keepaliveKey(leadReq, true, { ...s, "x-claude-code-agent-id": "a1" })])
  expect(keys.size).toBe(3)
  // and a grown check stops only the check's pings
  globalThis.fetch = () => {
    throw new Error("Network forbidden")
  }
  arrive(leadReq, s)
  arrive(check, s)
  arrive(grown(check, "History B"), s)
  expect(_internal.keeping().length).toBe(2)
})

// plugins#626 (zelong77): the pings were timed from the reply's end, and
// each from the end of the ping before. Devin renews its cache when it
// takes a request, so a long reply or a slow ping put the next ping past
// the cache's 5 minutes: 285 s after a 33.5 s reply was 318.5 s after the
// request, a miss that wrote 503,797 tokens again. Each is timed from when
// the request before it was sent.
test("the first ping is 285 s after the request was sent, not after its reply (plugins#626)", async () => {
  devin()
  const ask = await plugin(true)
  // zelong77's slowest reply, 46.8 s
  real = () => ((clock.t += 46_800), answer({ write: 200, read: 9000 }))
  await ask(lead())
  expect(clock.live().map((t) => t.ms)).toEqual([285_000 - 46_800])
  // a ping that took 15 s: the next goes 285 s after it was sent
  pings.push(() => ((clock.t += 15_000), answer({ input: 3, read: 9200 })))
  const sentAt = clock.t + clock.live()[0].ms
  await clock.fire()
  expect(pingsSent()).toBe(1)
  expect(clock.live().map((t) => t.ms)).toEqual([285_000 - 15_000])
  expect(sentAt + 285_000).toBe(clock.t + clock.live()[0].ms)
  // a quick one waits its whole interval, less what it took
  pings.push(() => answer({ input: 3, read: 9200 }))
  await clock.fire()
  expect(clock.live().map((t) => t.ms)).toEqual([285_000])
})

test("a reply that took longer than the interval is followed by a ping at once (plugins#626)", async () => {
  devin()
  const ask = await plugin(true)
  real = () => ((clock.t += 300_000), answer({ write: 200, read: 9000 }))
  await ask(lead())
  expect(clock.live().map((t) => t.ms)).toEqual([0])
  // and a ping that took longer than the interval too
  pings.push(() => ((clock.t += 290_000), answer({ input: 3, read: 9200 })))
  await clock.fire()
  expect(clock.live().map((t) => t.ms)).toEqual([0])
})

// plugins#620, after 0.1.33 (zelong77, 11-02): magpie hands a plugin's fetch
// none of the agent's own headers, so x-claude-code-session-id never
// reached the key, and magpie's translation merges Claude Code's two user
// messages into one: [fixed instructions, transcript…, current operation].
// The transcript grows in the middle of it, which firstOf can't follow, so
// checks A and B kept separate pings. magpie now names the session the
// agent named (x-magpie-session) and its Claude Code subagent
// (x-magpie-subagent) to the plugin.
const merged = (history, op) => ({
  model: "claude-haiku-5-5",
  max_tokens: 64,
  system: [{ type: "text", text: "Permission classifier" }],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Fixed instructions", cache_control: { type: "ephemeral" } },
        ...history.map((text) => ({ type: "text", text })),
        { type: "text", text: "Current operation:" },
        { type: "text", text: op },
      ],
    },
  ],
})
const mainTurn = { model: "claude-haiku-5-5", max_tokens: 64, system: [{ type: "text", text: "You are Claude Code." }], messages: [{ role: "user", content: "fix the build" }] }

test("magpie's session header keys a permission check whose merged history grew in the middle (plugins#620)", async () => {
  devin()
  const hooks = await DevinAuthPlugin({ magpie: { option: (p, k) => p === "devin" && k === KEEPALIVE } })
  const { fetch } = await hooks.auth.loader(async () => auth)
  const ask = async (req, headers) => {
    const res = await fetch("https://server.codeium.com/devin/v1/messages", { method: "POST", headers, body: JSON.stringify(req) })
    expect(res.status).toBe(200)
    await res.text()
  }
  const s = { "x-magpie-session": "cc-session-1" }
  // check A, the main conversation C, then check B with the history grown
  await ask(merged(["Bash ls"], "Bash rm a"), s)
  const [a] = clock.live()
  await ask(mainTurn, s)
  const [, c] = clock.live()
  await ask(merged(["Bash ls", "Bash cat b"], "Bash rm b"), s)
  expect(a.cleared).toBe(true)
  expect(c.cleared).toBe(false)
  expect(clock.live().length).toBe(2)
  expect(_internal.keeping().length).toBe(2)
  // a subagent magpie names is a conversation of its own in that session
  await ask(mainTurn, { ...s, "x-magpie-subagent": "agent-1" })
  expect(c.cleared).toBe(false)
  expect(clock.live().length).toBe(3)
  // the same keys as Claude Code's own headers give
  expect(keepaliveKey(mainTurn, true, { "x-magpie-session": "x", "x-magpie-subagent": "a" })).toBe(keepaliveKey(mainTurn, true, { "x-claude-code-session-id": "x", "x-claude-code-agent-id": "a" }))
})
