import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { browserArgs, findBrowser, profileRoot, seuCookies, signIn, renew } from "./browser.mjs"

// fakeOpener 造一个假浏览器句柄：cookies 按 script 依次吐出（吐完给 {})，
// close 记在 closed。open 收到 (profile, url, opts) 记进 opened。
function fakeOpener(script) {
  const opened = []
  let closed = false
  const handle = {
    get exited() {
      return script.exited?.() ?? false
    },
    cookies: async () => script.cookies.shift() ?? {},
    close: async () => {
      closed = true
    },
  }
  const opener = async (profile, url, opts = {}) => {
    opened.push({ profile, url, opts })
    return handle
  }
  return { opener, opened, get closed() {
    return closed
  }, handle }
}

const verifyOK = (c) => (c && c.SESSION ? { uid: "1", name: "某人" } : null)

test("browserArgs：专属 profile、回环 DevTools、续期时无头", () => {
  const args = browserArgs("/tmp/profile", 9223, "https://example.com/login")
  assert.ok(args.includes("--user-data-dir=/tmp/profile"))
  assert.ok(args.includes("--remote-debugging-port=9223"))
  assert.ok(args.includes("--remote-debugging-address=127.0.0.1"))
  assert.ok(args.includes("--new-window"))
  assert.equal(args.at(-1), "https://example.com/login")
  const headless = browserArgs("/tmp/profile", 9223, "https://example.com/chat", { headless: true })
  assert.ok(headless.includes("--headless=new"))
  assert.ok(!headless.includes("--new-window"))
})

test("profileRoot：Windows 在 LOCALAPPDATA，其它在 ~/.config，可用 SEU_CHAT_PROFILE 覆盖", () => {
  assert.equal(
    profileRoot({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, "win32"),
    join("C:\\Users\\x\\AppData\\Local", "magpie", "seu-chat-browser"),
  )
  assert.equal(profileRoot({ HOME: "/home/x" }, "linux"), join("/home/x", ".config", "magpie", "seu-chat-browser"))
  assert.equal(profileRoot({ SEU_CHAT_PROFILE: "/elsewhere" }, "win32"), "/elsewhere")
})

test("findBrowser：SEU_CHAT_BROWSER 优先，否则第一个存在的候选", () => {
  const dir = mkdtempSync(join(tmpdir(), "seu-browser-"))
  const exe = join(dir, "Google", "Chrome", "Application", "chrome.exe")
  mkdirSync(join(dir, "Google", "Chrome", "Application"), { recursive: true })
  writeFileSync(exe, "")
  assert.equal(findBrowser("win32", { SEU_CHAT_BROWSER: exe }), exe)
  assert.equal(
    findBrowser("win32", { SEU_CHAT_BROWSER: join(dir, "missing.exe"), PROGRAMFILES: dir, LOCALAPPDATA: dir }),
    exe,
  )
  rmSync(dir, { recursive: true, force: true })
})

test("seuCookies 只留 chatseu.seu.edu.cn 的 cookie，任意 path，去掉前导点", () => {
  assert.deepEqual(
    seuCookies([
      { domain: ".chatseu.seu.edu.cn", name: "A", value: "1", path: "/" },
      { domain: "chatseu.seu.edu.cn", name: "B", value: "2", path: "/api" },
      { domain: "auth.seu.edu.cn", name: "C", value: "3", path: "/" },
    ]),
    { A: "1", B: "2" },
  )
})

test("signIn：验证通过后等 settle 再读一次，关窗，返回 cookies", async () => {
  const script = { cookies: [{ SESSION: "a" }, { SESSION: "b", added: "yes" }] }
  const f = fakeOpener(script)
  const cookies = await signIn("/tmp/profile", { verify: verifyOK, timeout: 5000, poll: 10, settle: 10, opener: f.opener })
  assert.deepEqual(cookies, { SESSION: "b", added: "yes" })
  assert.equal(f.opened.length, 1)
  assert.equal(f.closed, true)
})

test("signIn：窗口被用户关掉就返回 null 并关窗", async () => {
  let exited = false
  const script = {
    exited: () => exited,
    cookies: [{}],
  }
  const f = fakeOpener(script)
  const p = signIn("/tmp/profile", { verify: verifyOK, timeout: 30000, poll: 10, settle: 10, opener: f.opener })
  exited = true
  assert.equal(await p, null)
  assert.equal(f.closed, true)
})

test("signIn：超时返回 null", async () => {
  const f = fakeOpener({ cookies: [{}] })
  assert.equal(await signIn("/tmp/profile", { verify: verifyOK, timeout: 50, poll: 10, settle: 10, opener: f.opener }), null)
  assert.equal(f.closed, true)
})

test("renew：profile 不存在返回 null，存在时无头打开并验证", async () => {
  assert.equal(await renew("/nowhere-at-all", { verify: verifyOK, opener: fakeOpener({}).opener }), null)
  const { opener, opened } = fakeOpener({ cookies: [{ SESSION: "fresh" }] })
  const dir = mkdtempSync(join(tmpdir(), "seu-profile-"))
  const cookies = await renew(dir, { verify: verifyOK, timeout: 2000, poll: 10, settle: 10, opener })
  assert.deepEqual(cookies, { SESSION: "fresh" })
  assert.equal(opened[0].opts.headless, true)
  rmSync(dir, { recursive: true, force: true })
})

test("signIn：窗口停在站外域名超过 stuckMs → 提前返回 null，不空等 5 分钟", async () => {
  let t = 0
  const opener = async () => ({
    exited: false,
    cookies: async () => ({}),
    urls: async () => ["https://example.org/login"],
    close: async () => {},
  })
  const progress = []
  const r = await signIn("/nonexistent", {
    verify: async () => false,
    opener,
    stuckMs: 1000,
    timeout: 60_000,
    poll: 100,
    sleep: async (ms) => { t += ms },
    now: () => t,
    onProgress: (msg) => progress.push(msg),
  })
  assert.equal(r, null)
  assert.ok(progress.some((m) => m.includes("example.org")), "报出停在哪")
})
