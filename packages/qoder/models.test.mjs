// The models an account lists are the "app" scene's, which Qoder's app
// shows and a request names, with any model only "chat" still lists kept
// (magpie-community/plugins#97). testdata/listing.json is a real account's
// /algo/api/v2/model/list on 2026-10-12 (its chat and app scenes): the app
// lists Fast at 0.8× where chat lists Performance at 1.1×.
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { QoderAuthPlugin } from "./index.mjs"

const LISTING = JSON.parse(readFileSync(new URL("./testdata/listing.json", import.meta.url), "utf8"))
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const account = () => ({ type: "oauth", access: "jt", refresh: "rt", expires: Date.now() + 3_600_000, accountId: "a@x", uid: "u1", machineId: "m1" })

async function listed(listing) {
  globalThis.fetch = async (url) => {
    if (new URL(String(url)).pathname === "/algo/api/v2/model/list") return new Response(JSON.stringify(listing))
    return new Response("", { status: 404 })
  }
  const hooks = await QoderAuthPlugin({ client: { auth: { set: async () => {} } } })
  return hooks.provider.models({ models: { fallback: {} } }, { auth: account() })
}

test("the app's Fast is listed at its price, and chat's Performance stays", async () => {
  const ms = await listed(LISTING)
  expect(ms.fast).toMatchObject({ name: "Fast", rate: 0.8 })
  expect(ms.performance).toMatchObject({ name: "Performance", rate: 1.1 })
  expect(Object.keys(ms)).toEqual([
    "ultimate", "performance", "fast", "efficient", "smodel", "cmodel", "qmodel_38max", "qfmodel", "qmodel_latest", "qmodel",
    "gmodel", "gfmodel", "kmodel_latest", "kmodel", "dmodel", "dfmodel", "mmodel",
  ])
})

test("a model both scenes list is listed once, as the app gives it", async () => {
  const chat = LISTING.chat.map((m) => (m.key === "ultimate" ? { ...m, display_name: "Ultimate (chat)" } : m))
  const ms = await listed({ chat, app: LISTING.app })
  expect(ms.ultimate.name).toBe("Ultimate")
})

test("a listing with only one scene lists that scene", async () => {
  expect(Object.keys(await listed({ chat: LISTING.chat }))).toContain("performance")
  expect(Object.keys(await listed({ chat: LISTING.chat }))).not.toContain("fast")
  expect(Object.keys(await listed({ app: LISTING.app }))).toContain("fast")
  expect(Object.keys(await listed({ app: LISTING.app }))).not.toContain("performance")
})

test("a model the app turns off isn't listed though chat has it on", async () => {
  const app = LISTING.app.map((m) => (m.key === "efficient" ? { ...m, enable: false } : m))
  expect(Object.keys(await listed({ chat: LISTING.chat, app }))).not.toContain("efficient")
})
