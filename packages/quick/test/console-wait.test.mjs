// waitForConsoleWindow's completion signal for the one-click sign-in.
// On Windows the profile's Cookies db is held with an exclusive handle by
// the running browser (verified live: every copy attempt while the window
// runs is EBUSY), so the window title is what completes the wait. The
// signed-out landing page settles on "AWS Quick - …" and the signed-in
// console on "Home - …" (both verified live) — a settled title that is
// neither a sign-in page nor the landing page means the console is showing.
// These tests inject titleOf/cookieProbe — no browser, no network.
import { describe, expect, test } from "bun:test"
import { waitForConsoleWindow } from "../lib/browser.mjs"

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
  test("a settled signed-in console title completes the wait", async () => {
    let i = 0
    const titles = ["Home - 用户配置 1 - Microsoft Edge", "Home - 用户配置 1 - Microsoft Edge"]
    const how = await run({
      profile: "/unused",
      cookieProbe: () => false,
      titleOf: () => titles[Math.min(i++, titles.length - 1)],
    })
    expect(how).toBe("console")
  })

  test("the signed-out landing page's title never completes the wait", async () => {
    // the original bug: the landing title settled and the window was closed
    // before the user could sign in
    const how = await run({
      profile: "/unused",
      cookieProbe: () => false,
      titleOf: () => "AWS Quick - 用户配置 1 - Microsoft Edge",
      timeoutMs: 700,
    })
    expect(how).toBe("timeout")
  })

  test("a sign-in page's title never completes the wait", async () => {
    const how = await run({
      profile: "/unused",
      cookieProbe: () => false,
      titleOf: () => "登录 - Amazon Web Services",
      timeoutMs: 700,
    })
    expect(how).toBe("timeout")
  })

  test("a flapping title (page still loading) does not complete the wait", async () => {
    let i = 0
    const how = await run({
      profile: "/unused",
      cookieProbe: () => false,
      titleOf: () => `Home - 第 ${i++} 次加载 - Microsoft Edge`,
      timeoutMs: 700,
    })
    expect(how).toBe("timeout")
  })

  test("the landing title -> console title transition completes the wait", async () => {
    const seq = ["AWS Quick - 用户配置 1 - Microsoft Edge", "Home - 用户配置 1 - Microsoft Edge"]
    let i = 0
    const how = await run({
      profile: "/unused",
      cookieProbe: () => false,
      titleOf: () => seq[Math.min(i++, seq.length - 1)],
      timeoutMs: 2000,
    })
    expect(how).toBe("console")
  })

  test("off Windows a fresh session row completes the wait", async () => {
    const how = await run({
      platform: "linux",
      profile: "/unused",
      cookieProbe: () => true,
      titleOf: () => "",
    })
    expect(how).toBe("console")
  })

  test("off Windows the previous sign-in's rows (probe false) do not complete the wait", async () => {
    const how = await run({
      platform: "linux",
      profile: "/unused",
      cookieProbe: () => false,
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
