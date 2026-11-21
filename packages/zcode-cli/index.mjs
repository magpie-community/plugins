// zcode-cli: ZCode's models through the ZCode CLI on this computer.
//
// Each request runs `zcode --prompt … --output-format stream-json`, ZCode's
// documented headless mode (apps/zcode-cli/docs/usage in zai-org/ZCode).
// The ZCode process signs in and makes every request itself, with its own
// sign-in and its own headers: the plugin never reads ZCode's credentials,
// sends nothing to Z.ai itself and stands in for no client. Its output is
// turned back into an Anthropic Messages reply (stream.mjs).
//
// What it doesn't do (yet): the client's own tools. ZCode runs with its own
// tools in plan mode, in an empty folder of its own, and the reply is text
// (and reasoning). Each request is a ZCode run of its own, with the whole
// conversation in its prompt (prompt.mjs).

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { Collector, errorOf, lastErrorLine } from "./stream.mjs"
import { render } from "./prompt.mjs"

export const PROVIDER_ID = "zcode-cli"
const PROVIDER_NAME = "ZCode (local CLI)"
const NPM_ANTHROPIC = "@ai-sdk/anthropic"
const MANUAL = "https://github.com/zai-org/ZCode"

// The model ZCode is set to use, as it is: nothing is chosen for it.
export const DEFAULT_MODEL = "zcode-default"

// The models a Coding Plan account has in ZCode. Picking one gives ZCode a
// provider file of its own for the run (selectionFile), never the user's.
export const MODELS = [
  { id: DEFAULT_MODEL, name: "ZCode's own model choice", context: 200_000, output: 32_000 },
  { id: "GLM-5.3", name: "GLM-5.3", context: 200_000, output: 128_000 },
  { id: "GLM-5.3-Flash", name: "GLM-5.3-Flash", context: 200_000, output: 128_000 },
  { id: "GLM-5-Turbo", name: "GLM-5-Turbo", context: 200_000, output: 128_000 },
]

// The plan a model is picked from: ZCode's providerId for a Z.ai Coding
// Plan account; ZCODE_CLI_PROVIDER names another (BigModel's is
// account:bigmodel-individual-coding-plan).
const planProvider = () => process.env.ZCODE_CLI_PROVIDER?.trim() || "account:zai-individual-coding-plan"

// ZCode's tools that wait on a person or hand work to another agent: with
// no one to answer in a headless run they only fail (02-cli-reference,
// 04-tools).
const DISALLOWED = "AskUserQuestion EnterPlanMode ExitPlanMode Agent Task"

// plan: ZCode reads but doesn't write, so a reply can't change files.
const mode = () => {
  const m = process.env.ZCODE_CLI_MODE?.trim()
  return ["plan", "edit", "build", "guarded", "yolo"].includes(m) ? m : "plan"
}

const isFile = (p) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function onPath(names) {
  for (const dir of String(process.env.PATH || "").split(delimiter)) {
    if (!dir) continue
    for (const n of names) {
      const p = join(dir, n)
      if (isFile(p)) return p
    }
  }
  return null
}

// The ZCode app's bundled CLI (Resources/glm/zcode.cjs), and the app's own
// executable to run it with (ELECTRON_RUN_AS_NODE, which ZCode's desktop
// host uses for the same file).
function appCLI() {
  if (process.platform !== "darwin") return null
  for (const app of ["/Applications/Z Code.app", join(homedir(), "Applications", "Z Code.app"), "/Applications/ZCode.app"]) {
    const cjs = join(app, "Contents", "Resources", "glm", "zcode.cjs")
    if (!isFile(cjs)) continue
    let electron = null
    try {
      const dir = join(app, "Contents", "MacOS")
      const exe = readdirSync(dir).find((n) => isFile(join(dir, n)))
      if (exe) electron = join(dir, exe)
    } catch {}
    return { cjs, electron }
  }
  return null
}

