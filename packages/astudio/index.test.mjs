import test from "node:test"
import assert from "node:assert/strict"
import { AStudioPlugin, _internal } from "./index.mjs"
import * as astroBrowser from "./browser.mjs"

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
  exchangeModelToken,
  MODEL_GATEWAY_BASE,
  MODEL_MANAGER_URL,
  STUDIO_API_BASE,
  STUDIO_VERSION,
  STUDIO_WEB_URL,
  OFFICIAL_SITE,
  DESKTOP_WAIT_MS,
  ID,
} = _internal

const methodByLabel = (plugin, pattern) => {
  const method = plugin.auth.methods.find((m) => pattern.test(m.label))
  assert.ok(method, `没有找到匹配 ${pattern} 的登录方式`)
  return method
}
const desktopMethod = (plugin) => methodByLabel(plugin, /桌面端/)
const pasteMethod = (plugin) => methodByLabel(plugin, /粘贴/)
const webMethod = (plugin) => methodByLabel(plugin, /浏览器登录/)

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

test("catalog reads refuse redirects and carry a timeout", async () => {
  let init
  const plugin = createPlugin({
    fetchImpl: async (_url, options) => {
      init = options
      return okRes({ code: 0, data: { models: [CATALOG_ENTRY] } })
    },
  })
  await plugin.provider.models({ models: {} }, { auth: { type: "api", key: "k" } })
  assert.equal(init.redirect, "error")
  assert.ok(init.signal, "目录请求要带 AbortSignal 超时")
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
  const method = desktopMethod(plugin)
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
  const out = await desktopMethod(plugin).authorize({})
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
  const out = await desktopMethod(plugin).authorize({})
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
  const out = await desktopMethod(plugin).authorize({})
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
  await assert.rejects(() => desktopMethod(plugin).authorize({}, {}), /封禁/)
})

test("desktop login method explains an unreadable session instead of pointing at install", async () => {
  const plugin = createPlugin({
    env: { ASTUDIO_HOME: "D:\\astudio" },
    registryQuery: () => null,
    readFileImpl: fakeFs({ "D:\\astudio/userdata/astron-session.json": "{ 不是 JSON" }),
  })
  const out = await desktopMethod(plugin).authorize({}, {})
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
  const out = await desktopMethod(plugin).authorize({}, {})
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
  const out = await desktopMethod(plugin).authorize({}, {})
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
  const out = await desktopMethod(plugin).authorize({}, { signal: controller.signal })
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
    // 时钟钉在 2026-11-06：否则 11-22 之后这条断言会随真实时间过期。
    nowMsImpl: () => Date.parse("2026-11-06T00:00:00+08:00"),
    fetchImpl: async (input) => {
      const url = String(input)
      if (url.includes("points/balance")) {
        return jsonRes({ flag: true, code: 0, data: { totalBalance: 7900, activityBalance: 7900, activityNextExpireTime: "2026-11-03T06:11:12", sparkTotalBalance: 35000, sparkActivityBalance: 35000 } })
      }
      if (url.includes("membership/me")) {
        return jsonRes({ flag: true, code: 0, data: { uid: 18800000000, active: true, planCode: "TRIAL", planName: "体验版" } })
      }
      if (url.includes("points/details")) {
        return jsonRes({ flag: true, code: 0, data: { total: 1, items: [sparkGrantRow(35000, "2026-11-22T21:34:30")] } })
      }
      throw new Error(`unexpected ${url}`)
    },
  })
  const out = await plugin.auth.usage(async () => ({ type: "api", key: "k", metadata: { session } }))
  assert.equal(out.plan, "体验版")
  assert.equal(out.user, "18800000000")
  assert.deepEqual(out.windows[0], { name: "通用积分", balance: 7900, aside: false, runsOutAt: "2026-11-03T06:11:12", runsOut: 7900 })
  // 星火到期从入账流水推（balance 接口不给星火到期时间）。
  assert.deepEqual(out.windows[1], { name: "星火积分", balance: 35000, aside: false, runsOutAt: "2026-11-22T13:34:30.000Z", runsOut: 35000 })
})

test("usage spark window omits expiry when the ledger query fails", async () => {
  const session = { token: "T", ssoSessionId: "S", accountId: "A" }
  const plugin = createPlugin({
    fetchImpl: async (input) => {
      const url = String(input)
      if (url.includes("points/balance")) {
        return jsonRes({ flag: true, code: 0, data: { totalBalance: 7900, activityBalance: 7900, sparkTotalBalance: 35000, sparkActivityBalance: 35000 } })
      }
      if (url.includes("membership/me")) {
        return jsonRes({ flag: true, code: 0, data: { uid: 18800000000, active: true, planCode: "TRIAL", planName: "体验版" } })
      }
      if (url.includes("points/details")) {
        return jsonRes({ flag: false, code: 11001001, desc: "参数无效" })
      }
      throw new Error(`unexpected ${url}`)
    },
  })
  const out = await plugin.auth.usage(async () => ({ type: "api", key: "k", metadata: { session } }))
  // 到期推算失败不塌方：星火窗口退回无 runsOut 形态。
  assert.deepEqual(out.windows[1], { name: "星火积分", balance: 35000, aside: false })
})

