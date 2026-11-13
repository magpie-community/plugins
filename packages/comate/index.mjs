// @magpie-community/opencode-comate-auth — the 文心快码 (Baidu Comate)
// provider plugin for OpenCode and magpie.
//
// Signs in the way Comate's own CLI (@comate/zulu 1.7.16, bundled in the VS
// Code extension BaiduComate.comate 4.14.1) does: a browser page binds a
// fresh clientId to the account, and polling hands back the account's
// license, which is the credential every later request carries. A license
// copied from https://comate.baidu.com/user can be pasted instead.
//
// Each chat completion runs as one Zulu agent turn: conversation → task →
// execute (SSE). The agent is a custom one in the client's own shape
// ({isProjectAgent: true, agentPrompt, tools: []}, as the client's retrieval
// planner sends it), so the request's system prompt is the agent's prompt
// and Comate's server-side tools stay out. Tools ride as JSON text over the
// prompt, as in the catpaw plugin. Read from the extension's code; not run
// against a real account (see README).

const ID = "comate"
const NAME = "文心快码 Comate"

const origin = () => process.env.COMATE_ORIGIN || "https://comate.baidu.com"
const AGENT_BASE = "/api/aidevops/autocomate/rest/autowork/v2"

// the client this plugin speaks as: Comate's own CLI
const CLI = Object.freeze({ ide: "zulucli", version: "1.7.16" })

// what the vendor answers before a list can be read: its own default mode
const MODELS = { auto: { name: "Auto", provider: null } }

// ── small helpers ──────────────────────────────────────────────────────────

const errorResponse = (status, message, fields = {}, headers = {}) =>
  new Response(JSON.stringify({ error: { message, ...fields } }), { status, headers: { "content-type": "application/json", ...headers } })

// a failure with the status the agent should see
class Refused extends Error {
  constructor(status, message, fields = {}, headers = {}) {
    super(message)
    this.status = status
    this.fields = fields
    this.headers = headers
  }
}

const expiredLicense = (said) =>
  new Refused(401, `文心快码 license 无效或已失效${said ? `：${said}` : ""}。请在 magpie 里重新登录文心快码`, { type: "authentication_error" })

// over the account's limit: the vendor's own words, as a 429 (it names no
// reset, so no retry-after is made up)
const overLimit = (said) =>
  new Refused(429, `文心快码用量已超限${said ? `：${said}` : ""}`, { type: "rate_limit_error", code: "quota_exceeded" })

function failResponse(e) {
  if (e instanceof Refused) return errorResponse(e.status, e.message, e.fields, e.headers)
  return errorResponse(502, String(e?.message ?? e))
}

// primed waits for a turn's first event, up to ms, before the agent is
// answered: a refusal there goes out as its own status instead of an error
// inside a 200 stream
const PRIME_MS = 10_000
async function primed(gen, ms = PRIME_MS) {
  const first = gen.next().then(
    (v) => ({ v }),
    (e) => ({ e }),
  )
  let timer
  const won = await Promise.race([first, new Promise((r) => (timer = setTimeout(() => r(null), ms)))])
  clearTimeout(timer)
  if (won?.e) throw won.e
  return (async function* () {
    const r = won ?? (await first)
    if (r.e) throw r.e
    if (r.v.done) return
    yield r.v.value
    yield* gen
  })()
}

async function bodyText(input, init) {
  const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  return typeof b === "string" ? b : new TextDecoder().decode(b)
}

const licenseOf = (auth) => (auth?.type === "oauth" && typeof auth.access === "string" ? auth.access.trim() : "")

// ── the wire: what the client puts on every request ───────────────────────

// getRequestUserHeader in the client: the license is the user's name
function headers(license, extra = {}) {
  const who = encodeURIComponent(license)
  return {
    "Content-Type": "application/json",
    "Accept-Language": "zh-CN,zh",
    "login-name": who,
    "Uuap-login-name": who,
    "X-Source": "COMATE",
    "plugin-version": `${CLI.ide}-${CLI.version}`,
    "x-skip-fcnap": "yes",
    ...extra,
  }
}

