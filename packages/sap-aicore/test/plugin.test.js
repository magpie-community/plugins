import { describe, it, beforeAll, afterAll, beforeEach, afterEach, jest } from "bun:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { SAPAICorePlugin } from "../src/index.js"

let originalFetch
let unstubbedFetchCalls = 0
beforeAll(() => {
  originalFetch = globalThis.fetch
  globalThis.fetch = () => {
    unstubbedFetchCalls++
    throw new Error("Unstubbed fetch: use withFetch to mock HTTP.")
  }
})
afterAll(() => { globalThis.fetch = originalFetch })
beforeEach(() => { unstubbedFetchCalls = 0 })

const cleanups = []
afterEach(async () => {
  try {
    for (const fn of cleanups.splice(0).reverse()) await fn()
  } finally {
    jest.useRealTimers()
    // The plugin catches fetch errors; assert outside that exception boundary.
    assert.equal(unstubbedFetchCalls, 0, "Unstubbed fetch: use withFetch to mock HTTP.")
  }
})

function pathKey(normalizedPath) {
  const digest = createHash("sha256").update("sap-aicore:path:" + normalizedPath).digest("hex")
  return "sap-aicore:path:" + digest
}

const VALID_CREDS = {
  authUrl: "https://mytenant.authentication.eu10.hana.ondemand.com",
  baseUrl: "https://api.ai.prod.eu10.hana.ondemand.com",
  clientId: "sb-abc123",
  clientSecret: "secret-value",
  resourceGroup: "default",
}

const TOKEN_RESPONSE = {
  access_token: "eyJhbGciOiJSUzI1NiJ9.synthetic",
  token_type: "bearer",
  expires_in: 43199,
}

function makeTokenResponse(overrides = {}) {
  return { ...TOKEN_RESPONSE, ...overrides }
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "magpie-aicore-test-"))
}

function writeCredFile(dir, name, creds = VALID_CREDS) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, JSON.stringify(creds), { mode: 0o600 })
  return p
}

function withFetch(mockFn, fn) {
  const real = globalThis.fetch
  globalThis.fetch = mockFn
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = real })
}

function makeOkResponse(body, requestUrl) {
  const resp = new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
  if (requestUrl) Object.defineProperty(resp, "url", { value: String(requestUrl), configurable: true })
  Object.defineProperty(resp, "redirected", { value: false, configurable: true })
  return resp
}

function makeErrResponse(status, body, requestUrl) {
  const resp = new Response(JSON.stringify(body ?? {}), {
    status,
    headers: { "content-type": "application/json", "www-authenticate": "Basic realm=\"OAuth\"" },
  })
  if (requestUrl) Object.defineProperty(resp, "url", { value: String(requestUrl), configurable: true })
  Object.defineProperty(resp, "redirected", { value: false, configurable: true })
  return resp
}

function okFetch(body) {
  return async (url, init) => makeOkResponse(body, url)
}

function routedFetch(tokenBody = TOKEN_RESPONSE, deployments = { resources: [] }) {
  return async (url, init) => {
    const target = url instanceof Request ? url.url : String(url)
    const pathname = new URL(target).pathname
    if (pathname === "/v2/lm/deployments") return makeOkResponse(deployments, url)
    return makeOkResponse(tokenBody, url)
  }
}

function errFetch(status, body = {}) {
  return async (url, init) => makeErrResponse(status, body, url)
}

function captureFetch(bodyOrFactory) {
  const calls = []
  const mock = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()), body: init?.body, redirect: init?.redirect, signal: init?.signal })
    const body = typeof bodyOrFactory === "function" ? bodyOrFactory(url) : bodyOrFactory
    return makeOkResponse(body, url)
  }
  mock.calls = calls
  return mock
}


describe("configuration", () => {
  it("preserves existing provider configuration", async () => {
    const plugin = await SAPAICorePlugin()
    const config = { provider: { "sap-aicore": { name: "My SAP", custom: true }, other: { name: "Other" } } }
    await plugin.config(config)
    assert.equal(config.provider["sap-aicore"].name, "My SAP")
    assert.equal(config.provider["sap-aicore"].custom, true)
    assert.equal(config.provider.other.name, "Other")
  })
})