const checkinFetch = (balanceSequence, { popups = [], popupsSequence, identityAssert, popupFails = false, onComplete, onInitApp, ledger, ledgerSequence, ledgerFails = false, sparkLedger, sparkPages } = {}) => {
  let balanceCalls = 0
  let popupCalls = 0
  let ledgerCalls = 0
  return async (input, init) => {
    const url = String(input)
    if (identityAssert) identityAssert(init.headers, init)
    if (url.includes("membership/plan-config")) {
      return jsonRes({ flag: true, code: 0, data: { dailyLoginEnabled: true, dailyLoginValidDays: 31, plans: [{ planCode: "TRIAL", dailyLoginPoints: 100 }] } })
    }
    if (url.includes("points/balance")) {
      balanceCalls += 1
      const total = balanceSequence[Math.min(balanceCalls - 1, balanceSequence.length - 1)]
      return jsonRes({ flag: true, code: 0, data: { totalBalance: total, activityBalance: total } })
    }
    if (url.includes("points/details")) {
      if (ledgerFails) return jsonRes({ flag: false, code: 11001001, desc: "参数无效" })
      // 当日窗口（起止同日）=「每日登录赠送」查询；跨 60 天窗口 = 星火到期查询。
      const params = new URL(url).searchParams
      const isDailyQuery = params.get("startTime")?.slice(0, 10) === params.get("endTime")?.slice(0, 10)
      if (!isDailyQuery && sparkPages) {
        const page = Number(params.get("pageNum") ?? 1)
        const items = sparkPages[page - 1] ?? []
        return jsonRes({ flag: true, code: 0, data: { total: 0, pageNum: page, pageSize: 50, items } })
      }
      // ledgerSequence 区分「签到前读」与「签到后读」：前者没有行，后者有。
      let items
      if (isDailyQuery) {
        ledgerCalls += 1
        items = ledgerSequence
          ? ledgerSequence[Math.min(ledgerCalls - 1, ledgerSequence.length - 1)]
          : ledger
      } else {
        items = sparkLedger
      }
      return jsonRes({ flag: true, code: 0, data: { total: items?.length ?? 0, pageNum: 1, pageSize: 50, items: items ?? [] } })
    }
    if (url.includes("client-popups/pending")) {
      if (popupFails) return jsonRes({ flag: false, code: 11001001, desc: "客户端平台、版本或构建号无效", data: null })
      popupCalls += 1
      // popupsSequence 区分「基线读」与「签到后读」：前者看旧弹窗，后者看新发放。
      const data = popupsSequence
        ? popupsSequence[Math.min(popupCalls - 1, popupsSequence.length - 1)]
        : popups
      return jsonRes({ flag: true, code: 0, data })
    }
    if (url.includes("client-popups/complete")) {
      if (onComplete) onComplete(JSON.parse(init.body))
      return jsonRes({ flag: true, code: 0, data: {} })
    }
    if (url.includes("tenant-app/v2/init-app")) {
      if (onInitApp) onInitApp()
      return jsonRes({ flag: true, code: 0, data: {} })
    }
    if (url.includes("membership/me") || url.includes("points/summary")) {
      return jsonRes({ flag: true, code: 0, data: {} })
    }
    throw new Error(`unexpected ${url}`)
  }
}

const dailyGrantRow = (createTime = "2026-11-06T00:00:30", amount = 100) => ({
  assetCode: "GENERAL_POINTS", deductions: [], direction: "CREDIT", operation: "GRANT",
  amount, balanceAfter: 8000, sourceType: "ACTIVITY", reason: "每日登录赠送", createTime,
  expireTime: "2026-12-07T00:00:30",
})

const sparkGrantRow = (amount, expireTime) => ({
  assetCode: "SPARK_POINTS", deductions: [], direction: "CREDIT", operation: "GRANT",
  amount, balanceAfter: 35000, sourceType: "ACTIVITY", reason: "1024讯飞开发者节狂欢", createTime: "2026-10-22T21:34:30",
  expireTime,
})

const dailyRewardPopup = [{
  popupId: 1, popupCode: "DAILY_LOGIN", popupType: "BANNER", componentType: "DAILY_REWARD_DIALOG",
  priority: 100, instanceKey: "2026-11-04", payload: { points: "100" },
}]

const checkinAuth = { type: "api", key: "k", metadata: { session: { token: "T", ssoSessionId: "S", accountId: "A" } } }

test("check-in observes the balance delta around the session touch", async () => {
  // 流水通畅但还没入账、余额涨了：发放已到账，记 claimed（不谎称 inactive）。
  const claimed = createPlugin({ fetchImpl: checkinFetch([7900, 8000], { ledger: [] }), sleepImpl: async () => {} })
  const out = await claimed.auth.checkin(async () => checkinAuth)
  assert.equal(out.outcome, "claimed")
  assert.equal(out.credit, 100)
  assert.match(out.message, /余额上涨，流水尚未入账/)

  const unobserved = createPlugin({ fetchImpl: checkinFetch([7900, 7900], { ledger: [] }), sleepImpl: async () => {} })
  const out2 = await unobserved.auth.checkin(async () => checkinAuth)
  // 流水通畅但无当日 GRANT 行：没发放就是没发放，不谎称 done。
  assert.equal(out2.outcome, "inactive")
  assert.match(out2.message, /未观测到新发放/)
})

test("check-in trusts the daily grant ledger as the authoritative signal", async () => {
  // 11-06 实测：服务端午夜批量先于签到发放，纯余额差会误报 inactive；
  // 流水里有当日 GRANT 行就是发了，谁触发的不影响结论。
  const plugin = createPlugin({ fetchImpl: checkinFetch([8000, 8000], { ledger: [dailyGrantRow()] }), sleepImpl: async () => {} })
  const out = await plugin.auth.checkin(async () => checkinAuth)
  assert.equal(out.outcome, "done")
  assert.equal(out.credit, 100)
  assert.match(out.message, /流水实证，先于签到发生/)
})

