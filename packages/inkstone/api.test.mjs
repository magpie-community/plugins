// The API-key side: the catalogue it reads, the models magpie lists for the
// account, the loader, and the sign-in methods. Everything runs against the
// local fake.
import "./nonet.mjs"
import { readFileSync } from "node:fs"
import { afterEach, expect, test } from "bun:test"
import { InkStoneAuthPlugin } from "./index.mjs"
import { fakeInkStone, json, ok } from "./fake.mjs"

let f
afterEach(() => f?.close())

const META = JSON.parse(readFileSync(new URL("./testdata/public-models.json", import.meta.url), "utf8"))
const auth = { type: "oauth", access: "sk-test", apiKey: "sk-test", uaaToken: "uaa-token" }

async function plugin(options) {
  return InkStoneAuthPlugin({ client: { auth: { set: async () => {} } } }, options)
}

function serve(live = [{ id: "glm-5.3" }, { id: "Agents-A1" }, { id: "intern-decision-4b" }]) {
  f.route("GET /v1/models", (r) => {
    expect(r.headers.get("authorization")).toBe("Bearer sk-test")
    return json({ object: "list", data: live })
  })
  f.route("GET /api/tokenplan/v1/public/models", () => json(META))
}

test("config declares the provider with a working npm, base URL and bootstrap models", async () => {
  f = fakeInkStone()
  const p = await plugin()
  const cfg = {}
  await p.config(cfg)
  const provider = cfg.provider["intern-inkstone"]
  expect(provider.name).toBe("书生·端砚")
  expect(provider.npm).toBe("@ai-sdk/openai-compatible")
  expect(provider.api).toBe(f.origin + "/v1")
  expect(Object.keys(provider.models).length).toBeGreaterThan(0)
  expect(provider.models["glm-5.3"].limit.context).toBe(1048576)
})

test("the listing is the key's live set intersected with the public metadata", async () => {
  f = fakeInkStone()
  serve()
  const p = await plugin()
  const models = await p.provider.models({ id: "intern-inkstone", models: {} }, { auth })
  expect(Object.keys(models).sort()).toEqual(["Agents-A1", "glm-5.3"])
  expect(models["glm-5.3"].limit.context).toBe(1048576)
  expect(models["glm-5.3"].reasoning).toBe(true)
  expect(models["Agents-A1"].capabilities.input.image).toBe(true)
  expect(models["glm-5.3"].variants).toBeUndefined()
  // the magpie-only price markers reach provider.models too
  expect(models["glm-5.3"].rate).toBe(8)
  expect(models["glm-5.3"].free).toBeUndefined()
  expect(models["Agents-A1"].free).toBe(true)
  expect(models["Agents-A1"].rate).toBeUndefined()
})

test("config's bootstrap models carry the free/rate markers too", async () => {
  f = fakeInkStone()
  const p = await plugin()
  const cfg = {}
  await p.config(cfg)
  const models = cfg.provider["intern-inkstone"].models
  expect(models["Sage-A1.5"].free).toBe(true)
  expect(models["Sage-A1.5"].rate).toBeUndefined()
  expect(models["glm-5.3"].rate).toBe(8)
  expect(models["glm-5.3"].free).toBeUndefined()
})

test("an account with no API key advertises no models", async () => {
  f = fakeInkStone()
  const p = await plugin()
  const noKey = { type: "oauth", access: "", uaaToken: "uaa-token" }
  expect(await p.provider.models({ id: "intern-inkstone", models: { "glm-5.3": {} } }, { auth: noKey })).toEqual({})
  expect(await p.auth.loader(async () => noKey)).toEqual({})
})

test("a key the platform refused lists nothing, not the bootstrap set", async () => {
  f = fakeInkStone()
  f.route("GET /v1/models", () => json({ error: "unauthorized" }, 401))
  f.route("GET /api/tokenplan/v1/public/models", () => json(META))
  const p = await plugin()
  expect(await p.provider.models({ id: "intern-inkstone", models: { "glm-5.3": {} } }, { auth })).toEqual({})
})

