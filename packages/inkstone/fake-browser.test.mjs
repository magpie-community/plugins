// A real end-to-end run of the browser sign-in and the silent renewal: the
// "browser" is a tiny compiled Chromium stand-in that serves the DevTools
// HTTP + WebSocket endpoints the plugin speaks, so the actual spawn →
// port-file → CDP cookie read → graceful close → key creation path runs here.
import "./nonet.mjs"
import { execSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, renameSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { InkStoneAuthPlugin } from "./index.mjs"
import { accountProfileDir, renewSilently, signInWithBrowser } from "./lib/browser.mjs"
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
  // A tree fingerprint: both the exe path and the sweep are scoped to THIS
  // checkout (import.meta.dir). Without it, a concurrent run of another tree
  // with the same user and source hash lands on the same dir, and this sweep
  // could delete the other tree's build mid-run (the review's point). Older
  // hashes of this same tree are still removed, so a source change does not
  // pile up ~60 MB directories.
  const tree = createHash("sha256").update(import.meta.dir).digest("hex").slice(0, 8)
  const name = `inkstone-fake-browser-${user}-${tree}-${key}`
  fakeDir = join(tmpdir(), name)
  mkdirSync(fakeDir, { recursive: true })
  // siblings: same user AND same tree, another source hash — a previous build
  // of this checkout, never a concurrent run of a different tree
  const owned = `inkstone-fake-browser-${user}-${tree}-`
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
  for (const key of ["MAGPIE_INKSTONE_PROFILE", "MAGPIE_INKSTONE_BROWSER", "MAGPIE_INKSTONE_LOGIN_EXIT", "FAKE_BROWSER_HOLD_COOKIE", "FAKE_BROWSER_COOKIE_VALUE", "FAKE_BROWSER_FOREIGN_COOKIE", "DISPLAY"]) {
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
    // the tests create accounts/ under the same parent; leave the temp dir as
    // they found it (an empty parent would outlive the run otherwise)
    rmSync(join(profile, "..", "inkstone-browser-accounts"), { recursive: true, force: true })
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
async function pluginWithFakeBrowser(options = {}, magpie = undefined) {
  const logs = []
  const p = await InkStoneAuthPlugin(
    {
      client: {
        auth: { set: async () => {} },
        app: {
          log: (b) => {
            const message = b?.body?.message ?? ""
            logs.push(message)
            console.log("[log]", message)
          },
        },
      },
      ...(magpie ? { magpie } : {}),
    },
    { browser: fakeExe, loginTimeoutMs: 30_000, waitForLogin: async () => "console", ...options },
  )
  p.logs = logs
  return p
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
  // the window path: reuse off, so the sign-in cannot finish on a kept session
  const p = await pluginWithFakeBrowser({ reuse_kept_session: false })
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
  const p = await pluginWithFakeBrowser({ reuse_kept_session: false })
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
  const p = await pluginWithFakeBrowser({ prune_keys: false, reuse_kept_session: false })
  const browser = p.auth.methods[0]
  for (let i = 0; i < 3; i++) {
    const saved = await browser.authorize({}).callback("", {})
    expect(saved.type).toBe("success")
  }
  expect(keys.length).toBe(3)
}, 60_000)

test("with the option on, a browser sign-in finishes on the console session the profile holds", async () => {
  // The wiring through the plugin itself: default config, so the kept-session
  // reuse runs. The headless stand-in serves the token, the fake console's
  // users/validate accepts it — no window, no close signal.
  f = fakeInkStone()
  const keys = serveKeyRoutes()
  const marker = join(profile, "close-signal.txt")
  try { rmSync(marker, { force: true }) } catch {}
  const p = await pluginWithFakeBrowser()
  const saved = await p.auth.methods[0].authorize({}).callback("", {})
  expect(saved.type).toBe("success")
  expect(saved.uaaToken).toBe("fake-uaa-token-for-tests")
  expect(keys.length).toBe(1)
  // the log proves which path ran: reuse announces the account it reused
  expect(p.logs.some((l) => l.includes("reusing the profile's console session"))).toBe(true)
  expect(p.logs.some((l) => l.includes("opening the sign-in window"))).toBe(false)
  // a window would have written the close signal; none opened
  expect(existsSync(marker)).toBe(false)
}, 60_000)

test("with the option off, the same sign-in opens the window instead", async () => {
  // The switch the "add a second account" case relies on: reuse off must
  // always mean a window, even though the profile holds a session the server
  // would accept.
  f = fakeInkStone()
  const keys = serveKeyRoutes()
  const marker = join(profile, "close-signal.txt")
  try { rmSync(marker, { force: true }) } catch {}
  const p = await pluginWithFakeBrowser({ reuse_kept_session: false })
  const saved = await p.auth.methods[0].authorize({}).callback("", {})
  expect(saved.type).toBe("success")
  expect(saved.uaaToken).toBe("fake-uaa-token-for-tests")
  expect(keys.length).toBe(1)
  expect(p.logs.some((l) => l.includes("reusing the profile's console session"))).toBe(false)
  expect(p.logs.some((l) => l.includes("opening the sign-in window"))).toBe(true)
  if (process.platform !== "win32") {
    expect(readFileSync(marker, "utf8")).toBe("SIGTERM")
  }
}, 60_000)

test("a second magpie account signs in on its own clean profile, leaving the kept one alone", async () => {
  // 同一个供应商下加第二个账号：共用 profile 时窗口一打开就是第一个账号的
  // 登录态——不退登登不进去，退登又把第一个账号的会话销毁。magpie 给出的
  // 账号 key 让每个账号各用一个 profile。
  f = fakeInkStone()
  const keys = serveKeyRoutes()
  const marker = join(profile, "legacy-marker.txt")
  writeFileSync(marker, "kept")
  const key = "intern-inkstone#second"
  const own = accountProfileDir(key)
  rmSync(own, { recursive: true, force: true })
  rmSync(join(profile, "close-signal.txt"), { force: true })
  try {
    const p = await pluginWithFakeBrowser({}, { account: () => key })
    const saved = await p.auth.methods[0].authorize({}).callback("", {})
    expect(saved.type).toBe("success")
    expect(keys.length).toBe(1)
    // the window ran in the account's own (new, empty) profile…
    expect(existsSync(join(own, "close-signal.txt"))).toBe(true)
    // …not in the kept one, whose contents were left alone
    expect(existsSync(join(profile, "close-signal.txt"))).toBe(false)
    expect(readFileSync(marker, "utf8")).toBe("kept")
  } finally {
    rmSync(own, { recursive: true, force: true })
    rmSync(marker, { force: true })
  }
}, 60_000)

test("the first magpie account gets its own profile too, not the shared legacy one", async () => {
  // The account key says nothing about which account a shared profile holds:
  // reusing it would complete the sign-in on whoever is logged in there.
  f = fakeInkStone()
  const keys = serveKeyRoutes()
  const marker = join(profile, "legacy-marker.txt")
  writeFileSync(marker, "kept")
  const own = accountProfileDir("intern-inkstone")
  rmSync(own, { recursive: true, force: true })
  rmSync(join(profile, "close-signal.txt"), { force: true })
  try {
    const p = await pluginWithFakeBrowser({}, { account: () => "intern-inkstone" })
    const saved = await p.auth.methods[0].authorize({}).callback("", {})
    expect(saved.type).toBe("success")
    expect(keys.length).toBe(1)
    expect(existsSync(join(own, "close-signal.txt"))).toBe(true)
    expect(existsSync(join(profile, "close-signal.txt"))).toBe(false)
    expect(readFileSync(marker, "utf8")).toBe("kept")
  } finally {
    rmSync(own, { recursive: true, force: true })
    rmSync(marker, { force: true })
  }
}, 60_000)

test("the silent renewal can be pointed at an account's own profile", async () => {
  const own = accountProfileDir("intern-inkstone#renew")
  mkdirSync(own, { recursive: true })
  try {
    expect(await renewSilently({ browserPath: fakeExe, profile: own })).toBe("fake-uaa-token-for-tests")
    // no profile for that account yet: renew nothing rather than the wrong account
    expect(await renewSilently({ browserPath: fakeExe, profile: join(profile, "missing-account") })).toBe("")
  } finally {
    rmSync(own, { recursive: true, force: true })
  }
}, 60_000)

test("adding an account after removing the first one never finishes on the removed account", async () => {
  // magpie hands the provider's own key to the next sign-in when no account
  // holds it: remove the only account, add another, and the key is the same.
  // Its profile still holds the removed account's live session — reusing it
  // would sign the new account in as the removed one, with no window.
  f = fakeInkStone()
  const keys = serveKeyRoutes()
  const key = "intern-inkstone"
  const own = accountProfileDir(key)
  rmSync(own, { recursive: true, force: true })
  mkdirSync(own, { recursive: true })
  writeFileSync(join(own, "removed-account.txt"), "A")
  try {
    const p = await pluginWithFakeBrowser({}, { account: () => key })
    const saved = await p.auth.methods[0].authorize({}).callback("", {})
    expect(saved.type).toBe("success")
    expect(keys.length).toBe(1)
    // a window opened (the user could log in as anyone), the stale session was
    // not reused, and the key's profile is now this sign-in's, not the old one
    expect(p.logs.some((l) => l.includes("reusing the profile's console session"))).toBe(false)
    expect(p.logs.some((l) => l.includes("opening the sign-in window"))).toBe(true)
    expect(existsSync(join(own, "close-signal.txt"))).toBe(true)
    expect(existsSync(join(own, "removed-account.txt"))).toBe(false)
    // no leftover .pending- directory next to it
    expect(readdirSync(join(own, "..")).filter((n) => n.startsWith(".pending-"))).toEqual([])
  } finally {
    rmSync(own, { recursive: true, force: true })
  }
}, 60_000)

test("the production users/validate decides reuse: a 401 opens the window", async () => {
  // The plugin's own validateToken must go through usersValidate: with the
  // console refusing the kept session, reuse has to give way to a window.
  f = fakeInkStone()
  const keys = serveKeyRoutes()
  f.route("GET /api/tokenplan/v1/users/validate", () => json({ code: 401, msg: "unauthorized", data: null }, 401))
  const key = "intern-inkstone#refused-401"
  const own = accountProfileDir(key)
  rmSync(own, { recursive: true, force: true })
  mkdirSync(own, { recursive: true })
  try {
    const p = await pluginWithFakeBrowser({}, { account: () => key })
    const saved = await p.auth.methods[0].authorize({}).callback("", {})
    expect(saved.type).toBe("success")
    expect(keys.length).toBe(1)
    expect(p.logs.some((l) => l.includes("is no longer accepted"))).toBe(true)
    expect(p.logs.some((l) => l.includes("opening the sign-in window"))).toBe(true)
    expect(p.logs.some((l) => l.includes("reusing the profile's console session"))).toBe(false)
  } finally {
    rmSync(own, { recursive: true, force: true })
  }
}, 60_000)

test("the production users/validate decides reuse: a 200 with code != 0 opens the window", async () => {
  f = fakeInkStone()
  const keys = serveKeyRoutes()
  f.route("GET /api/tokenplan/v1/users/validate", () => fail(-1, "expired"))
  const key = "intern-inkstone#refused-code"
  const own = accountProfileDir(key)
  rmSync(own, { recursive: true, force: true })
  mkdirSync(own, { recursive: true })
  try {
    const p = await pluginWithFakeBrowser({}, { account: () => key })
    const saved = await p.auth.methods[0].authorize({}).callback("", {})
    expect(saved.type).toBe("success")
    expect(keys.length).toBe(1)
    expect(p.logs.some((l) => l.includes("is no longer accepted"))).toBe(true)
    expect(p.logs.some((l) => l.includes("opening the sign-in window"))).toBe(true)
  } finally {
    rmSync(own, { recursive: true, force: true })
  }
}, 60_000)

test("renewal through auth.usage reads the account's own profile, not the shared one", async () => {
  // The renewal's profile choice is only guaranteed at the call site: this
  // goes through auth.usage -> renew -> renewSilently with magpie.account set.
  f = fakeInkStone()
  serveKeyRoutes()
  f.route("GET /api/tokenplan/v1/credits/balance", () => ok(poolUsageFixture()))
  f.route("GET /api/tokenplan/v1/credits/packages", () => ok(packagesFixture()))
  const key = "intern-inkstone#renew-wire"
  const own = accountProfileDir(key)
  rmSync(own, { recursive: true, force: true })
  mkdirSync(own, { recursive: true })
  try {
    const writes = []
    const p = await InkStoneAuthPlugin(
      { client: { auth: { set: async (req) => writes.push(structuredClone(req.body)) } }, magpie: { account: () => key } },
      { browser: fakeExe },
    )
    const auth = { type: "oauth", access: "", uaaToken: jwtOf({ exp: Math.floor(Date.now() / 1000) - 60 }), accountId: "张三" }
    // a port file left by an earlier test would hide whether the shared
    // profile was opened now
    rmSync(join(profile, "DevToolsActivePort"), { force: true })
    const u = await p.auth.usage(async () => auth)
    expect(u.error).toBeUndefined()
    expect(writes.length).toBe(1)
    expect(writes[0].uaaToken).toBe("fake-uaa-token-for-tests")
    // the browser ran in the account's profile; the shared one was not opened
    expect(existsSync(join(own, "DevToolsActivePort"))).toBe(true)
    expect(existsSync(join(profile, "DevToolsActivePort"))).toBe(false)
  } finally {
    rmSync(own, { recursive: true, force: true })
  }
}, 60_000)

test("a 0.1.5 shared profile is moved to the account whose session it holds", async () => {
  // Upgrading must not cost every existing user their silent renewal: the
  // shared profile's session is validated and, when it is this account's,
  // the whole profile moves under the account's key.
  f = fakeInkStone()
  serveKeyRoutes()
  f.route("GET /api/tokenplan/v1/credits/balance", () => ok(poolUsageFixture()))
  f.route("GET /api/tokenplan/v1/credits/packages", () => ok(packagesFixture()))
  const savedProfile = process.env.MAGPIE_INKSTONE_PROFILE
  const shared = mkdtempSync(join(tmpdir(), "inkstone-shared-"))
  process.env.MAGPIE_INKSTONE_PROFILE = shared
  const key = "intern-inkstone#migrated"
  const own = accountProfileDir(key)
  rmSync(own, { recursive: true, force: true })
  try {
    const writes = []
    const p = await InkStoneAuthPlugin(
      { client: { auth: { set: async (req) => writes.push(structuredClone(req.body)) } }, magpie: { account: () => key } },
      { browser: fakeExe },
    )
    const auth = { type: "oauth", access: "", uaaToken: jwtOf({ exp: Math.floor(Date.now() / 1000) - 60 }), accountId: "张三" }
    const u = await p.auth.usage(async () => auth)
    expect(u.error).toBeUndefined()
    expect(writes.length).toBe(1)
    expect(writes[0].uaaToken).toBe("fake-uaa-token-for-tests")
    expect(existsSync(own)).toBe(true)
    expect(existsSync(shared)).toBe(false)
  } finally {
    process.env.MAGPIE_INKSTONE_PROFILE = savedProfile
    rmSync(own, { recursive: true, force: true })
    rmSync(shared, { recursive: true, force: true })
  }
}, 60_000)

test("a uaa-token on another org.cn host is not the console session", async () => {
  // The CDP read is filtered by the console's registrable domain: a cookie
  // served first for .other.org.cn must not win over the console's own.
  process.env.FAKE_BROWSER_FOREIGN_COOKIE = "1"
  try {
    expect(await renewSilently({ browserPath: fakeExe })).toBe("fake-uaa-token-for-tests")
  } finally {
    delete process.env.FAKE_BROWSER_FOREIGN_COOKIE
  }
}, 30_000)

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
  // B4 (third-round review): the real signInWithBrowser path with NO injected
  // probe — launch baseline → the real sqlite probe → "console". The stand-in
  // writes its uaa-token row ~300 ms in, and the wait must see it through the
  // production wiring. Replacing the wiring with `loginWait?.cookieProbe`
  // alone (no probe at all off Windows) leaves this wait to the child's exit
  // and it never says "console" — this goes red.
  f = fakeInkStone()
  serveKeyRoutes()
  // a clean store: whatever a previous test left is in the baseline anyway,
  // but starting empty makes "a new row appeared" unambiguous
  try { rmSync(join(profile, "Default", "Cookies"), { force: true }) } catch {}
  const logs = []
  const token = await signInWithBrowser({
    browserPath: fakeExe,
    keepSignIn: true,
    timeoutMs: 6000,
    loginWait: { platform: "linux", pollMs: 50 },
    log: (...args) => logs.push(args.map(String).join(" ")),
  })
  expect(token).toBe("fake-uaa-token-for-tests")
  expect(logs.some((l) => l.includes("login window finished (console)"))).toBe(true)
  expect(logs.some((l) => l.includes("cookie store"))).toBe(true)
}, 30_000)

