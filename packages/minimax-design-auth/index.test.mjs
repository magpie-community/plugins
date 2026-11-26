import assert from "node:assert/strict"
import { createCipheriv, randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix, win32 } from "node:path"
import { describe, test } from "node:test"
import * as opencode1 from "./opencode.mjs"
import opencode2 from "./opencode2.mjs"
import { _internal } from "./index.mjs"

const {
  SITES,
  OtherSite,
  createPlugin,
  decryptV2Token,
  candidateDataDirs,
  inferRegionFromConfig,
  readDesktopCredentialFromDir,
  readDesktopCredential,
  waitForDesktopCredential,
  parseRemoteConfig,
  usageFromWallet,
  usageFromBalance,
  normalizeUpstreamResponse,
  normalizeVersionCode,
  parseDateIso,
  isExpiredJwt,
  siteFetch,
} = _internal

function makeJwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${header}.${payload}.fakesig`
}

function encryptV2(plain, keyBuf) {
  const iv = randomBytes(16)
  const cipher = createCipheriv("aes-256-gcm", keyBuf, iv)
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v2enc:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`
}

function makeTempDesktopDir({
  token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  userID = "10001",
  userName = "Tester",
  groupId = "20002",
  deviceId = "dev-uuid-1",
  lkgObj = null,
  adUrl = "https://design.minimax.cn/",
  rawAccessOverride = null,
  skipKey = false,
  symlinkKey = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "mm-design-test-"))
  const keyBuf = randomBytes(32)
  if (!skipKey) {
    if (symlinkKey) {
      const target = join(root, "real-key")
      writeFileSync(target, keyBuf)
      symlinkSync(target, join(root, ".token-key"))
    } else {
      writeFileSync(join(root, ".token-key"), keyBuf)
    }
  }
  const cfg = {
    _version: 34,
    tokens: {
      accessToken: rawAccessOverride !== null ? rawAccessOverride : encryptV2(token, keyBuf),
      ...(adUrl ? { adAttribution: { v: 1, url: adUrl } } : {}),
    },
    user: { userID, userName },
    selectedGroupIds: groupId ? { [userID]: groupId } : {},
    deviceId,
    ...(lkgObj ? { lkgProviderConfig: encryptV2(JSON.stringify(lkgObj), keyBuf) } : {}),
  }
  writeFileSync(join(root, "hub-config.json"), JSON.stringify(cfg))
  return { root, keyBuf, token, cfg }
}

const SAMPLE_REMOTE_CONFIG = {
  enabled_providers: ["minimaxHub", "alpha", "gamma", "omega"],
  provider: {
    minimaxHub: {
      name: "minimaxHub",
      npm: "@ai-sdk/anthropic",
      options: { baseURL: "https://hub.minimaxi.com/api/v1" },
      models: {
        "MiniMax-M3.1-Flash": {
          name: "MiniMax-M3.1-Flash",
          display_name: "MiniMax M3.1 Flash",
          attachment: true,
          reasoning: true,
          tool_call: true,
          temperature: true,
          options: { thinking: { type: "adaptive" }, effort: "high" },
          modalities: { input: ["text", "image", "video"], output: ["text"] },
          limit: { context: 1000000, input: 872000, output: 128000 },
        },
      },
    },
    alpha: {
      name: "alpha",
      npm: "@ai-sdk/anthropic",
      options: { baseURL: "https://hub.minimaxi.com/api/v1" },
      models: {
        alpha: {
          name: "Gamma-Op 5.5",
          reasoning: true,
          attachment: true,
          tool_call: true,
          temperature: true,
          modalities: { input: ["text", "image", "pdf"], output: ["text"] },
          limit: { context: 400000, input: 280000, output: 128000 },
          variants: { low: { effort: "low" }, high: { effort: "high" } },
        },
      },
    },
    gamma: {
      name: "gamma",
      npm: "@ai-sdk/openai",
      options: { baseURL: "https://hub.minimaxi.com/api/v1" },
      models: {
        gamma_high: {
          name: "Gamma",
          reasoning: true,
          attachment: true,
          tool_call: true,
          temperature: true,
          modalities: { input: ["text", "image"], output: ["text"] },
          limit: { context: 262000, input: 270000, output: 128000 },
          options: { store: false, reasoningEffort: "medium" },
          variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } },
        },
      },
    },
    omega: {
      name: "omega",
      npm: "@ai-sdk/google",
      options: { baseURL: "https://hub.minimaxi.com/api/v1" },
      models: {
        "omega-3.1-pro": {
          name: "omega-3.1-pro",
          limit: { context: 1000000, output: 65536 },
        },
      },
    },
  },
}

