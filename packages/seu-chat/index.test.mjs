import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { BASE, ID, cookiesOf, createPlugin, estimateTokens } from "./index.mjs"
import { MAX_PROMPT, ORIGIN } from "./seu.mjs"
import { fakeSeu } from "./testdata/fakeseu.mjs"

const COOKIES = { SESSION: "abc" }
const TMP = "testdata/local"

// 一个 createPlugin 的小工厂：假服务器 + 假浏览器 + 固定 id
function makePlugin({ options, browser, client, fake: fakeOpts } = {}) {
  const fake = fakeSeu(fakeOpts)
  const sets = []
  const theClient = client ?? { auth: { set: async (arg) => sets.push(arg) }, app: { log: async () => {} }, tui: { showToast: async () => {} } }
  const plugin = createPlugin({
    client: theClient,
    fetchImpl: fake.fetch,
    newId: () => "call_1",
    browser: browser ?? { profileRoot: () => TMP, signIn: async () => COOKIES, renew: async () => null },
    options,
  })
  return { plugin, fake, sets }
}

const loaderOf = async (plugin) => plugin.auth.loader(async () => ({ type: "oauth", access: JSON.stringify({ cookies: COOKIES }), refresh: "p", accountId: "21321xxxx" }))

async function readBody(res) {
  return await res.text()
}

test("config 注册供应商和两个文本模型，带 tool_call", async () => {
  const { plugin } = makePlugin()
  const cfg = { provider: {} }
  await plugin.config(cfg)
  const p = cfg.provider[ID]
  assert.equal(p.name, "东大 ChatSEU")
  assert.equal(p.npm, "@ai-sdk/openai-compatible")
  assert.equal(p.api, BASE)
  assert.deepEqual(p.models["glm-5.3-flash"], {
    name: "GLM5.3-Flash",
    limit: { context: 200000, output: 8192 },
    tool_call: true,
    reasoning: true,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
  })
  assert.equal(p.models["qwen3.8-flash-next"].name, "Qwen3.8-Flash-Next")
})

test("provider.models 给 magpie 形状的模型表：只收文本，且明确说了", async () => {
  const { plugin } = makePlugin()
  const list = await plugin.provider.models()
  const m = list["glm-5.3-flash"]
  assert.equal(m.id, "glm-5.3-flash")
  assert.equal(m.context, 200000)
  assert.equal(m.output, 8192)
  assert.deepEqual(m.inputs, ["text"])
  assert.deepEqual(m.outputs, ["text"])
  assert.equal(m.image, false)
  assert.equal(m.imageSaid, true)
  assert.equal(m.inputsSaid, true)
  assert.equal(m.outputsSaid, true)
})

test("config hook 仍给 OpenCode 形状（limit/modalities），OpenCode 靠它", async () => {
  const { plugin } = makePlugin()
  const cfg = { provider: {} }
  await plugin.config(cfg)
  const m = cfg.provider[ID].models["glm-5.3-flash"]
  assert.equal(m.limit.context, 200000)
  assert.deepEqual(m.modalities.input, ["text"])
  assert.equal(m.tool_call, true)
})

test("provider.models 列出同样的表", async () => {
  const { plugin } = makePlugin()
  const table = await plugin.provider.models({}, { auth: { access: JSON.stringify({ cookies: COOKIES }) } })
  assert.equal(table["glm-5.3-flash"].code, undefined)
  assert.equal(table["glm-5.3-flash"].name, "GLM5.3-Flash")
  assert.equal(Object.keys(table).length, 2)
})

test("fetch 只接 POST …/chat/completions", async () => {
  const { plugin } = makePlugin()
  const loader = await loaderOf(plugin)
  const get = await loader.fetch(BASE + "/chat/completions", { method: "GET" })
  assert.equal(get.status, 404)
  const other = await loader.fetch("https://example.com/v1/chat/completions", { method: "POST", body: "{}" })
  assert.equal(other.status, 404)
})