test("check-in claims when the grant lands after the check-in started", async () => {
  // 签到前读流水为空（还没发），init-app 之后才有 GRANT 行 ⇒ 本次触发。
  const plugin = createPlugin({
    fetchImpl: checkinFetch([7900, 8000], { ledgerSequence: [[], [dailyGrantRow()]] }),
    sleepImpl: async () => {},
  })
  const out = await plugin.auth.checkin(async () => checkinAuth)
  assert.equal(out.outcome, "claimed")
  assert.equal(out.credit, 100)
  assert.match(out.message, /本次签到触发/)
})

test("check-in skips init-app when today's grant is already on the ledger", async () => {
  // 流水已有当日 GRANT 行 ⇒ 只读，不再发 init-app（不给账号制造无谓写入）。
  let initCalls = 0
  let popupReads = 0
  const plugin = createPlugin({
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url.includes("client-popups")) popupReads += 1
      if (url.includes("points/details")) {
        return jsonRes({ flag: true, code: 0, data: { items: [dailyGrantRow()] } })
      }
      return checkinFetch([8000], { onInitApp: () => { initCalls += 1 } })(input, init)
    },
    sleepImpl: async () => {},
  })
  const out = await plugin.auth.checkin(async () => checkinAuth)
  assert.equal(out.outcome, "done")
  assert.equal(initCalls, 0)
  assert.equal(popupReads, 0)
})

test("check-in message warns about spark points expiring within 7 days", async () => {
  // 星火大额批次 5 天后到期：签到消息要带上提醒。
  const soon = new Date(Date.now() + 5 * 86400000)
  const p2 = (n) => String(n).padStart(2, "0")
  const stamp = `${soon.getFullYear()}-${p2(soon.getMonth() + 1)}-${p2(soon.getDate())}T21:34:30`
  const plugin = createPlugin({
    fetchImpl: checkinFetch([8000, 8000], {
      ledger: [dailyGrantRow()],
      sparkLedger: [sparkGrantRow(35000, stamp)],
    }),
    sleepImpl: async () => {},
  })
  const out = await plugin.auth.checkin(async () => checkinAuth)
  assert.equal(out.outcome, "done")
  assert.match(out.message, /35000 星火积分 \d 天内到期|35000 星火积分 今天到期/)
})

test("check-in message stays quiet when spark expiry is far away", async () => {
  const far = new Date(Date.now() + 40 * 86400000)
  const p2 = (n) => String(n).padStart(2, "0")
  const stamp = `${far.getFullYear()}-${p2(far.getMonth() + 1)}-${p2(far.getDate())}T21:34:30`
  const plugin = createPlugin({
    fetchImpl: checkinFetch([8000, 8000], {
      ledger: [dailyGrantRow()],
      sparkLedger: [sparkGrantRow(35000, stamp)],
    }),
    sleepImpl: async () => {},
  })
  const out = await plugin.auth.checkin(async () => checkinAuth)
  assert.doesNotMatch(out.message, /到期/)
})

test("check-in falls back to balance and popups when the ledger query fails", async () => {
  // 流水读失败退回旧判据：余额差为正仍能 claimed。
  const plugin = createPlugin({ fetchImpl: checkinFetch([7900, 8000], { ledgerFails: true }), sleepImpl: async () => {} })
  const out = await plugin.auth.checkin(async () => checkinAuth)
  assert.deepEqual(out, { outcome: "claimed", credit: 100, message: "每日登录积分 +100" })
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
      identityAssert: (headers, init) => seen.push({ headers, method: init.method ?? "GET" }),
    }),
    sleepImpl: async () => {},
  })
  await plugin.auth.checkin(async () => checkinAuth)
  // 只数账号面 GET：POST（init-app）不参与这条断言。签到主路径（inactive 场景）=
  // plan-config、签到前流水、签到前余额、touch（me+summary）、签到后余额、签到后流水。
  const gets = seen.filter((item) => item.method !== "POST")
  assert.equal(gets.length, 7)
  for (const { headers } of seen) {
    assert.equal(headers.clientType, process.platform === "darwin" ? "22" : "21")
    assert.equal(headers.studioVersion, STUDIO_VERSION)
  }
})

test("check-in reports done from popups when the ledger query fails", async () => {
  // 弹窗 done 路径只属于退路：流水读失败 + 余额无变化 + 签到前无旧弹窗 +
  // 签到后出现 DAILY_REWARD_DIALOG ⇒ 服务端发了但流水接口没读到。
  const plugin = createPlugin({
    fetchImpl: checkinFetch([7900, 7900], { popupsSequence: [[], dailyRewardPopup], ledgerFails: true }),
    sleepImpl: async () => {},
  })
  const out = await plugin.auth.checkin(async () => checkinAuth)
  assert.deepEqual(out, { outcome: "done", credit: 100, message: "每日登录积分已发放（服务端待通知弹窗）" })
})

test("check-in omits credit when the daily reward popup has no usable points", async () => {
  for (const payload of [{}, { points: "0" }, { points: "n/a" }]) {
    const plugin = createPlugin({
      fetchImpl: checkinFetch([7900, 7900], { popupsSequence: [[], [{ ...dailyRewardPopup[0], payload }]], ledgerFails: true }),
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
      ledger: [],
    }),
    sleepImpl: async () => {},
  })
  const out = await plugin.auth.checkin(async () => checkinAuth)
  assert.equal(out.outcome, "inactive")
})

test("check-in still falls back to popups when both ledger and popup query fail", async () => {
  // 流水+弹窗都挂：退路里的退路，基线（第一次弹窗读）失败 ⇒ failed 不硬判。
  const plugin = createPlugin({ fetchImpl: checkinFetch([7900, 7900], { popupFails: true, ledgerFails: true }), sleepImpl: async () => {} })
  const out = await plugin.auth.checkin(async () => checkinAuth)
  assert.equal(out.outcome, "failed")
  assert.match(out.message, /11001001|平台|版本/)
})

