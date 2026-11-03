import test from "node:test"
import assert from "node:assert/strict"
import { createCipheriv, randomBytes } from "node:crypto"
import { join as pjoin } from "node:path"
import { AgnesPlugin, _internal } from "./index.mjs"

const {
  createPlugin,
  rowFromCatalogEntry,
  bootstrapRows,
  parseEncryptedKey,
  decryptSessionWithKey,
  readDesktopCredential,
  isExpiredJwt,
  dpapiUnprotect,
  OFFICIAL_SITE,
  DESKTOP_WAIT_MS,
  CHAT_GATEWAY_BASE,
  MODELS_URL,
  ID,
} = _internal

const MODEL_ENTRY = {
  id: "agnes-3.0-flash",
  object: "model",
  max_input_tokens: 512000,
  max_output_tokens: 65536,
  model_type: "text",
  is_member_only: false,
  thinking_toggle: { default_enabled: true },
  supported_endpoint_types: ["openai"],
}

test("rowFromCatalogEntry maps the agnes catalog shape", () => {
  const m = rowFromCatalogEntry(MODEL_ENTRY)
  assert.equal(m.id, "agnes-3.0-flash")
  assert.deepEqual(m.limit, { context: 512000, output: 65536 })
  assert.equal(m.reasoning, true)
  assert.equal(m.tool_call, true)
  assert.equal(m.capabilities.reasoning, true)
  assert.equal(m.capabilities.input.image, false)

  const plain = rowFromCatalogEntry({ id: "glm-5.3", max_input_tokens: 1000000, max_output_tokens: 131072 })
  assert.equal(plain.reasoning, false)
  assert.deepEqual(plain.limit, { context: 1000000, output: 131072 })
})

test("bootstrap table covers the observed catalog", () => {
  const rows = bootstrapRows()
  assert.equal(Object.keys(rows).length, 11)
  for (const id of ["agnes-3.0-flash", "claude-opus-5-5", "kimi-k3", "deepseek-v4-pro"]) {
    assert.ok(rows[id], `missing ${id}`)
  }
  assert.equal(rows["agnes-3.0-flash"].limit.context, 512000)
  assert.equal(rows["kimi-k3"].limit.context, 1048576)
})

test("parseEncryptedKey strips the DPAPI prefix and rejects other shapes", () => {
  const key = randomBytes(32)
  const blob = Buffer.concat([Buffer.from("DPAPI", "latin1"), key])
  assert.deepEqual(parseEncryptedKey(blob.toString("base64")), key)
  assert.throws(() => parseEncryptedKey(Buffer.from("hello").toString("base64")), /DPAPI/)
})

function frame(key, obj) {
  const nonce = Buffer.alloc(12, 7)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()])
  return Buffer.concat([Buffer.from("v10", "latin1"), nonce, ct, cipher.getAuthTag()])
}

test("decryptSessionWithKey round-trips the v10 safeStorage frame", () => {
  const key = randomBytes(32)
  const session = { accessToken: "jwt.abc", userInfo: { username: "tester" }, bffPublicBaseUrl: "https://x/v1" }
  const out = decryptSessionWithKey(key, frame(key, session))
  assert.deepEqual(out, session)

  assert.throws(() => decryptSessionWithKey(key, Buffer.from("v01-not-a-frame")), /v10/)
  assert.throws(() => decryptSessionWithKey(randomBytes(32), frame(key, session)), /auth|tag|state/i)
})

