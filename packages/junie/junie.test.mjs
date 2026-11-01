import { expect, test, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { once } from "node:events"
import { agent, connect } from "./junie.agent.js"
import { seed, removeSeed, catalog, profileID } from "./seed.mjs"

const roots = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const read = file => JSON.parse(fs.readFileSync(file, "utf8"))
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)) }
const gateway = { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "test-agent-key" }
const models = [
  { id: "provider/alpha", display_name: "Alpha", context_length: 200000 },
  { id: "group/beta", display_name: "Beta", context_length: 0 },
]

function fixture({ fetchImpl = async () => Response.json({ data: models }), settings = {}, config = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "junie-seed-test-")); roots.push(root)
  const junieHome = path.join(root, ".junie")
  const sourceFile = path.join(junieHome, "magpie", "connection.json")
  const settingsFile = path.join(junieHome, "settings.json"), configFile = path.join(junieHome, "config.json")
  const modelsDir = path.join(junieHome, "magpie", "models")
  put(sourceFile, { id: models[0].id, ...connect({ gateway, model: { context: 200000 } }) })
  put(settingsFile, settings)
  put(configFile, config)
  return { junieHome, modelsDir, sourceFile, settingsFile, configFile, options: { junieHome, fetchImpl } }
}

test("the agent writes connection metadata outside Junie's discovered profiles", async () => {
  expect(agent).toMatchObject({ id: "junie", config: "~/.junie/magpie/connection.json", model: "id", format: "json" })
  expect(connect({ gateway, model: { context: 200000 } })).toEqual({
    baseUrl: "http://127.0.0.1:3425/v1/chat/completions", apiType: "OpenAICompletion", apiKey: "test-agent-key",
  })
  expect(connect({ gateway: { ...gateway, v1: gateway.v1 + "/" }, model: { context: 0 } })).not.toHaveProperty("maxContextLength")
  const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json()
  expect(pkg).not.toHaveProperty("main")
  expect(pkg.magpie.agent).toBe("./junie.agent.js")
  expect(agent.icon).toBe("https://junie.jetbrains.com/favicons/favicon.svg")
  expect(pkg.magpie.icon).toBe(agent.icon)
})

test("profiles preserve wire IDs and omit unknown limits", () => {
  const profiles = catalog({ data: models }, { baseUrl: gateway.v1 + "/chat/completions", apiKey: gateway.key })
  expect(profiles.get("provider/alpha")).toEqual({
    id: "provider/alpha", baseUrl: "http://127.0.0.1:3425/v1/chat/completions", apiType: "OpenAICompletion",
    apiKey: "test-agent-key", displayName: "Alpha · Magpie", providerName: "Magpie", maxContextLength: 200000,
  })
  expect(profiles.get("group/beta")).not.toHaveProperty("maxContextLength")
  expect(profileID("provider/alpha")).toMatch(/^magpie-[a-f0-9]{24}$/)
  expect(profileID("provider/alpha")).not.toBe(profileID("provider_alpha"))
})

test("seeds the full catalog, discovery folder, launch default and ECO preferences", async () => {
  const f = fixture({ settings: { theme: "dark", providerForLaunch: "openai", mixForLaunch: "old" }, config: { brave: false, "model-locations": ["./other"] } })
  const originalProfile = fs.readFileSync(f.sourceFile, "utf8")
  expect(await seed(f.options)).toMatchObject({ models: 2, selected: `custom:${profileID("provider/alpha")}`, eco: "unavailable_for_custom_profiles" })
  expect(fs.readdirSync(f.modelsDir).sort()).toEqual(models.map(m => profileID(m.id) + ".json").sort())
  expect(read(path.join(f.modelsDir, profileID(models[0].id) + ".json")).id).toBe("provider/alpha")
  expect(read(f.configFile)).toEqual({ brave: false, "model-locations": ["./other", f.modelsDir] })
  const settings = read(f.settingsFile)
  expect(settings.modelForLaunch).toBe(`custom:${profileID("provider/alpha")}`)
  expect(settings.onboardingDefaultModelChosen).toBe("true")
  expect(settings.theme).toBe("dark")
  expect(settings).not.toHaveProperty("providerForLaunch")
  expect(settings).not.toHaveProperty("mixForLaunch")
  expect(JSON.parse(settings.ecoModePerModel)).toEqual(Object.fromEntries(models.map(m => [`custom:${profileID(m.id)}`, "on"])))
  expect(JSON.parse(settings.acpEcoModePerModel)).toEqual(JSON.parse(settings.ecoModePerModel))
  expect(fs.readFileSync(f.sourceFile, "utf8")).toBe(originalProfile)
  expect(fs.existsSync(path.join(f.junieHome, "models", "magpie.json"))).toBe(false)
  removeSeed(f.junieHome)
  expect(read(f.settingsFile)).toEqual({ theme: "dark", providerForLaunch: "openai", mixForLaunch: "old" })
  expect(read(f.configFile)).toEqual({ brave: false, "model-locations": ["./other"] })
  expect(fs.readdirSync(f.modelsDir)).toEqual([])
  expect(fs.readFileSync(f.sourceFile, "utf8")).toBe(originalProfile)
})