test("a catalogue read that fails keeps the declared models", async () => {
  f = fakeInkStone()
  f.route("GET /v1/models", () => json({ error: "boom" }, 500))
  f.route("GET /api/tokenplan/v1/public/models", () => json(META))
  const p = await plugin()
  const given = { "glm-5.3": {} }
  const got = await p.provider.models({ id: "intern-inkstone", models: given }, { auth })
  expect(got).toEqual(given)
})

test("an account with no auth yet still sees the bootstrap list", async () => {
  f = fakeInkStone()
  const p = await plugin()
  const cfg = {}
  await p.config(cfg)
  const declared = cfg.provider["intern-inkstone"].models
  expect(await p.provider.models({ id: "intern-inkstone", models: {} }, {})).toEqual(declared)
})

test("the loader serves the models with the key at the platform's base URL", async () => {
  f = fakeInkStone()
  const p = await plugin()
  const loader = await p.auth.loader(async () => auth)
  expect(loader.apiKey).toBe("sk-test")
  expect(loader.baseURL).toBe(f.origin + "/v1")
})

test("the sign-in methods cover two browser ways, API key, and API key + console token", async () => {
  // a machine with a Chromium browser, whatever the test machine has
  const p = await plugin({ browserCandidates: () => ["/opt/chromium/chrome"] })
  const labels = p.auth.methods.map((m) => m.label)
  // zero-prompt browser sign-in first, the paste-optional one second
  expect(labels[0]).toContain("Browser sign-in")
  expect(labels[0]).not.toContain("reuse")
  expect(labels[1]).toContain("Browser sign-in")
  expect(labels[1]).toContain("reuse")
  expect(labels[2]).toContain("API key only")
  expect(labels[3]).toContain("console token")
  // the zero-prompt method has no prompts at all: the host opens the window
  // straight away (sensenova's and cursor's browser sign-in is the same)
  expect(p.auth.methods[0].prompts ?? []).toEqual([])
  // both browser methods must not block the host's authorize call: the browser
  // work runs in its callback (the host's authorize deadline is short)
  const browser = p.auth.methods[0]
  const result = browser.authorize({})
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    // a displayless CI runner is refused up front, not left with a window it cannot open
    expect(result.type).toBe("failed")
    expect(result.error).toContain("needs a display")
  } else {
    expect(result.method).toBe("auto")
    expect(typeof result.callback).toBe("function")
    expect(result.instructions).toContain("Sign in there")
    expect(result.url).toBe("")
  }
  // the reuse method's key prompt is optional; a non-sk- one is refused
  const reuse = p.auth.methods[1]
  expect(reuse.prompts[0].validate("")).toBeUndefined()
  expect(reuse.prompts[0].validate("sk-abc")).toBeUndefined()
  expect(reuse.prompts[0].validate("nope")).toContain("sk-")
})

test("with no Chromium browser the browser sign-in fails at authorize and names the other sign-ins (#825)", async () => {
  // a display is claimed so a displayless runner reaches the browser check
  const display = process.env.DISPLAY
  process.env.DISPLAY = display || ":99"
  try {
    const p = await plugin({ browserCandidates: () => [] })
    const result = p.auth.methods[0].authorize({})
    // never "opened" with instructions that say a window opens
    expect(result.type).toBe("failed")
    expect(result.opened).toBeUndefined()
    expect(result.callback).toBeUndefined()
    expect(result.error).toContain("Microsoft Edge, Google Chrome or Chromium")
    expect(result.error).toContain('"API key only"')
    expect(result.error).toContain('"API key + console token"')
    // the names it gives are the other methods' own labels
    expect(p.auth.methods[2].label).toStartWith("API key only")
    expect(p.auth.methods[3].label).toStartWith("API key + console token")
    // the reuse-a-key method goes through the same browserAuthorize path:
    // it fails at authorize too, never with a window it cannot open
    const reuse = p.auth.methods[1].authorize({})
    expect(reuse.type).toBe("failed")
    expect(reuse.opened).toBeUndefined()
    expect(reuse.callback).toBeUndefined()
    expect(reuse.error).toContain("Microsoft Edge, Google Chrome or Chromium")
    if (process.platform === "darwin") expect(result.error).toContain("Safari can't be used")
    else expect(result.error).not.toContain("Safari")
  } finally {
    if (display === undefined) delete process.env.DISPLAY
    else process.env.DISPLAY = display
  }
})

