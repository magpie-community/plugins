import { readFileSync } from "node:fs"
import { randomUUID, createHash } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"

const ORIGIN = "https://opencode.ai"
const CONSOLE = `${ORIGIN}/console`
// Public OpenCode device client ID; requests use this adapter’s User-Agent.
const CLIENT = "opencode-cli"
const ICON = `data:image/svg+xml;base64,${readFileSync(new URL("./assets/opencode.svg", import.meta.url)).toString("base64")}`
const AGENT = `magpie-opencode-console-account/${JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version}`
const SDK = {
  "chat-completions": "@ai-sdk/openai-compatible",
  responses: "@ai-sdk/openai",
  messages: "@ai-sdk/anthropic",
  "generate-content": "@ai-sdk/google",
}
const KINDS = ["text", "image", "audio", "video", "pdf"]
const specs = {
  go: { id: "opencode-go-account", upstream: "opencode-go", name: "OpenCode Go", root: "/inference/go" },
  console: { id: "opencode-console-account", upstream: "opencode", name: "OpenCode Console", root: "/inference" },
}

function expired(message = "OpenCode 登录已失效，请重新登录。") {
  return Object.assign(new Error(message), { signIn: "expired" })
}

const ACCOUNT_TAG = "opencode-workspace-v1:"

function restoreWorkspace(auth) {
  if (auth?.metadata?.orgID) return auth
  if (typeof auth?.accountId !== "string" || !auth.accountId.startsWith(ACCOUNT_TAG)) throw expired("OpenCode workspace missing; please sign in again.")
  const encoded = auth.accountId.slice(ACCOUNT_TAG.length)
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw expired("OpenCode workspace missing; please sign in again.")
  const orgID = Buffer.from(encoded, "base64url").toString("utf8")
  if (!safeOrg(orgID) || Buffer.from(orgID).toString("base64url") !== encoded) throw expired("OpenCode workspace missing; please sign in again.")
  return { ...auth, metadata: { orgID } }
}

function safeToken(value) { return typeof value === "string" && /^[\x21-\x7e]+$/.test(value) }
function safeOrg(value) { return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) }
function deadline(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined
  const result = Date.now() + seconds * 1000
  return Number.isSafeInteger(result) ? result : undefined
}

function requireAuth(auth) {
  if (auth?.type !== "oauth" || !safeToken(auth.access) || !safeToken(auth.refresh) ||
      !safeOrg(auth.metadata?.orgID) || !Number.isSafeInteger(auth.expires) || auth.expires <= 0) throw expired()
  return auth
}

async function json(url, { auth, body, signal, optional = false, pending = false, inference = false } = {}) {
  const headers = new Headers({ accept: "application/json", "user-agent": AGENT })
  if (body) headers.set("content-type", "application/json")
  if (auth) {
    requireAuth(auth)
    headers.set("authorization", `Bearer ${auth.access}`)
    headers.set(inference ? "x-opencode-org-id" : "x-org-id", auth.metadata.orgID)
  }
  const response = await fetch(url, {
    method: body ? "POST" : "GET", headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  })
  if (optional && [403, 404].includes(response.status)) {
    await response.body?.cancel()
    return undefined
  }
  // Do not log response bodies: auth errors can contain credential material.
  if (response.status === 401 && auth) {
    await response.body?.cancel()
    throw expired()
  }
  if (!response.ok && !(pending && response.status === 400)) {
    await response.body?.cancel()
    throw new Error(`OpenCode ${new URL(url).pathname} 返回 HTTP ${response.status}`)
  }
  let result
  try { result = await response.json() }
  catch (e) { if (e.name === "AbortError" || e.name === "TimeoutError") throw e; throw new Error("OpenCode 返回的 JSON 格式无效。") }
  if (!response.ok && (!result?.error || typeof result.error !== "string")) {
    throw new Error(`OpenCode 授权失败（HTTP ${response.status}）`)
  }
  return result
}

async function token(body, signal) {
  return json(`${CONSOLE}/auth/device/token`, { body: { client_id: CLIENT, ...body }, signal, pending: true })
}