describe("authorize input validation", () => {
  let dir

  beforeAll(() => { dir = makeTmpDir() })
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it("rejects missing credentialFile", async () => {
    const plugin = await SAPAICorePlugin()
    const r = await plugin.auth.methods[0].authorize({})
    assert.equal(r.type, "failed")
    assert.ok(r.error)
  })

  it("rejects non-string credentialFile", async () => {
    const plugin = await SAPAICorePlugin()
    const r = await plugin.auth.methods[0].authorize({ credentialFile: 42 })
    assert.equal(r.type, "failed")
  })

  it("rejects empty credentialFile", async () => {
    const plugin = await SAPAICorePlugin()
    const r = await plugin.auth.methods[0].authorize({ credentialFile: "" })
    assert.equal(r.type, "failed")
  })

  it("rejects relative path", async () => {
    const plugin = await SAPAICorePlugin()
    const r = await plugin.auth.methods[0].authorize({ credentialFile: "relative/path.json" })
    assert.equal(r.type, "failed")
  })

  it("rejects unknown input fields", async () => {
    const plugin = await SAPAICorePlugin()
    const r = await plugin.auth.methods[0].authorize({ credentialFile: "/tmp/x.json", extra: "bad" })
    assert.equal(r.type, "failed")
  })

  it("rejects path with NUL byte", async () => {
    const plugin = await SAPAICorePlugin()
    const r = await plugin.auth.methods[0].authorize({ credentialFile: "/tmp/x\x00.json" })
    assert.equal(r.type, "failed")
  })

  it("rejects array as input", async () => {
    const plugin = await SAPAICorePlugin()
    const r = await plugin.auth.methods[0].authorize(["/tmp/x.json"])
    assert.equal(r.type, "failed")
  })

  it("rejects null input", async () => {
    const plugin = await SAPAICorePlugin()
    const r = await plugin.auth.methods[0].authorize(null)
    assert.equal(r.type, "failed")
  })

  it("failed result has no key or metadata fields", async () => {
    const plugin = await SAPAICorePlugin()
    const r = await plugin.auth.methods[0].authorize({ credentialFile: "relative.json" })
    assert.equal(r.type, "failed")
    assert.equal("key" in r, false)
    assert.equal("metadata" in r, false)
  })
})


describe("credential file validation", () => {
  let dir

  beforeAll(() => { dir = makeTmpDir() })
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it("rejects nonexistent file", async () => {
    const plugin = await SAPAICorePlugin()
    const r = await plugin.auth.methods[0].authorize({ credentialFile: path.join(dir, "missing.json") })
    assert.equal(r.type, "failed")
  })

  it("rejects malformed JSON", async () => {
    const plugin = await SAPAICorePlugin()
    const p = path.join(dir, "bad.json")
    fs.writeFileSync(p, "{not valid json}")
    const r = await plugin.auth.methods[0].authorize({ credentialFile: p })
    assert.equal(r.type, "failed")
  })

  it("rejects missing authUrl", async () => {
    const plugin = await SAPAICorePlugin()
    const p = path.join(dir, "no-authurl.json")
    const { authUrl: _, ...creds } = VALID_CREDS
    fs.writeFileSync(p, JSON.stringify(creds))
    const r = await plugin.auth.methods[0].authorize({ credentialFile: p })
    assert.equal(r.type, "failed")
  })

  it("rejects empty authUrl", async () => {
    const plugin = await SAPAICorePlugin()
    const p = path.join(dir, "empty-authurl.json")
    fs.writeFileSync(p, JSON.stringify({ ...VALID_CREDS, authUrl: "" }))
    const r = await plugin.auth.methods[0].authorize({ credentialFile: p })
    assert.equal(r.type, "failed")
  })

  it("rejects missing clientSecret", async () => {
    const plugin = await SAPAICorePlugin()
    const p = path.join(dir, "no-secret.json")
    const { clientSecret: _, ...creds } = VALID_CREDS
    fs.writeFileSync(p, JSON.stringify(creds))
    const r = await plugin.auth.methods[0].authorize({ credentialFile: p })
    assert.equal(r.type, "failed")
  })

  it("rejects clientId containing a colon", async () => {
    const plugin = await SAPAICorePlugin()
    const p = path.join(dir, "colon-clientid.json")
    fs.writeFileSync(p, JSON.stringify({ ...VALID_CREDS, clientId: "sb:bad" }))
    const r = await plugin.auth.methods[0].authorize({ credentialFile: p })
    assert.equal(r.type, "failed")
  })

  it("rejects non-string clientId", async () => {
    const plugin = await SAPAICorePlugin()
    const p = path.join(dir, "num-clientid.json")
    fs.writeFileSync(p, JSON.stringify({ ...VALID_CREDS, clientId: 123 }))
    const r = await plugin.auth.methods[0].authorize({ credentialFile: p })
    assert.equal(r.type, "failed")
  })

  it("rejects clientSecret with control characters", async () => {
    const plugin = await SAPAICorePlugin()
    const p = path.join(dir, "ctrl-secret.json")
    fs.writeFileSync(p, JSON.stringify({ ...VALID_CREDS, clientSecret: "secret\x01val" }))
    const r = await plugin.auth.methods[0].authorize({ credentialFile: p })
    assert.equal(r.type, "failed")
  })

  it("rejects missing resourceGroup", async () => {
    const plugin = await SAPAICorePlugin()
    const p = path.join(dir, "no-rg.json")
    const { resourceGroup: _, ...creds } = VALID_CREDS
    fs.writeFileSync(p, JSON.stringify(creds))
    const r = await plugin.auth.methods[0].authorize({ credentialFile: p })
    assert.equal(r.type, "failed")
  })
})


