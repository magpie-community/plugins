// A real end-to-end run of the MOSS browser sign-in and the silent renewal:
// the "browser" is a tiny compiled Chromium stand-in that serves the DevTools
// HTTP + WebSocket endpoints the plugin speaks, so the actual spawn →
// DevToolsActivePort → CDP cookie read → graceful close → key creation path
// runs here. No real browser, no real network (nonet.mjs + the fake below).
import "./nonet.mjs"
import "./safe-browser.mjs" // first: any real-browser spawn throws instead of opening a window
import { execSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, renameSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { MossPlugin } from "./index.mjs"
import { renewSilently, signInWithBrowser } from "./lib/browser.mjs"
import { fakeMoss, json, meBody, usageSummaryBody } from "./fake.mjs"

let fakeExe = ""
let fakeDir = ""
let profile = ""
const savedEnv = {}
let f

beforeAll(() => {
  // compile the fake browser once (bun build --compile takes under a second).
  // The exe goes to a FIXED path keyed by the source's hash, not a fresh
  // mkdtemp every run: Windows Defender allows an exe by its path, so a
  // randomly named one pops the firewall prompt on every run (and every run
  // of every contributor's machine). Same bytes → same path → prompted once.
  // Rebuilt only when testdata/fake-browser.mjs changes.
  const entry = join(import.meta.dir, "testdata/fake-browser.mjs")
  const { createHash } = require("node:crypto")
  const { userInfo } = require("node:os")
  let user = ""
  try {
    user = userInfo().username.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16) || "u"
  } catch {
    user = (process.env.USER || process.env.USERNAME || "u").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16)
  }
  const key = createHash("sha256").update(readFileSync(entry)).digest("hex").slice(0, 12)
  // A tree fingerprint: both the exe path and the sweep are scoped to THIS
  // checkout (import.meta.dir), so a concurrent run of another tree with the
  // same user and source hash cannot collide. Older hashes of this same tree
  // are removed, so a source change does not pile up ~60 MB directories.
  const tree = createHash("sha256").update(import.meta.dir).digest("hex").slice(0, 8)
  const name = `moss-fake-browser-${user}-${tree}-${key}`
  fakeDir = join(tmpdir(), name)
  mkdirSync(fakeDir, { recursive: true })
  const owned = `moss-fake-browser-${user}-${tree}-`
  for (const sibling of existsSync(tmpdir()) ? readdirSync(tmpdir()) : []) {
    if (sibling.startsWith(owned) && sibling !== name) {
      try {
        rmSync(join(tmpdir(), sibling), { recursive: true, force: true })
      } catch {}
    }
  }
  const exeName = process.platform === "win32" ? "fake-chrome.exe" : "fake-chrome"
  const out = join(fakeDir, exeName)
  if (!existsSync(out)) {
    // bun build --compile appends its own .exe on Windows, so the temp name
    // is computed after the build. The pid suffix keeps two concurrent runs
    // of the same source from racing on one temp file.
    const tmpOut = join(fakeDir, `${exeName}.building-${process.pid}`)
    execSync(`${JSON.stringify(process.execPath)} build --compile ${JSON.stringify(entry)} --outfile ${JSON.stringify(tmpOut)}`, { stdio: "pipe" })
    const built = existsSync(tmpOut) ? tmpOut : join(fakeDir, `${exeName}.building-${process.pid}.exe`)
    renameSync(built, out)
  }
  fakeExe = out
  profile = mkdtempSync(join(tmpdir(), "moss-fake-profile-"))
  // save what we override: bun test runs every file in one process, so these
  // would leak into whatever test file runs next
  for (const k of ["MAGPIE_MOSS_PROFILE", "MAGPIE_MOSS_BROWSER", "FAKE_BROWSER_HOLD_COOKIE", "DISPLAY"]) {
    savedEnv[k] = process.env[k]
  }
  process.env.MAGPIE_MOSS_PROFILE = profile
  delete process.env.MAGPIE_MOSS_BROWSER
  delete process.env.FAKE_BROWSER_HOLD_COOKIE
  // a displayless CI runner refuses the browser sign-in up front unless a
  // display is claimed; the fake browser does not need a real one
  process.env.DISPLAY = process.env.DISPLAY || ":99"
})

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {}
  // the profile is per-run; the compiled fake browser is not (fixed path,
  // rebuilt only when its source changes), so removing it here would make
  // every run recompile and re-prompt the firewall on Windows
})

afterEach(() => {
  f?.close()
  f = undefined
})

/** The plugin configured for the fake browser, with logs surfaced for debugging. */
async function pluginWithFakeBrowser(options = {}) {
  return MossPlugin(
    { client: { auth: { set: async () => {} }, app: { log: (b) => console.log("[log]", b?.body?.message ?? "") } } },
    { browser: fakeExe, loginTimeoutMs: 30_000, ...options },
  )
}

/** Portal + API routes the sign-in callback needs (keys list/create/delete, me). */
function serveKeyRoutes() {
  const keys = []
  f.route("GET /portal-api/api_keys", () => json({ items: keys, total: keys.length }))
  f.route("POST /portal-api/api_keys", (r) => {
    const row = {
      id: String(keys.length + 1),
      name: r.json?.name,
      api_key: "sk-****new",
      status: "active",
      created_at: new Date().toISOString(),
    }
    keys.push(row)
    return json({ ...row, api_key: "sk-new-plaintext" })
  })
  for (let i = 1; i <= 12; i++) {
    f.route(`DELETE /portal-api/api_keys/${i}`, () => {
      const at = keys.findIndex((k) => k.id === String(i))
      if (at >= 0) keys.splice(at, 1)
      return json({ ok: true })
    })
  }
  f.route("GET /v1/models", () => json({ object: "list", data: [{ id: "nex-n2.6" }] }))
  f.route("GET /portal-api/me", () => json(meBody()))
  f.route("GET /portal-api/maas/credits/usage-summary", () => json(usageSummaryBody()))
  return keys
}

