// Native Gemini transport. Only model/stream routing fields are removed;
// contents, signed parts, schemas and native replies are never reconstructed.
import {
  AI_HOST, SAFE_TEXT, MAX_BODY_BYTES, isObject, safeError, invalid, abortReason,
  drain, secretsOf, redactErrorDetails, bearerRejected, safeHeaders, streamHeaders,
  sseRelay, messageFor, owns, nativeRequestJSON,
} from "./transport.js"
import { isGeminiModel } from "./discovery.js"

const TOP = new Set(["model", "stream", "contents", "systemInstruction", "generationConfig", "tools", "toolConfig", "safetySettings"])
const PART = new Set(["text", "thought", "thoughtSignature", "inlineData", "functionCall", "functionResponse"])
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"])
const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/
const object = (value, where) => { if (!isObject(value)) throw invalid(where + " must be an object.") }
const keys = (value, allowed, where) => {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw invalid("Unsupported field in " + where + ": " + key + ".")
}
const nonnegative = value => Number.isSafeInteger(value) && value >= 0
const strings = value => Array.isArray(value) && value.every(item => typeof item === "string")

function validatePart(part, role, image) {
  object(part, "A content part")
  keys(part, PART, "a content part")
  const payloads = ["text", "inlineData", "functionCall", "functionResponse"].filter(key => key in part)
  if (payloads.length !== 1 && !(payloads.length === 0 && typeof part.thoughtSignature === "string" && part.thoughtSignature)) throw invalid("A part requires one native payload or an opaque signature.")
  if ("thought" in part && (role !== "model" || typeof part.thought !== "boolean")) throw invalid("A thought flag requires a model part and a boolean.")
  if ("thoughtSignature" in part && (role !== "model" || typeof part.thoughtSignature !== "string" || !part.thoughtSignature)) throw invalid("A thought signature requires a model part and a non-empty string.")
  if ("text" in part && typeof part.text !== "string") throw invalid("Part text must be a string.")
  if ("inlineData" in part) {
    if (!image) throw invalid("Image input is not supported for this model.")
    const data = part.inlineData
    object(data, "inlineData")
    keys(data, new Set(["mimeType", "data"]), "inlineData")
    if (!IMAGE_TYPES.has(data.mimeType) || typeof data.data !== "string" || !data.data || data.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.data)) throw invalid("inlineData requires a supported image MIME type and base64 data.")
  }
  for (const key of ["functionCall", "functionResponse"]) {
    if (!(key in part)) continue
    if (role !== (key === "functionCall" ? "model" : "user")) throw invalid("A " + key + " has the wrong content role.")
    const fn = part[key]
    object(fn, key)
    keys(fn, new Set(key === "functionCall" ? ["id", "name", "args"] : ["id", "name", "response", "parts"]), key)
    if (typeof fn.name !== "string" || !NAME.test(fn.name)) throw invalid("A function name is invalid.")
    if ("id" in fn && (typeof fn.id !== "string" || !fn.id)) throw invalid("A function ID must be a non-empty string.")
    if (key === "functionCall") {
      if ("args" in fn) object(fn.args, "Function arguments")
    } else {
      object(fn.response, "Function response")
      if ("parts" in fn) {
        if (!Array.isArray(fn.parts) || !fn.parts.length) throw invalid("Function response parts must be a non-empty array.")
        for (const nested of fn.parts) {
          object(nested, "A function response part")
          keys(nested, new Set(["inlineData"]), "a function response image part")
          validatePart(nested, "user", image)
        }
      }
    }
  }
}

