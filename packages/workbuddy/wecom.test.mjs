// The sign-in page is opened with the desktop app's version, as WorkBuddy
// desktop opens it. WorkBuddy's China login page (www.workbuddy.cn/login)
// shows 企业微信 (WeCom) only to platform workbuddy at version 5.8.0 or
// later, so a lower version leaves a WeCom user no way to sign in
// (shenyebuwu on Discord).
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const opened = async (id) => {
  globalThis.fetch = async (url) => {
    const u = new URL(String(url))
    const data = u.pathname.endsWith("/auth/state")
      ? { state: "s", authUrl: `https://www.workbuddy.cn/login?platform=${id}&state=s` }
      : {}
    return new Response(JSON.stringify({ code: 0, data }))
  }
  return new URL((await _internal.browserSignIn(_internal.SITES[id])).url)
}

// the page's own check (signin-callback: en(version, "5.8.0"))
const atLeast = (v, min) => {
  const a = v.split(".").map(Number), b = min.split(".").map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return true
}

for (const id of ["workbuddy", "workbuddy-ai"]) {
  test(`${id}'s sign-in page is opened with the desktop app's version`, async () => {
    const url = await opened(id)
    expect(url.searchParams.get("version")).toBe(_internal.SITES[id].app)
    expect(url.searchParams.get("platform")).toBe(id)
    expect(url.searchParams.get("state")).toBe("s")
  })
}

test("the China build's page is opened at a version that shows WeCom", async () => {
  const url = await opened("workbuddy")
  expect(atLeast(url.searchParams.get("version"), "5.8.0")).toBe(true)
})
