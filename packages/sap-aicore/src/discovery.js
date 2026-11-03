import { claudeFamily, resolveCanonicalClaude } from "./identity.js"
import { AI_HOST, SAFE_TEXT, isObject } from "./transport.js"

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const SAFE_PATH = /^(?:\/[A-Za-z0-9_-]+)+$/
const safeId = v => typeof v === "string" && SAFE_ID.test(v)

const TIMEOUT_MS = 15000
const PAGE_SIZE = 100
const MAX_PAGES = 128
const MAX_ROWS = 4096
const MAX_BODY_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_REQUESTS = 512

const ERRORS = {
  destination: "SAP AI Core: unsafe deployment-list destination.",
  response: "SAP AI Core: deployment listing returned an unexpected response.",
  network: "SAP AI Core: deployment listing could not be reached.",
  timeout: "SAP AI Core: deployment discovery timed out.",
  cancelled: "SAP AI Core: deployment discovery was cancelled.",
  exhausted: "SAP AI Core: deployment listing exceeded its bounds.",
  identity: "SAP AI Core: a Claude deployment's model identity could not be resolved.",
  conflict: "SAP AI Core: distinct Claude deployments resolved to the same model identity.",
}

const OWNED = new WeakSet()

/** @returns {Error & {code: string, status?: number, retryAfter?: string}} */
function failure(code) {
  const error = Object.assign(new Error(ERRORS[code]), { code })
  OWNED.add(error)
  return error
}

function safeFailure(error) {
  return OWNED.has(error) ? error : failure("response")
}

function abortReason(signal) {
  return OWNED.has(signal?.reason) ? signal.reason : failure("cancelled")
}

function rootOrigin(aiRoot) {
  if (typeof aiRoot !== "string" || !/^https:\/\//i.test(aiRoot) || /[\x00-\x20\x7f-\x9f\\\s?#]/.test(aiRoot) ||
      /%(?:2f|5c|2e)/i.test(aiRoot) || /\/(?:\.|\.\.)(?:\/|$)/.test(aiRoot)) return null
  let base
  try { base = new URL(aiRoot) } catch { return null }
  if (base.protocol !== "https:" || base.username || base.password || base.port ||
      base.search || base.hash || base.pathname !== "/" || !AI_HOST.test(base.hostname) ||
      (aiRoot !== base.origin && aiRoot !== base.origin + "/")) return null
  return base.origin
}

function requestContext(aiRoot, resourceGroup, bearer, signal, rejectedToken) {
  const origin = rootOrigin(aiRoot)
  if (origin === null) throw failure("destination")
  if (typeof resourceGroup !== "string" || !SAFE_TEXT.test(resourceGroup)) throw failure("destination")
  if (typeof bearer !== "function") throw failure("response")
  return { origin, resourceGroup, bearer, signal, rejectedToken, requests: 0, totalBytes: 0 }
}

function requestURL(origin, path, query) {
  if (typeof path !== "string" || !SAFE_PATH.test(path)) throw failure("destination")
  const url = new URL(origin + path)
  if (query) for (const key of Object.keys(query)) url.searchParams.set(key, query[key])
  return url.href
}

