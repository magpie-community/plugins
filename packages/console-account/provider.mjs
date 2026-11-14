import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"

const ORIGIN = "https://opencode.ai"
const CONSOLE = `${ORIGIN}/console`
// Public device client used by the official OpenCode client. This is a local,
// unofficial adapter; it identifies itself independently in User-Agent.
const CLIENT = "opencode-cli"
const ICON = `data:image/svg+xml;base64,${readFileSync(new URL("./assets/opencode.svg", import.meta.url)).toString("base64")}`
const AGENT = "magpie-opencode-console-account/0.1.3"
const SDK = {
  "chat-completions": "@ai-sdk/openai-compatible",
  responses: "@ai-sdk/openai",
  messages: "@ai-sdk/anthropic",
  "generate-content": "@ai-sdk/google",
}
const KINDS = ["text", "image", "audio", "video", "pdf"]
const specs = {
  go: { id: "opencode-go-account", upstream: "opencode-go", name: "OpenCode Go · 账号登录", root: "/inference/go" },
  console: { id: "opencode-console-account", upstream: "opencode", name: "OpenCode Console · 账号登录", root: "/inference" },
}

function expired(message = "OpenCode 登录已失效，请重新登录。") {
  return Object.assign(new Error(message), { signIn: "expired" })
}

function requireAuth(auth) {
  if (auth?.type !== "oauth" || !auth.access || !auth.metadata?.orgID) throw expired()
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
  const result = await response.json()
  if (!response.ok && (!result?.error || typeof result.error !== "string")) {
    throw new Error(`OpenCode 授权失败（HTTP ${response.status}）`)
  }
  return result
}

async function token(body, signal) {
  return json(`${CONSOLE}/auth/device/token`, { body: { client_id: CLIENT, ...body }, signal, pending: true })
}

function tokenFields(t, previous) {
  if (typeof t?.access_token !== "string" || !t.access_token ||
      typeof t.refresh_token !== "string" || !t.refresh_token ||
      !Number.isFinite(t.expires_in) || t.expires_in <= 0) throw new Error("OpenCode 返回的 Token 格式不完整。")
  const metadata = { ...previous }
  if (typeof t.org_id === "string" && t.org_id !== metadata.orgID) {
    metadata.orgID = t.org_id
    metadata.orgName = t.org_id
  }
  return { access: t.access_token, refresh: t.refresh_token, expires: Date.now() + t.expires_in * 1000, metadata }
}

export async function startDevice({ signal } = {}) {
  const d = await json(`${CONSOLE}/auth/device/code`, {
    body: { client_id: CLIENT, supports_org_scope: true }, signal,
  })
  if (!d?.device_code || !d.user_code || !d.verification_uri_complete ||
      !Number.isFinite(d.expires_in) || d.expires_in <= 0) throw new Error("OpenCode 返回的设备码格式不完整。")
  const url = new URL(d.verification_uri_complete, `${CONSOLE}/`)
  if (url.origin !== ORIGIN || !url.pathname.startsWith("/console/")) throw new Error("OpenCode 返回了意外的授权地址。")
  return { ...d, url: url.href, deadline: Date.now() + d.expires_in * 1000 }
}

export async function finishDevice(device, { signal, sleep = delay } = {}) {
  let interval = Math.max(1, Number(device.interval) || 5) * 1000
  while (Date.now() < device.deadline) {
    await sleep(Math.min(interval, 60000, Math.max(0, device.deadline - Date.now())), undefined, { signal })
    if (Date.now() >= device.deadline) break
    const t = await token({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code }, signal)
    if (t.error === "authorization_pending") continue
    if (t.error === "slow_down") { interval += 5000; continue }
    if (t.error) throw new Error("OpenCode 授权未完成，可能已拒绝或过期，请重新登录。")
    const fields = tokenFields(t)
    // A workspace is selected on OpenCode's own authorization page.
    const headers = { authorization: `Bearer ${fields.access}`, "user-agent": AGENT, accept: "application/json" }
    const get = async (path) => {
      const r = await fetch(`${CONSOLE}${path}`, {
        headers, redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      })
      if (!r.ok) { await r.body?.cancel(); throw new Error(`OpenCode 账户查询返回 HTTP ${r.status}`) }
      return r.json()
    }
    const [user, orgs] = await Promise.all([get("/api/user"), get("/api/orgs")])
    if (!user?.id || !user.email || !Array.isArray(orgs)) throw new Error("OpenCode 账户信息不完整。")
    const org = t.org_id == null
      ? [...orgs].sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)))[0]
      : orgs.find((o) => o.id === t.org_id)
    if (!org?.id) throw new Error("未找到授权的 OpenCode 工作区。")
    return {
      type: "success", ...fields,
      metadata: { accountID: user.id, email: user.email, orgID: org.id, orgName: org.name, server: CONSOLE },
    }
  }
  throw new Error("OpenCode 设备码已过期，请重新登录。")
}