// getRequestClienInfo in the client: spread into every agent body
const clientInfo = (license) => ({ username: license, ide: CLI.ide, ideVersion: CLI.version, pluginVersion: CLI.version })

async function postJSON(url, body, license, extra, signal) {
  const res = await fetch(url, { method: "POST", headers: headers(license, extra), body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(30_000) })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, text, json }
}

// ── models ─────────────────────────────────────────────────────────────────

// the account's list as the CLI reads it (POST /api/v2/api/models/available,
// {data: {reason, models: [...]}}); a row's modelId is the id the agent
// turn's modelKey takes
function liveModels(rows) {
  const out = {}
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = typeof r?.modelId === "string" ? r.modelId.trim() : ""
    if (!id) continue
    const prev = out[id]
    out[id] = {
      name: (typeof r.displayName === "string" && r.displayName.trim()) || prev?.name || id,
      provider: r.provider ?? prev?.provider ?? null,
      image: r.supportImage === true || prev?.image === true,
      thinking: r.supportThinking === true || prev?.thinking === true,
      effort: r.supportEffort === true || prev?.effort === true,
      ...(Number.isFinite(r.maxContextWindow) && r.maxContextWindow > 0 ? { context: r.maxContextWindow } : prev?.context ? { context: prev.context } : {}),
      ...(Number.isFinite(r.ratio) && r.ratio >= 0 ? { rate: r.ratio } : prev?.rate !== undefined ? { rate: prev.rate } : {}),
    }
  }
  return out
}

const LIVE_TTL = 5 * 60_000
const liveLists = new Map() // license -> { at, models }

async function fetchLiveModels(license, signal) {
  const r = await postJSON(
    origin() + "/api/v2/api/models/available",
    { username: license, type: "ZULU", rootRepo: "", submodules: [], zuluVersion: CLI.version, source: "cli", ideType: CLI.ide },
    license,
    {},
    signal ?? AbortSignal.timeout(15_000),
  )
  if (r.status !== 200 || r.json?.status !== "OK") throw new Error(`文心快码模型列表返回 HTTP ${r.status} ${r.json?.message ?? ""}`.trim())
  const rows = Array.isArray(r.json.data) ? r.json.data : r.json.data?.models
  if (!Array.isArray(rows)) throw new Error("文心快码模型列表无法解析")
  return liveModels(rows)
}

async function liveListFor(license, signal) {
  const hit = liveLists.get(license)
  if (hit && Date.now() - hit.at < LIVE_TTL) return hit.models
  try {
    const models = await fetchLiveModels(license, signal)
    liveLists.set(license, { at: Date.now(), models })
    return models
  } catch {
    return hit?.models ?? null
  }
}

async function specOf(license, id, signal) {
  const live = await liveListFor(license, signal)
  return live?.[id] ?? MODELS[id] ?? null
}

// the vendor's context window when it gives one; no output limit is made up
const configModel = (m) => ({
  name: m.name,
  ...(m.rate !== undefined ? { rate: m.rate } : {}),
})

// ── prompt and tools over text ─────────────────────────────────────────────

function textOfContent(content) {
  if (typeof content === "string") return content
  return Array.isArray(content) ? content.map((c) => (typeof c === "string" ? c : c?.type === "text" ? c.text || "" : "")).join("") : ""
}

function normalizeToolChoice(toolChoice) {
  if (toolChoice === undefined || toolChoice === null) return { mode: "auto" }
  if (typeof toolChoice === "string") {
    if (toolChoice === "none") return { mode: "none" }
    if (toolChoice === "required" || toolChoice === "any") return { mode: "required" }
    if (toolChoice === "auto") return { mode: "auto" }
    return { mode: "named", name: toolChoice }
  }
  if (typeof toolChoice === "object") {
    const type = toolChoice.type || "auto"
    if (type === "none") return { mode: "none" }
    if (type === "required" || type === "any") return { mode: "required" }
    if (type === "tool" || type === "function") {
      const name = toolChoice.name || toolChoice.function?.name || ""
      return name ? { mode: "named", name } : { mode: "required" }
    }
  }
  return { mode: "auto" }
}

