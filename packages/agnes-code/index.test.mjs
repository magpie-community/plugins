import test from "node:test"
import assert from "node:assert/strict"
import { createCipheriv, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { join } from "node:path"

import { AgnesCNPlugin, AgnesPlugin, SITES, _internal, createPlugin } from "./index.mjs"

const { CB_PATH, trustBase, siteOfBase } = _internal

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

function makeJwt(claims = { sub: "u-1", name: "tester", exp: Math.floor(Date.now() / 1000) + 3600 }) {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.sig`
}

async function startServer(handler) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

// 假的 BFF：校验 origin / x-platform / client_id，否则拒；成功回 000000 + access_token。
async function fakeBff({ token, seen = [] }) {
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += String(c)))
    req.on("end", () => {
      const body = JSON.parse(raw || "{}")
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      const reply = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(payload))
      }
      if (req.method !== "POST" || req.url !== "/api/v1/code/auth/exchange-code") return reply(404, { code: "404" })
      if (req.headers["x-platform"] !== "1") return reply(400, { code: "40001", message: "缺少 x-platform" })
      if (!["agnes-cli", "agnes-code"].includes(body.client_id)) return reply(400, { code: "40002", message: "client_id 不对" })
      if (typeof body.code !== "string" || !body.code) return reply(400, { code: "40003", message: "缺少 code" })
      return reply(200, { code: "000000", message: "ok", data: { access_token: token } })
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { server, base: `http://127.0.0.1:${server.address().port}`, seen }
}

test("两个 provider id 各自钉在自己那一端的 host", () => {
  assert.equal(SITES.intl.id, "agnes-code")
  assert.equal(SITES.cn.id, "agnes-code-cn")
  assert.equal(SITES.intl.bffBase, "https://api-agnes-code.agnes-ai.com")
  assert.equal(SITES.cn.bffBase, "https://api-agnes-code.agnes-ai.cn")
  assert.equal(_internal.chatBase(SITES.cn), "https://api-agnes-code.agnes-ai.cn/v1")
})

test("trustBase 只认 https + 该站后缀 + 无端口", () => {
  assert.equal(trustBase("https://api-agnes-code.agnes-ai.cn", SITES.cn), "https://api-agnes-code.agnes-ai.cn")
  assert.equal(trustBase("https://api-agnes-code.agnes-ai.com/app", SITES.intl), "https://api-agnes-code.agnes-ai.com")
  assert.equal(trustBase("http://api-agnes-code.agnes-ai.cn", SITES.cn), null)
  assert.equal(trustBase("https://api-agnes-code.agnes-ai.cn:8443", SITES.cn), null)
  assert.equal(trustBase("https://evil-agnes-ai.cn", SITES.cn), null)
  assert.equal(trustBase("https://agnes-ai.cn", SITES.cn), null)
  assert.equal(trustBase("https://api.agnes-ai.com", SITES.cn), null)
})

test("siteOfBase 把会话里的 bffPublicBaseUrl 归到正确的一端", () => {
  assert.equal(siteOfBase("https://api-agnes-code.agnes-ai.cn")?.domain, "cn")
  assert.equal(siteOfBase("https://api-agnes-code.agnes-ai.com")?.domain, "intl")
  assert.equal(siteOfBase("https://api-agnes-code.agnes-ai.com.evil.cn"), null)
  assert.equal(siteOfBase("https://unknown.example.com"), null)
})

test("config / loader 按站点走各自的 baseURL", async () => {
  const intl = createPlugin(SITES.intl)
  const cn = createPlugin(SITES.cn)

  const cfg = {}
  await intl.config(cfg)
  await cn.config(cfg)
  assert.equal(cfg.provider["agnes-code"].api, "https://api-agnes-code.agnes-ai.com/v1")
  assert.equal(cfg.provider["agnes-code-cn"].api, "https://api-agnes-code.agnes-ai.cn/v1")

  assert.equal(intl.auth.methods.length, 3)
  assert.deepEqual(
    intl.auth.methods.map((m) => m.type),
    ["oauth", "oauth", "api"],
  )
  // 两个 provider 的按钮文案必须互相区分：只靠弹窗标题说明站点，列表里两张卡会一模一样。
  assert.deepEqual(
    intl.auth.methods.map((m) => m.label),
    ["浏览器登录 · 国际站", "读取桌面端登录态 · 国际站", "粘贴 accessToken · 国际站"],
  )
  assert.deepEqual(
    cn.auth.methods.map((m) => m.label),
    ["浏览器登录 · 国内站", "读取桌面端登录态 · 国内站", "粘贴 accessToken · 国内站"],
  )
  for (let i = 0; i < 3; i += 1) assert.notEqual(intl.auth.methods[i].label, cn.auth.methods[i].label)
  assert.equal(cfg.provider["agnes-code"].name, "Agnes Code · 国际站")
  assert.equal(cfg.provider["agnes-code-cn"].name, "Agnes Code · 国内站")
  // 官网链接必须落在应用页：营销页 agnes-ai.com/agnescode 被 Defender SmartScreen 举报过，会红屏。
  assert.equal(SITES.intl.officialSite, "https://app.agnes-ai.com")
  assert.equal(SITES.cn.officialSite, "https://app.agnes-ai.cn")
  assert.ok(!SITES.intl.officialSite.includes("/agnescode"))

  const loader = await cn.auth.loader(async () => ({ type: "api", key: "k" }))
  assert.deepEqual(loader, { baseURL: "https://api-agnes-code.agnes-ai.cn/v1", apiKey: "k" })
  const empty = await cn.auth.loader(async () => ({ type: "oauth" }))
  assert.deepEqual(empty, {})
})

test("浏览器登录：回调 POST {code,state} → 换票 → 成功（含 CORS 预检）", async () => {
  const token = makeJwt()
  const bff = await fakeBff({ token })
  const site = { ...SITES.cn, bffBase: bff.base, loginUrl: `${bff.base}/login`, origin: "https://app.agnes-ai.cn" }

  try {
    const plugin = createPlugin(site, { fetchImpl: globalThis.fetch, platform: "linux" })
    const auth = await plugin.auth.methods[0].authorize(undefined, {})
    const url = new URL(auth.url)
    const redirect = url.searchParams.get("redirect_uri")
    const state = url.searchParams.get("state")
    assert.equal(url.searchParams.get("client"), "agnes-cli")
    assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
    assert.ok(state.length > 10)

    // 预检：登录页是 https，回本地 http，浏览器一定先发 OPTIONS。
    const preflight = await fetch(redirect, {
      method: "OPTIONS",
      headers: { origin: "https://app.agnes-ai.cn", "access-control-request-method": "POST" },
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://app.agnes-ai.cn")

    // 错误的 state 必须被拒，且不能把这一次登录弄坏。
    const wrong = await postJson(redirect, { code: "c-1", state: "not-my-state" })
    assert.equal(wrong.status, 400)
    assert.equal(wrong.body.error, "bad state")

    const resultPromise = auth.callback()
    const ok = await postJson(redirect, { code: "c-1", state })
    assert.equal(ok.status, 200)

    const result = await resultPromise
    assert.equal(result.type, "success")
    assert.equal(result.key, token)
    assert.equal(result.metadata.method, "browser")
    assert.equal(result.metadata.bffBase, bff.base)

    // 换票请求长什么样：origin 头 + x-platform + client_id 缺一不可。
    assert.equal(bff.seen.length, 1)
    // 回环登录必须用 agnes-cli 前缀（agnes-code 只配 agnes:// 深链），换票先按它发。
    assert.equal(bff.seen[0].body.client_id, "agnes-cli")
    assert.equal(bff.seen[0].headers.origin, "https://app.agnes-ai.cn")
    assert.equal(bff.seen[0].headers["x-platform"], "1")
    assert.equal(bff.seen[0].body.redirect_uri, redirect)
    assert.equal(bff.seen[0].body.state, state)
  } finally {
    bff.server.close()
  }
})

test("换票被拒时登录结果是失败而不是静默成功", async () => {
  const bff = await fakeBff({ token: "" })
  const site = { ...SITES.cn, bffBase: bff.base, loginUrl: `${bff.base}/login` }
  try {
    const plugin = createPlugin(site)
    const auth = await plugin.auth.methods[0].authorize(undefined, {})
    const redirect = new URL(auth.url).searchParams.get("redirect_uri")
    const state = new URL(auth.url).searchParams.get("state")
    const pending = auth.callback()
    await postJson(redirect, { code: "c-2", state })
    const result = await pending
    // fake BFF 的 token 为空 → 应该明确失败
    assert.equal(result.type, "failed")
    assert.match(result.error, /access_token/)
  } finally {
    bff.server.close()
  }
})

test("取消登录会关掉监听端口", async () => {
  const bff = await fakeBff({ token: makeJwt() })
  const site = { ...SITES.cn, bffBase: bff.base, loginUrl: `${bff.base}/login` }
  try {
    const plugin = createPlugin(site)
    const controller = new AbortController()
    const auth = await plugin.auth.methods[0].authorize(undefined, { signal: controller.signal })
    const redirect = new URL(auth.url).searchParams.get("redirect_uri")
    const pending = auth.callback()
    controller.abort()
    const result = await pending
    assert.equal(result.type, "failed")
    assert.match(result.error, /取消/)
    // 端口已关：再连一次应当失败
    await assert.rejects(fetch(redirect, { method: "OPTIONS" }))
  } finally {
    bff.server.close()
  }
})

test("桌面端会话：读出 bffPublicBaseUrl 并分清国内站/国际站", async () => {
  const key = randomBytes(32)
  const jwt = makeJwt()
  const session = {
    accessToken: jwt,
    userInfo: { username: "tester" },
    bffPublicBaseUrl: "https://api-agnes-code.agnes-ai.cn",
  }
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(session), "utf8")), cipher.final()])
  const blob = Buffer.concat([Buffer.from("v10", "latin1"), nonce, ciphertext, cipher.getAuthTag()])

  const dir = "C:\\fake\\AgnesCode"
  const cnFile = "code-auth-session.cn.v1"
  const files = {
    [join(dir, "Local State")]: Buffer.from(JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI", "latin1"), Buffer.from("wrapped")]).toString("base64") } })),
    // 桌面端国内站的会话文件名带 .cn（实测如此），只认名字里没后缀的那份会一直读不到。
    [join(dir, cnFile)]: blob,
  }
  const readFileImpl = (path) => {
    if (!files[path]) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
    return files[path]
  }
  const deps = {
    platform: "win32",
    env: { APPDATA: "C:\\fake" },
    readFileImpl,
    readDirImpl: () => [cnFile, "Preferences", "settings.json"],
    dpapiImpl: async () => key,
    nowMs: Date.now(),
  }

  const cnCred = await _internal.readDesktopCredential({ site: SITES.cn, ...deps })
  assert.equal(cnCred.domain, "cn")
  assert.equal(cnCred.bffBase, "https://api-agnes-code.agnes-ai.cn")
  assert.equal(cnCred.username, "tester")

  await assert.rejects(() => _internal.readDesktopCredential({ site: SITES.intl, ...deps }), (error) => {
    assert.equal(error.code, "domain_mismatch")
    assert.match(error.message, /国内站/)
    return true
  })

  // 国际站的会话是 code-auth-session.v1（无后缀），走它自己的 .com 源站
  const intlSession = { ...session, bffPublicBaseUrl: "https://api-agnes-code.agnes-ai.com" }
  const cipherIntl = createCipheriv("aes-256-gcm", key, nonce)
  const blobIntl = Buffer.concat([Buffer.from("v10", "latin1"), nonce, Buffer.concat([cipherIntl.update(Buffer.from(JSON.stringify(intlSession), "utf8")), cipherIntl.final()]), cipherIntl.getAuthTag()])
  const intlFiles = { [join(dir, "code-auth-session.v1")]: blobIntl, ...files }
  const intlCred = await _internal.readDesktopCredential({
    ...deps,
    readFileImpl: (p) => intlFiles[p] ?? readFileImpl(p),
    readDirImpl: () => ["code-auth-session.v1", cnFile],
  })
  assert.equal(intlCred.domain, "intl")
  assert.equal(intlCred.bffBase, "https://api-agnes-code.agnes-ai.com")
  assert.equal((await _internal.readDesktopCredential({ site: SITES.intl, ...deps, readFileImpl: (p) => intlFiles[p] ?? readFileImpl(p), readDirImpl: () => ["code-auth-session.v1", cnFile] })).domain, "intl")

  // 会话里写了不在信任范围的源站：拒绝，而不是照着它把 token 发出去
  const tampered = Buffer.from(JSON.stringify({ ...session, bffPublicBaseUrl: "https://evil.example.com" }))
  const cipher2 = createCipheriv("aes-256-gcm", key, nonce)
  const blob2 = Buffer.concat([Buffer.from("v10", "latin1"), nonce, Buffer.concat([cipher2.update(tampered), cipher2.final()]), cipher2.getAuthTag()])
  const files2 = { [join(dir, "Local State")]: files[join(dir, "Local State")], [join(dir, cnFile)]: blob2 }
  await assert.rejects(
    () => _internal.readDesktopCredential({ ...deps, readFileImpl: (p) => files2[p] ?? readFileImpl(p) }),
    (error) => {
      assert.equal(error.code, "untrusted")
      return true
    },
  )
})

