import { randomUUID as nodeRandomUUID } from "node:crypto"
import * as discovery from "./discovery.mjs"
import {
  buildQuery,
  comatePieces,
  consumeComateSSE,
  events,
  MAX_TOOL_CALLS,
  newState,
  parseToolCalls,
  piecesOf,
  ProtocolRequestError,
  queryOf,
  ToolTextParser,
} from "./protocol.mjs"

const SITE = { id: "comate", name: "Comate" }
const NPM = "@ai-sdk/openai-compatible"
const PORT_FALLBACK = 8741
const LIST_TIMEOUT_MS = 15_000
const CANCEL_TIMEOUT_MS = 1_500

// These ids and display names are a last-resort menu for clients that load
// config before Comate can answer /list-model. Live account data replaces it.
const MODEL_SEEDS = [
  ["deepseek-v4-flash_660919a9053745059c9c023d86567c0d", "Deepseek V4 Flash", "deepseek-v4-flash", true],
  ["deepseek-v4-pro_9b720c11782248878a51edcf6a91b9e6", "Deepseek V4 Pro", "deepseek-v4-pro", true],
  ["deepseek-v4.1-flash_1ff104f179214cf2a5ccd5addc7751a8", "Deepseek V4.1 Flash", "deepseek-v4.1-flash", true],
  ["glm-4.7-fc_0932b6afb498412fb4a02966066ab62c", "GLM-4.7", "glm-4.7-fc", true],
  ["glm-5.0-fc_2690eecf312347009dd0d5f076be1d28", "GLM-5", "glm-5.0-fc", true],
  ["glm-5-turbo-fc_1f06c29b8cab4a99aacde4a818eadadf", "GLM-5-Turbo", "glm-5-turbo-fc", true],
  ["glm-5.1_d18e90e56319488fa14892a22d333652", "GLM-5.1", "glm-5.1", true],
  ["glm-5.2_eb3516c57e204b618f15324fff45bfc2", "GLM-5.2", "glm-5.2", true],
  ["glm-5.3_53f6498d9c0c4152af79c5912e7c533d", "GLM-5.3", "glm-5.3", true],
  ["glm-5.3-flash_c67a4da6ccd3406ca3b4faa2fc4b5dae", "GLM-5.3-Flash", "glm-5.3-flash", true],
  ["glm-5v-turbo_53f84ce17fec43dbbe1f3d9b574f0a85", "GLM-5v-Turbo", "glm-5v-turbo", true],
  ["kimi-k3_3d357a70771545b8a7621793974a2539", "Kimi K3", "kimi-k3", true],
  ["kimi-k2.6-oneapi_f78874608f044707b36807a9c8e5d2b1", "Kimi-K2.6", "kimi-k2.6-oneapi", true],
  ["minimax-m3_2db94a2ac2ff4288be6cb4b03e18eba5", "MiniMax M3", "minimax-m3", true],
  ["minimax-m2.7-fc_6d8af9f11e9541d6b381d1cf9ce70538", "MiniMax-M2.7", "minimax-m2.7-fc", true],
].map(([modelId, displayName, modelType, thinking]) => ({ modelId, displayName, modelType, thinking }))

const string = (value) => (typeof value === "string" ? value : "")
const modelAliases = new Map(MODEL_SEEDS.flatMap((model) => [
  [model.modelId, model.modelId],
  [model.modelType, model.modelId],
  [model.displayName.toLowerCase(), model.modelId],
]))
const httpStatus = (status) => `HTTP ${status}`

function safeMessage(message, secret) {
  const text = string(message) || "Comate request failed"
  if (!secret) return text
  let safe = text.split(secret).join("[redacted]")
  try {
    const encoded = encodeURIComponent(secret)
    if (encoded !== secret) safe = safe.split(encoded).join("[redacted]")
  } catch {}
  return safe
}

function errorResponse(status, message, signIn, secret = "") {
  return new Response(JSON.stringify({ error: { message: safeMessage(message, secret), type: "comate_error", code: status } }), {
    status,
    headers: {
      "content-type": "application/json",
      ...(signIn ? { "X-Magpie-Sign-In": signIn } : {}),
    },
  })
}

function apiErrorChunk(message, secret) {
  return `data: ${JSON.stringify({ error: { message: safeMessage(message, secret), type: "api_error", code: "comate_error" } })}\n\n`
}

const TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"])

