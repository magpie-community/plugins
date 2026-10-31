// 协议原生插件的回归测试，由 index.test.mjs 在隔离子进程中运行。
// 全部离线：网络调用用注入的 mock fetch，凭据一律用假数据。
import "./isolate.mjs"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const mod = await import(join(root, "index.mjs"))
const _ = mod._internal

let passed = 0
const cases = []
function test(name, fn) { cases.push([name, fn]) }
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

// ---------------------------------------------------------------------------
// 地址校验
// ---------------------------------------------------------------------------
test("parseBaseURL 接受带路径前缀的 HTTPS", () => {
  const ok = (v) => { const r = _.parseBaseURL(v); assert.ok(!r.error, v); return r.base }
  assert.equal(ok("https://corp.invalid"), "https://corp.invalid")
  assert.equal(ok("https://a.b.com/prefix/"), "https://a.b.com/prefix")
})
test("parseBaseURL 拒绝 http/账号/查询/编码分隔符", () => {
  for (const bad of ["http://a.com", "https://u:p@a.com", "https://a.com?q=1", "https://a.com#f", "https://a.com/%2f", "not a url", ""]) {
    assert.ok(_.parseBaseURL(bad).error, bad)
  }
})
test("sameOriginPath 不允许离开部署 origin", () => {
  assert.equal(_.sameOriginPath("https://a.com", "/api/x"), "https://a.com/api/x")
  assert.throws(() => _.sameOriginPath("https://a.com", "https://b.com/x"))
  assert.throws(() => _.sameOriginPath("https://a.com", "/a/../b"))
})

// ---------------------------------------------------------------------------
// 模型目录映射（fixture 来自 get_config_list 实测响应的结构）
// ---------------------------------------------------------------------------
const CONFIG_LIST_FIXTURE = {
  config_info_list: [
    {
      config_name: "glm-5.3",
      config_source: 1,
      display_config: { display_name: "GLM-5.3", is_custom_model: false, model_capability: "reasoning_model", multimodal: true },
      model_detail_list: [{ model_name: "glm-5.3__v2", max_tokens: 16000, prompt_max_tokens: 200000 }],
    },
    {
      config_name: "kimi-k3",
      display_config: { display_name: "Kimi-K3", is_custom_model: false, model_capability: "chat", multimodal: true },
      model_detail_list: [{ model_name: "kimi-k3__v1", max_tokens: 8000, prompt_max_tokens: 184000 }],
    },
    { config_name: "broken-no-detail", display_config: { display_name: "X" }, model_detail_list: [] },
    { config_name: "custom-1", display_config: { display_name: "C", is_custom_model: true }, model_detail_list: [{ model_name: "c__1", prompt_max_tokens: 1000 }] },
  ],
}
test("catalogOf 映射 config_name/model_name/上下文/能力", () => {
  const items = _.catalogOf(CONFIG_LIST_FIXTURE)
  assert.equal(items.length, 3)
  const glm = items[0]
  assert.equal(glm.id, "glm-5.3")
  assert.equal(glm.wire, "glm-5.3__v2")
  assert.equal(glm.context, 200000)
  assert.equal(glm.image, true)
  assert.equal(glm.reasoning, true)
  assert.equal(items[1].reasoning, false)
  assert.ok(items.some((m) => m.custom))
})
test("模型目录缓存：上游失败时回落最近一次成功列表", async () => {
  const real = globalThis.fetch
  let fail = false
  const token = "t".repeat(30)
  globalThis.fetch = async () => fail
    ? new Response("boom", { status: 500 })
    : jsonResponse(CONFIG_LIST_FIXTURE)
  try {
    const first = await _.catalogFor("https://a.com", token, { fallback: false })
    assert.equal(first.length, 2) // custom-1 被过滤
    assert.ok(first.every((m) => !m.custom))
    fail = true
    const second = await _.catalogFor("https://a.com", token)
    assert.equal(second.length, 2)
    await assert.rejects(() => _.catalogFor("https://a.com", "other-token-aaaaaaaaaaaaaaaa", { fallback: false }))
  } finally { globalThis.fetch = real }
})