test("check-in never claims done when the baseline popup read fails", async () => {
  // 退路里的场景：流水读失败 + 基线读失败 = 不知道签到前有没有旧弹窗，
  // 签到后读到弹窗也不能判 done，更不能替用户把弹窗 complete 掉。
  let popupCalls = 0
  const completed = []
  const plugin = createPlugin({
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url.includes("membership/plan-config")) {
        return jsonRes({ flag: true, code: 0, data: { dailyLoginEnabled: true } })
      }
      if (url.includes("points/balance")) {
        return jsonRes({ flag: true, code: 0, data: { totalBalance: 7900, activityBalance: 7900 } })
      }
      if (url.includes("points/details")) {
        return jsonRes({ flag: false, code: 11001001, desc: "参数无效" })
      }
      if (url.includes("client-popups/pending")) {
        popupCalls += 1
        if (popupCalls === 1) return jsonRes({ flag: false, code: 500, desc: "基线读失败" })
        return jsonRes({ flag: true, code: 0, data: dailyRewardPopup })
      }
      if (url.includes("client-popups/complete")) {
        completed.push(JSON.parse(init.body))
        return jsonRes({ flag: true, code: 0, data: {} })
      }
      return jsonRes({ flag: true, code: 0, data: {} })
    },
    sleepImpl: async () => {},
  })
  const out = await plugin.auth.checkin(async () => checkinAuth)
  assert.equal(out.outcome, "failed")
  assert.match(out.message, /基线读失败/)
  assert.equal(completed.length, 0)
})

test("check-in leaves the daily popup alone on the ledger path", async () => {
  // 流水能判定时不再碰弹窗：不读、更不替用户点「知道了」（那是桌面端的交互）。
  let popupReads = 0
  const completed = []
  const mock = checkinFetch([7900, 8000], { ledgerSequence: [[], [dailyGrantRow()]] })
  const plugin = createPlugin({
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url.includes("client-popups/pending")) popupReads += 1
      if (url.includes("client-popups/complete")) completed.push(JSON.parse(init.body))
      return mock(input, init)
    },
    sleepImpl: async () => {},
  })
  const out = await plugin.auth.checkin(async () => checkinAuth)
  assert.match(out.message, /本次签到触发/)
  assert.equal(popupReads, 0)
  assert.equal(completed.length, 0)
})

test("check-in treats a pre-existing daily popup as unprovable on the fallback path", async () => {
  const completed = []
  const plugin = createPlugin({
    fetchImpl: checkinFetch([7900, 7900], {
      popupsSequence: [dailyRewardPopup, dailyRewardPopup],
      ledgerFails: true,
      onComplete: (body) => completed.push(body),
    }),
    sleepImpl: async () => {},
  })
  const out = await plugin.auth.checkin(async () => checkinAuth)
  assert.equal(out.outcome, "inactive")
  assert.match(out.message, /签到前已有/)
  // 旧弹窗不属于今天，但也不替用户点掉：签到不再发 client-popups/complete。
  assert.equal(completed.length, 0)
})

test("check-in surfaces init-app failures instead of hiding them", async () => {
  const plugin = createPlugin({
    fetchImpl: async (input) => {
      const url = String(input)
      if (url.includes("tenant-app/v2/init-app")) {
        return jsonRes({ flag: false, code: 400, desc: "bad request" }, 400)
      }
      if (url.includes("membership/plan-config")) {
        return jsonRes({ flag: true, code: 0, data: { dailyLoginEnabled: true } })
      }
      if (url.includes("points/balance")) {
        return jsonRes({ flag: true, code: 0, data: { totalBalance: 7900, activityBalance: 7900 } })
      }
      if (url.includes("client-popups/pending")) return jsonRes({ flag: true, code: 0, data: [] })
      if (url.includes("points/details")) return jsonRes({ flag: true, code: 0, data: { total: 0, items: [] } })
      return jsonRes({ flag: true, code: 0, data: {} })
    },
    sleepImpl: async () => {},
  })
  const out = await plugin.auth.checkin(async () => checkinAuth)
  assert.equal(out.outcome, "inactive")
  assert.match(out.message, /init-app/)
  assert.match(out.message, /400/)
})

test("check-in never calls auth/bearer-token", async () => {
  const paths = []
  const plugin = createPlugin({
    fetchImpl: async (input) => {
      const url = String(input)
      paths.push(url)
      if (url.includes("membership/plan-config")) {
        return jsonRes({ flag: true, code: 0, data: { dailyLoginEnabled: true } })
      }
      if (url.includes("points/balance")) {
        return jsonRes({ flag: true, code: 0, data: { totalBalance: 7900, activityBalance: 7900 } })
      }
      if (url.includes("client-popups/pending")) return jsonRes({ flag: true, code: 0, data: [] })
      if (url.includes("points/details")) return jsonRes({ flag: true, code: 0, data: { total: 0, items: [] } })
      return jsonRes({ flag: true, code: 0, data: {} })
    },
    sleepImpl: async () => {},
  })
  await plugin.auth.checkin(async () => checkinAuth)
  assert.ok(paths.some((p) => p.includes("tenant-app/v2/init-app")))
  assert.ok(!paths.some((p) => p.includes("auth/bearer-token")))
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
  const method = pasteMethod(plugin)
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
  assert.equal(plugin.auth.methods.length, 3)
})

// ---------------------------------------------------------------- 网页登录（多账号）

