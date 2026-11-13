// 集成测试：起一个本地假站点，模拟麦块云的真实响应形状，
// 然后通过插件导出的 hooks 走完整链路（config → authorize → models → usage）。
//
// 这样测的是插件自己的代码，不是站点现状；响应体是从 2026-11-13 的真实
// 抓包里复制出来的，只把密钥值换成了固定的假值。
//
// 跑法：node --test

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"

import { MinekuaiPlugin } from "./index.mjs"

const GOOD_KEY = "sk-fake-test-0001"
const GOOD_TOKEN = "fake-token-0001"
const RENEWED_TOKEN = "fake-token-0002"
const CLIENT_ID = "428a8310cd442757ae699df5d894f051"

const PHONE = "fake-phone-0001"
const PASSWORD = "fake-pass-0001"

// 真实响应的形状：注意 HTTP 一律 200，错误靠 body 的 code 表达
const TOKEN_BODY = {
  code: 200,
  msg: "操作成功",
  data: {
    enabled: true,
    eligible: true,
    day: "2026-11-13",
    today: { exchanged: 0, bonus: 0, used: 0, remaining: 0 },
    permanent: { balance: 10_000_000, totalIn: 10_000_000, totalUsed: 0 },
    remaining: 10_000_000,
    paid: {
      group: "paygo",
      groupName: "按量付费",
      balance: 999_999_865,
      totalIn: 1_000_000_000,
      totalUsed: 135,
    },
    keys: [{ keyId: "2121068580813709313", name: "1", keyPrefix: "sk-qTCn4", mode: null }],
  },
}

// GET /app/checkin 的真实形状（2026-11-13 抓包）
const CHECKIN_STATUS = {
  awardable: "0.0000",
  awardedToday: "10.0000",
  balance: "40.0000",
  balanceCap: "10000.0000",
  basePoints: "10.0000",
  bonusPct: 0,
  capReached: false,
  checkedIn: true,
  date: "2026-11-13",
  enabled: true,
  ipLimitReached: false,
  memberPoints: "10.0000",
  nextBonusInDays: 6,
  streakBonus: "20.0000",
  streakDays: 1,
  streakEvery: 7,
  todayBonus: "0.0000",
}

// GET /app/llm/requests/daily 的真实形状（2026-11-13 抓包，截取今天一行）
// 口径：站点「Token」= inputTokens + cacheReadTokens + outputTokens
const DAILY_BODY = {
  code: 200,
  msg: "操作成功",
  data: {
    beginTime: "2026-11-13 00:00:00",
    endTime: "2026-11-13 23:59:59",
    days: 1,
    daily: [
      {
        date: "2026-11-13",
        inputTokens: 1156619,
        cacheReadTokens: 4533632,
        cacheWriteTokens: 0,
        outputTokens: 9462,
        requests: 17,
        success: 17,
        failed: 0,
        blocked: 0,
        pending: 0,
        points: "0.0000",
      },
    ],
    models: [{ model: "deepseek-v4.1-flash-1017", points: "0.0000", requests: 17 }],
    todayRequests: 17,
    yesterdaySameTimeRequests: 0,
  },
}

let server
let base

/** 记录收到的请求，断言请求头与调用顺序用。 */
const seen = []

/**
 * 每个用例可调的站点行为。默认值与真实站点一致：
 *   - 有效令牌是 GOOD_TOKEN；
 *   - 签到接口回 409（今天已签）。
 */
const state = {
  validTokens: null, // null = 只认 GOOD_TOKEN
  checkinReply: "already", // "ok" | "already" | "fail"
  loginFails: false,
  reset() {
    this.validTokens = null
    this.checkinReply = "already"
    this.loginFails = false
  },
}

function tokenOk(auth) {
  const t = auth.replace(/^Bearer\s+/i, "")
  const allowed = state.validTokens ?? [GOOD_TOKEN]
  return allowed.includes(t)
}