test("isExpiredJwt reads the exp claim", () => {
  const make = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`
  assert.equal(isExpiredJwt(make({ exp: Math.floor(Date.now() / 1000) - 10 })), true)
  assert.equal(isExpiredJwt(make({ exp: Math.floor(Date.now() / 1000) + 3600 })), false)
  assert.equal(isExpiredJwt("not-a-jwt"), false)
})

function fixtureFs(files) {
  const norm = (x) => pjoin(...x.split(/[\/]+/))
  const byNorm = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]))
  return (path) => {
    if (byNorm.has(norm(path))) return byNorm.get(norm(path))
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
  }
}

test("readDesktopCredential decrypts the desktop session and reports the username", async () => {
  const key = randomBytes(32)
  const keyBlob = Buffer.concat([Buffer.from("DPAPI", "latin1"), key])
  const session = { accessToken: "jwt.def", userInfo: { username: "jy960815", id: "uuid-1" }, bffPublicBaseUrl: "https://x/v1" }
  const cred = await readDesktopCredential({
    platform: "win32",
    env: { APPDATA: "/w/Roaming" },
    homedir: "/home/t",
    readFileImpl: fixtureFs({
      [pjoin("/w/Roaming", "AgnesCode", "Local State")]: Buffer.from(JSON.stringify({ os_crypt: { encrypted_key: keyBlob.toString("base64") } })),
      [pjoin("/w/Roaming", "AgnesCode", "code-auth-session.v1")]: frame(key, session),
    }),
    dpapiImpl: async (blob) => blob,
  })
  assert.equal(cred.key, "jwt.def")
  assert.equal(cred.accountId, "jy960815")
  assert.equal(cred.username, "jy960815")
  assert.match(cred.source, /code-auth-session\.v1$/)
})

test("readDesktopCredential rejects expired logins with an actionable message", async () => {
  const key = randomBytes(32)
  const keyBlob = Buffer.concat([Buffer.from("DPAPI", "latin1"), key])
  const expired = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 100 })).toString("base64url")}.s`
  await assert.rejects(
    readDesktopCredential({
      platform: "win32",
      env: { APPDATA: "/w/Roaming" },
      homedir: "/home/t",
      readFileImpl: fixtureFs({
        [pjoin("/w/Roaming", "AgnesCode", "Local State")]: Buffer.from(JSON.stringify({ os_crypt: { encrypted_key: keyBlob.toString("base64") } })),
        [pjoin("/w/Roaming", "AgnesCode", "code-auth-session.v1")]: frame(key, { accessToken: expired, userInfo: { username: "x" }, bffPublicBaseUrl: "https://x/v1" }),
      }),
      dpapiImpl: async (blob) => blob,
    }),
    /重新登录/,
  )
})

test("readDesktopCredential tells an empty machine from an unreadable one", async () => {
  // 什么都没有 = missing（新机器），不该把「这台机器上没有」说成读不出来
  await assert.rejects(
    readDesktopCredential({ platform: "win32", env: { APPDATA: "/w/Roaming" }, homedir: "/home/t", readFileImpl: fixtureFs({}) }),
    (e) => e.code === "missing" && !/AgnesCode（/.test(e.message),
  )
  // 有文件但读不出来 = unreadable，原因要留在 message 里给用户看
  await assert.rejects(
    readDesktopCredential({
      platform: "win32",
      env: { APPDATA: "/w/Roaming" },
      homedir: "/home/t",
      readFileImpl: fixtureFs({ [pjoin("/w/Roaming", "AgnesCode", "Local State")]: Buffer.from("{ 不是 JSON") }),
    }),
    (e) => e.code === "unreadable" && /不是有效|Unexpected|JSON/i.test(e.message),
  )
})

test("readDesktopCredential refuses non-Windows with a clear pointer before touching disk", async () => {
  let reads = 0
  await assert.rejects(
    readDesktopCredential({
      platform: "darwin",
      homedir: "/home/t",
      readFileImpl: () => {
        reads += 1
        return Buffer.from("{}")
      },
    }),
    /仅支持 Windows/,
  )
  assert.equal(reads, 0)
})