// 假浏览器模块：startBrowserHarvest 立刻给出一个收割结果，removeProfile 记账。
function fakeBrowser({ session = { token: "tok-web", accountId: "A-web", ssoSessionId: "sso-web" }, profilePath = "C:/tmp/astudio-profile" } = {}) {
  const calls = { started: 0, closed: 0, released: 0, removed: [] }
  return {
    calls,
    startBrowserHarvest() {
      calls.started++
      return {
        promise: Promise.resolve({
          session,
          profilePath,
          release: async () => { calls.released++ },
          close: async () => { calls.closed++ },
        }),
        abort: async () => {},
      }
    },
    async removeProfile(path) { calls.removed.push(path) },
  }
}

const webFetch = ({ uid = "u-web", token = "tok-model-web", exchangeStatus = 200 } = {}) => async (input) => {
  const url = String(input)
  if (url.includes("membership/me")) return jsonRes({ flag: true, code: 0, data: uid ? { uid } : {} })
  if (url.includes("auth/bearer-token")) {
    if (exchangeStatus !== 200) return jsonRes({}, exchangeStatus)
    return jsonRes({ flag: true, code: 0, data: { modelBearerToken: token } })
  }
  throw new Error(`unexpected ${url}`)
}

test("web login is the recommended oauth method, listed first", () => {
  const plugin = createPlugin()
  const method = webMethod(plugin)
  assert.equal(method.type, "oauth")
  assert.match(method.label, /推荐/)
  assert.match(method.label, /多账号/)
  assert.equal(method.prompts, undefined)
  assert.equal(plugin.auth.methods[0], method)
})

test("web login harvests cookies, exchanges the model token, and drops the browser profile", async () => {
  const browser = fakeBrowser()
  const plugin = createPlugin({ fetchImpl: webFetch(), browserModule: browser })
  const out = await webMethod(plugin).authorize({}, {})
  // 浏览器由插件自己弹出，宿主不要再开 url（mclaw 同款 opened:true）。
  assert.equal(out.url, "")
  assert.equal(out.opened, true)
  assert.match(out.instructions, /登录/)
  assert.equal(out.method, "auto")
  const result = await out.callback()
  assert.deepEqual(result, {
    type: "success",
    key: "tok-model-web",
    accountId: "u-web",
    metadata: {
      uid: "u-web",
      method: "web",
      source: STUDIO_WEB_URL,
      session: { token: "tok-web", accountId: "A-web", ssoSessionId: "sso-web" },
    },
  })
  assert.equal(browser.calls.started, 1)
  assert.equal(browser.calls.closed, 1)
  assert.equal(browser.calls.released, 1)
  // 会话已进 metadata.session，浏览器目录不留第二份凭据。
  assert.deepEqual(browser.calls.removed, ["C:/tmp/astudio-profile"])
})

test("web login retries a transient membership read before failing", async () => {
  let reads = 0
  const sleeps = []
  const flaky = async (input) => {
    if (String(input).includes("membership/me") && reads++ === 0) throw new Error("network down")
    return webFetch()(input)
  }
  const plugin = createPlugin({ fetchImpl: flaky, sleepImpl: async (ms) => { sleeps.push(ms) }, browserModule: fakeBrowser() })
  const out = await webMethod(plugin).authorize({}, {})
  const result = await out.callback()
  assert.equal(result.type, "success")
  assert.equal(result.accountId, "u-web")
  assert.equal(reads, 2)
  // 真实等 2s 会让这条测试变成最慢的一条；注入 sleep 只验「等过」。
  assert.deepEqual(sleeps, [2000])
})

test("web login retries a membership read that answered 5xx", async () => {
  let reads = 0
  const flaky = async (input) => {
    if (String(input).includes("membership/me") && reads++ === 0) return jsonRes({}, 502)
    return webFetch()(input)
  }
  const plugin = createPlugin({ fetchImpl: flaky, sleepImpl: async () => {}, browserModule: fakeBrowser() })
  const result = await (await webMethod(plugin).authorize({}, {})).callback()
  assert.equal(result.type, "success")
  assert.equal(reads, 2)
})

test("web login refuses to promise a window when no browser is installed", async () => {
  const browser = {
    ...fakeBrowser(),
    browserExecutable: async () => { throw new Error("找不到 Chrome/Edge；请安装其中一个") },
  }
  const plugin = createPlugin({ fetchImpl: webFetch(), browserModule: browser })
  await assert.rejects(() => webMethod(plugin).authorize({}, {}), /找不到 Chrome/)
  assert.equal(browser.calls.started, 0)
})

test("check-in reads the ledger for a web session without a token cookie", async () => {
  const urls = []
  const plugin = createPlugin({
    nowMsImpl: () => Date.parse("2026-11-06T02:00:00Z"),
    fetchImpl: async (input) => {
      const url = String(input)
      urls.push(url)
      if (url.includes("membership/plan-config")) {
        return jsonRes({ flag: true, code: 0, data: { dailyLoginEnabled: true } })
      }
      if (url.includes("points/details")) {
        return jsonRes({
          flag: true,
          code: 0,
          data: { items: [{ direction: "CREDIT", operation: "GRANT", reason: "每日登录赠送", amount: 100, createTime: "2026-11-06 00:00:30" }] },
        })
      }
      throw new Error(`unexpected ${url}`)
    },
  })
  // 网页登录收割的会话可以没有 token Cookie（只需 ssoSessionId + account_id）。
  const out = await plugin.auth.checkin(async () => ({
    type: "api",
    key: "k",
    metadata: { session: { accountId: "A-web", ssoSessionId: "S-web" } },
  }))
  assert.equal(out.outcome, "done")
  assert.ok(urls.some((url) => url.includes("points/details")))
})

