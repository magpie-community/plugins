// The auth callback, exercised offline: no window, no network.
//
// This is the test that was missing when a refactor broke sign-in. In
// 4f7f084 the shared accountName helper was rewritten to call
// browserFor(profile), but browserFor is a const INSIDE createPlugin —
// from the module scope accountName could not see it, so every sign-in
// that reached the naming step died on "ReferenceError: browserFor is
// not defined" AFTER the user had already signed in. The callback never
// returned {type:"success"}, so magpie showed a sign-in that never
// completed.
//
// The regression is caught here without any browser: signIn and the name
// read are injected, so the whole callback runs in-process.
import { expect, test } from "bun:test"
import { createPlugin } from "./index.mjs"

const PROFILE_RE = /^[\w-]+$/

// a plugin whose sign-in succeeds instantly and whose name read is stubbed
function offlinePlugin({ cookies = { "__Secure-1PSID": "s", "__Secure-1PSIDTS": "t" }, name = "" } = {}) {
  return createPlugin({
    headless: true,
    // signIn(profile) → the cookies the window would have left behind
    signInImpl: async () => cookies,
    // pageEmail(browser) → the account's email, or "" when hidden
    pageEmailImpl: async () => name,
    // the naming step, without starting a browser at all
    accountNameImpl: async () => name,
  })
}

test("callback 成功时返回 success 记录，而不是抛错", async () => {
  const plugin = offlinePlugin({ name: "someone@example.com" })
  const method = plugin.auth.methods[0]
  const auth = await method.authorize()
  // the callback is what magpie invokes once the window is done
  const result = await auth.callback()
  expect(result.type).toBe("success")
  expect(result.accountId).toBe("someone@example.com")
  expect(result.name).toBe("someone@example.com")
  // the profile directory is what the relay browser is later started on
  const access = JSON.parse(result.access)
  expect(access.profileDir).toBeTruthy()
  expect(PROFILE_RE.test(access.profileDir.split(/[\\/]/).pop())).toBe(true)
})

test("读不到邮箱时用 profile 后缀兜底，仍然 success", async () => {
  const plugin = offlinePlugin({ name: "" })
  const method = plugin.auth.methods[0]
  const auth = await method.authorize()
  const result = await auth.callback()
  expect(result.type).toBe("success")
  expect(result.name).toMatch(/^Google 账号 \(.+\)$/)
  expect(result.accountId).toBe(result.name)
})

test("五分钟没有登录（signIn 返回 null）→ failed，不抛错", async () => {
  const plugin = createPlugin({
    headless: true,
    signInImpl: async () => null,
    pageEmailImpl: async () => "",
    accountNameImpl: async () => "",
  })
  const auth = await plugin.auth.methods[0].authorize()
  const result = await auth.callback()
  expect(result.type).toBe("failed")
  expect(result.error).toContain("五分钟")
})

test("打不开浏览器（signIn 抛错）→ failed，错误信息带上原因", async () => {
  const plugin = createPlugin({
    headless: true,
    signInImpl: async () => {
      throw new Error("没有找到 Chrome")
    },
    pageEmailImpl: async () => "",
    accountNameImpl: async () => "",
  })
  const auth = await plugin.auth.methods[0].authorize()
  const result = await auth.callback()
  expect(result.type).toBe("failed")
  expect(result.error).toContain("没有找到 Chrome")
})

test("访客方式不经过浏览器，直接 success", async () => {
  const plugin = offlinePlugin()
  const auth = await plugin.auth.methods[1].authorize()
  const result = await auth.callback()
  expect(result.type).toBe("success")
  expect(result.access).toBe("anonymous")
})

// the shape magpie itself needs: an oauth method must hand back a callback
test("authorize 给出 host 认得的形状（url/method/docs/instructions/callback）", async () => {
  const plugin = offlinePlugin()
  for (const method of plugin.auth.methods) {
    expect(method.type).toBe("oauth")
    const a = await method.authorize()
    expect(typeof a.callback).toBe("function")
    expect(a.method).toBe("auto")
    expect(typeof a.url).toBe("string")
  }
})

// --- proxy: Chrome does not read HTTPS_PROXY on its own ---------------------
//
// On a network where Google only answers through a local proxy, a launch
// without --proxy-server renders chrome-error://chromewebdata: the sign-in
// window itself still opens (the host's env had HTTPS_PROXY), but every
// page the plugin then reads comes back empty. These pin the rules.
import { proxyArgs, proxyFor } from "./browser.mjs"

test("proxyFor 读标准代理变量，并给裸 host:port 补 scheme", () => {
  expect(proxyFor({})).toBe("")
  expect(proxyFor({ HTTPS_PROXY: "http://127.0.0.1:7890" })).toBe("http://127.0.0.1:7890")
  expect(proxyFor({ https_proxy: "http://127.0.0.1:7890" })).toBe("http://127.0.0.1:7890")
  expect(proxyFor({ ALL_PROXY: "socks5://127.0.0.1:1080" })).toBe("socks5://127.0.0.1:1080")
  expect(proxyFor({ HTTP_PROXY: "127.0.0.1:7890" })).toBe("http://127.0.0.1:7890")
  expect(proxyFor({ HTTPS_PROXY: "  http://127.0.0.1:7890  " })).toBe("http://127.0.0.1:7890")
})

test("GEMINI_RELAY_PROXY 覆盖变量，none/direct 表示直连", () => {
  expect(proxyFor({ HTTPS_PROXY: "http://a:1", GEMINI_RELAY_PROXY: "http://b:2" })).toBe("http://b:2")
  expect(proxyFor({ HTTPS_PROXY: "http://a:1", GEMINI_RELAY_PROXY: "none" })).toBe("")
  expect(proxyFor({ HTTPS_PROXY: "http://a:1", GEMINI_RELAY_PROXY: "direct" })).toBe("")
})

test("proxyArgs 只加 --proxy-server，不覆盖 loopback 直连", () => {
  expect(proxyArgs("")).toEqual([])
  // DevTools lives on 127.0.0.1; Chrome bypasses loopback by default and a
  // bypass override (--proxy-bypass-list=<-loopback>) would break CDP
  expect(proxyArgs("http://127.0.0.1:7890")).toEqual(["--proxy-server=http://127.0.0.1:7890"])
})
