import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startLogin } from "./login.mjs"

// agy-tui: Antigravity's models through agy's own interactive mode. Each
// request starts the real `agy` TUI in a terminal magpie gives it (`magpie
// tui-helper`, internal/tuihelper), types the conversation into its prompt
// as a person would paste it, and reads the answer from the transcript agy
// writes. Nothing here speaks to Google: agy does, as it does for anyone
// at its prompt.
//
// Each account has a home of its own (accountsDir), where agy keeps its
// sign-in as a file (SSH_CONNECTION, as in the agy-cli plugin), so the
// user's own ~/.gemini, skills and MCP servers are never used. agy runs
// with an agent of the request's own whose tools are none: v1 answers in
// text; the caller's tools are not offered to the model.

export const PROVIDER_ID = "agy-tui"
const PROVIDER_NAME = "Antigravity (agy TUI)"
const NPM = "@ai-sdk/openai-compatible"
const AGENT_NAME = "text-only"
const AGY_MANUAL = "https://antigravity.google/docs/cli"

// What agy 1.5's footer says: waiting for a message, and in a turn.
export const READY = "? for shortcuts"
export const BUSY = "esc to cancel"

// What agy asks the terminal before it draws, answered as xterm does.
export const REPLIES = [
  { ask: "\x1b[>c", answer: "\x1b[>1;10;0c" },
  { ask: "\x1b]11;?\x07", answer: "\x1b]11;rgb:0000/0000/0000\x1b\\" },
  { ask: "\x1b]10;?\x07", answer: "\x1b]10;rgb:ffff/ffff/ffff\x1b\\" },
]

const START_MS = 90_000
const SUBMIT_MS = 60_000
const PASTE_SETTLE_MS = 300
// how long agy may sit at its prompt after a turn before the transcript has
// its answer
const IDLE_MS = 5_000

function turnTimeout() {
  const n = Number(process.env.AGY_TUI_TURN_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : 15 * 60_000
}

// ---- accounts

const HOME_ID = /^[a-z0-9]{8,32}$/

export function accountsDir(env = process.env) {
  const base = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(os.homedir(), ".local", "state")
  return path.join(base, "magpie-agy-tui", "accounts")
}

export function homeOf(id, env = process.env) {
  return typeof id === "string" && HOME_ID.test(id) ? path.join(accountsDir(env), id) : null
}

export function homeOfAuth(auth) {
  return homeOf(auth?.metadata?.agyHome) ?? homeOf(String(auth?.key ?? "").replace(/^agy-tui:/, ""))
}

function newHome() {
  const id = randomBytes(8).toString("hex")
  const home = homeOf(id)
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  return { id, home }
}

export function tokenFile(home) {
  return path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token")
}

// agyEnv is what an agy for the account at home runs with: the host's
// environment, the account's HOME, and its sign-in kept in tokenFile, not
// the keyring every account would share.
export function agyEnv(home, parent = process.env, platform = process.platform) {
  const env = { ...parent, HOME: home, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0", TERM: "xterm-256color" }
  if (platform === "win32") env.USERPROFILE = home
  if (!Object.keys(parent).some((k) => k.toUpperCase() === "AGY_CLI_DISABLE_AUTO_UPDATE")) env.AGY_CLI_DISABLE_AUTO_UPDATE = "true"
  return env
}

// agy's first-run screens are the account home's own business: they were
// passed once its sign-in took. Written only where nothing is.
function settleHome(home) {
  const file = path.join(home, ".gemini", "antigravity-cli", "cache", "onboarding.json")
  if (fs.existsSync(file)) return
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify({ consumerOnboardingComplete: true, onboardingComplete: true }), { mode: 0o600 })
}

// ---- agy

export function findAgy(env = process.env, platform = process.platform) {
  const windows = platform === "win32"
  const paths = windows ? path.win32 : path.posix
  const home = os.homedir()
  const names = windows ? ["agy.exe"] : ["agy"]
  const candidates = env.AGY_PATH ? [env.AGY_PATH] : []
  for (const dir of (env.PATH || env.Path || "").split(windows ? ";" : ":")) {
    if (dir) candidates.push(...names.map((n) => paths.join(dir.replace(/^"|"$/g, ""), n)))
  }
  const dirs = windows
    ? [paths.join(env.LOCALAPPDATA || paths.join(home, "AppData", "Local"), "agy", "bin"), paths.join(home, ".local", "bin"), paths.join(home, ".gemini", "bin")]
    : [paths.join(home, ".local", "bin"), paths.join(home, ".gemini", "bin"), "/usr/local/bin", "/opt/homebrew/bin"]
  for (const dir of dirs) candidates.push(...names.map((n) => paths.join(dir, n)))
  // the copy the agy-cli plugin installed, when the machine has no other
  const data = windows ? (env.LOCALAPPDATA || paths.join(home, "AppData", "Local")) : (env.XDG_DATA_HOME || paths.join(home, ".local", "share"))
  candidates.push(paths.join(data, "magpie-agy-cli", names[0]))
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK)
      return c
    } catch {}
  }
  return null
}