async function requestJSON(context, path, query) {
  if (context.requests >= MAX_REQUESTS) throw failure("exhausted")
  context.requests++
  const href = requestURL(context.origin, path, query)
  if (context.signal.aborted) throw abortReason(context.signal)
  const token = await context.bearer()
  if (context.signal.aborted) throw abortReason(context.signal)
  if (typeof token !== "string" || !SAFE_TEXT.test(token)) throw failure("response")
  let response
  try {
    response = await globalThis.fetch(href, {
      method: "GET",
      redirect: "error",
      headers: {
        Authorization: "Bearer " + token,
        "AI-Resource-Group": context.resourceGroup,
        Accept: "application/json",
      },
      signal: context.signal,
    })
  } catch (error) {
    if (context.signal.aborted) throw abortReason(context.signal)
    throw failure("network")
  }
  if (context.signal.aborted) {
    void response?.body?.cancel?.().catch(() => {})
    throw abortReason(context.signal)
  }
  if (response.redirected || (response.url && response.url !== href) || (response.status >= 300 && response.status < 400)) {
    void response.body?.cancel?.().catch(() => {})
    throw failure("destination")
  }
  if (!response.ok) {
    if (response.status === 401 && /^Bearer\b/i.test(response.headers?.get?.("www-authenticate") ?? "") &&
        /\berror\s*=\s*(?:"(?:invalid_token|expired_token)"|(?:invalid_token|expired_token))(?=\s|,|$)/i.test(response.headers?.get?.("www-authenticate") ?? "")) context.rejectedToken?.()
    const error = failure("response")
    if (response.status >= 400 && response.status <= 599) error.status = response.status
    const retryAfter = response.headers?.get?.("retry-after")
    if (/^\d{1,10}$/.test(retryAfter ?? "")) error.retryAfter = retryAfter
    void response.body?.cancel?.().catch(() => {})
    throw error
  }
  const { json, bytes } = await readJSON(response, context.signal, MAX_TOTAL_BYTES - context.totalBytes)
  context.totalBytes += bytes
  return json
}

function pageRows(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw failure("response")
  if (!Array.isArray(json.resources)) throw failure("response")
  if (json.count !== undefined && !(Number.isSafeInteger(json.count) && json.count >= 0)) throw failure("response")
  return json.resources
}

function deploymentId(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw failure("response")
  if (!safeId(row.id)) throw failure("response")
  return row.id
}

async function readJSON(response, signal, remainingBytes) {
  const reader = response.body?.getReader?.()
  if (!reader) throw failure("response")
  const chunks = []
  let size = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    for (;;) {
      if (signal.aborted) throw abortReason(signal)
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES || size > remainingBytes) throw failure("exhausted")
      chunks.push(value)
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
    return { json: JSON.parse(text), bytes: size }
  } catch (error) {
    cancel()
    if (signal.aborted) throw abortReason(signal)
    throw safeFailure(error)
  } finally {
    signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
}

async function collect(context) {
  const rows = []
  const seen = new Set()
  let skip = 0
  for (let pages = 0; ; pages++) {
    if (context.signal.aborted) throw abortReason(context.signal)
    if (pages >= MAX_PAGES) throw failure("exhausted")
    const resources = pageRows(await requestJSON(context, "/v2/lm/deployments", {
      scenarioId: "foundation-models",
      executableIds: "azure-openai,aws-bedrock",
      status: "RUNNING",
      $top: String(PAGE_SIZE),
      $skip: String(skip),
    }))
    if (resources.length === 0) return rows
    for (const row of resources) {
      const id = deploymentId(row)
      if (seen.has(id)) throw failure("response")
      seen.add(id)
      rows.push(row)
    }
    if (rows.length > MAX_ROWS) throw failure("exhausted")
    const next = skip + resources.length
    if (!Number.isSafeInteger(next) || next <= skip) throw failure("response")
    skip = next
  }
}

/** @param {{aiRoot?: string, resourceGroup?: string, bearer?: () => Promise<string>, signal?: AbortSignal, rejectedToken?: () => void}} request */
async function operation({ aiRoot, resourceGroup, bearer, signal, rejectedToken } = {}, run) {
  const controller = new AbortController()
  const abort = reason => { if (!controller.signal.aborted) controller.abort(reason) }
  let timer
  let onAbort
  const stop = new Promise((_, reject) => {
    onAbort = () => reject(abortReason(controller.signal))
    controller.signal.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => abort(failure("timeout")), TIMEOUT_MS)
  })
  const relay = () => abort(abortReason(signal))
  if (signal) {
    if (signal.aborted) abort(abortReason(signal))
    else signal.addEventListener("abort", relay, { once: true })
  }
  const work = (async () => run(requestContext(aiRoot, resourceGroup, bearer, controller.signal, rejectedToken)))()
  work.catch(() => {})
  try {
    return await Promise.race([work, stop])
  } catch (error) {
    abort(failure("cancelled"))
    throw safeFailure(error)
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener("abort", onAbort)
    signal?.removeEventListener("abort", relay)
  }
}

// test-only: exposes the raw pre-enrichment collection phase for tests.
// Production uses discover(), which runs collection and enrichment together.
export async function listDeployments(request = {}) {
  return operation(request, collect)
}