const isToolChoiceRequired = (toolChoice) => ["required", "named"].includes(normalizeToolChoice(toolChoice).mode)
const toolNameOf = (tool) => tool?.function?.name || tool?.name || ""
const toolParamsOf = (tool) => tool?.function?.parameters || tool?.input_schema || tool?.parameters || {}

function summarizeTool(tool) {
  const schema = toolParamsOf(tool)
  const props = schema?.properties && typeof schema.properties === "object" ? schema.properties : {}
  const required = new Set(Array.isArray(schema?.required) ? schema.required : [])
  const names = Object.keys(props).slice(0, 12)
  const params = names.length ? `args: ${names.map((n) => `${n}: ${props[n]?.type ?? "?"}${required.has(n) ? "*" : ""}`).join(", ")}` : "args: object"
  const desc = String(tool?.function?.description || tool?.description || "").replace(/\s+/g, " ").trim()
  return `- ${toolNameOf(tool) || "tool"}: ${desc ? desc.slice(0, 120) : "No description"} (${params})`
}

function buildToolInstruction(tools, toolChoice) {
  const choice = normalizeToolChoice(toolChoice)
  const lines = [
    "You can call tools, but this API only accepts a strict JSON tool-call response.",
    "When a tool is needed, respond with JSON only and no prose.",
    "For any file, code, shell, workspace, search, read, edit, write, or project task, you MUST call tools instead of describing the change.",
    "Never claim that you changed, read, searched, or executed anything unless you returned a tool call for it.",
    "Use exactly this shape:",
    '{"tool_calls":[{"name":"ToolName","arguments":{"arg":"value"}}]}',
    "Required argument names are marked with *.",
  ]
  if (choice.mode === "required") lines.push("tool_choice=required: you MUST return a JSON tool_calls payload now. Plain text answers are forbidden.")
  else if (choice.mode === "named") lines.push(`tool_choice forces tool "${choice.name}": return JSON tool_calls that call ONLY this tool. Plain text answers are forbidden.`)
  else lines.push("Only answer normally for pure explanation or conversation tasks that do not need workspace access.")
  lines.push("Available tools:", ...tools.map(summarizeTool))
  return lines.join("\n")
}

function forcedToolRetryMessage(toolChoice) {
  const choice = normalizeToolChoice(toolChoice)
  if (choice.mode === "named")
    return [
      "Your previous reply did not include a valid tool call.",
      `Return ONLY JSON tool_calls that invoke "${choice.name}". No markdown, no explanation.`,
      `{"tool_calls":[{"name":"${choice.name}","arguments":{...}}]}`,
    ].join("\n")
  return [
    "Your previous reply did not include a valid tool call.",
    "Return ONLY a JSON tool_calls payload now. No markdown, no explanation.",
    '{"tool_calls":[{"name":"ToolName","arguments":{"arg":"value"}}]}',
  ].join("\n")
}

// the request's messages as the agent's prompt and the turn's query. System
// messages become the agent's prompt; the rest is one text, each turn
// labelled, tool calls and results written out (never dropped).
function buildTurn(messages, tools, toolChoice) {
  const system = []
  const parts = []
  for (const msg of messages) {
    const role = msg.role || "user"
    const text = textOfContent(msg.content)
    if (role === "system" || role === "developer") {
      if (text) system.push(text)
      continue
    }
    if (role === "tool") {
      parts.push(`[Tool result${msg.tool_call_id ? ` for ${msg.tool_call_id}` : ""}]\n${text}`)
      continue
    }
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    const callText = calls
      .map((call) => {
        const name = call?.function?.name || call?.name || "tool"
        const args = call?.function?.arguments ?? call?.arguments ?? "{}"
        return `Tool call requested: ${name} ${typeof args === "string" ? args : JSON.stringify(args)}`
      })
      .join("\n")
    const body = [text, callText].filter(Boolean).join("\n")
    parts.push(role === "assistant" ? `[Assistant]\n${body}` : `[User]\n${body}`)
  }
  const wantsTools = normalizeToolChoice(toolChoice).mode !== "none" && Array.isArray(tools) && tools.length > 0
  if (wantsTools) {
    const instruction = buildToolInstruction(tools, toolChoice)
    system.push(instruction)
    parts.push(`[System]\n${instruction}`)
  }
  // a lone user message goes as itself, the way the client sends a query
  const rest = messages.filter((m) => m.role !== "system" && m.role !== "developer")
  const lone = !wantsTools && rest.length === 1 && (rest[0].role || "user") === "user"
  const query = lone ? textOfContent(rest[0].content) : parts.join("\n\n")
  return { prompt: system.join("\n\n"), query }
}

