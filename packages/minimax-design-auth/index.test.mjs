import assert from "node:assert/strict"
import { createCipheriv, randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix, win32 } from "node:path"
import { describe, test } from "node:test"
import * as opencode1 from "./opencode.mjs"
import opencode2 from "./opencode2.mjs"
import { _internal } from "./index.mjs"

const {
  SITES,
  MODELS_TTL_MS,
  OWNER_VERIFY_FAIL_TTL_MS,
  OWNER_CACHE_MAX,
  OtherSite,
  createPlugin,
  decryptV2Token,
  candidateDataDirs,
  inferRegionFromConfig,
  readDesktopCredentialFromDir,
  readDesktopCredential,
  waitForDesktopCredential,
  parseRemoteConfig,
  parseModelsConfig,
  usageFromWallet,
  usageFromBalance,
  normalizeUpstreamResponse,
  normalizeVersionCode,
  parseDateIso,
  isExpiredJwt,
  jwtOwnerId,
  siteFetch,
  _mediaInternal,
} = _internal

const TEST_VERSION = "4.0.18"

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
  token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, user: { id: "owner-10001" } }),
  userID = "10001",
  userName = "Tester",
  groupId = "20002",
  deviceId = "dev-uuid-1",
  lkgObj = null,
  adUrl = "https://design.minimax.cn/",
  rawAccessOverride = null,
  skipKey = false,
  symlinkKey = false,
  configFile = "hub-config.json",
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
    selectedGroupIds: groupId && userID !== undefined ? { [String(userID)]: groupId } : {},
    deviceId,
    ...(lkgObj ? { lkgProviderConfig: encryptV2(JSON.stringify(lkgObj), keyBuf) } : {}),
  }
  writeFileSync(join(root, configFile), JSON.stringify(cfg))
  return { root, keyBuf, token, cfg, configFile }
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
  test("decryptV2Token decrypts valid AES-256-GCM, rejects short tags/legacy/malformed, and localizes errors", () => {
    const key = randomBytes(32)
    const enc = encryptV2("secret-jwt-value", key)
    assert.equal(decryptV2Token(enc, key, "zh"), "secret-jwt-value")
    assert.equal(decryptV2Token("plaintext-token", key, "en"), "plaintext-token")
    assert.throws(() => decryptV2Token("encrypted:abc", key, "zh"), /safeStorage/)
    assert.throws(() => decryptV2Token("encrypted:abc", key, "en"), /legacy safeStorage/)
    assert.throws(() => decryptV2Token("v2enc:onlytwo:parts", key, "en"), /Malformed v2enc/)
    assert.throws(() => decryptV2Token(enc, randomBytes(32), "en"))

    // Regression: truncated GCM AuthTag (< 16 bytes) MUST be rejected even if OpenSSL accepts short tags
    const iv = randomBytes(16)
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 12 })
    const ct = Buffer.concat([cipher.update("short-tag-secret", "utf8"), cipher.final()])
    const shortTag = cipher.getAuthTag()
    assert.equal(shortTag.length, 12)
    const shortEnc = `v2enc:${iv.toString("base64")}:${shortTag.toString("base64")}:${ct.toString("base64")}`
    assert.throws(() => decryptV2Token(shortEnc, key, "en"), /16-byte AuthTag/)
  })

  test("readDesktopCredentialFromDir reads token, numeric userID, groupId, deviceId, LKG, and Global hub-config-global.json", () => {
    const cn = makeTempDesktopDir({ lkgObj: SAMPLE_REMOTE_CONFIG, userID: 10001, groupId: 20002 })
    const gl = makeTempDesktopDir({
      configFile: "hub-config-global.json",
      adUrl: null,
      userID: "777",
      groupId: "888",
    })
    try {
      const cred = readDesktopCredentialFromDir(cn.root, SITES["minimax-design"])
      assert.equal(cred.key, cn.token)
      assert.equal(cred.userId, "10001")
      assert.equal(cred.groupId, "20002")
      assert.equal(cred.tokenOwnerId, "owner-10001")
      assert.equal(cred.configFile, "hub-config.json")
      assert.equal(cred.region, "domestic")
      assert.ok(cred.lkgConfig?.provider?.minimaxHub)

      // Global client uses hub-config-global.json and infers overseas region
      const gCred = readDesktopCredentialFromDir(gl.root, SITES["minimax-design-global"])
      assert.equal(gCred.key, gl.token)
      assert.equal(gCred.userId, "777")
      assert.equal(gCred.groupId, "888")
      assert.equal(gCred.configFile, "hub-config-global.json")
      assert.equal(gCred.region, "overseas")
      assert.equal(gCred.regionConfirmed, true)
    } finally {
      rmSync(cn.root, { recursive: true, force: true })
      rmSync(gl.root, { recursive: true, force: true })
    }
  })

  test("classifies missing .token-key alongside v2enc token as unreadable (not missing) and localizes English errors", () => {
    const noKey = makeTempDesktopDir({ skipKey: true, adUrl: null })
    try {
      assert.throws(
        () =>
          readDesktopCredential(SITES["minimax-design"], {
            env: { MINIMAX_DESIGN_DATA_DIR: noKey.root },
          }),
        (err) => err.code === "unreadable" && /\.token-key/.test(err.message),
      )
      assert.throws(
        () =>
          readDesktopCredential(SITES["minimax-design-global"], {
            env: { MINIMAX_DESIGN_DATA_DIR: noKey.root },
          }),
        (err) => err.code === "unreadable" && /Missing \.token-key/.test(err.message) && !/[\u4e00-\u9fff]/.test(err.message),
      )
    } finally {
      rmSync(noKey.root, { recursive: true, force: true })
    }
  })

  test("rejects symlinked .token-key, expired JWT, and cross-region desktop configs", () => {
    const sym = makeTempDesktopDir({ symlinkKey: true })
    const exp = makeTempDesktopDir({ token: makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 }) })
    const globalCfg = makeTempDesktopDir({ adUrl: "https://design.minimax.io/landing" })
    try {
      assert.throws(() => readDesktopCredentialFromDir(sym.root, SITES["minimax-design"]), /常规文件/)
      assert.throws(() => readDesktopCredentialFromDir(sym.root, SITES["minimax-design-global"]), /regular file/)
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
    const envDirs = candidateDataDirs(SITES["minimax-design"], {
      homedir: "/home/alice",
      platform: "linux",
      env: { MINIMAX_DESIGN_DATA_DIR: "/custom/hilo" },
    })
    assert.deepEqual(envDirs, ["/custom/hilo"])
  })

  test("readDesktopCredential classifies missing vs unreadable", () => {
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
  test("parseRemoteConfig extracts multi-SDK models, maps compliance aliases to canonical names, sanitizes untrusted baseURL, and handles empty catalogs", () => {
    const specs = parseRemoteConfig(SITES["minimax-design"], SAMPLE_REMOTE_CONFIG)
    assert.ok(Array.isArray(specs))
    const byId = Object.fromEntries(specs.map((s) => [s.id, s]))
    assert.equal(byId["MiniMax-M3.1-Flash"].npm, "@ai-sdk/anthropic")
    assert.equal(byId["MiniMax-M3.1-Flash"].name, "MiniMax M3.1 Flash")
    assert.equal(byId["claude-opus-5-5"].npm, "@ai-sdk/anthropic")
    assert.equal(byId["claude-opus-5-5"].apiId, "alpha")
    assert.equal(byId["claude-opus-5-5"].name, "Claude Opus 5.5")
    assert.equal(byId.alpha, undefined)
    assert.equal(byId["gpt-5.5-high"].npm, "@ai-sdk/openai")
    assert.equal(byId["gpt-5.5-high"].apiId, "gamma_high")
    assert.equal(byId["gpt-5.5-high"].name, "GPT-5.5 High")
    assert.equal(byId["gpt-5.5-high"].limit.context, 270000)
    assert.equal(byId["gpt-5.5-high"].options.store, false)
    assert.equal(byId["omega-3.1-pro"], undefined)

    // Non-allowlisted baseURL in remote config falls back to site.defaultLlmBase
    const untrusted = parseRemoteConfig(SITES["minimax-design"], {
      enabled_providers: ["alpha"],
      provider: {
        alpha: {
          npm: "@ai-sdk/anthropic",
          options: { baseURL: "https://evil.example.com/api/v1" },
          models: {
            "alias-fast": { id: "shared-upstream", name: "Fast" },
            "alias-deep": { id: "shared-upstream", name: "Deep" },
          },
        },
      },
    })
    assert.equal(untrusted.length, 2)
    assert.equal(untrusted[0].url, SITES["minimax-design"].defaultLlmBase)
    assert.equal(untrusted[0].id, "alias-fast")
    assert.equal(untrusted[0].apiId, "shared-upstream")
    assert.equal(untrusted[1].id, "alias-deep")

    assert.deepEqual(parseRemoteConfig(SITES["minimax-design"], { enabled_providers: [], provider: {} }), [])
    assert.equal(parseRemoteConfig(SITES["minimax-design"], null), null)
  })

  test("usageFromWallet and usageFromBalance emit numeric balance primary window, handle 0 credits, never fabricate 0/Free, and sum same-instant expiries", () => {
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
    // Primary numeric balance window (for routing) + 2 aside sub-credit breakdowns
    assert.equal(u.windows.length, 3)
    assert.deepEqual(u.windows[0], { name: "积分", balance: 87145, unit: "积分" })
    assert.equal(u.windows[0].used, undefined)
    assert.equal(u.windows[0].limit, undefined)
    assert.equal(u.windows[0].aside, undefined)
    assert.equal(u.windows[1].name, "会员积分")
    assert.equal(u.windows[1].aside, true)
    assert.equal(u.windows[1].used, undefined)
    assert.equal(u.windows[1].balance, undefined)
    assert.equal(u.windows[1].runsOutAt, new Date(exp1).toISOString())
    assert.equal(u.windows[1].runsOut, 30000)
    assert.equal(u.windows[2].name, "充值积分")
    assert.equal(u.windows[2].aside, true)

    // 0-credit account must expose primary window with balance: 0 so magpie stops routing to it
    const zero = usageFromWallet(SITES["minimax-design"], { wallets: [{ source: 1, plan_name: "Plus", total_credit: "0", sub_credits: [] }] }, now)
    assert.equal(zero.plan, "Plus")
    assert.deepEqual(zero.windows, [{ name: "积分", balance: 0, unit: "积分" }])

    // Missing total_credit returns null (never 0 / Free); missing plan_name omits plan
    assert.equal(usageFromWallet(SITES["minimax-design"], { wallets: [{ source: 1 }] }, now), null)
    const noPlan = usageFromWallet(SITES["minimax-design"], { wallets: [{ source: 1, total_credit: "50" }] }, now)
    assert.equal(noPlan.plan, undefined)
    assert.deepEqual(noPlan.windows, [{ name: "积分", balance: 50, unit: "积分" }])

    const renewed = usageFromWallet(SITES["minimax-design"], wallet, now, { renewed: true })
    assert.equal(renewed.signIn, "renewed")

    // Team-scoped balance fallback puts team_credit in numeric balance primary window and total_credit aside
    const teamBal = usageFromBalance(SITES["minimax-design"], { total_credit: "500", team_credit: "200" }, { hasGroupId: true })
    assert.equal(teamBal.balance, undefined)
    assert.deepEqual(teamBal.windows[0], { name: "团队积分", balance: 200, unit: "积分" })
    assert.equal(teamBal.windows[1].name, "总积分")
    assert.equal(teamBal.windows[1].aside, true)
    assert.equal(teamBal.windows[1].used, undefined)
  })

  test("helper functions parse dates, versions, regions, JWT owner, and expiration", () => {
    assert.equal(normalizeVersionCode("v4.0.18-beta.1"), "4.0.18")
    assert.equal(parseDateIso("09/29/2027"), "2027-09-29T00:00:00.000Z")
    assert.equal(parseDateIso("0"), undefined)
    assert.equal(isExpiredJwt(makeJwt({ exp: 1000 }), 2_000_000), true)
    assert.equal(isExpiredJwt(makeJwt({ exp: 9_999_999_999 }), 2_000_000), false)
    assert.equal(jwtOwnerId(makeJwt({ user: { id: "u-xyz" } })), "u-xyz")
    assert.equal(inferRegionFromConfig({ tokens: { adAttribution: { url: "https://design.minimax.io/" } } }, null, "", "hub-config.json"), "overseas")
    assert.equal(inferRegionFromConfig({}, null, "", "hub-config-global.json"), "overseas")
  })
})