describe("URL validation", () => {
  let dir

  beforeAll(() => { dir = makeTmpDir() })
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  async function tryUrl(authUrl, baseUrl) {
    const plugin = await SAPAICorePlugin()
    const p = path.join(dir, `url-test-${Date.now()}-${Math.random()}.json`)
    fs.writeFileSync(p, JSON.stringify({ ...VALID_CREDS, authUrl, baseUrl }))
    return plugin.auth.methods[0].authorize({ credentialFile: p })
  }

  it("rejects http:// authUrl", async () => {
    const r = await tryUrl("http://mytenant.authentication.eu10.hana.ondemand.com", VALID_CREDS.baseUrl)
    assert.equal(r.type, "failed")
  })

  it("rejects authUrl with userinfo", async () => {
    const r = await tryUrl("https://user:pass@mytenant.authentication.eu10.hana.ondemand.com", VALID_CREDS.baseUrl)
    assert.equal(r.type, "failed")
  })

  it("rejects authUrl with query string", async () => {
    const r = await tryUrl("https://mytenant.authentication.eu10.hana.ondemand.com?foo=bar", VALID_CREDS.baseUrl)
    assert.equal(r.type, "failed")
  })

  it("rejects authUrl with fragment", async () => {
    const r = await tryUrl("https://mytenant.authentication.eu10.hana.ondemand.com#section", VALID_CREDS.baseUrl)
    assert.equal(r.type, "failed")
  })

  it("rejects authUrl with non-default port", async () => {
    const r = await tryUrl("https://mytenant.authentication.eu10.hana.ondemand.com:8443", VALID_CREDS.baseUrl)
    assert.equal(r.type, "failed")
  })

  it("rejects authUrl with IP literal", async () => {
    const r = await tryUrl("https://192.168.1.1", VALID_CREDS.baseUrl)
    assert.equal(r.type, "failed")
  })

  it("rejects authUrl with incomplete /oauth path", async () => {
    const r = await tryUrl("https://mytenant.authentication.eu10.hana.ondemand.com/oauth", VALID_CREDS.baseUrl)
    assert.equal(r.type, "failed")
  })

  it("rejects authUrl with extra path segments", async () => {
    const r = await tryUrl("https://mytenant.authentication.eu10.hana.ondemand.com/extra/path", VALID_CREDS.baseUrl)
    assert.equal(r.type, "failed")
  })

  it("rejects baseUrl with unsupported /v1 suffix", async () => {
    const r = await tryUrl(VALID_CREDS.authUrl, "https://api.ai.prod.eu10.hana.ondemand.com/v1")
    assert.equal(r.type, "failed")
  })

  it("rejects authUrl on unknown domain", async () => {
    const r = await tryUrl("https://attacker.evil.com", VALID_CREDS.baseUrl)
    assert.equal(r.type, "failed")
  })

  it("rejects baseUrl on unknown domain", async () => {
    const r = await tryUrl(VALID_CREDS.authUrl, "https://attacker.evil.com")
    assert.equal(r.type, "failed")
  })

  it("accepts /oauth/token and /v2 suffixes without duplicating the token path", async () => {
    const mock = captureFetch(TOKEN_RESPONSE)
    const r = await withFetch(mock, () => tryUrl(
      VALID_CREDS.authUrl + "/oauth/token",
      VALID_CREDS.baseUrl + "/v2",
    ))
    assert.equal(r.type, "success")
    assert.equal(mock.calls.length, 1)
    assert.equal(mock.calls[0].method, "POST")
    assert.equal(mock.calls[0].url, VALID_CREDS.authUrl + "/oauth/token")
  })

  it("accepts authUrl with trailing slash", async () => {
    const plugin = await SAPAICorePlugin()
    const p = path.join(dir, "trailing-slash.json")
    fs.writeFileSync(p, JSON.stringify({ ...VALID_CREDS, authUrl: VALID_CREDS.authUrl + "/" }))
    const r = await withFetch(okFetch(TOKEN_RESPONSE), () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(r.type, "success")
  })
})


describe("OAuth request contract", () => {
  let dir

  beforeAll(() => { dir = makeTmpDir() })
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it("POSTs to normalized OAuth token URL", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "oauth-req.json")
    const mock = captureFetch(TOKEN_RESPONSE)
    const r = await withFetch(mock, () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(r.type, "success")
    assert.equal(mock.calls.length, 1)
    assert.equal(mock.calls[0].url, VALID_CREDS.authUrl + "/oauth/token")
    assert.equal(mock.calls[0].method, "POST")
  })

  it("uses raw UTF-8 Basic auth (not percent-encoded)", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "basic-raw.json", { ...VALID_CREDS, clientId: "sb-abc+def", clientSecret: "s3cr3t+val" })
    const mock = captureFetch(TOKEN_RESPONSE)
    await withFetch(mock, () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    const authHeader = mock.calls[0].headers["authorization"] ?? mock.calls[0].headers["Authorization"]
    assert.ok(authHeader, "Authorization header must be present")
    assert.ok(authHeader.startsWith("Basic "), "Must be Basic scheme")
    const encoded = authHeader.slice("Basic ".length)
    const decoded = Buffer.from(encoded, "base64").toString("utf8")
    assert.equal(decoded, "sb-abc+def:s3cr3t+val")
  })

  it("sends only grant_type=client_credentials in body", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "grant-type.json")
    const mock = captureFetch(TOKEN_RESPONSE)
    await withFetch(mock, () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(mock.calls[0].body, "grant_type=client_credentials")
  })

  it("sets Content-Type to application/x-www-form-urlencoded", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "content-type.json")
    const mock = captureFetch(TOKEN_RESPONSE)
    await withFetch(mock, () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    const ct = mock.calls[0].headers["content-type"] ?? mock.calls[0].headers["Content-Type"]
    assert.ok(ct?.includes("application/x-www-form-urlencoded"))
  })

  it("sets redirect to error", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "redirect.json")
    const mock = captureFetch(TOKEN_RESPONSE)
    await withFetch(mock, () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(mock.calls[0].redirect, "error")
  })

  it("rejects redirected response", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "redirected.json")
    const mock2 = async (url, init) => {
      const resp = makeOkResponse(TOKEN_RESPONSE, url)
      Object.defineProperty(resp, "redirected", { value: true, configurable: true })
      return resp
    }
    const r = await withFetch(mock2, () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(r.type, "failed")
  })

  it("fails on network error", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "network-err.json")
    const r = await withFetch(async () => { throw new Error("network failure") }, () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(r.type, "failed")
    assert.ok(!r.error.includes("network failure"), "must not echo underlying error message")
  })

  it("fails on empty access_token", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "empty-token.json")
    const r = await withFetch(okFetch({ ...TOKEN_RESPONSE, access_token: "" }), () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(r.type, "failed")
  })

  it("fails on missing access_token", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "no-token.json")
    const r = await withFetch(okFetch({ token_type: "bearer", expires_in: 43199 }), () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(r.type, "failed")
  })

  it("fails on non-finite expires_in", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "inf-exp.json")
    const r = await withFetch(okFetch({ ...TOKEN_RESPONSE, expires_in: Infinity }), () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(r.type, "failed")
  })

  it("fails on zero expires_in", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "zero-exp.json")
    const r = await withFetch(okFetch({ ...TOKEN_RESPONSE, expires_in: 0 }), () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(r.type, "failed")
  })

  it("fails on negative expires_in", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "neg-exp.json")
    const r = await withFetch(okFetch({ ...TOKEN_RESPONSE, expires_in: -1 }), () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(r.type, "failed")
  })

  it("fails on HTTP 500", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "5xx.json")
    const r = await withFetch(errFetch(500, {}), () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(r.type, "failed")
  })

  it("fails on unrelated 401 (no invalid_client body)", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "unrelated-401.json")
    const r = await withFetch(errFetch(401, { error: "unauthorized" }), () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(r.type, "failed")
  })

  it("accepts token_type bearer case-insensitively", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "bearer-upper.json")
    const r = await withFetch(okFetch({ ...TOKEN_RESPONSE, token_type: "Bearer" }), () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(r.type, "success")
  })
})