before(async () => {
  server = createServer((req, res) => {
    const auth = req.headers.authorization ?? ""
    const clientid = req.headers.clientid ?? ""
    seen.push({ path: req.url, method: req.method, auth, clientid })

    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json;charset=UTF-8" })
      res.end(JSON.stringify(body))
    }

    // 模型列表：只认 API Key
    if (req.url === "/v1/models") {
      if (auth !== `Bearer ${GOOD_KEY}`) {
        return send(401, {
          error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" },
        })
      }
      return send(200, {
        object: "list",
        data: [{ id: "deepseek-v4.1-flash-1017", object: "model", owned_by: "deepseek" }],
      })
    }

    // 密码登录：换新令牌
    if (req.url === "/app/auth/login" && req.method === "POST") {
      if (state.loginFails) return send(200, { code: 500, data: null, msg: "手机号或密码错误" })
      return send(200, {
        code: 200,
        msg: "操作成功",
        data: { access_token: RENEWED_TOKEN, expire_in: 604800 },
      })
    }

    // 额度：只认网页令牌 + clientid
    if (req.url === "/app/token") {
      if (!tokenOk(auth) || clientid !== CLIENT_ID) {
        return send(200, { code: 401, data: null, msg: "认证失败，无法访问系统资源" })
      }
      return send(200, TOKEN_BODY)
    }

    // 每日用量
    if (req.url.startsWith("/app/llm/requests/daily")) {
      if (!tokenOk(auth) || clientid !== CLIENT_ID) {
        return send(200, { code: 401, data: null, msg: "认证失败，无法访问系统资源" })
      }
      return send(200, DAILY_BODY)
    }

    // 钱包：鱼币余额
    if (req.url === "/app/wallet") {
      if (!tokenOk(auth) || clientid !== CLIENT_ID) {
        return send(200, { code: 401, data: null, msg: "认证失败，无法访问系统资源" })
      }
      return send(200, {
        code: 200,
        msg: "操作成功",
        data: {
          giftPoints: "40.0000",
          heldPoints: "0.0000",
          paidPoints: "0.0000",
          totalPoints: "40.0000",
        },
      })
    }

    // 签到状态
    if (req.url === "/app/checkin" && req.method === "GET") {
      if (!tokenOk(auth) || clientid !== CLIENT_ID) {
        return send(200, { code: 401, data: null, msg: "认证失败，无法访问系统资源" })
      }
      // "notyet" 模拟今天还没签：checkedIn=false 且 awardedToday=0
      const data =
        state.checkinReply === "notyet"
          ? { ...CHECKIN_STATUS, checkedIn: false, awardedToday: "0.0000", streakDays: 0 }
          : CHECKIN_STATUS
      return send(200, { code: 200, msg: "操作成功", data })
    }

    // 签到：POST。三种结果对齐真实站点
    if (req.url === "/app/checkin" && req.method === "POST") {
      if (!tokenOk(auth) || clientid !== CLIENT_ID) {
        return send(200, { code: 401, data: null, msg: "认证失败，无法访问系统资源" })
      }
      if (state.checkinReply === "already") {
        return send(200, {
          code: 409,
          msg: "今天已经签到过了，明天再来吧",
          data: { reason: "already_checked_in" },
        })
      }
      if (state.checkinReply === "fail") {
        return send(200, { code: 500, msg: "签到服务暂时不可用", data: null })
      }
      return send(200, {
        code: 200,
        msg: "签到成功",
        data: { awarded: "10.0000", streakDays: 2 },
      })
    }

    // 复刻真实站点的行为：/v1 下任何未实现路径都返回这个
    if (req.url.startsWith("/v1/")) {
      return send(404, {
        error: { message: `No endpoint GET ${req.url}.`, type: "invalid_request_error", param: null, code: null },
      })
    }

    // 其余路径被反代成 HTML（真实站点也是这样）
    res.writeHead(200, { "content-type": "text/html" })
    res.end("<!doctype html><html></html>")
  })

  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((r) => server.close(r))
})

/** 取插件定义；每个用例都要新的实例，避免状态串味。 */
async function plugin(client) {
  return MinekuaiPlugin({ client })
}

/** 记录 client.auth.set 的假 magpie client，用来断言「有没有写回账号」。 */
function fakeClient() {
  const writes = []
  return {
    writes,
    auth: {
      async set(payload) {
        writes.push(payload)
      },
    },
  }
}

// ---- config ------------------------------------------------------------------

test("config 写出 provider 名与占位模型", async () => {
  const p = await plugin()
  const config = {}

  await p.config(config)
  assert.equal(config.provider.minekuai.name, "麦块云")
  assert.equal(config.provider.minekuai.npm, "@ai-sdk/openai-compatible")
  // 还没有账号时用占位模型顶住 magpie 的非空要求
  assert.ok(config.provider.minekuai.models["minekuai-placeholder"])

  // 第二次调用要保留账号已列出的真实模型，并去掉占位
  config.provider.minekuai.models = {
    "deepseek-v4.1-flash-1017": { id: "deepseek-v4.1-flash-1017" },
  }
  await p.config(config)
  assert.ok(config.provider.minekuai.models["deepseek-v4.1-flash-1017"])
  assert.equal(config.provider.minekuai.models["minekuai-placeholder"], undefined)
})