describe("crypto & desktop credential reading", () => {
  test("decryptV2Token decrypts valid AES-256-GCM payloads and rejects malformed/legacy values", () => {
    const key = randomBytes(32)
    const enc = encryptV2("secret-jwt-value", key)
    assert.equal(decryptV2Token(enc, key), "secret-jwt-value")
    assert.equal(decryptV2Token("plaintext-token", key), "plaintext-token")
    assert.throws(() => decryptV2Token("encrypted:abc", key), /safeStorage/)
    assert.throws(() => decryptV2Token("v2enc:onlytwo:parts", key), /格式异常/)
    assert.throws(() => decryptV2Token(enc, randomBytes(32)))
  })

  test("readDesktopCredentialFromDir reads token, groupId, deviceId, and decrypted LKG", () => {
    const { root, token } = makeTempDesktopDir({ lkgObj: SAMPLE_REMOTE_CONFIG })
    try {
      const cred = readDesktopCredentialFromDir(root, SITES["minimax-design"])
      assert.equal(cred.key, token)
      assert.equal(cred.userId, "10001")
      assert.equal(cred.userName, "Tester")
      assert.equal(cred.groupId, "20002")
      assert.equal(cred.deviceId, "dev-uuid-1")
      assert.equal(cred.region, "domestic")
      assert.ok(cred.lkgConfig?.provider?.minimaxHub)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects symlinked .token-key, expired JWT, and cross-region desktop configs", () => {
    const sym = makeTempDesktopDir({ symlinkKey: true })
    const exp = makeTempDesktopDir({ token: makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 }) })
    const globalCfg = makeTempDesktopDir({ adUrl: "https://design.minimax.io/landing" })
    try {
      assert.throws(() => readDesktopCredentialFromDir(sym.root, SITES["minimax-design"]), /常规文件/)
      assert.throws(() => readDesktopCredentialFromDir(exp.root, SITES["minimax-design"]), (err) => err.code === "expired")
      assert.throws(
        () => readDesktopCredentialFromDir(globalCfg.root, SITES["minimax-design"]),
        (err) => err.code === "region_mismatch" && err.detectedRegion === "overseas",
      )
      const ok = readDesktopCredentialFromDir(globalCfg.root, SITES["minimax-design-global"])
      assert.equal(ok.region, "overseas")
    } finally {
      rmSync(sym.root, { recursive: true, force: true })
      rmSync(exp.root, { recursive: true, force: true })
      rmSync(globalCfg.root, { recursive: true, force: true })
    }
  })

  test("candidateDataDirs uses platform path semantics and honors MINIMAX_DESIGN_DATA_DIR exclusively", () => {
    const macDirs = candidateDataDirs(SITES["minimax-design"], { homedir: "/Users/alice", platform: "darwin", env: {} })
    assert.equal(macDirs[0], posix.join("/Users/alice", "Library", "Application Support", "@hilo", "desktop"))
    const winDirs = candidateDataDirs(SITES["minimax-design-global"], {
      homedir: "C:\\Users\\alice",
      platform: "win32",
      env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" },
    })
    assert.equal(winDirs[0], win32.join("C:\\Users\\alice\\AppData\\Roaming", "MiniMax Hub Global"))
    // Explicit override returns ONLY the override path and never falls through to defaults
    const envDirs = candidateDataDirs(SITES["minimax-design"], {
      homedir: "/home/alice",
      platform: "linux",
      env: { MINIMAX_DESIGN_DATA_DIR: "/custom/hilo" },
    })
    assert.deepEqual(envDirs, ["/custom/hilo"])
  })

  test("readDesktopCredential respects MINIMAX_DESIGN_DATA_DIR and classifies missing vs unreadable", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "mm-empty-"))
    try {
      assert.throws(
        () =>
          readDesktopCredential(SITES["minimax-design"], {
            homedir: emptyRoot,
            platform: "darwin",
            env: { MINIMAX_DESIGN_DATA_DIR: join(emptyRoot, "nope") },
          }),
        (err) => err.code === "missing",
      )
      mkdirSync(join(emptyRoot, "bad"), { recursive: true })
      writeFileSync(join(emptyRoot, "bad", "hub-config.json"), "{not-json")
      assert.throws(
        () =>
          readDesktopCredential(SITES["minimax-design"], {
            homedir: emptyRoot,
            platform: "darwin",
            env: { MINIMAX_DESIGN_DATA_DIR: join(emptyRoot, "bad") },
          }),
        (err) => err.code === "unreadable",
      )
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true })
    }
  })
})

