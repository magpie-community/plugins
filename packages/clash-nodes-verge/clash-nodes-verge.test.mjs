import { expect, test } from "bun:test"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

const dir = import.meta.dir
const page = join(dir, "page")
const read = (f) => readFileSync(join(page, f), "utf8")
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))

test("package declares a page, an OpenCode main, and providers:list only", () => {
  expect(pkg.name).toBe("@magpie-community/page-clash-nodes-verge")
  expect(pkg.magpie.page).toEqual({
    title: "Clash 节点",
    titles: { zh: "梯子节点", "zh-TW": "梯子节点", ja: "Clash ノード" },
    file: "page/index.html",
    icon: "page/icon.svg",
  })
  // the page can only read what magpie.permissions lists; nothing else
  expect(pkg.magpie.permissions).toEqual(["providers:list"])
  // the host is loaded as an OpenCode plugin through main: magpie calls
  // ClashNodesPlugin once on plugin-host start; the function returns a
  // tools hook so a no-auth tools-only package is a legal shape
  // (scripts/check.mjs: tools without auth is a real category).
  expect(pkg.main).toBe("./index.mjs")
  expect(pkg.exports).toBeUndefined()
  expect(existsSync(join(dir, "index.mjs"))).toBe(true)
})

test("page/index.html loads the magpie bridge, no inline scripts, only local files", () => {
  const html = read("index.html")
  expect(html).toContain('<script src="_magpie/bridge.js"></script>')
  // CSP forbids inline scripts on plugin pages; every <script> must be src=""
  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    expect(m[1]).toMatch(/\ssrc="/)
    expect(m[2].trim()).toBe("")
  }
  // every src/href resolves to a file inside page/, _magpie/ for the bridge,
  // or a data: URL carrying the page's own bootstrap (build.mjs inlines a
  // base64 boot that re-loads bridge.js + app.js when the native path is
  // blocked by `magpie web`'s CSP — desktop allows neither, web allows only
  // data:, so both have to ship).
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = m[1]
    if (ref.startsWith("_magpie/")) continue
    if (ref.startsWith("data:text/javascript;base64,")) continue
    // state.js is written by the host at runtime; index.html references it
    // with a cache-busting ?v=. The test only checks the path shape.
    const clean = ref.split("?")[0]
    expect(clean).not.toMatch(/^(?:[a-z]+:|\/|\.\.)/i)
  }
})

test("page/app.js reaches no network and only the declared magpie surface", () => {
  const src = read("app.js")
  // sandboxed pages have no network anyway (connect-src 'none'); a fetch/
  // XHR/WebSocket in the source would be a bug, not a feature
  for (const bad of ["fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "navigator.sendBeacon", "import("]) {
    expect(src).not.toContain(bad)
  }
  // the only bridge APIs the page may touch
  for (const m of src.matchAll(/magpie\.([a-zA-Z.]+)/g)) {
    expect(["options.get", "options.set", "ready", "theme", "onTheme", "read"].join(" ")).toContain(m[1])
  }
  // and the only magpie.read it may issue is the one permission the package
  // declares — providers:list. Everything else the page needs comes in through
  // page/state.js, written by the host.
  const reads = [...src.matchAll(/magpie\.read\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
  expect(reads).toEqual(["providers:list"])
})

test("state.js is generated, not shipped", () => {
  // state.js holds the user's subscription node list and is rewritten by the
  // host on every command. Shipping it would publish real subscription data.
  expect(pkg.files).not.toContain("page/state.js")
  expect(pkg.files).not.toContain("page")
  // but the page's real files are all listed
  for (const f of ["index.html", "app.js", "style.css", "icon.svg"]) {
    expect(pkg.files).toContain(`page/${f}`)
    expect(existsSync(join(page, f))).toBe(true)
  }
  // and there is no stale state.js sitting in the package directory
  expect(existsSync(join(page, "state.js"))).toBe(false)
})

test("host index.mjs gates its side effects behind the real plugin ctx", async () => {
  // The host spawns mihomo and writes page/state.js — none of that may run
  // when scripts/check.mjs (or any OpenCode stub ctx) calls the plugin. The
  // gate is `input.$`: OpenCode always passes the Bun shell there, the stub
  // leaves it undefined.
  const mod = await import(join(dir, "index.mjs"))
  expect(typeof mod.ClashNodesPlugin).toBe("function")
  const hooks = await mod.ClashNodesPlugin({ client: {}, directory: ".", worktree: ".", $: undefined, project: {} })
  expect(hooks.tool).toBeObject()
  const status = hooks.tool["clash-nodes-status"]
  expect(typeof status.execute).toBe("function")
  expect(status.description).toBeString()
  // and the returned tool can run without a host started
  const out = await status.execute({})
  expect(out).toBeObject()
})
