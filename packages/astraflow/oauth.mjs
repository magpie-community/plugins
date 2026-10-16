import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { projectPage, keyPage, noticePage } from "./oauth-page.mjs"

// Public desktop-client credentials shipped by ucloud/astraflow-cli.
// These identify the application; they are not the user's inference key.
const CLIENT_ID = "kGsiLX8UJCf34BPOXtzn"
const CLIENT_SECRET = "RJSTS3P6FkwQW5oCIP9QEtgetTWMrARYrESyAAZz"
const ISSUERS = {
  ucloud: { oauth: "https://oauth2.ucloud.cn", api: "https://api.ucloud.cn/" },
  "ucloud-global": { oauth: "https://oauth2.ucloud-global.com", api: "https://api.ucloud-global.com/" },
}
export const LEAD = 300_000
const TIMEOUT = 300_000
const text = (v) => typeof v === "string" ? v.trim() : ""
const rows = (v) => Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []
const truthy = (v) => [true, 1, "1", "true"].includes(v)

function pageHeaders(res, nonce) {
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.setHeader("Cache-Control", "no-store")
  // Keep callback query secrets out of Referer without making a same-origin
  // browser form's Origin opaque ("null"), which no-referrer can do.
  res.setHeader("Referrer-Policy", "strict-origin")
  res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`)
}

function site(issuer) {
  if (!Object.hasOwn(ISSUERS, issuer)) throw new Error("AstraFlow: choose UCloud China or UCloud Global")
  return ISSUERS[issuer]
}

function failure(message, secrets = [], expired = false) {
  for (const secret of secrets) if (secret) message = message.split(secret).join("[redacted]")
  const e = new Error(`AstraFlow: ${message.slice(0, 500)}`)
  if (expired) e.signIn = "expired"
  return e
}

async function json(url, options, secrets) {
  let response, body
  try {
    response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(20_000) })
    body = await response.json()
  } catch (e) {
    throw failure(`UCloud request failed: ${e?.message ?? e}`, secrets)
  }
  if (!response.ok || body?.error || (body?.RetCode !== undefined && body.RetCode !== 0)) {
    throw failure(`UCloud HTTP ${response.status}: ${body?.error_description ?? body?.Message ?? body?.error ?? "request rejected"}`,
      secrets, response.status === 401 || body?.error === "invalid_grant")
  }
  return body
}

function identity(idToken) {
  // The ID token is only a display hint. API authorization uses UCloud's
  // access token; no identity claim decoded here grants any permission.
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString())
    return { ...(text(claims.email) ? { email: text(claims.email) } : {}), ...(text(claims.sub) ? { uid: text(claims.sub) } : {}) }
  } catch { return {} }
}

async function token(issuer, params, previous = {}) {
  const body = await json(site(issuer).oauth + "/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  }, [params.code, params.refresh_token, CLIENT_SECRET, previous.access])
  if (!text(body?.access_token) || /[\r\n]/.test(body.access_token)) throw failure("OAuth returned no valid access token")
  if (body.token_type && !/^Bearer$/i.test(body.token_type)) throw failure("OAuth returned an unsupported token type")
  const seconds = Number(body.expires_in)
  const expires = Date.now() + seconds * 1000
  if (body.expires_in !== undefined && (!Number.isFinite(expires) || seconds <= 0)) throw failure("OAuth returned an invalid token expiry")
  return {
    access: body.access_token,
    refresh: text(body.refresh_token) || previous.refresh || "",
    expires: body.expires_in === undefined ? 0 : expires,
    ...identity(body.id_token),
  }
}

export async function control(auth, action, params = {}) {
  if (!text(auth?.access) || /[\r\n]/.test(auth.access)) throw failure("not signed in to UCloud")
  const body = await json(site(auth.issuer).api, {
    method: "POST", headers: { Authorization: `Bearer ${auth.access}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...params, Action: action }),
  }, [auth.access, auth.refresh, auth.inferenceKey])
  if (body?.RetCode !== 0) throw failure(`${action} returned no successful RetCode`)
  return body
}

