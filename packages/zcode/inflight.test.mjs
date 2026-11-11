// What ZCode's own client (3.17.2) does with its Start Plan's in-flight cap,
// the plugin does: an account's requests go a few at a time (startGate), the
// rest wait their turn here instead of being sent to be refused, a refusal
// (3008/3009/3010) is asked again twice, after 1s and 2s, and the firewall
// hold counts only a refusal that a re-ask didn't get past. The requests go
// to a local Bun.serve that counts what is in flight; nothing reaches z.ai.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"
import { ZCodeAuthPlugin, _internal } from "./index.mjs"

const { BUSY_WAITS, startGate, busyHold } = _internal
const WAITS = [...BUSY_WAITS]
const GATE = { ...startGate, lanes: undefined, narrow: undefined }

let server
const got = [] // every request the fake took: when, whose
let answer = null // (req) => Response, what the fake answers
const now = { flight: new Map(), peak: new Map() } // in flight per account
beforeAll(() => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const who = req.headers.get("authorization") ?? ""
      const path = new URL(req.url).pathname
      const n = (now.flight.get(who) ?? 0) + 1
      now.flight.set(who, n)
      now.peak.set(who, Math.max(now.peak.get(who) ?? 0, n))
      got.push({ at: Date.now(), who, path, flight: n })
      try {
        await req.text()
        return answer ? await answer({ who, flight: n, path }) : Response.json({ type: "message", content: [] })
      } finally {
        now.flight.set(who, now.flight.get(who) - 1)
      }
    },
  })
})
afterAll(() => server?.stop(true))

const real = globalThis.fetch
const HOSTS = ["https://zcode.z.ai", "https://api.z.ai", "https://open.bigmodel.cn"]
beforeEach(() => {
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const host = HOSTS.find((h) => url.startsWith(h + "/"))
    if (!host) throw new Error("no network in tests: " + url)
    return real(`http://127.0.0.1:${server.port}/${new URL(host).host}${url.slice(host.length)}`, init)
  }
  got.length = 0
  answer = null
  now.flight.clear()
  now.peak.clear()
  _internal.routes.clear()
  _internal.blocked.clear()
})
afterEach(() => {
  globalThis.fetch = real
  BUSY_WAITS.splice(0, BUSY_WAITS.length, ...WAITS)
  startGate.inflight = GATE.inflight
  startGate.wait = GATE.wait
  startGate.lanes.clear()
  startGate.narrow.clear()
  startGate.now = () => Date.now()
  busyHold.until = 0
  busyHold.hits.length = 0
  busyHold.now = () => Date.now()
  _internal.edge.until = 0
})