test("插件流式返回一个 chat completion", async () => {
  const { plugin, fake } = makePlugin()
  const loader = await loaderOf(plugin)
  const res = await loader.fetch(BASE + "/chat/completions", {
    method: "POST",
    headers: {},
    body: JSON.stringify({ model: "seu-chat/glm-5.3-flash", messages: [{ role: "user", content: "你好" }], stream: true }),
  })
  assert.equal(res.status, 200)
  const text = await readBody(res)
  assert.equal(text.endsWith("data: [DONE]\n\n"), true)
  const chunks = text.split("\n\n").filter((x) => x.startsWith("data: ") && !x.includes("[DONE]")).map((x) => JSON.parse(x.slice(6)))
  const deltas = chunks.filter((c) => c.choices?.[0]?.delta)
  assert.deepEqual(deltas[0].choices[0].delta, { role: "assistant", content: "" })
  const content = deltas.map((c) => c.choices[0].delta.content ?? "").join("")
  assert.equal(content, "Hello\nworld again")
  assert.equal(deltas.at(-1).choices[0].finish_reason, "stop")
  const usage = chunks.find((c) => c.usage)
  assert.ok(usage.usage.prompt_tokens > 0)
  // 发给 ChatSEU 的请求体：modelCode 4，prompt 带 [user] 标
  assert.equal(JSON.parse(fake.calls[0].body).modelCode, 4)
  assert.ok(JSON.parse(fake.calls[0].body).content.includes("[user]\n你好"))
})

test("非流式返回整段 completion", async () => {
  const { plugin } = makePlugin()
  const loader = await loaderOf(plugin)
  const res = await loader.fetch(BASE + "/chat/completions", {
    method: "POST",
    headers: {},
    body: JSON.stringify({ model: "seu-chat/glm-5.3-flash", messages: [{ role: "user", content: "你好" }] }),
  })
  const out = await res.json()
  assert.equal(out.choices[0].message.content, "Hello\nworld again")
  assert.equal(out.choices[0].message.reasoning_content, "Let me think\nhard")
  assert.equal(out.choices[0].finish_reason, "stop")
})

test("工具调用：GLM 写成 ask_question({...}) 且无闭合标签时，流式和非流式都回成 tool_calls（线上事故回归）", async () => {
  const FN = readFileSync(new URL("./testdata/tool-fncall.sse", import.meta.url), "utf8")
  const fake = fakeSeu({ stream: new Response(FN, { status: 200, headers: { "content-type": "text/event-stream" } }) })
  const plugin = createPlugin({
    client: { auth: { set: async () => {} }, app: { log: async () => {} } },
    fetchImpl: fake.fetch,
    newId: () => "call_fn",
    browser: { profileRoot: () => TMP, signIn: async () => COOKIES, renew: async () => null },
  })
  const loader = await plugin.auth.loader(async () => ({ type: "oauth", access: JSON.stringify({ cookies: COOKIES }), refresh: "p", accountId: "u" }))
  const body = { model: "seu-chat/glm-5.3-flash", messages: [{ role: "user", content: "问用户三件事" }], stream: true, tools: [{ type: "function", function: { name: "ask_question", parameters: { type: "object" } } }] }
  const res = await loader.fetch(BASE + "/chat/completions", { method: "POST", headers: {}, body: JSON.stringify(body) })
  const text = await readBody(res)
  const chunks = text.split("\n\n").filter((x) => x.startsWith("data: ") && !x.includes("[DONE]")).map((x) => JSON.parse(x.slice(6)))
  const calls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
  assert.equal(calls[0].function.name, "ask_question")
  const args = calls.map((c) => c.function.arguments).join("")
  assert.deepEqual(JSON.parse(args).questions[0].id, "repo")
  assert.ok(chunks.some((c) => c.choices?.[0]?.finish_reason === "tool_calls"))
  // 调用之外的文字仍然给用户看，不是整段吞掉
  const shown = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("")
  assert.ok(shown.includes("再等几分钟就能确认"))
  assert.ok(!shown.includes("ask_question("))
  // 非流式
  const res2 = await loader.fetch(BASE + "/chat/completions", { method: "POST", headers: {}, body: JSON.stringify({ ...body, stream: false }) })
  const out = await res2.json()
  assert.equal(out.choices[0].finish_reason, "tool_calls")
  assert.equal(out.choices[0].message.tool_calls[0].function.name, "ask_question")
})