function isTextPart(part) {
  if (typeof part === "string") return true
  if (!part || typeof part !== "object" || Array.isArray(part)) return false
  const type = string(part.type).toLowerCase()
  if (type ? !TEXT_PART_TYPES.has(type) : typeof part.text !== "string") return false
  if (part.image_url || part.audio_url || part.video_url || part.source !== undefined) return false
  return true
}

function isTextOnly(messages) {
  for (const message of messages ?? []) {
    const content = message?.content
    if (content === undefined || content === null || typeof content === "string") continue
    if (Array.isArray(content)) {
      if (!content.every(isTextPart)) return false
      continue
    }
    if (!isTextPart(content)) return false
  }
  return true
}

function textContent(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : string(part?.text)).join("")
  }
  if (content && typeof content === "object") return string(content.text)
  return ""
}

function hasTextContent(messages) {
  return Array.isArray(messages) && messages.some((message) => textContent(message?.content).trim() !== "")
}

function modelIdOf(chat) {
  const original = string(chat?.model).trim()
  const unprefixed = original.startsWith(`${SITE.id}/`) ? original.slice(SITE.id.length + 1) : original
  return modelAliases.get(unprefixed) ?? modelAliases.get(unprefixed.toLowerCase()) ?? unprefixed
}

function configModels() {
  return Object.fromEntries(MODEL_SEEDS.map((model) => [model.modelId, {
    name: model.displayName,
    limit: { context: 0, output: 0 },
    // This is the adapter's prompt-emulated function-call output, not a
    // native capability reported by Comate's model list.
    tool_call: true,
    ...(model.thinking ? { reasoning: true } : {}),
  }]))
}

function modelOf(provider, model, base) {
  const thinking = model?.thinking === true
  return {
    id: model.modelId,
    providerID: provider?.id ?? SITE.id,
    name: string(model.displayName) || model.modelId,
    api: { id: model.modelId, url: base, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, output: 0 },
    capabilities: {
      temperature: false,
      reasoning: thinking,
      attachment: false,
      toolcall: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

function assertLoopback(url) {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new Error("Comate endpoints must use the local IPv4 loopback address")
  }
}

async function liveModels(auth, { fetchImpl, discoveryOptions }) {
  const base = discovery.zulu(auth, discoveryOptions)
  const url = `${base}/list-model`
  assertLoopback(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS)
  timer.unref?.()
  let response
  let envelope
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ license: auth.license }),
      signal: controller.signal,
      redirect: "error",
    })
    if (!response.ok) throw new Error(`Comate /list-model: ${httpStatus(response.status)}`)
    envelope = await response.json().catch(() => null)
  } finally {
    clearTimeout(timer)
  }
  if (envelope?.code != null && Number(envelope.code) !== 0) {
    throw new Error(safeMessage(string(envelope.message) || "Comate /list-model failed", auth.license))
  }
  const list = Array.isArray(envelope?.data) ? envelope.data : []
  const seen = new Set()
  const models = list.filter((model) => {
    if (!model || typeof model.modelId !== "string" || !model.modelId || seen.has(model.modelId)) return false
    seen.add(model.modelId)
    return true
  })
  if (!models.length) throw new Error("Comate /list-model returned no models")
  return { base, list: models }
}

async function bodyText(input, init) {
  const body = init?.body ?? (typeof Request !== "undefined" && input instanceof Request ? await input.clone().text() : undefined)
  if (body === undefined || body === null) return ""
  if (typeof body === "string") return body
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body)
  try {
    return await new Response(body).text()
  } catch {
    return ""
  }
}

async function said(response, secret) {
  const text = await response.text().catch(() => "")
  let message = text.trim().slice(0, 500) || httpStatus(response.status)
  try {
    const value = JSON.parse(text)
    message = string(value?.error?.message) || string(value?.error) || string(value?.message) || string(value?.msg) || message
  } catch {}
  return safeMessage(message, secret)
}

function isAbortError(error) {
  return error?.name === "AbortError"
}

function abortError() {
  return new DOMException("The operation was aborted", "AbortError")
}

async function cancelComate(fetchImpl, base, traceId, license) {
  const url = `${base}/api/v1/conversations/${encodeURIComponent(traceId)}/cancel`
  assertLoopback(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CANCEL_TIMEOUT_MS)
  timer.unref?.()
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ license }),
      signal: controller.signal,
      redirect: "error",
    })
    await response.body?.cancel().catch(() => {})
  } catch {
    // The caller has already cancelled; the local cancel endpoint is best effort.
  } finally {
    clearTimeout(timer)
  }
}

