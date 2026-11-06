import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

test("1.x entry exports plugin functions only", async () => {
  const mod = await import("./opencode.mjs")
  // WarpAuthPlugin should be a function (plugin)
  expect(typeof mod.WarpAuthPlugin).toBe("function")
  // No accidental non-function default export
  expect(typeof mod.default === "undefined" || typeof mod.default === "function").toBe(true)
})

test("2.x entry default export has { id, setup }", async () => {
  const mod = await import("./opencode2.mjs")
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  expect(typeof mod.default?.id).toBe("string")
  expect(mod.default.id).toBe(pkg.name)
  expect(typeof mod.default?.setup).toBe("function")
})