test("未知上下文保守上报，GUI 开关才启用扩展窗口", () => {
  process.env.TRAE_PRIVATE_CONTEXT = "1500000"
  try {
    for (const value of [undefined, 0, -1, 1.5, "bad", Infinity]) {
      const data = { config_info_list: [{ config_name: "unknown", model_detail_list: [{ model_name: "wire", prompt_max_tokens: value }] }] }
      const items = _.catalogOf(data)
      assert.equal(_.reported(items, {})[0].context, 128000)
      assert.equal(_.reported(items, { magpie: { option: () => true } })[0].context, 1500000)
    }
    const large = _.catalogOf({ config_info_list: [{ config_name: "large", model_detail_list: [{ model_name: "large", prompt_max_tokens: 2000000 }] }] })
    assert.equal(_.reported(large, { magpie: { option: () => true } })[0].context, 2000000)
  } finally { delete process.env.TRAE_PRIVATE_CONTEXT }
})
test("目录缓存按完整凭据隔离，不能借用相同前缀账号的模型", async () => {
  const real = globalThis.fetch
  const base = "https://identity.invalid"
  const prefix = "x".repeat(24)
  try {
    globalThis.fetch = async () => jsonResponse(CONFIG_LIST_FIXTURE)
    await _.catalogFor(base, `${prefix}A`)
    globalThis.fetch = async () => { throw new Error("offline") }
    await assert.rejects(() => _.catalogFor(base, `${prefix}B`), /offline/)
    await assert.rejects(() => _.catalogFor("https://other.invalid", `${prefix}A`), /offline/)
  } finally { globalThis.fetch = real }
})
test("格式损坏的目录不能清空 last-good；有效空目录可以撤回模型", async () => {
  const real = globalThis.fetch
  const now = Date.now
  let clock = now()
  const base = "https://malformed.invalid"
  try {
    Date.now = () => clock
    globalThis.fetch = async () => jsonResponse(CONFIG_LIST_FIXTURE)
    const good = await _.catalogFor(base, "token")
    for (const invalid of [{}, { config_info_list: null }, { config_info_list: [null] }, { config_info_list: [{ config_name: "broken", model_detail_list: [] }] }]) {
      clock += 61000
      globalThis.fetch = async () => jsonResponse(invalid)
      assert.deepEqual(await _.catalogFor(base, "token"), good)
      await assert.rejects(() => _.catalogFor(base, "token", { fallback: false }))
    }
    clock += 61000
    globalThis.fetch = async () => jsonResponse({ config_info_list: [] })
    assert.deepEqual(await _.catalogFor(base, "token"), [])
    clock += 61000
    globalThis.fetch = async () => { throw new Error("offline") }
    assert.deepEqual(await _.catalogFor(base, "token"), [])
  } finally { globalThis.fetch = real; Date.now = now }
})
test("目录一分钟内复用，长时间故障保留列表，恢复后更新", async () => {
  const real = globalThis.fetch
  const now = Date.now
  let clock = now()
  let calls = 0
  let response = CONFIG_LIST_FIXTURE
  const base = "https://ttl.invalid"
  try {
    Date.now = () => clock
    globalThis.fetch = async () => { calls++; if (!response) throw new Error("offline"); return jsonResponse(response) }
    const good = await _.catalogFor(base, "token")
    clock += 59000
    assert.deepEqual(await _.catalogFor(base, "token"), good)
    assert.equal(calls, 1)
    clock += 86400000
    response = null
    assert.deepEqual(await _.catalogFor(base, "token"), good)
    clock += 86400000
    assert.deepEqual(await _.catalogFor(base, "token"), good)
    response = { config_info_list: [CONFIG_LIST_FIXTURE.config_info_list[1]] }
    assert.equal((await _.catalogFor(base, "token")).length, 1)
  } finally { globalThis.fetch = real; Date.now = now }
})
test("目录鉴权失效不使用缓存掩盖，并清除旧目录", async () => {
  const real = globalThis.fetch
  const now = Date.now
  let clock = now()
  try {
    Date.now = () => clock
    globalThis.fetch = async () => jsonResponse(CONFIG_LIST_FIXTURE)
    await _.catalogFor("https://expired.invalid", "token")
    clock += 61000
    globalThis.fetch = async () => jsonResponse({ code: 30011, message: "expired" })
    await assert.rejects(() => _.catalogFor("https://expired.invalid", "token"), (e) => e.signIn === "expired")
    globalThis.fetch = async () => { throw new Error("offline") }
    await assert.rejects(() => _.catalogFor("https://expired.invalid", "token"), /offline/)
  } finally { globalThis.fetch = real; Date.now = now }
})
test("目录请求使用与会话相同的协议覆盖项", async () => {
  const real = globalThis.fetch
  let headers
  process.env.TRAE_PRIVATE_APP_ID = "override-app"
  process.env.TRAE_PRIVATE_IDE_VERSION_CODE = "20270101"
  process.env.TRAE_PRIVATE_ORIGINATOR = "override-client"
  try {
    globalThis.fetch = async (_url, init) => { headers = init.headers; return jsonResponse(CONFIG_LIST_FIXTURE) }
    await _.fetchConfigList("https://headers.invalid", "token")
    assert.equal(headers["X-App-Id"], "override-app")
    assert.equal(headers["X-Ide-Version-Code"], "20270101")
    assert.equal(headers.Originator, "override-client")
  } finally {
    globalThis.fetch = real
    for (const key of ["TRAE_PRIVATE_APP_ID", "TRAE_PRIVATE_IDE_VERSION_CODE", "TRAE_PRIVATE_ORIGINATOR"]) delete process.env[key]
  }
})