function tokenFields(t, previous) {
  if (!object(t) || (t.org_id != null && !safeOrg(t.org_id)) || !safeToken(t.access_token) ||
      !safeToken(t.refresh_token) || !deadline(t.expires_in)) throw new Error("OpenCode 返回的 Token 格式不完整。")
  const metadata = { ...previous }
  if (previous?.orgID && t.org_id != null && t.org_id !== previous.orgID) throw expired("OpenCode 工作区已变更，请重新授权。")
  return { access: t.access_token, refresh: t.refresh_token, expires: deadline(t.expires_in), metadata }
}

export async function startDevice({ signal } = {}) {
  const d = await json(`${CONSOLE}/auth/device/code`, {
    body: { client_id: CLIENT, supports_org_scope: true }, signal,
  })
  if (!object(d) || typeof d.device_code !== "string" || !d.device_code || typeof d.user_code !== "string" || !d.user_code || typeof d.verification_uri_complete !== "string" || !d.verification_uri_complete ||
      (d.interval != null && (!Number.isSafeInteger(d.interval) || d.interval <= 0 || !Number.isSafeInteger(d.interval * 1000))) || !deadline(d.expires_in)) throw new Error("OpenCode 返回的设备码格式不完整。")
  let url
  try { url = new URL(d.verification_uri_complete, `${CONSOLE}/`) } catch { throw new Error("OpenCode 返回了意外的授权地址。") }
  if (url.username || url.password || url.origin !== ORIGIN || !url.pathname.startsWith("/console/")) throw new Error("OpenCode 返回了意外的授权地址。")
  return { ...d, url: url.href, deadline: deadline(d.expires_in) }
}

export async function finishDevice(device, { signal, sleep = delay } = {}) {
  let interval = Math.max(1, Number(device.interval) || 5) * 1000
  while (Date.now() < device.deadline) {
    let wait = Math.min(interval, Math.max(0, device.deadline - Date.now()))
    while (wait > 0) {
      const chunk = Math.min(wait, 2147483647)
      await sleep(chunk, undefined, { signal })
      wait -= chunk
    }
    if (Date.now() >= device.deadline) break
    const deadlineSignal = AbortSignal.timeout(Math.min(2147483647, Math.max(1, Math.ceil(device.deadline - Date.now()))))
    let t
    try { t = await token({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code }, signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal) }
    catch (e) { if (deadlineSignal.aborted && !signal?.aborted) break; throw e }
    if (!object(t)) throw new Error("OpenCode 返回的 Token 格式不完整。")
    if (t.error === "authorization_pending") continue
    if (t.error === "slow_down") { interval = Math.min(Number.MAX_SAFE_INTEGER, interval + 5000); continue }
    if (t.error === "access_denied") throw new Error("OpenCode 授权已拒绝，请重新登录。")
    if (t.error === "expired_token") throw new Error("OpenCode 设备码已过期，请重新登录。")
    if (t.error) throw new Error("OpenCode 授权未完成，请重新登录。")
    const fields = tokenFields(t)
    // A workspace is selected on OpenCode's own authorization page.
    const headers = { authorization: `Bearer ${fields.access}`, "user-agent": AGENT, accept: "application/json" }
    const get = async (path) => {
      const r = await fetch(`${CONSOLE}${path}`, {
        headers, redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      })
      if (!r.ok) { await r.body?.cancel(); throw new Error(`OpenCode 账户查询返回 HTTP ${r.status}`) }
      try { return await r.json() } catch (e) { if (e.name === "AbortError" || e.name === "TimeoutError") throw e; throw new Error("OpenCode 账户信息格式无效。") }
    }
    const [user, orgs] = await Promise.all([get("/api/user"), get("/api/orgs")])
    if (!validAccount(user, orgs)) throw new Error("OpenCode 账户信息不完整。")
    if (t.org_id == null && orgs.length > 1) throw new Error("请选择 OpenCode 工作区后重新授权。")
    const org = t.org_id == null ? orgs[0] : orgs.find((o) => o.id === t.org_id)
    if (!org?.id) throw new Error("未找到授权的 OpenCode 工作区。")
    return {
      type: "success", ...fields,
      accountId: `${user.email} · ${org.name || org.id}`,
      uid: createHash("sha256").update(JSON.stringify([user.id, org.id])).digest("hex"),
      metadata: { accountID: user.id, email: user.email, orgID: org.id, orgName: org.name, server: CONSOLE },
    }
  }
  throw new Error("OpenCode 设备码已过期，请重新登录。")
}