test("0.1.2 升级路径：原 agnes-code 的会话与粘贴 token 继续可用，不用重登", async () => {
  // provider id 不能改名：老用户 plugin-auth.json 里的键就是 agnes-code，改了等于把人踢下线。
  const plugin = await AgnesPlugin()
  assert.equal(plugin.auth.provider, "agnes-code")

  // 已存的粘贴 token（type: api）升级后照样走 .com 源站。
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "old-token" }))
  assert.deepEqual(loader, { baseURL: "https://api-agnes-code.agnes-ai.com/v1", apiKey: "old-token" })

  // 老版本桌面端只有无后缀的 code-auth-session.v1，必须仍被判成国际站并读出用户名。
  const key = randomBytes(32)
  const session = { accessToken: makeJwt(), userInfo: { username: "old-user" }, bffPublicBaseUrl: "https://api-agnes-code.agnes-ai.com" }
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const blob = Buffer.concat([Buffer.from("v10", "latin1"), nonce, Buffer.concat([cipher.update(Buffer.from(JSON.stringify(session), "utf8")), cipher.final()]), cipher.getAuthTag()])
  const dir = "C:\\fake\\AgnesCode"
  const files = {
    [join(dir, "Local State")]: Buffer.from(JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI", "latin1"), Buffer.from("wrapped")]).toString("base64") } })),
    [join(dir, "code-auth-session.v1")]: blob,
  }
  const cred = await _internal.readDesktopCredential({
    site: SITES.intl,
    platform: "win32",
    env: { APPDATA: "C:\\fake" },
    readFileImpl: (path) => {
      if (!files[path]) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
      return files[path]
    },
    readDirImpl: () => ["code-auth-session.v1"],
    dpapiImpl: async () => key,
    nowMs: Date.now(),
  })
  assert.equal(cred.domain, "intl")
  assert.equal(cred.bffBase, "https://api-agnes-code.agnes-ai.com")
  assert.equal(cred.username, "old-user")
})

