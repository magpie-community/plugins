import test from "node:test"
import assert from "node:assert/strict"
import { AStudioPlugin, _internal } from "./index.mjs"

const {
  createPlugin,
  rowFromCatalogEntry,
  bootstrapRows,
  readDesktopCredential,
  waitForDesktopCredential,
  readAcodeConfigToken,
  registryDataRoots,
  buildCookieHeader,
  studioJson,
  MODEL_GATEWAY_BASE,
  MODEL_MANAGER_URL,
  STUDIO_API_BASE,
  STUDIO_VERSION,
  OFFICIAL_SITE,
  DESKTOP_WAIT_MS,
  ID,
} = _internal

const CATALOG_ENTRY = {
  slug: "spark-x2.6-4b",
  badge: { text: { en: "Free", "zh-CN": "限免" } },
  visibility: "list",
  display_name: "Spark-X2.6-Lite",
  description: "Spark-X2.6-Lite 文本模型。",
  context_window: 1048576,
  max_context_window: 1048576,
  max_output_tokens: 110000,
  input_modalities: ["text"],
  supported_in_api: true,
  default_reasoning_level: "high",
  supported_reasoning_levels: [
    { effort: "none", description: "关闭思考" },
    { effort: "high", description: "高强度思考" },
    { effort: "max", description: "最大强度思考" },
  ],
  supports_parallel_tool_calls: true,
}

test("rowFromCatalogEntry maps the live catalog shape", () => {
  const m = rowFromCatalogEntry(CATALOG_ENTRY)
  assert.equal(m.id, "spark-x2.6-4b")
  assert.equal(m.name, "Spark-X2.6-Lite")
  assert.deepEqual(m.limit, { context: 1048576, output: 110000 })
  assert.equal(m.reasoning, true)
  assert.equal(m.tool_call, true)
  assert.equal(m.free, true)
  assert.deepEqual(m.variants, {
    none: { reasoningEffort: "none" },
    high: { reasoningEffort: "high" },
    max: { reasoningEffort: "max" },
  })
  assert.equal(m.capabilities.input.image, false)
})

test("rowFromCatalogEntry degrades safely on sparse entries", () => {
  const m = rowFromCatalogEntry({ slug: "m1", display_name: "M1", input_modalities: ["text", "image"] })
  assert.deepEqual(m.limit, { context: 0, output: 32768 })
  assert.equal(m.reasoning, false)
  assert.equal("variants" in m, false)
  assert.equal(m.capabilities.attachment, true)
  assert.equal(m.capabilities.input.image, true)

  const none = rowFromCatalogEntry({
    slug: "m2",
    supported_reasoning_levels: [{ effort: "none" }],
  })
  assert.equal(none.reasoning, false)
  assert.equal("variants" in none, false)
})

test("bootstrap table covers the observed catalog", () => {
  const rows = bootstrapRows()
  assert.equal(Object.keys(rows).length, 7)
  for (const id of ["astronclaw-auto", "spark-x2.6", "spark-x2.6-4b", "xopglm52", "xopdeepseekv4pro0813"]) {
    assert.ok(rows[id], `missing ${id}`)
  }
  assert.equal(rows["spark-x2.6-4b"].free, true)
  assert.equal(rows["xopglm52"].limit.context, 1048576)
})

test("readAcodeConfigToken parses the astron-spark section", () => {
  const toml = `
[features]
hooks = true

[model_providers.astron-spark]
name = "Astron Spark"
experimental_bearer_token = "tok-abc"
uid = "18800000000"

[marketplaces.x]
last_updated = "2026-10-31T16:27:14Z"
`
  assert.deepEqual(readAcodeConfigToken(toml), { key: "tok-abc", uid: "18800000000" })
  assert.equal(readAcodeConfigToken("[other]\nkey = \"x\""), null)
  assert.equal(readAcodeConfigToken("[model_providers.astron-spark]\nname = \"Astron Spark\""), null)
})

function fakeFs(files) {
  return (path) => {
    if (path in files) return files[path]
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
  }
}

