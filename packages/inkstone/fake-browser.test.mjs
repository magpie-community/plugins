// A real end-to-end run of the browser sign-in and the silent renewal: the
// "browser" is a tiny compiled Chromium stand-in that serves the DevTools
// HTTP + WebSocket endpoints the plugin speaks, so the actual spawn →
// port-file → CDP cookie read → graceful close → key creation path runs here.
import "./nonet.mjs"
import { execSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, renameSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { InkStoneAuthPlugin } from "./index.mjs"
import { renewSilently, signInWithBrowser } from "./lib/browser.mjs"
import { fakeInkStone, json, ok, fail, jwtOf, poolUsageFixture, packagesFixture } from "./fake.mjs"

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
  //
  // The dir is per-user (`os.userInfo().username`): a fixed name in the
  // shared /tmp could be pre-created by another user on a Linux CI runner.
  // A half-written build never parks at the final name — the compile goes to
  // a temp name (pid-suffixed: two concurrent runs of the same source would
  // otherwise race on it) that is renamed over, so `existsSync(out)` below
  // is only true of a complete exe. Older builds (a different hash, left by
  // a previous version of testdata/fake-browser.mjs) are removed here, so
  // a change to the source does not accumulate ~60 MB directories.
  const entry = join(import.meta.dir, "testdata/fake-browser.mjs")
  const { createHash } = require("node:crypto")
  const { userInfo } = require("node:os")
  let user = ""
  try {
    user = userInfo().username.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16) || "u"
  } catch {
    user = process.env.USER || process.env.USERNAME || "u"
    user = user.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16) || "u"
  }
  const key = createHash("sha256").update(readFileSync(entry)).digest("hex").slice(0, 12)
  fakeDir = join(tmpdir(), `inkstone-fake-browser-${user}-${key}`)
  mkdirSync(fakeDir, { recursive: true })
  // siblings: same user, another source hash — a previous build, never the
  // concurrent one (its hash is ours)
  for (const sibling of existsSync(tmpdir()) ? readdirSync(tmpdir()) : []) {
    if (sibling.startsWith(`inkstone-fake-browser-${user}-`) && sibling !== `inkstone-fake-browser-${user}-${key}`) {
      try {
        rmSync(join(tmpdir(), sibling), { recursive: true, force: true })
      } catch {}
    }
  }
  const exeName = process.platform === "win32" ? "fake-chrome.exe" : "fake-chrome"
  const out = join(fakeDir, exeName)
  if (!existsSync(out)) {
    // bun build --compile appends its own .exe on Windows, so the temp name
    // is computed after the build: look for whatever `*.building-<pid>*`
    // came out. The pid suffix keeps two concurrent runs of the same source
    // from racing on one temp file.
    const tmpOut = join(fakeDir, `${exeName}.building-${process.pid}`)
    execSync(`${JSON.stringify(process.execPath)} build --compile ${JSON.stringify(entry)} --outfile ${JSON.stringify(tmpOut)}`, { stdio: "pipe" })
    const built = existsSync(tmpOut) ? tmpOut : join(fakeDir, `${exeName}.building-${process.pid}.exe`)
    renameSync(built, out)
  }
  fakeExe = out
  profile = mkdtempSync(join(tmpdir(), "inkstone-fake-profile-"))
  // save what we override: bun test runs every file in one process, so these
  // would leak into whatever test file runs next
  for (const key of ["MAGPIE_INKSTONE_PROFILE", "MAGPIE_INKSTONE_BROWSER", "MAGPIE_INKSTONE_LOGIN_EXIT", "FAKE_BROWSER_HOLD_COOKIE", "DISPLAY"]) {
    savedEnv[key] = process.env[key]
  }
  process.env.MAGPIE_INKSTONE_PROFILE = profile
  delete process.env.MAGPIE_INKSTONE_BROWSER
  delete process.env.MAGPIE_INKSTONE_LOGIN_EXIT
  // a displayless CI runner refuses the browser sign-in up front unless a
  // display is claimed; the fake browser does not need a real one
  process.env.DISPLAY = process.env.DISPLAY || ":99"
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
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
  return InkStoneAuthPlugin(
    { client: { auth: { set: async () => {} }, app: { log: (b) => console.log("[log]", b?.body?.message ?? "") } } },
    { browser: fakeExe, loginTimeoutMs: 30_000, waitForLogin: async () => "console", ...options },
  )
}