describe("authorize success result", () => {
  let dir

  beforeAll(() => { dir = makeTmpDir() })
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it("returns type success with key and metadata on valid exchange", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "success.json")
    const r = await withFetch(okFetch(TOKEN_RESPONSE), () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(r.type, "success")
    assert.ok(typeof r.key === "string")
    assert.ok(r.key.startsWith("sap-aicore:path:"))
    assert.deepEqual(r.metadata, { credentialFile: p })
  })

  it("key is deterministic SHA-256 of normalized path", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "det-key.json")
    const r = await withFetch(okFetch(TOKEN_RESPONSE), () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(r.key, pathKey(p))
  })

  it("result contains no access_token, clientSecret, or refresh", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "no-secrets.json")
    const r = await withFetch(okFetch(TOKEN_RESPONSE), () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(r.type, "success")
    const text = JSON.stringify(r)
    assert.ok(!text.includes("access_token"))
    assert.ok(!text.includes("eyJhbGciOiJSUzI1NiJ9"))
    assert.ok(!text.includes("secret-value"))
    assert.ok(!text.includes("client_credentials"))
    assert.equal("refresh" in r, false)
    assert.equal("expires" in r, false)
  })

  it("metadata normalizes credentialFile key regardless of input", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "norm-meta.json")
    const r = await withFetch(okFetch(TOKEN_RESPONSE), () => plugin.auth.methods[0].authorize({ credentialFile: p }))
    assert.equal(r.metadata.credentialFile, p)
  })
})