export async function refreshAuth(auth) {
  requireAuth(auth)
  if (!safeToken(auth.refresh)) throw expired()
  const t = await token({ grant_type: "refresh_token", refresh_token: auth.refresh })
  if (!object(t)) throw new Error("OpenCode 返回的 Token 格式不完整。")
  if (t.error === "invalid_grant") throw expired()
  if (t.error) throw new Error("OpenCode 暂时无法刷新登录。")
  return tokenFields(t, auth.metadata)
}

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value) }

function validAccount(user, orgs) {
  const validOrg = (org) => object(org) && safeOrg(org.id) && typeof org.name === "string"
  return object(user) && typeof user.id === "string" && !!user.id &&
    typeof user.email === "string" && !!user.email && Array.isArray(orgs) && orgs.every(validOrg)
}

function validReset(value) {
  return value === undefined || (typeof value === "string" && Number.isFinite(Date.parse(value)))
}

function validMeter(m) {
  return object(m) && Number.isFinite(m.percent) && m.percent >= 0 && validReset(m.resetsAt) &&
    (m.status === undefined || m.status === "ok" || m.status === "rate-limited")
}

function invalidGoUsage(go) {
  if (!object(go) || !object(go.usage)) return true
  const keys = ["rolling", "weekly", "monthly"]
  const valid = (key) => validMeter(go.usage[key])
  return !keys.some(valid) || keys.some((key) => go.usage[key] !== undefined && !valid(key))
}

function invalidBudget(b) {
  const money = (n) => Number.isFinite(n) && n >= 0
  return !object(b) || !money(b.limitDollars) || !money(b.spentDollars) ||
    !["set", "model"].includes(b.per) || !["all", "models"].includes(b.coverage) ||
    !["each", "combined"].includes(b.scope) || !validReset(b.resetsAt) ||
    (b.models !== undefined && !Array.isArray(b.models)) ||
    (b.vendors !== undefined && !Array.isArray(b.vendors)) ||
    (b.inputPriceAtLeast !== undefined && !money(b.inputPriceAtLeast)) ||
    (Array.isArray(b.models) && b.models.some((m) => !object(m) || (m.spentDollars !== undefined && !money(m.spentDollars))))
}

function validateConfig(remote, spec) {
  const fail = () => { throw new Error("OpenCode 工作区配置格式无效。") }
  if (!object(remote)) fail()
  if (remote.providers === undefined) return
  if (!object(remote.providers)) fail()
  const p = remote.providers[spec.upstream]
  if (p === undefined) return
  if (!object(p)) fail()
  const flags = (v) => { for (const k of ["enabled", "disabled"]) if (v[k] !== undefined && typeof v[k] !== "boolean") fail() }
  flags(p)
  if (p.models === undefined) return
  if (!object(p.models)) fail()
  for (const model of Object.values(p.models)) { if (!object(model)) fail(); flags(model) }
}

function modalities(values) {
  return Object.fromEntries(KINDS.map((kind) => [kind, (Array.isArray(values) ? values : ["text"]).some((v) =>
    typeof v === "string" && (v === kind || v.startsWith(`${kind}/`) || (kind === "pdf" && v === "application/pdf")))]))
}

function allowedURL(value, spec, base = false) {
  const url = new URL(value)
  const prefix = spec.root
  const bases = [`${prefix}/openai/v1`, `${prefix}/anthropic/v1`, `${prefix}/google/v1beta`]
  const cleanPath = !/[%;\\]/.test(url.pathname)
  const path = url.pathname.replace(/\/$/, "")
  const validBase = bases.includes(path)
  let validRoute = false
  if (!base && cleanPath) {
    const openai = `${prefix}/openai/v1`
    const anthropic = `${prefix}/anthropic/v1`
    const google = `${prefix}/google/v1beta`
    validRoute = [`${openai}/chat/completions`, `${openai}/responses`, `${anthropic}/messages`].includes(path) ||
      new RegExp(`^${google}/models/[A-Za-z0-9_.-]+:(generateContent|streamGenerateContent)$`).test(path)
  }
  if (url.origin !== ORIGIN || url.username || url.password || !cleanPath ||
      (base ? !validBase || !!url.search || !!url.hash : !validRoute) || url.hash) {
    throw new Error("拒绝向 OpenCode 官方接口以外的地址发送账户 Token。")
  }
  return url
}

function positiveInteger(n) { return Number.isSafeInteger(n) && n > 0 }
function nonnegative(n) { return typeof n === "number" && Number.isFinite(n) && n >= 0 }