function validateGeneration(config) {
  object(config, "generationConfig")
  keys(config, new Set(["maxOutputTokens", "temperature", "topP", "topK", "candidateCount", "stopSequences", "responseMimeType", "responseSchema", "responseJsonSchema", "thinkingConfig", "seed", "presencePenalty", "frequencyPenalty"]), "generationConfig")
  for (const key of ["maxOutputTokens", "topK", "candidateCount"]) if (key in config && (!nonnegative(config[key]) || config[key] === 0)) throw invalid(key + " must be a positive integer.")
  if ("seed" in config && !Number.isSafeInteger(config.seed)) throw invalid("seed must be an integer.")
  for (const key of ["temperature", "topP", "presencePenalty", "frequencyPenalty"]) if (key in config && (typeof config[key] !== "number" || !Number.isFinite(config[key]))) throw invalid(key + " must be finite.")
  if ("stopSequences" in config && !strings(config.stopSequences)) throw invalid("stopSequences must be strings.")
  if ("responseMimeType" in config && !["text/plain", "application/json"].includes(config.responseMimeType)) throw invalid("Unsupported responseMimeType.")
  for (const key of ["responseSchema", "responseJsonSchema"]) if (key in config) object(config[key], key)
  if ("responseSchema" in config && "responseJsonSchema" in config) throw invalid("Use only one response schema.")
  if ("thinkingConfig" in config) {
    const thinking = config.thinkingConfig
    object(thinking, "thinkingConfig")
    keys(thinking, new Set(["thinkingBudget", "thinkingLevel", "includeThoughts"]), "thinkingConfig")
    if ("thinkingBudget" in thinking && (!Number.isSafeInteger(thinking.thinkingBudget) || thinking.thinkingBudget < -1)) throw invalid("thinkingBudget must be an integer >= -1.")
    if ("thinkingLevel" in thinking && (typeof thinking.thinkingLevel !== "string" || !["MINIMAL", "LOW", "MEDIUM", "HIGH"].includes(thinking.thinkingLevel.toUpperCase()))) throw invalid("Unsupported thinkingLevel.")
    if ("thinkingBudget" in thinking && "thinkingLevel" in thinking) throw invalid("Use only one thinking control.")
    if ("includeThoughts" in thinking && typeof thinking.includeThoughts !== "boolean") throw invalid("includeThoughts must be a boolean.")
  }
}

export function validateRequest(body, entry) {
  object(body, "Request")
  keys(body, TOP, "the Gemini request")
  if (!isGeminiModel(body.model)) throw invalid("A native Gemini model is required.")
  if ("stream" in body && typeof body.stream !== "boolean") throw invalid("stream must be a boolean.")
  if (!Array.isArray(body.contents) || !body.contents.length) throw invalid("contents must be a non-empty array.")
  for (const content of body.contents) {
    object(content, "Content")
    keys(content, new Set(["role", "parts"]), "content")
    if (!["user", "model"].includes(content.role) || !Array.isArray(content.parts) || !content.parts.length) throw invalid("Content requires a user/model role and non-empty parts.")
    for (const part of content.parts) validatePart(part, content.role, entry?.capabilities?.image === true)
  }
  if ("systemInstruction" in body) {
    const system = body.systemInstruction
    object(system, "systemInstruction")
    keys(system, new Set(["role", "parts"]), "systemInstruction")
    if ("role" in system && system.role !== "user") throw invalid("systemInstruction role must be user.")
    if (!Array.isArray(system.parts) || !system.parts.length) throw invalid("systemInstruction requires text parts.")
    for (const part of system.parts) {
      object(part, "System part")
      keys(part, new Set(["text"]), "a system part")
      if (typeof part.text !== "string") throw invalid("System text must be a string.")
    }
  }
  if ("generationConfig" in body) validateGeneration(body.generationConfig)
  if ("tools" in body) {
    if (!Array.isArray(body.tools)) throw invalid("tools must be an array.")
    for (const tool of body.tools) {
      object(tool, "Tool")
      keys(tool, new Set(["functionDeclarations"]), "a tool (only agent-executed functions are supported)")
      if (!Array.isArray(tool.functionDeclarations) || !tool.functionDeclarations.length) throw invalid("A tool requires functionDeclarations.")
      for (const fn of tool.functionDeclarations) {
        object(fn, "Function declaration")
        keys(fn, new Set(["name", "description", "parameters", "parametersJsonSchema", "response", "responseJsonSchema"]), "a function declaration")
        if (typeof fn.name !== "string" || !NAME.test(fn.name)) throw invalid("A function name is invalid.")
        if ("description" in fn && typeof fn.description !== "string") throw invalid("Function description must be a string.")
        for (const key of ["parameters", "parametersJsonSchema", "response", "responseJsonSchema"]) if (key in fn) object(fn[key], key)
        if ("parameters" in fn && "parametersJsonSchema" in fn) throw invalid("Use only one function parameter schema.")
        if ("response" in fn && "responseJsonSchema" in fn) throw invalid("Use only one function response schema.")
      }
    }
  }
  if ("toolConfig" in body) {
    object(body.toolConfig, "toolConfig")
    keys(body.toolConfig, new Set(["functionCallingConfig"]), "toolConfig")
    const config = body.toolConfig.functionCallingConfig
    object(config, "functionCallingConfig")
    keys(config, new Set(["mode", "allowedFunctionNames"]), "functionCallingConfig")
    if ("mode" in config && !["AUTO", "ANY", "NONE", "VALIDATED"].includes(config.mode)) throw invalid("Unsupported function calling mode.")
    if ("allowedFunctionNames" in config && (!strings(config.allowedFunctionNames) || !config.allowedFunctionNames.every(name => NAME.test(name)))) throw invalid("allowedFunctionNames must be function names.")
  }
  if ("safetySettings" in body) {
    if (!Array.isArray(body.safetySettings)) throw invalid("safetySettings must be an array.")
    for (const setting of body.safetySettings) {
      object(setting, "Safety setting")
      keys(setting, new Set(["category", "threshold", "method"]), "a safety setting")
      if (typeof setting.category !== "string" || typeof setting.threshold !== "string" || ("method" in setting && typeof setting.method !== "string")) throw invalid("Invalid safety setting.")
    }
  }
  return body
}