export function isPermittedModel(modelName) {
  if (typeof modelName !== "string") return false
  const match = /^gpt-(\d+)(?:\.\d+)*(?:-[a-z0-9]+)*$/.exec(modelName)
  return match !== null && match[0] === modelName && Number(match[1]) >= 6
}

function deploymentUrl(raw, origin, id) {
  if (typeof raw !== "string" || !/^https:\/\//i.test(raw) ||
      /[\x00-\x20\x7f-\x9f\\\s?#]/.test(raw) || /%(?:2f|5c|2e)/i.test(raw)) return null
  let url
  try { url = new URL(raw) } catch { return null }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.search || url.hash || url.origin !== origin) return null
  const path = "/v2/inference/deployments/" + id
  if (url.pathname !== path || raw !== origin + path) return null
  return raw
}

const EXECUTABLES = new Set(["azure-openai", "aws-bedrock"])

function resolveIdentity(deployment, configuration) {
  if (!isObject(configuration)) return null
  if (typeof configuration.executableId !== "string" || configuration.scenarioId !== "foundation-models" || !EXECUTABLES.has(configuration.executableId)) return null
  const executableId = configuration.executableId
  if (deployment.scenarioId !== undefined && deployment.scenarioId !== "foundation-models") return null
  if (deployment.executableId !== undefined && deployment.executableId !== executableId) return null

  const bindings = configuration.parameterBindings
  if (!Array.isArray(bindings)) return null
  for (const b of bindings) {
    if (!isObject(b) || typeof b.key !== "string" || typeof b.value !== "string") return null
  }
  const names = bindings.filter(b => b.key === "modelName")
  const versions = bindings.filter(b => b.key === "modelVersion")
  if (names.length !== 1 || versions.length > 1) return null
  const modelName = names[0].value
  if (!modelName) return null
  let configuredVersion = "latest"
  if (versions.length === 1) {
    if (!versions[0].value) return null
    configuredVersion = versions[0].value
  }

  let configurationID = null
  if (configuration.id !== undefined) {
    if (!safeId(configuration.id)) return null
    configurationID = configuration.id
  }
  if (deployment.configurationId !== undefined) {
    if (!safeId(deployment.configurationId)) return null
    if (configurationID !== null && configurationID !== deployment.configurationId) return null
    configurationID ??= deployment.configurationId
  }
  return { modelName, configuredVersion, configurationID, executableId }
}

// Resolve the concrete backend version, reconciling any configured pin.
function resolveActive(deployment, modelName, configuredVersion) {
  const backend = deployment?.details?.resources?.backendDetails?.model
  if (!isObject(backend)) return null
  if (typeof backend.name !== "string" || backend.name !== modelName) return null
  const version = backend.version
  if (typeof version !== "string" || !version || version === "latest") return null
  if (configuredVersion !== "latest" && configuredVersion !== version) return null
  return version
}

function dateUTC(y, mo, da) {
  const t = Date.UTC(y, mo - 1, da)
  const d = new Date(t)
  return d.getUTCFullYear() === y && d.getUTCMonth() === mo - 1 && d.getUTCDate() === da ? t : null
}

export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  return m ? dateUTC(Number(m[1]), Number(m[2]), Number(m[3])) : null
}