test("a kept row is never this sign-in by itself, unexpired or not", async () => {
  // B1 end-to-end with the real sqlite probe: keep_sign_in's profile carries
  // the previous uaa-token. Reuse needs the positive check (validateToken,
  // see the tests below); the window wait alone must never take the row for
  // this sign-in. The timeout is deliberately longer than the Windows title
  // path's settle — the guarantee is not a matter of how long we wait.
  f = fakeInkStone()
  serveKeyRoutes()
  const writeRow = (expiresAt) => {
    try { rmSync(join(profile, "Default", "Cookies"), { force: true }) } catch {}
    mkdirSync(join(profile, "Default"), { recursive: true })
    const { Database } = require("bun:sqlite")
    const db = new Database(join(profile, "Default", "Cookies"))
    db.query("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, creation_utc INTEGER, last_update_utc INTEGER, expires_utc INTEGER)").run()
    const old = (Date.now() - 3600_000 + 11644473600000) * 1000
    db.query(
      "INSERT INTO cookies (host_key, name, value, creation_utc, last_update_utc, expires_utc) VALUES ('.intern-ai.org.cn', 'uaa-token', 'old', ?, ?, ?)",
    ).run(old, old, expiresAt)
    db.close()
  }
  const waitOnce = async (timeoutMs) => {
    const logs = []
    await signInWithBrowser({
      browserPath: fakeExe,
      keepSignIn: true,
      timeoutMs,
      loginWait: { platform: "linux", pollMs: 50 },
      log: (...args) => logs.push(args.map(String).join(" ")),
    }).catch(() => "")
    return logs
  }
  process.env.FAKE_BROWSER_HOLD_COOKIE = "1"
  try {
    // an unexpired old row, waited out past the settle: still not "console"
    writeRow((Date.now() + 86400_000 + 11644473600000) * 1000)
    expect((await waitOnce(7000)).some((l) => l.includes("login window finished (console)"))).toBe(false)
    // an expired old row: not "console" either
    writeRow((Date.now() - 3600_000 + 11644473600000) * 1000)
    expect((await waitOnce(2500)).some((l) => l.includes("login window finished (console)"))).toBe(false)
  } finally {
    delete process.env.FAKE_BROWSER_HOLD_COOKIE
    try { rmSync(join(profile, "Default", "Cookies"), { force: true }) } catch {}
  }
}, 30_000)