function serveKeyRoutes() {
  const keys = []
  f.route("GET /api/tokenplan/v1/keys", () => ok({ total: keys.length, items: keys }))
  f.route("POST /api/tokenplan/v1/keys", (r) => {
    keys.push({ id: `id-${keys.length + 1}`, name: r.json?.name, status: "active", created_at: new Date().toISOString() })
    return ok({ key: "sk-new" })
  })
  f.route("DELETE /api/tokenplan/v1/keys", () => ok({}))
  // the fake routes are exact-match; deleteKey uses /keys/<id>
  for (let i = 1; i <= 12; i++) {
    f.route(`DELETE /api/tokenplan/v1/keys/id-${i}`, (r) => {
      const id = r.url.split("/").pop()
      const at = keys.findIndex((k) => k.id === id)
      if (at >= 0) keys.splice(at, 1)
      return ok({})
    })
  }
  f.route("GET /v1/models", () => json({ object: "list", data: [] }))
  f.route("GET /api/tokenplan/v1/users/validate", () => ok({ name: "张三", phone: "12345678901" }))
  f.route("POST /api/tokenplan/v1/users/free-grant", () => ok({ has_received: true }))
  return keys
}

test("the silent renewal reads the session cookie through a real CDP exchange", async () => {
  const token = await renewSilently({ browserPath: fakeExe, log: (m) => console.log("[renew]", m) })
  expect(token).toBe("fake-uaa-token-for-tests")
  // a second renewal works too: the fake browser was closed and the profile is reusable
  expect(await renewSilently({ browserPath: fakeExe })).toBe("fake-uaa-token-for-tests")
}, 30_000)

test("a renewed token is written back where the api entry keeps it, under metadata", async () => {
  f = fakeInkStone()
  f.route("GET /api/tokenplan/v1/credits/balance", () => ok(poolUsageFixture()))
  f.route("GET /api/tokenplan/v1/credits/packages", () => ok(packagesFixture()))
  f.route("GET /api/tokenplan/v1/users/validate", () => ok({ name: "张三", phone: "12345678901" }))
  const writes = []
  const p = await InkStoneAuthPlugin(
    { client: { auth: { set: async (req) => writes.push(structuredClone(req.body)) } } },
    { browser: fakeExe },
  )
  const expired = jwtOf({ exp: Math.floor(Date.now() / 1000) - 60 })
  const saved = { type: "api", key: "sk-test", metadata: { apiKey: "sk-test", uaaToken: expired } }
  const u = await p.auth.usage(async () => saved)
  expect(u.error).toBeUndefined()
  expect(writes).toEqual([
    { type: "api", key: "sk-test", metadata: { apiKey: "sk-test", uaaToken: "fake-uaa-token-for-tests" } },
  ])
}, 30_000)

test("a full browser sign-in opens the login window, reads the session, and creates the key", async () => {
  f = fakeInkStone()
  const keys = serveKeyRoutes()
  const p = await pluginWithFakeBrowser()
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
  // the login window was closed gracefully: the fake records the signal it
  // received. On Windows the escalation is TerminateProcess, which nothing
  // can catch — the marker is absent there by design. Everywhere else the
  // marker's existence is the proof that no SIGKILL was needed.
  const marker = join(profile, "close-signal.txt")
  if (process.platform !== "win32") {
    expect(readFileSync(marker, "utf8")).toBe("SIGTERM")
  } else if (existsSync(marker)) {
    expect(readFileSync(marker, "utf8")).toBe("SIGTERM")
  }
}, 60_000)