// ---- 登录 --------------------------------------------------------------------

test("authorize 校验 API Key 与网页令牌，成功时不把令牌当密钥存", async () => {
  const p = await plugin()
  const method = p.auth.methods[0]
  assert.equal(method.type, "oauth")

  const flow = await method.authorize({ baseURL: base, apiKey: GOOD_KEY, webToken: GOOD_TOKEN })
  const result = await flow.callback()

  assert.equal(result.type, "success")
  assert.equal(result.key, GOOD_KEY)
  assert.equal(result.metadata.webToken, GOOD_TOKEN)
  // 默认站点不写进 metadata，非默认地址才写
  assert.equal(result.metadata.baseURL, base)
  // 账号名只用密钥后四位，不能出现令牌
  assert.match(result.accountId, /127\.0\.0\.1/)
  assert.doesNotMatch(result.accountId, /eyJ/)
})

test("authorize 在 API Key 无效时明确失败", async () => {
  const p = await plugin()
  const method = p.auth.methods[0]
  const flow = await method.authorize({ baseURL: base, apiKey: "sk-bad", webToken: "" })
  const result = await flow.callback()

  assert.equal(result.type, "failed")
  assert.match(result.error, /API Key 不可用/)
})

test("authorize 在网页令牌无效时提前失败，不存坏账号", async () => {
  const p = await plugin()
  const method = p.auth.methods[0]
  const flow = await method.authorize({ baseURL: base, apiKey: GOOD_KEY, webToken: "eyJbad" })
  const result = await flow.callback()

  assert.equal(result.type, "failed")
  assert.match(result.error, /网页登录令牌不可用/)
})

test("authorize 允许不填网页令牌（只要模型，不看额度）", async () => {
  const p = await plugin()
  const method = p.auth.methods[0]
  const flow = await method.authorize({ baseURL: base, apiKey: GOOD_KEY, webToken: "" })
  const result = await flow.callback()

  assert.equal(result.type, "success")
  assert.equal(result.metadata.webToken, undefined)
})

// ---- 模型 --------------------------------------------------------------------

test("provider.models 用 API Key 列出真实模型", async () => {
  const p = await plugin()
  const auth = { type: "api", key: GOOD_KEY, metadata: { baseURL: base } }

  const models = await p.provider.models({ models: {} }, { auth })
  assert.deepEqual(Object.keys(models), ["deepseek-v4.1-flash-1017"])
  assert.equal(models["deepseek-v4.1-flash-1017"].api.url, base + "/v1")
  assert.equal(models["deepseek-v4.1-flash-1017"].api.npm, "@ai-sdk/openai-compatible")
})

test("loader 给出 magpie 需要的 baseURL 与 apiKey", async () => {
  const p = await plugin()
  const auth = { type: "api", key: GOOD_KEY, metadata: { baseURL: base } }

  const out = await p.auth.loader(async () => auth)
  assert.equal(out.baseURL, base + "/v1")
  assert.equal(out.apiKey, GOOD_KEY)
})

// ---- 额度 --------------------------------------------------------------------

test("usage 用网页令牌 + clientid 读出两个额度窗口", async () => {
  seen.length = 0
  const p = await plugin()
  const auth = { type: "api", key: GOOD_KEY, metadata: { baseURL: base, webToken: GOOD_TOKEN } }

  const u = await p.auth.usage(async () => auth)

  assert.equal(u.plan, "按量付费")
  // 两个额度窗口 + 鱼币余额 + 今日用量 + 签到状态
  assert.equal(u.windows.length, 5)
  assert.equal(u.windows[0].name, "付费按量 token")
  assert.equal(u.windows[1].name, "免费按量额度")
  assert.equal(u.windows[2].name, "鱼币余额")
  assert.equal(u.windows[2].display, "40 鱼币")
  assert.equal(u.windows[3].name, "今日用量")
  // 1156619 + 4533632 + 9462 = 5,699,713 → 569.97 万
  assert.equal(u.windows[3].display, "569.97 万 token · 17 次调用")
  assert.equal(u.windows[4].name, "每日签到")
  assert.equal(u.balance, "10.1 亿 token")
  assert.equal(u.error, undefined)

  // 关键：请求带回 clientid 头，且用的是网页令牌而不是 API Key
  const q = seen.find((s) => s.path === "/app/token")
  assert.ok(q, "应当请求 /app/token")
  assert.equal(q.clientid, CLIENT_ID)
  assert.equal(q.auth, `Bearer ${GOOD_TOKEN}`)
})