// ---------------------------------------------------------------------------
// 用量卡片（fixture 来自 GetUserInfo 实测结构，值做了改写）
// ---------------------------------------------------------------------------
const USER_INFO_FIXTURE = {
  code: 0,
  Data: {
    UserInfo: {
      UserID: "1", Account: "u@corp.test", Email: "u@corp.test", Scope: "private_volc", Region: "cn-beijing",
      ProductType: 320, CurSeats: 682, TotalSeats: 700, AllChatCnt: 5, UsagePrice: 1.5, UsagePriceLimit: 10,
      IsAllowLogin: true, TenantInfoBase: { TenantName: "某集团", CurrentEntitlementExpireTime: 1793462400000 },
    },
    RoleInfo: { RoleName: "成员" },
  },
}
test("usageCardOf 输出席位/个人额度窗口与权益到期", () => {
  const card = _.usageCardOf(USER_INFO_FIXTURE)
  assert.equal(card.plan, "企业专享版")
  assert.equal(card.user, "u@corp.test")
  assert.equal(card.windows.length, 2)
  const seats = card.windows.find((w) => w.name === "企业席位")
  assert.equal(seats.used.toFixed(2), "97.43")
  assert.equal(seats.amount, 682)
  assert.equal(seats.limit, 700)
  assert.equal(seats.display, "682/700 席")
  const price = card.windows.find((w) => w.name === "个人额度")
  assert.equal(price.display, "￥1.50 / ￥10.00")
  assert.equal(card.until, new Date(1793462400000).toISOString())
  assert.equal(card.metadata.tenant, "某集团")
})
test("usageCardOf 零额度时不编造窗口", () => {
  const card = _.usageCardOf({ Data: { UserInfo: { UserID: "1", IsAllowLogin: true } } })
  assert.equal(card.windows.length, 0)
  assert.ok(card.error)
})
test("usageCardOf 部署禁登时标记账号失效", () => {
  const fix = structuredClone(USER_INFO_FIXTURE)
  fix.Data.UserInfo.IsAllowLogin = false
  assert.throws(() => _.usageCardOf(fix), (e) => e.signIn === "expired")
})

// ---------------------------------------------------------------------------
// 网页会话增强（基础/超额/企业内置模型）
// ---------------------------------------------------------------------------
test("parseCookieValue 兼容裸值/键值对/带属性三种形态并拒绝换行注入", () => {
  assert.equal(_.parseCookieValue("  abc=; Path=/  "), "abc=")
  assert.equal(_.parseCookieValue("X-Cloudide-Tob-Session=v1; Secure"), "v1")
  assert.equal(_.parseCookieValue("v2"), "v2")
  assert.equal(_.parseCookieValue("bad\r\nvalue"), "")
  assert.equal(_.parseCookieValue(""), "")
})
test("webSessionFile 按部署 origin 与 uid 分层编码", () => {
  const p = _.webSessionFile({ base: "https://a.com", uid: "7" })
  assert.ok(p.includes("trae-private-sessions"))
  assert.ok(p.endsWith("web-session.txt"))
  assert.notEqual(p, _.webSessionFile({ base: "https://b.com", uid: "7" }))
  assert.notEqual(p, _.webSessionFile({ base: "https://a.com", uid: "8" }))
})
const QUOTA_FIXTURE = {
  code: 0,
  user_model_quota: {
    seat_pool_currency_quota: 1000,
    paygo_currency_quota: 200,
    custom_model_quota_list: [
      { config_name: "glm-v5", display_name: "glm-v5（私有化）", token_quota: 10000 },
      { config_name: "qwen-vl", display_name: "qwen-vl", token_quota: 9999999999 },
    ],
  },
}
const USAGE_FIXTURE = {
  code: 0,
  user_usage_list: [
    {
      model_usage_detail_list: [
        { config_name: "glm-v5", display_name: "glm-v5（私有化）", total_token_usage: 24093, total_cost_currency: 0 },
        { config_name: "qwen-vl", display_name: "qwen-vl", total_token_usage: 0, total_cost_currency: 0 },
      ],
      in_seat_detail: {
        chat_usage_details: [
          { config_name: "glm-5.3", display_name: "GLM-5.3", total_cost_currency: 3.5, total_token_usage: 900 },
          { config_name: "Doubao-Seed-2.1-pro", display_name: "Doubao", total_cost_currency: 0, total_token_usage: 0 },
        ],
      },
    },
    {
      model_usage_detail_list: [
        { config_name: "kimi-k3", display_name: "Kimi-K3", total_cost_currency: 12.0, total_token_usage: 5000 },
      ],
    },
  ],
}
test("mergeSessionUsage 输出基础/超额窗口、企业内置模型 token 窗口与余额", () => {
  const card = _.usageCardOf(USER_INFO_FIXTURE)
  const merged = _.mergeSessionUsage(card, { quota: QUOTA_FIXTURE, usage: USAGE_FIXTURE })
  const names = merged.windows.map((w) => w.name)
  assert.ok(names.includes("企业席位"))
  assert.ok(names.includes("基础用量"))
  assert.ok(names.includes("超额用量"))
  assert.ok(names.some((n) => n.includes("glm-v5")))
  assert.ok(!names.some((n) => n.includes("qwen-vl"))) // 不限量且零用量的不画窗口
  assert.ok(merged.metadata.builtInModels.some((m) => m.name.includes("qwen-vl") && m.quota === "不限"))
  const seat = merged.windows.find((w) => w.name === "基础用量")
  assert.equal(seat.display, "￥3.50 / ￥1,000.00")
  assert.equal(seat.used.toFixed(2), "0.35")
  const over = merged.windows.find((w) => w.name === "超额用量")
  assert.equal(over.amount, 12)
  assert.equal(merged.balance, "996.50") // 席位还有余额时不计超额余量
  const custom = merged.windows.find((w) => w.name.includes("glm-v5"))
  assert.equal(custom.display, "24,093 / 10,000 token")
  assert.ok(custom.used > 100)
  assert.ok(merged.metadata.models.some((m) => m.name === "GLM-5.3"))
})
test("quotaWithSession 带 Cookie 头调用两个会话端点", async () => {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), cookie: init.headers.Cookie })
    return jsonResponse({ code: 0, user_model_quota: {}, user_usage_list: [] })
  }
  try {
    await _.quotaWithSession("https://a.com", "SESS")
    assert.equal(calls.length, 2)
    assert.ok(calls[0].url.includes("get_personal_quota"))
    assert.ok(calls[1].url.includes("get_user_model_usage"))
    assert.ok(calls.every((c) => c.cookie === "X-Cloudide-Tob-Session=SESS"))
  } finally { globalThis.fetch = real }
})