test("repeated sign-ins stay inside the key budget: the newest two remain, the rest go", async () => {
  f = fakeInkStone()
  const keys = serveKeyRoutes()
  const p = await pluginWithFakeBrowser()
  const browser = p.auth.methods[0]
  for (let i = 0; i < 3; i++) {
    const saved = await browser.authorize({}).callback("", {})
    expect(saved.type).toBe("success")
    expect(saved.apiKey).toBe("sk-new")
  }
  // three created, prune keeps the newest two of this machine/account: the
  // account's 10-key budget is never reached through repeated sign-ins
  expect(keys.length).toBe(2)
  expect(keys.every((k) => k.name.startsWith("ink-"))).toBe(true)
  rmSync(profile, { recursive: true, force: true })
}, 60_000)

test("prune_keys off leaves every key alone, whatever the count", async () => {
  f = fakeInkStone()
  const keys = serveKeyRoutes()
  const p = await pluginWithFakeBrowser({ prune_keys: false })
  const browser = p.auth.methods[0]
  for (let i = 0; i < 3; i++) {
    const saved = await browser.authorize({}).callback("", {})
    expect(saved.type).toBe("success")
  }
  expect(keys.length).toBe(3)
}, 60_000)

test("the reuse method keeps a pasted key instead of creating one", async () => {
  f = fakeInkStone()
  const keys = serveKeyRoutes()
  const p = await pluginWithFakeBrowser()
  const reuse = p.auth.methods[1]
  expect(reuse.label).toContain("reuse")
  const saved = await reuse.authorize({ apiKey: "sk-pasted" }).callback("", {})
  expect(saved.type).toBe("success")
  expect(saved.apiKey).toBe("sk-pasted")
  // the pasted key is kept: nothing was created on the console
  expect(keys.length).toBe(0)
}, 60_000)

test("off Windows the production wiring closes the window on a new cookie", async () => {
  // B4: the real signInWithBrowser path (baseline → probe → close), with the
  // sqlite probe injected so the test does not depend on where a compiled
  // Chromium stand-in happens to write its profile on each OS. Removing the
  // cookieProbe wiring from signInWithBrowser makes the wait ignore the
  // injected probe and end on the child's exit, not "console" — this goes red.
  f = fakeInkStone()
  serveKeyRoutes()
  const logs = []
  let probes = 0
  const token = await signInWithBrowser({
    browserPath: fakeExe,
    keepSignIn: true,
    timeoutMs: 6000,
    loginWait: {
      platform: "linux",
      pollMs: 50,
      cookieProbe: () => ++probes >= 3,
    },
    log: (...args) => logs.push(args.map(String).join(" ")),
  })
  expect(token).toBe("fake-uaa-token-for-tests")
  expect(logs.some((l) => l.includes("login window finished (console)"))).toBe(true)
  expect(logs.some((l) => l.includes("cookie store"))).toBe(true)
  expect(probes).toBeGreaterThanOrEqual(3)
}, 30_000)

test("off Windows an old cookie in the kept profile is not this sign-in", async () => {
  // B1 end-to-end with the real sqlite probe: keep_sign_in's profile carries
  // the previous uaa-token. The launch baseline must keep it from counting as
  // "console" (if the baseline is dropped, this immediately sees "console"
  // and goes red). The stand-in writes no new cookie in this run.
  f = fakeInkStone()
  serveKeyRoutes()
  try { rmSync(join(profile, "Default", "Cookies"), { force: true }) } catch {}
  mkdirSync(join(profile, "Default"), { recursive: true })
  const { Database } = require("bun:sqlite")
  const db = new Database(join(profile, "Default", "Cookies"))
  db.query("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, creation_utc INTEGER, last_update_utc INTEGER, expires_utc INTEGER)").run()
  const old = (Date.now() - 3600_000 + 11644473600000) * 1000
  db.query(
    "INSERT INTO cookies (host_key, name, value, creation_utc, last_update_utc, expires_utc) VALUES ('.intern-ai.org.cn', 'uaa-token', 'old', ?, ?, ?)",
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
    try { rmSync(join(profile, "Default", "Cookies"), { force: true }) } catch {}
  }
}, 30_000)
