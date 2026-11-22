// Native Amazon Quick account login (browser OAuth, no desktop app needed).
//
// Replays the same OIDC dance the desktop app performs at sign-in:
//
//   https://quick.aws.com/sn?qwSurface=desktop:<nonce>:<port>:<appVersion>
//     → browser login (Amazon resolves the account/tenant)
//     → GET 127.0.0.1:<port>/callback?nonce&issuerUrl&tenantUrl&idcRegion…
//     → POST oidc.<idcRegion>.amazonaws.com/client/register  (dynamic client)
//     → 302 → oidc.<idcRegion>.amazonaws.com/authorize (PKCE)
//     → GET 127.0.0.1:<port>/?code&state
//     → POST oidc.<idcRegion>.amazonaws.com/token          (code exchange)
//     → POST <tenant>/integration/quick-work/user-info
//     → session {jwt:id_token, ws_host, actor_arn, …} saved to a config file
//
// The saved session drives the chat WS directly — no outpost, no desktop app.
// Refresh uses grantType:"refresh_token" on the same OIDC token endpoint and
// is written back to the file so rotated refresh tokens survive restarts.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, fsyncSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { APP_VERSION } from './desktop.mjs'

export class OAuthError extends Error {
  constructor(message, { status, kind } = {}) {
    super(message)
    this.name = 'OAuthError'
    this.status = status
    this.kind = kind // 'auth' | 'timeout' | 'http' | 'abort'
  }
}

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

const SOCIAL_DISCOVERY = {
  prod: 'https://quick.aws.com/sn',
  beta: 'https://devtest.quicksuite.aws.dev/sn',
  integ: 'https://devtest.quicksuite.aws.dev/sn',
  dev: 'https://devtest.quicksuite.aws.dev/sn',
}
const SOCIAL_DATA_PLANE = {
  prod: 'https://cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev',
  beta: 'https://cell001.dp.appintegrations.us-west-2.beta.plato.ai.aws.dev',
  integ: 'https://cell001.dp.appintegrations.us-west-2.beta.plato.ai.aws.dev',
  dev: 'https://cell001.dp.appintegrations.us-west-2.beta.plato.ai.aws.dev',
}
const SOCIAL_SCOPES = { prod: 'quicksight:read_write', beta: 'quicksight_test:read_write', integ: 'quicksight_test:read_write', dev: 'quicksight_test:read_write' }

