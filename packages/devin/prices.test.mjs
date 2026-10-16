// 太陽と向日葵 on magpie's Discord (2026-10-15): Usage showed no cost for
// calls through Devin. Devin lists a price for each model it doesn't
// serve free, in USD per 1M tokens, in GetCliModelConfigs (field 32), and
// the list gave every model a price of 0. And Devin now files three
// -lightning variants at the High cost tier under SWE-2, so swe-2, which
// is sent as swe-2-high, -medium or -max, all Free, was no longer free.
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DevinAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.forgetSaid()
})

// Devin's own response to GetCliModelConfigs (2026-10-15), cut to SWE-2's
// six variants, SWE-1.7 Lightning, Gemini 4 Argon's three and GLM-5.2
const configs = readFileSync(join(import.meta.dir, "testdata", "model-configs-1015.bin"))

function serve() {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/GetUserStatus")) return Response.json({ userStatus: { planStatus: { planInfo: { planName: "Teams", isDevin: true }, planEnd: "2026-10-26T21:45:55Z" } } })
    if (String(url).endsWith("/GetCliModelConfigs")) return new Response(configs)
    throw new Error("unexpected fetch " + url)
  }
}

test("Devin's prices are read from its model configs, as Devin wrote them", () => {
  const p = _internal.parsePrices(new Uint8Array(configs))
  expect(p.get("swe-1-7-lightning")).toEqual({ input: 2.5, output: 12.5, cache: { read: 1 } })
  expect(p.get("swe-2-high-lightning")).toEqual({ input: 1, output: 5, cache: { read: 0.1 } })
  // a float32's 1.4 and 0.26, not 1.39999997…
  expect(p.get("glm-5-2")).toEqual({ input: 1.4, output: 4.4, cache: { read: 0.26 } })
  // the Free tier lists none
  expect(p.has("swe-2-high")).toBe(false)
})

test("the list gives each model Devin's price, and SWE-2 stays free beside its Lightning variants", async () => {
  serve()
  const got = await (await DevinAuthPlugin()).provider.models({ models: {} }, { auth: { type: "api", key: "key-prices-list" } })
  expect(got["swe-2"].free).toBe(true)
  expect(got["swe-2"].cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
  expect(got["swe-2-high-lightning"].free).toBeUndefined()
  expect(got["swe-2-high-lightning"].cost).toEqual({ input: 1, output: 5, cache: { read: 0.1, write: 0 } })
  // a family is priced at its variants' one price
  expect(got["gemini-4-argon"].cost).toEqual({ input: 1, output: 5, cache: { read: 0.05, write: 0 } })
  const swe17 = got["swe-1.7-lightning"] ?? got["swe-1-7-lightning"]
  expect(swe17.cost).toEqual({ input: 2.5, output: 12.5, cache: { read: 1, write: 0 } })
})

test("a family whose variants Devin lists at different prices has none", () => {
  const f = { uid: "fam", label: "Fam", aliases: [], models: [{ id: "fam-low" }, { id: "fam-high" }] }
  const prices = new Map([["fam-low", { input: 1, output: 2, cache: { read: 0 } }], ["fam-high", { input: 3, output: 6, cache: { read: 0 } }]])
  const [fam] = _internal.listed([f], [], {}, new Set(), prices)
  expect(fam.cost).toBeUndefined()
  expect(_internal.runtimeModel(fam).cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
})

test("SWE-2 used up a quota doesn't count, with its Lightning variants in the list", async () => {
  serve()
  const ids = await _internal.freeIDs("key-prices-free", "https://server.self-serve.windsurf.com")
  expect(ids).toContain("swe-2")
  expect(ids).not.toContain("swe-2-high-lightning")
})