test("工具调用：<tool_call> 文本回成 tool_calls", async () => {
  const TOOL = readFileSync(new URL("./testdata/tool.sse", import.meta.url), "utf8")
  const { plugin } = makePlugin()
  // 让假服务器的流回 tool.sse
  const raw = plugin.auth.loader
  const loader = await loaderOf(plugin)
  // 直接替换 fetchImpl 太绕：重新造一个插件，fetchImpl 里把 GET 流换成 tool.sse
  const fake = fakeSeu({ stream: new Response(TOOL, { status: 200, headers: { "content-type": "text/event-stream" } }) })
  const plugin2 = createPlugin({
    client: { auth: { set: async () => {} }, app: { log: async () => {} } },
    fetchImpl: fake.fetch,
    newId: () => "call_9",
    browser: { profileRoot: () => TMP, signIn: async () => COOKIES, renew: async () => null },
  })
  const loader2 = await plugin2.auth.loader(async () => ({ type: "oauth", access: JSON.stringify({ cookies: COOKIES }), refresh: "p", accountId: "u" }))
  const body = { model: "seu-chat/glm-5.3-flash", messages: [{ role: "user", content: "读一下 a.txt" }], stream: true, tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }] }
  const res = await loader2.fetch(BASE + "/chat/completions", { method: "POST", headers: {}, body: JSON.stringify(body) })
  const text = await readBody(res)
  const chunks = text.split("\n\n").filter((x) => x.startsWith("data: ") && !x.includes("[DONE]")).map((x) => JSON.parse(x.slice(6)))
  const calls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
  assert.equal(calls[0].function.name, "read")
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: "a.txt" })
  assert.ok(chunks.some((c) => c.choices?.[0]?.finish_reason === "tool_calls"))
  // 非流式
  const res2 = await loader2.fetch(BASE + "/chat/completions", { method: "POST", headers: {}, body: JSON.stringify({ ...body, stream: false }) })
  const out = await res2.json()
  assert.equal(out.choices[0].finish_reason, "tool_calls")
  assert.match(out.choices[0].message.tool_calls[0].id, /^call_/)
  void raw
})

test("裸 JSON 工具调用（ChatSEU 的真实形状）也回成 tool_calls", async () => {
  const RAW = 'event: metadata\nid: c1\ndata: {"rounds":1}\n\ndata: {"name": "read", "arguments": {"path": "a.txt"}}\n\ndata: [DONE]\n'
  const fake = fakeSeu({ stream: new Response(RAW, { status: 200, headers: { "content-type": "text/event-stream" } }) })
  const plugin = createPlugin({
    client: { auth: { set: async () => {} }, app: { log: async () => {} } },
    fetchImpl: fake.fetch,
    newId: () => "call_1",
    browser: { profileRoot: () => TMP, signIn: async () => COOKIES, renew: async () => null },
  })
  const loader = await plugin.auth.loader(async () => ({ type: "oauth", access: JSON.stringify({ cookies: COOKIES }), refresh: "p", accountId: "u" }))
  const body = { model: "glm-5.3-flash", messages: [{ role: "user", content: "读一下" }], tools: [{ type: "function", function: { name: "read", parameters: {} } }] }
  const res = await loader.fetch(BASE + "/chat/completions", { method: "POST", headers: {}, body: JSON.stringify(body) })
  const out = await res.json()
  assert.equal(out.choices[0].finish_reason, "tool_calls")
  assert.equal(out.choices[0].message.tool_calls[0].function.name, "read")
})

test("qwen 模型发 code 3；options.models 可增补", async () => {
  const { plugin, fake } = makePlugin({ options: { models: [{ id: "x", name: "X", code: 9 }] } })
  const loader = await loaderOf(plugin)
  await loader.fetch(BASE + "/chat/completions", { method: "POST", headers: {}, body: JSON.stringify({ model: "qwen3.8-flash-next", messages: [{ role: "user", content: "hi" }] }) })
  assert.equal(JSON.parse(fake.calls[0].body).modelCode, 3)
  await loader.fetch(BASE + "/chat/completions", { method: "POST", headers: {}, body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }) })
  assert.equal(JSON.parse(fake.calls[3].body).modelCode, 9)
})