function usableCatalogRow(row) {
  const limits = row.limit, text = row.cost?.text
  if (!object(limits) || !positiveInteger(limits.context) || !positiveInteger(limits.output) ||
      (limits.input !== undefined && !positiveInteger(limits.input))) return false
  if (!nonnegative(text?.input?.price) || !nonnegative(text?.output?.price)) return false
  const cache = text.input?.cache
  if (cache === undefined) return true
  if (!object(cache) || (cache.read !== undefined && !nonnegative(cache.read))) return false
  return cache.write === undefined || nonnegative(cache.write) ||
    (object(cache.write) && Object.keys(cache.write).length > 0 && Object.values(cache.write).every(nonnegative))
}

function applyOverrides(models, remote, spec) {
  const config = remote?.providers?.[spec.upstream]
  for (const id of Object.keys(models)) {
    const model = config?.models?.[id]
    if (config?.disabled === true || config?.enabled === false || model?.disabled === true || model?.enabled === false) delete models[id]
  }
  return models
}

export function buildModels(rows, mode, remote) {
  const spec = specs[mode]
  const models = Object.create(null)
  for (const row of rows) {
    if (!object(row) || typeof row.id !== "string" || !row.id.trim() || /[\u0000-\u001f\u007f]/.test(row.id) || row.type !== "chat" || row.deprecated || ["disabled", "retired", "deprecated"].includes(row.status)) continue
    if (!usableCatalogRow(row)) continue
    const text = row.cost?.text
    // Console's free tier is restricted to OpenCode. Go has its own catalog.
    if (mode === "console" && (/-free(?:$|-)/i.test(row.id) || (text?.input?.price === 0 && text?.output?.price === 0))) continue
    let protocol, url
    for (const [candidate, api] of Object.entries(object(row.api) ? row.api : {})) {
      if (!Object.hasOwn(SDK, candidate) || typeof api?.base_url !== "string" || api.base_url.includes("%")) continue
      try {
        const parsed = allowedURL(api.base_url, spec, true)
        if (parsed.pathname.includes("%") || parsed.search || parsed.hash) continue
        protocol = candidate
        url = parsed.href.replace(/\/$/, "")
        break
      } catch { continue }
    }
    if (!url) continue
    models[row.id] = {
      id: row.id, providerID: spec.id, name: typeof row.name === "string" && row.name.trim() ? row.name : row.id,
      ...(mode === "go" && text.input.price === 0 && text.output.price === 0 ? { free: true } : {}),
      api: { id: row.id, url, npm: SDK[protocol] },
      limit: { context: row.limit?.context ?? 0, output: row.limit?.output ?? 0, ...(row.limit?.input ? { input: row.limit.input } : {}) },
      capabilities: {
        temperature: row.capabilities?.temperature === true,
        reasoning: row.capabilities?.reasoning?.supported === true,
        toolcall: row.capabilities?.tools?.supported === true,
        attachment: (Array.isArray(row.modalities?.input) ? row.modalities.input : []).some((m) => typeof m === "string" && m !== "text"),
        input: modalities(row.modalities?.input), output: modalities(row.modalities?.output), interleaved: false,
      },
      cost: { input: text?.input?.price ?? 0, output: text?.output?.price ?? 0, cache: { read: text?.input?.cache?.read ?? 0, ...(typeof text?.input?.cache?.write === "number" ? { write: text.input.cache.write } : {}) } },
      options: {}, headers: {}, variants: {},
    }
  }
  return applyOverrides(models, remote, spec)
}

