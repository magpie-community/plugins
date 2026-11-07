// A real end-to-end run of the browser sign-in and the silent renewal: the
// "browser" is a tiny compiled Chromium stand-in that serves the DevTools
// HTTP + WebSocket endpoints the plugin speaks, so the actual spawn →
// port-file → CDP cookie read → graceful close → key creation path runs here.
import "./nonet.mjs"
import { execSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { InkStoneAuthPlugin } from "./index.mjs"
import { renewSilently } from "./lib/browser.mjs"
import { fakeInkStone, json, ok, fail } from "./fake.mjs"

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
  // Rebuilt only when testdata/fake-browser.mjs changes. The dir is cleaned
  // on exit; a leftover from a crashed run is replaced by the rebuild.
  const entry = join(import.meta.dir, "testdata/fake-browser.mjs")
  const { createHash } = require("node:crypto")
  const key = createHash("sha256").update(readFileSync(entry)).digest("hex").slice(0, 12)
  fakeDir = join(tmpdir(), `inkstone-fake-browser-${key}`)
  mkdirSync(fakeDir, { recursive: true })
  const out = join(fakeDir, process.platform === "win32" ? "fake-chrome.exe" : "fake-chrome")
  if (!existsSync(out)) {
    execSync(`${JSON.stringify(process.execPath)} build --compile ${JSON.stringify(entry)} --outfile ${JSON.stringify(out)}`, { stdio: "pipe" })
  }
  fakeExe = out
  profile = mkdtempSync(join(tmpdir(), "inkstone-fake-profile-"))
  // save what we override: bun test runs every file in one process, so these
  // would leak into whatever test file runs next
  for (const key of ["MAGPIE_INKSTONE_PROFILE", "MAGPIE_INKSTONE_BROWSER", "MAGPIE_INKSTONE_LOGIN_EXIT", "DISPLAY"]) {
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