test("the silent renewal reads the console session through a real CDP exchange", async () => {
  const token = await renewSilently({ browserPath: fakeExe, log: (m) => console.log("[renew]", m) })
  expect(token).toBe("fake-moss-console-token")
  // a second renewal works too: the fake browser was closed and the profile is reusable
  expect(await renewSilently({ browserPath: fakeExe })).toBe("fake-moss-console-token")
}, 30_000)

test("a full browser sign-in reads the session, validates the account, and creates the key", async () => {
  f = fakeMoss()
  const keys = serveKeyRoutes()
  const p = await pluginWithFakeBrowser()
  const browser = p.auth.methods[0]
  const result = browser.authorize({})
  expect(result.method).toBe("auto")
  const saved = await result.callback("", {})
  expect(saved.type).toBe("success")
  expect(saved.consoleToken).toBe("fake-moss-console-token")
  // the plugin created the key on the (fake) console and kept its plaintext
  expect(saved.apiKey).toBe("sk-new-plaintext")
  expect(saved.username).toBe("张三")
  expect(keys.length).toBe(1)
  expect(keys[0].name.startsWith("moss-")).toBe(true)
}, 60_000)

test("a renewed token is written back under metadata, where magpie saves an api entry", async () => {
  f = fakeMoss()
  serveKeyRoutes()
  const writes = []
  const p = await MossPlugin(
    { client: { auth: { set: async (req) => writes.push(structuredClone(req.body)) } } },
    { browser: fakeExe },
  )
  const saved = { type: "api", key: "sk-test", metadata: { apiKey: "sk-test", consoleToken: "expired-token" } }
  // the expired token makes usage-summary 403 → one silent renewal → retry
  f.route("GET /portal-api/maas/credits/usage-summary", (r) =>
    r.headers.get("cookie")?.includes("expired-token") ? json({ message: "unauthorized" }, 401) : json(usageSummaryBody()),
  )
  const card = await p.auth.usage(async () => saved)
  expect(card.error).toBeUndefined()
  expect(card.balance).toContain("1,200.00")
  expect(writes).toEqual([
    { type: "api", key: "sk-test", metadata: { apiKey: "sk-test", consoleToken: "fake-moss-console-token" } },
  ])
}, 30_000)

test("off Windows the production wiring closes the window on a new cookie", async () => {
  // the real signInWithBrowser path with NO injected probe — launch baseline
  // → the real sqlite probe → "console". The stand-in writes its session row
  // ~300 ms in, and the wait must see it through the production wiring.
  if (process.platform === "win32") return // the title wait runs there instead
  f = fakeMoss()
  serveKeyRoutes()
  try {
    rmSync(join(profile, "Default", "Cookies"), { force: true })
  } catch {}
  const logs = []
  const token = await signInWithBrowser({
    browserPath: fakeExe,
    keepSignIn: true,
    timeoutMs: 6000,
    loginWait: { platform: "linux", pollMs: 50 },
    log: (...args) => logs.push(args.map(String).join(" ")),
  })
  expect(token).toBe("fake-moss-console-token")
  expect(logs.some((l) => l.includes("login window finished (console)"))).toBe(true)
}, 30_000)
test("off Windows an old cookie in the kept profile is not this sign-in", async () => {
  // keep_sign_in's profile carries the previous session row. The launch
  // baseline must keep it from counting as "this sign-in finished". The
  // stand-in writes no new cookie in this run (FAKE_BROWSER_HOLD_COOKIE).
  if (process.platform === "win32") return
  f = fakeMoss()
  serveKeyRoutes()
  try {
    rmSync(join(profile, "Default", "Cookies"), { force: true })
  } catch {}
  mkdirSync(join(profile, "Default"), { recursive: true })
  const { Database } = require("bun:sqlite")
  const db = new Database(join(profile, "Default", "Cookies"))
  db.query("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, creation_utc INTEGER, last_update_utc INTEGER, expires_utc INTEGER)").run()
  const old = (Date.now() - 3600_000 + 11644473600000) * 1000
  db.query(
    "INSERT INTO cookies (host_key, name, value, creation_utc, last_update_utc, expires_utc) VALUES ('.mosi.cn', 'moss_studio_prod_access_token', 'old', ?, ?, ?)",
  ).run(old, old, old + 86400_000_000)
  db.close()
  process.env.FAKE_BROWSER_HOLD_COOKIE = "1"
  const logs = []
  try {
    await signInWithBrowser({
      browserPath: fakeExe,
      keepSignIn: true,
      timeoutMs: 2500,
      loginWait: { platform: "linux", pollMs: 50 },
      log: (...args) => logs.push(args.map(String).join(" ")),
    }).catch(() => "")
    expect(logs.some((l) => l.includes("login window finished (console)"))).toBe(false)
  } finally {
    delete process.env.FAKE_BROWSER_HOLD_COOKIE
    try {
      rmSync(join(profile, "Default", "Cookies"), { force: true })
    } catch {}
  }
}, 30_000)