export function usageWindows(go, budgets = [], upstream = "opencode-go", mode = "go", freeModels = []) {
  const windows = []
  for (const [key, name, span] of [["rolling", "5 hours", 18000], ["weekly", "7 days", 604800], ["monthly", "Monthly", undefined]]) {
    const m = go?.usage?.[key]
    if (!validMeter(m)) continue
    const raw = Math.max(0, m.percent)
    const used = m.status === "rate-limited" ? Math.max(100, raw) : raw
    windows.push({ name, used, ...(freeModels.length ? { notModels: [...freeModels] } : {}), ...(used !== raw ? { display: `Rate limited · ${raw}% reported` } : {}), ...(m.resetsAt ? { resetsAt: m.resetsAt } : {}), ...(span ? { span } : {}) })
  }
  for (const b of budgets) {
    if (invalidBudget(b)) continue
    const filtered = (Array.isArray(b.vendors) && b.vendors.length > 0) || b.inputPriceAtLeast !== undefined
    const models = Array.isArray(b.models) ? b.models : []
    const matching = models.length > 0 && models.every((m) => object(m) && m.providerID === upstream && typeof m.modelID === "string" && m.modelID)
    const perModel = b.per === "model"
    const canSplit = perModel && b.coverage === "models" && matching && models.every((m) => Number.isFinite(m.spentDollars)) && !filtered
    const name = b.scope === "combined" || b.shared === true ? "Shared budget" : "Member budget"
    const window = (amount, suffix, extra = {}) => ({
      name: suffix ? `${name} · ${suffix}` : name, amount, limit: b.limitDollars, unit: "USD",
      used: b.limitDollars > 0 ? Math.max(0, amount / b.limitDollars * 100) : 100,
      ...(b.resetsAt ? { resetsAt: b.resetsAt } : {}), ...extra,
    })
    if (mode !== "go" && canSplit) {
      for (const m of models) windows.push(window(m.spentDollars, m.name || m.modelID, { models: [m.modelID] }))
      continue
    }
    const setModels = !perModel && b.coverage === "models" && matching && !filtered && models.every((m) => m.spentDollars === undefined)
    const all = !perModel && b.coverage === "all" && !filtered
    const aside = mode === "go" || (!setModels && !all)
    windows.push(window(b.spentDollars, undefined, { ...(setModels && !aside ? { models: models.map((m) => m.modelID) } : {}), ...(aside ? { aside: true } : {}) }))
  }
  return windows
}