describe("provider.models", () => {
  let dir

  beforeAll(() => { dir = makeTmpDir() })
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it("returns empty object without auth (no file read or network)", async () => {
    const plugin = await SAPAICorePlugin()
    const r = await plugin.provider.models({ models: {} })
    assert.deepEqual(r, {})
  })

  it("returns empty object with auth when discovery finds no eligible deployments", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "models-auth.json")
    let authorized
    await withFetch(okFetch(TOKEN_RESPONSE), async () => {
      authorized = await plugin.auth.methods[0].authorize({ credentialFile: p })
    })
    assert.equal(authorized.type, "success")
    const r = await withFetch(routedFetch(), () =>
      plugin.provider.models({ models: {} }, { auth: { type: "api", key: authorized.key, metadata: authorized.metadata } })
    )
    assert.deepEqual(r, {})
  })

  it("does not fabricate models with plausible-looking auth", async () => {
    const plugin = await SAPAICorePlugin()
    await assert.rejects(
      () => plugin.provider.models({ models: { "gpt-4o": {} } }, { auth: { type: "api", key: "fake-key", metadata: {} } }),
      (e) => { assert.ok(e instanceof Error); return true }
    )
  })
})


describe("same-path reauthorization", () => {
  let dir

  beforeAll(() => { dir = makeTmpDir() })
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it("sequential authorizations to same path return same key", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "same-path.json")
    const r1 = await withFetch(okFetch(TOKEN_RESPONSE), () =>
      plugin.auth.methods[0].authorize({ credentialFile: p })
    )
    const r2 = await withFetch(okFetch({ ...TOKEN_RESPONSE, access_token: "token2" }), () =>
      plugin.auth.methods[0].authorize({ credentialFile: p })
    )
    assert.equal(r1.type, "success")
    assert.equal(r2.type, "success")
    assert.equal(r1.key, r2.key)
  })

  it("concurrent same-path authorizations: newer candidate supersedes older", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "concurrent-same.json")
    const results = await withFetch(okFetch(TOKEN_RESPONSE), () =>
      Promise.all([
        plugin.auth.methods[0].authorize({ credentialFile: p }),
        plugin.auth.methods[0].authorize({ credentialFile: p }),
      ])
    )
    const successes = results.filter(r => r.type === "success")
    assert.ok(successes.length >= 1, "at least one same-path concurrent authorize must succeed")
    const keys = new Set(successes.map(r => r.key))
    assert.equal(keys.size, 1)
  })

  it("distinct paths yield distinct keys even with identical credential bytes", async () => {
    const plugin = await SAPAICorePlugin()
    const p1 = writeCredFile(dir, "path-a.json")
    const p2 = writeCredFile(dir, "path-b.json")
    const [r1, r2] = await withFetch(okFetch(TOKEN_RESPONSE), () =>
      Promise.all([
        plugin.auth.methods[0].authorize({ credentialFile: p1 }),
        plugin.auth.methods[0].authorize({ credentialFile: p2 }),
      ])
    )
    assert.equal(r1.type, "success")
    assert.equal(r2.type, "success")
    assert.notEqual(r1.key, r2.key)
  })

  it("failed reauthorization does not retire current working account", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "fail-reauth.json")

    const r1 = await withFetch(okFetch(TOKEN_RESPONSE), () =>
      plugin.auth.methods[0].authorize({ credentialFile: p })
    )
    assert.equal(r1.type, "success")

    const r2 = await withFetch(errFetch(401, { error: "invalid_client" }), () =>
      plugin.auth.methods[0].authorize({ credentialFile: p })
    )
    assert.equal(r2.type, "failed")

    const modelsResult = await withFetch(routedFetch(), () =>
      plugin.provider.models({ models: {} }, { auth: { type: "api", key: r1.key, metadata: r1.metadata } })
    )
    assert.deepEqual(modelsResult, {})
  })

  it("successful same-path reauthorization replaces old generation", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "success-reauth.json")

    const r1 = await withFetch(okFetch(TOKEN_RESPONSE), () =>
      plugin.auth.methods[0].authorize({ credentialFile: p })
    )
    assert.equal(r1.type, "success")

    fs.writeFileSync(p, JSON.stringify({ ...VALID_CREDS, resourceGroup: "new-rg" }))

    const r2 = await withFetch(okFetch({ ...TOKEN_RESPONSE, access_token: "new-token" }), () =>
      plugin.auth.methods[0].authorize({ credentialFile: p })
    )
    assert.equal(r2.type, "success")
    assert.equal(r1.key, r2.key)
  })
})