test("paste login method stores the access token and optional username", async () => {
  const plugin = createPlugin()
  const method = plugin.auth.methods[1]
  assert.match(method.label, /粘贴/)
  const out = await method.authorize({ accessToken: "jwt.paste", username: "u9" })
  assert.deepEqual(out, {
    type: "success",
    key: "jwt.paste",
    accountId: "u9",
    metadata: { username: "u9", source: "paste", method: "paste" },
  })

  const bare = await method.authorize({ accessToken: "jwt.paste" })
  assert.equal(bare.type, "success")
  assert.equal(bare.metadata.username, undefined)

  const missing = await method.authorize({ username: "u9" })
  assert.equal(missing.type, "failed")
  assert.match(missing.error, /必填/)
})

const WIN_ENV = { APPDATA: "D:/AgnesTest" }

function winFiles(key, session) {
  const keyBlob = Buffer.concat([Buffer.from("DPAPI", "latin1"), key])
  return {
    [pjoin(WIN_ENV.APPDATA, "AgnesCode", "Local State")]: Buffer.from(
      JSON.stringify({ os_crypt: { encrypted_key: keyBlob.toString("base64") } }),
    ),
    [pjoin(WIN_ENV.APPDATA, "AgnesCode", "code-auth-session.v1")]: frame(key, session),
  }
}

test("desktop login method is oauth, so magpie shows no key input box", async () => {
  const plugin = await AgnesPlugin()
  // type:"api" 在 magpie 里就是一个 key 输入框 —— 本方法自己解磁盘，不该要用户输入。
  assert.equal(plugin.auth.methods[0].type, "oauth")
  assert.equal(plugin.auth.methods[0].prompts, undefined)
})

test("desktop login method decrypts the session and finishes right away", async () => {
  const key = randomBytes(32)
  const plugin = createPlugin({
    platform: "win32",
    env: WIN_ENV,
    dpapiImpl: async (blob) => blob,
    readFileImpl: fixtureFs(winFiles(key, { accessToken: "jwt.desk", userInfo: { username: "tester", id: "uuid-1" } })),
  })
  const out = await plugin.auth.methods[0].authorize()
  assert.equal(out.url, "")
  assert.match(out.instructions, /已读取本机 Agnes Code 登录态（tester）/)
  const result = await out.callback()
  assert.equal(result.type, "success")
  assert.equal(result.key, "jwt.desk")
  assert.equal(result.accountId, "tester")
  assert.equal(result.metadata.username, "tester")
  assert.match(result.metadata.source, /code-auth-session\.v1$/)
})

test("desktop login method points at the official site and waits when the session is missing", async () => {
  let clock = 0
  const slept = []
  const plugin = createPlugin({
    platform: "win32",
    env: WIN_ENV,
    dpapiImpl: async (blob) => blob,
    readFileImpl: fixtureFs({}),
    sleepImpl: async (ms) => {
      slept.push(ms)
      if (slept.length > 400) throw new Error("轮询没有封顶")
      clock += ms
    },
    nowMsImpl: () => clock,
  })
  const out = await plugin.auth.methods[0].authorize()
  assert.equal(out.url, OFFICIAL_SITE)
  assert.equal(out.method, "auto")
  assert.match(out.instructions, /没有读到 Agnes Code 桌面端登录态/)
  // 等不到就是 failed，并告诉他登录后重试
  const failed = await out.callback()
  assert.equal(failed.type, "failed")
  assert.match(failed.error, /重新点一次/)
  // 轮询被 DESKTOP_WAIT_MS 封顶，不会无限等下去
  assert.equal(slept.length, DESKTOP_WAIT_MS / 2000)
})

test("desktop login method completes on its own once the desktop logs in", async () => {
  const key = randomBytes(32)
  const base = fixtureFs(winFiles(key, { accessToken: "jwt.late", userInfo: { username: "late" } }))
  const sessionPath = pjoin(WIN_ENV.APPDATA, "AgnesCode", "code-auth-session.v1")
  let sessionReads = 0
  const plugin = createPlugin({
    platform: "win32",
    env: WIN_ENV,
    dpapiImpl: async (blob) => blob,
    sleepImpl: async () => {},
    readFileImpl: (path) => {
      if (pjoin(path) === pjoin(sessionPath)) {
        sessionReads += 1
        if (sessionReads < 3) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      }
      return base(path)
    },
  })
  const out = await plugin.auth.methods[0].authorize()
  assert.equal(out.url, OFFICIAL_SITE)
  assert.equal((await out.callback()).key, "jwt.late")
  assert.equal(sessionReads, 3)
})

