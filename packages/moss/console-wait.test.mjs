// waitForConsoleWindow's completion signal. On Windows the profile's cookie
// store is usually locked by the running browser (an exclusive handle), so
// the window title is what actually completes the wait: a title that settles
// on a console page (any business page, e.g. "API Key - 用户配置 1") and is
// not a login/SSO page. These tests inject titleOf/cookieProbe — no browser.
import "./nonet.mjs"
import { describe, expect, test } from "bun:test"
import { waitForConsoleWindow } from "./lib/browser.mjs"

/** A child that stays "running" for the test. */
const liveChild = () => ({ pid: 4242, exitCode: null, signalCode: null })

const run = (opts) =>
  waitForConsoleWindow(liveChild(), {
    timeoutMs: 4000,
    pollMs: 20,
    settleMs: 0,
    platform: "win32",
    ...opts,
  })

describe("waitForConsoleWindow (Windows title signal)", () => {
  test("a settled console-page title completes the wait even when the cookie probe is silent", async () => {
    // the live failure: Edge holds the Cookies db exclusively, probe always []
    const titles = ["API Key - 用户配置 1 - Microsoft Edge", "API Key - 用户配置 1 - Microsoft Edge"]
    let i = 0
    const how = await run({
      profile: "/unused",
      cookieProbe: () => false,
      titleOf: () => titles[Math.min(i++, titles.length - 1)],
    })
    expect(how).toBe("console")
  })

  test("a login/SSO page title never completes the wait", async () => {
    let i = 0
    const how = await run({
      profile: "/unused",
      cookieProbe: () => false,
      titleOf: () => (i++ < 40 ? `账号登录 - 用户认证 - Microsoft Edge ${i}` : "账号登录 - 用户认证"),
      timeoutMs: 700,
    })
    expect(how).toBe("timeout")
  })

  test("a flapping title (page still loading) does not complete the wait", async () => {
    let i = 0
    const how = await run({
      profile: "/unused",
      cookieProbe: () => false,
      titleOf: () => `API Key - 第 ${i++} 次加载 - Microsoft Edge`,
      timeoutMs: 700,
    })
    expect(how).toBe("timeout")
  })

  test("a fresh session row in the profile completes the wait on any platform", async () => {
    const how = await run({
      platform: "linux",
      profile: "/unused",
      cookieProbe: () => true,
      titleOf: () => "",
    })
    expect(how).toBe("console")
  })

  test("the previous sign-in's rows (probe false) do not complete the wait", async () => {
    const how = await run({
      platform: "linux",
      profile: "/unused",
      cookieProbe: () => false,
      titleOf: () => "",
      timeoutMs: 600,
    })
    expect(how).toBe("timeout")
  })

  test("an exiting browser ends the wait as 'closed'", async () => {
    const how = await waitForConsoleWindow(
      { pid: 1, exitCode: 0, signalCode: null },
      { timeoutMs: 4000, pollMs: 20, settleMs: 0, platform: "win32", profile: "/unused", cookieProbe: () => false },
    )
    expect(how).toBe("closed")
  })

  test("an aborted signal ends the wait as 'aborted'", async () => {
    const controller = new AbortController()
    controller.abort()
    const how = await run({ profile: "/unused", cookieProbe: () => false, signal: controller.signal, titleOf: () => "" })
    expect(how).toBe("aborted")
  })
})