function todayUTC() {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

function scenariosAllow(scenarios, executableId) {
  if (!Array.isArray(scenarios)) return false
  for (const s of scenarios) {
    if (!isObject(s) || typeof s.scenarioId !== "string" || typeof s.executableId !== "string") return false
  }
  return scenarios.some(s => s.scenarioId === "foundation-models" && s.executableId === executableId)
}

// The single, validated catalog model entry for this model under its executable.
function catalogModel(catalog, modelName, executableId) {
  if (!isObject(catalog) || !Array.isArray(catalog.resources)) return null
  if (catalog.count !== undefined && !(Number.isSafeInteger(catalog.count) && Number(catalog.count) >= 0)) return null
  const models = catalog.resources.filter(r => isObject(r) && r.model === modelName)
  if (models.length !== 1) return null
  const model = models[0]
  if (model.executableId !== undefined && model.executableId !== executableId) return null
  if (!scenariosAllow(model.allowedScenarios, executableId)) return null
  return model
}

// Version-matched metadata for a validated catalog model entry. Facts are taken
// from the concrete resolved version, never inherited across versions/models.
function resolveMetadata(model, activeVersion, executableId) {
  if (!Array.isArray(model.versions)) return null
  const matched = model.versions.filter(v => isObject(v) && v.name === activeVersion)
  if (matched.length !== 1) return null
  const version = matched[0]

  if (version.deprecated !== undefined && typeof version.deprecated !== "boolean") return null
  if (version.deprecated === true) return null
  if (version.isLatest !== undefined && typeof version.isLatest !== "boolean") return null
  if (version.allowedScenarios !== undefined && !scenariosAllow(version.allowedScenarios, executableId)) return null
  if (version.streamingSupported !== undefined) {
    if (typeof version.streamingSupported !== "boolean") return null
  }
  if (version.inputTypes !== undefined) {
    if (!Array.isArray(version.inputTypes) || !version.inputTypes.every(t => typeof t === "string")) return null
    if (!version.inputTypes.includes("text")) return null
  }

  const metadata = {}
  if (version.contextLength !== undefined) {
    if (!Number.isSafeInteger(version.contextLength) || version.contextLength <= 0) return null
    metadata.contextLength = version.contextLength
  }
  if (version.retirementDate !== undefined) {
    if (typeof version.retirementDate !== "string") return null
    if (version.retirementDate !== "") {
      const retires = parseDate(version.retirementDate)
      if (retires === null || retires <= todayUTC()) return null
      metadata.retirementDate = version.retirementDate
    }
  }
  if (version.streamingSupported !== undefined) metadata.streamingSupported = version.streamingSupported
  if (version.deprecated !== undefined) metadata.deprecated = version.deprecated
  if (version.inputTypes !== undefined) metadata.inputTypes = Object.freeze([...version.inputTypes])
  return metadata
}

function freezeEntry(deployment, identity, url, activeVersion, metadata, extra) {
  const entry = {
    ...extra,
    modelName: identity.modelName,
    deploymentID: deployment.id,
    deploymentURL: url,
    configuredVersion: identity.configuredVersion,
    activeVersion,
    activeEvidence: "deployment-backend",
    scenarioID: "foundation-models",
    executableID: identity.executableId,
  }
  if (identity.configurationID !== null) entry.configurationID = identity.configurationID
  if (Object.keys(metadata).length) entry.metadata = Object.freeze(metadata)
  return Object.freeze(entry)
}

// GPT major version >= 6, OpenAI Responses on /responses.
function resolveResponses(deployment, identity, model, url) {
  if (!isPermittedModel(identity.modelName)) return null
  const activeVersion = resolveActive(deployment, identity.modelName, identity.configuredVersion)
  if (activeVersion === null) return null
  const metadata = resolveMetadata(model, activeVersion, "azure-openai")
  if (metadata === null || metadata.streamingSupported === false) return null
  return freezeEntry(deployment, identity, url, activeVersion, metadata, {
    protocol: "responses",
    canonicalID: identity.modelName,
    displayLabel: identity.modelName,
    apiNpm: "@ai-sdk/openai",
    routePolicy: Object.freeze({ path: "/responses", query: false }),
    capabilities: Object.freeze({ text: true, functionTool: true, streaming: true, image: metadata.inputTypes?.includes("image") === true }),
  })
}
// Verified request-policy baselines. Emitted only for the two live-verified
// baseline canonical IDs at their verified active version "1"; newer versions
// never inherit these controls or the 128000 output maximum.
const BASELINE_POLICY = {
  "claude-opus-4-8": { maxOutputTokens: 128000, rejectTemperature: true, rejectTopP: true, rejectEnabledThinking: true },
  "claude-sonnet-4-6": { maxOutputTokens: 128000, rejectCombinedSampling: true, rejectForcedToolThinking: true },
}

// Identity evidence kept out of the public frozen entry: true when the canonical
// ID was established from authoritative display metadata rather than SAP-format
// fallback. Discovery's collision rule consults it; transport never sees it.
const IDENTITY_AUTHORITATIVE = new WeakMap()

function baselinePolicy(canonicalID, activeVersion) {
  if (activeVersion !== "1" || !Object.hasOwn(BASELINE_POLICY, canonicalID)) return null
  return Object.freeze({ ...BASELINE_POLICY[canonicalID] })
}

// Claude: contract-based family rule (no model/version allowlist), native
// Anthropic Messages on the Bedrock invoke endpoints. The canonical agent-facing
// ID is resolved from model metadata; the raw SAP identity stays in the entry
// for version reconciliation and account-local routing but is opaque to
// transport. A Claude deployment whose canonical identity cannot be resolved is
// an observable discovery error, not a silent omission.
function resolveAnthropic(deployment, identity, model, url) {
  const activeVersion = resolveActive(deployment, identity.modelName, identity.configuredVersion)
  if (activeVersion === null) return null
  const metadata = resolveMetadata(model, activeVersion, "aws-bedrock")
  if (metadata === null) return null
  // Preserve raw metadata so malformed types fail closed rather than becoming absent.
  if (!claudeFamily({ provider: model.provider, sapIdentity: identity.modelName, displayName: model.displayName })) return null
  const resolved = resolveCanonicalClaude({ sapIdentity: identity.modelName, displayName: model.displayName })
  if (resolved === null) throw failure("identity")
  const requestPolicy = baselinePolicy(resolved.canonicalID, activeVersion)
  const entry = freezeEntry(deployment, identity, url, activeVersion, metadata, {
    protocol: "anthropic",
    canonicalID: resolved.canonicalID,
    displayLabel: resolved.displayLabel,
    apiNpm: "@ai-sdk/anthropic",
    routePolicy: Object.freeze({ invoke: "/invoke", stream: "/invoke-with-response-stream", query: false }),
    capabilities: Object.freeze({ text: true, functionTool: true, streaming: metadata.streamingSupported === true, image: metadata.inputTypes?.includes("image") === true }),
    ...(requestPolicy ? { requestPolicy } : {}),
  })
  IDENTITY_AUTHORITATIVE.set(entry, typeof model.displayName === "string" && model.displayName.trim() !== "")
  return entry
}

/** @param {{deployment?: any, configuration?: any, catalog?: any, aiRoot?: string}} request */
export function resolveDeployment({ deployment, configuration, catalog, aiRoot } = {}) {
  const origin = rootOrigin(aiRoot)
  if (origin === null || !isObject(deployment) || deployment.status !== "RUNNING") return null
  if (!safeId(deployment.id)) return null

  const url = deploymentUrl(deployment.deploymentUrl, origin, deployment.id)
  if (url === null) return null

  const identity = resolveIdentity(deployment, configuration)
  if (identity === null) return null

  const model = catalogModel(catalog, identity.modelName, identity.executableId)
  if (model === null) return null

  if (identity.executableId === "azure-openai") return resolveResponses(deployment, identity, model, url)
  if (identity.executableId === "aws-bedrock") return resolveAnthropic(deployment, identity, model, url)
  return null
}

const CATALOG_PATH = "/v2/lm/scenarios/foundation-models/models"
const CONFIGURATION_PATH = "/v2/lm/configurations/"
const DEPLOYMENT_PATH = "/v2/lm/deployments/"

const backendModel = d => d?.details?.resources?.backendDetails?.model

function backendMalformed(d) {
  if (d.details === undefined) return false
  if (!isObject(d.details)) return true
  if (d.details.resources === undefined) return false
  if (!isObject(d.details.resources)) return true
  if (d.details.resources.backendDetails === undefined) return false
  if (!isObject(d.details.resources.backendDetails)) return true
  const model = d.details.resources.backendDetails.model
  if (model === undefined) return false
  if (!isObject(model)) return true
  if (model.name !== undefined && typeof model.name !== "string") return true
  if (model.version !== undefined && typeof model.version !== "string") return true
  return false
}

function listIneligible(row, origin) {
  if (typeof row.status !== "string" || row.status === "") throw failure("response")
  if (row.status !== "RUNNING") return true
  if (row.scenarioId !== undefined && row.scenarioId !== "foundation-models") return true
  if (row.executableId !== undefined && !EXECUTABLES.has(row.executableId)) return true
  if (row.deploymentUrl !== undefined && deploymentUrl(row.deploymentUrl, origin, row.id) === null) return true
  if (row.configurationId !== undefined && !safeId(row.configurationId)) return true
  if (backendMalformed(row)) return true
  return false
}

function listComplete(row) {
  const model = backendModel(row)
  return row.deploymentUrl !== undefined && row.configurationId !== undefined &&
    typeof model?.name === "string" && typeof model?.version === "string"
}

function structuredDetail(detail, id) {
  if (!isObject(detail) || detail.id !== id || typeof detail.status !== "string") return false
  for (const key of ["configurationId", "deploymentUrl", "scenarioId", "executableId"]) {
    if (detail[key] !== undefined && typeof detail[key] !== "string") return false
  }
  return !backendMalformed(detail)
}

function repair(row, detail, origin) {
  if (!structuredDetail(detail, row.id)) throw failure("response")
  if (detail.status !== row.status) return null

  const merged = { ...row }

  if (detail.configurationId !== undefined) {
    if (!safeId(detail.configurationId)) return null
    if (row.configurationId === undefined) merged.configurationId = detail.configurationId
    else if (row.configurationId !== detail.configurationId) return null
  }
  if (merged.configurationId === undefined) return null

  if (detail.deploymentUrl !== undefined) {
    const url = deploymentUrl(detail.deploymentUrl, origin, row.id)
    if (url === null) return null
    if (row.deploymentUrl === undefined) merged.deploymentUrl = url
    else if (deploymentUrl(row.deploymentUrl, origin, row.id) !== url) return null
  }
  if (merged.deploymentUrl === undefined) return null

  for (const key of ["scenarioId", "executableId"]) {
    if (detail[key] === undefined) continue
    if (row[key] === undefined) merged[key] = detail[key]
    else if (row[key] !== detail[key]) return null
  }

  const detailModel = backendModel(detail)
  if (detailModel !== undefined) {
    const listModel = backendModel(row)
    const model = {}
    for (const field of ["name", "version"]) {
      const listVal = listModel?.[field]
      const detailVal = detailModel[field]
      if (listVal !== undefined && detailVal !== undefined && listVal !== detailVal) return null
      const value = detailVal ?? listVal
      if (value !== undefined) model[field] = value
    }
    merged.details = { resources: { backendDetails: { model } } }
  }
  if (!isObject(backendModel(merged))) return null

  return merged
}

async function candidate(context, row) {
  if (listIneligible(row, context.origin)) return null
  if (listComplete(row)) return row
  return repair(row, await requestJSON(context, DEPLOYMENT_PATH + row.id), context.origin)
}

function structuredConfiguration(json, configurationId) {
  if (!isObject(json)) return false
  if (typeof json.scenarioId !== "string" || typeof json.executableId !== "string") return false
  if (!Array.isArray(json.parameterBindings)) return false
  for (const b of json.parameterBindings) {
    if (!isObject(b) || typeof b.key !== "string" || typeof b.value !== "string") return false
  }
  if (json.id !== undefined && (!safeId(json.id) || json.id !== configurationId)) return false
  return true
}

// The memo caches the in-flight promise, not the resolved value, so concurrent
// enrichment workers asking for the same configuration or the catalog share one
// fetch rather than each issuing its own.
function configuration(context, memo, configurationId) {
  if (!memo.has(configurationId)) {
    memo.set(configurationId, (async () => {
      const json = await requestJSON(context, CONFIGURATION_PATH + configurationId)
      if (!structuredConfiguration(json, configurationId)) throw failure("response")
      return json
    })())
  }
  return memo.get(configurationId)
}

function catalog(context, memo) {
  if (memo.catalog === undefined) {
    memo.catalog = (async () => {
      const json = await requestJSON(context, CATALOG_PATH)
      pageRows(json)
      return json
    })()
  }
  return memo.catalog
}

// Resolve up to ENRICH_CONCURRENCY rows at once, preserving input order in the
// results. The first failure stops new work from being picked up and is rethrown
// once in-flight work settles; the operation's shared signal aborts the rest.
const ENRICH_CONCURRENCY = 8

async function mapBounded(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  let failed = null
  async function worker() {
    while (failed === null) {
      const i = next++
      if (i >= items.length) return
      try { results[i] = await fn(items[i]) }
      catch (error) { if (failed === null) failed = error; return }
    }
  }
  const workers = []
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker())
  await Promise.all(workers)
  if (failed !== null) throw failed
  return results
}