export async function projects(auth) {
  const data = await control(auth, "GetProjectList")
  const result = rows(data.ProjectSet).filter((p) => text(p?.ProjectId)).map((p) => ({ id: p.ProjectId, name: text(p.ProjectName) || p.ProjectId, default: truthy(p.IsDefault) }))
  if (!result.length) throw failure("UCloud account has no accessible projects")
  return result
}

function keyOf(row) {
  if (!text(row?.KeyId) || !text(row.Key) || /\s|[\x00-\x1f\x7f]/.test(row.Key.trim())) return null
  if ((row.Status !== undefined && Number(row.Status) !== 1) || Number(row.ModelverseDisabled) === 1) return null
  // ExpireTime is Unix seconds; -1 means no expiry. Some replies omit it
  // or use zero, so only a declared timestamp can prove the key expired.
  if (row.ExpireTime !== undefined && row.ExpireTime !== null && row.ExpireTime !== "") {
    const expiry = Number(row.ExpireTime)
    if (!["number", "string"].includes(typeof row.ExpireTime) || !Number.isFinite(expiry) ||
      (expiry !== -1 && expiry !== 0 && expiry <= Date.now() / 1000)) return null
  }
  return { id: row.KeyId, name: text(row.Name) || row.KeyId, key: row.Key.trim() }
}

export async function keys(auth, projectId) {
  const result = new Map()
  // Respect the control plane's pagination, including disabled entries.
  for (let offset = 0; offset < 10_000; offset += 100) {
    const data = await control(auth, "ListUMInferAPIKey", { ProjectId: projectId, Offset: offset, Limit: 100 })
    const page = rows(data.Data)
    for (const row of page) { const key = keyOf(row); if (key) result.set(key.id, key) }
    if (page.length < 100) return [...result.values()]
  }
  throw failure("too many API keys; choose a smaller project")
}

async function createKey(auth, projectId, name) {
  name = text(name)
  if (!name || name.length > 64) throw failure("new API key name must contain 1–64 characters")
  const data = await control(auth, "CreateUMInferAPIKey", {
    ProjectId: projectId, Name: name, ModelverseDisabled: 0, SandBoxDisabled: 1, GrantAllModels: true,
  })
  const key = keyOf(data.Data)
  if (!key) throw failure("UCloud returned no usable new API key")
  return key
}

function success(auth, inputs, project, key) {
  return {
    type: "success", ...auth, issuer: inputs.issuer,
    inferenceKey: key.key, projectId: project.id, projectName: project.name, keyId: key.id, keyName: key.name,
    accountId: `${auth.email || auth.uid || inputs.issuer} / ${project.name} / ${key.name}`,
    metadata: { region: inputs.region, protocol: inputs.protocol || "chat" },
  }
}

export function callbackCode(value, redirect, state) {
  let url
  try { url = new URL(value) } catch { throw failure("paste the complete OAuth callback URL, including state") }
  const expected = new URL(redirect)
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.searchParams.get("state") !== state) throw failure("OAuth callback URL or state does not match this sign-in")
  if (url.searchParams.has("error")) throw failure(`OAuth authorization rejected: ${url.searchParams.get("error")}`)
  const code = url.searchParams.get("code")
  if (!text(code)) throw failure("OAuth callback has no authorization code")
  return code
}

function authorization(issuer, redirect, state) {
  const url = new URL(site(issuer).oauth + "/authorize")
  url.search = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: redirect, response_type: "code", scope: "openid email offline_access full_access", state }).toString()
  return url.href
}