test("usage 在没填网页令牌时给出可操作的提示", async () => {
  const p = await plugin()
  const auth = { type: "api", key: GOOD_KEY, metadata: { baseURL: base } }

  const u = await p.auth.usage(async () => auth)
  assert.equal(u.windows.length, 0)
  assert.match(u.error, /网页登录令牌/)
})

test("usage 在网页令牌过期时标记需要重登", async () => {
  state.reset()
  const p = await plugin()
  // 没存手机号密码 → 无法自动续期，只能报错
  const auth = { type: "api", key: GOOD_KEY, metadata: { baseURL: base, webToken: "eyJexpired" } }

  const u = await p.auth.usage(async () => auth)
  assert.equal(u.signIn, "expired")
  assert.match(u.error, /认证失败/)
  // 明确告诉用户为什么没自动续上
  assert.match(u.notice, /未保存手机号与密码/)
})

test("usage 不把 /v1/usage 当额度来源", async () => {
  // 这是本插件存在的根本原因：麦块云的 /v1/usage 是 404。
  // 如果有人误改回读 /v1/usage，这个用例会失败。
  state.reset()
  seen.length = 0
  const p = await plugin()
  const auth = { type: "api", key: GOOD_KEY, metadata: { baseURL: base, webToken: GOOD_TOKEN } }
  await p.auth.usage(async () => auth)

  assert.equal(seen.some((s) => s.path === "/v1/usage"), false)
  assert.equal(seen.some((s) => s.path === "/app/token"), true)
})

// ---- 令牌自动续期 -------------------------------------------------------------

test("令牌过期但存了密码时，自动续期并重试成功", async () => {
  state.reset()
  // 站点只认新令牌，旧令牌已被判过期
  state.validTokens = [RENEWED_TOKEN]
  const client = fakeClient()
  const p = await plugin(client)

  seen.length = 0
  const auth = {
    type: "api",
    key: GOOD_KEY,
    metadata: { baseURL: base, webToken: GOOD_TOKEN, phone: PHONE, password: PASSWORD },
  }
  const u = await p.auth.usage(async () => auth)

  // 额度照常读出，并标记这次续过期
  assert.equal(u.windows.length, 5)
  assert.equal(u.balance, "10.1 亿 token")
  assert.equal(u.renewed, true)
  assert.equal(u.signIn, undefined)

  // 调用顺序：先登录换令牌，再用新令牌读额度
  const login = seen.findIndex((s) => s.path === "/app/auth/login")
  const withNew = seen.findIndex((s) => s.path === "/app/token" && s.auth === `Bearer ${RENEWED_TOKEN}`)
  assert.ok(login >= 0, "应当调用密码登录接口")
  assert.ok(withNew > login, "应当在登录之后用新令牌读额度")
})

test("续期成功后把新令牌写回账号，避免下次重复登录", async () => {
  state.reset()
  state.validTokens = [RENEWED_TOKEN]
  const client = fakeClient()
  const p = await plugin(client)

  const auth = {
    type: "api",
    key: GOOD_KEY,
    metadata: { baseURL: base, webToken: GOOD_TOKEN, phone: PHONE, password: PASSWORD },
  }
  await p.auth.usage(async () => auth)

  const tokenWrite = client.writes.find((w) => w.body?.metadata?.webToken === RENEWED_TOKEN)
  assert.ok(tokenWrite, "应当把新令牌写回账号")
  assert.ok(tokenWrite.body.metadata.webTokenExpireAt > Date.now(), "应当记下新令牌的到期时间")
  // 写回时必须保留原 API Key
  assert.equal(tokenWrite.body.key, GOOD_KEY)
})

test("令牌快到期时提前续期，不等 401", async () => {
  state.reset()
  state.validTokens = [GOOD_TOKEN, RENEWED_TOKEN]
  const client = fakeClient()
  const p = await plugin(client)

  seen.length = 0
  const auth = {
    type: "api",
    key: GOOD_KEY,
    metadata: {
      baseURL: base,
      webToken: GOOD_TOKEN,
      phone: PHONE,
      password: PASSWORD,
      // 还剩 12 小时，小于 1 天的提前量
      webTokenExpireAt: Date.now() + 12 * 3600 * 1000,
    },
  }
  const u = await p.auth.usage(async () => auth)

  assert.equal(u.renewed, true)
  // 旧令牌仍然可用，但应当先续期
  assert.ok(seen.some((s) => s.path === "/app/auth/login"), "应当提前调用登录接口")
})