export function makePlugin(mode, input = {}) {
  const spec = specs[mode]
  const current = async (getAuth) => {
    const stored = await getAuth()
    const auth = requireAuth(input.magpie ? stored : restoreWorkspace(stored))
    // Magpie refreshes and persists tokens in the selected account's scope.
    // Other hosts do not expose an atomic account-scoped credential save.
    if (Number.isFinite(auth.expires) && auth.expires > 0 && auth.expires <= Date.now()) {
      if (input.magpie) throw Object.assign(new Error("OpenCode session renewal pending; retry shortly."), { signIn: "kept" })
      throw expired()
    }
    return auth
  }
  const workspaceFreeModels = new Map()
  const bootstrap = buildModels(JSON.parse(readFileSync(new URL(`./catalog/${mode}.json`, import.meta.url), "utf8")).data, mode)
  const bootstrapFreeModels = Object.values(bootstrap).filter((m) => m.free).map((m) => m.id)
  return {
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider[spec.id] ??= {
        name: spec.name, npm: "@ai-sdk/openai-compatible", api: `${ORIGIN}${spec.root}/openai/v1`,
        models: Object.fromEntries(Object.entries(bootstrap).map(([id, m]) => [id, {
          name: m.name, provider: { api: m.api.url, npm: m.api.npm }, limit: m.limit,
          ...(m.free ? { free: true } : {}),
          reasoning: m.capabilities.reasoning, tool_call: m.capabilities.toolcall,
          modalities: { input: KINDS.filter((k) => m.capabilities.input[k]), output: KINDS.filter((k) => m.capabilities.output[k]) },
        }])),
      }
    },
    auth: {
      provider: spec.id,
      icon: ICON,
      refresh: refreshAuth,
      rotating: true,
      methods: [{
        type: "oauth", label: "Sign in with OpenCode",
        async authorize(_inputs, { signal } = {}) {
          const device = await startDevice({ signal })
          return {
            method: "auto", url: device.url,
            instructions: `Sign in and select a workspace on OpenCode. Check code: ${device.user_code}`,
            async callback(_code, { signal: callbackSignal } = {}) {
              try {
                const result = await finishDevice(device, { signal: callbackSignal ?? signal })
                if (!input.magpie) result.accountId = ACCOUNT_TAG + Buffer.from(result.metadata.orgID).toString("base64url")
                return result
              }
              catch (e) { return { type: "failed", error: e.message } }
            },
          }
        },
      }],
      async loader(getAuth) {
        return {
          apiKey: "opencode-oauth-placeholder",
          async fetch(input, init) {
            const request = new Request(input, init)
            allowedURL(request.url, spec)
            const auth = await current(getAuth)
            const headers = new Headers(request.headers)
            headers.set("authorization", `Bearer ${auth.access}`)
            headers.set("x-opencode-org-id", auth.metadata.orgID)
            headers.set("user-agent", AGENT)
            headers.delete("cookie")
            headers.delete("x-org-id")
            headers.delete("x-api-key")
            headers.delete("x-goog-api-key")
            // Magpie's model test is one independent request and has no chat
            // session. Give it its own ID; real conversations keep their ID.
            const session = headers.get("x-opencode-session") || headers.get("x-magpie-session") || `magpie-${randomUUID()}`
            headers.set("x-opencode-session", session)
            return fetch(request, { headers, redirect: "error" })
          },
        }
      },
      async usage(getAuth, _context, { signal } = {}) {
        signal?.throwIfAborted()
        const auth = await current(getAuth)
        signal?.throwIfAborted()
        const results = await Promise.allSettled([
          mode === "go" ? json(`${ORIGIN}/zen/go/v1/usage`, { auth, inference: true, optional: true, signal }) : Promise.resolve(undefined),
          json(`${CONSOLE}/api/policies/current-budgets`, { auth, optional: true, signal }),
        ])
        signal?.throwIfAborted()
        const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason)
        const go = results[0].status === "fulfilled" ? results[0].value : undefined
        const budgetValue = results[1].status === "fulfilled" ? results[1].value : undefined
        const budgets = Array.isArray(budgetValue) ? budgetValue : []
        if (results[1].status === "fulfilled" && budgetValue === undefined) errors.push(new Error("当前工作区无法读取 Console 预算。"))
        if (budgetValue !== undefined && (!Array.isArray(budgetValue) || budgets.some(invalidBudget))) errors.push(new Error("OpenCode 预算信息格式无效。"))
        if (go !== undefined && invalidGoUsage(go)) errors.push(new Error("OpenCode Go 额度信息格式无效。"))
        const freeModels = mode === "go" ? (workspaceFreeModels.get(auth.metadata.orgID) ?? bootstrapFreeModels) : []
        const windows = usageWindows(go, budgets, spec.upstream, mode, freeModels)
        if (mode === "go" && !go && results[0].status === "fulfilled") errors.push(new Error("当前工作区没有可读取的 Go 订阅额度。"))
        const authenticatedRead = (mode === "go" && go !== undefined) || budgetValue !== undefined
        const signIn = errors.some((e) => e.signIn === "expired") && !authenticatedRead ? "expired" : "kept"
        const message = errors.map((e) => e.message).join("；")
        if (errors.length && windows.length) windows.push({ name: "Usage notice", display: message, aside: true })
        return {
          user: `${auth.metadata.email} · ${auth.metadata.orgName}`,
          plan: mode === "go" ? "OpenCode Go" : "OpenCode Console",
          windows,
          ...(errors.length ? { ...(!windows.length ? { error: message } : {}), signIn } : {}),
        }
      },
    },
    provider: {
      id: spec.id,
      async models(provider, { auth, signal } = {}) {
        if (auth?.type !== "oauth") return provider.models
        auth = await current(async () => auth)
        const [catalog, remote] = await Promise.all([
          json(`${ORIGIN}${spec.root}/v1/models`, { signal }),
          json(`${CONSOLE}/api/v2/config`, { auth, signal }),
        ])
        if (!Array.isArray(catalog?.data)) throw new Error("OpenCode 模型列表格式不完整。")
        // A transient empty public catalog must not replace the last good list.
        // Magpie preserves its cached models when the discovery hook fails.
        if (!catalog.data.length) throw new Error("OpenCode 暂时返回空模型目录，保留已有列表。")
        validateConfig(remote, spec)
        const models = buildModels(catalog.data, mode)
        if (!Object.keys(models).length) throw new Error("OpenCode 模型目录格式无效，保留已有列表。")
        const configured = applyOverrides(models, remote, spec)
        if (mode === "go") {
          workspaceFreeModels.delete(auth.metadata.orgID)
          workspaceFreeModels.set(auth.metadata.orgID, Object.values(configured).filter((m) => m.free).map((m) => m.id))
          if (workspaceFreeModels.size > 32) workspaceFreeModels.delete(workspaceFreeModels.keys().next().value)
        }
        return configured
      },
    },
    async "chat.headers"(input, output) {
      if (input.model.providerID === spec.id && input.sessionID) output.headers["x-opencode-session"] = input.sessionID
    },
  }
}