function targetURL(entry, aiRoot, streaming) {
  const raw = entry?.deploymentURL
  const reject = () => safeError("inference-destination", { status: 502 })
  if (typeof raw !== "string" || !/^https:\/\//i.test(raw) || /[\x00-\x20\x7f-\x9f\\\s?#]/.test(raw) || /%(?:2f|5c|2e)/i.test(raw)) throw reject()
  let url
  try { url = new URL(raw) } catch { throw reject() }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !AI_HOST.test(url.hostname) || (aiRoot && url.origin !== aiRoot) || !/^\/v2\/inference\/deployments\/[A-Za-z0-9_-]+$/.test(url.pathname) || raw !== url.origin + url.pathname || !isGeminiModel(entry.modelName)) throw reject()
  return raw + "/models/" + entry.modelName + (streaming ? ":streamGenerateContent?alt=sse" : ":generateContent")
}

function validUsage(value) {
  return isObject(value) && Object.entries(value).every(([key, count]) => !key.endsWith("TokenCount") || nonnegative(count))
}

function responseShape(value) {
  if (!isObject(value) || "error" in value) return false
  if ("usageMetadata" in value && !validUsage(value.usageMetadata)) return false
  if (isObject(value.promptFeedback) && typeof value.promptFeedback.blockReason === "string" && value.promptFeedback.blockReason) return true
  return Array.isArray(value.candidates) && value.candidates.length > 0 && value.candidates.every(candidate =>
    isObject(candidate) && (candidate.index === undefined || nonnegative(candidate.index)) &&
    (candidate.finishReason === undefined || (typeof candidate.finishReason === "string" && !!candidate.finishReason && candidate.finishReason !== "FINISH_REASON_UNSPECIFIED")) &&
    (candidate.content === undefined ? typeof candidate.finishReason === "string" :
      isObject(candidate.content) && (candidate.content.role === undefined || candidate.content.role === "model") &&
      (candidate.content.parts === undefined ? typeof candidate.finishReason === "string" :
        Array.isArray(candidate.content.parts) && candidate.content.parts.every(isObject))))
}