// Conservative structural equality of the selection-relevant facts two entries
// must share before distinct raw SAP identities may collapse to one canonical
// ID. Any difference in protocol, version, capabilities, route, metadata or
// request policy keeps them a conflict rather than an equivalence.
const selectionShape = e =>
  JSON.stringify([e.protocol, e.activeVersion, e.executableID, e.capabilities, e.routePolicy,
    e.metadata ?? null, e.requestPolicy ?? null])
const compatibleSelection = (a, b) => selectionShape(a) === selectionShape(b)

async function resolveRow(context, aiRoot, configs, catalogMemo, row) {
  const deployment = await candidate(context, row)
  if (deployment === null) return null
  return resolveDeployment({
    deployment,
    configuration: await configuration(context, configs, deployment.configurationId),
    catalog: await catalog(context, catalogMemo),
    aiRoot,
  })
}

async function enrich(context, aiRoot, rows) {
  const configs = new Map()
  const catalogMemo = {}
  const chosen = new Map()
  // Rows are resolved concurrently but reduced in input order, so duplicate
  // selection (lowest deployment ID) and conflict detection stay deterministic.
  const entries = await mapBounded(rows, ENRICH_CONCURRENCY, row => resolveRow(context, aiRoot, configs, catalogMemo, row))
  for (const entry of entries) {
    if (entry === null) continue
    const prior = chosen.get(entry.canonicalID)
    if (prior === undefined) { chosen.set(entry.canonicalID, entry); continue }
    // GPT versions share a model ID; select the lowest eligible deployment ID.
    // Claude duplicates still require the same active version.
    const sameConcrete = prior.modelName === entry.modelName &&
      ((prior.protocol === "responses" && entry.protocol === "responses") || prior.activeVersion === entry.activeVersion)
    // Distinct raw SAP identities may share one canonical ID only when both were
    // established from authoritative display metadata and select a compatible
    // model. A fallback-only equivalence, or any incompatibility (version,
    // protocol, capability, policy, metadata), is an observable identity
    // conflict rather than a guessed merge.
    if (!sameConcrete) {
      const equivalent = IDENTITY_AUTHORITATIVE.get(prior) === true &&
        IDENTITY_AUTHORITATIVE.get(entry) === true && compatibleSelection(prior, entry)
      if (!equivalent) throw failure("conflict")
    }
    if (entry.deploymentID < prior.deploymentID) chosen.set(entry.canonicalID, entry)
  }
  const registry = Object.create(null)
  for (const canonicalID of [...chosen.keys()].sort()) registry[canonicalID] = chosen.get(canonicalID)
  return Object.freeze(registry)
}

export async function discover(request = {}) {
  return operation(request, async context => enrich(context, request.aiRoot, await collect(context)))
}

export function projectModels(registry) {
  const catalog = {}
  for (const canonicalID of Object.keys(registry)) {
    const entry = registry[canonicalID]
    const model = {
      id: entry.canonicalID,
      name: entry.displayLabel,
      providerID: "sap-aicore",
      api: { id: entry.canonicalID, npm: entry.apiNpm },
      capabilities: {
        toolcall: entry.capabilities.functionTool === true,
        attachment: entry.capabilities.image === true,
        input: { text: true, image: entry.capabilities.image === true, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
      },
    }
    const contextLength = entry.metadata?.contextLength
    const maxOutput = entry.requestPolicy?.maxOutputTokens
    if (contextLength !== undefined || maxOutput !== undefined) {
      model.limit = {}
      if (contextLength !== undefined) model.limit.context = contextLength
      if (maxOutput !== undefined) model.limit.output = maxOutput
    }
    catalog[canonicalID] = model
  }
  return catalog
}
