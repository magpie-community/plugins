import { expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// applyPlan / restore read and write magpie's providers.json under
// MAGPIE_CONFIG_DIR. Point it at a fresh temp dir per test so the real
// ~/.config/magpie is never touched.
let dir
let prevEnv

const seed = (providers) =>
  writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers }, null, 2))
const providers = () => JSON.parse(readFileSync(join(dir, "providers.json"), "utf8")).providers
const byId = (id) => providers().find((p) => p.id === id)

// The module reads process.env.MAGPIE_CONFIG_DIR on every call, so import it
// once and just swap the env + files per test.
const M = await import("./lib/magpie.mjs")

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clash-nodes-magpie-"))
  prevEnv = process.env.MAGPIE_CONFIG_DIR
  process.env.MAGPIE_CONFIG_DIR = dir
})
afterEach(() => {
  if (prevEnv === undefined) delete process.env.MAGPIE_CONFIG_DIR
  else process.env.MAGPIE_CONFIG_DIR = prevEnv
  rmSync(dir, { recursive: true, force: true })
})

test("applyPlan writes proxy + accountProxies, snapshots before, restore puts them back exactly", () => {
  seed([
    // a provider that already has both fields set
    { id: "zcode", name: "ZCode", proxy: "http://old:1", accountProxies: { "a@x.com": "http://old:2" }, keys: [{ id: "a@x.com" }] },
    // a provider that has neither field — the restore must delete, not blank
    { id: "kimi", name: "Kimi" },
    // a provider unrelated to the plan — must not be touched or snapshotted
    { id: "qwen", name: "Qwen", proxy: "direct" },
  ])

  const plan = {
    zcode: { proxy: "http://127.0.0.1:18001", accountProxies: { "a@x.com": "http://127.0.0.1:18002", "b@x.com": "http://127.0.0.1:18003" } },
    kimi: "http://127.0.0.1:18004",
  }
  const { applied, before } = M.applyPlan(plan)

  // applied reflects the new state
  expect(applied.find((a) => a.id === "zcode").proxy).toBe("http://127.0.0.1:18001")
  expect(byId("zcode").accountProxies["b@x.com"]).toBe("http://127.0.0.1:18003")
  expect(byId("kimi").proxy).toBe("http://127.0.0.1:18004")

  // before captured the original field-for-field, and only for providers in the plan
  expect(before.zcode).toEqual({ proxy: "http://old:1", accountProxies: { "a@x.com": "http://old:2" }, hadProxy: true, hadAccountProxies: true })
  expect(before.kimi).toEqual({ proxy: undefined, accountProxies: undefined, hadProxy: false, hadAccountProxies: false })
  expect(before.qwen).toBeUndefined()
  expect(byId("qwen").proxy).toBe("direct")

  const { restored } = M.restore()
  expect(restored.sort()).toEqual(["kimi", "zcode"])
  // zcode gets its exact old values back
  expect(byId("zcode").proxy).toBe("http://old:1")
  expect(byId("zcode").accountProxies).toEqual({ "a@x.com": "http://old:2" })
  // kimi never had the keys — restore deletes them, not sets them to ""
  expect("proxy" in byId("kimi")).toBe(false)
  expect("accountProxies" in byId("kimi")).toBe(false)
  // qwen was never in the plan and stays untouched
  expect(byId("qwen").proxy).toBe("direct")
})

test("accountProxies '' clears that account's override; restore brings it back", () => {
  seed([{ id: "zcode", accountProxies: { "a@x.com": "http://old:9", "b@x.com": "http://old:8" } }])
  M.applyPlan({ zcode: { accountProxies: { "a@x.com": "" } } })
  // "" means "follow the provider" — the key is removed, not stored as ""
  expect(byId("zcode").accountProxies).toEqual({ "b@x.com": "http://old:8" })
  M.restore()
  expect(byId("zcode").accountProxies).toEqual({ "a@x.com": "http://old:9", "b@x.com": "http://old:8" })
})

test("clearing the last accountProxies key removes the field when the provider never had it", () => {
  seed([{ id: "kimi" }])
  M.applyPlan({ kimi: { accountProxies: { "a@x.com": "http://127.0.0.1:18001" } } })
  expect(byId("kimi").accountProxies).toEqual({ "a@x.com": "http://127.0.0.1:18001" })
  // empty merged map + provider never had the field -> field dropped, not left {}
  M.applyPlan({ kimi: { accountProxies: { "a@x.com": "" } } })
  expect("accountProxies" in byId("kimi")).toBe(false)
})

test("restore with nothing applied is a no-op, not a crash", () => {
  seed([{ id: "kimi", proxy: "direct" }])
  expect(M.restore()).toEqual({ restored: [] })
  expect(byId("kimi").proxy).toBe("direct")
})

test("applyPlan on an unknown provider id throws and writes nothing", () => {
  seed([{ id: "kimi" }])
  expect(() => M.applyPlan({ nosuch: "http://127.0.0.1:18001" })).toThrow(/没有/)
  // providers.json on disk is untouched
  expect(byId("kimi")).toEqual({ id: "kimi" })
  expect(existsSync(join(dir, "clash-nodes", "magpie-state.json"))).toBe(false)
})

test("second applyPlan accumulates 'before' so one restore undoes both edits", () => {
  seed([{ id: "zcode", proxy: "http://orig:1" }])
  M.applyPlan({ zcode: "http://127.0.0.1:18001" })
  M.applyPlan({ zcode: "http://127.0.0.1:18002" })
  expect(byId("zcode").proxy).toBe("http://127.0.0.1:18002")
  M.restore()
  // one restore still lands on the value from before the FIRST edit
  expect(byId("zcode").proxy).toBe("http://orig:1")
})
