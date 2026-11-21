import { test, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Frames, GeminiError, MAX_PROMPT, MODELS, Session, clean, innerRequest, mergeSetCookie, modelHeader, outcome, pageTokens, parseModels, slug } from "./gemini.mjs"
import { browserArgs, googleCookies, renew, signIn } from "./browser.mjs"
import { _internal as I, cookiesOf } from "./index.mjs"
import plugin from "./opencode.mjs"

const dir = path.join(import.meta.dir, "testdata")
// real StreamGenerate replies, read from gemini.google.com on 2026-11-19
// (the location Google guessed from the address is scrubbed): "pong" from
// a signed-in account, served as 4 Hydrogen; a short text about rivers
// from no account, served as 3.5 Flash-Lite, with the chunks as they came
const PONG = fs.readFileSync(path.join(dir, "pong.raw"), "utf8")
const RIVERS = fs.readFileSync(path.join(dir, "rivers.raw"), "utf8")
const RIVER_CHUNKS = JSON.parse(fs.readFileSync(path.join(dir, "rivers.chunks.json"), "utf8")).chunks
// the model picker's list (otAQ7b) for a free account
const OTAQ7B = fs.readFileSync(path.join(dir, "otaq7b.raw"), "utf8")

// reply rewrites the text of every content frame of a real reply,
// keeping the rest of its bytes and the length lines right
function reply(raw, text) {
  const lines = raw.split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("[")) continue
    const rows = JSON.parse(lines[i])
    let changed = false
    for (const e of rows) {
      if (e[0] !== "wrb.fr" || typeof e[2] !== "string") continue
      const b = JSON.parse(e[2])
      if (!Array.isArray(b?.[4]?.[0]?.[1])) continue
      b[4][0][1][0] = text
      e[2] = JSON.stringify(b)
      changed = true
    }
    if (changed) {
      lines[i] = JSON.stringify(rows)
      lines[i - 1] = String(lines[i].length + 2)
    }
  }
  return lines.join("\n")
}

const REFUSED = ')]}\'\n\n41\n[["wrb.fr",null,null,null,null,[3]]]\n25\n[["e",4,null,null,141]]\n'

const PAGE = (at = "AJvLN6Mtoken") =>
  `<html><script>WIZ_global_data = {"SNlM0e":"${at}","cfb2h":"boq_assistant-bard-web-server_20261117.06_p0","FdrFJe":"-4096","oPEP7c":"${at ? "someone@example.com" : ""}"};</script></html>`

const enc = new TextEncoder()
const streamOf = (chunks) =>
  new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(enc.encode(x))
      c.close()
    },
  })

// fakeGoogle answers /app, StreamGenerate, batchexecute and RotateCookies
// as Google does, and records what was asked
function fakeGoogle({ page = () => PAGE(), generate = () => [PONG], status = () => 200, setCookie = [], models = OTAQ7B, rotate = 200 } = {}) {
  const calls = []
  const f = async (url, init = {}) => {
    const u = new URL(String(url))
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers ?? {}, body })
    const h = new Headers()
    for (const c of setCookie) h.append("set-cookie", c)
    if (u.pathname === "/app") return new Response(page(), { status: 200, headers: h })
    if (u.pathname === "/RotateCookies") return new Response("", { status: rotate, headers: h })
    if (u.pathname.endsWith("/batchexecute")) return new Response(models, { status: 200, headers: h })
    if (u.pathname.endsWith("/StreamGenerate")) {
      const s = status(calls)
      if (s !== 200) return new Response("nope", { status: s, headers: h })
      return new Response(streamOf(generate(calls)), { status: 200, headers: h })
    }
    return new Response("?", { status: 404 })
  }
  f.calls = calls
  f.generates = () => calls.filter((c) => c.path.endsWith("/StreamGenerate"))
  return f
}

const COOKIES = { "__Secure-1PSID": "psid", "__Secure-1PSIDTS": "ts1", NID: "nid" }

// ---- the reply ----

test("Frames reads a real signed-in reply: text, model, end", () => {
  const f = new Frames()
  f.push(PONG)
  f.end()
  expect(outcome(f)).toEqual({ text: "pong", reasoning: "", model: "4 Hydrogen" })
  expect(f.done).toBe(true)
})

