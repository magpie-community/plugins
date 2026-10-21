import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { _internal } from "./index.mjs"

const captured = new URL("./testdata/empty-reply.bin", import.meta.url)

test("Devin's usage-only reply fails before a successful stream is opened", async () => {
  const raw = await readFile(captured)
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response(raw)
  try {
    for (const stream of [true, false]) {
      const response = await _internal.complete(
        { key: "test", server: "https://devin.test", families: _internal.familiesOf(_internal.SNAPSHOT) },
        { model: "gemini-4-argon", stream, messages: [{ role: "user", content: "?" }] },
      )
      expect(response.status).toBe(502)
      expect((await response.json()).error.message).toContain("empty reply")
      expect(response.headers.get("X-Magpie-Sign-In")).toBe("kept")
    }
  } finally {
    globalThis.fetch = real
  }
})
