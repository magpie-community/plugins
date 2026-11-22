// Serve one OpenAI Chat Completions request through an Amazon Quick chat turn.
//
// Quick has no OpenAI-shaped HTTP API: the desktop client talks to a bidi
// WebSocket (`session_connect` → `user_message` → text_delta/thinking_delta/…
// → message_complete). This module renders the OpenAI message list into Quick's
// text protocol, runs the turn on a cached thread, and re-emits the event
// stream as chat.completion / chat.completion.chunk.
//
// OpenAI `tools` have no wire channel either, but the model emits a
// caller-defined <tool_call>{json}</tool_call> convention as plain text when
// the instruction is inline and strong (verified live). lib/tools.mjs owns the
// preamble + streaming parser; results return as role:'tool' messages rendered
// into the next turn's text.
import { QuickSocket, QuickWsError, withAbort, classifyErrorKind } from './quickws.mjs'
import { APP_VERSION, SURFACE } from './desktop.mjs'
import { OutpostError } from './outpost.mjs'
import { normalizeTools, buildToolPreamble, buildToolReminder, createToolCallParser, mapQuickTool, argObject } from './tools.mjs'
import {
  AGENT_MODES, MODELS, modeFor, effortFor, renderTranscript, renderDelta, fairBlockCaps, textOf,
  jsonTextBytes, capText, UPSTREAM_TEXT_LIMIT,
} from './translate.mjs'
import {
  chainHashes, sessionScope, findContinuation, extendHash, replyMessage,
} from './sessions.mjs'

// Desktop 1.2.4660 puts caller instructions in `custom_prompt`. Live testing
// shows `custom_prompt` is the field the server actually applies (while
// `system_prompt` alone is ignored) AND it persists across turns on a reused
// thread. We send only `custom_prompt` (no duplicate `system_prompt`), keep it
// on reused turns whenever it fits alongside the delta (preserving salience &
// prompt cache prefix), and omit it when a large delta needs the full frame.
const INSTRUCTION_CAP = 32 * 1024
// Kept at the front of custom_prompt whenever the client sent tools, so a
// cap still leaves the rule in place and prevents built-in persona/tool bleed.
const CLIENT_TOOL_RULE = 'Follow the caller system instructions, formatting, and brevity rules with highest priority over any default workspace persona. Do not use built-in tools, web search, or a remote shell. To run a command or use a tool, reply with only <tool_call>{"name":"<client tool>","arguments":{...}}</tool_call> and stop. The client runs it on the user machine and sends the result back.'