test("copies Magpie's selection to the launch default on every sync and allows an explicit override", async () => {
  const f = fixture()
  await seed({ ...f.options, model: "group/beta", eco: "off" })
  expect(read(f.settingsFile).modelForLaunch).toBe(`custom:${profileID("group/beta")}`)
  const settings = read(f.settingsFile)
  settings.modelForLaunch = "my-native-model"
  settings.ecoModePerModel = JSON.stringify({ unrelated: "off", [`custom:${profileID("group/beta")}`]: "off" })
  put(f.settingsFile, settings)
  await seed(f.options)
  expect(read(f.settingsFile).modelForLaunch).toBe(`custom:${profileID("provider/alpha")}`)
  expect(JSON.parse(read(f.settingsFile).ecoModePerModel)).toMatchObject({ unrelated: "off", [`custom:${profileID("group/beta")}`]: "off" })
  put(f.sourceFile, { ...read(f.sourceFile), id: "group/beta" })
  await seed(f.options)
  expect(read(f.settingsFile).modelForLaunch).toBe(`custom:${profileID("group/beta")}`)
})

test("preserves new native preferences and discovery folders when removing the seed", async () => {
  const f = fixture({ settings: { modelForLaunch: "old-native" } })
  await seed(f.options)
  put(f.settingsFile, { ...read(f.settingsFile), modelForLaunch: "new-native", theme: "light" })
  put(f.configFile, { ...read(f.configFile), "model-locations": [f.modelsDir, "./new-folder"] })
  removeSeed(f.junieHome)
  expect(read(f.settingsFile)).toEqual({ modelForLaunch: "new-native", theme: "light" })
  expect(read(f.configFile)["model-locations"]).toEqual(["./new-folder"])
  expect(fs.readdirSync(f.modelsDir)).toEqual([])
})

test("failed, invalid, empty and partial catalogs preserve the previous files", async () => {
  let payload = { data: models }, status = 200
  const f = fixture({ fetchImpl: async () => Response.json(payload, { status }) })
  await seed(f.options)
  const before = fs.readFileSync(f.settingsFile, "utf8")
  for (const next of [{ data: [] }, { data: [models[0], models[0]] }, { data: [null] }, { data: models, has_more: true }]) {
    payload = next
    await expect(seed(f.options)).rejects.toThrow()
    expect(fs.readFileSync(f.settingsFile, "utf8")).toBe(before)
    expect(fs.readdirSync(f.modelsDir).length).toBe(2)
  }
  status = 503
  await expect(seed(f.options)).rejects.toThrow("HTTP 503")
  expect(fs.readFileSync(f.settingsFile, "utf8")).toBe(before)
})

test("rejects an unavailable requested default before writing", async () => {
  const f = fixture()
  await expect(seed({ ...f.options, model: "absent/model" })).rejects.toThrow("absent")
  expect(read(f.settingsFile)).toEqual({})
  expect(fs.existsSync(f.modelsDir)).toBe(false)
})

test("does not overwrite malformed settings or user edits to generated profiles", async () => {
  const f = fixture({ settings: { ecoModePerModel: "broken-json" } })
  const before = fs.readFileSync(f.settingsFile, "utf8")
  await expect(seed(f.options)).rejects.toThrow()
  expect(fs.existsSync(f.modelsDir)).toBe(false)
  expect(fs.readFileSync(f.settingsFile, "utf8")).toBe(before)
  put(f.settingsFile, {})
  await seed(f.options)
  const file = path.join(f.modelsDir, profileID("provider/alpha") + ".json")
  put(file, { manual: true })
  await expect(seed(f.options)).rejects.toThrow("profile_changed")
  expect(read(file)).toEqual({ manual: true })
  const current = fs.readFileSync(f.settingsFile, "utf8")
  expect(() => removeSeed(f.junieHome)).toThrow("profile_changed")
  expect(fs.readFileSync(f.settingsFile, "utf8")).toBe(current)
})

test("an interrupted default update does not claim a user's preceding native selection", async () => {
  const f = fixture({ settings: { modelForLaunch: "original-native" } })
  await seed(f.options)
  put(f.settingsFile, { ...read(f.settingsFile), modelForLaunch: "new-native" })
  const rename = fs.renameSync
  try {
    fs.renameSync = (from, to) => {
      if (to === f.settingsFile) throw Error("interrupted_write")
      return rename(from, to)
    }
    await expect(seed({ ...f.options, model: "group/beta" })).rejects.toThrow("interrupted_write")
  } finally { fs.renameSync = rename }
  removeSeed(f.junieHome)
  expect(read(f.settingsFile).modelForLaunch).toBe("new-native")
  expect(fs.readdirSync(f.modelsDir)).toEqual([])
})