describe("model catalog & usage parsing", () => {
  test("parseRemoteConfig extracts multi-SDK models, preserves aliases vs apiId, clamps context, and handles empty catalogs", () => {
    const specs = parseRemoteConfig(SITES["minimax-design"], SAMPLE_REMOTE_CONFIG)
    assert.ok(Array.isArray(specs))
    const byId = Object.fromEntries(specs.map((s) => [s.id, s]))
    assert.equal(byId["MiniMax-M3.1-Flash"].npm, "@ai-sdk/anthropic")
    assert.equal(byId["MiniMax-M3.1-Flash"].name, "MiniMax M3.1 Flash")
    assert.equal(byId.alpha.npm, "@ai-sdk/anthropic")
    assert.equal(byId.gamma_high.npm, "@ai-sdk/openai")
    assert.equal(byId.gamma_high.limit.context, 270000)
    assert.equal(byId.gamma_high.options.store, false)
    assert.equal(byId["omega-3.1-pro"], undefined)

    // Catalog aliases sharing an upstream id remain distinct entries
    const aliased = parseRemoteConfig(SITES["minimax-design"], {
      enabled_providers: ["alpha"],
      provider: {
        alpha: {
          npm: "@ai-sdk/anthropic",
          options: { baseURL: "https://design.minimax.cn/api/v1" },
          models: {
            "alias-fast": { id: "shared-upstream", name: "Fast" },
            "alias-deep": { id: "shared-upstream", name: "Deep" },
          },
        },
      },
    })
    assert.equal(aliased.length, 2)
    assert.equal(aliased[0].id, "alias-fast")
    assert.equal(aliased[0].apiId, "shared-upstream")
    assert.equal(aliased[0].url, "https://design.minimax.cn/api/v1")
    assert.equal(aliased[1].id, "alias-deep")
    assert.equal(aliased[1].apiId, "shared-upstream")

    // Authoritative empty catalog returns [] (not null), malformed returns null
    assert.deepEqual(parseRemoteConfig(SITES["minimax-design"], { enabled_providers: [], provider: {} }), [])
    assert.equal(parseRemoteConfig(SITES["minimax-design"], null), null)
  })

  test("usageFromWallet and usageFromBalance omit fake used%, sum same-instant expiries, and handle team scope", () => {
    const now = Date.UTC(2026, 10, 26)
    const exp1 = Date.UTC(2026, 11, 25)
    const exp2 = Date.UTC(2027, 7, 10)
    const wallet = {
      wallets: [
        {
          source: 1,
          plan_name: "Design Plus 年会员",
          total_credit: "87145",
          end_time: "09/29/2027",
          next_credit_refresh_time: "12/24/2026",
          sub_credits: [
            {
              credit_type: 1,
              end_time: String(exp1),
              credit: "87000",
              records: [
                { end_time: String(exp1), credit: "10000" },
                { end_time: String(exp1), credit: "20000" },
                { end_time: String(exp2), credit: "57000" },
              ],
            },
            { credit_type: 0, end_time: String(exp2), credit: "145", records: [{ end_time: String(exp2), credit: "145" }] },
          ],
        },
      ],
    }
    const u = usageFromWallet(SITES["minimax-design"], wallet, now)
    assert.equal(u.plan, "Design Plus 年会员")
    assert.equal(u.until, "2027-09-29T00:00:00.000Z")
    assert.equal(u.balance, undefined)
    assert.equal(u.signIn, undefined)
    assert.equal(u.windows.length, 3)
    assert.equal(u.windows[0].used, undefined)
    assert.equal(u.windows[0].aside, undefined)
    assert.equal(u.windows[0].balance, 87145)
    assert.equal(u.windows[0].resetsAt, "2026-12-24T00:00:00.000Z")
    assert.equal(u.windows[1].name, "会员积分")
    assert.equal(u.windows[1].runsOutAt, new Date(exp1).toISOString())
    // Summed across both records sharing earliest expiry timestamp
    assert.equal(u.windows[1].runsOut, 30000)
    assert.equal(u.windows[1].aside, true)

    const renewed = usageFromWallet(SITES["minimax-design"], wallet, now, { renewed: true })
    assert.equal(renewed.signIn, "renewed")

    // Team-scoped balance fallback prioritizes team_credit without aside/used
    const teamBal = usageFromBalance(SITES["minimax-design"], { total_credit: "500", team_credit: "200" }, { hasGroupId: true })
    assert.equal(teamBal.windows[0].name, "团队积分")
    assert.equal(teamBal.windows[0].balance, 200)
    assert.equal(teamBal.windows[0].aside, undefined)
    assert.equal(teamBal.windows[0].used, undefined)
    assert.equal(teamBal.windows[1].name, "总积分")
    assert.equal(teamBal.windows[1].aside, true)
  })

  test("helper functions parse dates, versions, regions, and JWT expiration", () => {
    assert.equal(normalizeVersionCode("v4.0.18-beta.1"), "4.0.18")
    assert.equal(parseDateIso("09/29/2027"), "2027-09-29T00:00:00.000Z")
    assert.equal(parseDateIso("0"), undefined)
    assert.equal(isExpiredJwt(makeJwt({ exp: 1000 }), 2_000_000), true)
    assert.equal(isExpiredJwt(makeJwt({ exp: 9_999_999_999 }), 2_000_000), false)
    assert.equal(inferRegionFromConfig({ tokens: { adAttribution: { url: "https://design.minimax.io/" } } }, null, ""), "overseas")
  })
})