test("usage 先打 bff 域，404 才回落到 api 域", async () => {
  const site = SITES.cn
  const urls = _internal.balanceUrls(site)
  assert.deepEqual(urls, ["https://api-agnes-code.agnes-ai.cn/api/v2/subscription/credits-balance", "https://api.agnes-ai.cn/api/v2/subscription/credits-balance"])

  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    if (url.startsWith("https://api-agnes-code.agnes-ai.cn")) return { status: 404, ok: false, json: async () => ({}) }
    return { status: 200, ok: true, json: async () => ({ data: { total_balance: 600 } }) }
  }
  const plugin = createPlugin(site, { fetchImpl })
  const usage = await plugin.auth.usage(async () => ({ type: "api", key: "k" }))
  assert.equal(seen.length, 2)
  assert.equal(usage.windows[0].balance, 600)
  assert.equal(usage.plan, "Free")

  // 第二次直接命中缓存，不再多打一发 404
  seen.length = 0
  const again = await plugin.auth.usage(async () => ({ type: "api", key: "k" }))
  assert.equal(seen.length, 1)
  assert.equal(again.windows[0].balance, 600)
})

test("两个入口函数都能被宿主直接调用", async () => {
  const intl = await AgnesPlugin()
  const cn = await AgnesCNPlugin()
  assert.equal(intl.auth.provider, "agnes-code")
  assert.equal(cn.auth.provider, "agnes-code-cn")
  assert.equal(intl.provider.id, "agnes-code")
})
