// Minimal local runner with the same request-hook semantics as magpie's shared harness.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "bun:test"

export function check(dir, mod) {
  const cases = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"))
  for (const c of cases) {
    test(c.name, async () => {
      const request = JSON.parse(JSON.stringify(c.request))
      const ctx = { protocol: c.protocol || "chat", options: c.options || {}, state: {}, origin: "local" }
      const result = mod.onRequest ? await mod.onRequest(request, ctx) : undefined
      if (c.expect_request_contains) {
        const text = JSON.stringify(result === undefined ? c.request : result)
        for (const needle of c.expect_request_contains) expect(text).toContain(needle)
      } else {
        expect(result === undefined ? c.request : result).toEqual(c.expect_request ?? c.request)
      }
    })
  }
}