export async function refreshAuth(auth) {
  requireAuth(auth)
  const t = await token({ grant_type: "refresh_token", refresh_token: auth.refresh })
  if (t.error === "invalid_grant") throw expired()
  if (t.error) throw new Error("OpenCode 暂时无法刷新登录。")
  return tokenFields(t, auth.metadata)
}

function modalities(values) {
  return Object.fromEntries(KINDS.map((kind) => [kind, (values ?? ["text"]).some((v) =>
    v === kind || v.startsWith(`${kind}/`) || (kind === "pdf" && v === "application/pdf"))]))
}

function allowedURL(value, spec) {
  const url = new URL(value)
  const root = `${spec.root}/`
  if (url.origin !== ORIGIN || url.username || url.password || !url.pathname.startsWith(root) ||
      (spec === specs.console && url.pathname.startsWith("/inference/go/"))) {
    throw new Error("拒绝向 OpenCode 官方接口以外的地址发送账户 Token。")
  }
  return url
}

export function buildModels(rows, mode, remote) {
  const spec = specs[mode]
  const providerConfig = remote?.providers?.[spec.upstream]
  const models = Object.create(null)
  for (const row of rows) {
    if (!row?.id || row.type !== "chat" || row.deprecated || ["disabled", "retired", "deprecated"].includes(row.status)) continue
    // Console config overlays the official catalog. In particular, models: {}
    // means no overrides; it is not a complete list of allowed models.
    const modelConfig = providerConfig?.models?.[row.id]
    if (providerConfig?.disabled === true || providerConfig?.enabled === false ||
        modelConfig?.disabled === true || modelConfig?.enabled === false) continue
    const text = row.cost?.text
    // Console's free tier is restricted to OpenCode. Go has its own catalog.
    if (mode === "console" && (/-free(?:$|-)/i.test(row.id) || (text?.input?.price === 0 && text?.output?.price === 0))) continue
    const [protocol, api] = Object.entries(row.api ?? {}).find(([p]) => Object.hasOwn(SDK, p)) ?? []
    if (!api?.base_url) continue
    const url = allowedURL(api.base_url, spec).href.replace(/\/$/, "")
    models[row.id] = {
      id: row.id, providerID: spec.id, name: row.name ?? row.id,
      api: { id: row.id, url, npm: SDK[protocol] },
      limit: { context: row.limit?.context ?? 0, output: row.limit?.output ?? 0, ...(row.limit?.input ? { input: row.limit.input } : {}) },
      capabilities: {
        temperature: row.capabilities?.temperature === true,
        reasoning: row.capabilities?.reasoning?.supported === true,
        toolcall: row.capabilities?.tools?.supported === true,
        attachment: (row.modalities?.input ?? []).some((m) => m !== "text"),
        input: modalities(row.modalities?.input), output: modalities(row.modalities?.output), interleaved: false,
      },
      cost: { input: text?.input?.price ?? 0, output: text?.output?.price ?? 0, cache: { read: text?.input?.cache?.read ?? 0, write: typeof text?.input?.cache?.write === "number" ? text.input.cache.write : 0 } },
      options: {}, headers: {}, variants: {},
    }
  }
  return models
}

export function usageWindows(go, budgets = []) {
  const windows = []
  for (const [key, name, span] of [["rolling", "5 小时", 18000], ["weekly", "每周", 604800], ["monthly", "每月", undefined]]) {
    const m = go?.usage?.[key]
    if (!Number.isFinite(m?.percent)) continue
    windows.push({ name, used: Math.max(0, m.percent), ...(m.resetsAt ? { resetsAt: m.resetsAt } : {}), ...(span ? { span } : {}) })
  }
  for (const b of budgets) {
    if (!Number.isFinite(b.limitDollars) || !Number.isFinite(b.spentDollars)) continue
    const specific = b.coverage === "models" && Array.isArray(b.models) && b.models.length > 0
    // Vendor and price filters cannot be represented faithfully by Magpie's
    // model selector: show them without applying them to every model's routing.
    const unsupported = !specific && b.coverage !== "all"
    windows.push({
      name: `预算 · ${b.ruleID}`, amount: b.spentDollars, limit: b.limitDollars, unit: "USD",
      used: b.limitDollars > 0 ? Math.max(0, b.spentDollars / b.limitDollars * 100) : 100,
      ...(b.resetsAt ? { resetsAt: b.resetsAt } : {}),
      ...(specific ? { models: b.models.map((m) => m.modelID) } : {}),
      ...(unsupported ? { aside: true } : {}),
    })
  }
  return windows
}

