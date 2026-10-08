// Warp (the terminal, warp.dev) AI credits as an OpenCode/magpie provider.
//
// Warp's agent mode speaks its own protocol: a protobuf Request POSTed to
// https://app.warp.dev/ai/multi-agent over HTTP/2, answered as SSE whose
// events are base64 protobuf ResponseEvents. The sign-in is the Warp app's
// own (Firebase Auth): on Windows the app keeps it DPAPI-encrypted beside
// its database, and this plugin only ever reads that file, refreshing the
// id token itself through Google's securetoken endpoint when the app's own
// token has grown stale. Agent tools are mapped to Warp's MCP tools, so a
// coding agent's tools arrive as CallMCPTool calls and their results go
// back as CallMCPToolResult inputs on the same conversation.
import { spawn } from "node:child_process"
import { statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import http2 from "node:http2"

const PROVIDER = "warp"
const SERVER = "https://app.warp.dev"
const CHAT_URL = SERVER + "/ai/multi-agent"
const GRAPHQL = SERVER + "/graphql/v2"
const TOKEN_URL = "https://securetoken.googleapis.com/v1/token?key=AIzaSyBdy3O3S9hrdayLJxJ7mriBR4qgUaUygAs"
// what the installed Warp sent when this was written; the server takes it as
// the client's identity on /ai and /graphql
const CLIENT_VERSION = "v0.2026.09.02.08.27.stable_01"
const REFRESH_MARGIN = 5 * 60 * 1000
const MODELS_MS = 10 * 60 * 1000

const enc = new TextEncoder()
const dec = new TextDecoder()

// a few of the account's models, so something is listed before the sign-in;
// the signed-in list replaces them
const SNAPSHOT = {
  "auto": { name: "auto (responsive)", limit: { context: 1_000_000 } },
  "auto-efficient": { name: "auto (cost-efficient)", limit: { context: 500_000 } },
  "auto-genius": { name: "auto (genius)", limit: { context: 1_000_000 } },
  "auto-open": { name: "auto (open-weights)", limit: { context: 1_040_000 } },
  "claude-5-5-opus-high": { name: "claude opus 5.5 (high)", limit: { context: 1_000_000 } },
  "claude-5-5-opus-max": { name: "claude opus 5.5 (max)", limit: { context: 1_000_000 } },
  "claude-4-5-haiku": { name: "claude haiku 4.5", limit: { context: 200_000 } },
  "gpt-6-3-high": { name: "gpt 6.3 (high)", limit: { context: 1_000_000 } },
  "gemini-3-5-pro-high": { name: "gemini 3.5 pro (high)", limit: { context: 1_000_000 } },
  "grok-5-2-high": { name: "grok 5.2 (high)", limit: { context: 1_000_000 } },
  "glm-5-3-high": { name: "glm 5.3 (high)", limit: { context: 1_000_000 } },
}

// ---- protobuf, by hand (the shapes Warp's protos define) -----------------------

class PB {
  constructor() { this.b = [] }
  uv(n) {
    do {
      const x = n & 0x7f
      n = Math.floor(n / 128) // >>> 7 fails past 2^32
      this.b.push(n ? x | 0x80 : x)
    } while (n)
    return this
  }
  tag(num, wire) { return this.uv((num << 3) | wire) }
  v(num, val) {
    if (val === undefined || val === null || val === 0 || val === false) return this
    this.tag(num, 0)
    return this.uv(val)
  }
  f64(num, val) {
    this.tag(num, 1)
    const buf = new ArrayBuffer(8)
    new DataView(buf).setFloat64(0, val, true)
    for (const x of new Uint8Array(buf)) this.b.push(x)
    return this
  }
  b_(num, data) {
    this.tag(num, 2)
    this.uv(data.length)
    for (const x of data) this.b.push(x)
    return this
  }
  s(num, text) {
    if (text === undefined || text === null || text === "") return this
    return this.b_(num, enc.encode(text))
  }
  m(num, inner) { return this.b_(num, inner.b) }
  out() { return Uint8Array.from(this.b) }
}

// valueMsg builds val as a google.protobuf.Value message:
// 1 null, 2 number (double), 3 string, 4 bool, 5 struct, 6 list
function valueMsg(val) {
  const w = new PB()
  if (val === null || val === undefined) {
    // NullValue NULL: 0, the default, needn't be sent
  } else if (typeof val === "number") w.f64(2, val)
  else if (typeof val === "string") w.s(3, val)
  else if (typeof val === "boolean") w.v(4, val ? 1 : 0)
  else if (Array.isArray(val)) {
    const list = new PB()
    for (const x of val) list.m(1, valueMsg(x))
    w.m(6, list)
  } else w.m(5, structPB(val))
  return w
}

// structPB writes a JSON object as a google.protobuf.Struct: a map whose
// values are Value messages
function structPB(val) {
  const w = new PB()
  for (const [k, v] of Object.entries(val || {})) {
    w.m(1, new PB().s(1, k).m(2, valueMsg(v)))
  }
  return w
}

// ---- protobuf reading -----------------------------------------------------------

function rdUvar(buf, i) {
  let n = 0, s = 0, b
  do {
    b = buf[i++]
    n += (b & 0x7f) * 2 ** s
    s += 7
  } while (b & 0x80)
  return [n, i]
}

function fields(buf) {
  const out = []
  let i = 0
  while (i < buf.length) {
    const [key, j] = rdUvar(buf, i)
    i = j
    const num = key >>> 3, wire = key & 7
    if (wire === 0) {
      const [v, k] = rdUvar(buf, i)
      i = k
      out.push({ num, v })
    } else if (wire === 2) {
      const [l, k] = rdUvar(buf, i)
      i = k
      out.push({ num, data: buf.subarray(i, i + l) })
      i += l
    } else if (wire === 5) { out.push({ num, f32: buf.subarray(i, i + 4) }); i += 4 }
    else if (wire === 1) { out.push({ num, f64: buf.subarray(i, i + 8) }); i += 8 }
    else throw new Error("protobuf wire type " + wire)
  }
  return out
}

const byNum = (buf, num) => fields(buf).filter((f) => f.num === num)
const str = (f) => (f?.data ? dec.decode(f.data) : "")
const f64 = (f) => (f?.f64 ? new DataView(f.f64.buffer, f.f64.byteOffset, 8).getFloat64(0, true) : 0)
const f32 = (f) => (f?.f32 ? new DataView(f.f32.buffer, f.f32.byteOffset, 4).getFloat32(0, true) : 0)

function valueOf(buf) {
  let out = null
  for (const f of fields(buf)) {
    if (f.num === 2) out = f64(f)
    else if (f.num === 3) out = str(f)
    else if (f.num === 4) out = f.v === 1
    else if (f.num === 5) out = structOf(f.data)
    else if (f.num === 6) {
      out = []
      for (const e of byNum(f.data, 1)) out.push(valueOf(e.data))
    }
  }
  return out
}

function structOf(buf) {
  const out = {}
  for (const e of byNum(buf, 1)) {
    let k = "", v = null
    for (const g of fields(e.data)) {
      if (g.num === 1) k = str(g)
      else if (g.num === 2) v = valueOf(g.data)
    }
    out[k] = v
  }
  return out
}

// ---- Warp's sign-in (Windows: the app's DPAPI-encrypted user file) --------------

function userFile() {
  return join(homedir(), "AppData", "Local", "warp", "Warp", "data", "dev.warp.Warp-User")
}

// warpUser reads the app's account. The decrypt is cached by the file's
// mtime: the file only changes when Warp refreshes its token (about
// hourly), so the shell out happens seldom, not per request.
const dpapi = { at: 0, json: null }
async function warpUser() {
  const file = userFile()
  let st
  try {
    st = statSync(file)
  } catch {
    return null
  }
  if (dpapi.json && dpapi.at === st.mtimeMs) return dpapi.json
  const script =
    `Add-Type -AssemblyName System.Security; ` +
    `$b=[IO.File]::ReadAllBytes('${file.replace(/'/g, "''")}'); ` +
    `$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); ` +
    `[Console]::OpenStandardOutput().Write($d,0,$d.Length)`
  const out = await new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const chunks = []
    let err = ""
    child.stdout.on("data", (d) => chunks.push(d))
    child.stderr.on("data", (d) => (err += d))
    child.on("error", (e) => resolve({ error: e.message }))
    child.on("close", () => resolve(err ? { error: err.trim() } : { data: Buffer.concat(chunks) }))
  })
  if (out.error) throw new Error("couldn't read Warp's sign-in: " + out.error)
  let json
  try {
    json = JSON.parse(dec.decode(out.data))
  } catch {
    throw new Error("Warp's sign-in file didn't read as the account")
  }
  dpapi.at = st.mtimeMs
  dpapi.json = json
  return json
}

