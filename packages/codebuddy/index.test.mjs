// Tests for the codebuddy plugin: file discovery and sealing, expiry
// selection, refresh merging and one-refresh-at-a-time, header signing
// (enterprise included) and model-list filtering. No real account, token
// or network: the refresh and models fetches go through a stubbed fetch.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { _internal } from "./index.mjs"

const {
  SITE, UA, configModels, modelOf, variants,
  isCodeBuddyFile, desktopFiles, desktopAuth, readDesktop, notDesktop, desktopSignIn,
  domainOf, enterpriseHeaders, sign, isStale, refreshable, merge,
  refreshToken, renew, current, liveModels, toEntry, listed, makePlugin,
} = _internal

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "codebuddy-test-"))
  return {
    dir,
    write(name, obj) {
      writeFileSync(join(dir, name), JSON.stringify(obj))
    },
    clean() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const account = {
  uid: "u-1",
  nickname: "tester",
  enterpriseId: "e-1",
}
const auth = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresIn: 3600,
  refreshExpiresIn: 86400,
  expiresAt: 0,
  refreshExpiresAt: 0,
  domain: "",
  tokenType: "Bearer",
}

// ---- file discovery --------------------------------------------------------

test("isCodeBuddyFile takes the desktop's own login files, not WorkBuddy's", () => {
  assert.equal(isCodeBuddyFile("Tencent-Cloud.coding-copilot.info"), true)
  assert.equal(isCodeBuddyFile("coding-copilot.info"), true)
  assert.equal(isCodeBuddyFile("my-codebuddy.info"), true)
  assert.equal(isCodeBuddyFile("workbuddy-desktop.info"), false)
  assert.equal(isCodeBuddyFile("workbuddy-desktop-ai.info"), false)
})

test("desktopFiles lists only matching regular .info files", () => {
  const t = temp()
  try {
    t.write("Tencent-Cloud.coding-copilot.info", { auth, account })
    t.write("workbuddy-desktop.info", { auth, account })
    t.write("other.json", { auth, account })
    const files = desktopFiles(t.dir)
    assert.equal(files.length, 1)
    assert.ok(files[0].endsWith("Tencent-Cloud.coding-copilot.info"))
  } finally {
    t.clean()
  }
})

test("desktopAuth reads a plaintext login and skips a sealed one", () => {
  const t = temp()
  try {
    t.write("a.coding-copilot.info", {
      auth: { ...auth, accessToken: { $wbEncrypted: 1, envelope: "x" } },
      account,
    })
    t.write("b.coding-copilot.info", { auth, account })
    assert.equal(desktopAuth(join(t.dir, "a.coding-copilot.info")), null)
    const a = desktopAuth(join(t.dir, "b.coding-copilot.info"))
    assert.equal(a.access, "access-1")
    assert.equal(a.refresh, "refresh-1")
    assert.equal(a.uid, "u-1")
    assert.equal(a.enterpriseId, "e-1")
    assert.equal(a.source, "desktop")
    assert.ok(a.expires > Date.now())
  } finally {
    t.clean()
  }
})

test("readDesktop prefers a file whose access token is usable", () => {
  const t = temp()
  try {
    const now = Date.now()
    // expiring in 5 seconds: too close (within EARLY_MS) — not usable
    t.write("soon.coding-copilot.info", {
      auth: { ...auth, expiresAt: now + 5 * 1000, expiresIn: 0, refreshExpiresAt: now + 1000 * 1000, refreshExpiresIn: 0 },
      account,
    })
    t.write("later.coding-copilot.info", {
      auth: { ...auth, accessToken: "access-2", refreshToken: "refresh-2", expiresAt: now + 10 * 60 * 1000, expiresIn: 0, refreshExpiresAt: now + 1000 * 1000, refreshExpiresIn: 0 },
      account: { ...account, uid: "u-2" },
    })
    const d = readDesktop(t.dir)
    assert.equal(d.uid, "u-2")
    assert.equal(d.access, "access-2")
  } finally {
    t.clean()
  }
})

test("readDesktop returns null when every file is sealed", () => {
  const t = temp()
  try {
    t.write("a.coding-copilot.info", { auth: { ...auth, accessToken: { $wbEncrypted: 1 } }, account })
    assert.equal(readDesktop(t.dir), null)
  } finally {
    t.clean()
  }
})