describe("plugin runtime: auth, loader, models, usage, security & race guards", () => {
  test("desktop login, 5m model cache, loader store:false, and auth-403 disk-rotation retry with ownership verification", async () => {
    const dirObj = makeTempDesktopDir({ lkgObj: SAMPLE_REMOTE_CONFIG })
    const calls = []
    let failFirstLlm = true
    let configCalls = 0
    let fakeNow = Date.now()
    const rotatedToken = makeJwt({ exp: Math.floor(fakeNow / 1000) + 7200, user: { id: "owner-10001" }, rot: 2 })

    const fakeFetch = async (url, init = {}) => {
      const u = String(url)
      const h = new Headers(init.headers)
      calls.push({ url: u, token: h.get("token"), version: h.get("version_code"), groupId: h.get("X-Group-Id"), body: init.body })

      if (u.endsWith("/api/v1/account/profile")) {
        return new Response(JSON.stringify({ uid: "10001", user_name: "Alice", account: "alice" }), { status: 200 })
      }
      if (u.endsWith("/api/v1/config")) {
        configCalls++
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
          const t = new Date(fakeNow + 2000)
          utimesSync(join(dirObj.root, "hub-config.json"), t, t)
          // Auth-related 403 must also trigger desktop disk refresh + retry
          return new Response(JSON.stringify({ error: { message: "invalid access token" } }), { status: 403 })
        }
        return new Response(JSON.stringify({ id: "resp_1", status: "completed" }), { status: 200 })
      }
      return new Response("not found", { status: 404 })
    }

    try {
      const hooks = createPlugin(SITES["minimax-design"], {
        fetchImpl: fakeFetch,
        env: { MINIMAX_DESIGN_DATA_DIR: dirObj.root },
        versionCode: TEST_VERSION,
        nowMsImpl: () => fakeNow,
      })

      const authStart = await hooks.auth.methods[0].authorize()
      assert.equal(authStart.url, "")
      const signed = await authStart.callback()
      assert.equal(signed.type, "success")
      assert.equal(signed.accountId, "10001")
      assert.equal(signed.metadata.name, "Alice")
      assert.equal(signed.metadata.groupId, "20002")
      assert.equal(signed.metadata.configFile, "hub-config.json")

      const storedAuth = { type: "api", key: signed.key, metadata: signed.metadata }

      // Model catalog: 5-minute TTL cache hit then expiry re-fetch
      const cfg = { provider: {} }
      await hooks.config(cfg)
      const prov = { id: "minimax-design", models: cfg.provider["minimax-design"].models }
      const models1 = await hooks.provider.models(prov, { auth: storedAuth })
      const models2 = await hooks.provider.models(prov, { auth: storedAuth })
      assert.equal(configCalls, 1)
      assert.ok(models1["MiniMax-M3.1-Flash"] && models2["gpt-5.5-high"])
      assert.equal(models2["gpt-5.5-high"].api.id, "gamma_high")
      assert.equal(models2["claude-opus-5-5"].api.id, "alpha")
      assert.ok(models2["gpt-image-2.6-sunburst"] && models2["MiniMax-H3"])
      fakeNow += MODELS_TTL_MS + 1000
      await hooks.provider.models(prov, { auth: storedAuth })
      assert.equal(configCalls, 2)

      // Loader omits baseURL, enforces store:false even when store:true, maps canonical model ID to upstream apiId, retries auth-403 on disk rotation
      const loaded = await hooks.auth.loader(async () => storedAuth)
      assert.equal(loaded.baseURL, undefined)

      const res = await loaded.fetch("https://hub.minimaxi.com/api/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5-high", store: true, input: "hi" }),
      })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get("X-Magpie-Sign-In"), "renewed")
      const respCalls = calls.filter((c) => c.url.endsWith("/responses"))
      assert.equal(respCalls.length, 2)
      assert.equal(respCalls[0].token, dirObj.token)
      assert.equal(respCalls[0].version, TEST_VERSION)
      assert.equal(respCalls[0].groupId, "20002")
      assert.equal(JSON.parse(respCalls[0].body).store, false)
      assert.equal(JSON.parse(respCalls[0].body).model, "gamma_high")
      assert.equal(respCalls[1].token, rotatedToken)

      const usage = await hooks.auth.usage(async () => storedAuth)
      assert.equal(usage.plan, "Design Plus")
      assert.deepEqual(usage.windows, [{ name: "积分", balance: 1234, unit: "积分" }])
      assert.equal(usage.signIn, "renewed")
    } finally {
      rmSync(dirObj.root, { recursive: true, force: true })
    }
  })

  test("offline provider.models falls back to local decrypted lkgProviderConfig", async () => {
    const customLkg = {
      enabled_providers: ["minimaxHub"],
      provider: {
        minimaxHub: {
          npm: "@ai-sdk/anthropic",
          options: { baseURL: "https://hub.minimaxi.com/api/v1" },
          models: {
            "LKG-Only-Model": { name: "LKG Model", limit: { context: 128000, output: 16384 } },
          },
        },
      },
    }
    const dirObj = makeTempDesktopDir({ lkgObj: customLkg })
    try {
      const hooks = createPlugin(SITES["minimax-design"], {
        fetchImpl: async () => {
          throw new Error("network down")
        },
        env: { MINIMAX_DESIGN_DATA_DIR: dirObj.root },
        versionCode: TEST_VERSION,
      })
      const cfg = { provider: {} }
      await hooks.config(cfg)
      const storedAuth = {
        type: "api",
        key: dirObj.token,
        metadata: { userId: "10001", dataDir: dirObj.root, configFile: "hub-config.json", method: "desktop" },
      }
      const models = await hooks.provider.models(
        { id: "minimax-design", models: cfg.provider["minimax-design"].models },
        { auth: storedAuth },
      )
      assert.ok(models["LKG-Only-Model"])
      assert.equal(models["MiniMax-M3.1-Flash"], undefined)
    } finally {
      rmSync(dirObj.root, { recursive: true, force: true })
    }
  })

  test("prevents cross-account charging on cache hit, fresh mtime re-read, missing userId, and persistAuthTokens mid-switch race", async () => {
    const dirObj = makeTempDesktopDir({
      userID: "20002",
      groupId: "team-99",
      token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 7200, user: { id: "owner-20002" } }),
    })
    const userAToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 7200, user: { id: "owner-10001" } })
    const userCToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 7200, user: { id: "owner-30003" } })
    const seen = []
    let profileCalls = 0

    const hooks = createPlugin(SITES["minimax-design"], {
      fetchImpl: async (url, init) => {
        const u = String(url)
        const h = new Headers(init.headers)
        const tok = h.get("token")
        if (u.endsWith("/api/v1/account/profile")) {
          profileCalls++
          const uid = tok === userCToken ? "30003" : tok === dirObj.token ? "20002" : "10001"
          return new Response(JSON.stringify({ uid, user_name: `User ${uid}` }), { status: 200 })
        }
        seen.push({ token: tok, groupId: h.get("X-Group-Id") })
        return new Response("{}", { status: 200 })
      },
      env: { MINIMAX_DESIGN_DATA_DIR: dirObj.root },
      versionCode: TEST_VERSION,
    })

    const bumpWrite = (nextCfg, offsetMs) => {
      writeFileSync(join(dirObj.root, "hub-config.json"), JSON.stringify(nextCfg))
      const t = new Date(Date.now() + offsetMs)
      utimesSync(join(dirObj.root, "hub-config.json"), t, t)
    }

    try {
      const authB = {
        type: "api",
        key: dirObj.token,
        metadata: { userId: "20002", tokenOwnerId: "owner-20002", groupId: "team-99", dataDir: dirObj.root, configFile: "hub-config.json", method: "desktop" },
      }
      const authA = {
        type: "api",
        key: userAToken,
        metadata: { userId: "10001", tokenOwnerId: "owner-10001", groupId: "team-11", dataDir: dirObj.root, configFile: "hub-config.json", method: "desktop" },
      }

      // 1. Account B populates diskCache
      const loadedB = await hooks.auth.loader(async () => authB)
      await loadedB.fetch("https://hub.minimaxi.com/api/v1/messages", { method: "POST", body: "{}" })
      assert.equal(seen[0].token, dirObj.token)
      assert.equal(seen[0].groupId, "team-99")

      // 2. Account A hits warm diskCache -> MUST keep A's saved token
      const loadedA = await hooks.auth.loader(async () => authA)
      await loadedA.fetch("https://hub.minimaxi.com/api/v1/messages", { method: "POST", body: "{}" })
      assert.equal(seen[1].token, userAToken)

      // 3. Saved auth without expected userId MUST NOT reuse desktop token (even if desktop userID is also missing)
      const anonDir = makeTempDesktopDir({
        userID: null,
        token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 7200, anon: 1 }),
      })
      try {
        const authNoUser = {
          type: "api",
          key: userAToken,
          metadata: { dataDir: anonDir.root, configFile: "hub-config.json", method: "desktop" },
        }
        const loadedNoUser = await hooks.auth.loader(async () => authNoUser)
        await loadedNoUser.fetch("https://hub.minimaxi.com/api/v1/messages", { method: "POST", body: "{}" })
        assert.equal(seen[2].token, userAToken)
        assert.equal(profileCalls, 0)
      } finally {
        rmSync(anonDir.root, { recursive: true, force: true })
      }

      // 4. Desktop switches to user C (mtime changes -> fresh disk read) -> rejected locally via fresh.userId check
      //    without trusting C's groupId or even probing profile
      bumpWrite(
        {
          ...dirObj.cfg,
          user: { userID: "30003", userName: "Carol" },
          selectedGroupIds: { "30003": "team-carol" },
          tokens: { ...dirObj.cfg.tokens, accessToken: encryptV2(dirObj.token, dirObj.keyBuf) },
        },
        4000,
      )
      await loadedB.fetch("https://hub.minimaxi.com/api/v1/messages", { method: "POST", body: "{}" })
      assert.equal(seen[3].token, dirObj.token)
      assert.equal(seen[3].groupId, "team-99")
      assert.equal(profileCalls, 0)

      // 5a. Mid-switch race with mismatched JWT claims.user.id -> rejected immediately WITHOUT hitting profile
      bumpWrite(
        { ...dirObj.cfg, user: { userID: "20002", userName: "Bob" }, tokens: { ...dirObj.cfg.tokens, accessToken: encryptV2(userCToken, dirObj.keyBuf) } },
        6000,
      )
      await loadedB.fetch("https://hub.minimaxi.com/api/v1/messages", { method: "POST", body: "{}" })
      assert.equal(seen[4].token, dirObj.token)
      assert.equal(profileCalls, 0)

      // 5b. Mid-switch race where JWT omits user.id so profile check must fire -> rejected by profile uid!
      const raceTokenNoJwtUser = makeJwt({ exp: Math.floor(Date.now() / 1000) + 7200, race: 1 })
      bumpWrite(
        { ...dirObj.cfg, user: { userID: "20002", userName: "Bob" }, tokens: { ...dirObj.cfg.tokens, accessToken: encryptV2(raceTokenNoJwtUser, dirObj.keyBuf) } },
        8000,
      )
      await loadedB.fetch("https://hub.minimaxi.com/api/v1/messages", { method: "POST", body: "{}" })
      assert.equal(seen[5].token, dirObj.token)
      assert.equal(profileCalls, 1)

      // 6. Account B returns with same token and clears selectedGroupIds -> X-Group-Id MUST clear
      bumpWrite({ ...dirObj.cfg, selectedGroupIds: {} }, 12000)
      await loadedB.fetch("https://hub.minimaxi.com/api/v1/messages", { method: "POST", body: "{}" })
      assert.equal(seen[6].token, dirObj.token)
      assert.equal(seen[6].groupId, null)
    } finally {
      rmSync(dirObj.root, { recursive: true, force: true })
    }
  })

  test("usage retries desktop rotation on 403 and negative-caches transient owner-profile failures for 30s", async () => {
    let fakeNow = Date.now()
    const dirObj = makeTempDesktopDir({
      userID: "10001",
      token: makeJwt({ exp: Math.floor(fakeNow / 1000) + 7200, user: { id: "owner-10001" }, v: 1 }),
    })
    const rotated = makeJwt({ exp: Math.floor(fakeNow / 1000) + 7200, user: { id: "owner-10001" }, v: 2 })
    const rotated2 = makeJwt({ exp: Math.floor(fakeNow / 1000) + 7200, user: { id: "owner-10001" }, v: 3 })
    let failWallet403 = true
    let failProfile = false
    let activeWalletToken = rotated
    let profileAttempts = 0
    const walletTokens = []

    const hooks = createPlugin(SITES["minimax-design"], {
      fetchImpl: async (url, init = {}) => {
        const u = String(url)
        const tok = new Headers(init.headers).get("token")
        if (u.endsWith("/api/v1/account/profile")) {
          profileAttempts++
          if (failProfile) throw new Error("transient profile outage")
          return new Response(JSON.stringify({ uid: "10001", user_name: "Alice" }), { status: 200 })
        }
        if (u.endsWith("/api/v1/credit/wallet")) {
          walletTokens.push(tok)
          if (failWallet403 && tok === dirObj.token) {
            failWallet403 = false
            writeFileSync(
              join(dirObj.root, "hub-config.json"),
              JSON.stringify({ ...dirObj.cfg, tokens: { ...dirObj.cfg.tokens, accessToken: encryptV2(rotated, dirObj.keyBuf) } }),
            )
            const t = new Date(fakeNow + 2000)
            utimesSync(join(dirObj.root, "hub-config.json"), t, t)
            return new Response(JSON.stringify({ error: { message: "token expired" } }), { status: 403 })
          }
          if (tok === activeWalletToken) {
            return new Response(JSON.stringify({ wallets: [{ source: 1, plan_name: "Plus", total_credit: "321" }] }), { status: 200 })
          }
          return new Response(JSON.stringify({ error: { message: "token expired" } }), { status: 403 })
        }
        return new Response("{}", { status: 200 })
      },
      env: { MINIMAX_DESIGN_DATA_DIR: dirObj.root },
      versionCode: TEST_VERSION,
      nowMsImpl: () => fakeNow,
    })

    try {
      const storedAuth = {
        type: "api",
        key: dirObj.token,
        metadata: { userId: "10001", tokenOwnerId: "owner-10001", dataDir: dirObj.root, configFile: "hub-config.json", method: "desktop" },
      }
      // 1. Wallet returns 403 while disk rotates -> usage MUST forceRefresh on 403 and retry with rotated token
      const recovered = await hooks.auth.usage(async () => storedAuth)
      assert.equal(recovered.plan, "Plus")
      assert.deepEqual(recovered.windows, [{ name: "积分", balance: 321, unit: "积分" }])
      assert.equal(recovered.signIn, "renewed")
      assert.deepEqual(walletTokens, [dirObj.token, rotated])
      assert.equal(profileAttempts, 1)

      // 2. Server supersedes rotated with rotated2, and profile hits transient outage -> negative-cached for 30s
      activeWalletToken = rotated2
      failProfile = true
      writeFileSync(
        join(dirObj.root, "hub-config.json"),
        JSON.stringify({ ...dirObj.cfg, tokens: { ...dirObj.cfg.tokens, accessToken: encryptV2(rotated2, dirObj.keyBuf) } }),
      )
      const t2 = new Date(fakeNow + 6000)
      utimesSync(join(dirObj.root, "hub-config.json"), t2, t2)

      const failed = await hooks.auth.usage(async () => storedAuth)
      assert.equal(failed.signIn, "expired")
      assert.equal(profileAttempts, 2)

      // Within 30s negative-cache window, profile is NOT re-queried
      fakeNow += 5_000
      await hooks.auth.usage(async () => storedAuth)
      assert.equal(profileAttempts, 2)

      // After 30s TTL expires and profile recovers, verification runs again and succeeds
      failProfile = false
      fakeNow += OWNER_VERIFY_FAIL_TTL_MS
      const recovered2 = await hooks.auth.usage(async () => storedAuth)
      assert.equal(profileAttempts, 3)
      assert.equal(recovered2.signIn, "renewed")
      assert.deepEqual(recovered2.windows, [{ name: "积分", balance: 321, unit: "积分" }])
    } finally {
      rmSync(dirObj.root, { recursive: true, force: true })
    }
  })

  test("retains verified rotated token across desktop account switch, recomputes hasGroupId after refresh, and keeps sign-in on non-auth cloud 403s", async () => {
    let fakeNow = Date.now()
    const origA = makeJwt({ exp: Math.floor(fakeNow / 1000) + 300, user: { id: "owner-A" }, v: 1 })
    const rotatedA = makeJwt({ exp: Math.floor(fakeNow / 1000) + 7200, user: { id: "owner-A" }, v: 2 })
    const tokenB = makeJwt({ exp: Math.floor(fakeNow / 1000) + 7200, user: { id: "owner-B" }, v: 1 })
    const dirObj = makeTempDesktopDir({ userID: "10001", groupId: null, token: origA, lkgObj: SAMPLE_REMOTE_CONFIG })
    const sentTokens = []

    let walletAttempt = 0
    const hooks = createPlugin(SITES["minimax-design"], {
      fetchImpl: async (url, init = {}) => {
        const u = String(url)
        const tok = new Headers(init.headers).get("token")
        if (u.endsWith("/api/v1/account/profile")) {
          const uid = tok === tokenB ? "20002" : "10001"
          return new Response(JSON.stringify({ uid, user_name: `User ${uid}` }), { status: 200 })
        }
        if (u.endsWith("/api/v1/config")) {
          return new Response(JSON.stringify({ error: { code: "client_upgrade_required", message: "upgrade client" } }), { status: 403 })
        }
        if (u.endsWith("/api/v1/credit/wallet")) {
          walletAttempt++
          if (walletAttempt === 1) {
            // Disk rotates A's token AND switches from personal (no groupId) to team-7
            writeFileSync(
              join(dirObj.root, "hub-config.json"),
              JSON.stringify({
                ...dirObj.cfg,
                selectedGroupIds: { "10001": "team-7" },
                tokens: { ...dirObj.cfg.tokens, accessToken: encryptV2(rotatedA, dirObj.keyBuf) },
              }),
            )
            const t = new Date(fakeNow + 2000)
            utimesSync(join(dirObj.root, "hub-config.json"), t, t)
            return new Response(JSON.stringify({ error: { message: "token expired" } }), { status: 401 })
          }
          // Non-auth 403 on wallet (e.g. team scope restriction) falls through to /credit/balance
          return new Response(JSON.stringify({ error: { message: "team wallet unavailable" } }), { status: 403 })
        }
        if (u.endsWith("/api/v1/credit/balance")) {
          return new Response(JSON.stringify({ total_credit: "500", team_credit: "0" }), { status: 200 })
        }
        if (u.endsWith("/api/v1/models/config")) {
          return new Response("not found", { status: 404 })
        }
        sentTokens.push(tok)
        return new Response("{}", { status: 200 })
      },
      env: { MINIMAX_DESIGN_DATA_DIR: dirObj.root },
      versionCode: TEST_VERSION,
      nowMsImpl: () => fakeNow,
    })

    try {
      const authA = {
        type: "api",
        key: origA,
        metadata: { userId: "10001", tokenOwnerId: "owner-A", dataDir: dirObj.root, configFile: "hub-config.json", method: "desktop" },
      }

      // 1. Usage starts in personal scope -> wallet 401 refreshes to rotatedA + team-7 -> wallet non-auth 403
      //    falls through to /credit/balance -> MUST recompute hasGroupId=true and report team_credit=0 (not 500!)
      const usage = await hooks.auth.usage(async () => authA)
      assert.equal(usage.signIn, "renewed")
      assert.deepEqual(usage.windows[0], { name: "团队积分", balance: 0, unit: "积分" })

      // 2. Desktop switches to Account B; Account A MUST retain verified rotatedA (not revert to origA)
      writeFileSync(
        join(dirObj.root, "hub-config.json"),
        JSON.stringify({
          ...dirObj.cfg,
          user: { userID: "20002", userName: "Bob" },
          selectedGroupIds: { "20002": "team-bob" },
          tokens: { ...dirObj.cfg.tokens, accessToken: encryptV2(tokenB, dirObj.keyBuf) },
        }),
      )
      const t2 = new Date(fakeNow + 6000)
      utimesSync(join(dirObj.root, "hub-config.json"), t2, t2)
      const loadedA = await hooks.auth.loader(async () => authA)
      await loadedA.fetch("https://hub.minimaxi.com/api/v1/messages", { method: "POST", body: "{}" })
      assert.equal(sentTokens[0], rotatedA)

      // 3. Non-auth 403 (client_upgrade_required) on /api/v1/config does NOT throw signIn:expired; falls back to LKG/bootstrap
      const cfg = { provider: {} }
      await hooks.config(cfg)
      const models = await hooks.provider.models(
        { id: "minimax-design", models: cfg.provider["minimax-design"].models },
        { auth: authA },
      )
      assert.ok(models["MiniMax-M3.1-Flash"])

      // 4. Once retained rotatedA expires, resolveCredential MUST NOT send the expired retained token
      fakeNow += 8_000_000
      await loadedA.fetch("https://hub.minimaxi.com/api/v1/messages", { method: "POST", body: "{}" })
      assert.equal(sentTokens[1], origA)
    } finally {
      rmSync(dirObj.root, { recursive: true, force: true })
    }
  })

  test("handles non-auth profile/wallet 403s, balance fallback auth 403, wallet upgrade 403, missing-uid negative cache, and owner cache eviction", async () => {
    let fakeNow = Date.now()
    const validToken = makeJwt({ exp: Math.floor(fakeNow / 1000) + 7200, user: { id: "owner-10001" } })
    const dirObj = makeTempDesktopDir({ userID: "10001", groupId: "team-1", token: validToken })

    try {
      // 1. fetchAccountProfile non-auth 403 MUST NOT abort a region-confirmed desktop sign-in as expired
      const hooksProfile403 = createPlugin(SITES["minimax-design"], {
        fetchImpl: async () => new Response(JSON.stringify({ error: { message: "profile feature disabled" } }), { status: 403 }),
        env: { MINIMAX_DESIGN_DATA_DIR: dirObj.root },
        versionCode: TEST_VERSION,
        nowMsImpl: () => fakeNow,
      })
      const start = await hooksProfile403.auth.methods[0].authorize()
      const signed = await start.callback()
      assert.equal(signed.type, "success")
      assert.equal(signed.accountId, "10001")

      const storedAuth = {
        type: "api",
        key: validToken,
        metadata: { userId: "10001", tokenOwnerId: "owner-10001", groupId: "team-1", dataDir: dirObj.root, configFile: "hub-config.json", method: "desktop" },
      }

      // 2. First-attempt wallet non-auth 403 falls through to /credit/balance cleanly (NOT marked expired)
      const hooksFirstWallet403 = createPlugin(SITES["minimax-design"], {
        fetchImpl: async (url) => {
          if (String(url).endsWith("/api/v1/credit/wallet")) {
            return new Response(JSON.stringify({ error: { message: "team wallet unavailable" } }), { status: 403 })
          }
          return new Response(JSON.stringify({ total_credit: "500", team_credit: "120" }), { status: 200 })
        },
        env: { MINIMAX_DESIGN_DATA_DIR: dirObj.root },
        versionCode: TEST_VERSION,
        nowMsImpl: () => fakeNow,
      })
      const firstFallback = await hooksFirstWallet403.auth.usage(async () => storedAuth)
      assert.equal(firstFallback.signIn, undefined)
      assert.deepEqual(firstFallback.windows[0], { name: "团队积分", balance: 120, unit: "积分" })

      // 3. /credit/balance fallback receiving auth 403 ("token expired") MUST report signIn: "expired"
      const hooksBalAuth403 = createPlugin(SITES["minimax-design"], {
        fetchImpl: async (url) => {
          if (String(url).endsWith("/api/v1/credit/wallet")) {
            return new Response(JSON.stringify({ error: { message: "team wallet unavailable" } }), { status: 403 })
          }
          return new Response(JSON.stringify({ error: { message: "token expired" } }), { status: 403 })
        },
        env: { MINIMAX_DESIGN_DATA_DIR: dirObj.root },
        versionCode: TEST_VERSION,
        nowMsImpl: () => fakeNow,
      })
      const balExpired = await hooksBalAuth403.auth.usage(async () => storedAuth)
      assert.equal(balExpired.signIn, "expired")

      // 4. Wallet client_upgrade_required 403 returns immediately with signIn: "kept" without calling /credit/balance
      let balanceCalls = 0
      const hooksUpgrade = createPlugin(SITES["minimax-design"], {
        fetchImpl: async (url) => {
          if (String(url).endsWith("/api/v1/credit/balance")) {
            balanceCalls++
            return new Response(JSON.stringify({ total_credit: "500" }), { status: 200 })
          }
          return new Response(JSON.stringify({ error: { code: "client_upgrade_required", message: "upgrade client" } }), { status: 403 })
        },
        env: { MINIMAX_DESIGN_DATA_DIR: dirObj.root },
        versionCode: TEST_VERSION,
        nowMsImpl: () => fakeNow,
      })
      const upg = await hooksUpgrade.auth.usage(async () => storedAuth)
      assert.equal(upg.signIn, "kept")
      assert.match(upg.error, /MINIMAX_DESIGN_VERSION_CODE/)
      assert.equal(balanceCalls, 0)

      // 5. Missing uid in profile 200 response negative-caches for 30s, and OWNER_CACHE_MAX evicts oldest entry
      let profileCalls = 0
      let returnUid = false
      const hooksCache = createPlugin(SITES["minimax-design"], {
        fetchImpl: async (url) => {
          if (String(url).endsWith("/api/v1/account/profile")) {
            profileCalls++
            return new Response(JSON.stringify(returnUid ? { uid: "10001", user_name: "Alice" } : { user_name: "NoUid" }), { status: 200 })
          }
          return new Response("{}", { status: 200 })
        },
        env: { MINIMAX_DESIGN_DATA_DIR: dirObj.root },
        versionCode: TEST_VERSION,
        nowMsImpl: () => fakeNow,
      })
      const writeRot = (tok, offsetMs) => {
        writeFileSync(
          join(dirObj.root, "hub-config.json"),
          JSON.stringify({ ...dirObj.cfg, tokens: { ...dirObj.cfg.tokens, accessToken: encryptV2(tok, dirObj.keyBuf) } }),
        )
        const t = new Date(fakeNow + offsetMs)
        utimesSync(join(dirObj.root, "hub-config.json"), t, t)
      }
      const loaded = await hooksCache.auth.loader(async () => storedAuth)
      const noUidTok = makeJwt({ exp: Math.floor(fakeNow / 1000) + 7200, user: { id: "owner-10001" }, seq: 0 })
      writeRot(noUidTok, 2000)
      await loaded.fetch("https://hub.minimaxi.com/api/v1/messages", { method: "POST", body: "{}" })
      assert.equal(profileCalls, 1)
      fakeNow += 5_000
      await loaded.fetch("https://hub.minimaxi.com/api/v1/messages", { method: "POST", body: "{}" })
      assert.equal(profileCalls, 1) // negative-cached within 30s
      returnUid = true
      fakeNow += OWNER_VERIFY_FAIL_TTL_MS
      await loaded.fetch("https://hub.minimaxi.com/api/v1/messages", { method: "POST", body: "{}" })
      assert.equal(profileCalls, 2) // re-queried after 30s and succeeded

      // Fill cache beyond OWNER_CACHE_MAX so noUidTok (oldest) is evicted
      for (let i = 1; i <= OWNER_CACHE_MAX; i++) {
        const tok = makeJwt({ exp: Math.floor(fakeNow / 1000) + 7200, user: { id: "owner-10001" }, seq: i })
        writeRot(tok, (i + 2) * 2000)
        await loaded.fetch("https://hub.minimaxi.com/api/v1/messages", { method: "POST", body: "{}" })
      }
      const callsBeforeRevisit = profileCalls
      writeRot(noUidTok, (OWNER_CACHE_MAX + 5) * 2000)
      await loaded.fetch("https://hub.minimaxi.com/api/v1/messages", { method: "POST", body: "{}" })
      assert.equal(profileCalls, callsBeforeRevisit + 1)
    } finally {
      rmSync(dirObj.root, { recursive: true, force: true })
    }
  })

  test("initial desktop login rejects contradictory profile uid and unverified region on network failure", async () => {
    const raceDir = makeTempDesktopDir({ userID: "10001", adUrl: null })
    try {
      // Contradictory profile uid (persistAuthTokens race) -> rejects
      const hooksRace = createPlugin(SITES["minimax-design"], {
        fetchImpl: async () => new Response(JSON.stringify({ uid: "99999", user_name: "Other" }), { status: 200 }),
        env: { MINIMAX_DESIGN_DATA_DIR: raceDir.root },
        versionCode: TEST_VERSION,
      })
      const start1 = await hooksRace.auth.methods[0].authorize()
      await assert.rejects(() => start1.callback(), /切换账号/)

      // Unknown region (no LKG, no adAttribution, hub-config.json) + profile failure -> rejects
      const hooksGlobal = createPlugin(SITES["minimax-design-global"], {
        fetchImpl: async () => {
          throw new Error("timeout")
        },
        env: { MINIMAX_DESIGN_DATA_DIR: raceDir.root },
        versionCode: TEST_VERSION,
      })
      const start2 = await hooksGlobal.auth.methods[0].authorize()
      await assert.rejects(() => start2.callback(), /verify the desktop sign-in region/)
    } finally {
      rmSync(raceDir.root, { recursive: true, force: true })
    }
  })

  test("authoritative empty remote catalog returns {} instead of bootstrap models", async () => {
    const validJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    const hooks = createPlugin(SITES["minimax-design"], {
      fetchImpl: async (url) => {
        if (String(url).endsWith("/api/v1/models/config")) {
          return new Response(JSON.stringify({ imageModels: [], videoModels: [] }), { status: 200 })
        }
        return new Response(JSON.stringify({ enabled_providers: [], provider: {} }), { status: 200 })
      },
      versionCode: TEST_VERSION,
    })
    const cfg = { provider: {} }
    await hooks.config(cfg)
    const models = await hooks.provider.models(
      { id: "minimax-design", models: cfg.provider["minimax-design"].models },
      { auth: { type: "api", key: validJwt } },
    )
    assert.deepEqual(models, {})
  })

  test("waitForDesktopCredential handles polling, abort (with bounded advancing clock), and immediate region_mismatch stop", async () => {
    let tries = 0
    const ready = await waitForDesktopCredential({
      read: () => (++tries < 3 ? { error: { code: "missing" } } : { cred: { key: "tok" } }),
      sleep: async () => {},
      now: () => tries * 1000,
    })
    assert.equal(ready.status, "ready")
    assert.equal(ready.cred.key, "tok")

    // Advancing clock ensures a broken abort check fails fast instead of hanging
    const ac = new AbortController()
    ac.abort()
    let tick = 0
    const aborted = await waitForDesktopCredential({
      read: () => ({ error: { code: "missing" } }),
      sleep: async () => {
        tick += 500
      },
      now: () => (tick += 100),
      waitMs: 1000,
      signal: ac.signal,
    })
    assert.equal(aborted.status, "aborted")

    // region_mismatch stops polling on the very first read
    let mismatchReads = 0
    const mismatch = await waitForDesktopCredential({
      read: () => {
        mismatchReads++
        return { error: Object.assign(new Error("wrong region"), { code: "region_mismatch" }) }
      },
      sleep: async () => {},
      now: () => mismatchReads * 1000,
      waitMs: 60_000,
    })
    assert.equal(mismatch.status, "failed")
    assert.equal(mismatchReads, 1)
  })

  test("siteFetch blocks untrusted hosts/downgrades/redirects and normalizeUpstreamResponse classifies 401/402/403/429 accurately", async () => {
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

    await assert.rejects(
      () => siteFetch(SITES["minimax-design"], "http://hub.minimaxi.com/api/v1/messages", {}, { fetchImpl: async () => new Response("ok") }),
      /untrusted destination/,
    )

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

    // Explicit credit exhaustion 403 -> 429 insufficient_credits + kept
    const quota = await normalizeUpstreamResponse(
      SITES["minimax-design"],
      new Response(JSON.stringify({ error: { message: "积分余额不足" } }), { status: 403 }),
      false,
    )
    assert.equal(quota.status, 429)
    assert.equal(quota.headers.get("X-Magpie-Sign-In"), "kept")

    // HTTP 402 with generic body (no credit keywords) still normalizes to 429 insufficient_credits + kept
    const pay402 = await normalizeUpstreamResponse(
      SITES["minimax-design"],
      new Response(JSON.stringify({ error: { message: "payment required" } }), { status: 402 }),
      false,
    )
    assert.equal(pay402.status, 429)
    assert.equal(pay402.headers.get("X-Magpie-Sign-In"), "kept")
    assert.match(await pay402.text(), /insufficient_credits/)

    // Upstream 429 RPM rate limit passes through untouched (NOT rewritten to insufficient_credits)
    const rateLimit = await normalizeUpstreamResponse(
      SITES["minimax-design"],
      new Response(JSON.stringify({ error: { message: "requests per minute quota exceeded" } }), {
        status: 429,
        headers: { "retry-after": "30" },
      }),
      false,
    )
    assert.equal(rateLimit.status, 429)
    assert.equal(rateLimit.headers.get("retry-after"), "30")
    assert.equal(rateLimit.headers.get("X-Magpie-Sign-In"), "kept")
    assert.doesNotMatch(await rateLimit.text(), /insufficient_credits/)

    // Non-credit 403 permission refusal stays 403 + kept (not misclassified as out-of-credits)
    const perm = await normalizeUpstreamResponse(
      SITES["minimax-design"],
      new Response(JSON.stringify({ error: { message: "insufficient permission for this model" } }), { status: 403 }),
      false,
    )
    assert.equal(perm.status, 403)
    assert.equal(perm.headers.get("X-Magpie-Sign-In"), "kept")

    // Auth-related 403 turns into 401 + expired
    const auth403 = await normalizeUpstreamResponse(
      SITES["minimax-design"],
      new Response(JSON.stringify({ error: { message: "token expired" } }), { status: 403 }),
      false,
    )
    assert.equal(auth403.status, 401)
    assert.equal(auth403.headers.get("X-Magpie-Sign-In"), "expired")

    // client_upgrade_required stays 403 + kept
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

const SAMPLE_MODELS_CONFIG = {
  imageModels: [
    { id: "MiniMax-H3-Image", model_name: "MiniMax-H3-Image", name: "MiniMax H3 Image", backend: "minimax_image", params: { aspect_ratio: { default: "1:1", options: ["1:1", "16:9", "9:16"] }, resolution: { default: "4K", options: ["1K", "2K", "4K"] } } },
    { id: "g-image-2.6-sunburst", model_name: "gpt-image-2.6-sunburst", name: "Design Image 2.6 Pro", backend: "openai", params: { aspect_ratio: { default: "1:1", options: ["1:1", "16:9", "9:16"] }, resolution: { default: "2k", options: ["1k", "2k", "4k"] }, quality: { default: "high", options: ["low", "medium", "high"] } } },
    { id: "banana-2", model_name: "nano_banana_2_flash", name: "General Image 2", backend: "nano_banana", params: { aspect_ratio: { default: "auto", options: ["auto", "1:1", "16:9"] }, resolution: { default: "auto", options: ["auto", "1K", "2K", "4K"] } } },
    { id: "banana-pro", model_name: "nano_banana_2", name: "General Image Pro", backend: "nano_banana" },
    { id: "doubao-seedream-5-0-pro-260628", model_name: "doubao-seedream-5-0-pro-260628", name: "Seedream 5.0 Pro", backend: "seedream", params: { resolution: { default: "2K", options: ["1K", "2K"] } } },
    { id: "doubao-seedream-4-5-251128", model_name: "doubao-seedream-4-5-251128", name: "Seedream 4.5", backend: "seedream", params: { resolution: { default: "2K", options: ["2K", "4K"] } } },
    { id: "midjourney-8.2", name: "悠船 8.2", backend: "midjourney", params: { aspect_ratio: { default: "1:1", options: ["auto", "1:1", "16:9"] } } },
    { id: "g-image-3-future", model_name: "gpt-image-3-future", name: "Design Image 3 Future", backend: "openai" },
    { id: "hidden-img", model_name: "hidden-img", name: "Hidden", backend: "minimax_image", visibility: "hidden" },
    { id: "unsupported-img", model_name: "unsupported", name: "Other", backend: "unknown_backend" },
  ],
  videoModels: [
    { id: "MiniMax-H3", model_name: "MiniMax-H3", name: "MiniMax H3", backend: "minimax_v3", params: { duration: { default: "5", options: ["4", "5", "6", "10"] }, aspect_ratio: { default: "adaptive", options: ["adaptive", "16:9", "9:16"] }, resolution: { default: "2K", options: ["768P", "2K"] } } },
    { id: "seedance2.5", model_name: "seedance2.5", name: "SD 2.5", backend: "seedance", params: { duration: { default: "5", options: ["4", "5", "10"] }, resolution: { default: "720p", options: ["480p", "720p", "1080p"] } } },
    { id: "seedance2.5-draft", model_name: "seedance2.5-draft", name: "SD 2.5 样片", backend: "seedance", params: { resolution: { default: "480p", options: ["480p"] } } },
    { id: "seedance2.0", model_name: "seedance2.0", name: "SD 2.0 满血版", backend: "seedance" },
    { id: "wan3.0-video", model_name: "wan3.0-video", name: "Wan 3.0", backend: "wan_i2v", params: { duration: { default: "5", options: ["2", "5", "10"] }, resolution: { default: "1080P", options: ["480P", "720P", "1080P"] } } },
    { id: "kling-v3-omni-video", model_name: "kling-v3-omni", name: "Kling 3.0 Omni", backend: "kling", params: { mode: { default: "pro", options: ["std", "pro"] }, duration: { default: "5", options: ["3", "5", "10"] }, aspect_ratio: { default: "16:9", options: ["16:9", "9:16", "1:1"] } } },
    { id: "kling-avatar", model_name: "kling-avatar", name: "Kling Avatar", backend: "kling_avatar", params: { mode: { default: "std", options: ["std", "pro"] } } },
    { id: "veo-3.1-generate-001", model_name: "veo-3.1-generate-001", name: "Veo3.1", backend: "veo3", params: { duration: { default: "8", options: ["8"] }, resolution: { default: "720p", options: ["720p", "1080p"] }, aspect_ratio: { default: "16:9", options: ["16:9", "9:16"] } } },
  ],
}

describe("native image & video models + canonical naming", () => {
  test("parseModelsConfig maps domestic compliance aliases to canonical IDs and names, drops hidden/unsupported models", () => {
    const specs = parseModelsConfig(SAMPLE_MODELS_CONFIG)
    assert.ok(Array.isArray(specs))
    const byId = Object.fromEntries(specs.map((s) => [s.id, s]))

    assert.equal(byId["gpt-image-2.6-sunburst"].name, "GPT Image 2.6 Sunburst")
    assert.equal(byId["gpt-image-2.6-sunburst"].upstreamId, "g-image-2.6-sunburst")
    assert.equal(byId["gpt-image-2.6-sunburst"].modelName, "gpt-image-2.6-sunburst")
    assert.equal(byId["g-image-2.6-sunburst"], undefined)

    assert.equal(byId["nano-banana-2"].name, "Nano Banana 2")
    assert.equal(byId["nano-banana-2"].modelName, "nano_banana_2_flash")
    assert.equal(byId["nano-banana-pro"].name, "Nano Banana Pro")
    assert.equal(byId["nano-banana-pro"].modelName, "nano_banana_2")

    assert.equal(byId["midjourney-8.2"].name, "Midjourney 8.2")
    assert.equal(byId["gpt-image-3-future"].name, "GPT Image 3 Future")

    assert.equal(byId["seedance-2.5"].name, "Seedance 2.5")
    assert.equal(byId["seedance-2.5"].modelName, "seedance2.5")
    assert.equal(byId["seedance-2.5-draft"].name, "Seedance 2.5 Draft")
    assert.equal(byId["seedance-2.0"].name, "Seedance 2.0")
    assert.equal(byId["wan-3.0-video"].name, "Wan 3.0")
    assert.equal(byId["kling-v3-omni-video"].modelName, "kling-v3-omni")
    assert.equal(byId["veo-3.1"].name, "Veo 3.1")
    assert.equal(byId["veo-3.1"].modelName, "veo-3.1-generate-001")

    // MiniMax-H3-Image defaults to 2K (not 4K) so callers omitting size don't burn 4K credits
    assert.equal(byId["MiniMax-H3-Image"].defaultResolution, "2K")
    // Hidden and unsupported backends are omitted
    assert.equal(byId["hidden-img"], undefined)
    assert.equal(byId["unsupported-img"], undefined)
  })

  test("provider.models merges live chat models with live image & video models using magpie native capabilities", async () => {
    const validJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    const hooks = createPlugin(SITES["minimax-design"], {
      fetchImpl: async (url) => {
        const u = String(url)
        if (u.endsWith("/api/v1/config")) return new Response(JSON.stringify(SAMPLE_REMOTE_CONFIG), { status: 200 })
        if (u.endsWith("/api/v1/models/config")) return new Response(JSON.stringify(SAMPLE_MODELS_CONFIG), { status: 200 })
        return new Response("not found", { status: 404 })
      },
      versionCode: TEST_VERSION,
    })

    const cfg = { provider: {} }
    await hooks.config(cfg)
    // Bootstrap config includes canonical chat + image + video entries
    assert.equal(cfg.provider["minimax-design"].models["claude-opus-5-5"].id, "alpha")
    assert.equal(cfg.provider["minimax-design"].models["claude-opus-5-5"].name, "Claude Opus 5.5")
    assert.equal(cfg.provider["minimax-design"].models["gpt-6-astra"].id, "gamma-6-astra")
    assert.deepEqual(cfg.provider["minimax-design"].models["gpt-image-2.6-sunburst"].modalities.output, ["image"])
    assert.deepEqual(cfg.provider["minimax-design"].models["seedance-2.5"].modalities.output, ["video"])

    const models = await hooks.provider.models(
      { id: "minimax-design", models: cfg.provider["minimax-design"].models },
      { auth: { type: "api", key: validJwt } },
    )
    // Chat models have canonical IDs & names with upstream api.id preserved
    assert.equal(models["claude-opus-5-5"].api.id, "alpha")
    assert.equal(models["gpt-5.5-high"].api.id, "gamma_high")
    assert.equal(models["gpt-5.5-high"].capabilities.output.text, true)
    // Image models have output.image=true & @ai-sdk/openai-compatible so magpie lists them as drawers
    assert.equal(models["gpt-image-2.6-sunburst"].api.npm, "@ai-sdk/openai-compatible")
    assert.equal(models["gpt-image-2.6-sunburst"].capabilities.output.text, false)
    assert.equal(models["gpt-image-2.6-sunburst"].capabilities.output.image, true)
    assert.equal(models["nano-banana-2"].name, "Nano Banana 2")
    assert.equal(models["midjourney-8.2"].name, "Midjourney 8.2")
    // Video models have output.video=true so magpie lists them as videomakers
    assert.equal(models["seedance-2.5"].capabilities.output.text, false)
    assert.equal(models["seedance-2.5"].capabilities.output.video, true)
    assert.equal(models["MiniMax-H3"].capabilities.output.video, true)
    assert.equal(models["veo-3.1"].capabilities.output.video, true)
  })

  test("POST /images/generations and /images/edits route all 5 image backends, upload multipart refs, refuse mask/local paths, and isolate CDN headers", async () => {
    const validJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    const sent = []
    const pollCounts = new Map()
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

    const fakeFetch = async (url, init = {}) => {
      const u = String(url)
      const h = new Headers(init.headers)
      const bodyObj = typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : null
      sent.push({ url: u, method: init.method ?? "GET", token: h.get("token"), body: bodyObj })

      if (u.endsWith("/api/v1/files/upload")) {
        return new Response(JSON.stringify({ url: "https://cdn.example.test/uploaded-ref.png" }), { status: 200 })
      }
      if (u.endsWith("/api/v2/image/minimax/generate")) return new Response(JSON.stringify({ task_id: "t-mm" }), { status: 200 })
      if (u.endsWith("/api/v2/image/minimax/tasks/t-mm")) {
        const c = (pollCounts.get("t-mm") ?? 0) + 1
        pollCounts.set("t-mm", c)
        if (c === 1) return new Response(JSON.stringify({ status: "processing" }), { status: 200 })
        return new Response(JSON.stringify({ status: "success", image_url: "https://cdn.example.test/mm-out.png" }), { status: 200 })
      }
      if (u.endsWith("/api/v2/image/openai/generate")) return new Response(JSON.stringify({ task_id: "t-oai" }), { status: 200 })
      if (u.endsWith("/api/v2/image/openai/tasks/t-oai")) {
        return new Response(JSON.stringify({ status: "success", image_urls: ["https://cdn.example.test/oai-1.png", "https://cdn.example.test/oai-2.png"] }), { status: 200 })
      }
      if (u.endsWith("/api/v2/image/nano_banana/generate")) return new Response(JSON.stringify({ task_id: "t-nb" }), { status: 200 })
      if (u.endsWith("/api/v2/image/nano_banana/tasks/t-nb")) {
        return new Response(JSON.stringify({ status: "success", image_url: "https://cdn.example.test/nb-out.png" }), { status: 200 })
      }
      if (u.endsWith("/api/v2/image/seedream/generate")) return new Response(JSON.stringify({ task_id: "t-sd" }), { status: 200 })
      if (u.endsWith("/api/v2/image/seedream/tasks/t-sd")) {
        return new Response(JSON.stringify({ status: "success", image_url: "https://cdn.example.test/sd-out.png" }), { status: 200 })
      }
      if (u.endsWith("/api/v1/image/midjourney/generate")) return new Response(JSON.stringify({ task_id: "t-mj" }), { status: 200 })
      if (u.endsWith("/api/v1/image/midjourney/tasks/t-mj")) {
        return new Response(JSON.stringify({ status: "completed", image_urls: ["https://cdn.example.test/mj-1.png", "https://cdn.example.test/mj-2.png"] }), { status: 200 })
      }
      if (u === "https://cdn.example.test/mm-out.png") {
        // Must NEVER receive MiniMax credentials on third-party CDN download
        assert.equal(h.get("token"), null)
        return new Response(pngBytes, { status: 200, headers: { "content-type": "image/png" } })
      }
      if (u === "https://cdn.example.test/insecure-redirect.png") {
        return new Response("", { status: 302, headers: { location: "http://cdn.example.test/plain.png" } })
      }
      return new Response("not found", { status: 404 })
    }

    const hooks = createPlugin(SITES["minimax-design"], {
      fetchImpl: fakeFetch,
      versionCode: TEST_VERSION,
      sleepImpl: async () => {},
      pollIntervalMs: 1,
    })
    const loaded = await hooks.auth.loader(async () => ({ type: "api", key: validJwt }))
    const base = "https://hub.minimaxi.com/api/v1"

    // 1. MiniMax-H3-Image with b64_json + polling pending -> success
    const rMm = await loaded.fetch(`${base}/images/generations`, {
      method: "POST",
      body: JSON.stringify({ model: "minimax-design/MiniMax-H3-Image", prompt: "a lighthouse", size: "1280x720", response_format: "b64_json" }),
    })
    assert.equal(rMm.status, 200)
    assert.equal(rMm.headers.get("X-Magpie-Sign-In"), "kept")
    const jMm = await rMm.json()
    assert.equal(jMm.data.length, 1)
    assert.equal(jMm.data[0].b64_json, pngBytes.toString("base64"))
    const mmSub = sent.find((s) => s.url.endsWith("/api/v2/image/minimax/generate"))
    assert.deepEqual(mmSub.body, { prompt: "a lighthouse", model: "MiniMax-H3-Image", image_paths: [], resolution: "1K", aspect_ratio: "16:9" })

    // 2. OpenAI image backend (canonical ID -> model: gpt-image-2.6-sunburst, n=2)
    const rOai = await loaded.fetch(`${base}/images/generations`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-image-2.6-sunburst", prompt: "editorial poster", size: "16:9", n: 2, quality: "high" }),
    })
    assert.equal(rOai.status, 200)
    assert.equal((await rOai.json()).data.length, 2)
    const oaiSub = sent.find((s) => s.url.endsWith("/api/v2/image/openai/generate"))
    assert.equal(oaiSub.body.model, "gpt-image-2.6-sunburst")
    assert.equal(oaiSub.body.n, 2)
    assert.equal(oaiSub.body.size, "3840x2160")

    // 3. Nano Banana 2 (canonical ID -> model_name: nano_banana_2_flash)
    const rNb = await loaded.fetch(`${base}/images/generations`, {
      method: "POST",
      body: JSON.stringify({ model: "nano-banana-2", prompt: "glass fruit", size: "1024x1024" }),
    })
    assert.equal(rNb.status, 200)
    const nbSub = sent.find((s) => s.url.endsWith("/api/v2/image/nano_banana/generate"))
    assert.equal(nbSub.body.model_name, "nano_banana_2_flash")
    assert.equal(nbSub.body.aspect_ratio, "1:1")
    assert.equal(nbSub.body.resolution, "1K")

    // 4. Seedream 4.5 includes seed & guidance_scale; Seedream 5.0 omits them
    await loaded.fetch(`${base}/images/generations`, {
      method: "POST",
      body: JSON.stringify({ model: "doubao-seedream-4-5-251128", prompt: "mountain" }),
    })
    await loaded.fetch(`${base}/images/generations`, {
      method: "POST",
      body: JSON.stringify({ model: "doubao-seedream-5-0-pro-260628", prompt: "ocean" }),
    })
    const sdSubs = sent.filter((s) => s.url.endsWith("/api/v2/image/seedream/generate"))
    assert.equal(sdSubs[0].body.seed, -1)
    assert.equal(sdSubs[0].body.guidance_scale, 5)
    assert.equal(sdSubs[1].body.seed, undefined)

    // 5. Midjourney 8.2 via multipart /images/edits uploads binary PNG to /api/v1/files/upload and prepends URL + flags
    const form = new FormData()
    form.append("model", "midjourney-8.2")
    form.append("prompt", "ink wash dragon")
    form.append("size", "16:9")
    form.append("n", "1")
    form.append("image", new Blob([pngBytes], { type: "image/png" }), "ref.png")
    const rMj = await loaded.fetch(`${base}/images/edits`, { method: "POST", body: form })
    assert.equal(rMj.status, 200)
    const jMj = await rMj.json()
    assert.equal(jMj.data.length, 1)
    assert.equal(jMj.data[0].url, "https://cdn.example.test/mj-1.png")
    const mjSub = sent.find((s) => s.url.endsWith("/api/v1/image/midjourney/generate"))
    assert.equal(mjSub.body.prompt, "https://cdn.example.test/uploaded-ref.png ink wash dragon --ar 16:9 --v 8.2")

    // 6. Mask edits and non-HTTPS / local file references are refused with HTTP 400
    const maskForm = new FormData()
    maskForm.append("model", "MiniMax-H3-Image")
    maskForm.append("prompt", "edit")
    maskForm.append("image", new Blob([pngBytes], { type: "image/png" }), "a.png")
    maskForm.append("mask", new Blob([pngBytes], { type: "image/png" }), "m.png")
    const rMask = await loaded.fetch(`${base}/images/edits`, { method: "POST", body: maskForm })
    assert.equal(rMask.status, 400)
    assert.match(await rMask.text(), /mask/)

    const rLocal = await loaded.fetch(`${base}/images/generations`, {
      method: "POST",
      body: JSON.stringify({ model: "MiniMax-H3-Image", prompt: "hi", image: "file:///etc/passwd" }),
    })
    assert.equal(rLocal.status, 400)
  })

  test("POST/GET /videos and /videos/:id/content route all 6 video backends, resolve H3 file_id, reject unsafe IDs, and propagate 401/429", async () => {
    const validJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    const sent = []
    const mp4Bytes = Buffer.from("ftypmp42-fake-video")
    let h3Ready = false

    const fakeFetch = async (url, init = {}) => {
      const u = String(url)
      const h = new Headers(init.headers)
      const bodyObj = typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : null
      sent.push({ url: u, method: init.method ?? "GET", token: h.get("token"), body: bodyObj })

      if (u.endsWith("/api/v1/files/upload")) {
        return new Response(JSON.stringify({ url: "https://cdn.example.test/frame.png" }), { status: 200 })
      }
      if (u.endsWith("/api/v1/video/minimax-v3/generate")) return new Response(JSON.stringify({ task_id: "h3-task-1" }), { status: 200 })
      if (u.endsWith("/api/v1/video/minimax-v3/tasks/h3-task-1")) {
        return new Response(JSON.stringify(h3Ready ? { status: "Success", file_id: "file-99" } : { status: "Processing" }), { status: 200 })
      }
      if (u.endsWith("/api/v1/video/minimax/files/file-99")) {
        return new Response(JSON.stringify({ file: { download_url: "https://cdn.example.test/h3.mp4" } }), { status: 200 })
      }
      if (u.endsWith("/api/v1/video/seedance/generate")) return new Response(JSON.stringify({ task_id: "sd-task-2" }), { status: 200 })
      if (u.endsWith("/api/v1/video/seedance/tasks/sd-task-2")) {
        return new Response(JSON.stringify({ status: "succeeded", video_url: "https://cdn.example.test/sd.mp4" }), { status: 200 })
      }
      if (u.endsWith("/api/v1/video/wan3/generate")) return new Response(JSON.stringify({ output: { task_id: "wan-task-3" } }), { status: 200 })
      if (u.endsWith("/api/v1/video/wan3/tasks/wan-task-3")) {
        return new Response(JSON.stringify({ output: { task_status: "SUCCEEDED", video_url: "https://cdn.example.test/wan.mp4" } }), { status: 200 })
      }
      if (u.endsWith("/api/v1/video/kling-omni/generate")) return new Response(JSON.stringify({ code: 0, data: { task_id: "kling-task-4" } }), { status: 200 })
      if (u.endsWith("/api/v1/video/kling-omni/tasks/kling-task-4")) {
        return new Response(JSON.stringify({ data: { task_status: "succeed", task_result: { videos: [{ url: "https://cdn.example.test/kling.mp4" }] } } }), { status: 200 })
      }
      if (u.endsWith("/api/v1/video/kling/avatar")) return new Response(JSON.stringify({ code: 0, data: { task_id: "av-task-5" } }), { status: 200 })
      if (u.includes("/api/v1/video/veo3/generate?model=veo-3.1-generate-001")) return new Response(JSON.stringify({ task_id: "veo-task-6" }), { status: 200 })
      if (u.endsWith("/api/v1/video/veo3/tasks/veo-task-6")) {
        return new Response(JSON.stringify({ status: "completed", video_url: "https://cdn.example.test/veo.mp4" }), { status: 200 })
      }
      if (u.startsWith("https://cdn.example.test/") && u.endsWith(".mp4")) {
        assert.equal(h.get("token"), null)
        return new Response(mp4Bytes, { status: 200, headers: { "content-type": "video/mp4" } })
      }
      return new Response("not found", { status: 404 })
    }

    const hooks = createPlugin(SITES["minimax-design"], { fetchImpl: fakeFetch, versionCode: TEST_VERSION })
    const loaded = await hooks.auth.loader(async () => ({ type: "api", key: validJwt }))
    const base = "https://hub.minimaxi.com/api/v1"

    // 1. MiniMax-H3: create -> poll in_progress -> content 409 -> poll completed -> 2-step file retrieve + download
    const h3Create = await loaded.fetch(`${base}/videos`, {
      method: "POST",
      body: JSON.stringify({
        model: "MiniMax-H3",
        prompt: "paper boat in the rain",
        seconds: "6",
        size: "1280x720",
        input_reference: "data:image/png;base64,iVBORw0KGgo=",
      }),
    })
    assert.equal(h3Create.status, 200)
    const h3Job = await h3Create.json()
    assert.equal(h3Job.id, "MiniMax-H3::h3-task-1")
    const h3Sub = sent.find((s) => s.url.endsWith("/api/v1/video/minimax-v3/generate"))
    assert.equal(h3Sub.body.first_frame_image, "https://cdn.example.test/frame.png")
    assert.equal(h3Sub.body.duration, 6)
    assert.equal(h3Sub.body.resolution, "768P")

    const notReady = await loaded.fetch(`${base}/videos/${encodeURIComponent(h3Job.id)}/content`, { method: "GET" })
    assert.equal(notReady.status, 409)

    h3Ready = true
    const h3Poll = await loaded.fetch(`${base}/videos/${encodeURIComponent(h3Job.id)}`, { method: "GET" })
    assert.equal((await h3Poll.json()).status, "completed")
    const h3Content = await loaded.fetch(`${base}/videos/${encodeURIComponent(h3Job.id)}/content`, { method: "GET" })
    assert.equal(h3Content.status, 200)
    assert.equal(h3Content.headers.get("content-type"), "video/mp4")
    assert.deepEqual(Buffer.from(await h3Content.arrayBuffer()), mp4Bytes)

    // 2. Seedance 2.5 (canonical seedance-2.5 -> model: seedance2.5)
    const sdCreate = await loaded.fetch(`${base}/videos`, {
      method: "POST",
      body: JSON.stringify({ model: "seedance-2.5", prompt: "neon street", seconds: 5 }),
    })
    const sdJob = await sdCreate.json()
    assert.equal(sdJob.id, "seedance-2.5::sd-task-2")
    assert.equal(sent.find((s) => s.url.endsWith("/api/v1/video/seedance/generate")).body.model, "seedance2.5")
    const sdPoll = await loaded.fetch(`${base}/videos/${encodeURIComponent(sdJob.id)}`, { method: "GET" })
    assert.equal((await sdPoll.json()).status, "completed")

    // 3. Wan 3.0 & Kling 3.0 Omni & Veo 3.1
    const wanCreate = await loaded.fetch(`${base}/videos`, {
      method: "POST",
      body: JSON.stringify({ model: "wan-3.0-video", prompt: "sunrise", seconds: 5 }),
    })
    assert.equal((await wanCreate.json()).id, "wan-3.0-video::wan-task-3")

    const klingCreate = await loaded.fetch(`${base}/videos`, {
      method: "POST",
      body: JSON.stringify({ model: "kling-v3-omni-video", prompt: "orbit shot", seconds: 5, size: "16:9" }),
    })
    assert.equal((await klingCreate.json()).id, "kling-v3-omni-video::kling-task-4")
    assert.equal(sent.find((s) => s.url.endsWith("/api/v1/video/kling-omni/generate")).body.model_name, "kling-v3-omni")

    const veoCreate = await loaded.fetch(`${base}/videos`, {
      method: "POST",
      body: JSON.stringify({ model: "veo-3.1", prompt: "ocean wave", input_reference: "data:image/png;base64,iVBORw0KGgo=" }),
    })
    assert.equal((await veoCreate.json()).id, "veo-3.1::veo-task-6")
    const veoSub = sent.find((s) => s.url.includes("/api/v1/video/veo3/generate"))
    assert.equal(veoSub.body.instances[0].image.mime_type, "image/png")

    // 4. kling-avatar refuses missing sound_file with 400, accepts image + extra.sound_file
    const avBad = await loaded.fetch(`${base}/videos`, {
      method: "POST",
      body: JSON.stringify({ model: "kling-avatar", prompt: "hello" }),
    })
    assert.equal(avBad.status, 400)
    const avOk = await loaded.fetch(`${base}/videos`, {
      method: "POST",
      body: JSON.stringify({ model: "kling-avatar", prompt: "hello", input_reference: "https://cdn.example.test/face.png", extra: { sound_file: "https://cdn.example.test/voice.mp3" } }),
    })
    assert.equal((await avOk.json()).id, "kling-avatar::av-task-5")

    // 5. Path traversal task ID rejected locally with 404 without sending any upstream request
    const sentBeforeBadId = sent.length
    const badId = await loaded.fetch(`${base}/videos/${encodeURIComponent("MiniMax-H3::../secret")}`, { method: "GET" })
    assert.equal(badId.status, 404)
    assert.equal(sent.length, sentBeforeBadId)

    // 6. Upstream 402 credit exhaustion becomes 429 + kept; 401 becomes 401 + expired
    const errHooks = createPlugin(SITES["minimax-design"], {
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "insufficient credits" } }), { status: 402 }),
      versionCode: TEST_VERSION,
    })
    const errLoaded = await errHooks.auth.loader(async () => ({ type: "api", key: validJwt }))
    const r402 = await errLoaded.fetch(`${base}/videos`, { method: "POST", body: JSON.stringify({ model: "MiniMax-H3", prompt: "hi" }) })
    assert.equal(r402.status, 429)
    assert.equal(r402.headers.get("X-Magpie-Sign-In"), "kept")

    const expHooks = createPlugin(SITES["minimax-design"], {
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "token expired" } }), { status: 401 }),
      versionCode: TEST_VERSION,
    })
    const expLoaded = await expHooks.auth.loader(async () => ({ type: "api", key: validJwt }))
    const r401 = await expLoaded.fetch(`${base}/videos`, { method: "POST", body: JSON.stringify({ model: "MiniMax-H3", prompt: "hi" }) })
    assert.equal(r401.status, 401)
    assert.equal(r401.headers.get("X-Magpie-Sign-In"), "expired")
  })
})