test("没有的模型是 404", async () => {
  const { plugin } = makePlugin()
  const loader = await loaderOf(plugin)
  const res = await loader.fetch(BASE + "/chat/completions", { method: "POST", headers: {}, body: JSON.stringify({ model: "nope", messages: [] }) })
  assert.equal(res.status, 404)
  const out = await res.json()
  assert.equal(out.error.type, "model_not_found")
  assert.ok(out.error.message.includes("glm-5.3-flash"))
})

test("超过 MAX_PROMPT 的请求是 413，fake 没收到请求", async () => {
  const { plugin, fake } = makePlugin()
  const loader = await loaderOf(plugin)
  const res = await loader.fetch(BASE + "/chat/completions", { method: "POST", headers: {}, body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "x".repeat(MAX_PROMPT + 1) }] }) })
  assert.equal(res.status, 413)
  assert.equal(fake.calls.length, 0)
})

test("登录失效且续期失败：fetch 抛 signIn expired", async () => {
  const fake = fakeSeu({ post: new Response(JSON.stringify({ status: 302, message: "请重新登录" }), { status: 302 }) })
  const plugin = createPlugin({
    client: { auth: { set: async () => {} }, app: { log: async () => {} } },
    fetchImpl: fake.fetch,
    newId: () => "call_1",
    browser: { profileRoot: () => TMP, signIn: async () => COOKIES, renew: async () => null },
  })
  const loader = await plugin.auth.loader(async () => ({ type: "oauth", access: JSON.stringify({ cookies: COOKIES }), refresh: "profile-x", accountId: "u" }))
  await assert.rejects(
    loader.fetch(BASE + "/chat/completions", { method: "POST", headers: {}, body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] }) }),
    (e) => e.signIn === "expired",
  )
})

test("封号 40301 → 403 JSON；code≠0 → 502 JSON 以 ChatSEU：开头", async () => {
  const loader1 = await loaderOf(makePlugin({}).plugin)
  // 封号
  const blocked = fakeSeu({ post: { code: 40301, message: "x" } })
  const p1 = createPlugin({ client: { auth: { set: async () => {} }, app: { log: async () => {} } }, fetchImpl: blocked.fetch, browser: { profileRoot: () => TMP, signIn: async () => COOKIES, renew: async () => null } })
  const l1 = await p1.auth.loader(async () => ({ type: "oauth", access: JSON.stringify({ cookies: COOKIES }), refresh: "", accountId: "u" }))
  const r1 = await l1.fetch(BASE + "/chat/completions", { method: "POST", headers: {}, body: JSON.stringify({ model: "glm-5.3-flash", messages: [] }) })
  assert.equal(r1.status, 403)
  assert.equal((await r1.json()).error.type, "seu_blocked")
  void loader1
  // 业务失败
  const busy = fakeSeu({ post: { code: 500, message: "模型繁忙" } })
  const p2 = createPlugin({ client: { auth: { set: async () => {} }, app: { log: async () => {} } }, fetchImpl: busy.fetch, browser: { profileRoot: () => TMP, signIn: async () => COOKIES, renew: async () => null } })
  const l2 = await p2.auth.loader(async () => ({ type: "oauth", access: JSON.stringify({ cookies: COOKIES }), refresh: "", accountId: "u" }))
  const r2 = await l2.fetch(BASE + "/chat/completions", { method: "POST", headers: {}, body: JSON.stringify({ model: "glm-5.3-flash", messages: [] }) })
  assert.equal(r2.status, 502)
  assert.match((await r2.json()).error.message, /^ChatSEU：模型繁忙/)
})

test("回复里的 Set-Cookie 写回账号", async () => {
  const sets = []
  const base = fakeSeu()
  const fake = {
    fetch: async (url, init) => {
      const res = await base.fetch(url, init)
      if (new URL(String(url)).searchParams.get("messageId"))
        return new Response(await res.clone().text(), { status: res.status, headers: [...res.headers, ["set-cookie", "JSESSIONID=zz9; Path=/"]] })
      return res
    },
  }
  const plugin = createPlugin({
    client: { auth: { set: async (arg) => sets.push(arg) }, app: { log: async () => {} } },
    fetchImpl: fake.fetch,
    newId: () => "call_1",
    browser: { profileRoot: () => TMP, signIn: async () => COOKIES, renew: async () => null },
  })
  const loader = await plugin.auth.loader(async () => ({ type: "oauth", access: JSON.stringify({ cookies: COOKIES }), refresh: "p", accountId: "21321xxxx", name: "张三", expires: 0 }))
  await loader.fetch(BASE + "/chat/completions", { method: "POST", headers: {}, body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] }) })
  const arg = sets.at(-1)
  assert.equal(arg.path.id, ID)
  const access = JSON.parse(arg.body.access)
  assert.equal(access.cookies.JSESSIONID, "zz9")
  assert.equal(arg.body.accountId, "21321xxxx")
})