test("readDesktopCredential reads the desktop session via ASTUDIO_HOME", () => {
  const cred = readDesktopCredential({
    env: { ASTUDIO_HOME: "F:\\AStudio Data" },
    readFileImpl: fakeFs({
      "F:\\AStudio Data/userdata/astron-session.json": JSON.stringify({
        uid: "18800000000", accountId: "18800000000", banned: false,
        modelBearerToken: "tok-65", token: "tok-36", loginMethod: "wechat",
      }),
    }),
  })
  assert.deepEqual(cred, {
    key: "tok-65",
    uid: "18800000000",
    session: { token: "tok-36", ssoSessionId: undefined, accountId: "18800000000" },
    source: "F:\\AStudio Data/userdata/astron-session.json",
  })
})

test("readDesktopCredential falls back to token and to the acode config", () => {
  const cred = readDesktopCredential({
    env: { ASTUDIO_HOME: "D:\\astudio" },
    readFileImpl: fakeFs({
      "D:\\astudio/userdata/astron-session.json": JSON.stringify({ uid: "u1", token: "tok-36" }),
    }),
  })
  assert.deepEqual(cred, { key: "tok-36", uid: "u1", session: undefined, source: "D:\\astudio/userdata/astron-session.json" })

  const cred2 = readDesktopCredential({
    env: { ASTUDIO_HOME: "D:\\astudio" },
    readFileImpl: fakeFs({
      "D:\\astudio/runtime/acode-home/config.toml": '[model_providers.astron-spark]\nexperimental_bearer_token = "tok-cfg"\nuid = "u2"\n',
    }),
  })
  assert.deepEqual(cred2, { key: "tok-cfg", uid: "u2", session: undefined, source: "D:\\astudio/runtime/acode-home/config.toml" })
})

test("readDesktopCredential uses registry roots and rejects banned accounts", () => {
  const cred = readDesktopCredential({
    env: {},
    registryQuery: (key, name) => (name === "ProductionDataRoot" ? "F:\\AStudio Data" : null),
    readFileImpl: fakeFs({
      "F:\\AStudio Data/userdata/astron-session.json": JSON.stringify({ uid: "u3", modelBearerToken: "tok-reg" }),
    }),
  })
  assert.equal(cred.key, "tok-reg")

  assert.throws(
    () => readDesktopCredential({
      env: { ASTUDIO_HOME: "D:\\astudio" },
      readFileImpl: fakeFs({
        "D:\\astudio/userdata/astron-session.json": JSON.stringify({ banned: true, modelBearerToken: "x" }),
      }),
    }),
    /封禁/,
  )

  assert.throws(
    () => readDesktopCredential({ env: {}, readFileImpl: fakeFs({}) }),
    /未找到 AStudio 桌面端登录态/,
  )
})

test("registryDataRoots queries each profile prefix", () => {
  const seen = []
  const roots = registryDataRoots((key, name) => {
    seen.push(`${key}|${name}`)
    return name === "ProductionDataRoot" ? "C:\\data" : null
  })
  assert.deepEqual(roots, ["C:\\data"])
  assert.ok(seen.includes("HKCU\\Software\\AStudioStorage|ProductionDataRoot"))
  assert.ok(seen.includes("HKCU\\Software\\AStudioStorage|CanaryDataRoot"))
})

test("config hook declares the Responses provider without clobbering user config", async () => {
  const plugin = createPlugin()
  const cfg = {}
  await plugin.config(cfg)
  assert.equal(cfg.provider[ID].npm, "@ai-sdk/openai")
  assert.equal(cfg.provider[ID].api, MODEL_GATEWAY_BASE)
  assert.ok(cfg.provider[ID].models["astronclaw-auto"])

  const existing = { provider: { [ID]: { name: "mine" } } }
  await plugin.config(existing)
  assert.deepEqual(existing.provider[ID], { name: "mine" })
})

test("loader hands the key to the OpenAI provider; no auth yields empty", async () => {
  const plugin = createPlugin()
  assert.deepEqual(await plugin.auth.loader(async () => undefined), {})
  const out = await plugin.auth.loader(async () => ({ type: "api", key: "k" }))
  assert.deepEqual(out, { baseURL: MODEL_GATEWAY_BASE, apiKey: "k" })
})

const okRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

test("models hook maps the live catalog and keeps the old list on network failure", async () => {
  const plugin = createPlugin({
    fetchImpl: async (url) => {
      assert.equal(url, MODEL_MANAGER_URL)
      return okRes({ code: 0, data: { models: [CATALOG_ENTRY, { slug: "xopglm52", display_name: "GLM-5.2", context_window: 1048576, max_output_tokens: 32768, input_modalities: ["text"], visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "high" }] }] } })
    },
  })
  const rows = await plugin.provider.models({ models: {} }, { auth: { type: "api", key: "k" } })
  assert.deepEqual(Object.keys(rows), ["spark-x2.6-4b", "xopglm52"])
  assert.equal(rows["spark-x2.6-4b"].free, true)

  const keep = createPlugin({ fetchImpl: async () => { throw new Error("down") } })
  const previousProvider = { models: { kept: true } }
  assert.deepEqual(
    await keep.provider.models(previousProvider, { auth: { type: "api", key: "k" } }),
    previousProvider.models,
  )

  const expired = createPlugin({ fetchImpl: async () => okRes({}, 401) })
  await assert.rejects(
    expired.provider.models({ models: {} }, { auth: { type: "api", key: "k" } }),
    (e) => e.signIn === "expired",
  )

  const malformed = createPlugin({ fetchImpl: async () => okRes({ data: {} }) })
  await assert.rejects(malformed.provider.models({ models: {} }, { auth: { type: "api", key: "k" } }))
})

test("usage hook checks the credential without burning quota", async () => {
  const ok = createPlugin({ fetchImpl: async () => okRes({ code: 0, data: { models: [] } }) })
  assert.deepEqual(await ok.auth.usage(async () => ({ type: "api", key: "k" })), { plan: "AStudio", windows: [] })

  const expired = createPlugin({ fetchImpl: async () => okRes({}, 403) })
  const out = await expired.auth.usage(async () => ({ type: "api", key: "k" }))
  assert.equal(out.signIn, "expired")

  const down = createPlugin({ fetchImpl: async () => { throw new Error("no route") } })
  const err = await down.auth.usage(async () => ({ type: "api", key: "k" }))
  assert.match(err.error, /不可达/)

  assert.deepEqual(await ok.auth.usage(async () => undefined), {})
})

test("desktop login method is oauth, so magpie shows no key input box", () => {
  const plugin = createPlugin({ env: {}, registryQuery: () => null, readFileImpl: fakeFs({}) })
  const method = plugin.auth.methods[0]
  // type:"api" 在 magpie 里就是一个 key 输入框 —— 本方法自己读磁盘，不该要用户输入。
  assert.equal(method.type, "oauth")
  assert.match(method.label, /桌面端/)
  assert.equal(method.prompts, undefined)
})

test("desktop login method reads real files through authorize", async () => {
  const plugin = createPlugin({
    env: { ASTUDIO_HOME: "D:\\astudio" },
    registryQuery: () => null,
    readFileImpl: fakeFs({
      "D:\\astudio/userdata/astron-session.json": JSON.stringify({ uid: "u9", modelBearerToken: "tok-9" }),
    }),
  })
  const out = await plugin.auth.methods[0].authorize({})
  assert.equal(out.url, "")
  assert.match(out.instructions, /已读取本机 AStudio 登录态（u9）/)
  assert.equal(out.method, "auto")
  assert.deepEqual(await out.callback(), {
    type: "success",
    key: "tok-9",
    accountId: "u9",
    metadata: { uid: "u9", source: "D:\\astudio/userdata/astron-session.json", method: "desktop", session: undefined },
  })
})