test("Frames reads the same reply however it is cut, and only grows", () => {
  const whole = new Frames()
  whole.push(RIVERS)
  whole.end()
  expect(whole.text.length).toBe(233)
  expect(whole.text.startsWith("Rivers carve winding paths")).toBe(true)
  expect(whole.model).toBe("3.5 Flash-Lite")
  for (const size of [1, 7, 64, 1000, 4096]) {
    const f = new Frames()
    let last = ""
    for (let i = 0; i < RIVERS.length; i += size) {
      f.push(RIVERS.slice(i, i + size))
      expect(f.text.startsWith(last)).toBe(true)
      last = f.text
    }
    f.end()
    expect(f.text).toBe(whole.text)
  }
})

test("Session.ask streams the real chunks as the reply grows", async () => {
  const g = fakeGoogle({ generate: () => RIVER_CHUNKS, page: () => PAGE("") })
  const s = new Session({ fetchImpl: g })
  const seen = []
  const r = await s.ask("Write two sentences about rivers.", { onUpdate: (u) => seen.push(u.text.length) })
  expect(seen).toEqual([83, 226, 233])
  expect(r.text.length).toBe(233)
})

test("a refusal with no content says why, not 'no content'", () => {
  const f = new Frames()
  f.push(REFUSED)
  expect(() => outcome(f)).toThrow(/拒绝了这个请求（错误 3）/)
  const empty = new Frames()
  empty.push(")]}'\n")
  expect(() => outcome(empty)).toThrow(GeminiError)
})

test("code-run artifacts are taken out of the text", () => {
  expect(clean("a\n```python?code_reference&code_event_index=2\nprint(1)\n```\nb")).toBe("a\nb")
  expect(clean("```python\nprint(1)\n```")).toBe("```python\nprint(1)\n```")
})

// ---- the request ----

test("the request is a temporary chat with the prompt inline", () => {
  const r = innerRequest("hello")
  expect(r.length).toBe(99)
  expect(r[0][0]).toBe("hello")
  expect(r[45]).toBe(1)
  expect(r[59]).toMatch(/^[0-9A-F-]{36}$/)
  // 4 Carbon needs the slots the app sends for it
  const c = innerRequest("x", { hex: "95a4c0abcba24364", mode: 8 })
  expect([c[6], c[30], c[49], c[68], c[98]]).toEqual([[1], [], 40, 2, 1])
  expect(modelHeader({})).toBe(null)
  const h = JSON.parse(modelHeader(MODELS["gemini-3.1-pro"]))
  expect([h[4], h[14]]).toEqual(["9d8ca3786ebdfbea", 3])
})

test("Session.ask sends the page's tokens, cookies and the picked model, and reads /app once", async () => {
  const g = fakeGoogle()
  const s = new Session({ cookies: COOKIES, fetchImpl: g })
  expect((await s.ask("ping", { model: MODELS["gemini-3.6-flash"] })).text).toBe("pong")
  await s.ask("ping again")
  expect(g.calls.filter((c) => c.path === "/app").length).toBe(1)
  const [first, second] = g.generates()
  expect(first.body.at).toBe("AJvLN6Mtoken")
  expect(JSON.parse(JSON.parse(first.body["f.req"])[1])[0][0]).toBe("ping")
  expect(first.query).toMatchObject({ bl: "boq_assistant-bard-web-server_20261117.06_p0", "f.sid": "-4096", rt: "c" })
  expect(first.headers.cookie).toBe("__Secure-1PSID=psid; __Secure-1PSIDTS=ts1; NID=nid")
  expect(first.headers["x-same-domain"]).toBe("1")
  expect(JSON.parse(first.headers["x-goog-ext-525001261-jspb"])[4]).toBe("fbb127bbb056c959")
  expect(second.headers["x-goog-ext-525001261-jspb"]).toBeUndefined()
})

test("no account sends no at and no cookie", async () => {
  const g = fakeGoogle({ page: () => PAGE("") })
  await new Session({ fetchImpl: g }).ask("ping")
  const [r] = g.generates()
  expect(r.body.at).toBeUndefined()
  expect(r.headers.cookie).toBeUndefined()
})