test("两种登录方式", async () => {
  const { plugin } = makePlugin()
  const methods = plugin.auth.methods
  assert.equal(methods[0].type, "oauth")
  const started = await methods[0].authorize()
  assert.equal(started.method, "auto")
  assert.equal(started.url, "")
  const r = await started.callback()
  assert.equal(r.type, "success")
  assert.equal(r.accountId, "21321xxxx")
  assert.equal(r.name, "张三")
  assert.deepEqual(JSON.parse(r.access).cookies, COOKIES)
  assert.ok(r.refresh.includes("local"))
  // 登录结果带 25 分钟后的 expires：magpie 的保活据此在到期前调用 auth.refresh
  assert.ok(r.expires > Date.now() + 20 * 60_000 && r.expires <= Date.now() + 25 * 60_000 + 5000)

  // 粘贴 Cookie：也是 oauth 形状（能被保活），没有 profile
  assert.equal(methods[1].type, "oauth")
  const paste = await methods[1].authorize({ cookie: "Cookie: SESSION=zzz" })
  assert.equal(paste.method, "auto")
  const ok = await paste.callback()
  assert.equal(ok.type, "success")
  assert.ok(JSON.parse(ok.access).cookies.SESSION === "zzz")
  assert.equal(ok.refresh, "")
  assert.equal(ok.accountId, "21321xxxx")
  const badP = await methods[1].authorize({ cookie: "" })
  assert.equal((await badP.callback()).type, "failed")
})

test("auth.refresh：用存的 cookie 碰一次 userInfo，expires 续 25 分钟，站点续的 cookie 存回", async () => {
  const { plugin, fake, sets } = makePlugin()
  const before = Date.now()
  const got = await plugin.auth.refresh({ type: "oauth", access: JSON.stringify({ cookies: COOKIES }), refresh: "p", expires: before, accountId: "u" })
  assert.deepEqual(fake.calls.map((c) => c.path), ["/api/cas/userInfo"])
  assert.match(fake.calls[0].headers.cookie, /SESSION=abc/)
  // 上界留 5 秒余量：refresh 里的 Date.now() 比 before 晚几毫秒
  assert.ok(got.expires > before + 20 * 60_000 && got.expires <= before + 25 * 60_000 + 5000)
  assert.deepEqual(JSON.parse(got.access).cookies, COOKIES)
  assert.equal(typeof plugin.auth.refresh, "function")
  assert.notEqual(plugin.auth.keepAlive, false) // 默认开启后台保活
  void sets
})

test("auth.refresh：站点已不认（302）→ 抛 signIn expired，magpie 据此标记账号", async () => {
  const expired = fakeSeu({ user: new Response(JSON.stringify({ status: 302, message: "请重新登录" }), { status: 302 }) })
  const plugin = createPlugin({ client: { auth: { set: async () => {} }, app: { log: async () => {} } }, fetchImpl: expired.fetch, browser: { profileRoot: () => TMP, signIn: async () => COOKIES, renew: async () => null } })
  await assert.rejects(plugin.auth.refresh({ type: "oauth", access: JSON.stringify({ cookies: COOKIES }), expires: Date.now(), accountId: "u" }), (e) => e.signIn === true)
})

test("auth.refresh：网络故障等普通错误不会被当成登录失效", async () => {
  const plugin = createPlugin({ client: { auth: { set: async () => {} }, app: { log: async () => {} } }, fetchImpl: async () => { throw new TypeError("fetch failed") }, browser: { profileRoot: () => TMP, signIn: async () => COOKIES, renew: async () => null } })
  await assert.rejects(plugin.auth.refresh({ type: "oauth", access: JSON.stringify({ cookies: COOKIES }), expires: Date.now(), accountId: "u" }), (e) => !e.signIn && e.name === "TypeError")
})

