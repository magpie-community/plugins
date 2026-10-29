// plugins#484 (fskk54-cmyk): on an enterprise qoder.com (international)
// account under 0.2.48, 12 of the 14 app models were answered with the
// plugin's own 400 `unknown or disabled model` while dfmodel and qfmodel,
// the two free ones, were served. The 400 is said from the account's
// listing, before any chat is sent, so the renewal 0.2.48 gave a refused
// chat (plugins#474) never ran for those models.
//
// The fake Qoder lists the reporter's 14 app models. A job token it still
// honours gets all 14 on; one it has stopped honouring gets the free view,
// dfmodel and qfmodel on and the rest off, and its chats are refused as
// Login expired. A refresh token is spent once. Calls are COSY-signed, and
// the fake opens the envelope with the private half of a key the test puts
// in place of Qoder's to read which job token a call carries.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from "node:crypto"
import { QoderAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
const site = _internal.SITES.qoder
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
beforeEach(() => (site.rsaKey = publicKey.export({ type: "spki", format: "pem" })))
afterEach(() => {
  globalThis.fetch = real
  delete site.rsaKey
})

const HOUR = 3_600_000
const CHAT = "https://api3.qoder.sh/v1/chat/completions"
const FREE = ["dfmodel", "qfmodel"]
// the reporter's 14 ids, in the order they tried them
const PAID = ["ultimate", "fast", "efficient", "smodel", "cmodel", "qmodel_38max", "gmodel", "gfmodel", "kmodel_latest", "kmodel", "dmodel", "mmodel"]
const ALL = [...PAID, ...FREE]

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })
const line = (body) => `data:${JSON.stringify({ headers: {}, body: JSON.stringify(body), statusCodeValue: 200 })}\n\n`
const answered = () =>
  new Response(line({ choices: [{ delta: { content: "hello" } }] }) + line({ choices: [{ delta: {}, finish_reason: "stop" }] }) + `data:${JSON.stringify({ headers: {}, body: "[DONE]", statusCodeValue: 200 })}\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  })
const chat = (model) => ({ method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) })

// tokenOf is the job token a COSY-signed call carries
function tokenOf(headers) {
  const block = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, Buffer.from(headers["Cosy-Key"], "base64"))
  const key = block.subarray(block.indexOf(0, 2) + 1)
  const [payload] = headers.Authorization.slice("Bearer COSY.".length).split(".")
  const { info } = JSON.parse(Buffer.from(payload, "base64").toString())
  const d = createDecipheriv("aes-128-cbc", key, key)
  return JSON.parse(Buffer.concat([d.update(Buffer.from(info, "base64")), d.final()]).toString()).security_oauth_token
}

// qoder is the fake. honoured is the job tokens Qoder serves in full;
// off is the models off for every account whatever its token.
function qoder({ honoured = new Set(), off = [] } = {}) {
  const pairs = new Map([["jrt-1", "jt-1"]])
  const calls = { refresh: [], listings: [], chats: [] }
  let n = 1
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname === "/api/v1/jobToken/refresh") {
      const rt = JSON.parse(init.body).refresh_token
      calls.refresh.push(rt)
      if (!pairs.has(rt)) return json({ message: "invalid refresh token" }, 401)
      honoured.delete(pairs.get(rt))
      pairs.delete(rt)
      n++
      honoured.add(`jt-${n}`)
      pairs.set(`jrt-${n}`, `jt-${n}`)
      return json({ token: `jt-${n}`, refresh_token: `jrt-${n}`, expires_in: 24 * HOUR })
    }
    const t = tokenOf(init.headers)
    if (u.pathname.endsWith("/model/list")) {
      calls.listings.push(t)
      const full = honoured.has(t)
      return json({ app: ALL.map((key) => ({ key, display_name: key, enable: !off.includes(key) && (full || FREE.includes(key)) })), byok_teams: [], byok_enterprise: [] })
    }
    calls.chats.push(t)
    if (!honoured.has(t)) return json({ message: "Login expired" }, 403)
    return answered()
  }
  return { calls, honoured }
}

// account is an enterprise account on qoder.com as magpie saved it, its
// job token a day from its saved end
async function account() {
  const box = { stored: { type: "oauth", access: "jt-1", refresh: "jrt-1", expires: Date.now() + 24 * HOUR, accountId: "ent@corp.example", uid: "u-ent", email: "ent@corp.example", machineId: "m1" } }
  const hooks = await QoderAuthPlugin({ client: { auth: { set: async ({ body }) => (box.stored = { ...body }) } } })
  const l = await hooks.auth.loader(async () => box.stored)
  return { hooks, fetch: l.fetch, box }
}

test("plugins#484: each of the reporter's 14 models is served on a job token Qoder lists only the free models for, renewed once", async () => {
  const q = qoder()
  const a = await account()
  for (const model of ALL) {
    const res = await a.fetch(CHAT, chat(model))
    expect({ model, status: res.status }).toEqual({ model, status: 200 })
    expect((await res.json()).choices[0].message.content).toBe("hello")
  }
  expect(q.calls.refresh).toEqual(["jrt-1"])
  expect(a.box.stored).toMatchObject({ access: "jt-2", refresh: "jrt-2" })
  expect(q.calls.chats.every((t) => t === "jt-2")).toBe(true)
})

test("plugins#484: the first request after the free view, on a paid model, says the renewal", async () => {
  qoder()
  const a = await account()
  const res = await a.fetch(CHAT, chat("efficient"))
  expect(res.status).toBe(200)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
})

test("an id Qoder never served is said unknown at once, spending no refresh token", async () => {
  const q = qoder({ honoured: new Set(["jt-1"]) })
  const a = await account()
  const res = await a.fetch(CHAT, chat("no-such-model"))
  expect(res.status).toBe(400)
  expect((await res.json()).error.message).toContain('unknown or disabled model "no-such-model"')
  expect(q.calls.refresh).toEqual([])
  expect(q.calls.chats).toEqual([])
})

test("a model the account has off on a renewed token too is said disabled, and the token renewed minutes ago isn't renewed again", async () => {
  const q = qoder({ off: ["ultimate"] })
  const a = await account()
  for (let i = 0; i < 3; i++) {
    const res = await a.fetch(CHAT, chat("ultimate"))
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain('unknown or disabled model "ultimate"')
  }
  expect(q.calls.refresh).toEqual(["jrt-1"])
  expect(q.calls.chats).toEqual([])
  // the other models are served on the renewed token
  expect((await a.fetch(CHAT, chat("gmodel"))).status).toBe(200)
  expect(q.calls.refresh).toEqual(["jrt-1"])
})

test("a model the live listing has on spends no refresh token", async () => {
  const q = qoder({ honoured: new Set(["jt-1"]) })
  const a = await account()
  for (const model of ALL) expect((await a.fetch(CHAT, chat(model))).status).toBe(200)
  expect(q.calls.refresh).toEqual([])
  expect(new Set(q.calls.listings)).toEqual(new Set(["jt-1"]))
})
