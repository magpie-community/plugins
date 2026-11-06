// A real end-to-end run of the browser sign-in and the silent renewal: the
// "browser" is a tiny compiled Chromium stand-in that serves the DevTools
// HTTP + WebSocket endpoints the plugin speaks, so the actual spawn →
// port-file → CDP cookie read → graceful close → kill path runs here.
import "./nonet.mjs"
import { execSync } from "node:child_process"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { InkStoneAuthPlugin } from "./index.mjs"
import { renewSilently } from "./lib/browser.mjs"
import { fakeInkStone, json, ok } from "./fake.mjs"

let fakeExe = ""
let profile = ""
let f

beforeAll(() => {
  // compile the fake browser once (bun build --compile takes under a second)
  const out = join(mkdtempSync(join(tmpdir(), "inkstone-fake-browser-")), process.platform === "win32" ? "fake-chrome.exe" : "fake-chrome")
  const entry = join(import.meta.dir, "testdata/fake-browser.mjs")
  execSync(`${JSON.stringify(process.execPath)} build --compile ${JSON.stringify(entry)} --outfile ${JSON.stringify(out)}`, { stdio: "pipe" })
  fakeExe = out
  profile = mkdtempSync(join(tmpdir(), "inkstone-fake-profile-"))
  process.env.MAGPIE_INKSTONE_PROFILE = profile
  // the compiled fake has no real window title for waitForConsoleWindow to
  // read: skip straight past the "user typed their password" step. The
  // headless CDP read, the key creation and the close/kill path all still run.
  process.env.MAGPIE_INKSTONE_LOGIN_EXIT = "1"
  // a displayless CI runner refuses the browser sign-in up front unless a
  // display is claimed; the fake browser does not need a real one
  process.env.DISPLAY = process.env.DISPLAY || ":99"
})

afterAll(() => {
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {}
})

afterEach(() => {
  f?.close()
  f = undefined
})

function serveKeyRoutes() {
  const keys = []
  f.route("GET /api/tokenplan/v1/keys", () => ok({ total: keys.length, items: keys }))
  f.route("POST /api/tokenplan/v1/keys", (r) => {
    keys.push({ id: `id-${keys.length + 1}`, name: r.json?.name, status: "active", created_at: new Date().toISOString() })
    return ok({ key: "sk-new" })
  })
  f.route("DELETE /api/tokenplan/v1/keys", () => ok({}))
  f.route("GET /v1/models", () => json({ object: "list", data: [] }))
  f.route("GET /api/tokenplan/v1/users/validate", () => ok({ name: "张三", phone: "12345678901" }))
  f.route("POST /api/tokenplan/v1/users/free-grant", () => ok({ has_received: true }))
  return keys
}

test("the silent renewal reads the session cookie through a real CDP exchange", async () => {
  // the profile already exists from beforeAll; the fake browser serves the
  // DevTools endpoints and answers Network.getAllCookies
  const token = await renewSilently({ browserPath: fakeExe, log: (m) => console.log("[renew]", m) })
  expect(token).toBe("fake-uaa-token-for-tests")
  // a second renewal works too: the fake browser was closed and the profile is reusable
  expect(await renewSilently({ browserPath: fakeExe })).toBe("fake-uaa-token-for-tests")
}, 30_000)

test("a full browser sign-in opens the login window, reads the session, and creates the key", async () => {
  f = fakeInkStone()
  const keys = serveKeyRoutes()
  const p = await InkStoneAuthPlugin(
    { client: { auth: { set: async () => {} }, app: { log: (b) => console.log("[log]", b?.body?.message ?? "") } } },
    { browser: fakeExe, loginTimeoutMs: 30_000, keep_sign_in: false },
  )
  const browser = p.auth.methods[0]
  const result = browser.authorize({})
  expect(result.method).toBe("auto")
  const saved = await result.callback("", {})
  expect(saved.type).toBe("success")
  expect(saved.uaaToken).toBe("fake-uaa-token-for-tests")
  // the plugin created the key on the (fake) console and kept its plaintext
  expect(saved.apiKey).toBe("sk-new")
  expect(keys.length).toBe(1)
  expect(keys[0].name.startsWith("ink-")).toBe(true)
}, 40_000)

test("a second browser sign-in stays inside the key budget instead of piling up", async () => {
  f = fakeInkStone()
  const keys = serveKeyRoutes()
  const p = await InkStoneAuthPlugin(
    { client: { auth: { set: async () => {} }, app: { log: (b) => console.log("[log]", b?.body?.message ?? "") } } },
    { browser: fakeExe, loginTimeoutMs: 30_000, keep_sign_in: false },
  )
  const browser = p.auth.methods[0]
  const first = await browser.authorize({}).callback("", {})
  expect(first.apiKey).toBe("sk-new")
  const second = await browser.authorize({}).callback("", {})
  expect(second.type).toBe("success")
  // default-on pruning keeps our own prefix at the newest two: the account's
  // 10-key budget is never reached through repeated sign-ins
  expect(keys.length).toBe(2)
  expect(keys.every((k) => k.name.startsWith("ink-"))).toBe(true)
}, 60_000)