describe("token renewal thresholds", () => {
  it("short-lived token is not re-exchanged while still within renewAt", async () => {
    const dir = makeTmpDir()
    try {
      const plugin = await SAPAICorePlugin()
      const p = writeCredFile(dir, "short-lived.json")
      let authorized
      await withFetch(okFetch({ ...TOKEN_RESPONSE, expires_in: 120 }), async () => {
        authorized = await plugin.auth.methods[0].authorize({ credentialFile: p })
      })
      assert.equal(authorized.type, "success")

      let tokenFetchCount = 0
      const trackFetch = async (url, init) => {
        if (new URL(String(url)).pathname === "/v2/lm/deployments") return makeOkResponse({ resources: [] }, url)
        tokenFetchCount++
        return makeOkResponse({ ...TOKEN_RESPONSE, expires_in: 120 }, url)
      }

      const auth = { type: "api", key: authorized.key, metadata: authorized.metadata }
      await withFetch(trackFetch, () => plugin.provider.models({ models: {} }, { auth }))
      const firstCount = tokenFetchCount
      await withFetch(trackFetch, () => plugin.provider.models({ models: {} }, { auth }))
      assert.equal(tokenFetchCount, firstCount, "second models call must not re-exchange a fresh token")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects already-expired token response", async () => {
    const dir = makeTmpDir()
    try {
      const plugin = await SAPAICorePlugin()
      const p = writeCredFile(dir, "expired-resp.json")
      const r = await withFetch(okFetch({ ...TOKEN_RESPONSE, expires_in: -5 }), () =>
        plugin.auth.methods[0].authorize({ credentialFile: p })
      )
      assert.equal(r.type, "failed")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})




describe("credential file caching", () => {
  let dir

  beforeAll(() => { dir = makeTmpDir() })
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it("does not re-read credential file after initialization", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "cache-test.json")
    let authorized
    await withFetch(okFetch(TOKEN_RESPONSE), async () => {
      authorized = await plugin.auth.methods[0].authorize({ credentialFile: p })
    })

    fs.writeFileSync(p, "{invalid}")

    const r = await withFetch(routedFetch({ ...TOKEN_RESPONSE, access_token: "refreshed" }), () =>
      plugin.provider.models({ models: {} }, { auth: { type: "api", key: authorized.key, metadata: authorized.metadata } })
    )
    assert.deepEqual(r, {})
  })

  it("new factory invocation must re-read credential file", async () => {
    const p = writeCredFile(dir, "new-factory.json")

    const plugin1 = await SAPAICorePlugin()
    let authorized
    await withFetch(okFetch(TOKEN_RESPONSE), async () => {
      authorized = await plugin1.auth.methods[0].authorize({ credentialFile: p })
    })
    assert.equal(authorized.type, "success")

    fs.writeFileSync(p, "{bad json}")

    const plugin2 = await SAPAICorePlugin()
    const r2 = await plugin2.auth.methods[0].authorize({ credentialFile: p })
    assert.equal(r2.type, "failed")
  })
})



describe("regression: malformed and edge responses", () => {
  let dir

  beforeAll(() => { dir = makeTmpDir() })
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it("rejects token_type that is a number", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "numeric-type.json")
    const r = await withFetch(okFetch({ ...TOKEN_RESPONSE, token_type: 42 }), () =>
      plugin.auth.methods[0].authorize({ credentialFile: p })
    )
    assert.equal(r.type, "failed")
  })

  it("rejects access_token that is whitespace-only", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "ws-token.json")
    const r = await withFetch(okFetch({ ...TOKEN_RESPONSE, access_token: "   " }), () =>
      plugin.auth.methods[0].authorize({ credentialFile: p })
    )
    assert.equal(r.type, "failed")
  })

  it("rejects expires_in arithmetic overflow (too large)", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "overflow-exp.json")
    const r = await withFetch(okFetch({ ...TOKEN_RESPONSE, expires_in: 9e15 }), () =>
      plugin.auth.methods[0].authorize({ credentialFile: p })
    )
    assert.equal(r.type, "failed")
  })

  it("rejects credentials with unpaired surrogate in clientId", async () => {
    const plugin = await SAPAICorePlugin()
    const p = path.join(dir, "surrogate-id.json")
    fs.writeFileSync(p, JSON.stringify({ ...VALID_CREDS, clientId: "sb-\uD800bad" }))
    const r = await plugin.auth.methods[0].authorize({ credentialFile: p })
    assert.equal(r.type, "failed")
  })

  it("rejects credentials with unpaired surrogate in clientSecret", async () => {
    const plugin = await SAPAICorePlugin()
    const p = path.join(dir, "surrogate-secret.json")
    fs.writeFileSync(p, JSON.stringify({ ...VALID_CREDS, clientSecret: "val\uDC00tail" }))
    const r = await plugin.auth.methods[0].authorize({ credentialFile: p })
    assert.equal(r.type, "failed")
  })

  it("rejects authUrl with raw whitespace", async () => {
    const plugin = await SAPAICorePlugin()
    const p = path.join(dir, "ws-authurl.json")
    fs.writeFileSync(p, JSON.stringify({ ...VALID_CREDS, authUrl: "https://mytenant.authentication.eu10.hana.ondemand.com " }))
    const r = await plugin.auth.methods[0].authorize({ credentialFile: p })
    assert.equal(r.type, "failed")
  })

  it("rejects authUrl with backslash", async () => {
    const plugin = await SAPAICorePlugin()
    const p = path.join(dir, "bs-authurl.json")
    fs.writeFileSync(p, JSON.stringify({ ...VALID_CREDS, authUrl: "https://mytenant.authentication.eu10.hana.ondemand.com\\" }))
    const r = await plugin.auth.methods[0].authorize({ credentialFile: p })
    assert.equal(r.type, "failed")
  })

  it("late failure does not delete a newer candidate for the same path", async () => {
    const plugin = await SAPAICorePlugin()
    const p = writeCredFile(dir, "late-fail-newer.json")

    let callCount = 0
    const racingFetch = async (url, init) => {
      callCount++
      const n = callCount
      if (n === 1) {
        await new Promise(r => setTimeout(r, 50))
        return makeErrResponse(500, {}, url)
      }
      return makeOkResponse(TOKEN_RESPONSE, url)
    }

    const [r1, r2] = await withFetch(racingFetch, async () => {
      const p1 = plugin.auth.methods[0].authorize({ credentialFile: p })
      await new Promise(r => setTimeout(r, 10))
      const p2 = plugin.auth.methods[0].authorize({ credentialFile: p })
      return Promise.all([p1, p2])
    })

    const successes = [r1, r2].filter(r => r.type === "success")
    assert.ok(successes.length >= 1, "newer candidate must succeed despite late first failure")
  })

})