// Renewals are shared only inside one plugin instance and for the exact old
// token pair. Keep a brief completed result so host/store races cannot reuse
// a refresh token after UCloud rotated it.
export function refresher(client) {
  const pending = new Map()
  const latest = new Map()
  const cacheKey = (a) => JSON.stringify([a.issuer, a.access, a.refresh])
  async function refresh(auth) {
    if (auth?.type !== "oauth") return undefined
    const id = cacheKey(auth)
    const cached = latest.get(id)
    if (cached && cached.until > Date.now()) return cached.patch
    if (!auth.refresh) throw failure("OAuth has no refresh token; sign in again", [], true)
    if (!pending.has(id)) {
      const job = token(auth.issuer, { grant_type: "refresh_token", refresh_token: auth.refresh }, auth).then((patch) => {
        for (const [k, v] of latest) if (v.until <= Date.now()) latest.delete(k)
        if (latest.size >= 100) latest.delete(latest.keys().next().value)
        latest.set(id, { patch, until: Date.now() + 60_000 })
        return patch
      }).finally(() => pending.delete(id))
      pending.set(id, job)
    }
    return pending.get(id)
  }
  async function fresh(getAuth) {
    const auth = await getAuth()
    if (auth?.type !== "oauth" || !auth.expires || auth.expires > Date.now() + LEAD) return auth
    const before = JSON.stringify(auth)
    try {
      const patch = await refresh(auth)
      // getAuth is live in loader/usage. A sign-out, new sign-in or another
      // renewal during the network request takes precedence over this one.
      const current = await getAuth()
      if (JSON.stringify(current) !== before) return current
      const updated = { ...current, ...patch }
      if (!client?.auth?.set) throw failure("host cannot persist refreshed OAuth credentials")
      await client.auth.set({ path: { id: "astraflow" }, body: updated })
      return updated
    } catch (e) {
      const current = await getAuth()
      if (JSON.stringify(current) !== before) return current
      if (e.signIn === "expired" || auth.expires <= Date.now()) throw e
      // Transient refresh failure: the existing token is still valid.
      return auth
    }
  }
  return { refresh, fresh }
}

