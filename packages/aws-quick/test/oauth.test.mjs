import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, utimesSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createSessionStore, startOAuthLogin, runOAuthLogin, refreshSession, buildSession,
  keyForSession, createDirectBackend, OAuthError,
} from '../lib/oauth.mjs'

const tmp = () => mkdtempSync(path.join(tmpdir(), 'oauth-test-'))

/** Mock fetch answering the OIDC endpoints the flow calls. */
const mockFetch = (log = []) => async (url, init = {}) => {
  const u = String(url)
  log.push({ url: u, body: init.body ? JSON.parse(init.body) : null })
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
  if (u.endsWith('/client/register')) return reply({ clientId: 'cid-1', clientSecret: 'csec-1' })
  if (u.endsWith('/token')) {
    const b = JSON.parse(init.body)
    if (b.grantType === 'authorization_code') {
      return reply({ accessToken: 'at-1', refreshToken: 'rt-1', idToken: 'idt-1', expiresIn: 3600 })
    }
    if (b.grantType === 'refresh_token') {
      return reply({ accessToken: 'at-2', refreshToken: 'rt-2', idToken: 'idt-2', expiresIn: 3600 })
    }
    return reply({ error: 'bad grant' }, 400)
  }
  if (u.endsWith('/integration/quick-work/user-info')) {
    return reply({ email: 'u@x.com', userArn: 'arn:aws:quicksight::1:user/u', awsAccountId: '111', accountName: 'acct' })
  }
  return reply({ error: 'unknown' }, 404)
}

/** Fake "browser": decodes the discovery URL and walks the redirect chain. */
async function fakeBrowser(url) {
  const surface = new URL(url).searchParams.get('qwSurface')
  const [nonce, port] = surface.split(':').slice(1)
  const cb = `http://127.0.0.1:${port}/callback?nonce=${encodeURIComponent(nonce)}` +
    `&issuerUrl=${encodeURIComponent('https://idc.example.com/issuer')}` +
    `&tenantUrl=${encodeURIComponent('https://qbs-cell.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev')}` +
    `&idcRegion=us-east-1`
  const r1 = await fetch(cb, { redirect: 'manual' })
  assert.equal(r1.status, 302)
  const loc = new URL(r1.headers.get('location'))
  const state = loc.searchParams.get('state')
  assert.ok(state)
  const r2 = await fetch(`http://127.0.0.1:${port}/?code=authcode-1&state=${encodeURIComponent(state)}`)
  assert.equal(r2.status, 200)
}