const isScript = (p) => /\.(?:c|m)?js$/i.test(p)

// findZcode is how to run ZCode's CLI: { file, args, env } with the CLI's
// own arguments to come after args, or null when this computer has none.
// ZCODE_CLI names it (a binary, or a .cjs to run with Node); else `zcode`
// on PATH; else the ZCode app's bundled CLI.
export function findZcode() {
  const runScript = (script, electron = null) => {
    const node = process.env.ZCODE_CLI_NODE?.trim() || onPath(process.platform === "win32" ? ["node.exe"] : ["node"])
    if (node) return { file: node, args: [script], env: {} }
    if (electron) return { file: electron, args: [script], env: { ELECTRON_RUN_AS_NODE: "1" } }
    return null
  }
  const given = process.env.ZCODE_CLI?.trim()
  if (given) {
    if (!existsSync(given)) return null
    return isScript(given) ? runScript(given) : { file: given, args: [], env: {} }
  }
  const bin = onPath(process.platform === "win32" ? ["zcode.exe", "zcode.cmd"] : ["zcode"])
  if (bin) return { file: bin, args: [], env: {}, shell: /\.cmd$/i.test(bin) }
  const app = appCLI()
  if (app) return runScript(app.cjs, app.electron)
  return null
}

// selectionFile writes the provider file ZCode is pointed at for one run
// (ZCODE_PERSONAL_PROVIDER_CONFIG_FILE): no providers of its own, only the
// model to use. The user's ~/.zcode/v2/provider_config.json is never read
// or written.
export function selectionFile(dir, modelId) {
  const file = join(dir, "provider_config.json")
  const cfg = {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      defaultModelSelection: { providerId: planProvider(), modelId },
    },
  }
  writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  return file
}

export function modelOf(body) {
  const raw = String(body?.model || "")
  const id = (raw.includes("/") ? raw.split("/").pop() : raw).replace(/\[1m\]$/i, "")
  return MODELS.find((m) => m.id.toLowerCase() === id.toLowerCase())?.id ?? null
}

function jsonError(status, message, code) {
  return new Response(
    JSON.stringify({ type: "error", error: { type: status === 400 ? "invalid_request_error" : status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status === 429 ? "rate_limit_error" : "api_error", ...(code ? { code } : {}), message } }),
    { status, headers: { "Content-Type": "application/json", ...(status === 401 ? { "X-Magpie-Sign-In": "expired" } : {}) } },
  )
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

// Ends ZCode and whatever it started (its Bash, its MCP servers): it runs
// as a process group of its own off Windows.
function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const kill = (sig) => {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      } else process.kill(-child.pid, sig)
    } catch {
      try {
        child.kill(sig)
      } catch {}
    }
  }
  kill("SIGTERM")
  const t = setTimeout(() => kill("SIGKILL"), 3000)
  t.unref?.()
}

// run starts ZCode on one request. It gives back the child and an async
// iterator of deltas; done settles with { code, stderr, collector }.
export function run(cli, body, signal) {
  const dir = mkdtempSync(join(tmpdir(), "zcode-cli-"))
  const work = join(dir, "work")
  // ZCode's working folder, apart from the provider file beside it
  mkdirSync(work)
  const { prompt, attach } = render(body, work)
  const model = modelOf(body)
  const env = { ...process.env, ...cli.env, NO_COLOR: "1" }
  if (model && model !== DEFAULT_MODEL) env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = selectionFile(dir, model)
  const args = [...cli.args, "--prompt", prompt, "--cwd", work, "--mode", mode(), "--output-format", "stream-json", "--no-color", "--disallowed-tools", DISALLOWED]
  for (const f of attach) args.push("--attach", f)
  const child = spawn(cli.file, args, {
    cwd: work,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
    shell: !!cli.shell,
  })
  const collector = new Collector()
  let stderr = ""
  const queue = []
  let wake = null
  let finished = false
  const push = (item) => {
    queue.push(item)
    wake?.()
  }
  let buf = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      for (const d of collector.take(line)) push(d)
    }
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (c) => {
    if (stderr.length < 64 * 1024) stderr += c
  })
  const onAbort = () => stop(child)
  signal?.addEventListener?.("abort", onAbort, { once: true })
  const done = new Promise((resolve) => {
    const end = (code) => {
      if (finished) return
      finished = true
      if (buf) for (const d of collector.take(buf)) push(d)
      buf = ""
      signal?.removeEventListener?.("abort", onAbort)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
      wake?.()
      resolve({ code, stderr, collector })
    }
    child.on("error", (e) => {
      stderr += `\nError: ${e.message}`
      end(-1)
    })
    child.on("close", (code) => end(code))
  })
  async function* deltas() {
    for (;;) {
      while (queue.length) yield queue.shift()
      if (finished) return
      await new Promise((r) => (wake = r))
      wake = null
    }
  }
  return { child, deltas: deltas(), done }
}