// jwt reads a Firebase id_token's claims (its expiry, its email)
function jwt(token) {
  try {
    const part = token.split(".")[1]
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))
  } catch {
    return {}
  }
}
const jwtExpires = (token) => {
  const exp = Number(jwt(token).exp)
  return Number.isFinite(exp) ? exp * 1000 : 0
}

// exchange refreshes a Firebase refresh token: Google gives a fresh id token
// and rotates the refresh token; both are returned. Nothing is written back
// to Warp's own file.
async function exchange(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let data = {}
  try {
    data = JSON.parse(text)
  } catch {}
  if (!res.ok || !data.id_token) {
    const why = data?.error?.message || `Google's token endpoint answered ${res.status}`
    const dead = /invalid_grant|token_expired|invalid refresh/i.test(String(data?.error?.message ?? ""))
    throw Object.assign(new Error(why), { status: dead ? 401 : res.status, signIn: dead ? "expired" : undefined })
  }
  return {
    access: data.id_token,
    refresh: data.refresh_token,
    expires: Date.now() + Number(data.expires_in || 3600) * 1000,
  }
}

// live resolves a usable id token for the account: Warp's own, when the app
// has refreshed its file since the sign-in was made; else the stored one,
// when it still has time on it; else a fresh one from the refresh token.
// What it settles on is remembered, so the store and the app drift apart
// as little as possible.
async function live(client, auth) {
  const remember = async (fix) => {
    if (!fix) return
    try {
      await client.auth.set({ path: { id: PROVIDER }, body: { ...auth, ...fix } })
    } catch {}
  }
  let fileToken = null
  try {
    const user = await warpUser()
    const head = user?.id_token
    if (head?.id_token && head.expiration_time) {
      const exp = Date.parse(head.expiration_time)
      if (Number.isFinite(exp) && exp - REFRESH_MARGIN > Date.now()) {
        fileToken = { access: head.id_token, refresh: head.refresh_token, expires: exp }
      }
    }
  } catch {}
  if (fileToken && fileToken.access !== auth.access) {
    await remember(fileToken)
    return fileToken
  }
  const exp = auth.expires || jwtExpires(auth.access)
  if (auth.access && exp - REFRESH_MARGIN > Date.now()) return { access: auth.access, refresh: auth.refresh, expires: exp }
  const fresh = await exchange(auth.refresh || auth.key)
  await remember(fresh)
  return fresh
}