test("the API-key + console-token method reads the token out of a pasted cookie", async () => {
  f = fakeInkStone()
  serve()
  f.route("GET /api/tokenplan/v1/users/validate", () => json({ code: 0, data: { name: "张三", phone: "12345678901" } }))
  const p = await plugin()
  const method = p.auth.methods[3]
  // a full cookie string must be reduced to just the uaa-token value
  const okResult = await method.authorize({
    apiKey: "sk-test",
    uaaToken: "sid=SESSIONSECRET; uaa-token=abc.def.ghi; other=1",
  })
  expect(okResult.type).toBe("success")
  expect(okResult.uaaToken).toBe("abc.def.ghi")
  expect(JSON.stringify(okResult)).not.toContain("SESSIONSECRET")
  // host save() stores {...inputs, ...result.metadata} under metadata (#826):
  // the result's metadata carries the parsed token, so the pasted cookie
  // string, with its other session cookies, is not what gets saved
  expect(okResult.metadata.uaaToken).toBe("abc.def.ghi")
  expect(okResult.metadata.apiKey).toBe("sk-test")
  // a bare token value is accepted as-is
  const bare = await method.authorize({ apiKey: "sk-test", uaaToken: "abc.def.ghi" })
  expect(bare.type).toBe("success")
  expect(bare.uaaToken).toBe("abc.def.ghi")
  // base64 padding at the end is still a bare token
  const padded = await method.authorize({ apiKey: "sk-test", uaaToken: "abc.def.gh==" })
  expect(padded.type).toBe("success")
  // a string without a uaa-token is refused, never stored verbatim
  for (const junk of ["sid=SESSIONSECRET", "Cookie: uaa-token=abc", "abc=def", "uaa-token", "abc def", "short"]) {
    const bad = await method.authorize({ apiKey: "sk-test", uaaToken: junk })
    expect(bad.type).toBe("failed")
    expect(bad.error).toContain("uaa-token")
  }
})

test("the key-management calls ride the session cookie, not the bearer", async () => {
  f = fakeInkStone()
  const p = await plugin()
  const seen = []
  const serve = (method, path) =>
    f.route(`${method} /api/tokenplan/v1${path}`, (r) => {
      seen.push(`${method} ${path}: auth=${r.headers.get("authorization") ? "bearer" : "none"} cookie=${r.headers.get("cookie") ? "yes" : "no"}`)
      return json({ code: 0, msg: "success", data: {} })
    })
  serve("GET", "/keys")
  serve("POST", "/keys")
  serve("DELETE", "/keys/ak_1")
  const { listKeys, createKey, deleteKey } = await import("./lib/protocol.mjs")
  const token = "fake-token"
  await listKeys(token).catch(() => {})
  await createKey(token, "ink-x", "idem-1").catch(() => {})
  await deleteKey(token, "ak_1").catch(() => {})
  expect(seen.length).toBe(3)
  for (const line of seen) {
    // the /keys family takes the session cookie; a bearer there is the
    // -10002 "not authenticated" the real console answers (verified live,
    // 2026-11-07: the sign-in then failed at key creation on the real thing)
    expect(line).toContain("cookie=yes")
    expect(line).not.toContain("auth=bearer")
  }
})