test("离到期还远时不续期，省掉一次登录", async () => {
  state.reset()
  const client = fakeClient()
  const p = await plugin(client)

  seen.length = 0
  const auth = {
    type: "api",
    key: GOOD_KEY,
    metadata: {
      baseURL: base,
      webToken: GOOD_TOKEN,
      phone: PHONE,
      password: PASSWORD,
      webTokenExpireAt: Date.now() + 6 * 24 * 3600 * 1000,
    },
  }
  const u = await p.auth.usage(async () => auth)

  // 没续期时不点亮 renewed 标记
  assert.notEqual(u.renewed, true)
  assert.equal(seen.some((s) => s.path === "/app/auth/login"), false)
})

test("密码错了时续期失败，明确报错而不是静默", async () => {
  state.reset()
  state.validTokens = [RENEWED_TOKEN]
  state.loginFails = true
  const p = await plugin(fakeClient())

  const auth = {
    type: "api",
    key: GOOD_KEY,
    metadata: { baseURL: base, webToken: GOOD_TOKEN, phone: PHONE, password: "definitely-wrong-xyz-123" },
  }
  const u = await p.auth.usage(async () => auth)

  assert.equal(u.signIn, "expired")
  assert.match(u.notice, /自动续期失败/)
})

test("登录时校验手机号密码，填错不阻断登录但会留下提示", async () => {
  state.reset()
  state.loginFails = true
  const p = await plugin()

  const method = p.auth.methods[0]
  const flow = await method.authorize({
    baseURL: base,
    apiKey: GOOD_KEY,
    webToken: GOOD_TOKEN,
    phone: PHONE,
    password: PASSWORD,
  })
  const result = await flow.callback()

  // 密码错不该让整个登录失败：模型部分仍然可用
  assert.equal(result.type, "success")
  assert.match(result.metadata.renewNote, /自动续期不可用/)
})

test("登录时手机号密码正确，不产生续期警告", async () => {
  state.reset()
  const p = await plugin()
  const method = p.auth.methods[0]
  const flow = await method.authorize({
    baseURL: base,
    apiKey: GOOD_KEY,
    webToken: GOOD_TOKEN,
    phone: PHONE,
    password: PASSWORD,
  })
  const result = await flow.callback()

  assert.equal(result.type, "success")
  assert.equal(result.metadata.renewNote, undefined)
  // 手机号密码要存下来，供下次续期用
  assert.equal(result.metadata.phone, PHONE)
  assert.equal(result.metadata.password, PASSWORD)
  // 令牌到期时间也应记下
  assert.ok(result.metadata.webTokenExpireAt > Date.now())
})

// ---- 签到（magpie 原生 checkin 钩子）-----------------------------------------

test("签到成功时返回 claimed 与奖励、连续天数", async () => {
  state.reset()
  state.checkinReply = "ok"
  const p = await plugin(fakeClient())

  const auth = { type: "api", key: GOOD_KEY, metadata: { baseURL: base, webToken: GOOD_TOKEN } }
  const r = await p.auth.checkin(async () => auth)

  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 10)
  assert.equal(r.streak, 2)
  assert.match(r.message, /\+10 鱼币/)
  assert.match(r.message, /连续 2 天/)
})

test("今天已经签过时返回 done，不是失败", async () => {
  state.reset()
  state.checkinReply = "already"
  const p = await plugin(fakeClient())

  const auth = { type: "api", key: GOOD_KEY, metadata: { baseURL: base, webToken: GOOD_TOKEN } }
  const r = await p.auth.checkin(async () => auth)

  assert.equal(r.outcome, "done")
  // 已签也要告诉用户今天拿了多少
  assert.equal(r.credit, 10)
  assert.match(r.message, /今天已签到/)
})

test("签到失败时返回 failed 并给出原因，让宿主稍后重试", async () => {
  state.reset()
  state.checkinReply = "fail"
  const p = await plugin(fakeClient())

  const auth = { type: "api", key: GOOD_KEY, metadata: { baseURL: base, webToken: GOOD_TOKEN } }
  const r = await p.auth.checkin(async () => auth)

  assert.equal(r.outcome, "failed")
  assert.match(r.message, /签到服务暂时不可用/)
})