// ---- HTTP/2: Warp's /ai endpoint answers nothing but h2 -------------------------

// h2post posts and hands back the status with the body's chunks as they
// arrive, so the answer's events are read while Warp is still sending it. A
// connection is made per call: Warp's front turns HTTP/1.1 away with a
// bare 403.
function h2post(url, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    let done = false
    let c
    const fail = (e) => {
      if (done) return
      done = true
      try { c?.destroy() } catch {}
      reject(e)
    }
    try {
      c = http2.connect(u.origin)
    } catch (e) {
      return fail(e)
    }
    c.on("error", (e) => fail(Object.assign(new Error(`app.warp.dev: ${e.message}`), { status: 502 })))
    let req
    try {
      req = c.request({ ":method": "POST", ":path": u.pathname + u.search, ...headers })
    } catch (e) {
      return fail(e)
    }
    const abort = () => {
      try { req.close(http2.constants.NGHTTP2_CANCEL) } catch {}
      fail(Object.assign(new Error("the request was aborted"), { status: 499 }))
    }
    signal?.addEventListener("abort", abort, { once: true })
    const chunks = []
    const waiters = []
    let ended = false
    let error = null
    const handOff = () => {
      while (waiters.length) waiters.shift()()
    }
    req.on("response", (h) => {
      const status = h[":status"] ?? 0
      if (status === 0) return fail(new Error("app.warp.dev gave no status"))
      // from here the promise has what it needs: the status, and a body the
      // caller reads as it comes
      resolve({
        status,
        async *body() {
          for (;;) {
            while (chunks.length) yield chunks.shift()
            if (ended) {
              if (error) throw error
              return
            }
            await new Promise((r) => waiters.push(r))
          }
        },
      })
    })
    req.on("data", (d) => {
      chunks.push(d)
      handOff()
    })
    req.on("error", (e) => {
      error = e
      ended = true
      if (!done) {
        // after the status came, errors surface through the body; before it,
        // they fail the request
        fail(e)
      }
      handOff()
    })
    req.on("end", () => {
      ended = true
      try { c.close() } catch {}
      handOff()
    })
    req.end(body)
  })
}

