import { createHash, randomUUID } from "node:crypto"
import { basename } from "node:path"
import { takeCheckpoint, saveCheckpoint } from "./checkpoint.mjs"
import { accountScope, configOption, connect, failure, optionValues, workspaceReleased } from "./acp.mjs"
import { contentParts, messagesResponse, promptParts, hasPrefill, replayPrompt } from "./messages.mjs"
import { sessionMeter } from "./usage.mjs"

function digest(value) {
  const canonical = JSON.stringify(value, (_, object) => {
    if (!object || Array.isArray(object) || typeof object !== "object") return object
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]))
  })
  return createHash("sha256").update(canonical).digest("hex")
}

function history(messages) {
  return digest(messages.map(m => {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content
    return [m.role, blocks.filter(b => b?.type !== "thinking" && b?.type !== "redacted_thinking").map(block => {
      if (!block || typeof block !== "object") return block
      const { cache_control, ...content } = block
      return content
    })]
  }))
}

// A result can share a user message with text, or arrive in a separate message.
function continuation(messages) {
  const prefill = hasPrefill(messages)
  const prior = prefill ? messages.slice(0, -1) : messages
  const end = prior.findLastIndex(m => m.role === "assistant") + 1
  const calls = messages[end - 1]?.content
  const ids = new Set(Array.isArray(calls) ? calls.filter(b => b?.type === "tool_use").map(b => b.id) : [])
  const results = new Map()
  const companions = messages.slice(end).map(m => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m
    const content = m.content.filter(b => {
      if (b?.type !== "tool_result") return true
      if (ids.size && !ids.has(b.tool_use_id)) throw failure(400, "tool_result does not match the preceding tool_use.")
      if (results.has(b.tool_use_id)) throw failure(400, "Duplicate tool_result ID.")
      results.set(b.tool_use_id, { content: contentParts(b.content ?? "", true), isError: !!b.is_error })
      return false
    })
    return { ...m, content }
  })
  if (results.size && ids.size && results.size !== ids.size) throw failure(400, "Return a result for every tool_use in the batch.")
  return { prefix: messages.slice(0, end), hasToolCalls: ids.size > 0, results, extra: promptParts(companions, prefill) }
}

const toolWait = 10 * 60_000
const ttl = 120_000
// Sessions own a process. Completed HTTP replies only retain bounded data.
const suspended = new Map()
const replies = new Map()
const delivered = new Map()
const running = new Map()

function untilAborted(work, signal) {
  if (!signal) return work
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason)
    if (signal.aborted) stop()
    else signal.addEventListener("abort", stop, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop))
  })
}

function take(map, key) {
  const entry = map.get(key)
  if (entry) { clearTimeout(entry.timer); map.delete(key) }
  return entry
}

function retain(map, key, entry, limit, lifetime = ttl) {
  function evict(k) { take(map, k)?.turn?.close() }
  evict(key)
  if (map.size >= limit) {
    const idle = map === suspended && [...map].find(([, item]) => !item.calls)
    evict(idle ? idle[0] : map.keys().next().value)
  }
  entry.timer = setTimeout(() => evict(key), lifetime)
  entry.timer.unref()
  map.set(key, entry)
}