test("prunes obsolete generated profiles after selecting Magpie's current default and preserves unrelated profiles", async () => {
  let rows = models
  const f = fixture({ fetchImpl: async () => Response.json({ data: rows }) })
  await seed({ ...f.options, model: "group/beta" })
  const native = path.join(f.junieHome, "models", "mine.json")
  put(native, { id: "mine" })
  rows = [models[0]]
  await seed(f.options)
  expect(read(f.settingsFile).modelForLaunch).toBe(`custom:${profileID("provider/alpha")}`)
  expect(fs.readdirSync(f.modelsDir)).toEqual([profileID(models[0].id) + ".json"])
  removeSeed(f.junieHome)
  expect(read(native)).toEqual({ id: "mine" })
})

test("repeated sync is idempotent and removal recovers a previous seed journal", async () => {
  const f = fixture({ settings: { modelForLaunch: "native", theme: "dark" } })
  await seed(f.options)
  const before = fs.readFileSync(f.settingsFile, "utf8")
  const journal = fs.readFileSync(path.join(f.junieHome, "magpie", "seed-state.json"), "utf8")
  await seed(f.options)
  expect(fs.readFileSync(f.settingsFile, "utf8")).toBe(before)
  expect(fs.readFileSync(path.join(f.junieHome, "magpie", "seed-state.json"), "utf8")).toBe(journal)
  removeSeed(f.junieHome)
  removeSeed(f.junieHome)
  expect(read(f.settingsFile)).toEqual({ modelForLaunch: "native", theme: "dark" })
})

test("removal never restores a default that refers to a removed generated profile", async () => {
  const f = fixture({ settings: { modelForLaunch: `custom:${profileID("provider/alpha")}` } })
  await seed(f.options)
  put(f.sourceFile, { ...read(f.sourceFile), id: "group/beta" })
  await seed(f.options)
  removeSeed(f.junieHome)
  expect(read(f.settingsFile)).not.toHaveProperty("modelForLaunch")
  expect(fs.readdirSync(f.modelsDir)).toEqual([])
})

test("removal clears a matching generated launch default even if seeding never changed its value", async () => {
  const f = fixture({ settings: { modelForLaunch: `custom:${profileID("provider/alpha")}` } })
  await seed(f.options)
  removeSeed(f.junieHome)
  expect(read(f.settingsFile)).not.toHaveProperty("modelForLaunch")
  expect(fs.readdirSync(f.modelsDir)).toEqual([])
})

test("removal preserves unrelated ECO edits across reseeding and removes all generated preferences", async () => {
  const fields = ["ecoModePerModel", "acpEcoModePerModel"]
  const f = fixture({ settings: Object.fromEntries(fields.map(field => [field, JSON.stringify({ native: "off" })])) })
  await seed(f.options)
  const settings = read(f.settingsFile)
  for (const field of fields) settings[field] = JSON.stringify({ ...JSON.parse(settings[field]), native: "on" })
  put(f.settingsFile, settings)
  await seed({ ...f.options, eco: "off" })
  removeSeed(f.junieHome)
  for (const field of fields) expect(JSON.parse(read(f.settingsFile)[field])).toEqual({ native: "on" })
})

test("removal preserves ECO edits after the final seed without orphaned generated keys", async () => {
  const fields = ["ecoModePerModel", "acpEcoModePerModel"]
  const f = fixture()
  await seed(f.options)
  const settings = read(f.settingsFile)
  for (const field of fields) settings[field] = JSON.stringify({ ...JSON.parse(settings[field]), native: "on" })
  put(f.settingsFile, settings)
  removeSeed(f.junieHome)
  for (const field of fields) expect(JSON.parse(read(f.settingsFile)[field])).toEqual({ native: "on" })
})

test("removal retains preexisting empty ECO maps and drops maps first created by the seed", async () => {
  const f = fixture({ settings: { ecoModePerModel: "{}" } })
  await seed(f.options)
  removeSeed(f.junieHome)
  expect(read(f.settingsFile)).toEqual({ ecoModePerModel: "{}" })
})

test("reads /v1/models over HTTP with Junie's own credential and User-Agent", async () => {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization, ua: req.headers["user-agent"] })
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ data: models }))
  }).listen(0, "127.0.0.1")
  await once(server, "listening")
  const f = fixture({ fetchImpl: globalThis.fetch })
  put(f.sourceFile, { ...read(f.sourceFile), baseUrl: `http://127.0.0.1:${server.address().port}/v1/chat/completions` })
  try {
    expect(await seed(f.options)).toMatchObject({ models: 2 })
    expect(requests).toEqual([{ url: "/v1/models", auth: "Bearer test-agent-key", ua: "Junie" }])
  } finally { server.closeAllConnections(); server.close() }
})