test("the fetch wiring is the request path — each piece breaks it in a way the fake sees", async () => {
  // 作者 review：他逐项破坏 chatFetch 的每一节（删 loader fetch、关翻译、关
  // rewrite、关软重试、还原分页），97 个测试全绿——纯函数测试抓不住接线。
  // 这一条把接线钉住：每一节都经这层 fetch（或 keys 层）被假服务看到。
  f = fakeInkStone()
  const p = await plugin()
  const loader = await p.auth.loader(async () => auth)
  const tiny = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

  // ① 预检在 fetch 层生效：9 张图到不了平台
  let asked = 0
  f.route("POST /v1/chat/completions", () => (asked++, json({ ok: true })))
  const nine = {
    model: "Sage-A1.5",
    messages: [{ role: "user", content: [{ type: "text", text: "x" }, ...Array.from({ length: 9 }, () => ({ type: "image_url", image_url: { url: `data:image/png;base64,${tiny}` } }))] }],
  }
  const r1 = await loader.fetch(`${f.origin}/v1/chat/completions`, { method: "POST", body: JSON.stringify(nine) })
  expect(r1.status).toBe(400)
  expect((await r1.json()).error.message).toContain("extra inputs are not permitted")
  expect(asked).toBe(0)

  // ② 翻译在 fetch 层生效：端砚的 invalid_media 400 被换写成宿主认得的形状
  f.route("POST /v1/chat/completions", () => json({ code: "invalid_media", message: "unsupported media type" }, 400))
  const r2 = await loader.fetch(`${f.origin}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) })
  expect(r2.status).toBe(400)
  expect((await r2.json()).error.message).toContain("extra inputs are not permitted")

  // ③ 改写在 fetch 层生效：reasoning 被剥、detail 被补，上游收到的就是改写后的
  let received = null
  f.route("POST /v1/chat/completions", (r) => {
    asked++
    received = r.json
    return json({ ok: true })
  })
  const withReasoning = {
    model: "Sage-A1.5",
    reasoning: { effort: "high" },
    messages: [{ role: "user", content: [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: `data:image/png;base64,${tiny}` } }] }],
  }
  const r3 = await loader.fetch(`${f.origin}/v1/chat/completions`, { method: "POST", body: JSON.stringify(withReasoning) })
  expect(r3.status).toBe(200)
  expect("reasoning" in received).toBe(false)
  expect(received.messages[0].content[1].image_url.detail).toBe("auto")

  // ④ /keys 的 cookie + 无分页 query（#839 的回归防线）。走 ensureKey 驱动
  // 而不是直接调 protocol.listKeys：query 由 lib/keys.mjs 的调用点传入，
  // 直调永远看不到它（作者 B05：query 加回 keys.mjs 时 101/101 依然绿）。
  // fake 对带 page/page_size 的 /keys 回 -15100——keys.mjs 的任何调用点把
  // query 加回来，这里立刻红。
  const seen = { query: "", cookie: "" }
  f.route("GET /api/tokenplan/v1/keys", (r) => {
    seen.query = r.url
    seen.cookie = r.headers.get("cookie") ?? ""
    if (/[?&]page(size)?=/.test(r.url)) return json({ code: -15100, msg: "API Key fetch failed, refresh page and retry" })
    return json({ code: 0, data: { total: 0, items: [] } })
  })
  const { ensureKey } = await import("./lib/keys.mjs")
  // keyCount is ensureKey's first call on the create path: the list request
  // this drives is the one whose query the fix removed
  f.route("POST /api/tokenplan/v1/keys", () => ok({ key: "sk-wiring" }))
  const wiringKey = await ensureKey("fake-token", "acct", { create: true, prune: false, log: () => {} })
  expect(wiringKey).toBe("sk-wiring")
  expect(seen.cookie).toContain("uaa-token=fake-token")
  expect(seen.query).not.toContain("page=")
  expect(seen.query).not.toContain("page_size=")

  // ⑤ 软拒绝重试在 keys 层生效：-15100 后换名字再试
  const attempts = []
  f.route("POST /api/tokenplan/v1/keys", (r) => {
    attempts.push(r.json?.name)
    if (attempts.length === 1) return json({ code: -15100, msg: "API Key fetch failed, refresh page and retry" })
    return ok({ key: "sk-retried" })
  })
  const key = await ensureKey("fake-token", "acct2", { create: true, log: () => {} })
  expect(key).toBe("sk-retried")
  expect(attempts.length).toBe(2)
  expect(attempts[0]).not.toBe(attempts[1])

  // ⑥ N2：input 是 Request 且 body 非 JSON 时，读完要原样交回上游——
  // 否则 fetch 带上一个已被 text() 消费的流。fake 的 r.text 就是收到的原文。
  let gotRaw = null
  f.route("POST /v1/chat/completions", (r) => {
    gotRaw = r.text
    return json({ ok: true })
  })
  const req = new Request(`${f.origin}/v1/chat/completions`, {
    method: "POST",
    body: "not json at all",
    headers: { "content-type": "text/plain" },
  })
  const r4 = await loader.fetch(req)
  expect(r4.status).toBe(200)
  expect(gotRaw).toBe("not json at all")

  // ⑥b 第四轮 review 备忘：Request 的流被读掉后，交给上游的是「url 字符串 +
  // 完整 init」，不是那个已读空的 Request。装一个一次性包装 fetch 钉住
  // 这一半——只把 init 原样转发的包装层（catpaw 泄漏那类）也照样能跑。
  const realFetch = globalThis.fetch
  let sawSpentRequest = false
  let sawUrl = ""
  globalThis.fetch = (input2, init2 = {}) => {
    if (String(init2?.method ?? "").toUpperCase() === "POST" && String(input2 ?? "").includes("/chat/completions")) {
      if (typeof input2 !== "string") sawSpentRequest = true
      else sawUrl = input2
    }
    return realFetch(input2, init2)
  }
  try {
    const r5 = await loader.fetch(
      new Request(`${f.origin}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        headers: { "content-type": "application/json" },
      }),
    )
    expect(r5.status).toBe(200)
    expect(sawSpentRequest).toBe(false)
    expect(sawUrl).toBe(`${f.origin}/v1/chat/completions`)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("cleanDetail masks real uaa-token, sk-, Bearer and JWT runs", async () => {
  const { cleanDetail } = await import("./lib/protocol.mjs")
  expect(cleanDetail("failed: uaa-token=secretValue123456")).toBe("failed: ***")
  expect(cleanDetail("cookie: uaa_token: secretValue123456; other")).toBe("cookie: ***; other")
  expect(cleanDetail("auth header: Bearer opaqueToken123456")).toBe("auth header: ***")
  expect(cleanDetail("key is sk-12345678abcdef")).toBe("key is ***")
  expect(cleanDetail("jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig")).toBe("jwt: ***")
  // diagnostic words must stay
  expect(cleanDetail("error: token expired")).toBe("error: token expired")
})