test("desktop login method points at the official site and waits when nothing is on disk", async () => {
  let clock = 0
  const slept = []
  const plugin = createPlugin({
    env: {},
    registryQuery: () => null,
    readFileImpl: fakeFs({}),
    sleepImpl: async (ms) => {
      slept.push(ms)
      // 变异把 deadline 判断删掉时这里立刻报红，而不是让假 sleep 把事件循环占死。
      if (slept.length > 400) throw new Error("轮询没有封顶")
      clock += ms
    },
    nowMsImpl: () => clock,
  })
  const out = await plugin.auth.methods[0].authorize({})
  assert.equal(out.url, OFFICIAL_SITE)
  assert.equal(out.method, "auto")
  assert.match(out.instructions, /没有找到 AStudio 桌面端登录态/)
  // 用户去装桌面端：等不到就是 failed，并告诉他装好后重试
  const failed = await out.callback()
  assert.equal(failed.type, "failed")
  assert.match(failed.error, /重新点一次/)
  // 轮询被 DESKTOP_WAIT_MS 封顶，不会无限等下去
  assert.equal(slept.length, DESKTOP_WAIT_MS / 2000)
})

test("desktop login method completes on its own once the desktop signs in", async () => {
  const session = JSON.stringify({ uid: "u7", modelBearerToken: "tok-7" })
  let reads = 0
  const plugin = createPlugin({
    env: { ASTUDIO_HOME: "D:\\astudio" },
    registryQuery: () => null,
    sleepImpl: async () => {},
    readFileImpl: (path) => {
      if (path !== "D:\\astudio/userdata/astron-session.json") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      reads += 1
      if (reads < 3) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      return session
    },
  })
  const out = await plugin.auth.methods[0].authorize({})
  assert.equal(out.url, OFFICIAL_SITE)
  assert.equal(reads, 1) // authorize 读一次
  assert.equal((await out.callback()).key, "tok-7")
  assert.equal(reads, 3)
})

test("waitForDesktopCredential stops at the deadline", async () => {
  let clock = 0
  const slept = []
  const result = await waitForDesktopCredential({
    read: () => ({ error: new Error("没找到") }),
    sleep: async (ms) => {
      slept.push(ms)
      clock += ms
    },
    now: () => clock,
    waitMs: 5000,
    stepMs: 2000,
  })
  assert.equal(result.status, "timeout")
  assert.equal(result.error.message, "没找到") // 超时要把最后一次的原因带出来
  assert.deepEqual(slept, [2000, 2000, 2000])
})

test("desktop login method refuses banned accounts instead of offering the site", async () => {
  const plugin = createPlugin({
    env: { ASTUDIO_HOME: "D:\\astudio" },
    registryQuery: () => null,
    readFileImpl: fakeFs({
      "D:\\astudio/userdata/astron-session.json": JSON.stringify({ banned: true, modelBearerToken: "tok" }),
    }),
  })
  // 宿主 host.js 不看 oauth authorize 结果里的 type，只看它抛出的 message 或 callback；
  // 抛错在任何宿主版本上都把原因原样交给用户。
  await assert.rejects(() => plugin.auth.methods[0].authorize({}, {}), /封禁/)
})

test("desktop login method explains an unreadable session instead of pointing at install", async () => {
  const plugin = createPlugin({
    env: { ASTUDIO_HOME: "D:\\astudio" },
    registryQuery: () => null,
    readFileImpl: fakeFs({ "D:\\astudio/userdata/astron-session.json": "{ 不是 JSON" }),
  })
  const out = await plugin.auth.methods[0].authorize({}, {})
  assert.equal(out.url, OFFICIAL_SITE)
  assert.match(out.instructions, /不是有效 JSON/)
  assert.doesNotMatch(out.instructions, /本机没有找到/)
})

test("desktop login method keeps a read error instead of calling the machine empty", async () => {
  const plugin = createPlugin({
    env: { ASTUDIO_HOME: "D:\\astudio" },
    registryQuery: () => null,
    readFileImpl: () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
    },
  })
  const out = await plugin.auth.methods[0].authorize({}, {})
  assert.match(out.instructions, /读取失败.*EACCES/s) // 读不了 ≠ 没装
})