function run(file, args, { env, timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, { env, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: error.message })
      return
    }
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill(), timeout)
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d))
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d))
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + error.message }) })
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

const helps = new Map()
async function agyHelp(agy) {
  if (!helps.has(agy)) helps.set(agy, run(agy, ["--help"], { env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" } }).then((r) => r.stdout + r.stderr))
  return helps.get(agy)
}

// parseModels reads `agy models`: one "<id>  <name>" a line.
export function parseModels(stdout) {
  const out = []
  for (const raw of String(stdout ?? "").split("\n")) {
    const m = /^(\S+)\s+(.+)$/.exec(raw.trim())
    if (m && /^[a-z0-9][\w.-]*$/i.test(m[1])) out.push({ id: m[1], name: m[2].trim() })
  }
  return out
}

async function listModels(agy, home) {
  // the account's provider, not a modelProvider a settings file names
  const args = (await agyHelp(agy)).includes("--settings") ? ["--settings", '{"modelProvider":""}', "models"] : ["models"]
  const r = await run(agy, args, { env: agyEnv(home) })
  const models = r.code === 0 ? parseModels(r.stdout) : []
  if (!models.length) throw new Error(`agy lists no models for this account${lastLine(r.stderr || r.stdout) ? `: ${lastLine(r.stderr || r.stdout)}` : ""}`)
  return models
}

function lastLine(text) {
  return String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? ""
}

// ---- the conversation, as typed

function textOf(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const out = []
  for (const part of content) {
    if (part?.type === "text" || part?.type === "input_text") out.push(part.text ?? "")
    else if (part?.type) throw Object.assign(new Error(`agy-tui takes text only (the message has ${part.type})`), { status: 400 })
  }
  return out.join("\n")
}

// promptOf is what is pasted into agy's prompt: the last user message
// alone, or with the instructions and the conversation before it.
export function promptOf(messages) {
  if (!Array.isArray(messages) || !messages.length) throw Object.assign(new Error("no messages"), { status: 400 })
  const system = []
  const turns = []
  for (const m of messages) {
    const text = textOf(m?.content).trim()
    if (m?.role === "system" || m?.role === "developer") {
      if (text) system.push(text)
    } else if (m?.role === "user" || m?.role === "assistant") {
      if (text) turns.push({ role: m.role, text })
    } else if (m?.role === "tool") {
      throw Object.assign(new Error("agy-tui runs no tools: the conversation has a tool result"), { status: 400 })
    }
  }
  if (!turns.length || turns.at(-1).role !== "user") throw Object.assign(new Error("the last message is not the user's"), { status: 400 })
  if (!system.length && turns.length === 1) return turns[0].text
  const parts = []
  if (system.length) parts.push(system.join("\n\n"))
  if (turns.length > 1) {
    parts.push(turns.slice(0, -1).map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n\n"))
    parts.push(`User: ${turns.at(-1).text}`)
  } else {
    parts.push(turns[0].text)
  }
  return parts.join("\n\n")
}

// ---- one turn in agy's TUI

function agentDefinition() {
  return [
    "---",
    `name: ${AGENT_NAME}`,
    "description: Answers in text",
    "mainAgent: true",
    "subagent: false",
    "tools: []",
    "inheritMcp: false",
    "inheritCustomizations: false",
    "---",
    "Answer in text.",
    "",
  ].join("\n")
}

const claimed = new Set()

// answerOf is the turn's answer in agy's transcript: a conversation agy
// started since `before`, whose user input is the prompt, and its last
// PLANNER_RESPONSE. The screen is not read for it: agy draws a refused
// call there too.
export function answerOf(brain, before, prompt, own = null) {
  const snip = prompt.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 60) ?? ""
  let ids = []
  try { ids = fs.readdirSync(brain) } catch {}
  for (const id of ids) {
    // another turn's, of the same words, running beside this one
    if (before.has(id) || (claimed.has(id) && id !== own)) continue
    const file = path.join(brain, id, ".system_generated", "logs", "transcript_full.jsonl")
    let text
    try { text = fs.readFileSync(file, "utf8") } catch { continue }
    let mine = false
    let answer = ""
    for (const line of text.split("\n")) {
      let row
      try { row = JSON.parse(line) } catch { continue }
      const type = row.type ?? row.Type
      const content = row.content ?? row.Content
      if (type === "PLANNER_RESPONSE") {
        if (mine && typeof content === "string" && content) answer = content
      } else if (!mine && snip && Object.values(row).some((v) => typeof v === "string" && v.includes(snip))) {
        mine = true
      }
    }
    if (mine) return { id, answer }
  }
  return null
}

// screenTail is what agy drew last, for an error: its warning when it
// shows one ("⚠ …" up to the next rule), else the last lines.
export function screenTail(screen, n = 8) {
  const lines = String(screen ?? "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() && !l.includes(READY))
  const warn = lines.findLastIndex((l) => l.trimStart().startsWith("⚠"))
  if (warn >= 0) {
    const out = []
    for (const l of lines.slice(warn)) {
      if (/^\s*─{3,}/.test(l)) break
      out.push(l.trim())
    }
    return out.join("\n")
  }
  return lines.slice(-n).join("\n")
}

class Failure extends Error {
  constructor(status, message, headers) {
    super(message)
    this.status = status
    this.headers = headers
  }
}

// startTurn starts agy in its terminal and types the prompt; it resolves
// once agy has the message, with `answer`, a promise of its reply.
export async function startTurn({ agy, home, model, prompt, signal, helper = process.env.MAGPIE_EXE }) {
  if (!helper) throw new Failure(501, "this magpie has no tui-helper: update magpie")
  settleHome(home)
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-tui-")))
  const agentDir = path.join(ws, ".agents", "agents", AGENT_NAME)
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, "agent.md"), agentDefinition(), { mode: 0o600 })
  const brain = path.join(home, ".gemini", "antigravity-cli", "brain")
  let before
  try { before = new Set(fs.readdirSync(brain)) } catch { before = new Set() }

  // the folder is trusted for this session only (never saved)
  const settings = { trustedWorkspaces: [ws] }
  const args = ["--settings", JSON.stringify(settings), "--agent", AGENT_NAME]
  if (model) args.push("--model", model)
  const child = spawn(helper, ["tui-helper"], { env: agyEnv(home), cwd: ws, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  let screen = ""
  let ended = null
  let errorLine = ""
  let stderr = ""
  const waiters = new Set()
  const poke = () => { for (const w of waiters) w() }
  let buf = ""
  child.stdout.setEncoding("utf8").on("data", (d) => {
    buf += d
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (typeof o.screen === "string") screen = o.screen
      if (o.error) errorLine = o.error
      if (o.exit) ended = o.exit
    }
    poke()
  })
  child.stderr.setEncoding("utf8").on("data", (d) => { stderr = (stderr + d).slice(-4000) })
  child.stdin.on("error", () => {})
  const closed = new Promise((resolve) => child.on("close", () => { ended ??= { code: -1, error: errorLine || lastLine(stderr) || "the terminal ended" }; poke(); resolve() }))
  child.on("error", (e) => { errorLine = e.message })
  const send = (v) => { try { child.stdin.write(JSON.stringify(v) + "\n") } catch {} }
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    send({ stop: true })
    try { child.stdin.end() } catch {}
    const late = setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 5000)
    await closed
    clearTimeout(late)
    if (process.env.AGY_TUI_KEEP) return
    fs.rmSync(ws, { recursive: true, force: true })
  }
  const onAbort = () => { cleanup() }
  signal?.addEventListener?.("abort", onAbort, { once: true })

  const waitFor = (what, ok, ms) => new Promise((resolve, reject) => {
    const check = () => {
      if (ok()) return done(resolve)
      if (signal?.aborted) return done(() => reject(new Failure(499, "the request was cancelled")))
      if (ended) return done(() => reject(new Failure(502, `agy ended ${what}: ${errorLine || ended.error || `exit ${ended.code}`}${screenTail(screen) ? `\n${screenTail(screen)}` : ""}`)))
    }
    const timer = setTimeout(() => done(() => reject(new Failure(504, `agy: no ${what} in ${Math.round(ms / 1000)}s${screenTail(screen) ? `:\n${screenTail(screen)}` : ""}`))), ms)
    const tick = setInterval(check, 250)
    const done = (f) => { clearTimeout(timer); clearInterval(tick); waiters.delete(check); f() }
    waiters.add(check)
    check()
  })
  const ready = () => screen.includes(READY) && !screen.includes(BUSY)

  try {
    send({ start: { path: agy, args, dir: ws, replies: REPLIES } })
    await waitFor("prompt", ready, START_MS)
    send({ write: `\x1b[200~${prompt}\x1b[201~` })
    await new Promise((r) => setTimeout(r, PASTE_SETTLE_MS))
    send({ write: "\r" })
    // agy has the message once it is in a turn, or its transcript has it
    // (a turn that failed at once may never draw "esc to cancel")
    await waitFor("turn", () => screen.includes(BUSY) || Boolean(answerOf(brain, before, prompt)), SUBMIT_MS)
  } catch (error) {
    await cleanup()
    throw error
  }

  const answer = (async () => {
    let found = null
    try {
      // back at its prompt with nothing in the transcript for a while:
      // the turn failed, and what agy drew says why (a quota, a refusal)
      let idleSince = 0
      await waitFor("answer", () => {
        if (!ready()) {
          idleSince = 0
          return false
        }
        found = answerOf(brain, before, prompt, found?.id)
        if (found?.id) claimed.add(found.id)
        if (found?.answer) return true
        idleSince ||= Date.now()
        return Date.now() - idleSince > IDLE_MS
      }, turnTimeout())
      if (!found?.answer) throw new Failure(502, `agy answered nothing${screenTail(screen) ? `:\n${screenTail(screen)}` : ""}`)
      return found.answer
    } finally {
      await cleanup()
      forget(brain, found?.id)
    }
  })()
  return { answer }
}

// forget removes the conversation agy kept for a turn from the account's
// home: each request is a conversation of its own.
function forget(brain, id) {
  if (!id) return
  claimed.delete(id)
  if (process.env.AGY_TUI_KEEP) return
  fs.rmSync(path.join(brain, id), { recursive: true, force: true })
  const conv = path.join(path.dirname(brain), "conversations")
  try {
    for (const name of fs.readdirSync(conv)) if (name.startsWith(id)) fs.rmSync(path.join(conv, name), { recursive: true, force: true })
  } catch {}
}

// ---- OpenAI chat completions

function jsonError(status, message, headers = {}) {
  return new Response(JSON.stringify({ error: { message, type: "agy_tui_error" } }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

function completion(id, model, text) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  }
}

function streamOf(id, model, answer) {
  const enc = new TextEncoder()
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  let keep
  return new ReadableStream({
    async start(c) {
      c.enqueue(enc.encode(chunk({ role: "assistant", content: "" })))
      // the turn may take minutes: a comment now and then keeps the
      // connection from looking dead
      keep = setInterval(() => { try { c.enqueue(enc.encode(": working\n\n")) } catch {} }, 15_000)
      try {
        const text = await answer
        c.enqueue(enc.encode(chunk({ content: text })))
        c.enqueue(enc.encode(chunk({}, "stop")))
      } catch (error) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: error.message, type: "agy_tui_error" } })}\n\n`))
      } finally {
        clearInterval(keep)
      }
      c.enqueue(enc.encode("data: [DONE]\n\n"))
      c.close()
    },
    cancel() { clearInterval(keep) },
  })
}

export async function handle(home, input, init = {}) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url || ""
  if (!/\/chat\/completions(?:$|[?#])/.test(url)) return jsonError(404, `agy-tui serves chat completions, not ${url}`)
  let body
  try {
    const raw = init.body != null ? (typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body)) : await input.text()
    body = JSON.parse(raw)
  } catch {
    return jsonError(400, "the request is not JSON")
  }
  if (!home) return jsonError(401, "agy-tui: no account; sign in again", { "X-Magpie-Sign-In": "expired" })
  if (!fs.existsSync(tokenFile(home))) return jsonError(401, "agy-tui: the account's agy is signed out; sign in again", { "X-Magpie-Sign-In": "expired" })
  const agy = findAgy()
  if (!agy) return jsonError(503, `agy CLI not found on this machine: ${AGY_MANUAL}`)
  const signal = init.signal ?? input?.signal
  const id = `chatcmpl-${randomBytes(12).toString("hex")}`
  const model = String(body.model ?? "")
  let turn
  try {
    const prompt = promptOf(body.messages)
    turn = await startTurn({ agy, home, model, prompt, signal })
  } catch (error) {
    return jsonError(error.status ?? 502, error.message, error.headers)
  }
  if (body.stream) {
    return new Response(streamOf(id, model, turn.answer), { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
  }
  try {
    return new Response(JSON.stringify(completion(id, model, await turn.answer)), { status: 200, headers: { "Content-Type": "application/json" } })
  } catch (error) {
    return jsonError(error.status ?? 502, error.message)
  }
}

// ---- the plugin

function modelEntry(m) {
  return {
    id: m.id,
    name: m.name,
    npm: NPM,
    api: { id: m.id, url: "agy-tui://local", npm: NPM },
    limit: { context: 1_000_000, output: 65_536 },
  }
}

function signIn(agy) {
  let account
  try {
    account = newHome()
  } catch (error) {
    return { type: "failed", error: `couldn't make a folder for the account: ${error.message}` }
  }
  const fail = (error) => {
    fs.rmSync(account.home, { recursive: true, force: true })
    return { type: "failed", error }
  }
  return startLogin(agy, agyEnv(account.home)).then((login) => {
    if (login.error) return fail(login.error)
    return {
      url: login.url,
      instructions: "",
      method: "code",
      callback: async (code, opts = {}) => {
        const done = await login.finish(code, { signal: opts.signal })
        if (done.error) return fail(done.error)
        try {
          await listModels(agy, account.home)
        } catch (error) {
          return fail(`agy signed in, but ${error.message}`)
        }
        return { type: "success", key: `agy-tui:${account.id}`, metadata: { agyHome: account.id } }
      },
    }
  })
}