test("web login drops the profile when the session cannot become an account", async () => {
  const browser = fakeBrowser()
  const plugin = createPlugin({ fetchImpl: webFetch({ uid: "" }), browserModule: browser })
  const out = await webMethod(plugin).authorize({}, {})
  const result = await out.callback()
  assert.equal(result.type, "failed")
  assert.match(result.error, /没有 uid/)
  assert.deepEqual(browser.calls.removed, ["C:/tmp/astudio-profile"])
  assert.equal(browser.calls.closed, 1)
})

test("web login drops the profile when the exchange is refused", async () => {
  const browser = fakeBrowser()
  const plugin = createPlugin({ fetchImpl: webFetch({ exchangeStatus: 401 }), browserModule: browser })
  const out = await webMethod(plugin).authorize({}, {})
  const result = await out.callback()
  assert.equal(result.type, "failed")
  assert.match(result.error, /会话已失效/)
  assert.deepEqual(browser.calls.removed, ["C:/tmp/astudio-profile"])
})

test("two web logins with different accounts return different accountIds", async () => {
  const signIn = async (uid) => {
    const plugin = createPlugin({ fetchImpl: webFetch({ uid }), browserModule: fakeBrowser() })
    const out = await webMethod(plugin).authorize({}, {})
    return (await out.callback()).accountId
  }
  // 宿主按 accountId 给账号池分格：uid 不同 = 两个账号，uid 相同 = 同一账号。
  assert.equal(await signIn("u-a"), "u-a")
  assert.equal(await signIn("u-b"), "u-b")
})

test("exchangeModelToken reads modelBearerToken and reports the envelope error", async () => {
  const session = { token: "T", accountId: "A" }
  assert.equal(await exchangeModelToken(session, webFetch({ token: "tok-x" })), "tok-x")
  await assert.rejects(() => exchangeModelToken(session, async () => jsonRes({ flag: false, code: 7, desc: "拒绝" })), /拒绝/)
  await assert.rejects(() => exchangeModelToken(session, async () => ({ ok: true, status: 200, json: async () => { throw new Error("x") } })), /不是 JSON/)
})

test("desktop sign-in falls back to account_id when the session has no uid", async () => {
  const plugin = createPlugin({
    env: { ASTUDIO_HOME: "D:\astudio" },
    readFileImpl: fakeFs({
      "D:\astudio/userdata/astron-session.json": JSON.stringify({
        accountId: "A-only", token: "tok-36", ssoSessionId: "sso-36", modelBearerToken: "tok-65",
      }),
    }),
  })
  const out = await desktopMethod(plugin).authorize({}, {})
  const result = await out.callback()
  assert.equal(result.accountId, "A-only")
})

test("the same account signed in both ways lands on one accountId", async () => {
  const plugin = createPlugin({
    env: { ASTUDIO_HOME: "D:\astudio" },
    readFileImpl: fakeFs({
      "D:\astudio/userdata/astron-session.json": JSON.stringify({
        uid: "u-same", accountId: "u-same", token: "tok-36", ssoSessionId: "sso-36", modelBearerToken: "tok-65",
      }),
    }),
    fetchImpl: webFetch({ uid: "u-same" }),
    browserModule: fakeBrowser(),
  })
  const desktop = await (await desktopMethod(plugin).authorize({}, {})).callback()
  const web = await (await webMethod(plugin).authorize({}, {})).callback()
  assert.equal(desktop.accountId, "u-same")
  assert.equal(web.accountId, desktop.accountId)
})

// ---------------------------------------------------------------- browser.mjs

const fakeChrome = (cookies = []) => ({
  connection: { send: async () => ({ cookies }), closed: false },
  close: async () => {},
})

test("harvestAstronSession prefers the most specific domain and needs ssoSessionId plus account_id", async () => {
  const cookies = [
    { name: "token", value: "t-other", domain: ".example.com" },
    { name: "token", value: "t-generic", domain: ".xfyun.cn" },
    { name: "token", value: "t-passport", domain: "passport.xfyun.cn" },
    { name: "token", value: "t-host", domain: "agent.xfyun.cn" },
    { name: "account_id", value: "A1", domain: ".xfyun.cn" },
    { name: "ssoSessionId", value: "S1", domain: ".xfyun.cn" },
  ]
  assert.deepEqual((await astroBrowser.harvestAstronSession(fakeChrome(cookies))).session, {
    token: "t-host", accountId: "A1", ssoSessionId: "S1",
  })
  // 网页登录可能没有 token Cookie：账号面与换发只需 ssoSessionId + account_id。
  const noToken = cookies.filter((c) => c.name !== "token")
  assert.deepEqual((await astroBrowser.harvestAstronSession(fakeChrome(noToken))).session, {
    accountId: "A1", ssoSessionId: "S1",
  })
  assert.equal(await astroBrowser.harvestAstronSession(fakeChrome([{ name: "token", value: "t", domain: ".xfyun.cn" }])), undefined)
  assert.equal(await astroBrowser.harvestAstronSession(fakeChrome([
    { name: "account_id", value: "A1", domain: ".xfyun.cn" },
  ])), undefined)
})

test("startBrowserHarvest rejects, closes the window, and removes the profile on abort", async () => {
  let closed = 0
  const removed = []
  const open = async ({ profilePath }) => ({
    browser: { ...fakeChrome(), close: async () => { closed++ } },
    profilePath,
    release: async () => {},
  })
  const harvest = astroBrowser.startBrowserHarvest({
    startUrl: "https://example.com",
    profilePath: "C:/tmp/astudio-abort-profile",
    open,
    removeProfileImpl: async (path) => { removed.push(path) },
  })
  // 先挂 rejection 断言再 abort：abort 会立刻让 promise 拒绝。
  const rejected = assert.rejects(() => harvest.promise, /登录已取消/)
  await harvest.abort()
  await rejected
  assert.equal(closed, 1)
  // 宿主取消后 callback 不会再被调，profile 没人认领，必须删掉（abort 与 catch
  // 都会删，rm 幂等，所以只断言「删过这个路径」）。
  assert.ok(removed.includes("C:/tmp/astudio-abort-profile"))
})

