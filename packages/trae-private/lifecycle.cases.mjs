// 全部为构造数据、mock 子进程与 mock 浏览器；不访问真实登录状态。
import { beforeEach, afterEach, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import Plugin, { _internal as I } from "./index.mjs"
let root, home, signed
const defaults = { execFile: I.execFile, spawnLogin: I.spawnLogin, launchDebugBrowser: I.launchDebugBrowser, fetch: globalThis.fetch, WebSocket: globalThis.WebSocket }
const base = "https://deploy.example.test/prefix"
function writeAuth(token = "fake-token", uid = "fake-user", deployment = base, expires = Date.now() + 3600000) {
  writeFileSync(join(home, "cli/auth.json"), JSON.stringify({ trae: { access_token: token, refresh_token: "fake-refresh", user_id: uid, expires_at: new Date(expires).toISOString(), endpoints: { api_base_url: deployment } } }))
}
function writeCatalog(models = [{ config_name: "m", context_window: 300000, supported_reasoning_levels: ["high"] }]) {
  writeFileSync(join(home, "cli/models_cache.json"), JSON.stringify({ models }))
}
function fakeLogin({ close = true, token = true, fail = false } = {}) {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.kill = () => { child.killed = true }
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from("docs https://docs.example.test/manual\nOpen https://idp.example.test/sso?state=a%26b&redirect_uri=https%3A%2F%2Fdeploy.example.test\n"))
    if (token) writeAuth()
    if (close) child.emit("close", fail ? 1 : 0)
  })
  return child
}
beforeEach(async () => {
  root = mkdtempSync(join(process.env.TMPDIR, "lifecycle-")); home = join(root, "account")
  mkdirSync(join(home, "cli"), { recursive: true }); process.env.TRAE_HOME = home; process.env.XDG_CONFIG_HOME = join(root, "config")
  process.env.TRAE_PRIVATE_CLI = join(root, "fake-cli"); writeFileSync(process.env.TRAE_PRIVATE_CLI, "")
  process.env.TRAE_PRIVATE_NO_AUTO_REFRESH = "1"
  writeAuth(); writeCatalog(); signed = await I.signInAt({ baseURL: base }, home)
})
afterEach(() => {
  Object.assign(I, { execFile: defaults.execFile, spawnLogin: defaults.spawnLogin, launchDebugBrowser: defaults.launchDebugBrowser })
  globalThis.fetch = defaults.fetch; globalThis.WebSocket = defaults.WebSocket
  for (const k of ["refreshTimeout", "loginTimeout", "linkTimeout", "cdpTimeout"]) delete I[k]
  for (const k of ["TRAE_PRIVATE_APP_ID", "TRAE_PRIVATE_USER_AGENT", "TRAE_PRIVATE_PROTOCOL_VERSION", "TRAE_PRIVATE_CONTEXT", "TRAE_PRIVATE_OUTPUT", "TRAE_PRIVATE_BODY_BUDGET"]) delete process.env[k]
  process.env.TRAE_PRIVATE_NO_AUTO_REFRESH = "1"
  rmSync(root, { recursive: true, force: true })
})
test("refresh: same home coalesces, different homes execute independently in empty cwd", async () => {
  process.env.TRAE_PRIVATE_NO_AUTO_REFRESH = "0"
  const jobs = []
  I.execFile = (exe, argv, options, callback) => { jobs.push({ exe, argv, options, callback }); return { kill() {} } }
  const b = join(root, "other account;literal")
  const p = I.renewViaCli(home); const same = I.renewViaCli(home); const q = I.renewViaCli(b)
  expect(p).toBe(same); expect(jobs.length).toBe(2)
  expect(jobs[0].options.cwd).not.toBe(jobs[1].options.cwd)
  for (const job of jobs) {
    expect(job.options.cwd).not.toBe(process.cwd()); expect(existsSync(job.options.cwd)).toBe(true)
    expect(job.argv).toEqual(["exec", "--skip-git-repo-check", "--json", "reply with: ok"])
    expect(job.options.shell).toBeUndefined(); job.callback(null)
  }
  expect(await p).toBe(true); expect(await q).toBe(true)
  for (const job of jobs) expect(existsSync(job.options.cwd)).toBe(false)
  const retry = I.renewViaCli(home); jobs.at(-1).callback(new Error("fake failure")); expect(await retry).toBe(false)
})
test("refresh: timeout/cancel/failure release promises and clean owned cwd", async () => {
  process.env.TRAE_PRIVATE_NO_AUTO_REFRESH = "0"; I.refreshTimeout = 10
  const jobs = []; let kills = 0
  I.execFile = (_, __, options) => { jobs.push(options); return { kill() { kills++ } } }
  expect(await I.renewViaCli(home)).toBe(false)
  const ac = new AbortController(); const p = I.renewViaCli(home, ac.signal); ac.abort(); expect(await p).toBe(false)
  expect(kills).toBe(2)
  I.execFile = (_, __, ___, cb) => { cb(null); return {} }
  expect(await I.renewViaCli(home)).toBe(true)
  for (const job of jobs) expect(existsSync(job.cwd)).toBe(false)
})
test("refresh: production preserves binding on rotation and rejects identity changed during renewal", async () => {
  process.env.TRAE_PRIVATE_NO_AUTO_REFRESH = "0"
  const plugin = await Plugin()
  I.execFile = (_, __, ___, cb) => { writeAuth("fake-new-token"); cb(null); return {} }
  const next = await plugin.auth.refresh(signed)
  expect(next.access).toBe("fake-new-token"); expect(next.traeHome).toBe(signed.traeHome); expect(next.uid).toBe(signed.uid); expect(next.baseURL).toBe(signed.baseURL); expect(next.refresh).toBeNull()
  I.execFile = (_, __, ___, cb) => { writeAuth("fake-new-token", "different-user"); cb(null); return {} }
  await expect(plugin.auth.refresh(next)).rejects.toThrow("账号")
})
test("Windows CLI: exe accepts literal argv; cmd/bat rejected without shell interpolation", () => {
  expect(() => I.checkCliExecutable("C:\\CLI dir\\traecli.exe", "win32")).not.toThrow()
  for (const name of ["C:\\CLI dir\\traecli.cmd", "traecli.BAT"]) expect(() => I.checkCliExecutable(name, "win32")).toThrow("exe")
  expect(() => I.checkCliExecutable("/path with spaces/traecli", "linux")).not.toThrow()
})
test("catalog: cold half-write retries without blocking event loop; auth does too", async () => {
  writeFileSync(join(home, "cli/models_cache.json"), "{")
  let tick = false; const timer = setTimeout(() => { tick = true; writeCatalog() }, 10)
  const plugin = await Plugin(); const list = await plugin.provider.models({ models: {} }, { auth: signed })
  clearTimeout(timer); expect(tick).toBe(true); expect(list.m.limit.context).toBe(300000)
  writeFileSync(join(home, "cli/auth.json"), "{")
  const t = setTimeout(() => writeAuth("fake-rotated"), 10)
  expect((await plugin.auth.refresh(signed)).access).toBe("fake-rotated"); clearTimeout(t)
})
test("catalog: identity switch invalidates last-good; schema/permissions/missing files do not resurrect", async () => {
  I.catalog(home); writeAuth("fake-other", "other-user"); writeFileSync(join(home, "cli/models_cache.json"), "{")
  expect(() => I.catalog(home)).toThrow()
  writeAuth(); writeCatalog(); I.catalog(home)
  rmSync(join(home, "cli/models_cache.json")); expect(() => I.catalog(home)).toThrow("缺少模型目录")
  mkdirSync(join(home, "cli/models_cache.json")); expect(() => I.catalog(home)).toThrow(/read|JSON/)
  const plugin = await Plugin(); await expect(plugin.provider.models({ models: {} }, { auth: signed })).rejects.toThrow()
  rmSync(join(home, "cli/models_cache.json"), { recursive: true }); writeFileSync(join(home, "cli/models_cache.json"), '{"models":"invalid"}')
  expect(() => I.catalog(home)).toThrow("结构")
})
test("cold corrupt files: config/models/usage/chat provide controlled errors", async () => {
  const p = await Plugin(); const l = await p.auth.loader(async () => signed)
  writeFileSync(join(home, "cli/auth.json"), "{")
  const config = {}; await p.config(config); expect(config.provider).toBeUndefined()
  expect(await p.provider.models({ models: {} })).toEqual({})
  expect((await p.auth.usage(async () => signed)).signIn).toBe("kept")
  const r = await l.fetch("https://unused.invalid", { body: JSON.stringify({ model: "m", input: "test" }) }); expect(r.status).toBe(503); expect(r.headers.get("X-Magpie-Sign-In")).toBe("kept")
})
test("models hook uses host-provided account auth and rejects changed identity", async () => {
  const other = join(root, "default"); mkdirSync(other); process.env.TRAE_HOME = other
  const p = await Plugin(); expect((await p.provider.models({ models: {} }, { auth: signed })).m).toBeDefined()
  writeAuth("fake-b", "fake-b"); await expect(p.provider.models({ models: {} }, { auth: signed })).rejects.toThrow("账号")
})
test("SSO: live CLI token can explicitly recollect cookie; stop makes cookies fail", async () => {
  let closed = false, child
  I.launchDebugBrowser = async () => ({ open: async () => {}, cookies: async () => { await Promise.resolve(); if (closed) throw new Error("closed"); return [{ name: "X-Cloudide-Tob-Session", value: "fake-cookie", domain: "deploy.example.test", path: "/prefix", secure: true }] }, stop: async () => { closed = true } })
  I.spawnLogin = () => child = fakeLogin()
  const step = await I.authorizeLogin({ baseURL: base, forceSso: true }, home)
  expect(step.url).toContain("idp.example.test/sso")
  const result = await step.callback(); expect(result.type).toBe("success"); expect(result.quotaStatus).toBe("available"); expect(I.usageCookie(result)).toBe("fake-cookie"); expect(closed).toBe(true); expect(child.killed).toBe(true)
  expect(result.webSession).toBeNull()
})
test("SSO: cookie failure is explicit degradation, valid CLI token remains", async () => {
  I.launchDebugBrowser = async () => ({ open: async () => {}, cookies: async () => { throw new Error("closed early") }, stop: async () => {} })
  I.spawnLogin = () => fakeLogin()
  const result = await (await I.authorizeLogin({ baseURL: base, forceSso: true }, home)).callback()
  expect(result.type).toBe("success"); expect(result.quotaStatus).toBe("missing"); expect(result.quotaError).toContain("失败"); expect(existsSync(join(home, "cli/auth.json"))).toBe(true)
})
test("SSO: no callback/explicit cancel/early CLI exit clean owned resources", async () => {
  for (const action of ["lease", "cancel", "exit"]) {
    let closed = false, cwd, child
    I.loginTimeout = 15
    I.launchDebugBrowser = async () => ({ open: async () => {}, stop: async () => { closed = true } })
    I.spawnLogin = (_, __, opts) => { cwd = opts.cwd; return child = fakeLogin({ close: action === "exit", token: false, fail: true }) }
    rmSync(join(home, "cli/auth.json"), { force: true })
    const step = await I.authorizeLogin({ baseURL: base }, home)
    if (action === "cancel") await step.cancel()
    else if (action === "exit") expect((await step.callback()).type).toBe("failed")
    else await new Promise((r) => setTimeout(r, 30))
    expect(closed).toBe(true); expect(child.killed).toBe(true); expect(existsSync(cwd)).toBe(false)
  }
})
test("SSO: abort during delayed browser startup fails before CLI and stops browser once", async () => {
  const ac = new AbortController()
  let releaseBrowser, markStarted, spawns = 0, stops = 0
  const started = new Promise((resolve) => { markStarted = resolve })
  const browserReady = new Promise((resolve) => { releaseBrowser = resolve })
  I.launchDebugBrowser = async () => {
    markStarted()
    return await browserReady
  }
  I.spawnLogin = () => { spawns++; return fakeLogin() }
  const pending = I.authorizeLogin({ baseURL: base, forceSso: true, signal: ac.signal }, home)
  await started
  ac.abort()
  releaseBrowser({
    open: async () => {},
    stop: async () => { await Promise.resolve(); stops++ },
  })
  const result = await pending
  expect(result.type).toBe("failed")
  expect(spawns).toBe(0)
  expect(stops).toBe(1)
})
test("SSO: abort and CDP open failure clean browser and CLI", async () => {
  for (const failure of ["abort", "cdp"]) {
    let stops = 0, child
    I.launchDebugBrowser = async () => ({ open: async () => { if (failure === "cdp") throw new Error("405") }, stop: async () => { stops++ } })
    I.spawnLogin = () => child = fakeLogin({ close: false, token: false })
    const ac = new AbortController()
    const step = await I.authorizeLogin({ baseURL: base, forceSso: true, signal: ac.signal }, home)
    if (failure === "abort") { ac.abort(); expect((await step.callback()).type).toBe("failed") }
    else expect(step.type).toBe("failed")
    expect(stops).toBe(1); expect(child.killed).toBe(true)
  }
})
test("CDP: PUT encodes full OAuth URL, rejects 405 and invalid structure", async () => {
  const url = "https://idp.example.test/oauth?state=a&redirect_uri=https%3A%2F%2Fdeploy.example.test"
  let target, init
  globalThis.fetch = async (u, o) => { target = u; init = o; return Response.json({ id: "fake", type: "page" }) }
  await I.openDebugPage(1234, url); expect(init.method).toBe("PUT"); expect(target).toBe(`http://127.0.0.1:1234/json/new?${encodeURIComponent(url)}`)
  globalThis.fetch = async () => new Response("", { status: 405 }); await expect(I.openDebugPage(1234, url)).rejects.toThrow("405")
  globalThis.fetch = async () => Response.json({}); await expect(I.openDebugPage(1234, url)).rejects.toThrow("响应")
})
test("SSO URL selection: reject arbitrary docs/userinfo, permit enterprise IdP OAuth", () => {
  expect(I.loginURL("https://docs.example.test/help", base)).toBe("")
  expect(I.loginURL("https://u:p@idp.example.test/login", base)).toBe("")
  expect(I.loginURL("https://enterprise.idp.test/authorize?state=x&client_id=fake", base)).toContain("enterprise.idp.test")
})
test("URL: prefix/slash invariants, malformed/encoded/backslash paths are rejected", () => {
  expect(I.sameOriginPath(base + "/", "/q")).toBe(base + "/q")
  for (const value of ["http://a.test", "https://u:p@a.test", "https://a.test/?q=x", "https://a.test/#x", "https://a.test/\\evil", "https://a.test/%2fother", "not a URL"]) expect(I.parseBaseURL(value).error).toBeTruthy()
  for (const path of ["//evil.test", "/\\evil.test", "/../x", "/%2e%2e/x", "@evil.test/q"]) expect(() => I.sameOriginPath(base, path)).toThrow()
})
test("usage: scoped cookie prefix and redirects, expiry and service errors", async () => {
  I.saveWebSession(signed, { name: "X-Cloudide-Tob-Session", value: "fake-cookie", domain: "deploy.example.test", path: "/prefix", secure: true, expires: Date.now() / 1000 + 60 })
  const requests = []
  globalThis.fetch = async (url, init) => { requests.push([url, init]); return Response.json(url.includes("get_personal_quota") ? { code: 0, user_model_quota: { seat_pool_currency_quota: 200 } } : { code: 0, user_usage_list: [] }) }
  const p = await Plugin(); const result = await p.auth.usage(async () => signed)
  expect(result.balance).toBe("200.00"); expect(result.windows[0].span).toBe(2592000)
  for (const [url, init] of requests) { expect(url).toStartWith(base + "/trae/"); expect(init.redirect).toBe("error"); expect(init.headers.Cookie).toBe("X-Cloudide-Tob-Session=fake-cookie") }
  globalThis.fetch = async () => Response.json({ code: 30011, message: "fake login expired" }); expect((await p.auth.usage(async () => signed)).error).toContain("30011")
  globalThis.fetch = async () => new Response("", { status: 307 }); expect((await p.auth.usage(async () => signed)).error).toContain("307")
  I.saveWebSession(signed, { name: "X-Cloudide-Tob-Session", value: "fake-cookie", domain: "deploy.example.test", expires: 1 }); expect((await p.auth.usage(async () => signed)).error).toContain("会话")
})
test("protocol: overrides/invalid env and sampling/reasoning mapping through chat", async () => {
  expect(I.protocolConfig()).toMatchObject({ appId: "fixture-app-id", ideVersionCode: "20260206", ideVersion: "99.99.99", originator: "codex_exec" })
  expect((await (await Plugin()).provider.models({ models: {} }, { auth: signed })).m.variants.high).toEqual({ reasoningEffort: "high" })
  process.env.TRAE_PRIVATE_APP_ID = "fake-app"; process.env.TRAE_PRIVATE_USER_AGENT = "fake-agent"; process.env.TRAE_PRIVATE_PROTOCOL_VERSION = "fake-version"
  let sent
  globalThis.fetch = async (_, init) => { sent = init; return new Response('event: done\ndata: {"response":"ok","usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n', { headers: { "content-type": "text/event-stream" } }) }
  const loader = await (await Plugin()).auth.loader(async () => signed)
  const req = { model: "m", input: "hi", temperature: 0.2, top_p: 0.9, stop: ["END"], reasoning_effort: "high" }
  const r = await loader.fetch("https://unused.invalid", { body: JSON.stringify(req) }); expect(r.status).toBe(200); expect((await r.json()).usage.total_tokens).toBe(3)
  expect(sent.headers["x-app-id"]).toBe("fake-app"); expect(sent.headers["User-Agent"]).toBe("fake-agent"); expect(sent.headers.version).toBe("fake-version")
  expect(JSON.parse(sent.body)).toMatchObject({ temperature: 0.2, top_p: 0.9, stop: ["END"], reasoning_effort: "high" })
  expect((await loader.fetch("https://unused.invalid", { body: JSON.stringify({ ...req, reasoning_effort: "invalid" }) })).status).toBe(400)
  process.env.TRAE_PRIVATE_APP_ID = "\n"; expect((await loader.fetch("https://unused.invalid", { body: JSON.stringify(req) })).status).toBe(502)
  for (const value of ["-1", "NaN", "0", "1.5"]) { process.env.TRAE_PRIVATE_CONTEXT = value; expect(() => I.contextOf({})).toThrow("正整数") }
})
test("binding: legacy full evidence migrates; invalid deployment never reaches network", async () => {
  const { bindingVersion, ...legacy } = signed
  writeAuth("fake-token", "fake-user", base, Date.now() + 86400000)
  const result = await (await Plugin()).auth.refresh({ ...legacy, refresh: "fake-old-refresh" })
  expect(result.bindingVersion).toBe(1); expect(result.refresh).toBeNull()
  const loader = await (await Plugin()).auth.loader(async () => signed)
  writeAuth("fake-token", "fake-user", "http://bad.example.test")
  expect((await loader.fetch("https://unused.invalid", { body: '{"model":"m","input":"x"}' })).status).toBe(401)
})
test("default home: no TRAE_HOME binds resolved HOME/.trae", async () => {
  delete process.env.TRAE_HOME; home = join(process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME, ".trae")
  mkdirSync(join(home, "cli"), { recursive: true }); writeAuth(); writeCatalog()
  const account = await I.signInAt({ baseURL: base }, "")
  expect(account.traeHome).toBe(I.traeHome(home)); expect(account.uid).toBe("fake-user")
})
test("catalog: last-good is short-lived and permissions bypass it", async () => {
  const p = await Plugin()
  await p.provider.models({ models: {} }, { auth: signed })
  writeFileSync(join(home, "cli/models_cache.json"), "{")
  expect((await p.provider.models({ models: {} }, { auth: signed })).m).toBeDefined()
  const now = Date.now
  try {
    const later = now() + 2000; Date.now = () => later
    await expect(p.provider.models({ models: {} }, { auth: signed })).rejects.toThrow("JSON")
  } finally { Date.now = now }
  writeCatalog(); I.catalog(home)
  if (process.platform !== "win32") {
    const file = join(home, "cli/models_cache.json"); chmodSync(file, 0)
    try { expect(() => I.catalog(home)).toThrow("EACCES") } finally { chmodSync(file, 0o600) }
  }
})
test("cookie: prefer matching path and exact host, never another account/origin/home", () => {
  const make = (value, domain, path) => ({ name: "X-Cloudide-Tob-Session", value, domain, path, secure: true })
  const list = [make("wrong-path", "deploy.example.test", "/else"), make("parent", ".example.test", "/"), make("exact", "deploy.example.test", "/"), make("specific", "deploy.example.test", "/prefix")]
  expect(I.cookieForHost(list, base + "/quota")).toBe("specific")
  expect(I.cookieForHost(list.slice(0, 3), base + "/quota")).toBe("exact")
  I.saveWebSession(signed, list.at(-1)); expect(I.usageCookie(signed)).toBe("specific")
  for (const other of [{ ...signed, uid: "different" }, { ...signed, baseURL: "https://other.example.test" }, { ...signed, traeHome: join(root, "other") }]) expect(I.usageCookie(other)).toBe("")
})
test("CDP: websocket success/error/close/timeout always closes owned socket", async () => {
  I.cdpTimeout = 10
  globalThis.fetch = async () => Response.json([{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:1234/devtools/page/fake" }])
  for (const mode of ["ok", "error", "close", "timeout"]) {
    let closed = false
    globalThis.WebSocket = class extends EventTarget {
      constructor() { super(); queueMicrotask(() => { if (mode !== "timeout") this.dispatchEvent(new Event(mode === "ok" ? "open" : mode)) }) }
      send() { queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: 1, result: { cookies: [] } }) }))) }
      close() { closed = true }
    }
    if (mode === "ok") expect(await I.cdpCookies(1234)).toEqual([])
    else await expect(I.cdpCookies(1234)).rejects.toThrow()
    expect(closed).toBe(true)
  }
})
test("SSO: missing login URL times out and cleans owned resources", async () => {
  I.linkTimeout = 10; let closed = false, killed = false
  I.launchDebugBrowser = async () => ({ stop: async () => { closed = true } })
  I.spawnLogin = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => { killed = true }; return c }
  const step = await I.authorizeLogin({ baseURL: base, forceSso: true }, home)
  expect(step.type).toBe("failed"); expect(closed).toBe(true); expect(killed).toBe(true)
})
test("self-check: only file presence, never credential contents or readiness claim", async () => {
  const lines = []; const log = console.log; const exit = process.exitCode
  try {
    console.log = (...args) => lines.push(args.join(" "))
    await import("./scripts/setup-machine.mjs")
    const text = lines.join("\n"); expect(text).not.toContain("fake-token"); expect(text).not.toContain("fake-refresh"); expect(text).toContain("尚未验证登录有效")
  } finally { console.log = log; process.exitCode = exit }
})