describe("plugin runtime: auth, loader, models, usage, security guards", () => {
  test("desktop login, live models, loader omits baseURL, enforces store:false even when store:true, and retries 401 on disk rotation", async () => {
    const dirObj = makeTempDesktopDir({ lkgObj: SAMPLE_REMOTE_CONFIG })
    const calls = []
    let failFirstLlm = true
    const rotatedToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 7200, rot: 2 })

    const fakeFetch = async (url, init = {}) => {
      const u = String(url)
      const h = new Headers(init.headers)
      calls.push({ url: u, token: h.get("token"), version: h.get("version_code"), groupId: h.get("X-Group-Id"), body: init.body })

      if (u.endsWith("/api/v1/account/profile")) {
        return new Response(JSON.stringify({ uid: "10001", user_name: "Alice", account: "alice" }), { status: 200 })
      }
      if (u.endsWith("/api/v1/config")) {
        return new Response(JSON.stringify(SAMPLE_REMOTE_CONFIG), { status: 200 })
      }
      if (u.endsWith("/api/v1/credit/wallet")) {
        return new Response(JSON.stringify({ wallets: [{ source: 1, plan_name: "Design Plus", total_credit: "1234", sub_credits: [] }] }), { status: 200 })
      }
      if (u.endsWith("/responses")) {
        if (failFirstLlm) {
          failFirstLlm = false
          const updatedCfg = {
            ...dirObj.cfg,
            tokens: { ...dirObj.cfg.tokens, accessToken: encryptV2(rotatedToken, dirObj.keyBuf) },
          }
          writeFileSync(join(dirObj.root, "hub-config.json"), JSON.stringify(updatedCfg))
          return new Response(JSON.stringify({ error: { message: "invalid token" } }), { status: 401 })
        }
        return new Response(JSON.stringify({ id: "resp_1", status: "completed" }), { status: 200 })
      }
      return new Response("not found", { status: 404 })
    }

    try {
      const hooks = createPlugin(SITES["minimax-design"], {
        fetchImpl: fakeFetch,
        env: { MINIMAX_DESIGN_DATA_DIR: dirObj.root },
        versionCode: "4.0.18",
      })

      const authStart = await hooks.auth.methods[0].authorize()
      assert.equal(authStart.url, "")
      const signed = await authStart.callback()
      assert.equal(signed.type, "success")
      assert.equal(signed.accountId, "10001")
      assert.equal(signed.metadata.name, "Alice")
      assert.equal(signed.metadata.groupId, "20002")

      const storedAuth = { type: "api", key: signed.key, metadata: signed.metadata }

      const cfg = { provider: {} }
      await hooks.config(cfg)
      const models = await hooks.provider.models({ id: "minimax-design", models: cfg.provider["minimax-design"].models }, { auth: storedAuth })
      assert.ok(models["MiniMax-M3.1-Flash"])
      assert.ok(models.gamma_high)
      assert.equal(models.gamma_high.api.npm, "@ai-sdk/openai")
      assert.equal(models["omega-3.1-pro"], undefined)

      // Loader preserves per-model URLs by omitting baseURL override
      const loaded = await hooks.auth.loader(async () => storedAuth)
      assert.equal(loaded.baseURL, undefined)

      // Explicitly passing store:true is normalized to store:false
      const res = await loaded.fetch("https://hub.minimaxi.com/api/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gamma_high", store: true, input: "hi" }),
      })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get("X-Magpie-Sign-In"), "renewed")
      const respCalls = calls.filter((c) => c.url.endsWith("/responses"))
      assert.equal(respCalls.length, 2)
      assert.equal(respCalls[0].token, dirObj.token)
      assert.equal(respCalls[0].version, "4.0.18")
      assert.equal(respCalls[0].groupId, "20002")
      assert.equal(JSON.parse(respCalls[0].body).store, false)
      assert.equal(respCalls[1].token, rotatedToken)

      // Usage reads wallet and reports renewed since live token differs from saved key
      const usage = await hooks.auth.usage(async () => storedAuth)
      assert.equal(usage.plan, "Design Plus")
      assert.equal(usage.windows[0].balance, 1234)
      assert.equal(usage.signIn, "renewed")
    } finally {
      rmSync(dirObj.root, { recursive: true, force: true })
    }
  })

  test("cached desktop token never leaks across accounts and clearing groupId on disk clears X-Group-Id", async () => {
    const dirObj = makeTempDesktopDir({ userID: "20002", groupId: "team-99" })
    const userAToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 7200, who: "userA" })
    const seen = []

    const hooks = createPlugin(SITES["minimax-design"], {
      fetchImpl: async (_url, init) => {
        const h = new Headers(init.headers)
        seen.push({ token: h.get("token"), groupId: h.get("X-Group-Id") })
        return new Response("{}", { status: 200 })
      },
      env: { MINIMAX_DESIGN_DATA_DIR: dirObj.root },
    })

    try {
      const authB = { type: "api", key: dirObj.token, metadata: { userId: "20002", groupId: "team-99", dataDir: dirObj.root, method: "desktop" } }
      const authA = { type: "api", key: userAToken, metadata: { userId: "10001", groupId: "team-11", dataDir: dirObj.root, method: "desktop" } }

      // 1. Account B populates diskCache with user 20002's token
      const loadedB = await hooks.auth.loader(async () => authB)
      await loadedB.fetch("https://hub.minimaxi.com/api/v1/messages", { method: "POST", body: "{}" })
      assert.equal(seen[0].token, dirObj.token)
      assert.equal(seen[0].groupId, "team-99")

      // 2. Account A hits same dataDir while diskCache is warm -> MUST NOT get B's token!
      const loadedA = await hooks.auth.loader(async () => authA)
      await loadedA.fetch("https://hub.minimaxi.com/api/v1/messages", { method: "POST", body: "{}" })
      assert.equal(seen[1].token, userAToken)
      assert.equal(seen[1].groupId, "team-11")

      // 3. Account B clears selectedGroupIds on disk -> X-Group-Id MUST be cleared (not fall back to team-99)
      writeFileSync(
        join(dirObj.root, "hub-config.json"),
        JSON.stringify({ ...dirObj.cfg, selectedGroupIds: {} }),
      )
      // Bump mtime explicitly via a second write or force cache miss by changing mtime
      const updatedTime = new Date(Date.now() + 5000)
      const { utimesSync } = await import("node:fs")
      utimesSync(join(dirObj.root, "hub-config.json"), updatedTime, updatedTime)

      await loadedB.fetch("https://hub.minimaxi.com/api/v1/messages", { method: "POST", body: "{}" })
      assert.equal(seen[2].token, dirObj.token)
      assert.equal(seen[2].groupId, null)
    } finally {
      rmSync(dirObj.root, { recursive: true, force: true })
    }
  })

  test("authoritative empty remote catalog returns {} instead of bootstrap models", async () => {
    const validJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    const hooks = createPlugin(SITES["minimax-design"], {
      fetchImpl: async () => new Response(JSON.stringify({ enabled_providers: [], provider: {} }), { status: 200 }),
    })
    const cfg = { provider: {} }
    await hooks.config(cfg)
    const models = await hooks.provider.models(
      { id: "minimax-design", models: cfg.provider["minimax-design"].models },
      { auth: { type: "api", key: validJwt } },
    )
    assert.deepEqual(models, {})
  })

  test("waitForDesktopCredential handles polling until ready and abort cancellation", async () => {
    let tries = 0
    const ready = await waitForDesktopCredential({
      read: () => (++tries < 3 ? { error: { code: "missing" } } : { cred: { key: "tok" } }),
      sleep: async () => {},
      now: () => tries * 1000,
    })
    assert.equal(ready.status, "ready")
    assert.equal(ready.cred.key, "tok")

    const ac = new AbortController()
    ac.abort()
    const aborted = await waitForDesktopCredential({
      read: () => ({ error: { code: "missing" } }),
      sleep: async () => {},
      now: () => 0,
      signal: ac.signal,
    })
    assert.equal(aborted.status, "aborted")
  })

  test("siteFetch blocks untrusted destinations, HTTPS downgrades, and cross-host redirects", async () => {
    // Untrusted external host blocked before fetch is called
    let called = false
    await assert.rejects(
      () =>
        siteFetch(
          SITES["minimax-design"],
          "https://evil.example.com/api/v1/messages",
          {},
          {
            fetchImpl: async () => {
              called = true
              return new Response("ok")
            },
          },
        ),
      /untrusted destination/,
    )
    assert.equal(called, false)

    // Plain HTTP rejected
    await assert.rejects(
      () => siteFetch(SITES["minimax-design"], "http://hub.minimaxi.com/api/v1/messages", {}, { fetchImpl: async () => new Response("ok") }),
      /untrusted destination/,
    )

    // Same-host HTTPS -> HTTP downgrade rejected
    await assert.rejects(
      () =>
        siteFetch(
          SITES["minimax-design"],
          "https://hub.minimaxi.com/api/v1/messages",
          {},
          {
            fetchImpl: async () => new Response(null, { status: 307, headers: { location: "http://hub.minimaxi.com/api/v1/messages" } }),
          },
        ),
      /insecure redirect/,
    )

    // Cross-host redirect throws OtherSite
    await assert.rejects(
      () =>
        siteFetch(
          SITES["minimax-design-global"],
          "https://design.minimax.io/api/v1/config",
          {},
          {
            fetchImpl: async () =>
              new Response(null, { status: 307, headers: { location: "https://design.minimax.cn/api/v1/config" } }),
          },
        ),
      (err) => err instanceof OtherSite && err.to === "design.minimax.cn",
    )

    const quota = await normalizeUpstreamResponse(
      SITES["minimax-design"],
      new Response(JSON.stringify({ error: { message: "积分余额不足" } }), { status: 403 }),
      false,
    )
    assert.equal(quota.status, 429)
    assert.equal(quota.headers.get("X-Magpie-Sign-In"), "kept")

    const upgrade = await normalizeUpstreamResponse(
      SITES["minimax-design"],
      new Response(JSON.stringify({ error: { code: "client_upgrade_required", message: "upgrade required" } }), { status: 403 }),
      false,
    )
    assert.equal(upgrade.status, 403)
    assert.equal(upgrade.headers.get("X-Magpie-Sign-In"), "kept")
    assert.match(await upgrade.text(), /MINIMAX_DESIGN_VERSION_CODE/)
  })

  test("opencode 1.x and 2.x entry points conform to magpie-community/plugins contract", async () => {
    const entries = Object.entries(opencode1)
    assert.equal(entries.length, 2)
    for (const [name, fn] of entries) {
      assert.equal(typeof fn, "function", `${name} must be a function`)
      const hooks = await fn()
      assert.ok(hooks.auth?.provider)
      assert.equal(hooks.auth.methods.length, 2)
      assert.equal(hooks.auth.methods[0].type, "oauth")
      assert.equal(hooks.auth.methods[1].type, "api")
      assert.equal(hooks.auth.methods[1].prompts, undefined)
      assert.equal(hooks.auth.methods[1].authorize, undefined)
      assert.equal(typeof hooks.auth?.loader, "function")
      assert.equal(typeof hooks.auth?.usage, "function")
      const cfg = { provider: {} }
      await hooks.config(cfg)
      const p = cfg.provider[hooks.auth.provider]
      assert.ok(p?.npm)
      assert.ok(Object.keys(p.models).length > 0)
    }

    assert.equal(typeof opencode2.id, "string")
    assert.equal(typeof opencode2.setup, "function")
  })
})