function nativeTurn(key, tools, restore) {
  const queue = [], callers = new Set()
  let wake, sessionId, images, closed, meter, canSteer, steering, resumable, options, currentModel, currentEffort
  function enqueue(event) {
    if (closed) return
    queue.push(event)
    wake?.()
  }
  const rpc = connect({ key, tools, restore, onCall(uuid, { name, input }) {
    if (closed) throw closed
    if (!tools.some(t => t.name === name) || !input || Array.isArray(input) || typeof input !== "object") throw failure(502, "Invalid Droid tool call.")
    return new Promise((resolve, reject) => {
      callers.add(reject)
      rpc.waitForTools(true)
      enqueue({ tool: { type: "tool_use", id: "toolu_" + uuid, name, input }, deliver(result) {
        callers.delete(reject)
        if (!callers.size) rpc.waitForTools(false)
        resolve(result)
      } })
    })
  }, onUpdate(update) {
    if (update.content?.type !== "text") return
    const kind = { agent_message_chunk: "text", agent_thought_chunk: "thinking" }[update.sessionUpdate]
    if (kind) enqueue({ kind, text: update.content.text })
  } })
  function close(error = failure(502, "Droid session closed.")) {
    if (closed) return
    closed = error
    for (const reject of callers) reject(error)
    callers.clear()
    rpc.close(error)
    wake?.()
  }
  function checkImages(parts) {
    if (!images && parts.some(p => p.type === "image")) throw failure(400, "This Droid CLI does not accept images over ACP.")
  }
  return {
    close,
    get alive() { return !closed && !rpc.ended },
    get canSteer() { return canSteer },
    steer(prompt) {
      // Droid acknowledges a concurrent prompt after the native turn ends.
      // Release the MCP result immediately after writing the new instruction.
      checkImages(prompt)
      const acknowledgement = rpc.request("session/prompt", { sessionId, prompt }, 300_000)
      steering = Promise.all([steering, acknowledgement]).then(() => {}, close)
    },
    async open() {
      const caps = await rpc.initialize()
      images = caps.promptCapabilities?.image
      canSteer = caps._meta?.factory?.promptWhileRunning === true
      resumable = !!caps.sessionCapabilities?.resume
      if (restore && !resumable) throw failure(502, "Droid cannot resume this session.")
      const session = await rpc.newSession()
      sessionId = session.sessionId
      meter = sessionMeter(rpc.cwd, sessionId, restore?.usage)
      if (session.modes?.currentModeId && session.modes.currentModeId !== "normal") {
        await rpc.request("session/set_mode", { sessionId, modeId: "normal" })
      }
      options = session.configOptions
      currentModel = configOption(options, "model")?.currentValue ?? session.models?.currentModelId
    },
    checkpoint() {
      if (resumable) return { id: sessionId, dir: basename(rpc.cwd), server: rpc.serverName, usage: meter.snapshot() }
    },
    async configure(model, effort) {
      const picker = configOption(options, "model")
      if (model !== "default" && model !== currentModel) {
        const advertised = optionValues(picker).some(o => o.value === model)
        let changed
        if (advertised) {
          try {
            changed = await rpc.request("session/set_config_option", { sessionId, configId: picker.id, value: model })
          } catch (error) { if (error.rpcCode !== -32601) throw error }
        }
        if (!changed) changed = await rpc.request("session/set_model", { sessionId, modelId: model })
        options = changed?.configOptions ?? options
        const applied = configOption(changed?.configOptions, "model")?.currentValue
        if (applied != null && applied !== model) throw failure(502, "Droid did not apply the requested model.")
        currentModel = model
        currentEffort = undefined
      }
      if (effort != null && effort !== currentEffort) {
        const option = configOption(options, "thought_level")
        if (!option) throw failure(400, "This Droid CLI does not expose a reasoning effort setting.")
        const offered = optionValues(option).some(o => o.value === effort)
        const changed = await rpc.request("session/set_config_option", { sessionId, configId: option.id, value: effort })
        options = changed?.configOptions ?? options
        currentEffort = configOption(changed?.configOptions, "thought_level")?.currentValue
        if (offered && currentEffort != null && currentEffort !== effort) {
          throw failure(502, "Droid did not apply the requested reasoning effort.")
        }
      }
    },
    prompt(parts, required, fresh) {
      checkImages(parts)
      if (fresh) {
        const instruction = tools.length
          ? "Use only the caller's tools on the MCP server " + rpc.serverName + ". Use ToolSearch to load them by their qualified names: " + tools.map(t => rpc.serverName + "___" + t.name).join(", ") + ". Call them directly. " + (required ? "A caller tool is required for this turn." : "")
          : "Answer the user's request directly. No tools are available."
        parts = [{ type: "text", text: instruction }, ...parts]
      }
      meter.begin()
      steering = undefined
      rpc.request("session/prompt", { sessionId, prompt: parts }, 300_000).then(async result => {
        await steering
        const reason = { end_turn: "end_turn", max_tokens: "max_tokens", model_context_window_exceeded: "max_tokens", refusal: "refusal" }[result?.stopReason]
        if (!reason) throw failure(502, "Droid stopped the prompt: " + (result?.stopReason ?? "unknown reason"))
        enqueue({ reason, usage: result.usage })
      }).catch(error => enqueue({ error }))
    },
    async read(chunk, parallel) {
      for (;;) {
        if (closed) throw closed
        if (!queue.length) {
          await new Promise(resolve => { wake = resolve })
          wake = undefined
          continue
        }
        const event = queue.shift()
        if (event.error) throw event.error
        if (!event.kind) {
          const usage = await meter.read(event.usage)
          if (!event.tool) return { ...event, usage }
          const calls = [event]
          // The mailbox publishes calls from one scan together. Never wait for
          // a second call: a sequential caller needs the first result to proceed.
          while (parallel && queue[0]?.tool) calls.push(queue.shift())
          return { calls, usage, reason: "tool_use" }
        }
        chunk(event.kind, event.text)
      }
    },
  }
}