test("a 400 reads the page again and tries once more", async () => {
  const g = fakeGoogle({ status: (calls) => (calls.filter((c) => c.path.endsWith("/StreamGenerate")).length === 1 ? 400 : 200) })
  const s = new Session({ cookies: COOKIES, fetchImpl: g })
  expect((await s.ask("ping")).text).toBe("pong")
  expect(g.calls.filter((c) => c.path === "/app").length).toBe(2)
  const always = fakeGoogle({ status: () => 429 })
  await expect(new Session({ fetchImpl: always }).ask("ping")).rejects.toMatchObject({ code: "rate_limited", status: 429 })
})

test("a prompt past what the app reads is refused before it is sent", async () => {
  const g = fakeGoogle()
  await expect(new Session({ fetchImpl: g }).ask("x".repeat(MAX_PROMPT + 1))).rejects.toMatchObject({ status: 413, code: "context_length_exceeded" })
  expect(g.calls.length).toBe(0)
})

// ---- the sign-in ----

test("pageTokens reads SNlM0e, cfb2h, FdrFJe and the account's email", () => {
  expect(pageTokens(PAGE())).toEqual({ at: "AJvLN6Mtoken", bl: "boq_assistant-bard-web-server_20261117.06_p0", sid: "-4096", email: "someone@example.com" })
  expect(pageTokens("<html></html>").at).toBe("")
})

test("mergeSetCookie keeps google.com's renewed cookies and drops others and deletions", () => {
  const c = { ...COOKIES }
  expect(mergeSetCookie(c, ["__Secure-1PSIDTS=ts2; Domain=.google.com; Path=/; Secure; HttpOnly", "x=1; Domain=.youtube.com", "NID=EXPIRED; Domain=.google.com; Max-Age=0"])).toBe(true)
  expect(c).toEqual({ ...COOKIES, "__Secure-1PSIDTS": "ts2" })
  expect(mergeSetCookie(c, ["__Secure-1PSIDTS=ts2; Domain=.google.com"])).toBe(false)
})

test("cookies Google renews on a reply are saved", async () => {
  const saved = []
  const g = fakeGoogle({ setCookie: ["__Secure-1PSIDTS=ts9; Domain=.google.com; Path=/"] })
  const s = new Session({ cookies: COOKIES, fetchImpl: g, onCookies: (c) => saved.push(c) })
  await s.ask("ping")
  expect(saved.length).toBe(1)
  expect(saved[0]["__Secure-1PSIDTS"]).toBe("ts9")
})

test("signed out: the cookies are rotated, then the profile renews them, then it asks for a sign-in", async () => {
  let pages = 0
  // the page is signed out until the profile gives fresh cookies
  const g = fakeGoogle({ page: () => (pages++, g.calls.at(-1).headers.cookie?.includes("ts-fresh") ? PAGE() : PAGE("")), rotate: 401 })
  let renewed = 0
  const s = new Session({ cookies: COOKIES, fetchImpl: g, renew: async () => (renewed++, { "__Secure-1PSIDTS": "ts-fresh" }) })
  expect((await s.ask("ping")).text).toBe("pong")
  expect(renewed).toBe(1)
  expect(g.calls.some((c) => c.path === "/RotateCookies")).toBe(true)
  expect(g.generates()[0].body.at).toBe("AJvLN6Mtoken")

  const dead = fakeGoogle({ page: () => PAGE(""), rotate: 401 })
  await expect(new Session({ cookies: COOKIES, fetchImpl: dead, renew: async () => null }).ask("ping")).rejects.toMatchObject({ signIn: true, status: 401 })
})

test("RotateCookies is sent only the session pair", async () => {
  const g = fakeGoogle({ setCookie: ["__Secure-1PSIDTS=ts3; Domain=.google.com"] })
  const s = new Session({ cookies: COOKIES, fetchImpl: g })
  expect(await s.rotate()).toBe(true)
  const r = g.calls.find((c) => c.path === "/RotateCookies")
  expect(r.headers.cookie).toBe("__Secure-1PSID=psid; __Secure-1PSIDTS=ts1")
  expect(r.body).toBe('[000,"-0000000000000000000"]')
  expect(s.cookies["__Secure-1PSIDTS"]).toBe("ts3")
})