function requestTask({ fetchImpl, base, traceId, license, outerSignal }) {
  const controller = new AbortController()
  let terminal = false
  let cancelled = false
  let cancelPromise = null
  const cleanup = () => outerSignal?.removeEventListener("abort", onAbort)
  const onAbort = () => { void cancel() }

  const cancel = () => {
    if (terminal) return Promise.resolve()
    cleanup()
    cancelled = true
    if (!cancelPromise) {
      // Start the remote cancellation before closing the local event stream.
      cancelPromise = cancelComate(fetchImpl, base, traceId, license)
      controller.abort()
    }
    return cancelPromise
  }
  const finish = () => {
    terminal = true
    cleanup()
  }
  if (outerSignal) {
    if (outerSignal.aborted) void cancel()
    else outerSignal.addEventListener("abort", onAbort, { once: true })
  }

  return { controller, cancel, finish, cleanup, get cancelled() { return cancelled } }
}

function toolCallIds(calls, uuid) {
  return calls.map((call) => ({
    id: `call_${uuid().replaceAll("-", "").slice(0, 24)}`,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  }))
}

function completionResult(chat, result, toolSpec, uuid) {
  const parsed = parseToolCalls(result.text, toolSpec)
  const requiresTool = toolSpec.choice === "required" || toolSpec.choice === "named"
  if (parsed.invalid && requiresTool) {
    return { error: `Comate did not produce a valid requested tool call: ${parsed.invalid}` }
  }
  const calls = parsed.invalid ? [] : parsed.calls
  const toolCalls = toolCallIds(calls, uuid)
  const message = {
    role: "assistant",
    content: toolCalls.length ? null : (parsed.invalid ? result.text : parsed.content),
  }
  if (result.reasoning) message.reasoning_content = result.reasoning
  if (toolCalls.length) message.tool_calls = toolCalls
  return {
    body: {
      id: `chatcmpl-${uuid().replaceAll("-", "").slice(0, 24)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: string(chat.model),
      choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    },
    toolCalls,
  }
}

function chunkEncoder(chat, uuid) {
  const id = `chatcmpl-${uuid().replaceAll("-", "").slice(0, 24)}`
  const created = Math.floor(Date.now() / 1000)
  const model = string(chat.model)
  const encode = (delta, finish = null) => `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
  return { encode, done: "data: [DONE]\n\n" }
}

async function finished(chat, response, task, toolSpec, uuid, license) {
  let result
  try {
    result = await consumeComateSSE(response.body)
  } catch (error) {
    if (task.cancelled || isAbortError(error)) throw error
    await task.cancel()
    return errorResponse(502, `Comate reply could not be read: ${error?.message ?? error}`, "kept", license)
  }

  if (result.terminal) task.finish()
  else await task.cancel()
  if (!result.ok) return errorResponse(502, result.error, "kept", license)

  const completion = completionResult(chat, result, toolSpec, uuid)
  if (completion.error) return errorResponse(502, completion.error, "kept", license)
  return new Response(JSON.stringify(completion.body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function streamed(chat, response, task, toolSpec, uuid, license) {
  const encoder = new TextEncoder()
  const chunks = chunkEncoder(chat, uuid)

  async function* output() {
    const parser = new ToolTextParser(toolSpec)
    const requiresTool = toolSpec.choice === "required" || toolSpec.choice === "named"
    yield chunks.encode({ role: "assistant" })
    let terminal = false
    let failed = ""
    try {
      for await (const piece of comatePieces(response.body)) {
        if (piece.text) {
          for (const part of parser.push(piece.text)) yield chunks.encode({ content: part.text })
        } else if (piece.reasoning) {
          if (!requiresTool) yield chunks.encode({ reasoning_content: piece.reasoning })
        } else if (piece.exception) {
          failed = piece.exception
          break
        } else if (piece.missing) {
          failed = "Comate stream ended before a terminal task event."
          break
        } else if (piece.done) {
          terminal = true
          task.finish()
          if (piece.status !== "completed") failed = `Comate task failed: ${piece.errorMessage || piece.status || "unknown status"}`
          break
        }
      }
      if (!terminal && !failed) failed = "Comate stream ended before a terminal task event."
      if (failed) {
        if (!terminal) await task.cancel()
        yield apiErrorChunk(failed, license)
        yield chunks.done
        return
      }

      const final = parser.finish()
      if (final.invalid && requiresTool) {
        yield apiErrorChunk(`Comate did not produce a valid requested tool call: ${final.invalid}`, license)
        yield chunks.done
        return
      }
      if (final.text) yield chunks.encode({ content: final.text })
      if (final.calls.length) {
        const calls = toolCallIds(final.calls, uuid)
        for (const [index, item] of calls.entries()) {
          yield chunks.encode({ tool_calls: [{ index, id: item.id, type: item.type, function: { name: item.function.name, arguments: "" } }] })
        }
        for (const [index, item] of calls.entries()) {
          yield chunks.encode({ tool_calls: [{ index, function: { arguments: item.function.arguments } }] })
        }
      }
      yield chunks.encode({}, final.calls.length ? "tool_calls" : "stop")
      yield chunks.done
    } catch (error) {
      if (task.cancelled) return
      if (!task.controller.signal.aborted) await task.cancel()
      yield apiErrorChunk(`Comate reply could not be read: ${error?.message ?? error}`, license)
      yield chunks.done
    } finally {
      task.cleanup()
    }
  }

  const iterator = output()
  let closed = false
  let pulling = false
  return new Response(new ReadableStream({
    async pull(controller) {
      if (closed || pulling) return
      pulling = true
      try {
        const next = await iterator.next()
        if (next.done) {
          closed = true
          controller.close()
        } else controller.enqueue(encoder.encode(next.value))
      } catch (error) {
        if (!task.cancelled) {
          await task.cancel()
          try {
            controller.enqueue(encoder.encode(apiErrorChunk(`Comate reply could not be read: ${error?.message ?? error}`, license)))
            controller.enqueue(encoder.encode(chunks.done))
            controller.close()
          } catch {}
        }
        closed = true
      } finally {
        pulling = false
      }
    },
    async cancel() {
      closed = true
      await task.cancel()
      try { await iterator.return() } catch {}
    },
  }, { highWaterMark: 0 }), {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

function desktopSignIn(discoveryOptions) {
  return {
    url: "",
    instructions: "Uses the Comate account already signed in on this computer.",
    method: "auto",
    async callback() {
      let state
      try {
        state = discovery.readState(discoveryOptions)
      } catch (error) {
        return { type: "failed", error: error.message }
      }
      if (!state) return { type: "failed", error: "Comate isn't signed in on this computer." }
      return {
        type: "success",
        refresh: "",
        access: state.license,
        expires: 0,
        source: "comate",
        accountId: state.username || SITE.name,
        uid: state.username || "",
      }
    },
  }
}

function licenseSignIn() {
  return {
    type: "api",
    label: "Comate license (paste)",
    placeholder: "Comate license",
    prompts: [
      {
        type: "text",
        key: "license",
        message: "Comate license (baidu.comate.license in Comate settings)",
        validate: (value) => (string(value).trim() ? undefined : "Paste Comate's license"),
      },
      {
        type: "text",
        key: "port",
        message: "Comate local service port (leave empty to discover it)",
        validate: (value) => {
          const text = string(value).trim()
          if (!text) return undefined
          const port = Number(text)
          return Number.isInteger(port) && port > 0 && port <= 65535 ? undefined : "A port is a number from 1 to 65535"
        },
      },
    ],
    authorize(inputs) {
      const license = string(inputs?.license).trim()
      if (!license) return { type: "failed", error: "Paste Comate's license" }
      const rawPort = string(inputs?.port).trim()
      const port = rawPort ? Number(rawPort) : 0
      return {
        type: "success",
        key: license,
        metadata: { ...(port ? { port } : {}), source: "comate-paste" },
      }
    },
  }
}

function makePlugin(options = {}) {
  const discoveryOptions = options.discoveryOptions ?? options
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const uuid = options.randomUUID ?? nodeRandomUUID

  return async ({ client } = {}) => ({
    config: async (config) => {
      config.provider ??= {}
      config.provider[SITE.id] ??= {}
      const provider = config.provider[SITE.id]
      provider.name ??= SITE.name
      provider.npm ??= NPM
      provider.api ??= `${discovery.zulu(null, discoveryOptions)}/v1`
      provider.models = { ...configModels(), ...(provider.models ?? {}) }
    },
    provider: {
      id: SITE.id,
      async models(provider, { auth } = {}) {
        if (!discovery.isComate(auth)) return provider.models
        try {
          const credential = await discovery.credential(async () => auth, discoveryOptions)
          if (!credential) return provider.models
          const { base, list } = await liveModels(credential, { fetchImpl, discoveryOptions })
          for (const model of list) {
            for (const alias of [model.modelId, model.modelType, string(model.displayName).toLowerCase()]) {
              if (alias) modelAliases.set(alias, model.modelId)
            }
          }
          return Object.fromEntries(list.map((model) => [model.modelId, modelOf(provider, model, base)]))
        } catch {
          return provider.models
        }
      },
    },
    auth: {
      provider: SITE.id,
      async loader(getAuth) {
        const auth = await getAuth()
        if (!discovery.isComate(auth)) return {}
        return {
          baseURL: `${discovery.zulu(auth, discoveryOptions)}/v1`,
          apiKey: "",
          async fetch(input, init = {}) {
            const text = await bodyText(input, init)
            let chat
            try { chat = JSON.parse(text) } catch { chat = null }
            if (!chat || typeof chat !== "object" || !Array.isArray(chat.messages)) {
              return errorResponse(400, "Only OpenAI-compatible chat completions are supported.", "kept")
            }
            if (!isTextOnly(chat.messages)) {
              return errorResponse(400, "Comate bridge accepts text parts only; remove non-text content parts.", "kept")
            }
            if (!hasTextContent(chat.messages)) {
              return errorResponse(400, "Messages must contain at least one non-empty text value.", "kept")
            }

            let queryRequest
            try {
              queryRequest = buildQuery(chat, uuid().replaceAll("-", ""))
            } catch (error) {
              if (error instanceof ProtocolRequestError) return errorResponse(error.status, error.message, "kept")
              return errorResponse(400, "The request contains an unsupported tool definition.", "kept")
            }

            let credential
            try {
              credential = await discovery.credential(getAuth, discoveryOptions)
            } catch (error) {
              return errorResponse(error.signIn === "expired" ? 401 : 503, error.message, error.signIn || "kept")
            }
            if (!credential) return errorResponse(401, "Comate isn't signed in here.", "expired")

            const model = modelIdOf(chat)
            if (!model) return errorResponse(400, "The request names no model.", "kept")
            const base = discovery.zulu(credential, discoveryOptions)
            const url = `${base}/api/v1/conversations/init`
            assertLoopback(url)
            const traceId = uuid()
            const payload = {
              query: queryRequest.query,
              license: credential.license,
              model,
              modelId: model,
              traceId,
              mode: "Ask",
              enableCodebaseSearch: false,
            }

            const outerSignal = init.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : null)
            if (outerSignal?.aborted) throw abortError()
            const task = requestTask({ fetchImpl, base, traceId, license: credential.license, outerSignal })
            let response
            try {
              response = await fetchImpl(url, {
                method: "POST",
                headers: { "content-type": "application/json", accept: "text/event-stream" },
                body: JSON.stringify(payload),
                signal: task.controller.signal,
                redirect: "error",
              })
            } catch (error) {
              task.finish()
              if (task.cancelled || isAbortError(error)) throw error
              const message = safeMessage(error?.message ?? "Comate local service could not be reached", credential.license)
              return errorResponse(502, message, "kept", credential.license)
            }

            if (response.status === 403) {
              const why = await said(response, credential.license)
              task.finish()
              return errorResponse(401, `Comate refused the license (${why}). Sign in to Comate again.`, "expired", credential.license)
            }
            if (!response.ok) {
              const why = await said(response, credential.license)
              task.finish()
              return errorResponse(response.status >= 400 ? response.status : 502, why, "kept", credential.license)
            }
            if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
              const why = await said(response, credential.license)
              task.finish()
              return errorResponse(502, `Comate returned a non-SSE response (${why}).`, "kept", credential.license)
            }

            return chat.stream === true
              ? streamed(chat, response, task, queryRequest.toolSpec, uuid, credential.license)
              : finished(chat, response, task, queryRequest.toolSpec, uuid, credential.license)
          },
        }
      },
      methods: [
        { type: "oauth", label: "Comate account (this computer)", authorize: async () => desktopSignIn(discoveryOptions) },
        licenseSignIn(),
      ],
    },
  })
}

export async function ComateAuthPlugin(input = {}, options = {}) {
  return makePlugin(options)(input)
}

// Magpie loads every function export as a plugin entry; keep all helpers on
// this object so only ComateAuthPlugin is treated as an entry point.
export const _internal = {
  SITE,
  NPM,
  PORT_FALLBACK,
  MODEL_SEEDS,
  MAX_TOOL_CALLS,
  buildQuery,
  queryOf,
  parseToolCalls,
  ToolTextParser,
  events,
  piecesOf,
  newState,
  consumeComateSSE,
  configModels,
  modelOf,
  modelIdOf,
  liveModels,
  errorResponse,
  isTextOnly,
  hasTextContent,
  cancelComate,
  requestTask,
  completionResult,
  makePlugin,
  createPlugin: makePlugin,
}