test("登录窗口没完成 → failed 带中文提示", async () => {
  const { plugin } = makePlugin({ browser: { profileRoot: () => TMP, signIn: async () => null, renew: async () => null } })
  const started = await plugin.auth.methods[0].authorize()
  const r = await started.callback()
  assert.equal(r.type, "failed")
  assert.match(r.error, /五分钟内没有/)
})

test("包的默认导出是插件函数", async () => {
  const mod = await import("./opencode.mjs")
  assert.equal(typeof mod.default, "function")
  const hooks = await mod.default({ client: { auth: { set: async () => {} }, app: { log: async () => {} } } })
  assert.equal(hooks.auth.provider, ID)
})

test("写回 cookie 时不带 expires：不覆盖 magpie 已经续过的到期时间", async () => {
  // 站点在回复里续了 cookie → 插件把新的 cookie 写回账号
  const { plugin, sets } = makePlugin({ fake: { setCookieOnPost: "JSESSIONID=zz9; Path=/" } })
  const loader = await plugin.auth.loader(async () => ({
    type: "oauth",
    access: JSON.stringify({ cookies: COOKIES }),
    refresh: "p",
    expires: Date.now() + 25 * 60_000, // 建会话时快照里的旧值
    accountId: "u",
  }))
  await loader.fetch(BASE + "/chat/completions", {
    method: "POST",
    headers: {},
    body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] }),
  })
  const written = sets.at(-1)
  assert.ok(written, "应该写回了一次账号")
  assert.equal("expires" in written.body, false, "写回时不能带 expires")
})

test("登录被拒时不尝试无窗口续期，直接把账号标记为要重新登录", async () => {
  let renewed = false
  const fake = fakeSeu({ post: new Response(JSON.stringify({ status: 302, message: "请重新登录" }), { status: 302 }) })
  const plugin = createPlugin({
    client: { auth: { set: async () => {} }, app: { log: async () => {} } },
    fetchImpl: fake.fetch,
    newId: () => "call_1",
    browser: { profileRoot: () => TMP, signIn: async () => COOKIES, renew: async () => { renewed = true; return COOKIES } },
  })
  const loader = await plugin.auth.loader(async () => ({ type: "oauth", access: JSON.stringify({ cookies: COOKIES }), refresh: "profile-x", accountId: "u" }))
  // 站点答 302 → 不再试无窗口续期（实测 CAS 票据关窗即清），直接 signIn: "expired"
  await assert.rejects(
    loader.fetch(BASE + "/chat/completions", { method: "POST", headers: {}, body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] }) }),
    (e) => e.signIn === "expired",
  )
  assert.equal(renewed, false, "不该再试无窗口续期")
})

test("cookiesOf 读两种账号形状", () => {
  assert.deepEqual(cookiesOf({ type: "oauth", access: JSON.stringify({ cookies: COOKIES }) }), COOKIES)
  // 旧版本存过的 api 形状也认
  assert.deepEqual(cookiesOf({ type: "api", key: JSON.stringify({ cookies: COOKIES }) }), COOKIES)
  assert.equal(cookiesOf({ type: "api", key: "not json" }), null)
  void ORIGIN
})

test("站点回空回复（实测：超过约 90 万字符时）→ 413 prompt is too long，而不是 200 空内容", async () => {
  const EMPTY = ["event: metadata", "id: c-empty", 'data: {"rounds":1}', "", "data: [DONE]", "", ""].join("\n")
  const fake = fakeSeu({ stream: () => new Response(EMPTY, { status: 200, headers: { "content-type": "text/event-stream" } }) })
  const plugin = createPlugin({
    client: { auth: { set: async () => {} }, app: { log: async () => {} } },
    fetchImpl: fake.fetch,
    newId: () => "call_1",
    browser: { profileRoot: () => TMP, signIn: async () => COOKIES, renew: async () => null },
  })
  const loader = await plugin.auth.loader(async () => ({ type: "oauth", access: JSON.stringify({ cookies: COOKIES }), refresh: "", accountId: "u" }))
  // 非流式
  const r = await loader.fetch(BASE + "/chat/completions", { method: "POST", headers: {}, body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] }) })
  assert.equal(r.status, 413)
  const out = await r.json()
  assert.equal(out.error.type, "context_length_exceeded")
  assert.match(out.error.message, /too long/)
  // 流式：也要在开流前就报 HTTP 错误
  const r2 = await loader.fetch(BASE + "/chat/completions", { method: "POST", headers: {}, body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }], stream: true }) })
  assert.equal(r2.status, 413)
})