export const AgyTuiPlugin = async () => ({
  auth: {
    provider: PROVIDER_ID,
    methods: [
      {
        // agy's own Google sign-in (`agy acp --login`), in the account's
        // home: magpie opens its link and takes the code the page shows
        type: "oauth",
        label: "Sign in with Google",
        labels: { zh: "使用 Google 登录", "zh-TW": "使用 Google 登入", ja: "Google でサインイン" },
        authorize: async () => {
          const agy = findAgy()
          if (!agy) return { type: "failed", error: `agy CLI not found. Install Antigravity CLI: ${AGY_MANUAL}` }
          return signIn(agy)
        },
      },
    ],
    loader: async (getAuth) => {
      const auth = typeof getAuth === "function" ? await getAuth() : getAuth
      const home = homeOfAuth(auth)
      return {
        baseURL: "agy-tui://local",
        apiKey: "agy-tui",
        fetch: (input, init) => handle(home, input, init),
      }
    },
  },
  config: async (cfg) => {
    cfg.provider ??= {}
    const was = cfg.provider[PROVIDER_ID] ?? {}
    cfg.provider[PROVIDER_ID] = { npm: NPM, ...was, name: was.name || PROVIDER_NAME }
  },
  provider: {
    id: PROVIDER_ID,
    npm: NPM,
    models: async (_given, ctx) => {
      const home = homeOfAuth(ctx?.auth)
      const agy = findAgy()
      if (!home || !agy) return {}
      const out = {}
      for (const m of await listModels(agy, home)) out[m.id] = modelEntry(m)
      return out
    },
  },
})

export default { id: PROVIDER_ID, server: AgyTuiPlugin }
