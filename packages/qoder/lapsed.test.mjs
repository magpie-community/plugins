// plugins#474 (ahang39): international Qoder answered dfmodel with 403
// "Login expired" in bursts of ~16 requests over 2–5 minutes, about every
// 24 hours, through magpie's 401 "the sign-in lapsed". The burst began as
// the job token's renewal came due (its saved end less magpie's 10-minute
// lead) and ended once a renewed pair was saved: Qoder refused the job
// token while the plugin still had it as minutes from its end, and nothing
// asked again with a renewed one.
//
// The fake Qoder here keeps its own books: each job token has its own end,
// a refresh token is spent once and the job token it paired with is refused
// from then on, and a chat names its job token inside the COSY envelope,
// which the fake opens with the private half of a key the test puts in place
// of Qoder's. A refused chat is a 403 {"message":"Login expired"}, the
// words the reporter's 401 quotes; its code and the rest of its body aren't
// in the report, so none is sent.
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test"
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from "node:crypto"
import { QoderAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
const site = _internal.SITES.qoder
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
beforeEach(() => (site.rsaKey = publicKey.export({ type: "spki", format: "pem" })))
afterEach(() => {
  globalThis.fetch = real
  delete site.rsaKey
  setSystemTime()
})

const HOUR = 3_600_000
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })
const line = (body) => `data:${JSON.stringify({ headers: {}, body: JSON.stringify(body), statusCodeValue: 200 })}\n\n`
const answered = () =>
  new Response(line({ choices: [{ delta: { content: "hello" } }] }) + line({ choices: [{ delta: {}, finish_reason: "stop" }] }) + `data:${JSON.stringify({ headers: {}, body: "[DONE]", statusCodeValue: 200 })}\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  })
const LISTING = { chat: [{ key: "dfmodel", display_name: "DeepSeek Flash", enable: true }] }
const CHAT = "https://api3.qoder.sh/v1/chat/completions"
const chat = () => ({ method: "POST", body: JSON.stringify({ model: "dfmodel", messages: [{ role: "user", content: "hi" }] }) })

// tokenOf is the job token a COSY-signed call carries
function tokenOf(headers) {
  // PKCS#1 v1.5 padding taken off by hand: Bun no longer decrypts with it
  const block = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, Buffer.from(headers["Cosy-Key"], "base64"))
  const key = block.subarray(block.indexOf(0, 2) + 1)
  const [payload] = headers.Authorization.slice("Bearer COSY.".length).split(".")
  const { info } = JSON.parse(Buffer.from(payload, "base64").toString())
  const d = createDecipheriv("aes-128-cbc", key, key)
  return JSON.parse(Buffer.concat([d.update(Buffer.from(info, "base64")), d.final()]).toString()).security_oauth_token
}

// qoder is the fake: live job tokens by their end, refresh tokens by the job
// token they pair with. life is a renewed token's lifetime; said is how the
// refresh says its end (expires_in, expire_time, or nothing).
function qoder({ life = 24 * HOUR, said = "expires_in", refuseAll = false, refuseRefresh = false, onRefused } = {}) {
  const live = new Map([["jt-1", Date.now() + life]])
  const pairs = new Map([["jrt-1", "jt-1"]])
  const calls = { refresh: [], chats: [] }
  let n = 1
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname === "/api/v1/jobToken/refresh") {
      const rt = JSON.parse(init.body).refresh_token
      calls.refresh.push(rt)
      if (refuseRefresh || !pairs.has(rt)) return json({ message: "invalid refresh token" }, 401)
      live.delete(pairs.get(rt))
      pairs.delete(rt)
      n++
      const end = Date.now() + life
      live.set(`jt-${n}`, end)
      pairs.set(`jrt-${n}`, `jt-${n}`)
      const at =
        said === "expires_in" ? { expires_in: life } : said === "expire_time" ? { expire_time: new Date(end).toISOString() } : said === "epoch" ? { expires_at: Math.floor(end / 1000) } : {}
      return json({ token: `jt-${n}`, refresh_token: `jrt-${n}`, ...at })
    }
    if (u.pathname.endsWith("/model/list")) return json(LISTING)
    const t = tokenOf(init.headers)
    calls.chats.push(t)
    if (refuseAll || !(live.get(t) > Date.now())) {
      await onRefused?.(t)
      return json({ message: "Login expired" }, 403)
    }
    return answered()
  }
  return { live, calls }
}

// account is the plugin's view: what magpie saved, through client.auth.set,
// read back as a copy as magpie's getAuth gives it
async function account(over = {}) {
  const box = { stored: { type: "oauth", access: "jt-1", refresh: "jrt-1", expires: Date.now() + 24 * HOUR, accountId: "one@x", uid: "u1", machineId: "m1", ...over } }
  const hooks = await QoderAuthPlugin({ client: { auth: { set: async ({ body }) => (box.stored = { ...body }) } } })
  const l = await hooks.auth.loader(async () => box.stored)
  return { hooks, fetch: l.fetch, box }
}

test("a job token Qoder refuses as Login expired before its saved end is renewed once and the request asked again", async () => {
  const q = qoder()
  q.live.set("jt-1", Date.now() - 1) // Qoder's end came first
  const a = await account({ expires: Date.now() + 9 * 60_000 }) // inside neither lead
  const res = await a.fetch(CHAT, chat())
  expect(res.status).toBe(200)
  expect((await res.json()).choices[0].message.content).toBe("hello")
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
  expect(q.calls.refresh).toEqual(["jrt-1"])
  expect(q.calls.chats).toEqual(["jt-1", "jt-2"])
  expect(a.box.stored).toMatchObject({ access: "jt-2", refresh: "jrt-2" })
})

test("a burst of requests on a refused job token spends its refresh token once, and every one is answered", async () => {
  const q = qoder()
  q.live.delete("jt-1")
  const a = await account()
  const res = await Promise.all(Array.from({ length: 16 }, () => a.fetch(CHAT, chat())))
  expect(res.map((r) => r.status)).toEqual(Array(16).fill(200))
  expect(q.calls.refresh).toEqual(["jrt-1"])
  expect(a.box.stored.access).toBe("jt-2")
})

test("a sign-in renewed elsewhere while the request was out is asked again with, spending no refresh token", async () => {
  let a
  const q = qoder({
    // another process saved a renewed pair: what magpie's store now says
    onRefused: async () => {
      q.live.set("jt-9", Date.now() + HOUR)
      a.box.stored = { ...a.box.stored, access: "jt-9", refresh: "jrt-9", expires: Date.now() + HOUR }
    },
  })
  q.live.delete("jt-1")
  a = await account()
  const res = await a.fetch(CHAT, chat())
  expect(res.status).toBe(200)
  expect(q.calls.refresh).toEqual([])
  expect(q.calls.chats).toEqual(["jt-1", "jt-9"])
})

test("magpie's own renewal, begun as a request meets the refusal, is waited for and not spent again", async () => {
  let a, renewal
  // magpie's auth.refresh starts while the refused chat is answered, before
  // the request asks for a renewal of its own; magpie hasn't saved it yet
  const q = qoder({ onRefused: () => void (renewal ??= a.hooks.auth.refresh({ ...a.box.stored })) })
  q.live.delete("jt-1")
  a = await account()
  const res = await a.fetch(CHAT, chat())
  expect(await renewal).toMatchObject({ access: "jt-2", refresh: "jrt-2" })
  expect(res.status).toBe(200)
  expect(q.calls.refresh).toEqual(["jrt-1"])
  expect(q.calls.chats).toEqual(["jt-1", "jt-2"])
})

test("a refusal a renewal doesn't end is said once renewed, and a token renewed minutes ago isn't renewed again", async () => {
  const q = qoder({ refuseAll: true })
  const a = await account()
  const one = await a.fetch(CHAT, chat())
  expect(one.status).toBe(401)
  expect((await one.json()).error.message).toContain("Login expired")
  expect(q.calls.refresh).toEqual(["jrt-1"])
  const two = await a.fetch(CHAT, chat())
  expect(two.status).toBe(401)
  expect(two.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect(q.calls.refresh).toEqual(["jrt-1"])
  expect(q.calls.chats).toEqual(["jt-1", "jt-2", "jt-2"])
})

test("a refused job token whose refresh Qoder turns away says the sign-in expired", async () => {
  qoder({ refuseAll: true, refuseRefresh: true })
  const a = await account()
  const res = await a.fetch(CHAT, chat())
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
})

for (const said of ["expire_time", "epoch"]) {
  test(`a renewed job token's end Qoder says as ${said} is the end magpie renews it before`, async () => {
    qoder({ life: 2 * HOUR, said })
    const a = await account({ expires: Date.now() + 60_000 })
    const got = await a.hooks.auth.refresh(a.box.stored)
    expect(Math.abs(got.expires - (Date.now() + 2 * HOUR))).toBeLessThan(2_000)
  })
}

// magpie's host, as host.js renews: before a request, an account whose end
// less the plugin's refreshLead has come is renewed through auth.refresh and
// what it gives saved. Driven across a day of Qoder's 23h tokens, said only
// as expire_time, no request is refused.
test("across a day, a token Qoder says ends at expire_time is renewed before it ends and no request is refused", async () => {
  const start = Date.now()
  const q = qoder({ life: 23 * HOUR, said: "expire_time" })
  const a = await account({ expires: start + 60_000 })
  const host = async () => {
    if (Date.now() >= a.box.stored.expires - a.hooks.auth.refreshLead) Object.assign(a.box.stored, await a.hooks.auth.refresh(a.box.stored))
  }
  const statuses = []
  for (let t = 0; t <= 48 * HOUR; t += 13 * 60_000) {
    setSystemTime(new Date(start + t))
    await host()
    statuses.push((await a.fetch(CHAT, chat())).status)
  }
  expect(statuses.filter((s) => s !== 200)).toEqual([])
  expect(q.calls.chats.length).toBe(statuses.length) // none asked twice
}, 30_000)