function relayGemini(upstream, signal, secrets) {
  const finished = new Map()
  let blocked = false
  return sseRelay(upstream, signal, {
    classify(event, name) {
      if (name && name !== "message") throw safeError("inference-response")
      if (isObject(event) && "error" in event) return { terminal: true, redacted: redactErrorDetails(event, secrets) }
      // A usage-only trailing frame is legal and must not be dropped.
      const usageOnly = isObject(event) && !("candidates" in event) && validUsage(event.usageMetadata) && finished.size > 0
      if (!usageOnly && !responseShape(event)) throw safeError("inference-response")
      blocked ||= !!event.promptFeedback?.blockReason
      for (const candidate of event.candidates ?? []) {
        const index = candidate.index ?? 0
        if (finished.get(index) && candidate.content?.parts?.length) throw safeError("inference-response")
        finished.set(index, finished.get(index) === true || typeof candidate.finishReason === "string")
      }
      return { terminal: false, redacted: event }
    },
    complete: () => blocked || (finished.size > 0 && [...finished.values()].every(Boolean)),
    errorEvent: code => "data: " + JSON.stringify({ error: { code: 502, status: "INTERNAL", message: messageFor(code) } }) + "\n\n",
  })
}

export async function dispatch({ entry, body, credentials, token, signal, extraSecrets, rejectedToken } = /** @type {*} */ ({})) {
  if (signal?.aborted) throw abortReason(signal)
  const streaming = body.stream === true
  if (streaming && entry?.capabilities?.streaming !== true) throw invalid("Streaming is not supported for this model.")
  const url = targetURL(entry, credentials?.aiRoot, streaming)
  const bearer = token?.value
  const group = credentials?.resourceGroup
  if (typeof bearer !== "string" || !SAFE_TEXT.test(bearer) || typeof group !== "string" || !SAFE_TEXT.test(group)) throw safeError("internal", { status: 500 })
  const { model, stream, ...nativeBody } = body
  let response
  try {
    response = await globalThis.fetch(url, { method: "POST", redirect: "error", signal, headers: { "content-type": "application/json", accept: streaming ? "text/event-stream" : "application/json", authorization: "Bearer " + bearer, "AI-Resource-Group": group }, body: nativeRequestJSON(body) ?? JSON.stringify(nativeBody) })
  } catch {
    if (signal?.aborted) throw abortReason(signal)
    throw safeError("inference-network")
  }
  if (signal?.aborted) {
    void response.body?.cancel().catch(() => {})
    throw abortReason(signal)
  }
  if (response.redirected || response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400) || (response.url && response.url !== url)) {
    void response.body?.cancel().catch(() => {})
    throw safeError("inference-redirect")
  }
  if (response.status === 401 && bearerRejected(response.headers.get("www-authenticate"))) rejectedToken?.()
  const secrets = secretsOf(credentials, token, extraSecrets)
  if (streaming && response.ok) {
    if (!response.body || !/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "")) {
      void response.body?.cancel().catch(() => {})
      throw safeError("inference-response")
    }
    return new Response(relayGemini(response.body, signal, secrets), { status: response.status, headers: streamHeaders() })
  }
  let native
  let nativeText
  try {
    if (!response.body) throw safeError("inference-response")
    const bytes = await drain(response.body, signal, MAX_BODY_BYTES, () => safeError("inference-response"))
    nativeText = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    native = JSON.parse(nativeText)
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal)
    if (response.ok) throw owns(error) ? error : safeError("inference-response")
    native = { error: { code: response.status, message: messageFor("inference-response") } }
  }
  if (response.ok && (!responseShape(native) || (!native.promptFeedback?.blockReason && !native.candidates.every(candidate => typeof candidate.finishReason === "string")))) throw safeError("inference-response")
  return new Response(response.ok ? nativeText : JSON.stringify(redactErrorDetails(native, secrets)), { status: response.status, headers: safeHeaders(response) })
}