test("a kept console session the server still accepts finishes the sign-in without a window", async () => {
  // The positive signal: the token read out of the profile is checked with the
  // console. No settle, no window — the sign-in ends on that session.
  try { rmSync(join(profile, "Default", "Cookies"), { force: true }) } catch {}
  const logs = []
  const checked = []
  const token = await signInWithBrowser({
    browserPath: fakeExe,
    keepSignIn: true,
    timeoutMs: 6000,
    loginWait: { platform: "linux", pollMs: 50 },
    reuseKeptSession: true,
    validateToken: async (t) => {
      checked.push(t)
      return "张三"
    },
    log: (...args) => logs.push(args.map(String).join(" ")),
  })
  expect(token).toBe("fake-uaa-token-for-tests")
  expect(checked).toEqual(["fake-uaa-token-for-tests"])
  expect(logs.some((l) => l.includes("reusing the profile's console session (张三)"))).toBe(true)
  // the window path logs this every time it runs
  expect(logs.some((l) => l.includes("opening the sign-in window"))).toBe(false)
}, 30_000)

test("a kept session the server refuses opens the window for a real sign-in", async () => {
  // A row on disk can outlive the server's session (password changed, signed
  // out elsewhere): the check fails, and the window must open so the user can
  // log in again — the dead row must not lock the flow.
  f = fakeInkStone()
  serveKeyRoutes()
  try { rmSync(join(profile, "Default", "Cookies"), { force: true }) } catch {}
  const logs = []
  const token = await signInWithBrowser({
    browserPath: fakeExe,
    keepSignIn: true,
    timeoutMs: 6000,
    loginWait: { platform: "linux", pollMs: 50 },
    reuseKeptSession: true,
    validateToken: async () => {
      throw Object.assign(new Error("401"), { status: 401 })
    },
    log: (...args) => logs.push(args.map(String).join(" ")),
  })
  expect(token).toBe("fake-uaa-token-for-tests")
  expect(logs.some((l) => l.includes("is no longer accepted"))).toBe(true)
  expect(logs.some((l) => l.includes("opening the sign-in window"))).toBe(true)
  // the fake window's new row is what finished this one
  expect(logs.some((l) => l.includes("login window finished (console)"))).toBe(true)
}, 30_000)

test("a kept session about to expire is not reused", async () => {
  const logs = []
  const checked = []
  process.env.FAKE_BROWSER_COOKIE_VALUE = jwtOf({ exp: Math.floor(Date.now() / 1000) + 60 })
  process.env.FAKE_BROWSER_HOLD_COOKIE = "1"
  try {
    await signInWithBrowser({
      browserPath: fakeExe,
      keepSignIn: true,
      timeoutMs: 2500,
      loginWait: { platform: "linux", pollMs: 50 },
      reuseKeptSession: true,
      validateToken: async (t) => {
        checked.push(t)
        return "张三"
      },
      log: (...args) => logs.push(args.map(String).join(" ")),
    }).catch(() => "")
    // five minutes of margin: a one-minute token is not worth reusing
    expect(checked).toEqual([])
    expect(logs.some((l) => l.includes("about to expire"))).toBe(true)
    expect(logs.some((l) => l.includes("opening the sign-in window"))).toBe(true)
  } finally {
    delete process.env.FAKE_BROWSER_COOKIE_VALUE
    delete process.env.FAKE_BROWSER_HOLD_COOKIE
  }
}, 30_000)
