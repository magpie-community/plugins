// Agent Lens — the gateway hook that watches what each agent behind the
// gateway costs you.
//
//   {"port": 3492, "dataDir": "", "gatewayTimeoutMs": 2000, "agents": []}
//
// One magpie request is one model request: the gateway routes it, the client
// (the agent) has already assembled the body, and the tool declarations in
// that body are what the agent re-sends on every turn. Their size is the
// part of the input the user pays for again and again, and no upstream
// usage page counts it per agent.
//
// What this hook records, per request, by agent:
//   - the tokens the upstream reported (input, output, cache read, cache write)
//   - the tool declarations' size: how many, how many bytes, and their names
//   - the outcome (the request succeeded or not)
//
// What it never records: the conversation, the prompt, the user's words, the
// tool arguments, the credentials. Only names, counts and numbers, so the
// file it writes is safe to keep and to show.
//
// The rows go to ~/.config/magpie/agent-lens/tools.jsonl (or dataDir). The page (a
// local service next to it) reads that file and draws the comparison.
//
// The gateway's contract for this file:
//   export async function onRequest(body, ctx) — before routing. Returning
//     undefined leaves the request as it was; returning a body that changed
//     the tools, the model or the streaming rolls the whole request back.
//     This hook only reads, so it returns undefined.
//   export async function onResponse(reply, ctx) — after the reply is whole.
//     ctx.request is the accepted request, ctx.success says whether it
//     worked. This is best-effort: a notification may be lost, and that is
//     fine, a missing row is not a wrong row.

import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { measureTools } from "./lib/measure.mjs"
import { toolsLog } from "./lib/paths.mjs"


// Rows older than this are dropped when the file is rewritten: the file is
// a rolling window of the recent past, not a ledger of all time.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
// The file is rewritten (not appended to) once it passes this size.
const MAX_FILE_BYTES = 8 * 1024 * 1024
// Below this size the file is left alone: rewriting it costs a read of the
// whole thing, and there is nothing to gain from dropping a few old rows.
const ROLLOVER_MIN_BYTES = 512 * 1024

// The hook's own options, filled in by the gateway before the first call.
let OPTIONS = {
  port: 3492,
  dataDir: "",
  gatewayTimeoutMs: 2000,
  agents: [],
}

function dataPath() {
  return toolsLog(OPTIONS)
}

// The agent names this hook watches; empty means all of them.
function wanted(agent) {
  if (!agent) return false
  if (!Array.isArray(OPTIONS.agents) || OPTIONS.agents.length === 0) return true
  return OPTIONS.agents.some((a) => String(a).trim().toLowerCase() === String(agent).toLowerCase())
}

// The tokens a reply reports, in the shapes the four protocols use.
function usageOf(reply) {
  const u = reply?.usage ?? reply?.usage_metadata ?? reply?.usageMetadata
  if (!u || typeof u !== "object") return null
  return {
    in: num(u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount ?? u.input),
    out: num(u.output_tokens ?? u.completion_tokens ?? u.candidatesTokenCount ?? u.output),
    cacheRead: num(u.cache_read_input_tokens ?? u.cached_content_token_count ?? u.cacheRead),
    cacheWrite: num(u.cache_creation_input_tokens ?? u.cacheWrite),
  }
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

// The row this hook writes. Everything in it is a number or a name.
function row(ctx, body, reply, success) {
  const tools = measureTools(body)
  const r = {
    t: Date.now(),
    agent: ctx?.agent ?? "unknown",
    model: ctx?.model ?? body?.model ?? "unknown",
    protocol: ctx?.protocol ?? "unknown",
    path: ctx?.path ?? "",
    tools: tools.count,
    toolBytes: tools.bytes,
    toolNames: tools.names.slice(0, 60),
    ok: success !== false,
  }
  const u = usageOf(reply)
  if (u) {
    r.in = u.in
    r.out = u.out
    r.cacheRead = u.cacheRead
    r.cacheWrite = u.cacheWrite
  }
  return r
}

// The hook's entry point: called before the request goes to the model.
// This hook only reads, so it returns undefined and the request goes on
// exactly as it came.
export async function onRequest(body, ctx) {
  OPTIONS = { ...OPTIONS, ...(ctx?.options ?? {}) }
  return undefined
}

// The hook's other entry point: called after the model replied. This is
// where the row is written.
export async function onResponse(reply, ctx) {
  OPTIONS = { ...OPTIONS, ...(ctx?.options ?? {}) }
  const agent = ctx?.agent ?? "unknown"
  if (!wanted(agent)) return

  try {
    // ctx.request is the request the gateway accepted; it carries the tool
    // declarations, which the reply knows nothing about.
    const body = ctx?.request
    await append(row(ctx, body, reply, ctx?.success !== false))
  } catch {
    // A hook that fails leaves the request as it was. Never let a write
    // error touch the user's request.
  }
}

// Append one row to the data file, rolling it over when it gets too big
// or too old.
async function append(r) {
  const file = dataPath()
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, JSON.stringify(r) + "\n", "utf8")
  await rollover(file)
}

// Rewrite the file when it has grown too big or holds rows older than the
// window. The rewrite is atomic (write beside, then rename), so a reader
// never sees a half-written file.
async function rollover(file) {
  let st
  try {
    st = await stat(file)
  } catch {
    return
  }
  if (st.size < ROLLOVER_MIN_BYTES && st.size <= MAX_FILE_BYTES) return

  const cutoff = Date.now() - MAX_AGE_MS
  const kept = await prune(file, cutoff)
  if (kept.length === 0) return
  await writeFile(file + ".tmp", kept.join("\n") + "\n", "utf8")
  await rename(file + ".tmp", file)
}

// The rows that are still inside the window, as JSON lines.
async function prune(file, cutoff) {
  let text
  try {
    text = await readFile(file, "utf8")
  } catch {
    return []
  }
  const out = []
  for (const line of text.split("\n")) {
    if (!line) continue
    try {
      const r = JSON.parse(line)
      if (typeof r.t === "number" && r.t >= cutoff) out.push(line)
    } catch {
      // A half-written line is dropped.
    }
  }
  return out
}