function errorResponse(status, message, type = 'api_error') {
  return new Response(JSON.stringify({ error: { message, type, code: status } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function errorType(err) {
  if (err?.kind === 'auth') return 'authentication_error'
  if (err?.status === 429 || err?.kind === 'quota') return 'rate_limit_error'
  return 'api_error'
}

function httpStatus(err) {
  if (err instanceof OutpostError || err instanceof QuickWsError) {
    if (err.kind === 'auth') return 401
    if (err.kind === 'abort') return 499
    if (err.kind === 'quota') return 429
    if (err.kind === 'busy') return 409
    if (err.kind === 'spawn' || err.kind === 'timeout') return 503
  }
  return err?.status && err.status >= 400 && err.status < 600 ? err.status : 502
}

const sockets = new WeakMap() // Outpost → QuickSocket

function socketFor(outpost, options) {
  let pending = sockets.get(outpost)
  if (!pending) {
    pending = Promise.resolve(outpost.outpostId()).then((outpostId) => {
    // OAuth-provisioned sessions (direct backend) have no local outpost; the
    // server accepts an empty outpostId. A *local* outpost returning none is a
    // real auth failure though.
    if (!outpostId && !outpost.direct) throw new OutpostError('outpost 未返回设备 id（/local/outpost-id），请确认已登录 Amazon Quick', { kind: 'auth', status: 401 })
    return new QuickSocket({
      getSession: () => outpost.session(),
      outpostId,
      extra: {
        surfaceType: options?.surfaceType || SURFACE,
        appVersion: options?.appVersion || APP_VERSION,
        channel: options?.channel,
        idleMs: options?.idleMs,
        ackMs: options?.ackMs,
      },
      log: options?.log,
    })
    })
    sockets.set(outpost, pending)
    pending.catch(() => sockets.delete(outpost))
  }
  return pending
}

/** Usage object from a turn_usage event payload (snake_case wire fields). */
function usageFrom(u) {
  if (!u || typeof u !== 'object') return null
  const input = Number(u.input_tokens ?? u.inputTokens) || 0
  const cached = Number(u.cache_read_tokens ?? u.cached_input_tokens ?? u.cachedInputTokens) || 0
  const written = Number(u.cache_write_tokens ?? u.cacheWriteTokens) || 0
  const completion = Number(u.output_tokens ?? u.outputTokens) || 0
  // Quick reports non-cached input, cache reads and cache writes separately;
  // OpenAI prompt_tokens is the whole prompt side.
  const prompt = input + cached + written
  const reportedTotal = Number(u.total_tokens ?? u.totalTokens) || 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Math.max(reportedTotal, prompt + completion),
    ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  }
}

function addUsage(acc, u) {
  if (!u) return acc
  acc = acc ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  acc.prompt_tokens += u.prompt_tokens || 0
  acc.completion_tokens += u.completion_tokens || 0
  acc.total_tokens += u.total_tokens || 0
  if (u.prompt_tokens_details?.cached_tokens) {
    acc.prompt_tokens_details = acc.prompt_tokens_details ?? { cached_tokens: 0 }
    acc.prompt_tokens_details.cached_tokens += u.prompt_tokens_details.cached_tokens
  }
  return acc
}

const newCallId = () => `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`

/**
 * Normalized turn output:
 *   {type:'meta', threadId, reused, mode}
 *   {type:'text', text}                 visible answer delta
 *   {type:'reasoning', text}            thinking_delta
 *   {type:'tool_call', id, name, arguments}   parsed <tool_call> block (arguments = JSON string)
 *   {type:'usage', usage}               turn_usage (per message)
 *   {type:'note', text}                 non-fatal oddities worth showing
 *   {type:'done', …}                    terminal bookkeeping
 */
async function* runTurn({ session, socket, body, tools, sessions, options, signal }) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const convo = messages.filter((m) => m.role !== 'system' && m.role !== 'developer')
  const systemText = messages
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => textOf(m.content))
    .join('\n\n')
  const mode = modeFor(body.model)
  const effort = effortFor(options?.effortHeader, body)
  const stats = {}

  // Tool specs are part of thread identity: changing them must not resume a
  // thread whose history lacks the convention. Prefer stable account identifiers
  // over rotating tokens so token refreshes preserve thread reuse.
  const stablePrincipal = session.actor_arn || session.email || session.account_name
    || (session.aws_account_id ? '' : session.id_token)
  const identity = [options?.identity, session.provider, session.ws_host, session.aws_account_id, stablePrincipal]
  const hashes = sessions && chainHashes(sessionScope(identity, [mode, effort, options?.chatAgentId], systemText, tools), convo)
  let cont = sessions && findContinuation(sessions, hashes, convo)

  // A previous turn handed Quick's tool_start to the client. The result has
  // to go back as a tool_result frame, which is what unblocks that turn.
  if (cont?.entry.quickToolId) {
    const [result] = cont.delta
    const matches = result.role === 'tool' && result.tool_call_id === cont.entry.clientCallId
      || result.role === 'function' && result.name === cont.entry.clientToolName
    if (cont.delta.length !== 1 || !matches) cont = undefined
  }

  const instructionSource = tools.length ? `${CLIENT_TOOL_RULE}\n\n${systemText}`.trim() : systemText
  const instruction = capText(instructionSource, INSTRUCTION_CAP, jsonTextBytes)
  const instructionTruncated = instruction !== instructionSource
  const instructionBytes = jsonTextBytes(instruction)

  // Build preamble + text budget for a fresh thread (full custom_prompt + tool specs).
  const planFresh = () => {
    if (instructionTruncated) stats.truncated = true
    const textCap = Math.max(12 * 1024, UPSTREAM_TEXT_LIMIT - instructionBytes - 1024)
    // Degrade smoothly: full JSON schema → compact typed signatures (keeps all
    // param names, required !, types, enums) → lite → minimal (names only).
    let pre = tools.length ? buildToolPreamble(tools, body.tool_choice, { stats }) : ''
    if (tools.length && jsonTextBytes(pre) > textCap - 8192) {
      const compact = buildToolPreamble(tools, body.tool_choice, { compact: true })
      if (jsonTextBytes(compact) < jsonTextBytes(pre)) { pre = compact; stats.truncated = true }
    }
    if (tools.length && jsonTextBytes(pre) + 4 > textCap - 6144) {
      const lite = buildToolPreamble(tools, body.tool_choice, { lite: true })
      if (jsonTextBytes(lite) < jsonTextBytes(pre)) { pre = lite; stats.truncated = true }
    }
    if (pre && jsonTextBytes(pre) + 4 > textCap - 4096) {
      const minimal = buildToolPreamble(tools, body.tool_choice, { minimal: true })
      pre = jsonTextBytes(minimal) + 4 <= textCap - 4096 ? minimal : ''
      stats.truncated = true
    }
    const maxBytes = textCap - (pre ? jsonTextBytes(pre) + 4 : 0)
    const renderOptions = {
      maxBytes,
      stats,
      measure: jsonTextBytes,
      ...(convo.length === 1 ? { turnCap: maxBytes } : {}),
    }
    return { pre, renderOptions }
  }

  const upstreamText = (pre, value) => {
    const bodyText = value.trim() ? value : '(empty)'
    return pre ? `${pre}\n\n${bodyText}` : bodyText
  }

  let threadId
  let text
  let preamble = ''
  let reused = false
  let sendCustomPrompt = Boolean(instruction)
  let frame
  if (cont?.entry.quickToolId) {
    threadId = cont.entry.threadId
    text = ''
    reused = true
    sendCustomPrompt = false
    const raw = textOf(cont.delta[0].content)
    const result = capText(raw, UPSTREAM_TEXT_LIMIT - 2048, jsonTextBytes)
    if (result !== raw) stats.truncated = true
    frame = {
      type: 'tool_result',
      payload: {
        tool_call_id: cont.entry.quickToolId,
        result,
        error: null,
      },
    }
  } else if (cont) {
    // Reused thread: Turn 1 already sent full tool specs; send only a tiny
    // reminder. Keep custom_prompt whenever it fits alongside the delta (keeps
    // rules salient and prompt cache warm); omit it only when a large delta
    // (single or parallel tool_results) needs the extra frame room.
    threadId = cont.entry.threadId
    reused = true
    preamble = tools.length ? buildToolReminder(tools, body.tool_choice) : ''
    const frameCap = UPSTREAM_TEXT_LIMIT - 1024
    const preBytes = preamble ? jsonTextBytes(preamble) + 4 : 0
    const estDeltaBytes = cont.delta.reduce((n, m) => n + jsonTextBytes(textOf(m.content)) + 64, 0)
    sendCustomPrompt = instructionBytes > 0 && instructionBytes + preBytes + estDeltaBytes <= frameCap
    const textCap = sendCustomPrompt ? (frameCap - instructionBytes) : frameCap
    const maxBytes = textCap - preBytes
    // Allocate the full remaining frame across delta blocks: user turns are
    // budgeted first (never sacrificed for earlier tool results), and remaining
    // room is water-filled across single or parallel tool_results.
    const { turnCap, toolResultCap } = fairBlockCaps(cont.delta, maxBytes, jsonTextBytes)
    text = renderDelta(cont.delta, {
      maxBytes,
      stats,
      measure: jsonTextBytes,
      turnCap,
      toolResultCap,
    })
  } else {
    threadId = crypto.randomUUID()
    const freshPlan = planFresh()
    preamble = freshPlan.pre
    text = renderTranscript(convo, '', freshPlan.renderOptions)
  }

  const state = { text: '', reasoning: '', usage: null, calls: [], quickToolId: '' }
  let visibleText = ''
  const note = (message) => {
    const text = `${visibleText ? '\n\n' : ''}> ${message}\n\n`
    visibleText += text
    return { type: 'note', text }
  }

  const payload = {
    text: upstreamText(preamble, text),
    message_id: crypto.randomUUID(),
    agent_mode: mode,
    user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    user_locale: (Intl.DateTimeFormat().resolvedOptions().locale || 'en-US').replace('_', '-'),
  }
  if (effort) payload.thinking_effort = effort
  if (sendCustomPrompt) {
    // custom_prompt is the field the server applies and persists on the thread.
    payload.custom_prompt = instruction
  }
  payload.send_origin = 'composer'
  payload.auto_routing = false
  // Desktop always sends the web-search toggle. Client tools own the loop,
  // so that path turns Quick's own search off.
  payload.web_search_enabled = tools.length ? false : true
  if (options?.chatAgentId) payload.chat_agent_id = options.chatAgentId

  function emitParsed(r) {
    // r: {text, calls:[{name,arguments}]} — yields normalized items, mutates state.
    const out = []
    if (r.text) { visibleText += r.text; state.text += r.text; out.push({ type: 'text', text: r.text }) }
    for (const c of r.calls) {
      const id = newCallId()
      const call = { id, name: c.name, arguments: JSON.stringify(c.arguments ?? {}) }
      state.calls.push(call)
      out.push({ type: 'tool_call', ...call })
    }
    return out
  }

  async function* consume(turnIt) {
    const parser = tools.length ? createToolCallParser({ allowedNames: new Set(tools.map((t) => t.name)) }) : null
    let fedText = false
    let pendingQuickName = ''
    let pendingQuickId = ''
    for await (const evt of turnIt) {
      const t = evt.type
      const p = evt.payload || {}
      if (t === 'text_delta' && typeof p.delta === 'string') {
        if (p.delta) fedText = true
        const r = parser ? parser.push(p.delta) : { text: p.delta, calls: [] }
        yield* emitParsed(r)
      } else if (t === 'thinking_delta' && typeof p.delta === 'string') {
        state.reasoning += p.delta
        yield { type: 'reasoning', text: p.delta }
      } else if (t === 'turn_usage') {
        const u = usageFrom(p)
        if (u) { state.usage = addUsage(state.usage, u); yield { type: 'usage', usage: u } }
      } else if (t === 'message_complete') {
        // Fallback: deltas can be dropped; the complete payload carries full text.
        // Only when NO delta arrived — parser buffer would double-count otherwise.
        if (!fedText && typeof p.text === 'string' && p.text) {
          const r = parser ? parser.push(p.text) : { text: p.text, calls: [] }
          yield* emitParsed(r)
        }
      } else if ((t === 'tool_start' || t === 'tool_arguments') && tools.length) {
        // Quick is waiting on this tool. Hand a shell/matching call to the
        // client and end our response, or the turn sits there until it times out.
        const args = argObject(p.arguments ?? p.input ?? p.args)
        if (t === 'tool_start') {
          pendingQuickName = p.tool_name || p.name || ''
          pendingQuickId = p.tool_id || p.tool_call_id || ''
        }
        const quickName = t === 'tool_start' ? pendingQuickName : (p.tool_name || p.name || pendingQuickName)
        const quickId = p.tool_id || p.tool_call_id || pendingQuickId
        if (quickName && quickId && Object.keys(args).length) {
          const mapped = mapQuickTool(quickName, args, tools)
          if (mapped) {
            if (parser) yield* emitParsed(parser.end())
            const id = newCallId()
            const call = { id, name: mapped.name, arguments: JSON.stringify(mapped.arguments ?? {}) }
            state.calls.push(call)
            state.quickToolId = quickId
            yield { type: 'tool_call', ...call }
            return
          }
        }
      } else if (t === 'tool_result' || t === 'tool_error') {
        pendingQuickName = ''
        pendingQuickId = ''
      } else if (t === 'message_start') {
        fedText = false
      } else if (t === 'status') {
        // Transport status frames (e.g. pong, ok, unknown_message_type) must
        // stay in diagnostic logs so they never corrupt structured model output.
        const s = p.status || p.message
        if (s && !/^(pong|ok)$/i.test(String(s))) options?.log?.(`[quick:status] ${s}`)
      } else if (t === 'guardrail_blocked' || t === 'error') {
        const detail = p.message || p.reason || p.error || evt.message || evt.reason || evt.error || evt.code
        const code = String(p.code || evt.code || '')
        const kind = t === 'error' ? classifyErrorKind(code, detail, 'stream') : 'stream'
        throw new QuickWsError(String(detail || `quick ${t}`), { kind, code })
      }
      // tool_start/tool_arguments/tool_progress/tool_result, runs_updated,
      // task_list_update, title_generated, session_sync … are agent-internal;
      // Quick executes its own tools, so they don't map to OpenAI tool_calls.
    }
    if (parser) {
      const tail = parser.end()
      yield* emitParsed(tail)
      if (tail.dropped) yield note('[quick] 已忽略无效、未声明或不完整的工具调用')
    }
  }

  yield { type: 'meta', threadId, reused, mode }
  const truncationNote = '为适应 Quick 64KB 消息上限，已压缩或截断部分上下文'
  const notedTruncation = stats.truncated
  if (notedTruncation) yield note(truncationNote)

  const produced = () => state.text.length > 0 || state.calls.length > 0 || state.reasoning.length > 0
  try {
    yield* consume(socket.turn(threadId, payload, { signal, frame, session }))
  } catch (e) {
    if (!cont || produced() || state.usage || e?.kind !== 'missing_thread' || signal?.aborted) throw e
    // Cached thread may be gone server-side: retry once on a fresh thread with
    // the full custom_prompt, full tool preamble, and full transcript.
    const fresh = crypto.randomUUID()
    const freshPlan = planFresh()
    const full = renderTranscript(convo, '', freshPlan.renderOptions)
    if (stats.truncated && !notedTruncation) yield note(truncationNote)
    threadId = fresh
    yield { type: 'meta', threadId: fresh, reused: false, mode }
    if (instruction) payload.custom_prompt = instruction
    payload.text = upstreamText(freshPlan.pre, full)
    payload.message_id = crypto.randomUUID()
    yield* consume(socket.turn(fresh, payload, { signal, session }))
  }

  // Remember where this conversation stands for the next request.
  if (sessions && (state.text || state.calls.length)) {
    const key = extendHash(hashes[convo.length], replyMessage(visibleText, state.calls))
    const last = state.calls.at(-1)
    sessions.set(key, state.quickToolId ? { threadId, quickToolId: state.quickToolId, clientCallId: last.id, clientToolName: last.name } : { threadId })
  }
  yield { type: 'done', threadId, text: state.text, reasoning: state.reasoning, usage: state.usage }
}

function makeId(threadId) {
  return `chatcmpl-quick-${threadId?.slice(0, 8) ?? 'x'}-${Date.now().toString(36)}`
}

/**
 * @param {object} p
 * @param {object} p.body       parsed Chat Completions request
 * @param {object} p.outpostMgr createOutpostManager() result
 * @param {object} [p.sessions] session store (lib/sessions.mjs)
 * @param {object} [p.options]  plugin options
 * @param {string} [p.effortHeader] X-Magpie-Effort style header value
 * @param {AbortSignal} [p.signal]
 */
export async function handleChatCompletions({ body, outpostMgr, sessions, options, effortHeader, signal }) {
  if (!body || typeof body !== 'object') return errorResponse(400, 'request body must be JSON', 'invalid_request_error')
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return errorResponse(400, 'messages is required', 'invalid_request_error')
  }
  for (const m of body.messages) {
    if (!m || !['system', 'developer', 'user', 'assistant', 'tool', 'function'].includes(m.role)
      || (m.tool_calls != null && (!Array.isArray(m.tool_calls) || m.tool_calls.some((c) => !c || typeof c !== 'object')))) {
      return errorResponse(400, 'messages contains an invalid role or tool call', 'invalid_request_error')
    }
  }
  const choice = body.tool_choice
  let tools = choice === 'none' || choice?.type === 'none' ? [] : normalizeTools(body.tools)
  const forced = choice?.function?.name ?? (choice?.type === 'tool' ? choice.name : undefined)
  if (forced != null) {
    tools = tools.filter((t) => t.name === forced)
    if (!tools.length) return errorResponse(400, 'tool_choice must name a declared tool', 'invalid_request_error')
  }
  if (signal?.aborted) return errorResponse(499, 'aborted')
  const controller = new AbortController()
  const turnSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let socket, session
  try {
    const outpost = await withAbort(outpostMgr.ensure(), turnSignal)
    session = await withAbort(outpost.session(), turnSignal)
    if (!session?.id_token || !session.ws_host) throw new QuickWsError('missing Quick session', { kind: 'auth' })
    socket = await withAbort(socketFor(outpost, options), turnSignal)
  } catch (e) {
    return errorResponse(httpStatus(e), e?.message ?? String(e), errorType(e))
  }

  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'smart'
  const it = runTurn({ session, socket, tools, body: { ...body, model }, sessions, options: { ...options, effortHeader }, signal: turnSignal })

  // Pull up to the first real output before answering so auth/session failures
  // surface as real HTTP statuses (magpie marks the account on 401, fails over
  // on 429/5xx) instead of a 200 stream that dies immediately.
  const pre = []
  let meta
  try {
    for (;;) {
      const r = await it.next()
      if (r.done) break
      if (r.value.type === 'meta') { meta = r.value; continue }
      pre.push(r.value)
      if (r.value.type !== 'note' && r.value.type !== 'usage') break
    }
  } catch (e) {
    return errorResponse(httpStatus(e), e?.message ?? String(e), errorType(e))
  }
  const items = (async function* () {
    try { yield* pre; yield* it } finally { await it.return() }
  })()

  const created = Math.floor(Date.now() / 1000)
  const id = makeId(meta?.threadId)

  if (!body.stream) {
    let text = ''
    let reasoning = ''
    const calls = []
    let usage
    try {
      for await (const o of items) {
        if (o.type === 'text' || o.type === 'note') text += o.text
        else if (o.type === 'reasoning') reasoning += o.text
        else if (o.type === 'tool_call') calls.push({ id: o.id, type: 'function', function: { name: o.name, arguments: o.arguments } })
        else if (o.type === 'usage') usage = addUsage(usage, o.usage)
      }
    } catch (e) {
      return errorResponse(httpStatus(e), e?.message ?? String(e), errorType(e))
    }
    const message = { role: 'assistant', content: text }
    if (reasoning) message.reasoning_content = reasoning
    if (calls.length) message.tool_calls = calls
    return new Response(
      JSON.stringify({
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
        usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  const enc = new TextEncoder()
  const includeUsage = !!body.stream_options?.include_usage
  async function* sse() {
    const send = (obj) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`)
    const chunk = (delta, finish = null) => send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })
    let toolIndex = 0
    let usage
    try {
      yield chunk({ role: 'assistant', content: '' })
      for await (const o of items) {
        if (o.type === 'text' || o.type === 'note') yield chunk({ content: o.text })
        else if (o.type === 'reasoning') yield chunk({ reasoning_content: o.text })
        else if (o.type === 'tool_call') {
          yield chunk({ tool_calls: [{ index: toolIndex++, id: o.id, type: 'function', function: { name: o.name, arguments: o.arguments } }] })
        } else if (o.type === 'usage') usage = addUsage(usage, o.usage)
      }
      yield chunk({}, toolIndex ? 'tool_calls' : 'stop')
      if (includeUsage) yield send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })
    } catch (e) {
      yield send({ error: { message: e?.message ?? String(e), type: errorType(e), code: httpStatus(e) } })
    }
    yield enc.encode('data: [DONE]\n\n')
  }
  const chunks = sse()
  const stream = new ReadableStream({
    async pull(output) {
      const r = await chunks.next()
      if (controller.signal.aborted) return
      if (r.done) output.close()
      else output.enqueue(r.value)
    },
    async cancel() {
      controller.abort()
      await chunks.return()
      await it.return()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  })
}

/** /v1/models in OpenAI shape. */
export function handleModels() {
  return new Response(JSON.stringify({ object: 'list', data: MODELS }), {
    headers: { 'content-type': 'application/json' },
  })
}

export { AGENT_MODES }