const b64url = (buf) => Buffer.from(buf).toString('base64url')
const rand = () => b64url(randomBytes(32))
const pkce = () => {
  const verifier = rand()
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

function decodeJwt(token) {
  try {
    const part = token.split('.')[1]
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

const oneLine = (v) => String(v ?? '').split(/\s+/).join(' ').trim()

const tenantHosts = /(?:^|\.)(?:plato\.ai\.aws\.dev|quicksuite\.aws\.dev|quick\.aws\.com|quicksight\.aws\.amazon\.com)$/i
const oidcHosts = /^oidc(?:-fips)?\.[a-z0-9-]+\.(?:amazonaws\.com(?:\.cn)?|api\.aws)$/i
const issuerHosts = /^(?:identitycenter\.amazonaws\.com|oidc(?:-fips)?\.[a-z0-9-]+\.(?:amazonaws\.com(?:\.cn)?|api\.aws))$/i

function trustedHttps(value, hosts) {
  try {
    const u = new URL(value)
    if (u.protocol === 'https:' && !u.username && !u.password && !u.port && hosts.test(u.hostname)) return u
  } catch {}
}

function tenantOrigin(value) {
  const url = trustedHttps(value, tenantHosts)
  if (!url) throw new OAuthError('unrecognized Amazon Quick tenant URL', { kind: 'auth', status: 401 })
  return url.origin
}

function oidcBase(region) {
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(region)) throw new OAuthError('invalid OIDC region', { kind: 'auth', status: 401 })
  return `https://oidc.${region}.amazonaws.com`
}

async function postJson(fetchImpl, url, body, headers = {}, signal) {
  const timeout = AbortSignal.timeout(20_000)
  const res = await fetchImpl(url, {
    method: 'POST',
    redirect: 'error',
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new OAuthError(`HTTP ${res.status} from ${new URL(url).host}`, { status: res.status, kind: 'http' })
  let parsed
  try { parsed = JSON.parse(text) } catch (e) { throw new OAuthError(`invalid JSON from ${new URL(url).host}: ${e?.message}`, { kind: 'http' }) }
  if (!parsed || typeof parsed !== 'object') throw new OAuthError(`unexpected JSON from ${new URL(url).host}`, { kind: 'http' })
  return parsed
}

function normalizeUserInfo(raw) {
  if (raw && typeof raw.userInfo === 'object') raw = raw.userInfo
  const pick = (...keys) => {
    for (const k of keys) {
      const v = raw?.[k]
      if (v != null && v !== '') return oneLine(v)
    }
    return ''
  }
  return {
    email: pick('email', 'emailAddress'),
    user_name: pick('userName', 'user_name', 'username'),
    first_name: pick('firstName', 'first_name'),
    last_name: pick('lastName', 'last_name'),
    display_name: pick('displayName', 'display_name'),
    user_arn: pick('userArn', 'user_arn'),
    quicksight_external_user_arn: pick('quicksightExternalUserArn', 'quicksight_external_user_arn'),
    role: pick('role'),
    identity_type: pick('identityType', 'identity_type'),
    aws_account_id: pick('awsAccountId', 'aws_account_id', 'accountId'),
    account_name: pick('accountName', 'account_name'),
    external_id: pick('externalId', 'external_id'),
    account_ownership: pick('accountOwnership', 'account_ownership'),
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// Result pages are a small branded card (dark glass panel + status badge) —
// kept deliberately distinct from a stock browser/system page.
const page = ({ icon, tone, title, children }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1rem;
 font-family:"Avenir Next","Segoe UI",system-ui,sans-serif;color:#e8ecf4;
 background:radial-gradient(900px 480px at 50% -12%,rgba(59,130,246,.35),transparent 65%),#0a0f1c}
.card{width:min(26rem,100%);padding:2.4rem 2rem 2rem;border-radius:1.25rem;text-align:center;
 background:rgba(17,24,39,.72);border:1px solid rgba(148,163,184,.16);
 box-shadow:0 24px 70px rgba(0,0,0,.5);backdrop-filter:blur(10px)}
.ring{width:3.4rem;height:3.4rem;margin:0 auto 1.1rem;border-radius:50%;
 display:grid;place-items:center;font-size:1.5rem;font-weight:700}
.ok{background:rgba(52,211,153,.12);color:#6ee7b7;border:1px solid rgba(52,211,153,.35)}
.bad{background:rgba(248,113,113,.12);color:#fca5a5;border:1px solid rgba(248,113,113,.35)}
.wait{background:rgba(96,165,250,.12);color:#93c5fd;border:1px solid rgba(96,165,250,.35)}
h1{font-size:1.2rem;margin:.1rem 0 .55rem;font-weight:650;letter-spacing:.01em}
.sub{color:#8b96ab;font-size:.86rem;line-height:1.55}
.acct{display:inline-block;margin:.35rem 0 .8rem;padding:.28rem .7rem;border-radius:999px;
 background:rgba(59,130,246,.12);border:1px solid rgba(96,165,250,.25);
 color:#bfdbfe;font-size:.82rem;word-break:break-all}
.err{margin-top:.4rem;padding:.6rem .8rem;border-radius:.6rem;text-align:left;
 background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.22);
 color:#fecaca;font-size:.78rem;line-height:1.45;word-break:break-word}
</style></head><body><main class="card"><div class="ring ${tone}">${icon}</div><h1>${esc(title)}</h1>${children}</main></body></html>`

const successPage = (who) => page({
  icon: '✓', tone: 'ok', title: 'Signed in to Amazon Quick',
  children: `${who ? `<span class="acct">${esc(who)}</span>` : ''}<p class="sub">Login complete — you can return to magpie now; this window is no longer needed.</p>`,
})
const failPage = (msg) => page({
  icon: '!', tone: 'bad', title: 'Sign-in did not complete',
  children: `<div class="err">${esc(msg)}</div><p class="sub">Close this window and start the login again from magpie.</p>`,
})
const waitingPage = () => page({
  icon: '…', tone: 'wait', title: 'Finish signing in',
  children: `<p class="sub">Complete the Amazon login in the tab that opened <code>quick.aws.com</code> — this page only confirms the result.</p>`,
})

// ---------------------------------------------------------------- store ----

/** Where OAuth sessions live (contains refresh tokens — keep private). */
export function defaultStoreDir() {
  const home = os.homedir()
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'magpie-aws-quick')
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'magpie-aws-quick')
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'magpie-aws-quick')
}

/**
 * JSON file store for OAuth sessions, keyed by magpie account key.
 * Persisting refresh tokens locally is required — OIDC refresh tokens can
 * rotate, so refreshed credentials must survive a magpie restart.
 */
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_BUF = new Int32Array(new SharedArrayBuffer(4))
const sleepSync = (ms) => { try { Atomics.wait(LOCK_WAIT_BUF, 0, 0, ms) } catch {} }

export function createSessionStore({ dir } = {}) {
  const d = dir || defaultStoreDir()
  const file = path.join(d, 'oauth-sessions.json')
  const read = () => {
    try {
      const db = JSON.parse(readFileSync(file, 'utf8'))
      if (!db?.accounts || typeof db.accounts !== 'object' || Array.isArray(db.accounts)) throw new Error('invalid accounts')
      return db
    } catch (e) {
      if (e.code === 'ENOENT') return { accounts: {} }
      throw new OAuthError('cannot read oauth-sessions.json; check file permissions and JSON format', { kind: 'store' })
    }
  }
  const acquireLock = (pending) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      try { return openSync(pending, 'wx', 0o600) } catch (e) {
        if (e.code !== 'EEXIST') throw e
        try {
          if (Date.now() - statSync(pending).mtimeMs > LOCK_STALE_MS) {
            unlinkSync(pending)
            continue
          }
        } catch {}
        sleepSync(50)
      }
    }
    throw new OAuthError('OAuth session save already pending; check oauth-sessions.json.pending if a previous process stopped during a save', { kind: 'store' })
  }
  const update = (change) => {
    mkdirSync(d, { recursive: true, mode: 0o700 })
    // Claim the transaction before reading so another process cannot lose an account update.
    const pending = `${file}.pending`
    let fd = acquireLock(pending)
    try {
      const db = read()
      change(db.accounts)
      writeFileSync(fd, JSON.stringify(db, null, 2) + '\n')
      try { fsyncSync(fd) } catch {}
      closeSync(fd)
      fd = undefined
      for (let i = 0; ; i++) {
        try { renameSync(pending, file); break } catch (e) {
          if (i < 3 && (e.code === 'EPERM' || e.code === 'EACCES')) { sleepSync(25); continue }
          throw e
        }
      }
    } catch (e) {
      if (fd !== undefined) { try { closeSync(fd) } catch {} }
      try { unlinkSync(pending) } catch {}
      throw e
    }
  }
  return {
    file,
    get(key) { const { accounts } = read(); return Object.hasOwn(accounts, key) ? accounts[key] : undefined },
    set: (key, sess) => update((accounts) => Object.defineProperty(accounts, key, { value: sess, enumerable: true, writable: true, configurable: true })),
    remove: (key) => update((accounts) => { delete accounts[key] }),
    list: () => Object.keys(read().accounts),
  }
}

// ------------------------------------------------------------- refresh ----

const endpointCache = new Map()

/** Resolve the OIDC token endpoint: discovery doc first, regional fallback. */
async function tokenEndpointFor(sess, fetchImpl) {
  const issuer = sess?.client?.issuer_url || sess?.issuer_url || ''
  if (trustedHttps(issuer, issuerHosts)) {
    if (!endpointCache.has(issuer)) {
      let ep = null
      try {
        const r = await fetchImpl(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
        if (r.ok) ep = trustedHttps((await r.json())?.token_endpoint, oidcHosts)?.href
      } catch {}
      if (ep) endpointCache.set(issuer, ep)
    }
    const ep = endpointCache.get(issuer)
    if (ep) return ep
  }
  const idc = sess?.client?.idc_region || sess?.region || 'us-east-1'
  return `${oidcBase(idc)}/token`
}

/** Refresh the stored OAuth session via grantType:refresh_token; mutates `sess`. */
export async function refreshSession(sess, { fetchImpl = fetch } = {}) {
  const rt = sess?.tokens?.refresh_token
  if (!rt) throw new OAuthError('stored session has no refresh_token; log in again', { status: 401, kind: 'auth' })
  const endpoint = await tokenEndpointFor(sess, fetchImpl)
  const tok = await postJson(fetchImpl, endpoint, {
    clientId: sess.client?.client_id || '',
    clientSecret: sess.client?.client_secret || '',
    grantType: 'refresh_token',
    refreshToken: rt,
  })
  const access = tok.accessToken || tok.access_token || ''
  if (!access) throw new OAuthError('refresh returned no accessToken; log in again', { status: 401, kind: 'auth' })
  const idToken = tok.idToken || tok.id_token || ''
  const expiresIn = Number(tok.expiresIn ?? tok.expires_in ?? 0)
  const claims = decodeJwt(idToken)
  const now = Math.floor(Date.now() / 1000)
  sess.tokens = {
    access_token: access,
    refresh_token: tok.refreshToken || tok.refresh_token || rt,
    id_token: idToken,
    expires_in: expiresIn,
  }
  sess.jwt = idToken || access
  sess.usable_until = expiresIn ? now + expiresIn : (Number(claims.exp) || sess.usable_until || 0)
  sess.obtained_at = now
  if (!sess.actor_arn && typeof claims.sub === 'string' && claims.sub.startsWith('arn:')) sess.actor_arn = claims.sub
  // best-effort: refresh the account descriptor too (arn/email keep thread identity stable)
  try {
    const base = trustedHttps(sess.tenant_url, tenantHosts)?.origin
    if (base) {
      const ui = normalizeUserInfo(await postJson(fetchImpl, `${base}/integration/quick-work/user-info`, {}, { Authorization: `Bearer ${access}` }))
      sess.user_info = ui
      if (ui.user_arn) sess.actor_arn = ui.user_arn
      if (ui.email) sess.email = ui.email
      if (ui.display_name) sess.display_name = ui.display_name
      if (ui.aws_account_id) sess.aws_account_id = ui.aws_account_id
      if (ui.account_name) sess.account_name = ui.account_name
    }
  } catch {}
  return sess
}

// ------------------------------------------------------------ login flow ----

async function defaultOpen(url) {
  // rundll32 does not pass the URL through cmd.exe, so `&` in the query stays
  // intact. `cmd /c start` splits on `&`.
  const args = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]]
  const child = spawn(args[0], args[1], { detached: true, stdio: 'ignore' })
  child.unref()
}

/**
 * Run the full browser OAuth login. Resolves a saved-session object shaped for
 * createSessionStore().set(key, sess).
 *
 * @param {object} p
 * @param {string}  [p.stage]       build stage (prod default)
 * @param {number}  [p.port]        callback port (default: free port)
 * @param {number}  [p.timeoutMs]   how long to wait for the browser (default 10min)
 * @param {AbortSignal} [p.signal]  cancel the wait
 * @param {Function} [p.fetchImpl]  injectable fetch (tests)
 * @param {Function} [p.openBrowser] injectable browser opener (tests; may return the URL)
 * @param {Function} [p.log]
 */
/**
 * Listen for the desktop login callback and return before the user finishes.
 * `ready` is `{ url }` once the local page is up. `result` is the raw login
 * params for buildSession(). Magpie opens `url` itself unless `openBrowser` is set.
 */
export async function startOAuthLogin({ stage = 'prod', port, timeoutMs = LOGIN_TIMEOUT_MS, signal, fetchImpl = fetch, openBrowser = null, log = () => {}, appVersion = APP_VERSION } = {}) {
  if (signal?.aborted) {
    const err = new OAuthError('login cancelled', { kind: 'abort' })
    const rejected = Promise.reject(err)
    rejected.catch(() => {})
    return { ready: rejected, result: rejected }
  }
  let resolveReady, rejectReady
  let readySettled = false
  const settleReady = (fn, arg) => {
    if (readySettled) return
    readySettled = true
    fn(arg)
  }
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const state = rand()
  const nonce = rand()
  const { verifier, challenge } = pkce()
  const scopes = SOCIAL_SCOPES[stage] || SOCIAL_SCOPES.prod

  const params = { discovery: {}, client_id: '', client_secret: '', tokens: {}, user_info: {}, tenant_url: '' }
  let listenPort = Number(port) || 0
  let redirectUri = ''
  let callbackHandled = false
  let exchanging = false

  const result = new Promise((resolve, reject) => {
    let finished = false
    const onAbort = () => done(reject, new OAuthError('login cancelled', { kind: 'abort' }))
    const done = (fn, arg) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      try { server.close() } catch {}
      try { server.closeIdleConnections?.() } catch {}
      const force = setTimeout(() => { try { server.closeAllConnections?.() } catch {} }, 1000)
      force.unref?.()
      fn(arg)
    }
    const reply = (res, status, body) => {
      const data = Buffer.from(body)
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
        Connection: 'close',
      })
      res.end(data)
    }
    const fail = (res, msg, status = 400) => {
      reply(res, status, failPage(msg))
      log(`[oauth] ${msg}`)
      done(reject, new OAuthError(msg, { kind: 'auth', status }))
    }

    const server = createServer(async (req, res) => {
      try {
        const u = new URL(req.url, `http://127.0.0.1:${listenPort}`)
        if (u.pathname === '/favicon.ico') { res.writeHead(204, { Connection: 'close' }); res.end(); return }
        if (u.pathname === '/callback') {
          const q = u.searchParams
          if (q.get('nonce') !== nonce) return fail(res, 'Discovery nonce mismatch (stale login link?)')
          if (q.get('error')) return fail(res, `Login failed: ${q.get('error')} ${q.get('error_description') || ''}`.trim())
          if (callbackHandled) { reply(res, 200, waitingPage()); return }
          const discovery = {
            issuer_url: q.get('issuerUrl') || q.get('issuer_url') || q.get('issuer') || '',
            tenant_url: q.get('tenantUrl') || q.get('tenant_url') || '',
            account: q.get('account') || '',
            idc_instance_id: q.get('idcInstanceId') || q.get('idc_instance_id') || '',
            idc_region: q.get('idcRegion') || q.get('idc_region') || '',
          }
          if (!discovery.issuer_url) return fail(res, 'discovery callback did not provide issuerUrl')
          if (discovery.tenant_url) tenantOrigin(discovery.tenant_url)
          const idcRegion = discovery.idc_region || 'us-east-1'
          const oidc = oidcBase(idcRegion)
          callbackHandled = true
          params.discovery = discovery
          params.tenant_url = discovery.tenant_url
          const client = await postJson(fetchImpl, `${oidc}/client/register`, {
            clientName: 'AmazonQuick-Desktop',
            clientType: 'public',
            scopes: [scopes],
            grantTypes: ['authorization_code', 'refresh_token'],
            redirectUris: [redirectUri],
            issuerUrl: params.discovery.issuer_url,
          }).catch((e) => { throw new OAuthError(`client registration failed: ${e?.message ?? e}`, { kind: 'http' }) })
          params.client_id = client.clientId || client.client_id || ''
          params.client_secret = client.clientSecret || client.client_secret || ''
          if (!params.client_id) return fail(res, 'client registration returned no clientId', 502)
          params.discovery.idc_region = idcRegion
          const authUrl = new URL(`${oidc}/authorize`)
          authUrl.searchParams.set('response_type', 'code')
          authUrl.searchParams.set('client_id', params.client_id)
          authUrl.searchParams.set('redirect_uri', redirectUri)
          authUrl.searchParams.set('scope', scopes)
          authUrl.searchParams.set('state', state)
          authUrl.searchParams.set('code_challenge', challenge)
          authUrl.searchParams.set('code_challenge_method', 'S256')
          res.writeHead(302, { Location: authUrl.toString(), 'Cache-Control': 'no-store', Connection: 'close' })
          res.end()
          return
        }
        if (u.pathname === '/' || u.pathname === '/index.html') {
          const q = u.searchParams
          const isCallback = q.has('code') || q.has('state') || q.has('error')
          if (!isCallback) { reply(res, 200, waitingPage()); return }
          if (q.get('error')) return fail(res, `Sign-in failed: ${q.get('error')} ${q.get('error_description') || ''}`.trim())
          if (q.get('state') !== state) return fail(res, 'OAuth state mismatch')
          const code = q.get('code')
          if (!code) return fail(res, 'OAuth callback has no code')
          if (!params.client_id) return fail(res, 'OAuth callback arrived before client registration')
          if (exchanging) { reply(res, 200, waitingPage()); return }
          exchanging = true
          const idcRegion = params.discovery.idc_region || 'us-east-1'
          const oidc = oidcBase(idcRegion)
          const tok = await postJson(fetchImpl, `${oidc}/token`, {
            clientId: params.client_id,
            clientSecret: params.client_secret,
            grantType: 'authorization_code',
            code,
            redirectUri,
            codeVerifier: verifier,
          }).catch((e) => { throw new OAuthError(`token exchange failed: ${e?.message ?? e}`, { kind: 'http' }) })
          params.tokens = {
            access_token: tok.accessToken || tok.access_token || '',
            refresh_token: tok.refreshToken || tok.refresh_token || '',
            id_token: tok.idToken || tok.id_token || '',
            expires_in: Number(tok.expiresIn ?? tok.expires_in ?? 0),
          }
          if (!params.tokens.id_token && !params.tokens.access_token) return fail(res, 'token response has no idToken/accessToken', 502)
          const trustedTenant = params.tenant_url ? trustedHttps(params.tenant_url, tenantHosts) : null
          const infoBase = trustedTenant && trustedTenant.hostname.includes('.dp.appintegrations.')
            ? trustedTenant.origin
            : (SOCIAL_DATA_PLANE[stage] || SOCIAL_DATA_PLANE.prod)
          try {
            params.user_info = normalizeUserInfo(await postJson(fetchImpl, `${infoBase}/integration/quick-work/user-info`, {}, {
              Authorization: `Bearer ${params.tokens.access_token}`,
            }))
          } catch (e) {
            // Tokens are already good. A user-info blip should not throw away
            // the login; actor_arn falls back to the id_token subject.
            params.user_info = {}
            log(`[oauth] user-info failed (${e?.message ?? e}); continuing with the token`)
          }
          const display = params.user_info.email || params.user_info.display_name || params.user_info.user_name || ''
          reply(res, 200, successPage(display))
          done(resolve, params)
          return
        }
        res.writeHead(404, { 'Content-Type': 'text/plain', Connection: 'close' })
        res.end('not found')
      } catch (e) {
        const status = e instanceof OAuthError && e.status ? e.status : 502
        fail(res, String(e?.message ?? e), status)
      }
    })
    server.on('error', (e) => {
      const err = new OAuthError(`cannot listen on 127.0.0.1:${listenPort}: ${e?.message ?? e}`, { kind: 'http' })
      settleReady(rejectReady, err)
      done(reject, err)
    })
    const timer = setTimeout(() => done(reject, new OAuthError(`timed out waiting for the browser login (${Math.round(timeoutMs / 60000)} min)`, { kind: 'timeout' })), timeoutMs)
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
    server.listen(listenPort, '127.0.0.1', () => {
      listenPort = server.address().port
      // AWS OIDC public clients only accept loopback redirect URIs with an empty
      // path — the code lands on "/"; a bare "/" visit (no OAuth params) shows the
      // waiting page instead.
      redirectUri = `http://127.0.0.1:${listenPort}`
      const discoverBase = SOCIAL_DISCOVERY[stage] || SOCIAL_DISCOVERY.prod
      const surface_ = encodeURIComponent(`desktop:${nonce}:${listenPort}:${appVersion}`)
      const url = `${discoverBase}?qwSurface=${surface_}`
      log(`[oauth] sign-in URL: ${url}`)
      settleReady(resolveReady, { url })
      if (openBrowser) Promise.resolve(openBrowser(url)).catch(() => log('[oauth] could not open a browser; use the URL above'))
      log('[oauth] waiting for the browser login…')
    })
  })
  // If callers fail during `await ready` and never await `result`, avoid an
  // unhandledRejection crash; awaiting `result` still rethrows the error.
  ready.catch(() => { result.catch(() => {}) })

  return { ready, result }
}

/** Run the login to the end. Opens the browser unless `openBrowser` is passed. */
export async function runOAuthLogin(opts = {}) {
  const openBrowser = Object.prototype.hasOwnProperty.call(opts, 'openBrowser') ? opts.openBrowser : defaultOpen
  const flow = await startOAuthLogin({ ...opts, openBrowser })
  await flow.ready
  return buildSession(await flow.result, { stage: opts.stage || 'prod' })
}

/** Assemble the stored-session record from a completed login. */
export function buildSession(p, { stage = 'prod' } = {}) {
  let tenant = String(p.tenant_url || p.discovery?.tenant_url || '').replace(/\/+$/, '')
  if (!tenant) tenant = SOCIAL_DATA_PLANE[stage] || SOCIAL_DATA_PLANE.prod
  if (!/^https?:\/\//.test(tenant)) tenant = `https://${tenant}`
  const ws_host = new URL(tenant).host
  if (!ws_host) throw new OAuthError('cannot derive ws_host from tenant_url', { kind: 'auth', status: 401 })
  const jwt = p.tokens.id_token || p.tokens.access_token || ''
  if (!jwt) throw new OAuthError('token response has no id_token/access_token', { kind: 'auth', status: 401 })
  const claims = decodeJwt(p.tokens.id_token || '')
  const now = Math.floor(Date.now() / 1000)
  const expiresIn = Number(p.tokens.expires_in) || 0
  const usable_until = expiresIn ? now + expiresIn : (Number(claims.exp) || 0)
  let actor_arn = p.user_info?.user_arn || ''
  if (!actor_arn && typeof claims.sub === 'string' && claims.sub.startsWith('arn:')) actor_arn = claims.sub
  return {
    provider: 'social',
    stage,
    tenant_url: tenant,
    ws_host,
    jwt,
    actor_arn,
    aws_account_id: p.user_info?.aws_account_id || claims.aws_account_id || '',
    account_name: p.user_info?.account_name || '',
    email: p.user_info?.email || '',
    display_name: p.user_info?.display_name || '',
    region: p.discovery?.idc_region || 'us-east-1',
    // Desktop always puts a device id on the chat URL. Browser login has no
    // local outpost, so keep one stable id with the account.
    outpost_id: p.outpost_id || randomUUID(),
    usable_until,
    obtained_at: now,
    user_info: p.user_info || {},
    tokens: { ...p.tokens },
    client: {
      client_id: p.client_id || '',
      client_secret: p.client_secret || '',
      idc_region: p.discovery?.idc_region || '',
      issuer_url: p.discovery?.issuer_url || '',
    },
    discovery: { ...p.discovery },
  }
}

/** Deterministic account key so re-login refreshes the same magpie account. */
export function keyForSession(sess) {
  const who = sess?.email || sess?.actor_arn || sess?.user_info?.user_arn || sess?.tenant_url || ''
  return `oauth-${createHash('sha256').update(who || rand()).digest('hex').slice(0, 16)}`
}

// ------------------------------------------------------- direct backend ----

/**
 * A session source with the same surface the chat path needs (Outpost-like):
 *   ensure() → self   session() → sncs-session-shaped object
 *   outpostId() → stable per-account device id
 * The chat WS takes the OIDC id_token (or the stored access token) in `?token=`.
 *
 * `load()` returns the persisted session record (or null); `persist(sess)`
 * writes it back after a refresh so rotated tokens survive restarts.
 */
export function createDirectBackend({ load, persist, fetchImpl = fetch, log = () => {} }) {
  let cached = null
  let refreshing = null
  let deviceId = ''
  const sncsShape = (s) => ({
    id_token: s.jwt,
    ws_host: s.ws_host,
    actor_arn: s.actor_arn || s.user_info?.user_arn || '',
    email: s.email || s.user_info?.email || '',
    provider: s.provider || 'social',
    aws_account_id: s.aws_account_id || s.user_info?.aws_account_id || '',
    account_name: s.account_name || s.user_info?.account_name || '',
    tenant_url: s.tenant_url || '',
    region: s.region || 'us-east-1',
    usable_until: s.usable_until || 0,
  })
  const backend = {
    direct: true,
    options: {},
    async ensure() {
      const s = await load()
      if (!s?.jwt) throw new OAuthError('session missing — log in again', { status: 401, kind: 'auth' })
      const diskUntil = Number(s.usable_until) || 0
      const memUntil = Number(cached?.usable_until) || 0
      const diskObtained = Number(s.obtained_at) || 0
      const memObtained = Number(cached?.obtained_at) || 0
      // A refresh that has not hit disk yet must not be replaced by the stale
      // copy. A newer disk copy (or re-login / tenant switch) wins.
      if (!cached || s.ws_host !== cached.ws_host || diskObtained > memObtained || diskUntil >= memUntil) {
        if (cached?.outpost_id && !s.outpost_id) s.outpost_id = cached.outpost_id
        cached = s
      }
      return backend
    },
    async session() {
      let s = cached || (await load())
      if (!s?.jwt) throw new OAuthError('session missing — log in again', { status: 401, kind: 'auth' })
      const now = Math.floor(Date.now() / 1000)
      if (s.usable_until && s.usable_until - now > 120) { cached = s; return sncsShape(s) }
      if (!s.tokens?.refresh_token) {
        // no refresh material: try the stored jwt; the server will 401 if dead
        if (s.jwt) { cached = s; return sncsShape(s) }
        throw new OAuthError('OAuth session expired and no refresh_token — log in again', { status: 401, kind: 'auth' })
      }
      refreshing ??= refreshSession(s, { fetchImpl }).then(async (fresh) => {
        await persist?.(fresh)
        cached = fresh
        log('[oauth] token refreshed')
        return fresh
      }).finally(() => { refreshing = null })
      const fresh = await refreshing
      return sncsShape(fresh)
    },
    async outpostId() {
      if (deviceId) return deviceId
      const s = cached || await load()
      deviceId = s?.outpost_id || randomUUID()
      if (s && s.outpost_id !== deviceId) {
        s.outpost_id = deviceId
        cached = s
        // Credential Manager blobs belong to the desktop app. A synthetic
        // device id stays in memory there; the OAuth file can persist it.
        if (!s._credTarget) await persist?.(s)
      }
      return deviceId
    },
    async status() {
      const s = cached || await Promise.resolve().then(load).catch(() => null)
      return { logged_in: Boolean(s?.jwt), user: s?.email || s?.display_name || '' }
    },
    async stop() {},
  }
  return backend
}