// ---------------------------------------------------------------------------
// 消息构造与请求体预算
// ---------------------------------------------------------------------------
test("messagesOf 转换图片/工具调用/工具结果", () => {
  const req = {
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,xxx" } }] },
      { role: "assistant", tool_calls: [{ id: "call_1", function: { name: "f", arguments: "{\"a\":1}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "result" },
    ],
  }
  const out = _.messagesOf(req)
  assert.equal(out.length, 3)
  assert.equal(out[0].content.length, 2)
  assert.equal(out[0].content[1].type, "image_url")
  assert.equal(out[1].tool_calls[0].function_call.name, "f")
  assert.equal(out[2].tool_call_id, "call_1")
})
test("toolChoiceOf 对象形式收敛为 required", () => {
  assert.equal(_.toolChoiceOf({ function: { name: "f" } }), "required")
  assert.equal(_.toolChoiceOf("auto"), "auto")
  assert.equal(_.toolChoiceOf("weird"), undefined)
})
test("chatBody 组装 config_name/model_name/会话", () => {
  const items = _.catalogOf(CONFIG_LIST_FIXTURE)
  process.env.TRAE_PRIVATE_BODY_BUDGET = String(1024 * 1024)
  try {
    const body = _.chatBody({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }], temperature: 0.2 }, "sess", items)
    assert.equal(body.config_name, "glm-5.3")
    assert.equal(body.model_name, "glm-5.3__v2")
    assert.equal(body.conversation_id, "sess")
    assert.equal(body.temperature, 0.2)
    assert.ok(_.sendable(body).includes('"config_name":"glm-5.3"'))
  } finally { delete process.env.TRAE_PRIVATE_BODY_BUDGET }
})
test("fitBody 超预算时先丢历史图片再截工具结果", () => {
  process.env.TRAE_PRIVATE_BODY_BUDGET = String(2048)
  process.env.TRAE_PRIVATE_TOOL_RESULT_KEEP = "100"
  try {
    const big = "x".repeat(4000)
    const body = {
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${big}` } }, { type: "text", text: "look" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "and this" }] },
      ],
    }
    const notes = _.fitBody(body)
    assert.ok(notes.droppedImages >= 1)
    assert.ok(notes.bytes <= 2048)
    assert.ok(body.messages[0].content.some((p) => p.type === "text" && p.text.includes("[image omitted")))
  } finally {
    delete process.env.TRAE_PRIVATE_BODY_BUDGET
    delete process.env.TRAE_PRIVATE_TOOL_RESULT_KEEP
  }
})

// ---------------------------------------------------------------------------
// SSE 事件解析
// ---------------------------------------------------------------------------
test("piece 解析 output/done/token_usage 与内容安全拦截", () => {
  const out = _.piece({ event: "output", data: { response: "你好" } }, new Set())
  assert.equal(out.text, "你好")
  assert.equal(out.done, false)
  const done = _.piece({ event: "done", data: { finish_reason: "stop" } }, new Set())
  assert.equal(done.done, true)
  assert.equal(done.finish, "stop")
  const usage = _.piece({ event: "token_usage", data: { usage: { prompt_tokens: 3, completion_tokens: 5 } } }, new Set())
  assert.equal(usage.usage.total_tokens, 8)
  const risky = _.piece({ event: "output", data: { finish_reason: "content_risk_filtered" } }, new Set())
  assert.ok(risky.error)
  const sec = _.piece({ event: "content_security", data: { hit_rule_name: "R1", action_type: 1, execute_point: 2 } }, new Set())
  assert.match(sec.error, /安全策略拦截/)
  const queue = _.piece({ event: "queue_position", data: "2" }, new Set())
  assert.deepEqual(queue, {})
})
test("piece 首帧工具调用补 call_<index>", () => {
  const seen = new Set()
  const p = _.piece({ event: "output", data: { tool_calls: [{ index: 0, function_call: { name: "f", arguments: "" } }] } }, seen)
  assert.equal(p.calls[0].id, "call_0")
})
test("collect 聚合非流式回答与分片工具参数", async () => {
  const events = [
    { event: "output", data: { tool_calls: [{ index: 0, id: "call_9", function_call: { name: "f", arguments: "{\"a" } }] } },
    { event: "output", data: { tool_calls: [{ index: 0, function_call: { arguments: "\":1}" } }] } },
    { event: "output", data: { response: "done text" } },
    { event: "done", data: { finish_reason: "tool_calls" } },
  ]
  async function* rest() { for (const e of events.slice(1)) yield e }
  const all = await _.collect(events[0], rest())
  assert.equal(all.error, "")
  assert.equal(all.text, "done text")
  assert.equal(all.calls[0].function.arguments, "{\"a\":1}")
  assert.equal(all.calls[0].id, "call_9")
  assert.equal(all.finish, "tool_calls")
})

// ---------------------------------------------------------------------------
// 协议客户端（mock fetch）
// ---------------------------------------------------------------------------
test("exchangeRefreshToken 用抓包实证的请求体并解析轮换响应", async () => {
  const real = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(init.body) }
    return jsonResponse({ code: 0, Data: {
      RefreshToken: "NEW-RT", Token: "NEW-JWT", TokenExpireAt: 1794073951465, RefreshExpireAt: 1808416351464, TokenExpireDuration: 1209600000,
    } })
  }
  try {
    const out = await _.exchangeRefreshToken("https://a.com", "OLD-RT")
    assert.equal(captured.url, "https://a.com/cloudide/api/v3/trae/oauth/ExchangeToken")
    assert.deepEqual(captured.body, { RefreshToken: "OLD-RT", ClientID: _.EXCHANGE_CLIENT_ID })
    assert.equal(out.access, "NEW-JWT")
    assert.equal(out.refresh, "NEW-RT")
    assert.equal(out.expires, 1794073951465)
  } finally { globalThis.fetch = real }
})
test("apiPost 把 30011 映射为账号失效", async () => {
  const real = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({ code: 30011, message: "请先登录" })
  try {
    await assert.rejects(() => _.apiPost("https://a.com/cloudide/api/v3/trae/GetUserInfo", { body: {} }), (e) => e.signIn === "expired")
  } finally { globalThis.fetch = real }
})
test("grantOf 读取真实回调的 userJwt 凭据布局", () => {
  const expires = Date.now() + 3600000
  const result = _.grantOf({ userJwt: JSON.stringify({ Token: "access", RefreshToken: "refresh", TokenExpireAt: expires, RefreshExpireAt: expires + 3600000, TokenExpireDuration: 3600000 }) })
  assert.deepEqual(result, { access: "access", refresh: "refresh", expires, refreshExpires: expires + 3600000, via: "sso" })
})
test("grantOf 拒绝损坏或不完整的回调，不把凭据带入错误", () => {
  for (const userJwt of [undefined, "{", "null", "[]", JSON.stringify({ Token: "secret-value", RefreshToken: "r" }), JSON.stringify({ Token: "t", RefreshToken: "", TokenExpireAt: 1 })]) {
    assert.throws(() => _.grantOf({ userJwt }), (e) => e.status === 502 && !e.message.includes("secret-value"))
  }
})
test("authAccount 识别旧版 traecli 绑定账号并要求重新登录", () => {
  assert.throws(() => _.authAccount({ traeHome: "/Users/x/.trae", access: "a", baseURL: "https://a.com" }), (e) => e.signIn === "expired")
  assert.throws(() => _.authAccount(null), (e) => e.signIn === "expired")
  const ok = _.authAccount({ access: "a", refresh: "r", baseURL: "https://a.com", expires: 1 })
  assert.equal(ok.base, "https://a.com")
})

// ---------------------------------------------------------------------------
// 登录装配
// ---------------------------------------------------------------------------
test("authorizationURL 复刻 traecli 的授权参数", () => {
  const url = new URL(_.authorizationURL(12345, "https://console.enterprise.trae.cn"))
  assert.equal(url.hostname, "console.enterprise.trae.cn")
  assert.equal(url.pathname, "/authorization")
  assert.equal(url.searchParams.get("auth_callback_url"), "http://127.0.0.1:12345/authorize")
  assert.equal(url.searchParams.get("client_id"), _.OAUTH_CLIENT_ID)
  assert.equal(url.searchParams.get("auth_from"), "traecli")
  assert.equal(url.searchParams.get("auth_type"), "local")
})
test("本地回调服务器收下 /authorize 查询参数后关闭", async () => {
  const server = await _.startCallbackServer(undefined, "https://login.invalid")
  try {
    const waiting = server.wait()
    const res = await fetch(`http://127.0.0.1:${server.port}/authorize?code=abc&state=s`)
    assert.equal(res.status, 200)
    await res.text()
    const params = await waiting
    assert.equal(params.code, "abc")
    assert.equal(params.state, "s")
  } finally { server.stop() }
})
test("importFromCli 校验部署一致性与凭据完整性", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trae-import-test-"))
  const realFetch = globalThis.fetch
  try {
    mkdirSync(join(dir, "cli"), { recursive: true })
    writeFileSync(join(dir, "cli", "auth.json"), JSON.stringify({ trae: {
      access_token: "A", refresh_token: "R", user_id: "1", user_email: "u@corp.test", expires_at: "2026-11-07T00:00:00.000Z",
      endpoints: { api_base_url: "https://a.com" },
    } }))
    globalThis.fetch = async () => jsonResponse({ code: 0, Data: { UserInfo: { UserID: "1", Account: "u@corp.test", Email: "u@corp.test" } } })
    const grant = await _.importFromCli({ baseURL: "https://a.com", traeHome: dir })
    assert.equal(typeof grant.callback, "function")
    const ok = await grant.callback()
    assert.equal(ok.type, "success")
    assert.equal(ok.access, "A")
    assert.equal(ok.refresh, "R")
    assert.equal(ok.accountId, "u@corp.test")
    assert.equal(ok.via, "cli-import")
    const mismatchGrant = await _.importFromCli({ baseURL: "https://other.com", traeHome: dir })
    const mismatch = await mismatchGrant.callback()
    assert.equal(mismatch.type, "failed")
  } finally {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test("SSO 使用部署返回的 LoginHost，浏览器由宿主打开", async () => {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => { calls.push(String(url)); return jsonResponse({ Result: { LoginHost: "login.enterprise.invalid" } }) }
  try {
    const grant = await _.authorizeSso({ baseURL: "https://deployment.invalid" })
    try {
      assert.equal(new URL(grant.url).hostname, "login.enterprise.invalid")
      assert.equal(grant.opened, undefined)
      assert.deepEqual(calls, ["https://deployment.invalid/cloudide/api/v3/trae/GetLoginGuidance"])
    } finally { grant.cancel?.() }
  } finally { globalThis.fetch = real }
})
test("SSO 缺少或返回非 HTTPS 登录引导时在登录阶段失败", async () => {
  const real = globalThis.fetch
  try {
    for (const response of [{}, { Result: { LoginHost: "http://login.invalid" } }]) {
      globalThis.fetch = async () => jsonResponse(response)
      const grant = await _.authorizeSso({ baseURL: "https://deployment.invalid" })
      if (grant.url) grant.cancel?.()
      assert.equal(grant.url, "")
      const result = await grant.callback()
      assert.equal(result.type, "failed")
      assert.ok(result.error.includes("登录"), result.error)
    }
  } finally { globalThis.fetch = real }
})
test("回调先于 wait 到达也能完成，不丢失本地或远程回填结果", async () => {
  const server = await _.startCallbackServer(undefined, "https://login.invalid")
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/authorize?code=early`)
    await res.text()
    const result = await Promise.race([server.wait(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("early callback lost")), 500); timer.unref?.() })])
    assert.equal(result.code, "early")
  } finally { server.stop() }
})
test("取消登录会结束等待并释放回调服务", async () => {
  const server = await _.startCallbackServer(undefined, "https://login.invalid")
  const waiting = server.wait()
  server.stop()
  await assert.rejects(Promise.race([waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("cancel hung")), 500))]), /取消/)
})
test("SSO 超时明确失败，callback 不永久挂起", async () => {
  const real = globalThis.fetch
  const timeout = _.loginTimeout
  globalThis.fetch = async () => jsonResponse({ Result: { LoginHost: "login.invalid" } })
  _.loginTimeout = 20
  let grant
  try {
    grant = await _.authorizeSso({ baseURL: "https://deployment.invalid" })
    const result = await Promise.race([grant.callback(), new Promise((_, reject) => setTimeout(() => reject(new Error("callback hung")), 500))])
    assert.equal(result.type, "failed")
    assert.match(result.error, /超时/)
  } finally { grant?.cancel?.(); globalThis.fetch = real; _.loginTimeout = timeout }
})

test("SSO 回调凭据经身份核验后产出宿主可保存的账号", async () => {
  const real = globalThis.fetch
  const localFetch = real
  const calls = []
  globalThis.fetch = async (url, init) => {
    const address = String(url)
    if (address.startsWith("http://127.0.0.1:")) return localFetch(url, init)
    calls.push(address)
    if (address.endsWith("GetLoginGuidance")) return jsonResponse({ Result: { LoginHost: "login.invalid" } })
    if (address.endsWith("GetUserInfo")) return jsonResponse(USER_INFO_FIXTURE)
    throw new Error("unexpected endpoint")
  }
  let grant
  try {
    grant = await _.authorizeSso({ baseURL: "https://deployment.invalid" })
    const callbackURL = new URL(grant.url).searchParams.get("auth_callback_url")
    const waiting = grant.callback()
    const userJwt = JSON.stringify({ Token: "new-access", RefreshToken: "new-refresh", TokenExpireAt: Date.now() + 3600000 })
    const response = await fetch(`${callbackURL}?${new URLSearchParams({ userJwt })}`)
    assert.equal(response.status, 200)
    await response.text()
    const account = await waiting
    assert.equal(account.type, "success")
    assert.equal(account.access, "new-access")
    assert.equal(account.refresh, "new-refresh")
    assert.equal(account.baseURL, "https://deployment.invalid")
    assert.equal(account.uid, "1")
    assert.equal(calls.length, 2)
  } finally { grant?.cancel?.(); globalThis.fetch = real }
})

// ---------------------------------------------------------------------------
// 插件装配面
// ---------------------------------------------------------------------------
test("默认导出提供 config/auth/provider/chat.headers 钩子", async () => {
  const plugin = await mod.default({})
  assert.equal(plugin.auth.provider, _.ID)
  assert.equal(plugin.auth.refreshLead, 2 * 3600 * 1000)
  assert.equal(plugin.provider.id, _.ID)
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(typeof plugin.auth.refresh, "function")
  assert.equal(typeof plugin.auth.usage, "function")
  const labels = plugin.auth.methods.map((m) => m.label)
  assert.ok(labels.some((l) => l.includes("浏览器 SSO")))
  assert.ok(labels.some((l) => l.includes("导入")))
})

test("无效部署覆盖项在两种登录入口提前报错", async () => {
  for (const [key, value] of [["TRAE_PRIVATE_APP_ID", ""], ["TRAE_PRIVATE_CONTEXT", "-1"], ["TRAE_PRIVATE_BODY_BUDGET", "invalid"]]) {
    process.env[key] = value
    try {
      for (const authorize of [_.authorizeSso, _.importFromCli]) {
        const grant = await authorize({ baseURL: "https://login.invalid" })
        if (grant.url) grant.cancel?.()
        assert.equal(grant.url, "")
        const result = await grant.callback()
        assert.equal(result.type, "failed")
        assert.ok(result.error.includes(key), result.error)
      }
    } finally { delete process.env[key] }
  }
})
test("loader 端到端支持 stream 缺省、false、true 及 done 内嵌用量", async () => {
  const real = globalThis.fetch
  const auth = { baseURL: "https://chat.invalid", access: "chat-token", refresh: "refresh", uid: "1", expires: Date.now() + 3600000 }
  const chatCalls = []
  globalThis.fetch = async (url, init) => {
    assert.equal(init.redirect, "error")
    if (String(url).endsWith("get_config_list")) return jsonResponse(CONFIG_LIST_FIXTURE)
    assert.ok(String(url).endsWith("llm_raw_chat"))
    chatCalls.push(JSON.parse(init.body))
    return new Response('event: output\ndata: {"response":"你好"}\n\nevent: done\ndata: {"finish_reason":"stop","usage":{"prompt_tokens":3,"completion_tokens":5}}\n\n', { headers: { "content-type": "text/event-stream" } })
  }
  try {
    const plugin = await mod.default({})
    const loader = await plugin.auth.loader(async () => auth)
    for (const stream of [undefined, false, true]) {
      const response = await loader.fetch("https://unconnected.invalid/v1/chat/completions", { body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }], stream }) })
      assert.equal(response.status, 200)
      if (stream === true) {
        const text = await response.text()
        assert.ok(text.includes("你好"))
        assert.ok(text.includes('"total_tokens":8'))
        assert.ok(text.includes("[DONE]"))
      } else {
        const body = await response.json()
        assert.equal(body.choices[0].message.content, "你好")
        assert.equal(body.usage.total_tokens, 8)
      }
    }
    assert.equal(chatCalls.length, 3)
    assert.ok(chatCalls.every((body) => body.model_name === "glm-5.3__v2"))
  } finally { globalThis.fetch = real }
})
test("过期令牌在读取目录或聊天前拒绝", async () => {
  const real = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; return jsonResponse(CONFIG_LIST_FIXTURE) }
  try {
    const plugin = await mod.default({})
    const loader = await plugin.auth.loader(async () => ({ baseURL: "https://past.invalid", access: "t", refresh: "r", expires: 1 }))
    const response = await loader.fetch("https://unconnected.invalid/v1/chat/completions", { body: "{}" })
    assert.equal(response.status, 401)
    assert.equal(response.headers.get("X-Magpie-Sign-In"), "expired")
    assert.equal(calls, 0)
  } finally { globalThis.fetch = real }
})
test("续期钩子返回完整轮换凭据并保留账号身份", async () => {
  const real = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({ Data: { Token: "new-access", RefreshToken: "new-refresh", TokenExpireAt: Date.now() + 3600000 } })
  try {
    const plugin = await mod.default({})
    const auth = { baseURL: "https://refresh.invalid", access: "old-access", refresh: "old-refresh", uid: "7", accountId: "member", webSession: "legacy", traeHome: "/unused" }
    const updated = await plugin.auth.refresh(auth)
    assert.equal(updated.access, "new-access")
    assert.equal(updated.refresh, "new-refresh")
    assert.equal(updated.uid, "7")
    assert.equal(updated.accountId, "member")
    assert.equal(updated.webSession, undefined)
    assert.equal(updated.traeHome, undefined)
  } finally { globalThis.fetch = real }
})
test("config 与账号模型钩子在目录故障后保留同身份列表", async () => {
  const real = globalThis.fetch
  const now = Date.now
  let clock = now()
  try {
    Date.now = () => clock
    globalThis.fetch = async () => jsonResponse(CONFIG_LIST_FIXTURE)
    const plugin = await mod.default({})
    const cfg = {}
    await plugin.config(cfg)
    assert.ok(cfg.provider[_.ID])
    const auth = { baseURL: "https://provider.invalid", access: "t", refresh: "r" }
    const good = await plugin.provider.models({}, { auth })
    clock += 120000
    globalThis.fetch = async () => { throw new Error("offline") }
    await plugin.config(cfg)
    assert.ok(cfg.provider[_.ID])
    assert.deepEqual(await plugin.provider.models({}, { auth }), good)
  } finally { globalThis.fetch = real; Date.now = now }
})
test("隔离层拒绝沙盒外文件、外网和子进程", async () => {
  const fs = await import("node:fs")
  const cp = await import("node:child_process")
  assert.throws(() => fs.readFileSync(join(root, "package.json")), /Test isolation/)
  assert.throws(() => fs.writeFileSync(join(root, "must-not-exist"), "bad"), /Test isolation/)
  assert.throws(() => cp.spawn("must-not-run", []), /Test isolation/)
  await assert.rejects(() => fetch("https://network.invalid"), /Test isolation/)
})

const QUOTA_ERROR = { code: 4222, error: "biz error: rpc error: code = ErrAllModelUserQuotaExceeded desc = , origin err = entitlement check failed", message: "", extra: null }
test("真实额度拒绝帧在流式和非流式请求中返回 429 并保留登录", async () => {
  const real = globalThis.fetch
  globalThis.fetch = async (url) => String(url).endsWith("get_config_list")
    ? jsonResponse(CONFIG_LIST_FIXTURE)
    : new Response(`event: error\ndata: ${JSON.stringify(QUOTA_ERROR)}\n\n`, { headers: { "content-type": "text/event-stream" } })
  try {
    const plugin = await mod.default({})
    const loader = await plugin.auth.loader(async () => ({ baseURL: "https://quota.invalid", access: "a", refresh: "r", expires: Date.now() + 3600000 }))
    for (const stream of [undefined, false, true]) {
      const response = await loader.fetch("https://unconnected.invalid/v1/chat/completions", { body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }], stream }) })
      assert.equal(response.status, 429)
      assert.equal(response.headers.get("X-Magpie-Sign-In"), "kept")
      assert.deepEqual((await response.json()).error, { message: "TRAE 模型额度已用尽", type: "insufficient_quota", code: "ErrAllModelUserQuotaExceeded" })
    }
  } finally { globalThis.fetch = real }
})
test("响应中途出现额度错误时不伪造成功结束", async () => {
  const first = { event: "output", data: { response: "partial" } }
  async function* remaining() { yield { event: "error", data: QUOTA_ERROR } }
  const all = await _.collect(first, remaining())
  assert.equal(all.errorStatus, 429)
  assert.equal(all.errorCode, "ErrAllModelUserQuotaExceeded")
  assert.equal(all.errorSignIn, "kept")
  const response = _.streamResponse("model", first, remaining())
  const text = await response.text()
  assert.ok(text.includes('"type":"insufficient_quota"'))
  assert.ok(text.includes('"code":"ErrAllModelUserQuotaExceeded"'))
  assert.ok(!text.includes('"finish_reason":"stop"'))
})

// ---------------------------------------------------------------------------
let failed = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    passed++
    console.log(`ok - ${name}`)
  } catch (error) {
    failed++
    console.error(`not ok - ${name}\n${error.stack}`)
  }
}
console.log(`\n${passed}/${cases.length} passed`)
if (failed) process.exitCode = 1