export function makePlugin(mode, input = {}) {
  const spec = specs[mode]
  const renewing = new Map()
  const current = async (getAuth) => {
    const auth = requireAuth(await getAuth())
    // Magpie serializes and persists refreshes across its processes. Other
    // OpenCode hosts ignore auth.refresh, so renew through their client here.
    if (input.magpie || !Number.isFinite(auth.expires) || auth.expires <= 0 || auth.expires > Date.now() + 60000) return auth
    if (typeof input.client?.auth?.set !== "function") throw new Error("当前宿主无法保存更新后的 OpenCode 登录。")
    const key = auth.refresh
    let pending = renewing.get(key)
    if (!pending) {
      pending = (async () => {
        const next = { ...auth, ...await refreshAuth(auth) }
        await input.client.auth.set({ path: { id: spec.id }, body: next })
        return next
      })()
      renewing.set(key, pending)
    }
    try { return await pending }
    finally { if (renewing.get(key) === pending) renewing.delete(key) }
  }
  const bootstrap = buildModels(JSON.parse(readFileSync(new URL(`./catalog/${mode}.json`, import.meta.url), "utf8")).data, mode)
  return {
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider[spec.id] ??= {
        name: spec.name, npm: "@ai-sdk/openai-compatible", api: `${ORIGIN}${spec.root}/openai/v1`,
        models: Object.fromEntries(Object.entries(bootstrap).map(([id, m]) => [id, {
          name: m.name, provider: { api: m.api.url, npm: m.api.npm }, limit: m.limit,
          reasoning: m.capabilities.reasoning, tool_call: m.capabilities.toolcall,
          modalities: { input: KINDS.filter((k) => m.capabilities.input[k]), output: KINDS.filter((k) => m.capabilities.output[k]) },
        }])),
      }
    },
    auth: {
      provider: spec.id,
      icon: ICON,
      refresh: refreshAuth,
      methods: [{
        type: "oauth", label: "在浏览器登录 OpenCode 账号",
        async authorize(_inputs, { signal } = {}) {
          const device = await startDevice({ signal })
          return {
            method: "auto", url: device.url,
            instructions: `在 OpenCode 页面登录并确认工作区。核对设备码：${device.user_code}`,
            async callback(_code, { signal: callbackSignal } = {}) {
              try { return await finishDevice(device, { signal: callbackSignal ?? signal }) }
              catch (e) { return { type: "failed", error: e.message } }
            },
          }
        },
      }],
      async loader(getAuth) {
        return {
          async fetch(input, init) {
            const request = new Request(input, init)
            allowedURL(request.url, spec)
            const auth = await current(getAuth)
            const headers = new Headers(request.headers)
            headers.set("authorization", `Bearer ${auth.access}`)
            headers.set("x-opencode-org-id", auth.metadata.orgID)
            headers.set("user-agent", AGENT)
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
      async usage(getAuth) {
        const auth = await current(getAuth)
        const results = await Promise.allSettled([
          mode === "go" ? json(`${ORIGIN}/zen/go/v1/usage`, { auth, inference: true, optional: true }) : Promise.resolve(undefined),
          json(`${CONSOLE}/api/policies/current-budgets`, { auth, optional: true }),
        ])
        const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason)
        const go = results[0].status === "fulfilled" ? results[0].value : undefined
        const budgets = results[1].status === "fulfilled" && Array.isArray(results[1].value) ? results[1].value : []
        const windows = usageWindows(go, budgets)
        if (mode === "go" && !go && results[0].status === "fulfilled") errors.push(new Error("当前工作区没有可读取的 Go 订阅额度。"))
        return {
          user: `${auth.metadata.email} · ${auth.metadata.orgName}`,
          plan: mode === "go" ? "OpenCode Go" : "OpenCode Console",
          windows,
          ...(errors.length ? { error: errors.map((e) => e.message).join("；"), signIn: errors.some((e) => e.signIn === "expired") ? "expired" : "kept" } : {}),
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
        return buildModels(catalog.data, mode, remote)
      },
    },
    async "chat.headers"(input, output) {
      if (input.model.providerID === spec.id && input.sessionID) output.headers["x-opencode-session"] = input.sessionID
    },
  }
}
