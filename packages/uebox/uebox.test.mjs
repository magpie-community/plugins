import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { PROVIDER_ID, buildProvider, link_path, merge, sync, uebox_dir } from "./lib/sync.mjs"

const link = {
  magpie_v1: "http://127.0.0.1:3425/v1",
  magpie_url: "http://127.0.0.1:3425",
  magpie_key: "magpie-zycode",
  magpie_models: [
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", context: 1000000, output: 393216, images: false, efforts: ["low", "high"] },
    { id: "copilot/gpt-6.1-terra", name: "GPT-6.1 Terra", context: 400000, output: 64000, images: true, efforts: [] },
  ],
}

// UEBox's own settings, as the app writes them: providers is an array and
// roles bind to provider ids
const uebox = (providers = []) => ({
  version: 3,
  providers: [{ id: "deepseek", displayName: "DeepSeek", kind: "chat", protocol: "openai-completions", baseUrl: "https://api.deepseek.com/v1", apiKey: { kind: "literal", id: "provider:deepseek" }, models: [{ id: "deepseek-flash", displayName: "DeepSeek Flash", supportsTools: true }] }, ...providers],
  roles: { chat: { providerId: "deepseek", modelId: "deepseek-flash" } },
})

let dir
let env

beforeEach(() => {
  // a folder of its own as HOME, as magpie gives a plugin one: no real
  // UEBox or magpie settings are read
  dir = mkdtempSync(join(tmpdir(), "uebox-"))
  env = { UEBOX_USER_DATA: join(dir, "unreal-box"), MAGPIE_UEBOX_LINK: join(dir, "magpie", "uebox-link.json") }
  mkdirSync(env.UEBOX_USER_DATA, { recursive: true })
  mkdirSync(join(dir, "magpie"), { recursive: true })
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const settingsPath = () => join(env.UEBOX_USER_DATA, "models.json")
const writeSettings = (s) => writeFileSync(settingsPath(), JSON.stringify(s, null, 2) + "\n", "utf8")
const readSettings = () => JSON.parse(readFileSync(settingsPath(), "utf8"))
const writeLink = (l) => writeFileSync(env.MAGPIE_UEBOX_LINK, JSON.stringify(l), "utf8")

test("the provider it adds is a Responses one on the gateway, keyed without storing the key", () => {
  const p = buildProvider(link)
  expect(p.id).toBe(PROVIDER_ID)
  // the Responses API is the one that carries a session id; Chat completions
  // sends none and magpie then routes the calls as "no session id"
  expect(p.protocol).toBe("openai-responses")
  expect(p.baseUrl).toBe("http://127.0.0.1:3425/v1")
  // UEBox encrypts a literal key and cannot be handed one from outside, so
  // the key is a command UEBox runs. The key is in that command, which is
  // fine: it is magpie's local per-agent gateway key, not a vendor secret.
  expect(p.apiKey.kind).toBe("shell")
  expect(p.apiKey.id).toBeUndefined()
  expect(p.headers).toEqual({ "x-magpie-agent": "uebox" })
  expect(p.models.map((m) => m.id)).toEqual(["deepseek/deepseek-v4-pro", "copilot/gpt-6.1-terra"])
  expect(p.models[0]).toMatchObject({ supportsTools: true, contextWindow: 1000000, maxOutputTokens: 393216, supportsReasoning: true })
  expect(p.models[1]).toMatchObject({ supportsVision: true, supportsReasoning: false })
})

test("the shell key shows the key when it runs", () => {
  const command = buildProvider(link).apiKey.command
  const shown = process.platform === "win32" ? command.replace(/^echo /, "") : command.replace(/^printf %s '(.*)'$/, "$1")
  expect(shown).toBe(link.magpie_key)
})

test("a provider of the user's own is left as it was, and one of ours replaced", () => {
  const before = uebox([{ id: PROVIDER_ID, displayName: "old", kind: "chat", protocol: "openai-completions", baseUrl: "http://old", apiKey: { kind: "none" }, models: [] }])
  const after = merge(before, link)
  expect(after.providers.map((p) => p.id)).toEqual(["deepseek", PROVIDER_ID])
  expect(after.providers.find((p) => p.id === PROVIDER_ID).baseUrl).toBe("http://127.0.0.1:3425/v1")
  expect(after.providers[0]).toEqual(before.providers[0])
  expect(after.roles).toEqual(before.roles)
})

test("with no link it takes only its own entry out", () => {
  writeSettings(uebox([buildProvider(link)]))
  const result = sync({ env, log: () => {} })
  expect(result).toMatchObject({ changed: true, reason: "unlinked" })
  expect(readSettings().providers.map((p) => p.id)).toEqual(["deepseek"])
})

test("it writes the provider once, and leaves the file alone after that", () => {
  writeSettings(uebox())
  writeLink(link)
  expect(sync({ env, log: () => {} })).toMatchObject({ changed: true, reason: "linked" })
  const written = readSettings()
  expect(written.providers.map((p) => p.id)).toEqual(["deepseek", PROVIDER_ID])
  expect(written.providers.find((p) => p.id === PROVIDER_ID).models).toHaveLength(2)

  const stamp = readFileSync(settingsPath(), "utf8")
  expect(sync({ env, log: () => {} })).toMatchObject({ changed: false, reason: "same" })
  expect(readFileSync(settingsPath(), "utf8")).toBe(stamp)
})

test("the file it found first is kept once, beside it", () => {
  writeSettings(uebox())
  const first = readFileSync(settingsPath(), "utf8")
  writeLink(link)
  sync({ env, log: () => {} })
  sync({ env, log: () => {} })
  expect(readFileSync(join(env.UEBOX_USER_DATA, "models.json.magpie-backup"), "utf8")).toBe(first)
})

test("it does nothing to a computer without UEBox, or to a file it cannot read", () => {
  writeLink(link)
  expect(sync({ env, log: () => {} })).toMatchObject({ changed: false, reason: "no-uebox" })
  writeFileSync(settingsPath(), "{ not json", "utf8")
  expect(sync({ env, log: () => {} })).toMatchObject({ changed: false, reason: "unreadable" })
  expect(readFileSync(settingsPath(), "utf8")).toBe("{ not json")
})

test("with no UEBox provider and no link it leaves a file alone", () => {
  writeSettings(uebox())
  const stamp = readFileSync(settingsPath(), "utf8")
  expect(sync({ env, log: () => {} })).toMatchObject({ changed: false, reason: "idle" })
  expect(readFileSync(settingsPath(), "utf8")).toBe(stamp)
})

test("the paths are UEBox's and magpie's", () => {
  expect(link_path(env)).toBe(env.MAGPIE_UEBOX_LINK)
  expect(uebox_dir(env)).toBe(env.UEBOX_USER_DATA)
  // without an override each system's own folder, named unreal-box
  expect(uebox_dir({}).endsWith("unreal-box")).toBe(true)
  if (process.platform !== "win32") expect(uebox_dir({ XDG_CONFIG_HOME: "/x" })).toBe(join("/x", "unreal-box"))
  if (process.platform !== "win32") expect(link_path({ XDG_CONFIG_HOME: "/x" })).toBe(join("/x", "magpie", "uebox-link.json"))
})
