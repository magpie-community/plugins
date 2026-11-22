#!/usr/bin/env node
// Standalone fallback: an OpenAI-compatible proxy on 127.0.0.1 for the same
// adapter, for when you would rather add Amazon Quick to magpie as a custom
// provider (magpie provider add … --base-url http://127.0.0.1:PORT/v1) than
// load the plugin, or use it from any other OpenAI-compatible client.
//
//   node bin/serve.mjs                  # boots the Quick outpost lazily on first request
//   PORT=3426  HOST=127.0.0.1
//   PROXY_TOKEN=…                       # require "Authorization: Bearer <PROXY_TOKEN>" (recommended)
//   QUICK_AUTH=outpost|credman|oauth    # session source (default: outpost)
//   QUICK_SESSION_DIR=…  QUICK_OAUTH_KEY=…  # for QUICK_AUTH=oauth
//   QUICK_AGENT_PATH=…                  # explicit quickwork-agent(.exe)
//   QUICK_AGENT_ZIP=…                   # explicit resources/agent.zip to extract
//   QUICK_SESSION_REUSE=0               # send every request on a fresh Quick thread
//   QUICK_SESSION_TTL_MS=1800000  QUICK_SESSION_MAX=200
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { handleChatCompletions, handleModels } from '../lib/handler.mjs'
import { createOutpostManager } from '../lib/outpost.mjs'
import { createSessionStore, SESSION_DEFAULTS } from '../lib/sessions.mjs'
import { createSessionStore as createOAuthStore, createDirectBackend } from '../lib/oauth.mjs'
import { createCredManBackend } from '../lib/credman.mjs'

const DEFAULT_BODY_LIMIT = 8 * 1024 * 1024

function safeTokenEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function createProxyServer({ options = {}, token = '', outpostMgr, sessions, maxBodyBytes = DEFAULT_BODY_LIMIT } = {}) {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new RangeError('maxBodyBytes must be a positive integer')
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local')
      const path = url.pathname.replace(/\/+$/, '')
      if (token) {
        const got = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1] || req.headers['x-api-key'] || ''
        if (!safeTokenEqual(got, token)) {
          res.writeHead(401, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: { message: 'bad proxy token', type: 'authentication_error' } }))
        }
      }
      if (req.method === 'GET' && (path === '/health' || path === '')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true }))
      }
      const ac = new AbortController()
      res.on('close', () => { if (!res.writableEnded) ac.abort() })
      let out
      if (req.method === 'GET' && /\/models$/.test(path)) out = handleModels()
      else if (req.method === 'POST' && /\/chat\/completions$/.test(path)) {
        const tooLarge = () => {
          req.resume()
          res.writeHead(413, { 'content-type': 'application/json', connection: 'close' })
          res.end(JSON.stringify({ error: { message: 'request body too large', type: 'invalid_request_error' } }))
        }
        if (Number(req.headers['content-length']) > maxBodyBytes) return tooLarge()
        const parts = []
        let size = 0
        for await (const c of req.iterator({ destroyOnReturn: false })) {
          size += c.length
          if (size > maxBodyBytes) return tooLarge()
          parts.push(c)
        }
        let body
        try { body = JSON.parse(Buffer.concat(parts, size).toString('utf8')) } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: { message: 'request body must be JSON', type: 'invalid_request_error' } }))
        }
        out = await handleChatCompletions({ body, outpostMgr, options, signal: ac.signal, sessions, effortHeader: req.headers['x-magpie-effort'] })
      } else {
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${path}`, type: 'invalid_request_error' } }))
      }
      res.writeHead(out.status, Object.fromEntries(out.headers))
      if (!out.body) return res.end()
      await pipeline(Readable.fromWeb(out.body), res, { signal: ac.signal })
    } catch (e) {
      if (res.destroyed) return
      if (res.headersSent) return res.destroy()
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: String(e?.message ?? e), type: 'api_error' } }))
    }
  })
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const port = Number(process.env.PORT || 3426)
  const host = process.env.HOST || '127.0.0.1'
  const options = {}
  if (process.env.QUICK_AGENT_PATH) options.agentPath = process.env.QUICK_AGENT_PATH
  if (process.env.QUICK_AGENT_ZIP) options.agentZip = process.env.QUICK_AGENT_ZIP
  if (process.env.QUICK_USER_DATA_DIR) options.userDataDir = process.env.QUICK_USER_DATA_DIR
  if (process.env.QUICK_CACHE_DIR) options.cacheDir = process.env.QUICK_CACHE_DIR
  if (process.env.QUICK_OUTPOST_PORT) options.port = Number(process.env.QUICK_OUTPOST_PORT)
  if (process.env.QUICK_BUILD_STAGE) options.buildStage = process.env.QUICK_BUILD_STAGE
  const reuse = !/^(0|false|off|no)$/i.test(process.env.QUICK_SESSION_REUSE ?? '')
  const sessions = reuse
    ? createSessionStore({
        ttlMs: Number(process.env.QUICK_SESSION_TTL_MS) > 0 ? Number(process.env.QUICK_SESSION_TTL_MS) : SESSION_DEFAULTS.ttlMs,
        max: Number(process.env.QUICK_SESSION_MAX) > 0 ? Number(process.env.QUICK_SESSION_MAX) : SESSION_DEFAULTS.max,
      })
    : undefined
  const authMode = String(process.env.QUICK_AUTH || 'outpost').trim().toLowerCase()
  const log = (l) => console.error(`[${authMode}]`, l)
  let outpostMgr
  if (authMode === 'credman') {
    const backend = createCredManBackend({ log })
    outpostMgr = { ensure: () => backend.ensure(), stop: () => backend.stop() }
  } else if (authMode === 'oauth') {
    const store = createOAuthStore({ dir: process.env.QUICK_SESSION_DIR })
    const pickKey = () => process.env.QUICK_OAUTH_KEY || store.list()[0]
    const backend = createDirectBackend({
      load: () => { const k = pickKey(); return k ? store.get(k) : null },
      persist: (s) => { const k = pickKey(); if (k) store.set(k, s) },
      log,
    })
    outpostMgr = { ensure: () => backend.ensure(), stop: () => backend.stop() }
  } else {
    outpostMgr = createOutpostManager({ ...options, log })
  }
  const maxBodyBytes = Number(process.env.QUICK_MAX_BODY_BYTES || DEFAULT_BODY_LIMIT)
  const server = createProxyServer({ options: { ...options, identity: `aws-quick-proxy:${authMode}` }, token: process.env.PROXY_TOKEN || '', outpostMgr, sessions, maxBodyBytes })
  server.listen(port, host, () => {
    console.error(`aws-quick proxy listening on http://${host}:${port}/v1 (auth=${authMode})`)
  })
  const shutdown = () => {
    server.close()
    Promise.resolve(outpostMgr.stop?.()).finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