test("令牌过期时签到会先自动续期，再签", async () => {
  state.reset()
  state.checkinReply = "ok"
  // 站点只认续期后的新令牌
  state.validTokens = [RENEWED_TOKEN]
  const client = fakeClient()
  const p = await plugin(client)

  seen.length = 0
  const auth = {
    type: "api",
    key: GOOD_KEY,
    metadata: { baseURL: base, webToken: GOOD_TOKEN, phone: PHONE, password: PASSWORD },
  }
  const r = await p.auth.checkin(async () => auth)

  assert.equal(r.outcome, "claimed")
  assert.ok(seen.some((s) => s.path === "/app/auth/login"), "应当先续期")
  assert.ok(
    seen.some((s) => s.path === "/app/checkin" && s.auth === `Bearer ${RENEWED_TOKEN}`),
    "签到应当用续期后的新令牌"
  )
  // 新令牌要写回账号
  assert.ok(client.writes.some((w) => w.body?.metadata?.webToken === RENEWED_TOKEN))
})

test("令牌过期且无密码时签到抛错并标记重登", async () => {
  state.reset()
  state.validTokens = [RENEWED_TOKEN] // 旧令牌全部失效
  const p = await plugin(fakeClient())

  const auth = { type: "api", key: GOOD_KEY, metadata: { baseURL: base, webToken: GOOD_TOKEN } }
  await assert.rejects(
    () => p.auth.checkin(async () => auth),
    (e) => e.signIn === "expired" && /未保存手机号与密码/.test(e.message)
  )
})

test("没填网页令牌时签到返回 failed，不会静默", async () => {
  state.reset()
  const p = await plugin(fakeClient())

  const auth = { type: "api", key: GOOD_KEY, metadata: { baseURL: base } }
  const r = await p.auth.checkin(async () => auth)

  assert.equal(r.outcome, "failed")
  assert.match(r.message, /网页登录令牌/)
})

test("签到不依赖查额度，可以单独触发", async () => {
  // magpie 的 Check in now / 每日调度只调 checkin，不调 usage。
  // 这条确保两者解耦，签到不会因为额度接口的问题而失效。
  state.reset()
  state.checkinReply = "ok"
  const p = await plugin(fakeClient())
  seen.length = 0

  const auth = { type: "api", key: GOOD_KEY, metadata: { baseURL: base, webToken: GOOD_TOKEN } }
  const r = await p.auth.checkin(async () => auth)

  assert.equal(r.outcome, "claimed")
  assert.ok(seen.some((s) => s.path === "/app/checkin" && s.method === "POST"))
})

test("查额度只读签到状态，不做签到动作", async () => {
  // 职责分离：usage 只负责展示今天签没签（GET /app/checkin），
  // 真正的签到（POST）交给 magpie 原生的 checkin 钩子调度，
  // 否则每次查额度都可能触发一次签到。
  state.reset()
  state.checkinReply = "ok"
  const p = await plugin(fakeClient())
  seen.length = 0

  const auth = { type: "api", key: GOOD_KEY, metadata: { baseURL: base, webToken: GOOD_TOKEN } }
  await p.auth.usage(async () => auth)

  assert.ok(seen.some((s) => s.path === "/app/checkin" && s.method === "GET"), "应当读取签到状态")
  assert.equal(seen.some((s) => s.path === "/app/checkin" && s.method === "POST"), false, "不应当在查额度时签到")
})

test("签到状态行不参与路由（aside）", async () => {
  // magpie 会把 windows 当成额度池参与选号；签到行只是展示，
  // 必须标 aside: true，否则会被误当成还能用多少
  state.reset()
  const p = await plugin(fakeClient())
  const auth = { type: "api", key: GOOD_KEY, metadata: { baseURL: base, webToken: GOOD_TOKEN } }
  const u = await p.auth.usage(async () => auth)

  const row = u.windows.find((w) => w.name === "每日签到")
  assert.ok(row, "应当有签到状态行")
  assert.equal(row.aside, true)
})

test("未签到时状态行明确说「今日未签」", async () => {
  // 站点返回 checkedIn: false 时不能沉默，也不能显示成已签
  state.reset()
  const p = await plugin(fakeClient())
  const auth = { type: "api", key: GOOD_KEY, metadata: { baseURL: base, webToken: GOOD_TOKEN } }

  // 临时把假站点的签到状态改成未签
  const original = state.checkinReply
  state.checkinReply = "notyet"
  try {
    const u = await p.auth.usage(async () => auth)
    const row = u.windows.find((w) => w.name === "每日签到")
    assert.match(row.display, /今日未签/)
  } finally {
    state.checkinReply = original
  }
})