const baseHeaders = (token) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/x-protobuf",
  accept: "text/event-stream",
  "x-warp-client-version": CLIENT_VERSION,
  "x-warp-os-category": "Windows",
})

// sseEvents yields the data lines of an SSE body as they arrive: Warp's
// events are base64 protobuf, one per line.
async function* sseEvents(body) {
  let buf = ""
  const lines = async function* () {
    for await (const chunk of body) {
      buf += chunk.toString("utf8")
      let at
      while ((at = buf.indexOf("\n")) >= 0) {
        yield buf.slice(0, at)
        buf = buf.slice(at + 1)
      }
    }
    if (buf) yield buf
  }()
  for await (const line of lines) {
    const m = line.match(/^data:\s*(.*)$/)
    if (!m) continue
    const raw = m[1].trim().replace(/^"|"$/g, "")
    let bytes = null
    try {
      bytes = Buffer.from(raw, "base64url")
    } catch {}
    if (bytes && bytes.length) yield bytes
  }
}

// warpEvents decodes the events one level: init, actions, finished.
async function* warpEvents(body) {
  for await (const buf of sseEvents(body)) {
    for (const f of fields(buf)) {
      if (f.num === 1 && f.data) {
        const [id] = byNum(f.data, 1)
        yield { init: { conversationId: id ? str(id) : "" } }
      } else if (f.num === 2 && f.data) {
        for (const a of byNum(f.data, 1)) {
          if (!a.data) continue
          for (const g of fields(a.data)) yield { action: g }
        }
      } else if (f.num === 3 && f.data) {
        const out = { reason: "other", message: "", usage: null }
        for (const g of fields(f.data)) {
          if (g.num === 2) out.reason = "done"
          else if (g.num === 3) out.reason = "length"
          else if (g.num === 4) out.reason = "quota"
          else if (g.num === 5) out.reason = "context"
          else if (g.num === 6) out.reason = "unavailable"
          else if (g.num === 7 && g.data) out.message = str(byNum(g.data, 1)[0])
          else if (g.num === 11 && g.data) {
            const meta = {}
            for (const h of fields(g.data)) {
              if (h.num === 10) meta.input = h.v
              else if (h.num === 3) meta.credits = f32(h)
            }
            out.usage = meta
          }
        }
        yield { finished: out }
      }
    }
  }
}

// ---- GraphQL: the account's models and its request allowance -------------------