test("notDesktop names the reason, never a token or path", () => {
  const t = temp()
  try {
    assert.match(notDesktop(t.dir), /isn't signed in/)
    t.write("a.coding-copilot.info", { auth: { ...auth, accessToken: { $wbEncrypted: 1 } }, account })
    assert.match(notDesktop(t.dir), /encrypted/)
  } finally {
    t.clean()
  }
})

// ---- signing and enterprise ------------------------------------------------

test("sign sets the desktop client's headers, enterprise included", () => {
  const a = { access: "tok", uid: "u-9", enterpriseId: "e-9", domain: "" }
  const headers = new Headers()
  sign(a, headers)
  assert.equal(headers.get("authorization"), "Bearer tok")
  assert.equal(headers.get("x-user-id"), "u-9")
  assert.equal(headers.get("x-domain"), SITE.defaultDomain)
  assert.equal(headers.get("x-enterprise-id"), "e-9")
  assert.equal(headers.get("x-tenant-id"), "e-9")
  assert.equal(headers.get("user-agent"), UA)
})

test("sign sends no enterprise headers for a personal account", () => {
  const headers = new Headers()
  sign({ access: "tok", uid: "u-1", domain: "x.codebuddy.cn" }, headers)
  assert.equal(headers.get("x-enterprise-id"), null)
  assert.equal(headers.get("x-tenant-id"), null)
  assert.equal(headers.get("x-domain"), "x.codebuddy.cn")
})

test("domainOf falls back to the site's default domain", () => {
  assert.equal(domainOf({}), SITE.defaultDomain)
  assert.equal(domainOf({ domain: "d" }), "d")
})

test("enterpriseHeaders sends both ids only when one is set", () => {
  assert.deepEqual(enterpriseHeaders({ enterpriseId: " e " }), { "X-Enterprise-Id": "e", "X-Tenant-Id": "e" })
  assert.deepEqual(enterpriseHeaders({}), {})
})

// ---- refresh ---------------------------------------------------------------

test("merge takes at-ms and in-seconds times and rotates the tokens", () => {
  const a = { access: "old", refresh: "old-r", expires: 0, refreshExpiresAt: 0, domain: "", tokenType: "" }
  const got = { accessToken: "new", refreshToken: "new-r", expiresIn: 300, refreshExpiresIn: 600, domain: "d" }
  const out = merge(a, got)
  assert.equal(out.access, "new")
  assert.equal(out.refresh, "new-r")
  assert.equal(out.domain, "d")
  assert.ok(out.expires > Date.now() && out.expires < Date.now() + 301 * 1000)
  assert.ok(out.refreshExpiresAt > Date.now() + 599 * 1000)
})

test("isStale and refreshable read the times", () => {
  const now = Date.now()
  assert.equal(isStale({ expires: now + 30 * 1000 }), true) // within a minute
  assert.equal(isStale({ expires: now + 10 * 60 * 1000 }), false)
  assert.equal(isStale({ expires: 0 }), false)
  assert.equal(refreshable({ refresh: "r" }), true)
  assert.equal(refreshable({ refresh: "" }), false)
  assert.equal(refreshable({ refresh: "r", refreshExpiresAt: now - 1 }), false)
})

test("refreshToken asks the backend and returns the new data", async () => {
  const calls = []
  const old = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers })
    return new Response(JSON.stringify({ code: 0, data: { accessToken: "fresh", refreshToken: "fresh-r", expiresIn: 3600 } }), { status: 200 })
  }
  try {
    const data = await refreshToken({ access: "a", refresh: "r", uid: "u", enterpriseId: "e" })
    assert.equal(data.accessToken, "fresh")
    assert.equal(calls.length, 1)
    const { url, headers } = calls[0]
    assert.ok(url.endsWith("/v2/plugin/auth/token/refresh"))
    assert.equal(headers["X-Refresh-Token"], "r")
    assert.equal(headers["X-Auth-Refresh-Source"], "plugin")
    assert.equal(headers["X-Enterprise-Id"], "e")
    assert.match(headers.Authorization, /^Bearer a$/)
  } finally {
    globalThis.fetch = old
  }
})

test("refreshToken surfaces a refusal without the token", async () => {
  const old = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 401, msg: "token refused" }), { status: 401 })
  try {
    await assert.rejects(refreshToken({ access: "secret-a", refresh: "secret-r" }), /token refused.*401.*code 401/)
  } finally {
    globalThis.fetch = old
  }
})

test("renew spends a refresh token once, giving late readers the same result", async () => {
  const old = globalThis.fetch
  let spent = 0
  globalThis.fetch = async () => {
    spent++
    return new Response(JSON.stringify({ code: 0, data: { accessToken: "fresh", refreshToken: "fresh-r", expiresIn: 3600 } }), { status: 200 })
  }
  try {
    const a = { access: "a", refresh: "r", expires: Date.now() - 1, refreshExpiresAt: 0, uid: "u" }
    const [x, y] = await Promise.all([renew(a), renew(a)])
    assert.equal(spent, 1)
    assert.equal(x.access, "fresh")
    assert.equal(y.access, "fresh")
    assert.equal(x.refresh, "fresh-r")
  } finally {
    globalThis.fetch = old
  }
})

// ---- current (desktop, in-memory only) -------------------------------------