test("desktop login method refuses to poll on non-Windows", async () => {
  const plugin = createPlugin({ platform: "linux", homedir: "/home/t", readFileImpl: fixtureFs({}) })
  // 宿主 host.js 不看 oauth authorize 结果里的 type，只看抛出的 message / callback；
  // 抛错在任何宿主版本上都把原因原样交给用户。
  await assert.rejects(() => plugin.auth.methods[0].authorize({}, {}), /粘贴 accessToken/)
})

test("readDesktopCredential keeps a read error instead of calling the machine empty", async () => {
  await assert.rejects(
    readDesktopCredential({
      platform: "win32",
      env: WIN_ENV,
      readFileImpl: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
      },
    }),
    (e) => e.code === "unreadable" && /读取失败|EACCES/.test(e.message),
  )
})

test("desktop login method explains an expired or unreadable session", async () => {
  const key = randomBytes(32)
  const expired = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 })).toString("base64url")}.s`
  const plugin = createPlugin({
    platform: "win32",
    env: WIN_ENV,
    dpapiImpl: async (blob) => blob,
    readFileImpl: fixtureFs(winFiles(key, { accessToken: expired, userInfo: { username: "tester" } })),
  })
  const out = await plugin.auth.methods[0].authorize({}, {})
  assert.equal(out.url, OFFICIAL_SITE)
  assert.match(out.instructions, /登录已过期/)
  assert.doesNotMatch(out.instructions, /本机没有读到/)
})

test("desktop login method reports the last reason when it times out", async () => {
  const key = randomBytes(32)
  // 假时钟从「现在」起步：JWT 才算过期，deadline 也还能走到
  let clock = Date.now()
  const slept = []
  const expired = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(clock / 1000) - 60 })).toString("base64url")}.s`
  const plugin = createPlugin({
    platform: "win32",
    env: WIN_ENV,
    dpapiImpl: async (blob) => blob,
    readFileImpl: fixtureFs(winFiles(key, { accessToken: expired, userInfo: { username: "t" } })),
    sleepImpl: async (ms) => {
      slept.push(ms)
      if (slept.length > 400) throw new Error("轮询没有封顶")
      clock += ms
    },
    nowMsImpl: () => clock,
  })
  const out = await plugin.auth.methods[0].authorize({}, {})
  const failed = await out.callback(undefined, {})
  assert.equal(failed.type, "failed")
  assert.match(failed.error, /登录已过期/)
})

test("desktop login method stops polling when the sign-in is cancelled", async () => {
  let clock = 0
  const slept = []
  const controller = new AbortController()
  const plugin = createPlugin({
    platform: "win32",
    env: WIN_ENV,
    dpapiImpl: async (blob) => blob,
    readFileImpl: fixtureFs({}),
    sleepImpl: async (ms) => {
      slept.push(ms)
      clock += ms
      controller.abort()
    },
    nowMsImpl: () => clock,
  })
  const out = await plugin.auth.methods[0].authorize({}, { signal: controller.signal })
  const failed = await out.callback(undefined, { signal: controller.signal })
  assert.equal(failed.type, "failed")
  assert.match(failed.error, /取消/)
  assert.equal(slept.length, 1)
})