export async function manualAuthorize(inputs) {
  site(inputs.issuer)
  const state = randomBytes(24).toString("hex")
  // Reserve the callback port during the flow, as the official CLI does.
  // A manual host may be remote: it receives the full URL pasted by the user.
  const nonce = randomBytes(16).toString("base64")
  const server = createServer((_req, res) => {
    pageHeaders(res, nonce)
    res.end(noticePage("manual", "UCloud 已返回授权结果。请将完整回调地址粘贴到 Magpie，继续完成登录。", nonce))
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  server.unref()
  const redirect = `http://localhost:${server.address().port}/authorization`
  const expires = Date.now() + TIMEOUT
  const timer = setTimeout(() => server.close(), TIMEOUT)
  timer.unref()
  let used = false
  return {
    url: authorization(inputs.issuer, redirect, state), method: "code",
    instructions: "Sign in to UCloud, then paste the complete localhost callback URL here (including code and state).",
    async callback(value) {
      try {
        if (used || Date.now() > expires) throw failure("OAuth sign-in expired or already completed")
        const code = callbackCode(value, redirect, state)
        used = true
        const auth = { ...await token(inputs.issuer, { grant_type: "authorization_code", code, redirect_uri: redirect }), issuer: inputs.issuer }
        const list = await projects(auth)
        const project = inputs.projectId ? list.find((p) => p.id === inputs.projectId) : list.find((p) => p.default) || list[0]
        if (!project) throw failure("selected project is not accessible")
        let key
        if (inputs.keyMode === "create") key = await createKey(auth, project.id, inputs.keyName)
        else {
          const list = await keys(auth, project.id)
          key = inputs.keyId ? list.find((k) => k.id === inputs.keyId) : list.length === 1 ? list[0] : undefined
          if (!key) throw failure("choose an enabled API key ID, or use browser sign-in to select from the list")
        }
        return success(auth, inputs, project, key)
      } catch (e) { return { type: "failed", error: e.message } }
      finally { clearTimeout(timer); server.close() }
    },
  }
}

export async function browserAuthorize(inputs) {
  site(inputs.issuer)
  const state = randomBytes(24).toString("hex")
  let resolve, auth, project, available = [], projectsList = [], phase = "oauth", timer, busy = false
  const result = new Promise((done) => { resolve = done })
  const finish = (value) => { if (phase === "done") return; phase = "done"; clearTimeout(timer); resolve(value); server.close() }
  const nonce = randomBytes(16).toString("base64")
  const server = createServer(async (req, res) => {
    pageHeaders(res, nonce)
    const host = req.headers.host
    if (host !== `localhost:${server.address().port}` && host !== `127.0.0.1:${server.address().port}`) { res.writeHead(400); res.end(); return }
    if (busy || phase === "done") { res.writeHead(409); res.end(noticePage("busy", "登录正在处理中或已经完成。", nonce)); return }
    let taken = false
    try {
      const url = new URL(req.url, redirect)
      if (req.method === "GET" && url.pathname === "/authorization" && phase === "oauth") {
        const code = callbackCode(url.href, redirect, state)
        busy = taken = true
        // Consume the code only once, even when a control-plane read fails.
        phase = "exchanging"
        auth = { ...await token(inputs.issuer, { grant_type: "authorization_code", code, redirect_uri: redirect }), issuer: inputs.issuer }
        projectsList = await projects(auth)
        phase = "project"
        res.end(projectPage(projectsList, state, nonce))
      } else if (req.method === "POST" && url.pathname === "/select" && ["project", "key"].includes(phase)) {
        const origin = req.headers.origin
        if (origin && origin !== new URL(redirect).origin) throw failure("invalid sign-in form origin")
        let body = ""
        for await (const chunk of req) { body += chunk; if (body.length > 8192) throw failure("sign-in form is too large") }
        const params = new URLSearchParams(body)
        if (params.get("state") !== state) throw failure("invalid sign-in form state")
        busy = taken = true
        if (phase === "project") {
          project = projectsList.find((p) => p.id === params.get("project"))
          if (!project) throw failure("selected project is not accessible")
          available = await keys(auth, project.id)
          phase = "key"
          res.end(keyPage(project, available, state, nonce))
        } else {
          const mode = params.get("mode")
          if (mode === "back") {
            phase = "project"
            res.end(projectPage(projectsList, state, nonce, project.id))
            return
          }
          if (!["create", "existing"].includes(mode)) throw failure("choose an existing key or explicitly create a new one")
          // A listed key can be revoked, expired or rotated while the user
          // chooses it. Validate the choice and read its current value again.
          if (mode === "existing" && !available.some((k) => k.id === params.get("key"))) throw failure("choose an enabled API key")
          const key = mode === "create" ? await createKey(auth, project.id, params.get("name")) :
            (await keys(auth, project.id)).find((k) => k.id === params.get("key"))
          if (!key) throw failure("choose an enabled API key")
          res.end(noticePage("success", "授权已完成，正在将登录结果交给本地 Magpie。", nonce))
          finish(success(auth, inputs, project, key))
        }
      } else { res.writeHead(404); res.end(noticePage("missing", "请使用 Magpie 提供的授权链接打开此页面。", nonce)) }
    } catch (e) {
      res.writeHead(400)
      res.end(noticePage("error", e.message, nonce))
      if (taken) finish({ type: "failed", error: e.message })
    } finally { if (taken) busy = false }
  })
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done) })
  server.unref()
  const redirect = `http://localhost:${server.address().port}/authorization`
  timer = setTimeout(() => finish({ type: "failed", error: "AstraFlow: browser sign-in timed out" }), TIMEOUT)
  timer.unref()
  return {
    url: authorization(inputs.issuer, redirect, state), method: "auto",
    instructions: "Sign in to UCloud in this browser, select a project and an existing ModelVerse key, or explicitly create one. This finishes automatically. For a remote host use the manual callback method.",
    callback: () => result,
  }
}

export const _internal = { ISSUERS, keyOf, identity, failure, createKey, success }