const DEVICE = "11111111-2222-4333-8444-555555555555"
const jwtOf = (n) => ["{}", JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, n })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
const startAuth = (n = 1) => {
  const jwt = jwtOf(n)
  return { type: "oauth", access: jwt, refresh: JSON.stringify({ site: "zai", device: DEVICE, jwt, plan: "Start Plan" }), expires: 0 }
}
const planAuth = () => ({ type: "api", key: "one.secret", metadata: { site: "zai" } })
const BODY = JSON.stringify({ model: "GLM-5.3", max_tokens: 16, messages: [{ role: "user", content: "hi" }] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CAP = () => Response.json({ code: 3008, msg: "user concurrency limit exceeded" }, { status: 429 })
const OK = () => Response.json({ type: "message", content: [] })
const messages = () => got.filter((r) => r.path.endsWith("/messages"))

async function loader(auth) {
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  return hooks.auth.loader(async () => auth, { id: "zcode" })
}

// one sends a request through opts and reads its answer to the end, as an
// agent's client does
async function one(opts, signal) {
  const res = await opts.fetch("https://api.z.ai/api/anthropic/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "zcode", "anthropic-version": "2023-06-01" },
    body: BODY,
    signal,
  })
  return { status: res.status, text: await res.text(), retryAfter: res.headers.get("retry-after") }
}

test("a cap is asked again twice, after 1s and 2s, then goes back to magpie", async () => {
  answer = CAP
  const opts = await loader(startAuth())
  const res = await one(opts)
  expect(res.status).toBe(429)
  // three asks: the first and two again (0.1.55 asked seven times)
  const asks = messages()
  expect(asks.length).toBe(3)
  const gaps = [asks[1].at - asks[0].at, asks[2].at - asks[1].at]
  expect(gaps[0]).toBeGreaterThanOrEqual(950)
  expect(gaps[0]).toBeLessThan(1600)
  expect(gaps[1]).toBeGreaterThanOrEqual(1950)
  expect(gaps[1]).toBeLessThan(2600)
  expect(JSON.parse(res.text).msg).toContain("asked again after 1s and 2s")
})

test("3010 is a cap too, as ZCode's client reads it", async () => {
  BUSY_WAITS.splice(0, BUSY_WAITS.length, 1, 1)
  let n = 0
  answer = () => (++n === 1 ? Response.json({ code: "3010", msg: "busy" }, { status: 429 }) : OK())
  const res = await one(await loader(startAuth()))
  expect(res.status).toBe(200)
  expect(messages().length).toBe(2)
})

test("twelve Start Plan requests at once: three of an account in flight, the rest wait their turn", async () => {
  answer = async () => {
    await sleep(60)
    return OK()
  }
  const opts = await loader(startAuth())
  const rs = await Promise.all(Array.from({ length: 12 }, () => one(opts)))
  expect(rs.every((r) => r.status === 200)).toBe(true)
  // every request sent once, never more than three at once (0.1.55: 12)
  expect(messages().length).toBe(12)
  expect(Math.max(...now.peak.values())).toBe(3)
})

test("each account has slots of its own", async () => {
  answer = async () => {
    await sleep(60)
    return OK()
  }
  const [a, b] = await Promise.all([loader(startAuth(1)), loader(startAuth(2))])
  const rs = await Promise.all([...Array.from({ length: 5 }, () => one(a)), ...Array.from({ length: 5 }, () => one(b))])
  expect(rs.every((r) => r.status === 200)).toBe(true)
  expect([...now.peak.values()]).toEqual([3, 3])
})

test("a slot is held across the re-asks, and let go when the answer has been read", async () => {
  BUSY_WAITS.splice(0, BUSY_WAITS.length, 50, 50)
  const opts = await loader(startAuth())
  let n = 0
  answer = () => (++n <= 3 ? CAP() : OK())
  // the first three are capped once each and wait 50ms with their slots; a
  // fourth sent meanwhile waits behind them rather than adding to the cap
  const rs = await Promise.all(Array.from({ length: 4 }, () => one(opts)))
  expect(rs.every((r) => r.status === 200)).toBe(true)
  expect(Math.max(...now.peak.values())).toBeLessThanOrEqual(3)
  // the fourth went out only once a slot was let go: after a re-ask
  const asks = messages()
  expect(asks.length).toBe(7)
  expect(asks.slice(0, 3).every((r) => r.at < asks[3].at)).toBe(true)
})

test("a wait that runs out is answered here, plainly, and nothing is sent", async () => {
  startGate.wait = 150
  let free = () => {}
  const held = new Promise((r) => (free = r))
  answer = async () => {
    await held
    return OK()
  }
  const opts = await loader(startAuth())
  const first = Array.from({ length: 3 }, () => one(opts))
  while (messages().length < 3) await sleep(5)
  const t0 = Date.now()
  const late = await one(opts)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(140)
  expect(late.status).toBe(429)
  expect(late.retryAfter).toBe("5")
  const e = JSON.parse(late.text).error
  expect(e.type).toBe("rate_limit_error")
  expect(e.message).toContain("serves this account 3 requests at a time")
  expect(e.message).toContain("was not sent")
  expect(messages().length).toBe(3)
  free()
  expect((await Promise.all(first)).every((r) => r.status === 200)).toBe(true)
  // the slots are back: the next request goes out at once
  expect((await one(opts)).status).toBe(200)
  expect(messages().length).toBe(4)
})

test("an agent that gives up while waiting leaves the queue", async () => {
  let free = () => {}
  const held = new Promise((r) => (free = r))
  answer = async () => {
    await held
    return OK()
  }
  const opts = await loader(startAuth())
  const first = Array.from({ length: 3 }, () => one(opts))
  while (messages().length < 3) await sleep(5)
  const ctl = new AbortController()
  const gone = one(opts, ctl.signal)
  const next = one(opts)
  await sleep(20)
  ctl.abort()
  await expect(gone).rejects.toThrow()
  free()
  await Promise.all(first)
  expect((await next).status).toBe(200)
  // the request that gave up was never sent; the one behind it was
  expect(messages().length).toBe(4)
  expect(startGate.lanes.size).toBe(0)
})

test("a stream the agent stops reading lets its slot go", async () => {
  answer = () =>
    new Response(
      new ReadableStream({
        pull: async (c) => {
          await sleep(20)
          c.enqueue(new TextEncoder().encode("event: ping\ndata: {}\n\n"))
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  const opts = await loader(startAuth())
  const send = () => opts.fetch("https://api.z.ai/api/anthropic/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: BODY })
  const streams = await Promise.all([send(), send(), send()])
  const fourth = send()
  await sleep(50)
  expect(messages().length).toBe(3)
  const r = streams[0].body.getReader()
  await r.read()
  await r.cancel()
  const res = await fourth
  expect(res.status).toBe(200)
  expect(messages().length).toBe(4)
  for (const s of [res, ...streams.slice(1)]) await s.body.cancel()
})

test("the coding plan keeps no gate of the plugin's", async () => {
  answer = async () => {
    await sleep(60)
    return OK()
  }
  const opts = await loader(planAuth())
  const rs = await Promise.all(Array.from({ length: 8 }, () => one(opts)))
  expect(rs.every((r) => r.status === 200)).toBe(true)
  expect(Math.max(...now.peak.values())).toBe(8)
  expect(startGate.lanes.size).toBe(0)
})

test("a cap the 1s re-ask got past counts toward no hold", async () => {
  BUSY_WAITS.splice(0, BUSY_WAITS.length, 1, 1)
  const opts = await loader(startAuth())
  // every request is refused once, then served: a slot let go late, not a
  // saturated address (0.1.55 held the Start Plan after five of these)
  let n = 0
  answer = () => (n++ % 2 === 0 ? CAP() : OK())
  for (let i = 0; i < 8; i++) expect((await one(opts)).status).toBe(200)
  expect(busyHold.until).toBe(0)
  expect(busyHold.hits.length).toBe(0)
})

test("five requests refused again at their re-ask hold the Start Plan, in plain words", async () => {
  BUSY_WAITS.splice(0, BUSY_WAITS.length, 1, 1)
  const opts = await loader(startAuth())
  let n = 0
  // refused twice, then served at the 2s re-ask: still a sustained cap
  answer = () => (n++ % 3 < 2 ? CAP() : OK())
  for (let i = 0; i < 4; i++) expect((await one(opts)).status).toBe(200)
  expect(busyHold.until).toBe(0)
  // the fifth is refused again at its 1s re-ask: the hold arms, and its 2s
  // re-ask is not sent
  const fifth = await one(opts)
  expect(fifth.status).toBe(429)
  expect(messages().length).toBe(4 * 3 + 2)
  expect(busyHold.until).toBeGreaterThan(Date.now())
  const sent = messages().length
  const held = await one(opts)
  expect(held.status).toBe(429)
  expect(messages().length).toBe(sent)
  const said = JSON.parse(held.text).error.message
  expect(said).toContain("ZCode turned away 5 requests in the last minute as too many requests at once")
  expect(said).toContain("so that ZCode's firewall does not block this network".replace(/^s/, "S"))
  expect(said).toContain("Wait, run fewer agents or subagents on ZCode at once, or use a GLM Coding Plan model")
})

// The scenario of #801's two days of logs (11-05 23:06, 11-06 06:23): agents
// asking the Start Plan of one account ~18 times a minute, up to ten at once,
// against an in-flight cap of about three; the edge firewall blocked the IP
// 3–7.5 minutes in. Replayed here at 20× speed — a minute is 3s, each turn
// 5–12s (0.25–0.6s), the re-ask waits and the hold's clock scaled alike —
// against a fake that refuses past three in flight. The plugin's own requests
// never go past the cap, so the vendor never refuses one, nothing is asked
// twice and no hold is needed; the requests that came faster than three at a
// time could serve waited here instead.
test("replay of #801's logs: nothing past the cap reaches ZCode, nothing refused, no hold", async () => {
  const F = 20
  BUSY_WAITS.splice(0, BUSY_WAITS.length, ...WAITS.map((w) => w / F))
  startGate.wait = 120_000 / F
  const t0 = Date.now()
  busyHold.now = () => t0 + (Date.now() - t0) * F
  let refused = 0
  answer = async ({ flight }) => {
    if (flight > 3) {
      refused++
      return CAP()
    }
    await sleep((5_000 + Math.random() * 7_000) / F)
    return OK()
  }
  const opts = await loader(startAuth())
  // four minutes of arrivals, ~18 a minute, in bursts of up to five
  const sends = []
  let at = 0
  while (at < (4 * 60_000) / F) {
    const burst = 1 + Math.floor(Math.random() * 5)
    for (let i = 0; i < burst; i++) sends.push(sleep(at).then(() => one(opts)))
    at += (burst * 60_000) / 18 / F
  }
  const rs = await Promise.all(sends)
  expect(refused).toBe(0)
  expect(Math.max(...now.peak.values())).toBeLessThanOrEqual(3)
  expect(messages().length).toBe(rs.filter((r) => r.status === 200).length)
  expect(busyHold.until).toBe(0)
  // 3 slots of 5–12s turns serve ~25 a minute: every arrival was served
  expect(rs.every((r) => r.status === 200)).toBe(true)
}, 30_000)

// The same replay with the account's slots taken by someone else (the ZCode
// app, another computer): ZCode refuses this computer's requests on and on.
// The hold still trips inside the replayed minute, and from then on nothing
// is sent until it ends — the firewall's protection #801 added.
test("replay with the account saturated elsewhere: the hold still trips within a minute", async () => {
  const F = 20
  BUSY_WAITS.splice(0, BUSY_WAITS.length, ...WAITS.map((w) => w / F))
  const t0 = Date.now()
  busyHold.now = () => t0 + (Date.now() - t0) * F
  answer = CAP
  const opts = await loader(startAuth())
  const sends = []
  for (let i = 0; i < 36; i++) sends.push(sleep((i * 60_000) / 18 / F).then(() => one(opts)))
  const rs = await Promise.all(sends)
  expect(rs.every((r) => r.status === 429)).toBe(true)
  const armed = busyHold.until - _internal.BUSY_HOLD
  expect(armed - t0).toBeLessThan(60_000)
  // nothing went upstream after the hold armed (scaled back to real time)
  const armedReal = t0 + (armed - t0) / F
  expect(messages().filter((r) => r.at > armedReal + 5).length).toBe(0)
  // and the upstream asks stayed within three per request
  expect(messages().length).toBeLessThanOrEqual(3 * rs.length)
}, 30_000)

// plugins#438 (takomitkm, 0.1.57, default settings): one account, one agent,
// never more than two requests in flight, about five a minute — and the
// hold armed, and armed again a minute after it ended. ZCode served that
// account one request at a time: the second of each pair was refused, and
// again at its re-ask, while the first was still in flight. A cap this
// computer brought on itself by sending two at once narrows the account's
// gate to one instead of counting toward the firewall hold; the pairs after
// it go one at a time and are all served.
test("an account ZCode serves one at a time is narrowed to one, and no hold arms (plugins#438)", async () => {
  BUSY_WAITS.splice(0, BUSY_WAITS.length, 1, 1)
  let clock = 1_000_000_000_000
  busyHold.now = () => clock
  startGate.now = () => clock
  answer = async ({ flight }) => {
    if (flight >= 2) return CAP()
    await sleep(100)
    return OK()
  }
  const opts = await loader(startAuth())
  const pairs = []
  for (let i = 0; i < 5; i++) {
    clock += 12_000
    pairs.push(await Promise.all([one(opts), sleep(10).then(() => one(opts))]))
  }
  expect(busyHold.until).toBe(0)
  expect(busyHold.hits.length).toBe(0)
  const [key] = startGate.narrow.keys()
  expect(_internal.limitOf(key)).toBe(1)
  // the first pair's second request was refused through its re-asks; every
  // pair after it went one at a time and was served
  expect(pairs.slice(1).flat().every((r) => r.status === 200)).toBe(true)
  const after = got.filter((r) => r.path.endsWith("/messages")).slice(4)
  expect(Math.max(...after.map((r) => r.flight))).toBe(1)
})

// The narrowing ends by its own clock: NARROW_FOR on, the account's gate is
// back to three, and two go at once again.
test("a narrowed account's gate is back to three after NARROW_FOR", async () => {
  BUSY_WAITS.splice(0, BUSY_WAITS.length, 1, 1)
  let clock = 1_000_000_000_000
  busyHold.now = () => clock
  startGate.now = () => clock
  let capAt = 2
  answer = async ({ flight }) => {
    if (flight >= capAt) return CAP()
    await sleep(100)
    return OK()
  }
  const opts = await loader(startAuth())
  await Promise.all([one(opts), sleep(10).then(() => one(opts))])
  expect(startGate.narrow.size).toBe(1)
  const [key] = startGate.narrow.keys()
  expect(_internal.limitOf(key)).toBe(1)
  clock += _internal.NARROW_FOR - 1
  expect(_internal.limitOf(key)).toBe(1)
  clock += 1
  expect(_internal.limitOf(key)).toBe(3)
  expect(startGate.narrow.size).toBe(0)
  capAt = 4
  got.length = 0
  now.peak.clear()
  const rs = await Promise.all([one(opts), sleep(10).then(() => one(opts))])
  expect(rs.every((r) => r.status === 200)).toBe(true)
  expect(Math.max(...now.peak.values())).toBe(2)
  expect(busyHold.until).toBe(0)
})

// Narrowed to one and still refused, alone: the account's slots are taken
// elsewhere (the ZCode app, another computer), and those caps count toward
// the hold as before. Three at once first narrow the account down (3 → 2 →
// 1); the lone caps after it arm the hold.
test("an account refused even one at a time still arms the hold", async () => {
  BUSY_WAITS.splice(0, BUSY_WAITS.length, 1, 1)
  let clock = 1_000_000_000_000
  busyHold.now = () => clock
  startGate.now = () => clock
  answer = async () => {
    await sleep(20)
    return CAP()
  }
  const opts = await loader(startAuth())
  const rs = []
  for (let i = 0; i < 6 && !busyHold.until; i++) {
    clock += 1_000
    rs.push(...(await Promise.all([one(opts), one(opts), one(opts)])))
  }
  expect(rs.every((r) => r.status === 429)).toBe(true)
  expect(busyHold.until).toBeGreaterThan(clock)
  const [key] = startGate.narrow.keys()
  expect(_internal.limitOf(key)).toBe(1)
})