test("desktop login method reports the last reason when it times out", async () => {
  let clock = 0
  const slept = []
  const plugin = createPlugin({
    env: { ASTUDIO_HOME: "D:\\astudio" },
    registryQuery: () => null,
    readFileImpl: fakeFs({ "D:\\astudio/userdata/astron-session.json": "{}" }),
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
  assert.match(failed.error, /没有 modelBearerToken.token/)
})

test("desktop login method stops polling when the sign-in is cancelled", async () => {
  let clock = 0
  const slept = []
  const controller = new AbortController()
  const plugin = createPlugin({
    env: {},
    registryQuery: () => null,
    readFileImpl: fakeFs({}),
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
  assert.equal(slept.length, 1) // 取消后不再空转
})

test("desktop credential carries the cookie session for points and check-in", () => {
  const cred = readDesktopCredential({
    env: { ASTUDIO_HOME: "D:\\astudio" },
    readFileImpl: fakeFs({
      "D:\\astudio/userdata/astron-session.json": JSON.stringify({
        uid: "18800000000", accountId: "18800000000", token: "tok-36", ssoSessionId: "sso-36", modelBearerToken: "tok-65",
      }),
    }),
  })
  assert.deepEqual(cred.session, { token: "tok-36", ssoSessionId: "sso-36", accountId: "18800000000" })
})

test("buildCookieHeader mirrors the desktop client", () => {
  assert.equal(
    buildCookieHeader({ token: "T", ssoSessionId: "S", accountId: "A" }),
    "ssoSessionId=S; sso_sessionid=S; account_id=A; token=T",
  )
  assert.equal(buildCookieHeader({ token: "T", accountId: "A" }), "account_id=A; token=T")
  assert.equal(buildCookieHeader(undefined), "")
})

const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

test("studioJson unwraps the envelope and flags dead sessions", async () => {
  const session = { token: "T", ssoSessionId: "S", accountId: "A" }
  const data = await studioJson("points/balance", {
    session,
    operation: "测试",
    fetchImpl: async (input, init) => {
      assert.equal(String(input), STUDIO_API_BASE + "points/balance")
      assert.match(init.headers.cookie, /sso_sessionid=S/)
      return jsonRes({ flag: true, code: 0, desc: "成功", data: { totalBalance: 1 } })
    },
  })
  assert.deepEqual(data, { totalBalance: 1 })

  await assert.rejects(
    studioJson("points/balance", { session, operation: "测试", fetchImpl: async () => jsonRes({ flag: false, code: 80000, desc: "登录异常，请重新登录" }) }),
    (e) => e.signIn === "expired",
  )
  await assert.rejects(
    studioJson("points/balance", { session, operation: "测试", fetchImpl: async () => jsonRes({}, 401) }),
    (e) => e.signIn === "expired",
  )
  await assert.rejects(
    studioJson("points/balance", { session, operation: "测试", fetchImpl: async () => jsonRes({ flag: true, code: 500, desc: "boom" }) }),
    /boom/,
  )
})

test("studioJson via usage: balance and membership map to quota windows", async () => {
  const session = { token: "T", ssoSessionId: "S", accountId: "A" }
  const plugin = createPlugin({
    fetchImpl: async (input) => {
      const url = String(input)
      if (url.includes("points/balance")) {
        return jsonRes({ flag: true, code: 0, data: { totalBalance: 7900, activityBalance: 7900, activityNextExpireTime: "2026-11-03T06:11:12", sparkTotalBalance: 35000, sparkActivityBalance: 35000 } })
      }
      if (url.includes("membership/me")) {
        return jsonRes({ flag: true, code: 0, data: { uid: 18800000000, active: true, planCode: "TRIAL", planName: "体验版" } })
      }
      throw new Error(`unexpected ${url}`)
    },
  })
  const out = await plugin.auth.usage(async () => ({ type: "api", key: "k", metadata: { session } }))
  assert.equal(out.plan, "体验版")
  assert.equal(out.user, "18800000000")
  assert.deepEqual(out.windows[0], { name: "通用积分", balance: 7900, aside: false, runsOutAt: "2026-11-03T06:11:12", runsOut: 7900 })
  assert.deepEqual(out.windows[1], { name: "星火积分", balance: 35000, aside: false })
})

const checkinFetch = (balanceSequence, { popups = [], identityAssert, popupFails = false } = {}) => {
  let balanceCalls = 0
  return async (input, init) => {
    const url = String(input)
    if (identityAssert) identityAssert(init.headers)
    if (url.includes("membership/plan-config")) {
      return jsonRes({ flag: true, code: 0, data: { dailyLoginEnabled: true, dailyLoginValidDays: 31, plans: [{ planCode: "TRIAL", dailyLoginPoints: 100 }] } })
    }
    if (url.includes("points/balance")) {
      balanceCalls += 1
      const total = balanceSequence[Math.min(balanceCalls - 1, balanceSequence.length - 1)]
      return jsonRes({ flag: true, code: 0, data: { totalBalance: total, activityBalance: total } })
    }
    if (url.includes("client-popups/pending")) {
      if (popupFails) return jsonRes({ flag: false, code: 11001001, desc: "客户端平台、版本或构建号无效", data: null })
      return jsonRes({ flag: true, code: 0, data: popups })
    }
    if (url.includes("membership/me") || url.includes("points/summary")) {
      return jsonRes({ flag: true, code: 0, data: {} })
    }
    throw new Error(`unexpected ${url}`)
  }
}

const dailyRewardPopup = [{
  popupId: 1, popupCode: "DAILY_LOGIN", popupType: "BANNER", componentType: "DAILY_REWARD_DIALOG",
  priority: 100, instanceKey: "2026-11-04", payload: { points: "100" },
}]

const checkinAuth = { type: "api", key: "k", metadata: { session: { token: "T", ssoSessionId: "S", accountId: "A" } } }

test("check-in observes the balance delta around the session touch", async () => {
  const claimed = createPlugin({ fetchImpl: checkinFetch([7900, 8000]), sleepImpl: async () => {} })
  const out = await claimed.auth.checkin(async () => checkinAuth)
  assert.deepEqual(out, { outcome: "claimed", credit: 100, message: "每日登录积分 +100" })

  const unobserved = createPlugin({ fetchImpl: checkinFetch([7900, 7900]), sleepImpl: async () => {} })
  const out2 = await unobserved.auth.checkin(async () => checkinAuth)
  // 余额没涨不谎称 done（宿主渲染成「今日已签到」）：inactive + 实情 message。
  assert.equal(out2.outcome, "inactive")
  assert.match(out2.message, /未观测到新发放/)
})

test("check-in reports ineligible without a session and inactive without the campaign", async () => {
  const noSession = createPlugin()
  const out = await noSession.auth.checkin(async () => ({ type: "api", key: "k", metadata: {} }))
  assert.equal(out.outcome, "ineligible")

  const inactive = createPlugin({
    fetchImpl: async () => jsonRes({ flag: true, code: 0, data: { dailyLoginEnabled: false, dailyLoginValidDays: 0, plans: [] } }),
    sleepImpl: async () => {},
  })
  const out2 = await inactive.auth.checkin(async () => checkinAuth)
  assert.equal(out2.outcome, "inactive")
})

test("check-in sends the desktop client identity on account requests", async () => {
  const seen = []
  const plugin = createPlugin({
    fetchImpl: checkinFetch([7900, 7900], {
      identityAssert: (headers) => seen.push(headers),
    }),
    sleepImpl: async () => {},
  })
  await plugin.auth.checkin(async () => checkinAuth)
  assert.equal(seen.length, 6)
  for (const headers of seen) {
    assert.equal(headers.clientType, process.platform === "darwin" ? "22" : "21")
    assert.equal(headers.studioVersion, STUDIO_VERSION)
  }
})

test("check-in reports done when the server has a pending daily reward popup", async () => {
  const plugin = createPlugin({ fetchImpl: checkinFetch([7900, 7900], { popups: dailyRewardPopup }), sleepImpl: async () => {} })
  const out = await plugin.auth.checkin(async () => checkinAuth)
  assert.deepEqual(out, { outcome: "done", credit: 100, message: "每日登录积分已发放（服务端待通知弹窗）" })
})

test("check-in omits credit when the daily reward popup has no usable points", async () => {
  for (const payload of [{}, { points: "0" }, { points: "n/a" }]) {
    const plugin = createPlugin({
      fetchImpl: checkinFetch([7900, 7900], { popups: [{ ...dailyRewardPopup[0], payload }] }),
      sleepImpl: async () => {},
    })
    const out = await plugin.auth.checkin(async () => checkinAuth)
    assert.deepEqual(out, { outcome: "done", message: "每日登录积分已发放（服务端待通知弹窗）" })
  }
})

test("check-in ignores other popup types", async () => {
  const plugin = createPlugin({
    fetchImpl: checkinFetch([7900, 7900], {
      popups: [{ ...dailyRewardPopup[0], componentType: "NEW_USER_DIALOG" }],
    }),
    sleepImpl: async () => {},
  })
  const out = await plugin.auth.checkin(async () => checkinAuth)
  assert.equal(out.outcome, "inactive")
})

test("check-in reports failed when the popup query is rejected", async () => {
  const plugin = createPlugin({ fetchImpl: checkinFetch([7900, 7900], { popupFails: true }), sleepImpl: async () => {} })
  const out = await plugin.auth.checkin(async () => checkinAuth)
  assert.equal(out.outcome, "failed")
  assert.match(out.message, /11001001|平台|版本/)
})

test("check-in propagates dead sessions as signIn expired", async () => {
  const dead = createPlugin({
    fetchImpl: async () => jsonRes({ flag: false, code: 80000, desc: "登录异常，请重新登录" }, 200),
    sleepImpl: async () => {},
  })
  await assert.rejects(
    dead.auth.checkin(async () => checkinAuth),
    (e) => e.signIn === "expired",
  )
})

test("paste login method stores key plus cookie session inputs", async () => {
  const plugin = createPlugin()
  const method = plugin.auth.methods[1]
  assert.match(method.label, /粘贴/)
  const out = await method.authorize({ modelBearerToken: "tok-p", uid: "u7", sessionToken: "tok-36", accountId: "A7", ssoSessionId: "sso-7" })
  assert.deepEqual(out, {
    type: "success",
    key: "tok-p",
    accountId: "A7",
    metadata: { uid: "u7", source: "paste", method: "paste", session: { token: "tok-36", accountId: "A7", ssoSessionId: "sso-7" } },
  })

  // 只有模型凭据也放行（无 Cookie 会话，积分/签到不可用），但缺失 key 拒绝。
  const bare = await method.authorize({ modelBearerToken: "tok-p" })
  assert.equal(bare.type, "success")
  assert.equal(bare.metadata.session, undefined)

  const missing = await method.authorize({})
  assert.equal(missing.type, "failed")
  assert.match(missing.error, /必填/)
})

test("fallback discovery honors the injected homedir", () => {
  const cred = readDesktopCredential({
    env: {},
    registryQuery: () => null,
    homedir: "/home/t",
    readFileImpl: fakeFs({
      "/home/t/.acode/acode/userdata/astron-session.json": JSON.stringify({ uid: "u8", modelBearerToken: "tok-8" }),
    }),
  })
  assert.equal(cred.key, "tok-8")
  assert.equal(cred.source, "/home/t/.acode/acode/userdata/astron-session.json")
})

test("usage keeps signIn expired when the cookie session dies mid-read", async () => {
  const plugin = createPlugin({ fetchImpl: async () => jsonRes({}, 401) })
  const out = await plugin.auth.usage(async () => ({
    type: "api",
    key: "k",
    metadata: { session: { token: "T", accountId: "A" } },
  }))
  assert.equal(out.signIn, "expired")
  assert.match(out.error, /会话已失效/)
})

test("module export is a plugin factory", async () => {
  const plugin = await AStudioPlugin()
  assert.equal(typeof plugin.config, "function")
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(plugin.auth.methods.length, 2)
})