test("startBrowserHarvest times out when no sign-in appears", async () => {
  const removed = []
  const open = async ({ profilePath }) => ({ browser: fakeChrome(), profilePath, release: async () => {} })
  const harvest = astroBrowser.startBrowserHarvest({
    startUrl: "https://example.com",
    deadlineMs: 0,
    open,
    removeProfileImpl: async (path) => { removed.push(path) },
  })
  await assert.rejects(() => harvest.promise, (error) => {
    assert.match(error.message, /登录超时/)
    // 不足 1 分钟要说秒，不能渲染成「0 分钟」。
    assert.doesNotMatch(error.message, /0 分钟/)
    return true
  })
  assert.equal(removed.length, 1)
})

test("startBrowserHarvest removes the profile when the browser cannot start", async () => {
  const removed = []
  const harvest = astroBrowser.startBrowserHarvest({
    startUrl: "https://example.com",
    profilePath: "C:/tmp/never-opened",
    open: async () => { throw new Error("找不到浏览器") },
    removeProfileImpl: async (path) => { removed.push(path) },
  })
  await assert.rejects(() => harvest.promise, /找不到浏览器/)
  assert.deepEqual(removed, ["C:/tmp/never-opened"])
})

test("web login does not retry a deterministic 4xx", async () => {
  let calls = 0
  const plugin = createPlugin({
    fetchImpl: async (input) => {
      if (String(input).includes("membership/me")) {
        calls++
        return jsonRes({ flag: false, code: 7, desc: "参数无效" }, 400)
      }
      return webFetch()(input)
    },
    browserModule: fakeBrowser(),
  })
  const out = await webMethod(plugin).authorize({}, {})
  const result = await out.callback()
  assert.equal(result.type, "failed")
  assert.match(result.error, /参数无效/)
  assert.equal(calls, 1)
})

test("usage reads the account API from a token-less web session", async () => {
  const seen = []
  const plugin = createPlugin({
    fetchImpl: async (input) => {
      seen.push(String(input))
      if (String(input).includes("points/balance")) {
        return jsonRes({ flag: true, code: 0, data: { totalBalance: 42 } })
      }
      if (String(input).includes("membership/me")) return jsonRes({ flag: true, code: 0, data: { uid: "u" } })
      return jsonRes({ flag: true, code: 0, data: {} })
    },
  })
  const out = await plugin.auth.usage(async () => ({
    type: "api",
    key: "k",
    metadata: { session: { accountId: "A", ssoSessionId: "S" } },
  }))
  assert.ok(seen.some((u) => u.includes("points/balance")))
  assert.equal(out.windows[0].balance, 42)
})

// ---------------------------------------------------------------- 北京时间窗口

test("check-in builds the daily ledger window in Beijing time", async () => {
  // 北京 2026-11-06 00:00:30（UTC 还是 11-05）：窗口必须是北京的当日，
  // 否则午夜批量发放会被算到窗口外，签到误报 inactive。
  const seen = []
  const plugin = createPlugin({
    nowMsImpl: () => Date.parse("2026-11-05T16:00:30Z"),
    fetchImpl: async (input) => {
      const url = String(input)
      seen.push(url)
      if (url.includes("points/details")) return jsonRes({ flag: true, code: 0, data: { items: [] } })
      if (url.includes("membership/plan-config")) return jsonRes({ flag: true, code: 0, data: { dailyLoginEnabled: true } })
      if (url.includes("points/balance")) return jsonRes({ flag: true, code: 0, data: { totalBalance: 8000, activityBalance: 8000 } })
      return jsonRes({ flag: true, code: 0, data: {} })
    },
    sleepImpl: async () => {},
  })
  await plugin.auth.checkin(async () => checkinAuth)
  const daily = seen.find((url) => url.includes("points/details"))
  const params = new URL(daily).searchParams
  assert.equal(params.get("startTime"), "2026-11-06 00:00:00")
  assert.equal(params.get("endTime"), "2026-11-06 00:00:30")
})

test("spark expiry window also uses Beijing bounds", async () => {
  const seen = []
  const plugin = createPlugin({
    nowMsImpl: () => Date.parse("2026-11-06T00:00:00+08:00"),
    fetchImpl: async (input) => {
      const url = String(input)
      seen.push(url)
      if (url.includes("points/balance")) {
        return jsonRes({ flag: true, code: 0, data: { totalBalance: 0, activityBalance: 0, sparkTotalBalance: 35000 } })
      }
      if (url.includes("membership/me")) return jsonRes({ flag: true, code: 0, data: {} })
      if (url.includes("points/details")) return jsonRes({ flag: true, code: 0, data: { items: [] } })
      throw new Error(`unexpected ${url}`)
    },
  })
  await plugin.auth.usage(async () => ({ type: "api", key: "k", metadata: { session: { token: "T", accountId: "A" } } }))
  const spark = seen.find((url) => url.includes("points/details"))
  const params = new URL(spark).searchParams
  assert.equal(params.get("startTime"), "2026-09-07 00:00:00")
  assert.equal(params.get("endTime"), "2026-11-06 00:00:00")
})

test("check-in ignores a GRANT row that is not the daily login grant", async () => {
  // reason 过滤：别的活动赠送不能冒充每日登录积分。
  const plugin = createPlugin({
    fetchImpl: checkinFetch([8000, 8000], { ledger: [{ ...dailyGrantRow(), reason: "活动奖励" }] }),
    sleepImpl: async () => {},
  })
  const out = await plugin.auth.checkin(async () => checkinAuth)
  assert.equal(out.outcome, "inactive")
})

