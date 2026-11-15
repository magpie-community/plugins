// The version the requests name is read from the update manifest (#1057).
import { afterEach, beforeEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"
import { real } from "./fake.mjs"

const { ver, version, lists, VERSION_TTL, VERSION_RETRY, DEFAULT_VERSION } = _internal

beforeEach(() => {
  ver.v = ""
  ver.at = 0
  ver.pending = null
  lists.clear()
})
afterEach(() => (globalThis.fetch = real))

const manifest = (v) => async () => new Response(`version: ${v}\nfiles: []\n`, { status: 200 })
const down = async () => { throw new TypeError("fetch failed") }

test("a manifest that can't be read is asked again after a minute, not six hours", async () => {
  let asked = 0
  globalThis.fetch = async (...a) => { asked++; return down(...a) }
  expect(await version()).toBe(DEFAULT_VERSION)
  expect(asked).toBe(1)
  expect(await version()).toBe(DEFAULT_VERSION)
  expect(asked).toBe(1)
  ver.at -= VERSION_RETRY + 1
  globalThis.fetch = async (...a) => { asked++; return manifest("2.40.0")(...a) }
  expect(await version()).toBe("2.40.0")
  expect(asked).toBe(2)
  ver.at -= VERSION_RETRY + 1
  expect(await version()).toBe("2.40.0")
  expect(asked).toBe(2)
})

test("a read manifest holds for six hours", async () => {
  let asked = 0
  globalThis.fetch = async (...a) => { asked++; return manifest("2.40.0")(...a) }
  await version()
  ver.at -= VERSION_TTL - 1000
  await version()
  expect(asked).toBe(1)
})

test("a new version drops the model lists read under the old one", async () => {
  globalThis.fetch = down
  await version()
  lists.set("rt", { at: Date.now(), infos: [], project: "p" })
  ver.at -= VERSION_RETRY + 1
  globalThis.fetch = manifest(DEFAULT_VERSION)
  await version()
  expect(lists.size).toBe(1)
  ver.at -= VERSION_TTL + 1
  globalThis.fetch = manifest("2.40.0")
  await version()
  expect(lists.size).toBe(0)
})

test("the default is a release Google serves Gemini 4 to", () => {
  const [a, b] = DEFAULT_VERSION.split(".").map(Number)
  expect(a > 2 || (a === 2 && b >= 20)).toBe(true)
})
