import test from "node:test"
import assert from "node:assert/strict"
import { runTurn } from "../src/api.mjs"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

for (const site of ["https://web.tabbit.ai", "https://web.tabbit.com"]) {
  test(`runs on ${site} carries unique-uuid`, async () => {
    const seen = [], original = globalThis.fetch
    globalThis.fetch = async (input, init = {}) => { seen.push(new Headers(init.headers ?? {})); return Response.json({ run_id: "r", status: "QUEUED" }) }
    try {
      const creds = { token: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.sig", header: "token=[REDACTED_VALUE]", site }
      await runTurn(creds, "room-1", { content: "hi", model: "Default" })
      await runTurn(creds, "room-1", { content: "hi", model: "Default" })
      assert.match(seen[0].get("unique-uuid") ?? "", UUID)
      assert.notEqual(seen[0].get("unique-uuid"), seen[1].get("unique-uuid"))
    } finally { globalThis.fetch = original }
  })
}