test("站点回了 reasoning 但没有 text：流式返回 502 错误，不是 200 完整回复", async () => {
  const sseBody = 'event: metadata\nid: c9\ndata: {"rounds":1}\n\ndata: <思考内容>让我想想</思考内容>\n\ndata: [DONE]\n\n'
  const fetchImpl = async (url) =>
    String(url).includes("messageId=")
      ? new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } })
      : new Response(JSON.stringify({ code: 0, response: "m1" }), { status: 200, headers: { "content-type": "application/json" } })
  const p = createPlugin({ client: null, fetchImpl, newId: () => "call_x" })
  const loader = await p.auth.loader(async () => ({ type: "oauth", access: JSON.stringify({ cookies: { S: "1" } }) }))
  const res = await loader.fetch("https://seu-chat.invalid/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "glm-5.3-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(res.status, 502)
  const j = await res.json()
  assert.equal(j.error.type, "seu_empty_reply")
  assert.match(j.error.message, /思考/)
})

test("estimateTokens：CJK 每字 1，其余每 4 字符 1", () => {
  assert.equal(estimateTokens("中文测试".repeat(1000)), 4000)
  assert.equal(estimateTokens("a".repeat(400)), 100)
  assert.equal(estimateTokens("中a中a"), 2 + 1)
})

test("usage.prompt_tokens 用 estimateTokens 而不是 length/3", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("messageId=")) {
      const body = 'event: metadata\nid: c1\ndata: {"rounds":1}\n\ndata: 收到\n\ndata: [DONE]\n\n'
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    return new Response(JSON.stringify({ code: 0, response: "m1" }), { status: 200, headers: { "content-type": "application/json" } })
  }
  const p = createPlugin({ client: null, fetchImpl, newId: () => "c" })
  const loader = await p.auth.loader(async () => ({ type: "oauth", access: JSON.stringify({ cookies: { S: "1" } }) }))
  const res = await loader.fetch("https://seu-chat.invalid/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "中".repeat(3000) }] }),
  })
  const j = await res.json()
  assert.ok(j.usage.prompt_tokens > 2000, "中文 3000 字不应被报成 1000 token")
})

test("空工具名：参数唯一匹配声明工具的 schema 就补名抬升；多匹配则 502（2026-11-28 真机）", async () => {
  // glm-5.3-flash 长提示下写出 {"name": "", "arguments": {"path": "D:/桌面/novel"}}
  const sseBody = 'event: metadata\nid: c1\ndata: {"rounds":1}\n\ndata: {"name": "", "arguments": {"path": "D:/桌面/novel"}}\n\ndata: [DONE]\n\n'
  const fetchImpl = async (url) =>
    String(url).includes("messageId=")
      ? new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } })
      : new Response(JSON.stringify({ code: 0, response: "m1" }), { status: 200, headers: { "content-type": "application/json" } })
  const p = createPlugin({ client: null, fetchImpl, newId: () => "call_x" })
  const loader = await p.auth.loader(async () => ({ type: "oauth", access: JSON.stringify({ cookies: { S: "1" } }) }))
  const call = (tools) =>
    loader.fetch("https://seu-chat.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "看看目录" }], tools }) })
  const A = await (
    await call([
      { type: "function", function: { name: "list_dir", parameters: { type: "object", properties: { path: { type: "string" } } } } },
      { type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } },
    ])
  ).json()
  assert.equal(A.choices[0].finish_reason, "tool_calls")
  assert.equal(A.choices[0].message.tool_calls[0].function.name, "list_dir")
  const B = await call([
    { type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } },
    { type: "function", function: { name: "list_dir", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  ])
  assert.equal(B.status, 502)
  assert.equal((await B.json()).error.type, "seu_unreadable_call")
})