test("googleCookies keeps google.com and gemini.google.com cookies at /", () => {
  expect(
    googleCookies([
      { name: "__Secure-1PSID", value: "a", domain: ".google.com", path: "/" },
      { name: "S", value: "b", domain: "gemini.google.com", path: "/" },
      { name: "LSID", value: "c", domain: "accounts.google.com", path: "/" },
      { name: "x", value: "d", domain: ".youtube.com", path: "/" },
      { name: "y", value: "e", domain: ".google.com", path: "/u/0" },
    ]),
  ).toEqual({ "__Secure-1PSID": "a", S: "b" })
})

test("browserArgs: a private profile, DevTools on loopback, headless for a renewal", () => {
  const a = browserArgs("/p", 9000, "https://x")
  expect(a).toContain("--user-data-dir=/p")
  expect(a).toContain("--remote-debugging-address=127.0.0.1")
  expect(a).toContain("--new-window")
  expect(browserArgs("/p", 9000, "https://x", { headless: true })).toContain("--headless=new")
})

const fakeBrowser = (reads) => {
  let closed = 0
  const opener = async () => {
    let i = 0
    return { exited: false, cookies: async () => reads[Math.min(i++, reads.length - 1)], close: async () => void closed++ }
  }
  opener.closed = () => closed
  return opener
}

test("signIn waits for the session cookies and closes the window; it gives up at the timeout", async () => {
  const o = fakeBrowser([{}, { NID: "n" }, { ...COOKIES }])
  expect(await signIn("/p", { opener: o, poll: 1, settle: 1, timeout: 10_000 })).toEqual(COOKIES)
  expect(o.closed()).toBe(1)
  const never = fakeBrowser([{}])
  expect(await signIn("/p", { opener: never, poll: 1, timeout: 20 })).toBe(null)
  expect(never.closed()).toBe(1)
})

test("renew answers once the profile's 1PSIDTS changed", async () => {
  const o = fakeBrowser([{ ...COOKIES }, { ...COOKIES, "__Secure-1PSIDTS": "ts2" }])
  expect((await renew(import.meta.dir, { before: COOKIES, opener: o, poll: 1 }))["__Secure-1PSIDTS"]).toBe("ts2")
  expect(await renew(path.join(dir, "no-such-profile"), { opener: o })).toBe(null)
})

// ---- models ----

test("parseModels reads the picker's list", () => {
  expect(parseModels(OTAQ7B)).toEqual({ "gemini-auto": { name: "Auto", hex: "cf41b0e0dd7d53e5", mode: 6 } })
  expect(slug("3.1 Pro")).toBe("gemini-3.1-pro")
  expect(slug("Gemini 3.6 Flash")).toBe("gemini-3.6-flash")
})

// ---- the plugin ----

const SIGNED_IN = { type: "oauth", access: JSON.stringify({ cookies: COOKIES }), refresh: "/profile", expires: 0, accountId: "someone@example.com" }
const VISITOR = { type: "oauth", access: "anonymous", refresh: "", expires: 0, accountId: "anonymous" }

async function load(g, auth, extra = {}) {
  const p = I.createPlugin({ fetchImpl: g, newId: () => "call_1", ...extra })
  const l = await p.auth.loader(async () => auth)
  const ask = (body) => l.fetch(I.BASE + "/chat/completions", { method: "POST", body: JSON.stringify(body) })
  return { p, l, ask }
}

test("the plugin streams a chat completion", async () => {
  const { ask } = await load(fakeGoogle(), SIGNED_IN)
  const res = await ask({ model: "gemini-3.6-flash", stream: true, messages: [{ role: "user", content: "ping" }] })
  expect(res.headers.get("content-type")).toBe("text/event-stream")
  const text = await res.text()
  const deltas = text
    .split("\n\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)))
  expect(deltas.map((d) => d.choices[0]?.delta?.content ?? "").join("")).toBe("pong")
  expect(deltas.some((d) => d.choices[0]?.finish_reason === "stop")).toBe(true)
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true)
})

test("the plugin gives tool calls back as tool_calls", async () => {
  const g = fakeGoogle({ generate: () => [reply(PONG, 'Reading it.\n<tool_call>{"name":"Read","arguments":{"path":"a.go"}}</tool_call>')] })
  const { ask } = await load(g, SIGNED_IN)
  const res = await ask({
    model: "gemini-auto",
    messages: [{ role: "user", content: "read a.go" }],
    tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
  })
  const j = await res.json()
  expect(j.choices[0].finish_reason).toBe("tool_calls")
  expect(j.choices[0].message.tool_calls[0].function).toEqual({ name: "Read", arguments: '{"path":"a.go"}' })
  expect(JSON.parse(JSON.parse(g.generates()[0].body["f.req"])[1])[0][0]).toContain("## Read")
})