// failedOf is a finished run's failure, or null when it answered.
function failedOf({ code, stderr, collector }) {
  if (collector.failure) return errorOf(collector.failure)
  if (code !== 0) return errorOf(lastErrorLine(stderr) || `ZCode CLI exited with ${code}`)
  if (!collector.result && !collector.text) return errorOf(lastErrorLine(stderr) || "ZCode CLI ended without a reply")
  if (collector.result?.projection?.status === "failed" && !collector.text) return errorOf(collector.result.response || "ZCode's turn failed")
  return null
}

const msgId = () => "msg_" + Math.random().toString(36).slice(2) + Date.now().toString(36)

// answer serves one Messages request through ZCode.
export async function answer(body, signal) {
  const cli = findZcode()
  if (!cli) return jsonError(503, `ZCode CLI not found on this computer: install ZCode (${MANUAL}), or set ZCODE_CLI to its zcode or zcode.cjs`, "zcode_not_found")
  if (!Array.isArray(body?.messages) || !body.messages.length) return jsonError(400, "messages is empty")
  const model = body.model || DEFAULT_MODEL
  const r = run(cli, body, signal)

  if (body.stream === false) {
    const out = await r.done
    const failed = failedOf(out)
    if (failed) return jsonError(failed.status, failed.message, failed.code)
    const c = out.collector
    const content = []
    if (c.thinking) content.push({ type: "thinking", thinking: c.thinking, signature: "" })
    content.push({ type: "text", text: c.text })
    return new Response(JSON.stringify({ id: msgId(), type: "message", role: "assistant", model, content, stop_reason: "end_turn", stop_sequence: null, usage: c.usage() }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  // Wait for the first delta (or the end) before answering, so a run that
  // fails at once (not signed in, blocked) is an HTTP error magpie can act
  // on, not a stream that ends in one.
  const it = r.deltas
  const first = await it.next()
  if (first.done) {
    const out = await r.done
    const failed = failedOf(out)
    if (failed) return jsonError(failed.status, failed.message, failed.code)
  }
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    async start(ctl) {
      const send = (e, d) => ctl.enqueue(enc.encode(sse(e, d)))
      send("message_start", { type: "message_start", message: { id: msgId(), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })
      let index = -1
      let open = null
      const close = () => {
        if (!open) return
        if (open === "thinking") send("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "" } })
        send("content_block_stop", { type: "content_block_stop", index })
        open = null
      }
      const emit = (d) => {
        if (open !== d.kind) {
          close()
          index++
          open = d.kind
          send("content_block_start", { type: "content_block_start", index, content_block: d.kind === "thinking" ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" } })
        }
        send("content_block_delta", { type: "content_block_delta", index, delta: d.kind === "thinking" ? { type: "thinking_delta", thinking: d.delta } : { type: "text_delta", text: d.delta } })
      }
      try {
        if (!first.done) emit(first.value)
        for await (const d of it) emit(d)
        const out = await r.done
        close()
        const failed = failedOf(out)
        if (failed && !out.collector.text) {
          send("error", { type: "error", error: { type: failed.status === 429 ? "rate_limit_error" : "api_error", message: failed.message } })
        } else {
          send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: out.collector.usage() })
          send("message_stop", { type: "message_stop" })
        }
      } catch (e) {
        send("error", { type: "error", error: { type: "api_error", message: String(e?.message ?? e) } })
      }
      ctl.close()
    },
    cancel() {
      stop(r.child)
    },
  })
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
}

async function bodyOf(input, init) {
  const raw = init?.body != null ? (typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body)) : typeof input?.text === "function" ? await input.text() : ""
  return JSON.parse(raw)
}

function estimateTokens(body) {
  return Math.ceil(JSON.stringify({ s: body.system ?? "", m: body.messages ?? [] }).length / 4)
}

export async function zcodeFetch(input, init = {}) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url || ""
  let body
  try {
    body = await bodyOf(input, init)
  } catch (e) {
    return jsonError(400, `invalid request: ${e.message}`)
  }
  if (/\/count[_-]tokens(?:$|[/?#])/i.test(url)) {
    return new Response(JSON.stringify({ input_tokens: estimateTokens(body) }), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  try {
    return await answer(body, init.signal)
  } catch (e) {
    return jsonError(502, String(e?.message ?? e))
  }
}

function catalog() {
  const out = {}
  for (const m of MODELS) {
    out[m.id] = {
      id: m.id,
      name: m.name,
      npm: NPM_ANTHROPIC,
      limit: { context: m.context, output: m.output },
      api: { id: m.id, url: "zcode://local", npm: NPM_ANTHROPIC },
      reasoning: true,
      capabilities: { reasoning: true, attachment: true, input: { text: true, image: true }, output: { text: true } },
    }
  }
  return out
}

export const ZCodeCLIPlugin = async () => ({
  auth: {
    provider: PROVIDER_ID,
    // magpie's hook for the CLI a plugin runs through; OpenCode ignores it.
    // ZCode is not installed from here: it is the user's own app.
    cli: {
      name: "ZCode",
      manual: MANUAL,
      installed: async () => findZcode() !== null,
      install: async () => {
        if (findZcode()) return
        throw new Error(`Install ZCode (${MANUAL}), then sign in to it with \`zcode login\` in a terminal`)
      },
    },
    methods: [
      {
        // ZCode keeps its own sign-in (`zcode login`): this saves nothing
        // but that ZCode is to be used, and reads none of ZCode's
        // credentials.
        type: "oauth",
        label: "Use ZCode's own sign-in",
        labels: { zh: "使用 ZCode 自己的登录", "zh-TW": "使用 ZCode 自己的登入", ja: "ZCode 自身のサインインを使う" },
        authorize: async () => {
          if (!findZcode()) return { type: "failed", error: `ZCode CLI not found: install ZCode (${MANUAL}), or set ZCODE_CLI to its zcode or zcode.cjs` }
          return { url: "", instructions: "Requests run through ZCode's own sign-in. If ZCode isn't signed in, run `zcode login` in a terminal first.", method: "auto", callback: async () => ({ type: "success", key: "zcode-cli" }) }
        },
      },
    ],
    loader: async () => ({ baseURL: "zcode://local", apiKey: "zcode-cli", fetch: zcodeFetch }),
  },
  config: async (cfg) => {
    cfg.provider ??= {}
    const was = cfg.provider[PROVIDER_ID] ?? {}
    cfg.provider[PROVIDER_ID] = { npm: NPM_ANTHROPIC, ...was, name: was.name || PROVIDER_NAME, models: { ...catalog(), ...(was.models ?? {}) } }
  },
  provider: {
    id: PROVIDER_ID,
    npm: NPM_ANTHROPIC,
    models: async () => catalog(),
  },
})

export default { id: PROVIDER_ID, server: ZCodeCLIPlugin }