const parseJsonLoose = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// the reply → OpenAI tool_calls; the whole reply must be the call JSON
function toolCallsFromText(text, tools, toolChoice) {
  if (normalizeToolChoice(toolChoice).mode === "none") return []
  if (!Array.isArray(tools) || tools.length === 0) return []
  const raw = String(text ?? "").trim()
  if (!raw) return []
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const parsed = parseJsonLoose(fenced ? fenced[1].trim() : raw)
  if (!parsed || typeof parsed !== "object") return []
  let items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.tool_calls) ? parsed.tool_calls : Array.isArray(parsed.tool_uses) ? parsed.tool_uses : []
  if (!items.length) {
    const bare = parsed.function?.name ? { name: parsed.function.name, arguments: parsed.function.arguments } : parsed
    if ((bare.name || bare.tool) && bare.arguments !== undefined) items = [bare]
  }
  const known = new Map(tools.map((t) => [toolNameOf(t).toLowerCase(), toolNameOf(t)]).filter(([k]) => k))
  const choice = normalizeToolChoice(toolChoice)
  const out = []
  for (const call of items) {
    const name = known.get(String(call?.name || call?.tool || call?.function?.name || "").toLowerCase())
    if (!name) continue
    if (choice.mode === "named" && name !== choice.name) continue
    let args = call?.arguments ?? call?.input ?? call?.parameters ?? call?.function?.arguments ?? {}
    if (typeof args === "string") {
      const p = parseJsonLoose(args)
      args = p && typeof p === "object" ? p : { value: args }
    }
    if (!args || typeof args !== "object") args = {}
    const schema = toolParamsOf(tools.find((t) => toolNameOf(t) === name))
    const required = Array.isArray(schema?.required) ? schema.required : []
    if (required.some((k) => args[k] === undefined)) continue
    out.push({ id: `call_${Date.now().toString(36)}_${out.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } })
  }
  return out
}

// ── one agent turn ─────────────────────────────────────────────────────────

// the custom agent each turn runs as: the client's own shape for an agent
// whose prompt it supplies, with none of Comate's tools
const AGENT_NAME = "assistant"
const agentInfo = (prompt) => ({ agentName: AGENT_NAME, isProjectAgent: true, agentPrompt: prompt, tools: [] })

// an agent step's JSON answer: {code, message, data}; HTTP 200 carries the
// refusals too
function stepData(step, r) {
  const code = r.json?.code
  const said = String(r.json?.message ?? "").trim()
  if (r.status === 401 || code === 401) throw expiredLicense(said)
  if (r.status === 429 || code === 429) throw overLimit(r.json?.data ? JSON.stringify(r.json.data) : said)
  if (r.status !== 200 || !r.json) throw new Error(`文心快码 ${step} 失败：HTTP ${r.status} ${r.text.slice(0, 300)}`.trim())
  if (code !== 200) throw new Error(`文心快码 ${step} 失败：code=${code ?? "?"} ${said}`.trim())
  return r.json.data
}

// runTurn: conversation → task → execute, yielding {delta}, {reasoningDelta},
// {usage} and finally {done, text, reasoning}. A fresh conversation each
// time: the whole history rides in the query.
async function* runTurn(license, { prompt, query, spec, effort }, signal) {
  const traceId = crypto.randomUUID()
  const info = agentInfo(prompt)
  const conv = stepData(
    "conversation",
    await postJSON(origin() + AGENT_BASE + "/conversation", { agentId: 1, ...clientInfo(license) }, license, { "X-Trace-Id": traceId }, signal),
  )
  const conversationId = conv?.id
  if (conversationId == null) throw new Error("文心快码 conversation 没有返回 id")
  const task = stepData(
    "task",
    await postJSON(
      origin() + AGENT_BASE + "/task",
      { agentInfo: { isProjectAgent: true, agentName: AGENT_NAME }, conversationId, ...clientInfo(license) },
      license,
      { "X-Trace-Id": traceId },
      signal,
    ),
  )
  const taskId = task?.taskId
  if (taskId == null) throw new Error("文心快码 task 没有返回 taskId")

  const body = {
    ...clientInfo(license),
    taskId,
    conversationId,
    query,
    modelKey: spec.id,
    ...(spec.provider ? { modelProvider: spec.provider } : {}),
    thinkingEnabled: !!spec.thinking,
    ...(spec.effort && effort ? { effort } : {}),
    ...(spec.context ? { contextWindow: spec.context } : {}),
    sysInfo: { os: process.platform, defaultShell: "", homeDir: "", installedCommands: [], notInstalledCommands: [], workspacePath: "", workspaceRoots: [] },
    skillInfos: [],
    hasMcp: false,
    isUserQuery: true,
    contexts: [],
    toolUseResults: [],
    subAgents: [],
    agentInfo: info,
    agentVersion: 12,
    isFirstQuery: true,
    systemReminder: "",
    extendUserQueryInfo: { commands: [], skills: [], subagents: [], rules: [] },
    extend: { isMultiWorkspace: false, useWorkflow: true },
  }
  const res = await fetch(origin() + AGENT_BASE + "/execute", {
    method: "POST",
    headers: headers(license, { Accept: "text/event-stream", "X-Trace-Id": traceId, "x-query-id": crypto.randomUUID() }),
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(60 * 60_000),
  })
  // a refusal comes as JSON, not a stream
  if (!String(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const text = await res.text().catch(() => "")
    let json = null
    try {
      json = JSON.parse(text)
    } catch {}
    stepData("execute", { status: res.status, text, json })
    throw new Error(`文心快码 execute 没有返回事件流：HTTP ${res.status} ${text.slice(0, 300)}`.trim())
  }
  if (!res.body) throw new Error("文心快码 execute 返回了空流")

  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  let buffered = ""
  let text = ""
  let reasoning = ""
  let frames = 0
  const handle = function* (data) {
    let frame
    try {
      frame = JSON.parse(data)
    } catch {
      return
    }
    const content = frame?.content
    if (!content || typeof content !== "object") return
    frames++
    const detail = content.detail ?? {}
    switch (content.type) {
      case "ANSWER":
        if (typeof detail.reasoningDelta === "string" && detail.reasoningDelta) {
          reasoning += detail.reasoningDelta
          yield { reasoningDelta: detail.reasoningDelta }
        }
        if (typeof detail.delta === "string" && detail.delta) {
          // the client trims the answer's leading newlines
          const d = text === "" ? detail.delta.replace(/^(\r?\n)+/, "") : detail.delta
          if (d) {
            text += d
            yield { delta: d }
          }
        }
        return
      case "TOKEN_USAGE":
        if (detail.usage) yield { usage: detail.usage }
        return
      case "EXCEPTION":
        throw new Error(`文心快码执行异常：${detail.exceptionMsg ?? "后端未返回详细信息"}`)
      case "QUOTA_EXCEED":
      case "DOWNGRADE":
        throw overLimit(String(detail.message ?? detail.msg ?? detail.exceptionMsg ?? "").trim())
      case "NEED_RETRY_EXCEPTION":
        throw new Error(`文心快码要求重试：${detail.exceptionMsg ?? ""}`.trim())
    }
  }
  const lineOf = function* (line) {
    if (!line.startsWith("data:")) return
    yield* handle(line.slice(5).trim())
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    const lines = buffered.split("\n")
    buffered = lines.pop() ?? ""
    for (const line of lines) yield* lineOf(line.replace(/\r$/, ""))
  }
  if (buffered) yield* lineOf(buffered.replace(/\r$/, ""))
  if (frames === 0) throw new Error("文心快码事件流结束但没有任何帧")
  yield { done: true, text, reasoning }
}

// TOKEN_USAGE's {inputTokens, cachedInputTokens, outputTokens} as OpenAI's
function openaiUsage(u) {
  if (!u) return undefined
  const prompt = Number(u.inputTokens) || 0
  const cached = Number(u.cachedInputTokens) || 0
  const completion = Number(u.outputTokens) || 0
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}) }
}

// ── sign-in ────────────────────────────────────────────────────────────────

const apiGet = (pathname, extra = {}, signal) =>
  fetch(origin() + "/api" + pathname, { headers: { Accept: "application/json", ...extra }, signal: signal ?? AbortSignal.timeout(10_000) })

async function checkLicense(license) {
  const res = await apiGet(`/key/valid/${encodeURIComponent(license)}`)
  const json = await res.json().catch(() => null)
  if (json?.status === "OK" && json.data === true) return { ok: true }
  if (json && json.data === false) return { ok: false, message: String(json.message ?? "license 无效") }
  return { ok: null, message: `HTTP ${res.status}` }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const POLL_MS = 2_000
const POLL_FOR_MS = 180_000

// the CLI's device label: "user host (OS arch release)"
async function deviceLabel() {
  try {
    const os = await import("node:os")
    return `${os.userInfo().username} ${os.hostname()} (${os.type()} ${os.arch()} ${os.release()})`
  } catch {
    return "magpie"
  }
}

// ── the plugin ─────────────────────────────────────────────────────────────

export async function ComateAuthPlugin() {
  return {
    auth: {
      provider: ID,
      async loader(getAuth) {
        const serve = async (chat, signal) => {
          const license = licenseOf(await getAuth())
          if (!license) return errorResponse(401, "文心快码未登录：请在 magpie 里登录文心快码")
          const id = String(chat.model ?? "").trim() || "auto"
          const found = await specOf(license, id, signal)
          if (!found) {
            const known = Object.keys({ ...MODELS, ...(liveLists.get(license)?.models ?? {}) })
            return errorResponse(400, `unknown model "${id}" (known: ${known.join(", ")})`)
          }
          const spec = { id, ...found }
          const effort = typeof chat.reasoning_effort === "string" ? chat.reasoning_effort : undefined
          const tools = chat.tools
          const wantsTools = normalizeToolChoice(chat.tool_choice).mode !== "none" && Array.isArray(tools) && tools.length > 0
          const forced = wantsTools && isToolChoiceRequired(chat.tool_choice)
          const turnOf = (messages) => ({ ...buildTurn(messages, tools, chat.tool_choice), spec, effort })
          const collect = async (messages) => {
            let out = { text: "", reasoning: "", usage: undefined }
            for await (const ev of runTurn(license, turnOf(messages), signal)) {
              if (ev.usage) out.usage = ev.usage
              if (ev.done) out = { ...out, text: ev.text, reasoning: ev.reasoning }
            }
            return out
          }
          const retryMessages = (failed) => [...chat.messages, { role: "assistant", content: failed }, { role: "user", content: forcedToolRetryMessage(chat.tool_choice) }]

          const cid = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
          const created = Math.floor(Date.now() / 1000)

          if (!chat.stream) {
            let out
            let calls = []
            try {
              out = await collect(chat.messages)
              if (wantsTools) {
                calls = toolCallsFromText(out.text, tools, chat.tool_choice)
                if (!calls.length && forced) {
                  out = await collect(retryMessages(out.text))
                  calls = toolCallsFromText(out.text, tools, chat.tool_choice)
                }
              }
            } catch (e) {
              return failResponse(e)
            }
            const message = {
              role: "assistant",
              content: calls.length ? null : out.text,
              ...(calls.length ? { tool_calls: calls } : {}),
              ...(out.reasoning ? { reasoning_content: out.reasoning } : {}),
            }
            const usage = openaiUsage(out.usage)
            return new Response(
              JSON.stringify({ id: cid, object: "chat.completion", created, model: id, choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }], ...(usage ? { usage } : {}) }),
              { status: 200, headers: { "content-type": "application/json" } },
            )
          }

          let events
          try {
            events = await primed(runTurn(license, turnOf(chat.messages), signal))
          } catch (e) {
            return failResponse(e)
          }
          const encoder = new TextEncoder()
          const frame = (obj) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)
          const chunk = (delta, finish, extra = {}) => frame({ id: cid, object: "chat.completion.chunk", created, model: id, choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...extra })
          const stream = new ReadableStream({
            async start(controller) {
              let closed = false
              const push = (bytes) => {
                if (closed) return
                try {
                  controller.enqueue(bytes)
                } catch {
                  closed = true
                }
              }
              // the agent can think a while before its first frame
              const ka = setInterval(() => push(encoder.encode(": ka\n\n")), 3_000)
              const stop = () => {
                clearInterval(ka)
                if (!closed) {
                  closed = true
                  try {
                    controller.close()
                  } catch {}
                }
              }
              signal?.addEventListener("abort", stop)
              push(chunk({ role: "assistant" }))
              // with tools, a JSON-shaped head is held until it reads as
              // prose (a forced tool_choice holds all of it, for the retry)
              let pending = ""
              let live = !wantsTools
              let text = ""
              let usage
              try {
                for await (const ev of events) {
                  if (closed) return
                  if (ev.reasoningDelta) push(chunk({ reasoning_content: ev.reasoningDelta }))
                  if (ev.usage) usage = ev.usage
                  if (ev.delta) {
                    text += ev.delta
                    if (live) push(chunk({ content: ev.delta }))
                    else {
                      pending += ev.delta
                      const head = pending.trimStart()
                      if (!forced && head !== "" && !head.startsWith("{") && !head.startsWith("```")) {
                        live = true
                        push(chunk({ content: pending }))
                        pending = ""
                      }
                    }
                  }
                  if (ev.done) text = ev.text
                }
                let calls = []
                if (wantsTools && !live) {
                  calls = toolCallsFromText(text, tools, chat.tool_choice)
                  if (!calls.length && forced) {
                    const out = await collect(retryMessages(text))
                    text = out.text
                    usage = out.usage ?? usage
                    calls = toolCallsFromText(text, tools, chat.tool_choice)
                  }
                }
                if (calls.length) {
                  calls.forEach((call, index) => {
                    push(chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] }))
                    push(chunk({ tool_calls: [{ index, function: { arguments: call.function.arguments } }] }))
                  })
                } else if (!live && text) push(chunk({ content: text }))
                const u = openaiUsage(usage)
                push(chunk({}, calls.length ? "tool_calls" : "stop", u ? { usage: u } : {}))
              } catch (e) {
                push(frame({ error: { message: String(e?.message ?? e), ...(e instanceof Refused ? e.fields : {}) } }))
              }
              push(encoder.encode("data: [DONE]\n\n"))
              stop()
            },
          })
          return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
        }
        return {
          baseURL: origin(),
          apiKey: "comate",
          async fetch(input, init = {}) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            if (!/\/chat\/completions$/.test(new URL(url).pathname)) return errorResponse(404, "only chat completions are served")
            let chat
            try {
              chat = JSON.parse(await bodyText(input, init))
            } catch {
              return errorResponse(400, "a request that isn't JSON")
            }
            if (!Array.isArray(chat.messages) || chat.messages.length === 0) return errorResponse(400, "messages is required")
            if (chat.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c?.type === "image" || c?.type === "image_url" || c?.type === "input_image")))
              return errorResponse(400, "this provider cannot take images through the text prompt (refused rather than silently dropped)")
            return serve(chat, init.signal)
          },
        }
      },
      // Comate's SaaS shows no quota a license can read (the client's own
      // quota read is on Baidu's internal host), so the card says whether
      // the license still holds and nothing more
      async usage(getAuth) {
        const license = licenseOf(await getAuth())
        if (!license) return { error: "文心快码未登录", signIn: "expired" }
        let r
        try {
          r = await checkLicense(license)
        } catch (e) {
          return { error: String(e?.message ?? e), signIn: "kept" }
        }
        if (r.ok === false) return { error: r.message, signIn: "expired" }
        if (r.ok === null) return { error: `文心快码 license 校验失败：${r.message}`, signIn: "kept" }
        return { plan: NAME, windows: [] }
      },
      methods: [
        {
          type: "oauth",
          label: "网页登录（文心快码官方登录页）",
          authorize: async () => {
            const clientId = crypto.randomUUID()
            // the CLI unbinds the id first; best effort, as there
            try {
              await apiGet(`/client/logout?clientId=${clientId}`)
            } catch {}
            const url = `${origin()}/zh/login?track=COMATE_CLI&clientId=${clientId}&device=${encodeURIComponent(await deviceLabel())}`
            return {
              url,
              instructions: "在浏览器打开的文心快码页面登录并确认授权，完成后会自动回到 magpie。",
              method: "auto",
              callback: async () => {
                const deadline = Date.now() + POLL_FOR_MS
                while (Date.now() < deadline) {
                  await sleep(POLL_MS)
                  try {
                    // not bound yet: {status: "BAD_REQUEST", message: "未找到客户端信息"}
                    const res = await apiGet(`/client/generate/token?clientId=${clientId}`)
                    const json = await res.json().catch(() => null)
                    if (json?.status !== "OK" || !json.data) continue
                    const keyRes = await apiGet(`/client/key?clientId=${clientId}`, { token: String(json.data) })
                    const key = await keyRes.json().catch(() => null)
                    const license = typeof key?.data?.key === "string" ? key.data.key.trim() : ""
                    if (key?.status !== "OK" || !license) return { type: "failed", error: "获取文心快码 license 失败，请重试" }
                    const name = typeof key.data.displayName === "string" && key.data.displayName.trim() ? key.data.displayName.trim() : "文心快码账号"
                    return { type: "success", refresh: "", access: license, expires: 0, accountId: name, source: "web" }
                  } catch {
                    // one failed poll is skipped, as the CLI does
                  }
                }
                return { type: "failed", error: "登录超时（3 分钟内未完成授权），请重试" }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "粘贴 License",
          prompts: [{ type: "text", key: "license", message: "License（comate.baidu.com/user 页面上的 License）", validate: (v) => (v && v.trim() ? undefined : "必填") }],
          authorize: async (inputs) => {
            const license = String(inputs?.license ?? "").trim()
            if (!license) return { type: "failed", error: "License 必填" }
            return {
              url: "",
              instructions: "正在校验 License。",
              method: "auto",
              callback: async () => {
                try {
                  const r = await checkLicense(license)
                  if (r.ok === false) return { type: "failed", error: r.message }
                } catch {}
                return { type: "success", refresh: "", access: license, expires: 0, accountId: "文心快码 License", source: "manual" }
              },
            }
          },
        },
      ],
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const have = provider?.models ?? {}
        const license = licenseOf(auth)
        if (!license) return have
        const live = await liveListFor(license)
        if (!live) return have
        return { ...have, ...Object.fromEntries(Object.entries(live).filter(([id]) => !(id in have)).map(([id, m]) => [id, configModel(m)])) }
      },
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: NAME,
        npm: "@ai-sdk/openai-compatible",
        api: origin(),
        ...was,
        models: { ...Object.fromEntries(Object.entries(MODELS).map(([id, m]) => [id, configModel(m)])), ...(was.models ?? {}) },
      }
    },
  }
}

// for tests
export const _internal = { ID, CLI, MODELS, headers, clientInfo, liveModels, buildTurn, toolCallsFromText, openaiUsage, runTurn, agentInfo, forgetLive: () => liveLists.clear() }