test("a soft refusal leaves no orphan key behind - each made one is deleted before the retry", async () => {
  // -15100 有时吞掉的是已成功的 POST 的明文（真机：孤儿曾留下）。blocking 3：
  // 每个建成的孤儿按名字删掉，重试换新名；耗尽后如实报错。账号上零孤儿。
  f = fakeInkStone()
  const created = []
  let deleted = 0
  f.route("GET /api/tokenplan/v1/keys", () => json({ code: 0, data: { total: created.length, items: created } }))
  f.route("POST /api/tokenplan/v1/keys", (r) => {
    const id = `ak_${created.length + 1}`
    created.push({ id, name: r.json?.name, status: "active", created_at: new Date().toISOString() })
    // fake.mjs 只认精确字符串路由键——DELETE 按这把 Key 的真实 id 注册，
    // 这样「按名字删孤儿」才真的能命中（正则键永远匹配不上）。
    f.route(`DELETE /api/tokenplan/v1/keys/${id}`, () => (deleted++, json({ code: 0 })))
    // 平台建成了，但软风控把回复换成 -15100（明文没给）
    return json({ code: -15100, msg: "API Key fetch failed, refresh page and retry" })
  })
  const { ensureKey } = await import("./lib/keys.mjs")
  let said = ""
  try {
    await ensureKey("fake-token", "acct7", { create: true, log: () => {}, softRetryDelays: [0, 0] })
  } catch (e) {
    said = String(e?.message ?? e)
  }
  // 三次尝试（1 首发重试 2），每次建成即删：账号上零孤儿
  expect(created.length).toBe(3)
  expect(deleted).toBe(3)
  expect(created.length - deleted).toBe(0)
  // 耗尽后如实报 -15100
  expect(said).toContain("refresh page and retry")
})