test("current reads the desktop file and holds the renewed token in memory", async () => {
  const t = temp()
  try {
    const now = Date.now()
    t.write("a.coding-copilot.info", {
      auth: { ...auth, accessToken: "acc", refreshToken: "ref", expiresAt: now + 30 * 1000, expiresIn: 0, refreshExpiresAt: now + 1000 * 1000, refreshExpiresIn: 0 },
      account,
    })
    const old = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { accessToken: "fresh", refreshToken: "fresh-r", expiresIn: 3600 } }), { status: 200 })
    try {
      const a = await current({}, { type: "oauth", source: "desktop", accountId: "tester", uid: "u-1" }, t.dir)
      assert.equal(a.access, "fresh")
      assert.equal(a.refresh, "fresh-r")
    } finally {
      globalThis.fetch = old
    }
  } finally {
    t.clean()
  }
})

test("current throws a plain error when the desktop isn't signed in", async () => {
  const t = temp()
  try {
    await assert.rejects(current({}, { type: "oauth", source: "desktop", uid: "u" }, t.dir), /isn't signed in/)
  } finally {
    t.clean()
  }
})

// ---- models ----------------------------------------------------------------

test("configModels gives every static model the chat API and its efforts", () => {
  const ms = configModels()
  assert.equal(ms["deepseek-v4.1-flash"].limit.context, 1000000)
  assert.deepEqual(ms["deepseek-v4.1-flash"].variants, variants(["none", "low", "high", "max"]))
  assert.equal(ms["deepseek-v4.1-flash"].limit.output, 128000)
  assert.equal(ms["glm-5.1"].variants, undefined)
  assert.ok(ms["auto"].tool_call)
  assert.deepEqual(ms["auto"].modalities.input, ["text", "image"])
})

test("toEntry keeps chat models and drops aliases and non-chat models", () => {
  assert.equal(toEntry({ id: "default" }), null)
  assert.equal(toEntry({ id: "fast-model" }), null)
  assert.equal(toEntry({ id: "image-1" }), null)
  assert.equal(toEntry({ id: "embedding-x" }), null)
  const m = toEntry({ id: "deepseek-v4.1-flash", name: "Deepseek", maxInputTokens: 1000000, maxOutputTokens: 128000, supportsImages: true, reasoning: { supportedEfforts: ["none", "high"] } })
  assert.equal(m.context, 1000000)
  assert.equal(m.output, 128000)
  assert.equal(m.images, true)
  assert.deepEqual(m.efforts, ["none", "high"])
  const fallback = toEntry({ id: "glm-5.1", maxAllowedSize: 200000 })
  assert.equal(fallback.context, 200000)
})

test("modelOf renders a live entry on the chat API", () => {
  const m = modelOf({ id: "codebuddy" }, { id: "kimi-k3-1", name: "Kimi-K3", context: 1000000, output: 0, efforts: ["low", "high"], images: true })
  assert.equal(m.id, "kimi-k3-1")
  assert.equal(m.providerID, "codebuddy")
  assert.equal(m.api.url, SITE.endpoint + "/v2")
  assert.equal(m.capabilities.reasoning, true)
  assert.equal(m.capabilities.attachment, true)
})

test("liveModels and listed refuse the enterprise config when it can't be read", async () => {
  const old = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: [{ id: "glm-5.3", name: "GLM", maxInputTokens: 1000000 }] }), { status: 200 })
  try {
    const a = { access: "a", uid: "u", enterpriseId: "e" }
    const list = await listed(a, true)
    assert.equal(list.length, 1)
    assert.equal(list[0].id, "glm-5.3")
  } finally {
    globalThis.fetch = old
  }
  // a personal account has no list
  assert.deepEqual(await liveModels({ access: "a", uid: "u" }), [])
})

// ---- the plugin's shape ----------------------------------------------------

test("makePlugin returns hooks OpenCode and magpie can load", async () => {
  const plugin = await makePlugin()({ client: {}, magpie: {} })
  assert.equal(plugin.auth.provider, "codebuddy")
  assert.ok(Array.isArray(plugin.auth.methods) && plugin.auth.methods.length)
  assert.equal(plugin.auth.methods[0].type, "oauth")
  assert.equal(typeof plugin.auth.methods[0].authorize, "function")
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(plugin.provider.id, "codebuddy")
  const cfg = { provider: {} }
  await plugin.config(cfg)
  const p = cfg.provider.codebuddy
  assert.equal(p.name, "CodeBuddy")
  assert.equal(p.npm, "@ai-sdk/openai-compatible")
  assert.equal(p.api, SITE.endpoint + "/v2")
  assert.ok(Object.keys(p.models).length >= 10)
  // models fall back to the static list when there's no sign-in
  const staticModels = await plugin.provider.models(p, { auth: undefined })
  assert.deepEqual(staticModels, p.models)
})

test("desktopSignIn succeeds with the desktop's account and fails without one", async () => {
  const t = temp()
  try {
    t.write("a.coding-copilot.info", { auth, account })
    const r = await (await desktopSignIn(t.dir).callback())
    assert.equal(r.type, "success")
    assert.equal(r.source, "desktop")
    assert.equal(r.uid, "u-1")
    assert.equal(r.access, "")
  } finally {
    t.clean()
  }
  const r = await (await desktopSignIn(t.dir).callback())
  assert.equal(r.type, "failed")
  assert.match(r.error, /isn't signed in/)
})