test("a visitor gets the visitor's model and no picker header", async () => {
  const g = fakeGoogle({ page: () => PAGE("") })
  const { ask, p } = await load(g, VISITOR)
  expect((await ask({ model: "gemini-3.1-pro", messages: [{ role: "user", content: "x" }] })).status).toBe(404)
  const res = await ask({ model: "gemini-auto", messages: [{ role: "user", content: "ping" }] })
  expect((await res.json()).choices[0].message.content).toBe("pong")
  expect(g.generates()[0].headers["x-goog-ext-525001261-jspb"]).toBeUndefined()
  expect(Object.keys(await p.provider.models({}, { auth: VISITOR }))).toEqual(["gemini-auto"])
})

test("a refusal goes back as an HTTP error, not a 200 stream", async () => {
  const { ask } = await load(fakeGoogle({ generate: () => [REFUSED] }), SIGNED_IN)
  const res = await ask({ model: "gemini-auto", stream: true, messages: [{ role: "user", content: "ping" }] })
  expect(res.status).toBe(502)
  expect((await res.json()).error.type).toBe("gemini_refused")
})

test("models: the account's picker list, or the built-in list marked as a fallback", async () => {
  const { p } = await load(fakeGoogle(), SIGNED_IN)
  const read = await p.provider.models({}, { auth: SIGNED_IN })
  expect(Object.keys(read)).toEqual(["gemini-auto"])
  expect(read[Symbol.for("magpie.fellBack")]).toBeUndefined()
  const broken = fakeGoogle({ models: "<html>500</html>" })
  const { p: p2 } = await load(broken, SIGNED_IN)
  const fell = await p2.provider.models({}, { auth: SIGNED_IN })
  expect(Object.keys(fell)).toEqual(Object.keys(MODELS))
  expect(fell[Symbol.for("magpie.fellBack")]).toBe(true)
})

test("renewed cookies are written back to the account", async () => {
  const sets = []
  const client = { auth: { set: async (x) => void sets.push(x) } }
  const g = fakeGoogle({ setCookie: ["__Secure-1PSIDTS=ts7; Domain=.google.com; Path=/"] })
  const { ask } = await load(g, SIGNED_IN, { client })
  await ask({ model: "gemini-auto", messages: [{ role: "user", content: "ping" }] })
  expect(sets.length).toBeGreaterThan(0)
  const last = sets.at(-1)
  expect(last.path).toEqual({ id: "gemini-web" })
  expect(last.body).toMatchObject({ type: "oauth", refresh: "/profile", accountId: "someone@example.com" })
  expect(cookiesOf(last.body)["__Secure-1PSIDTS"]).toBe("ts7")
})

test("the sign-in method signs in through the browser and names the account by its email", async () => {
  const g = fakeGoogle()
  const browser = { profileRoot: () => "/root", signIn: async () => ({ ...COOKIES }), renew: async () => null }
  const p = I.createPlugin({ fetchImpl: g, browser })
  const [google, visitor] = p.auth.methods
  const ok = await (await google.authorize()).callback()
  expect(ok).toMatchObject({ type: "success", accountId: "someone@example.com" })
  expect(ok.refresh.startsWith("/root/")).toBe(true)
  expect(cookiesOf(ok)).toEqual(COOKIES)
  const none = I.createPlugin({ fetchImpl: g, browser: { ...browser, signIn: async () => null } })
  expect((await (await none.auth.methods[0].authorize()).callback()).type).toBe("failed")
  const out = I.createPlugin({ fetchImpl: fakeGoogle({ page: () => PAGE("") }), browser })
  expect(await (await out.auth.methods[0].authorize()).callback()).toMatchObject({ type: "failed" })
  expect(await (await visitor.authorize()).callback()).toMatchObject({ type: "success", access: "anonymous" })
})

test("the package's default export is the plugin", async () => {
  const p = await plugin({ client: {} })
  expect(p.auth.provider).toBe("gemini-web")
  const cfg = {}
  await p.config(cfg)
  expect(cfg.provider["gemini-web"].api).toBe(I.BASE)
})