test("spark expiry sums one batch, skips expired rows, and caps at the balance", async () => {
  const plugin = createPlugin({
    nowMsImpl: () => Date.parse("2026-11-06T00:00:00+08:00"),
    fetchImpl: async (input) => {
      const url = String(input)
      if (url.includes("points/balance")) {
        return jsonRes({ flag: true, code: 0, data: { totalBalance: 0, activityBalance: 0, sparkTotalBalance: 20000 } })
      }
      if (url.includes("membership/me")) return jsonRes({ flag: true, code: 0, data: {} })
      if (url.includes("points/details")) {
        return jsonRes({ flag: true, code: 0, data: { items: [
          sparkGrantRow(10000, "2026-11-22T21:34:30"),
          sparkGrantRow(25000, "2026-11-22T21:34:30"),
          sparkGrantRow(9999, "2026-10-01T00:00:00"), // 已过期，跳过
        ] } })
      }
      throw new Error(`unexpected ${url}`)
    },
  })
  const out = await plugin.auth.usage(async () => ({ type: "api", key: "k", metadata: { session: { token: "T", accountId: "A" } } }))
  // 同批 10000+25000=35000，但余额只剩 20000 ⇒ 提示按余额封顶。
  const spark = out.windows.find((w) => w.name === "星火积分")
  assert.equal(spark.runsOut, 20000)
  assert.equal(spark.runsOutAt, "2026-11-22T13:34:30.000Z")
})

test("spark expiry reads past the first page of ledger rows", async () => {
  const filler = Array.from({ length: 50 }, (_, i) => ({ ...dailyGrantRow(), createTime: `2026-10-${String((i % 28) + 1).padStart(2, "0")}T00:00:00` }))
  const plugin = createPlugin({
    nowMsImpl: () => Date.parse("2026-11-06T00:00:00+08:00"),
    fetchImpl: async (input) => {
      const url = String(input)
      if (url.includes("points/balance")) {
        return jsonRes({ flag: true, code: 0, data: { totalBalance: 0, activityBalance: 0, sparkTotalBalance: 35000 } })
      }
      if (url.includes("membership/me")) return jsonRes({ flag: true, code: 0, data: {} })
      if (url.includes("points/details")) {
        const page = Number(new URL(url).searchParams.get("pageNum") ?? 1)
        const items = page === 1 ? filler : [sparkGrantRow(35000, "2026-11-22T21:34:30")]
        return jsonRes({ flag: true, code: 0, data: { items } })
      }
      throw new Error(`unexpected ${url}`)
    },
  })
  const out = await plugin.auth.usage(async () => ({
    type: "api",
    key: "k",
    metadata: { session: { token: "T", accountId: "A" } },
  }))
  const spark = out.windows.find((w) => w.name === "星火积分")
  assert.equal(spark.runsOut, 35000)
  assert.equal(spark.runsOutAt, "2026-11-22T13:34:30.000Z")
})

test("check-in counts days to expiry by Beijing calendar days", async () => {
  // 北京 11-06 23:00，到期 11-07 00:30：不到 24 小时，但日历上是「1 天内」。
  const plugin = createPlugin({
    nowMsImpl: () => Date.parse("2026-11-06T23:00:00+08:00"),
    fetchImpl: checkinFetch([8000, 8000], {
      ledger: [dailyGrantRow()],
      sparkLedger: [sparkGrantRow(35000, "2026-11-07T00:30:00")],
    }),
    sleepImpl: async () => {},
  })
  const out = await plugin.auth.checkin(async () => checkinAuth)
  assert.match(out.message, /35000 星火积分 1 天内到期/)
})

test("web login does not retry a session the server turns away", async () => {
  // code 80000 = 登录异常：studioJson 映射成 signIn expired，retryTransient 不重试。
  let calls = 0
  const plugin = createPlugin({
    fetchImpl: async (input) => {
      if (String(input).includes("membership/me")) {
        calls++
        return jsonRes({ flag: false, code: 80000, desc: "登录异常，请重新登录" })
      }
      return webFetch()(input)
    },
    browserModule: fakeBrowser(),
  })
  const out = await webMethod(plugin).authorize({}, {})
  const result = await out.callback()
  assert.equal(result.type, "failed")
  assert.match(result.error, /会话已失效/)
  assert.equal(calls, 1)
})

test("web login's account requests refuse redirects and carry a timeout", async () => {
  let exchangeInit
  const plugin = createPlugin({
    fetchImpl: async (input, init) => {
      if (String(input).includes("auth/bearer-token")) {
        exchangeInit = init
        return jsonRes({ flag: true, code: 0, data: { modelBearerToken: "tok" } })
      }
      return webFetch()(input)
    },
    browserModule: fakeBrowser(),
  })
  const out = await webMethod(plugin).authorize({}, {})
  const result = await out.callback()
  assert.equal(result.type, "success")
  assert.equal(exchangeInit.redirect, "error")
  assert.ok(exchangeInit.signal, "请求要带超时 signal")
})

test("web login maps a code 80000 from the exchange to sign-in expired", async () => {
  let exchangeCalls = 0
  const plugin = createPlugin({
    fetchImpl: async (input) => {
      if (String(input).includes("auth/bearer-token")) {
        exchangeCalls++
        return jsonRes({ flag: false, code: 80000, desc: "登录异常，请重新登录" })
      }
      return webFetch()(input)
    },
    browserModule: fakeBrowser(),
  })
  const out = await webMethod(plugin).authorize({}, {})
  const result = await out.callback()
  assert.equal(result.type, "failed")
  assert.match(result.error, /会话已失效/)
  assert.equal(exchangeCalls, 1)
})