test("the desktop master key is decrypted once per sign-in, not once per poll", async () => {
  const key = randomBytes(32)
  // 会话读得出来、但 JWT 已过期 ⇒ 每次轮询都会走到解密那一步，缓存与不缓存能分开
  let clock = Date.now()
  const slept = []
  const expired = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(clock / 1000) - 60 })).toString("base64url")}.s`
  let dpapiCalls = 0
  const plugin = createPlugin({
    platform: "win32",
    env: WIN_ENV,
    dpapiImpl: async (blob) => {
      dpapiCalls += 1
      return blob
    },
    sleepImpl: async (ms) => {
      slept.push(ms)
      if (slept.length > 400) throw new Error("轮询没有封顶")
      clock += ms
    },
    nowMsImpl: () => clock,
    readFileImpl: fixtureFs(winFiles(key, { accessToken: expired, userInfo: { username: "late" } })),
  })
  const out = await plugin.auth.methods[0].authorize({}, {})
  assert.equal((await out.callback(undefined, {})).type, "failed")
  assert.ok(slept.length > 1, "应该轮询了不止一次")
  assert.equal(dpapiCalls, 1) // 轮询再多次，主密钥也只解一次
})

test("dpapiUnprotect kills a stuck PowerShell instead of waiting forever", async () => {
  const { EventEmitter } = await import("node:events")
  const fakeSpawn = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.kill = () => child.emit("close", null)
    return child
  }
  const plugin = createPlugin({ platform: "win32" })
  // 万一超时保护被删掉，这里也不能挂死：guard 先报红
  const guard = new Promise((_, reject) => setTimeout(() => reject(new Error("dpapiUnprotect 挂住了：子进程没被杀掉")), 300))
  // platform 显式传 win32：这条测的是超时，不该跟着跑测试的机器变
  await assert.rejects(Promise.race([dpapiUnprotect(Buffer.from("blob"), fakeSpawn, { timeoutMs: 0, platform: "win32" }), guard]), /DPAPI 解密超时/)
  assert.equal(plugin.auth.provider, ID) // 顺手确认插件实例仍然可建
})

test("dpapiUnprotect refuses a machine that is not Windows, before spawning anything", async () => {
  let spawned = 0
  const spawnImpl = () => {
    spawned += 1
    throw new Error("不该起子进程")
  }
  await assert.rejects(dpapiUnprotect(Buffer.from("blob"), spawnImpl, { platform: "darwin" }), /仅支持 Windows/)
  assert.equal(spawned, 0)
})

test("config hook declares the chat-completions provider without clobbering user config", async () => {
  const plugin = createPlugin()
  const cfg = {}
  await plugin.config(cfg)
  assert.equal(cfg.provider[ID].npm, "@ai-sdk/openai-compatible")
  assert.equal(cfg.provider[ID].api, CHAT_GATEWAY_BASE)
  assert.ok(cfg.provider[ID].models["agnes-3.0-flash"])

  const existing = { provider: { [ID]: { name: "mine" } } }
  await plugin.config(existing)
  assert.deepEqual(existing.provider[ID], { name: "mine" })
})

test("loader hands the token to the openai-compatible provider; no auth yields empty", async () => {
  const plugin = createPlugin()
  assert.deepEqual(await plugin.auth.loader(async () => undefined), {})
  assert.deepEqual(await plugin.auth.loader(async () => ({ type: "api", key: "k" })), { baseURL: CHAT_GATEWAY_BASE, apiKey: "k" })
})

const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

test("models hook maps the live catalog and keeps the old list on network failure", async () => {
  const plugin = createPlugin({
    fetchImpl: async (url) => {
      assert.equal(String(url), MODELS_URL)
      return jsonRes({ data: [MODEL_ENTRY, { id: "kimi-k3", max_input_tokens: 1048576, max_output_tokens: 131072 }] })
    },
  })
  const rows = await plugin.provider.models({ models: {} }, { auth: { type: "api", key: "k" } })
  assert.deepEqual(Object.keys(rows), ["agnes-3.0-flash", "kimi-k3"])
  assert.equal(rows["kimi-k3"].reasoning, false)

  const keep = createPlugin({ fetchImpl: async () => { throw new Error("down") } })
  const previousProvider = { models: { kept: true } }
  assert.deepEqual(
    await keep.provider.models(previousProvider, { auth: { type: "api", key: "k" } }),
    previousProvider.models,
  )

  const expired = createPlugin({ fetchImpl: async () => jsonRes({}, 401) })
  await assert.rejects(
    expired.provider.models({ models: {} }, { auth: { type: "api", key: "k" } }),
    (e) => e.signIn === "expired",
  )

  const malformed = createPlugin({ fetchImpl: async () => jsonRes({ data: {} }) })
  await assert.rejects(malformed.provider.models({ models: {} }, { auth: { type: "api", key: "k" } }))
})

const BALANCE = { total_balance: 600, time_sensitive_balance: 600, permanent_balance: 0, level: 0, level_name: "" }

test("usage maps the balance into quota windows", async () => {
  const plugin = createPlugin({ fetchImpl: async (url) => {
    assert.match(String(url), /credits-balance/)
    return jsonRes({ code: "000000", message: "success", data: BALANCE })
  } })
  const out = await plugin.auth.usage(async () => ({ type: "api", key: "k" }))
  assert.equal(out.plan, "Free")
  assert.deepEqual(out.windows[0], { name: "积分", balance: 600, aside: false })
  assert.deepEqual(out.windows[1], { name: "限时积分", balance: 600, aside: true })

  const named = createPlugin({ fetchImpl: async () => jsonRes({ code: "000000", data: { ...BALANCE, level_name: "Plus", permanent_balance: 50, time_sensitive_balance: 0 } }) })
  const out2 = await named.auth.usage(async () => ({ type: "api", key: "k" }))
  assert.equal(out2.plan, "Plus")
  assert.deepEqual(out2.windows.map((w) => w.name), ["积分", "永久积分"])

  const expired = createPlugin({ fetchImpl: async () => jsonRes({}, 401) })
  const err = await expired.auth.usage(async () => ({ type: "api", key: "k" }))
  assert.equal(err.signIn, "expired")
})

const checkinFetch = (balanceSequence) => {
  let calls = 0
  return async (input) => {
    const url = String(input)
    if (url.includes("credits-balance")) {
      calls += 1
      return jsonRes({ code: "000000", data: { ...BALANCE, total_balance: balanceSequence[Math.min(calls - 1, balanceSequence.length - 1)] } })
    }
    if (url.includes("/v1/models")) return jsonRes({ data: [] })
    throw new Error(`unexpected ${url}`)
  }
}

test("check-in observes the balance delta around the session touch", async () => {
  const claimed = createPlugin({ fetchImpl: checkinFetch([600, 1200]), sleepImpl: async () => {} })
  const out = await claimed.auth.checkin(async () => ({ type: "api", key: "k" }))
  assert.deepEqual(out, { outcome: "claimed", credit: 600, message: "每日登录积分 +600" })

  const unobserved = createPlugin({ fetchImpl: checkinFetch([600, 600]), sleepImpl: async () => {} })
  const out2 = await unobserved.auth.checkin(async () => ({ type: "api", key: "k" }))
  // 余额没涨不谎称 done（宿主渲染成「今日已签到」）：inactive + 实情 message。
  assert.equal(out2.outcome, "inactive")
  assert.match(out2.message, /未观测到新发放/)
})

test("check-in propagates dead sessions as signIn expired", async () => {
  const dead = createPlugin({ fetchImpl: async () => jsonRes({}, 401), sleepImpl: async () => {} })
  await assert.rejects(
    dead.auth.checkin(async () => ({ type: "api", key: "k" })),
    (e) => e.signIn === "expired",
  )
})

test("module export is a plugin factory", async () => {
  const plugin = await AgnesPlugin()
  assert.equal(typeof plugin.config, "function")
  assert.equal(typeof plugin.auth.checkin, "function")
  assert.equal(plugin.auth.methods.length, 2)
})