export async function runMessages({ key, headers, body, prepared, signal }) {
  const { messages, stream, tools, tool_choice, model, output_config, reasoning_effort, ...config } = body
  const effort = headers.get("x-magpie-effort") || output_config?.effort || reasoning_effort
  const selection = { model, effort }
  const rawSession = headers.get("x-magpie-session") || ""
  const session = /^magpie-[0-9a-f]{24}$/.test(rawSession) ? "" : rawSession
  const catalog = [...prepared.tools].sort((a, b) => a.name.localeCompare(b.name))
  const owner = accountScope(key)
  // Only Claude Code's generated model identity can change during /model.
  const identityLines = []
  const stripModel = value => typeof value === "string" ? value.replace(/^You are powered by the model (?:named [^\n]{1,80}?\. The exact model ID is )?\S{1,160}\.(?: Assistant knowledge cutoff is [^.\n]{1,40}\.)?$/gm, line => {
    identityLines.push(line)
    return ""
  }) : value
  const system = Array.isArray(config.system) ? config.system.map(b => b?.type === "text" ? { ...b, text: stripModel(b.text) } : b) : stripModel(config.system)
  const scope = owner && digest([owner, session, headers.get("x-magpie-subagent"), headers.get("x-magpie-work-dir"), { ...config, system },
    { ...output_config, effort: undefined }, catalog, prepared.required, tool_choice?.disable_parallel_tool_use])
  const { prefix, hasToolCalls, results, extra } = continuation(messages)
  const result = results.size > 0
  const toolScope = scope && digest([scope, selection, config.system])
  const prefixHash = scope && prefix.length ? history(prefix) : undefined
  const previous = prefixHash ? digest([result ? toolScope : scope, prefixHash]) : undefined
  // The step that returned the last tool calls, when this request brings no result for them.
  const unanswered = prefixHash && !result ? digest([toolScope, prefixHash]) : undefined
  const requestKey = scope && (result || session || headers.has("idempotency-key")) ? digest([toolScope, history(messages), headers.get("idempotency-key")]) : undefined
  signal?.throwIfAborted()
  const pending = running.get(requestKey)
  if (pending) {
    if (!pending.disconnected) throw failure(409, "The same request is still in progress.")
    const error = await untilAborted(pending.done, signal)
    if (error) throw error
  }
  const cached = replies.get(requestKey)
  if (cached) {
    if (!cached.answer) throw failure(409, "The original reply exceeds the retry cache limit.")
    return messagesResponse({ body, signal, id: cached.id, close() {}, async run(chunk) {
      for (const block of cached.blocks) chunk(block.type, block[block.type])
      const usage = cached.claimed ? undefined : cached.answer.usage
      cached.claimed = true
      return { ...cached.answer, usage }
    } })
  }
  const match = suspended.get(previous)
  // A late result can still resume or replay this step after the process closes.
  if (unanswered) take(suspended, unanswered)?.turn.close()
  const canAnswer = result && match?.calls && match.calls.every(c => results.has(c.tool.id)) && (!extra.length || match.turn.canSteer)
  const receiptKey = result && hasToolCalls && previous
  const receipt = receiptKey && delivered.get(receiptKey)
  // Older Droid versions replay accompanying instructions while the native callback
  // is still waiting. It may later accept the same batch without those instructions.
  const replayWithLiveCalls = result && match?.turn.alive && !canAnswer
  const batch = replayWithLiveCalls || receipt?.liveBatch ? digest(Object.fromEntries(results)) : undefined
  const retryFailure = receipt?.failed && receipt.requestKey === requestKey
  const finishLiveBatch = canAnswer && receipt?.liveBatch && receipt.liveBatch === batch
  if ((receiptKey && running.has(receiptKey)) || (receipt && !retryFailure && !finishLiveBatch)) {
    throw failure(409, "This tool call has already received a result.")
  }
  const canContinue = !result && session && extra.length && !match?.calls
  // A live MCP callback belongs to its process. A replacement process can
  // resume the saved conversation and submit the client's completed results.
  const saved = (canContinue || result && (canAnswer || !match?.turn.alive)) && takeCheckpoint(previous)
  const prior = match?.selection ?? saved?.selection
  // Droid has no reset-to-default action for a live effort override.
  const canSelect = prior && (model !== "default" || prior.model === model) && (effort || !prior.effort)
  const savedResults = result && Array.isArray(saved?.pending) && saved.pending.length === results.size &&
    saved.pending.every(id => results.has(id))
  const reuse = match?.turn.alive && (canAnswer || canContinue && canSelect)
  let turn = reuse ? take(suspended, previous).turn : undefined
  let finish, timer, submittedResult = false
  const active = { disconnected: false, done: new Promise(resolve => { finish = resolve }) }
  const http = new AbortController()
  const disconnect = () => {
    if (http.signal.aborted) return
    http.abort(signal?.reason)
    if (submittedResult) {
      // The tool already has its result. Let a retry collect the same answer.
      active.disconnected = true
      timer = setTimeout(() => turn.close(failure(504, "Droid timed out after disconnect.")), ttl)
      timer.unref()
    } else turn?.close(http.signal.reason)
  }
  signal?.addEventListener("abort", disconnect, { once: true })
  if (requestKey) running.set(requestKey, active)
  if (receiptKey) running.set(receiptKey, active)
  const finishRequest = error => {
    clearTimeout(timer)
    signal?.removeEventListener("abort", disconnect)
    if (running.get(requestKey) === active) running.delete(requestKey)
    if (receiptKey && running.get(receiptKey) === active) {
      running.delete(receiptKey)
      retain(delivered, receiptKey, { requestKey, failed: !!error, liveBatch: replayWithLiveCalls ? batch : undefined }, 64)
    }
    finish(error)
  }
  try {
    if (reuse && result) {
      if (extra.length) turn.steer(extra)
      for (const call of match.calls) call.deliver(results.get(call.tool.id))
      submittedResult = true
    } else {
      let continued = !!reuse
      if (!turn && saved && canSelect && (!result || savedResults)) {
        try {
          await untilAborted(workspaceReleased(saved.dir), http.signal)
          turn = nativeTurn(key, prepared.tools, saved)
          await turn.open()
          continued = true
        } catch {
          turn?.close()
          turn = undefined
          http.signal.throwIfAborted()
        }
      }
      if (!turn) {
        turn = nativeTurn(key, prepared.tools)
        await turn.open()
      }
      await turn.configure(model, effort)
      http.signal.throwIfAborted()
      if (continued && model !== prior?.model && identityLines.length) {
        extra.unshift({ type: "text", text: "\nSystem instructions:\n" + identityLines.join("\n") })
      }
      let prompt = continued ? extra : replayPrompt(body, prepared)
      if (continued && savedResults) {
        // The new MCP server has no callback for the previous process. Include
        // the related call and result so the model sees exactly what finished.
        prompt = [{ type: "text", text: "The client already executed these tool calls. Continue from the following results.\n" },
          ...promptParts(messages.slice(prefix.length - 1))]
      }
      turn.prompt(prompt, prepared.required, !continued)
      submittedResult = !!receiptKey
    }
    const id = "msg_" + randomUUID()
    async function readStep(chunk) {
      try {
        const blocks = []
        let bytes = 0
        const event = await turn.read((type, text) => {
          if (!text || (type === "thinking" && body.thinking?.type === "disabled")) return
          if (!http.signal.aborted) chunk(type, text)
          bytes += Buffer.byteLength(text)
          if (bytes > 512_000) return
          if (blocks.at(-1)?.type === type) blocks.at(-1)[type] += text
          else blocks.push({ type, [type]: text })
        }, !tool_choice?.disable_parallel_tool_use)
        if (event.reason === "end_turn" && prepared.required) throw failure(502, "Droid ended its turn without calling the required tool.")
        const calls = event.calls
        const answer = { reason: event.reason, tools: calls?.map(c => c.tool), usage: event.usage }
        if (calls) bytes += Buffer.byteLength(JSON.stringify(answer.tools))
        if (scope && (calls || (session && event.reason === "end_turn")) && bytes <= 512_000) {
          const content = calls ? [...blocks, ...answer.tools] : blocks
          const next = digest([calls ? toolScope : scope, history([...messages, { role: "assistant", content }])])
          retain(suspended, next, { turn, calls, selection }, 8, calls ? toolWait : ttl)
          const data = turn.checkpoint()
          if (data) saveCheckpoint(next, { ...data, selection, pending: calls?.map(c => c.tool.id) })
        } else turn.close()
        if (requestKey) retain(replies, requestKey, bytes <= 512_000 ? { id, blocks, answer, claimed: !active.disconnected } : {}, 32)
        finishRequest()
        return answer
      } catch (error) { turn.close(error); finishRequest(error); throw error }
    }
    return await messagesResponse({ body, id, signal, close() {}, cancel: disconnect, run(chunk) {
      return untilAborted(readStep(chunk), http.signal)
    } })
  } catch (error) {
    if (!active.disconnected) { turn?.close(error); finishRequest(error) }
    throw error
  }
}