async function gql(token, op, query, variables) {
  const res = await fetch(`${GRAPHQL}?op=${op}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Warp-Client-Version": CLIENT_VERSION,
      "X-Warp-OS-Category": "Windows",
    },
    body: JSON.stringify({ query, variables, operationName: op }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`Warp's ${op} answered ${res.status}`)
  const body = await res.json()
  const user = body?.data?.user
  const err = user?.error?.message
  if (err) throw new Error(String(err))
  return user?.user ?? null
}

const REQUEST_CONTEXT = {
  clientContext: { version: CLIENT_VERSION },
  osContext: { category: "Windows", name: "Windows", version: "10.0" },
}

const MODELS_QUERY = `query GetWorkspacesMetadataForUser($requestContext: RequestContext!) {
  user(requestContext: $requestContext) { ... on UserOutput { user { workspaces {
    featureModelChoice { agentMode { defaultId choices {
      displayName id reasoningLevel visionSupported
      usageMetadata { requestMultiplier }
      contextWindow { default max }
    } } } } } } } }`

let modelsCache = { at: 0, token: "", list: null }

async function accountModels(token) {
  if (modelsCache.token === token && Date.now() - modelsCache.at < MODELS_MS) return modelsCache.list
  const user = await gql(token, "GetWorkspacesMetadataForUser", MODELS_QUERY, { requestContext: REQUEST_CONTEXT })
  const out = {}
  for (const w of user?.workspaces ?? []) {
    for (const c of w?.featureModelChoice?.agentMode?.choices ?? []) {
      const ctx = Number(c?.contextWindow?.default) || 200_000
      out[c.id] = {
        id: c.id,
        name: c.displayName || c.id,
        tool_call: true,
        reasoning: !!c.reasoningLevel,
        attachment: !!c.visionSupported,
        temperature: true,
        modalities: { input: c.visionSupported ? ["text", "image"] : ["text"], output: ["text"] },
        limit: { context: ctx, output: 64_000 },
      }
    }
  }
  if (!Object.keys(out).length) throw new Error("Warp listed no models for this account")
  modelsCache = { at: Date.now(), token, list: out }
  return out
}

const LIMIT_QUERY = `query GetRequestLimitInfo($requestContext: RequestContext!) {
  user(requestContext: $requestContext) { ... on UserOutput { user {
    requestLimitInfo { isUnlimited requestsUsedSinceLastRefresh requestLimit nextRefreshTime requestLimitRefreshDuration }
    bonusGrants { requestCreditsGranted requestCreditsRemaining expiration }
  } } } }`

async function requestWindows(token) {
  const user = await gql(token, "GetRequestLimitInfo", LIMIT_QUERY, { requestContext: REQUEST_CONTEXT })
  const info = user?.requestLimitInfo
  const windows = []
  if (info && !info.isUnlimited && Number(info.requestLimit) > 0) {
    windows.push({
      name: "Requests",
      used: (100 * Number(info.requestsUsedSinceLastRefresh ?? 0)) / Number(info.requestLimit),
      aside: `${info.requestsUsedSinceLastRefresh}/${info.requestLimit}`,
      ...(info.nextRefreshTime ? { resetsAt: info.nextRefreshTime } : {}),
    })
  } else if (info?.isUnlimited) {
    windows.push({ name: "Requests", used: 0 })
  }
  let bonus = 0
  for (const g of user?.bonusGrants ?? []) bonus += Number(g.requestCreditsRemaining ?? 0)
  if (bonus > 0) windows.push({ name: "Bonus credits", used: 0, aside: `${bonus} left` })
  return { windows }
}

// ---- chat completions in, Warp's Request out ------------------------------------

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((p) => p?.type === "text").map((p) => p.text).join("\n")
      : ""

// buildRequest turns a chat completion into the protobuf Request. Warp's
// conversation state lives in tasks the client round-trips whole; rather
// than rebuild that model, every request starts one conversation whose
// query carries the transcript so far — the shape a stateless client can
// always give, and the one tool results ride back on too.
function buildRequest(chat) {
  const messages = chat.messages ?? []
  const model = typeof chat.model === "string" && chat.model ? chat.model : "auto"

  const settings = new PB().m(1, new PB().s(1, model))
  settings.v(9, 9) // supported_tools: CALL_MCP_TOOL — the only kind this answers
  if (chat.parallel_tool_calls) settings.v(4, 1)
  settings.v(17, 1) // supports_reasoning_message

  const req = new PB()

  // the agent's tools, as one MCP server's tools
  const tools = (chat.tools ?? []).filter((t) => t?.type === "function" && t?.function?.name)
  if (tools.length) {
    const server = new PB().s(1, "magpie").s(5, "magpie")
    for (const t of tools) {
      const tool = new PB().s(1, t.function.name).s(2, t.function.description || "")
      if (t.function.parameters && typeof t.function.parameters === "object") tool.m(3, structPB(t.function.parameters))
      server.m(4, tool)
    }
    req.m(6, new PB().m(3, server))
  }

  const context = new PB()
    .m(2, new PB().s(1, "Windows"))
    .m(3, new PB().s(1, "powershell"))

  const parts = []
  for (const m of messages) {
    const t = textOf(m.content)
    if (m.role === "system") parts.push(`[system instructions]\n${t}`)
    else if (m.role === "user") parts.push(`[user]\n${t}`)
    else if (m.role === "assistant") {
      let own = t
      for (const c of m.tool_calls ?? []) {
        own += `\n[assistant called ${c.function?.name}(${typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments ?? "")})]`
      }
      parts.push(`[assistant]\n${own}`)
    } else if (m.role === "tool") parts.push(`[tool result for ${m.tool_call_id}]\n${t}`)
  }
  const last = messages[messages.length - 1]
  let query
  if (messages.length === 1 && last?.role === "user") {
    // one user message and nothing else: it rides as itself
    query = textOf(last.content)
  } else if (parts.length > 1) {
    query = `The following is the transcript of a conversation so far, ending with what to answer now.\n\n${parts.join("\n\n")}\n\nContinue as the assistant: reply to the last message above${messages.some((m) => m.role === "tool") ? ", taking the tool results into account" : ""}.`
  } else {
    query = parts[0] || ""
  }
  const inputs = new PB().m(1, new PB().m(1, new PB().s(1, query)))
  const input = new PB().m(1, context).m(6, inputs)

  req.m(2, input).m(3, settings)
  return { body: req.out() }
}

// ---- the answer, as chat completion events ---------------------------------------

// turnEvents folds Warp's response into what a chat completion is made of:
// text deltas, reasoning deltas, whole tool calls, the end.
async function* turnEvents(body) {
  const texts = new Map() // message id -> { text, reasoning }
  const calls = []
  let conversationId = ""
  let ended = null
  let model = ""
  for await (const ev of warpEvents(body)) {
    if (ev.init) {
      conversationId = ev.init.conversationId
      continue
    }
    if (ev.finished) {
      ended = ev.finished
      continue
    }
    const { num, data } = ev.action ?? {}
    if (!data) continue
    if (num === 3 || num === 4 || num === 5) {
      // messages added to the task (2), a message updated (1), a message's
      // content appended to (1)
      const msgFs = num === 3 ? byNum(data, 2) : byNum(data, 1)
      for (const msgF of msgFs) {
        if (!msgF?.data) continue
        let id = ""
        for (const g of fields(msgF.data)) {
          if (g.num === 1) id = str(g)
          else if (g.num === 3 && g.data) {
            const text = str(byNum(g.data, 1)[0])
            const was = texts.get(id) ?? { text: "", reasoning: "" }
            if (num === 5) {
              was.text += text
              if (text) yield { text }
            } else if (text) {
              const grow = text.startsWith(was.text) ? text.slice(was.text.length) : text
              was.text = text
              if (grow) yield { text: grow }
            }
            texts.set(id, was)
          } else if (g.num === 15 && g.data) {
            const reasoning = str(byNum(g.data, 1)[0])
            const was = texts.get(id) ?? { text: "", reasoning: "" }
            if (num === 5) {
              was.reasoning += reasoning
              if (reasoning) yield { reasoning }
            } else if (reasoning) {
              const grow = reasoning.startsWith(was.reasoning) ? reasoning.slice(was.reasoning.length) : reasoning
              was.reasoning = reasoning
              if (grow) yield { reasoning: grow }
            }
            texts.set(id, was)
          } else if (g.num === 4 && g.data) {
            // a tool call, whole
            let callId = "", name = "", args = null
            for (const h of fields(g.data)) {
              if (h.num === 1) callId = str(h)
              else if (h.num === 12 && h.data) {
                for (const k of fields(h.data)) {
                  if (k.num === 1) name = str(k)
                  else if (k.num === 2 && k.data) args = structOf(k.data)
                }
              }
            }
            if (name) {
              const call = { id: callId || `call_${calls.length}`, name, args: args ?? {}, index: calls.length }
              calls.push(call)
              yield { tool: call }
            }
          } else if (g.num === 25 && g.data) {
            model = str(byNum(g.data, 1)[0])
          }
        }
      }
    }
  }
  if (model) yield { model }
  yield {
    end: {
      reason: ended?.reason ?? "other",
      message: ended?.message ?? "",
      usage: ended?.usage ?? null,
      tools: calls,
      conversationId,
    },
  }
}

// a clean stop for what ended the turn: "stop" | "length", or an error
function endFinish(end) {
  if (end.tools?.length) return "tool_calls"
  if (end.reason === "done" || end.reason === "other") return "stop"
  if (end.reason === "length") return "length"
  return null // quota, context, unavailable: an error
}
const END_STATUS = { quota: 429, context: 400, unavailable: 503 }

const usageOf = (u) => {
  if (!u) return undefined
  const input = Number(u.input ?? 0)
  return { prompt_tokens: input, completion_tokens: 0, total_tokens: input }
}

const errorBody = (status, message) => ({ error: { message, code: status } })

// ---- the plugin ------------------------------------------------------------------

export const WarpAuthPlugin = async ({ client }) => {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "Warp",
        npm: "@ai-sdk/openai-compatible",
        api: SERVER + "/warp/v1",
        models: SNAPSHOT,
      }
    },

    auth: {
      provider: PROVIDER,
      refreshLead: REFRESH_MARGIN,

      // magpie renews the sign-in before its end: Google is asked for a
      // fresh id token with the refresh token (Warp's own file is left be)
      async refresh(auth) {
        if (!auth || (!auth.refresh && !auth.key)) return undefined
        const fresh = await exchange(auth.refresh || auth.key)
        return { access: fresh.access, refresh: fresh.refresh, expires: fresh.expires }
      },

      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth || (!auth.access && !auth.refresh && !auth.key)) return {}
        return {
          baseURL: SERVER + "/warp/v1",
          apiKey: "warp",
          async fetch(input, init = {}) {
            const now = await getAuth()
            if (!now || (!now.refresh && !now.key && !now.access)) {
              return Response.json(errorBody(401, "Warp isn't signed in"), { status: 401, headers: { "X-Magpie-Sign-In": "expired" } })
            }
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            if (!/\/chat\/completions$/.test(new URL(url).pathname)) {
              return Response.json(errorBody(404, "only chat completions are served"), { status: 404 })
            }
            let chat
            try {
              const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
              chat = JSON.parse(typeof b === "string" ? b : dec.decode(b))
            } catch {
              return Response.json(errorBody(400, "a request that isn't JSON"), { status: 400 })
            }

            let token
            try {
              token = (await live(client, now)).access
            } catch (e) {
              return Response.json(errorBody(e.status ?? 401, e.message), {
                status: e.status ?? 401,
                headers: e.signIn === "expired" ? { "X-Magpie-Sign-In": "expired" } : {},
              })
            }

            // a model asked of a family Warp splits by effort, when the
            // account has that split, is asked of its variant
            let model = typeof chat.model === "string" && chat.model ? chat.model : "auto"
            try {
              const list = await accountModels(token)
              if (!list[model] && chat.reasoning_effort && list[`${model}-${chat.reasoning_effort}`]) {
                model = `${model}-${chat.reasoning_effort}`
              }
            } catch {}

            const { body } = buildRequest({ ...chat, model })

            let res
            try {
              res = await h2post(CHAT_URL, baseHeaders(token), body, init.signal)
            } catch (e) {
              return Response.json(errorBody(e.status ?? 502, e.message), { status: e.status ?? 502 })
            }
            if (res.status === 401 || res.status === 403) {
              return Response.json(errorBody(res.status, `Warp turned the request away (${res.status}); sign in again if it persists`), {
                status: res.status,
                headers: { "X-Magpie-Sign-In": "expired" },
              })
            }
            if (res.status !== 200) {
              return Response.json(errorBody(res.status, `Warp's agent answered ${res.status}`), { status: res.status })
            }
            const it = turnEvents(res.body())[Symbol.asyncIterator]()
            const id = "chatcmpl-" + randomBytes(12).toString("hex")
            const created = Math.floor(Date.now() / 1000)

            if (!chat.stream) {
              const msg = { role: "assistant", content: "" }
              let reasoning = ""
              let usage
              let end
              for (;;) {
                const r = await it.next()
                if (r.done) break
                const e = r.value
                if (e.text) msg.content += e.text
                else if (e.reasoning) reasoning += e.reasoning
                else if (e.tool) {
                  msg.tool_calls ??= []
                  msg.tool_calls.push({ id: e.tool.id, type: "function", function: { name: e.tool.name, arguments: JSON.stringify(e.tool.args ?? {}) } })
                } else if (e.end) {
                  end = e.end
                  usage = usageOf(e.end.usage)
                }
              }
              const finish = end ? endFinish(end) : "stop"
              if (finish === null && !msg.content && !msg.tool_calls?.length) {
                return Response.json(errorBody(END_STATUS[end.reason] ?? 500, end.message || `Warp's agent ended with ${end.reason}`), {
                  status: END_STATUS[end.reason] ?? 500,
                })
              }
              if (reasoning) msg.reasoning_content = reasoning
              return Response.json(
                {
                  id,
                  object: "chat.completion",
                  created,
                  model: chat.model,
                  choices: [{ index: 0, message: msg, finish_reason: finish ?? "stop" }],
                  ...(usage ? { usage } : {}),
                },
                { headers: { "X-Magpie-Sign-In": "kept" } },
              )
            }

            const chunk = (delta, finish_reason = null, extra = {}) =>
              enc.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: chat.model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`)
            const stream = new ReadableStream({
              async pull(ctl) {
                // keep taking events until one of them says something
                for (;;) {
                  let r
                  try {
                    r = await it.next()
                  } catch (e) {
                    ctl.enqueue(enc.encode(`data: ${JSON.stringify(errorBody(502, e.message))}\n\n`))
                    return ctl.close()
                  }
                  if (r.done) {
                    ctl.enqueue(enc.encode("data: [DONE]\n\n"))
                    return ctl.close()
                  }
                  const e = r.value
                  if (e.text) return void ctl.enqueue(chunk({ content: e.text }))
                  if (e.reasoning) return void ctl.enqueue(chunk({ reasoning_content: e.reasoning }))
                  if (e.tool) {
                    return void ctl.enqueue(
                      chunk({
                        tool_calls: [
                          {
                            index: e.tool.index,
                            id: e.tool.id,
                            type: "function",
                            function: { name: e.tool.name, arguments: JSON.stringify(e.tool.args ?? {}) },
                          },
                        ],
                      }),
                    )
                  }
                  if (e.end) {
                    const finish = endFinish(e.end)
                    if (finish !== null) {
                      const usage = usageOf(e.end.usage)
                      return void ctl.enqueue(chunk({}, finish, usage ? { usage } : {}))
                    }
                    ctl.enqueue(enc.encode(`data: ${JSON.stringify(errorBody(END_STATUS[e.end.reason] ?? 500, e.end.message || `Warp's agent ended with ${e.end.reason}`))}\n\n`))
                    return ctl.close()
                  }
                  // e.model: the model Warp ran — noted, nothing to send
                }
              },
              cancel() {
                it.return?.()
              },
            })
            return new Response(stream, {
              status: 200,
              headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Magpie-Sign-In": "kept" },
            })
          },
        }
      },

      methods: [
        {
          type: "oauth",
          label: "Use the Warp app's sign-in",
          async authorize() {
            const user = await warpUser()
            if (!user || !user.id_token?.id_token) {
              throw new Error("Warp isn't signed in on this machine: sign in in the Warp app first (its sign-in is kept where only it can read it)")
            }
            const head = user.id_token
            let access = head.id_token
            let refresh = head.refresh_token
            let expires = Number.isFinite(Date.parse(head.expiration_time)) ? Date.parse(head.expiration_time) : jwtExpires(access)
            if (expires <= Date.now() && refresh) {
              const fresh = await exchange(refresh)
              access = fresh.access
              refresh = fresh.refresh
              expires = fresh.expires
            }
            return {
              url: "",
              instructions: `Warp is signed in as ${user.email || "its account"}.`,
              method: "auto",
              callback: async () => ({
                type: "success",
                access,
                refresh,
                expires,
                accountId: user.email || "warp",
              }),
            }
          },
        },
        {
          type: "api",
          label: "Warp refresh token",
          async authorize(key) {
            const fresh = await exchange(String(key ?? "").trim())
            const claims = jwt(fresh.access)
            return {
              type: "success",
              access: fresh.access,
              refresh: fresh.refresh,
              expires: fresh.expires,
              accountId: claims.email || "warp",
            }
          },
        },
      ],

      // magpie's card: the request allowance of the period, and any bonus
      // credits beside it
      async usage(getAuth) {
        const auth = await getAuth()
        if (!auth || (!auth.access && !auth.refresh && !auth.key)) return { error: "Warp isn't signed in", windows: [], signIn: "kept" }
        try {
          const token = (await live(client, auth)).access
          return { ...(await requestWindows(token)), signIn: "kept" }
        } catch (e) {
          return { error: e.message, windows: [], signIn: "kept" }
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const have = provider?.models ?? {}
        if (!auth || (!auth.access && !auth.refresh && !auth.key)) return have
        try {
          const token = (await live(client, auth)).access
          return await accountModels(token)
        } catch {
          return have
        }
      },
    },
  }
}

// for tests
export const _internal = {
  PB, structPB, valueMsg, fields, byNum, str, f32, structOf, valueOf, buildRequest, turnEvents,
  warpUser, jwt, jwtExpires, exchange, endFinish,
  sseEvents, baseHeaders,
}