test('session store save/get/remove round-trip', () => {
  const dir = tmp()
  try {
    const store = createSessionStore({ dir })
    assert.equal(store.get('k'), undefined)
    store.set('k', { jwt: 'j', ws_host: 'h' })
    assert.equal(store.get('k').jwt, 'j')
    assert.deepEqual(store.list(), ['k'])
    store.remove('k')
    assert.equal(store.get('k'), undefined)
    // file written under dir with private name
    assert.ok(existsSync(path.join(dir, 'oauth-sessions.json')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildSession derives ws_host + jwt + usable_until', () => {
  const sess = buildSession({
    tenant_url: 'https://qbs-x.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev/',
    tokens: { access_token: 'a', refresh_token: 'r', id_token: 'i', expires_in: 3600 },
    user_info: { user_arn: 'arn:aws:quicksight::1:user/u', aws_account_id: '1', email: 'u@x' },
    client_id: 'c', client_secret: 's',
    discovery: { idc_region: 'us-east-1', issuer_url: 'https://idc/x' },
  })
  assert.equal(sess.ws_host, 'qbs-x.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev')
  assert.equal(sess.jwt, 'i')
  assert.equal(sess.actor_arn, 'arn:aws:quicksight::1:user/u')
  assert.ok(sess.usable_until > Math.floor(Date.now() / 1000))
  assert.equal(sess.client.idc_region, 'us-east-1')
})

test('full OAuth login flow: callback server + register + exchange + user-info', async () => {
  const calls = []
  const sess = await runOAuthLogin({
    fetchImpl: mockFetch(calls),
    openBrowser: fakeBrowser,
    log: () => {},
    timeoutMs: 15000,
  })
  assert.equal(sess.jwt, 'idt-1')
  assert.equal(sess.ws_host, 'qbs-cell.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev')
  assert.equal(sess.email, 'u@x.com')
  assert.equal(sess.tokens.refresh_token, 'rt-1')
  // called register → token → user-info in order
  assert.deepEqual(calls.map((c) => c.url.split('/').pop()), ['register', 'token', 'user-info'])
  const reg = calls[0].body
  assert.deepEqual(reg.grantTypes, ['authorization_code', 'refresh_token'])
  assert.equal(reg.clientName, 'AmazonQuick-Desktop')
  const exch = calls[1].body
  assert.equal(exch.grantType, 'authorization_code')
  assert.equal(exch.code, 'authcode-1')
  assert.ok(exch.codeVerifier)
})

test('login still completes when user-info fails', async () => {
  const sess = await runOAuthLogin({
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/integration/quick-work/user-info')) return new Response('nope', { status: 500 })
      return mockFetch()(url, init)
    },
    openBrowser: fakeBrowser,
    log: () => {},
    timeoutMs: 15000,
  })
  assert.equal(sess.jwt, 'idt-1')
  assert.equal(sess.ws_host, 'qbs-cell.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev')
  assert.equal(sess.email, '')
})

test('ensure does not roll a refreshed token back to a stale disk copy', async () => {
  let disk = buildSession({
    tenant_url: 'https://t/x',
    tokens: { access_token: 'a', refresh_token: 'rt-1', id_token: 'i', expires_in: 10 },
    user_info: { user_arn: 'arn:u' },
    discovery: { idc_region: 'us-east-1' },
    client_id: 'c', client_secret: 's',
  })
  let refreshes = 0
  const backend = createDirectBackend({
    load: () => disk,
    persist: (s) => { disk = s },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/token')) refreshes++
      return mockFetch()(url, init)
    },
  })
  await backend.ensure()
  const first = await backend.session()
  assert.equal(first.id_token, 'idt-2')
  disk = { ...disk, jwt: 'stale', usable_until: 1 }
  await backend.ensure()
  const again = await backend.session()
  assert.equal(again.id_token, 'idt-2')
  assert.equal(refreshes, 1)
})

test('login fails cleanly when the callback gets an error', async () => {
  await assert.rejects(() => runOAuthLogin({
    fetchImpl: mockFetch(),
    openBrowser: async (url) => {
      const port = new URL(url).searchParams.get('qwSurface').split(':')[2]
      await fetch(`http://127.0.0.1:${port}/callback?nonce=wrong&error=access_denied`)
    },
    log: () => {},
    timeoutMs: 15000,
  }), /nonce|mismatch|access_denied|timed out/i)
})

test('refreshSession mints new tokens and keeps rotation', async () => {
  const sess = buildSession({
    tenant_url: 'https://t/x', tokens: { access_token: 'a', refresh_token: 'rt-1', id_token: 'i', expires_in: 3600 },
    user_info: {}, client_id: 'c', client_secret: 's', discovery: { idc_region: 'us-east-1' },
  })
  await refreshSession(sess, { fetchImpl: mockFetch() })
  assert.equal(sess.jwt, 'idt-2')
  assert.equal(sess.tokens.refresh_token, 'rt-2') // rotated token persisted
  assert.equal(sess.tokens.access_token, 'at-2')
})

test('DirectBackend: sncs shape + refresh-on-expiry writes back', async () => {
  const dir = tmp()
  try {
    const store = createSessionStore({ dir })
    const sess = buildSession({
      tenant_url: 'https://t/x',
      tokens: { access_token: 'a', refresh_token: 'rt-1', id_token: 'i', expires_in: 10 }, // ~expired
      user_info: { user_arn: 'arn:u' }, discovery: { idc_region: 'us-east-1' },
      client_id: 'c', client_secret: 's',
    })
    store.set('k', sess)
    const backend = createDirectBackend({
      load: () => store.get('k'),
      persist: (s) => store.set('k', s),
      fetchImpl: mockFetch(),
    })
    assert.equal(backend.direct, true)
    assert.match(await backend.outpostId(), /^[0-9a-f-]{36}$/i)
    assert.equal(await backend.outpostId(), sess.outpost_id)
    const got = await backend.session()
    assert.equal(got.id_token, 'idt-2') // refreshed via refresh_token grant
    assert.equal(got.ws_host, 't')
    assert.equal(got.actor_arn, 'arn:u')
    // rotated refresh token persisted to the file
    assert.equal(store.get('k').tokens.refresh_token, 'rt-2')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DirectBackend errors 401/auth when session is missing', async () => {
  const backend = createDirectBackend({ load: () => null })
  await assert.rejects(() => backend.ensure(), OAuthError)
  await assert.rejects(() => backend.session(), /missing|again/i)
})

test('keyForSession is stable per account', () => {
  const a = keyForSession({ email: 'u@x.com' })
  const b = keyForSession({ email: 'u@x.com' })
  const c = keyForSession({ email: 'v@x.com' })
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.ok(a.startsWith('oauth-'))
})

test('callback rejects untrusted tenantUrl and invalid idcRegion', async () => {
  await assert.rejects(() => runOAuthLogin({
    fetchImpl: mockFetch(),
    openBrowser: async (url) => {
      const surface = new URL(url).searchParams.get('qwSurface')
      const [nonce, port] = surface.split(':').slice(1)
      await fetch(`http://127.0.0.1:${port}/callback?nonce=${encodeURIComponent(nonce)}&issuerUrl=https://idc.example.com&tenantUrl=${encodeURIComponent('https://dp.appintegrations.evil.com')}&idcRegion=us-east-1`)
    },
    log: () => {},
    timeoutMs: 15000,
  }), /unrecognized Amazon Quick tenant URL/i)

  await assert.rejects(() => runOAuthLogin({
    fetchImpl: mockFetch(),
    openBrowser: async (url) => {
      const surface = new URL(url).searchParams.get('qwSurface')
      const [nonce, port] = surface.split(':').slice(1)
      await fetch(`http://127.0.0.1:${port}/callback?nonce=${encodeURIComponent(nonce)}&issuerUrl=https://idc.example.com&idcRegion=${encodeURIComponent('evil.com#')}`)
    },
    log: () => {},
    timeoutMs: 15000,
  }), /invalid OIDC region/i)
})

test('startOAuthLogin handles pre-aborted signal and EADDRINUSE cleanly', async () => {
  const ac = new AbortController()
  ac.abort()
  const abortedFlow = await startOAuthLogin({ signal: ac.signal })
  await assert.rejects(() => abortedFlow.ready, /cancelled/i)

  const blocker = createServer()
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r))
  const busyPort = blocker.address().port
  try {
    const busyFlow = await startOAuthLogin({ port: busyPort, log: () => {} })
    await assert.rejects(() => busyFlow.ready, /cannot listen/i)
  } finally {
    await new Promise((r) => blocker.close(r))
  }
})

test('session store recovers from stale .pending lock file', () => {
  const dir = tmp()
  try {
    const store = createSessionStore({ dir })
    const pending = `${store.file}.pending`
    writeFileSync(pending, 'stale')
    const old = new Date(Date.now() - 60_000)
    utimesSync(pending, old, old)
    store.set('acct', { jwt: 'fresh', ws_host: 'h' })
    assert.equal(store.get('acct').jwt, 'fresh')
    assert.equal(existsSync(pending), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('refreshSession propagates user-info into top-level session fields', async () => {
  const sess = buildSession({
    tenant_url: 'https://qbs-x.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev',
    tokens: { access_token: 'a', refresh_token: 'rt-1', id_token: 'i', expires_in: 3600 },
    user_info: {}, client_id: 'c', client_secret: 's', discovery: { idc_region: 'us-east-1' },
  })
  await refreshSession(sess, { fetchImpl: mockFetch() })
  assert.equal(sess.email, 'u@x.com')
  assert.equal(sess.actor_arn, 'arn:aws:quicksight::1:user/u')
  assert.equal(sess.aws_account_id, '111')
})
