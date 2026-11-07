import * as mod from "./output-strategy.middleware.js"

// The community repository owns the shared harness. A standalone checkout
// keeps its behavioral tests in test/ and has no community-only test file.
const harness = new URL("../../scripts/middleware.mjs", import.meta.url)
if (await Bun.file(harness).exists()) {
  const { check } = await import(harness.href)
  check(import.meta.dir, mod)
}