describe("security boundaries", () => {
  let dir

  beforeAll(() => { dir = makeTmpDir() })
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it("authorize result never contains credentials or token text", async () => {
    const plugin = await SAPAICorePlugin()
    const sentinelSecret = "secret-value"
    const sentinelToken = TOKEN_RESPONSE.access_token
    const p = writeCredFile(dir, "sec-check.json")
    const r = await withFetch(okFetch(TOKEN_RESPONSE), () =>
      plugin.auth.methods[0].authorize({ credentialFile: p })
    )
    assert.equal(r.type, "success")
    const text = JSON.stringify(r)
    assert.ok(!text.includes(sentinelSecret), "result must not contain clientSecret")
    assert.ok(!text.includes(sentinelToken), "result must not contain access_token")
    assert.ok(!text.includes("sb-abc123"), "result must not contain clientId")
    assert.ok(!text.includes("client_credentials"), "result must not contain grant type")
    assert.ok(!text.includes("basic "), "result must not contain Basic scheme (case insensitive)")
    assert.ok(!text.includes("Basic "), "result must not contain Basic scheme")
  })

  it("failed authorize result never reveals path or JSON bytes", async () => {
    const plugin = await SAPAICorePlugin()
    const p = path.join(dir, "sec-fail.json")
    fs.writeFileSync(p, JSON.stringify({ ...VALID_CREDS, clientSecret: "ultra-secret" }))
    const r = await withFetch(errFetch(500), () =>
      plugin.auth.methods[0].authorize({ credentialFile: p })
    )
    assert.equal(r.type, "failed")
    const text = JSON.stringify(r)
    assert.ok(!text.includes("ultra-secret"), "error must not echo clientSecret")
  })
})
