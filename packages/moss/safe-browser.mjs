// Test-time guard: a test must never launch a REAL browser. The only browser
// a test may spawn is the compiled fake (its file name contains
// "fake-chrome"). Anything else — the machine's Edge/Chrome/Chromium — opens
// a real window on the desktop and hits the console's WAF from a test box
// (2026-11-21: repeated automated logins got the shared IP rate-limited).
//
// Why a Bun plugin instead of patching node:child_process: the CJS exports
// patch does NOT intercept the static `import { spawn }` that
// lib/browser.mjs uses (Bun binds the named import at link time), so the
// only reliable seam is rewriting the module at load. The plugin is
// registered the moment this file is imported; every load of lib/browser.mjs
// after that gets the guarded spawn/spawnSync. "openSession" and friends keep
// their real logic — only the process launch is checked.
//
// Load order: `bun test packages/moss` runs files alphabetically, and
// browser-args.test.mjs (b < f) imports lib/browser.mjs before
// fake-browser.test.mjs imports this file. The guard still applies: this
// plugin registers for every later LOAD of browser.mjs, and nonet.mjs —
// imported first by every test file — pulls this file in before any of them
// load browser.mjs, so the very first browser.mjs load is already guarded.
import { readFileSync } from "node:fs"

const GUARD_SHIM = `import { spawn as __rawSpawn, spawnSync as __rawSpawnSync } from "node:child_process"
const __realBrowser = (cmd) => {
  const base = String(cmd).split(/[\\\\/]/).pop()?.toLowerCase() ?? ""
  if (base.includes("fake-chrome")) return "" // the compiled test double is fine
  if (/^msedge/.test(base)) return "Microsoft Edge"
  if (/^chrome/.test(base)) return "Google Chrome"
  if (/^chromium/.test(base)) return "Chromium"
  return ""
}
const __guard = (fn, kind) => (cmd, ...rest) => {
  const who = __realBrowser(cmd)
  if (who) throw new Error("a test tried to " + kind + " the real " + who + "; the e2e suite must use the fake-chrome double")
  return fn(cmd, ...rest)
}
const spawn = __guard(__rawSpawn, "spawn")
const spawnSync = __guard(__rawSpawnSync, "spawnSync")`

Bun.plugin({
  name: "moss-test-browser-guard",
  setup(build) {
    build.onLoad({ filter: /browser\.mjs$/ }, async (args) => {
      let src = readFileSync(args.path, "utf8")
      if (!src.includes("/*BROWSER-GUARD*/")) {
        src = "/*BROWSER-GUARD*/" + src.replace(
          'import { spawn, spawnSync } from "node:child_process"',
          GUARD_SHIM,
        )
      }
      return { contents: src, loader: "js" }
    })
  },
})
