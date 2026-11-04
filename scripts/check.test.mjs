import { expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentKindProblems, registryProblems } from "./registry.mjs"

// Exercise the checker in a tiny independent repository, without loading any
// real plugin, credential file or network client.
const okRegistry = JSON.stringify({ version: 1, plugins: [{ package: "fixture", name: "Fixture", community: true, summary: { en: "A fixture.", zh: "示例。" } }] })

function check(source, registry = okRegistry, pkg = { main: "index.mjs" }, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "magpie-check-test-"))
  try {
    mkdirSync(join(dir, "scripts"))
    mkdirSync(join(dir, "packages", "fixture"), { recursive: true })
    copyFileSync(new URL("./check.mjs", import.meta.url), join(dir, "scripts", "check.mjs"))
    copyFileSync(new URL("./registry.mjs", import.meta.url), join(dir, "scripts", "registry.mjs"))
    copyFileSync(new URL("./opencode2.mjs", import.meta.url), join(dir, "scripts", "opencode2.mjs"))
    if (registry !== null) writeFileSync(join(dir, "registry.json"), registry)
    writeFileSync(join(dir, "packages", "fixture", "package.json"), JSON.stringify({ name: "fixture", ...pkg }))
    for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, "packages", "fixture", f), body)
    writeFileSync(join(dir, "packages", "fixture", "index.mjs"), source)
    const result = Bun.spawnSync([process.execPath, join(dir, "scripts", "check.mjs")])
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const tool = `{search: {description: "Search the web", args: {type: "object"}, execute() {}}}`
const auth = `{provider: "fixture", methods: [{type: "api", label: "API key"}]}`

test("check accepts tools with sign-in and no chat models or loader", () => {
  const result = check(`export const Plugin = async () => ({
    auth: ${auth}, tool: ${tool},
    config: async (cfg) => { cfg.provider.fixture = {name: "Fixture", models: {}} }
  })`)
  expect(result.code).toBe(0)
  expect(result.output).toContain("✓ fixture")
})

test("check still checks tool definitions and auth methods together", () => {
  const result = check(`export const Plugin = async () => ({
    auth: {provider: "fixture", methods: [{type: "unknown"}]},
    tool: {search: {args: {type: "object"}}}
  })`)
  expect(result.code).toBe(1)
  expect(result.output).toContain("search has no execute")
  expect(result.output).toContain("search has no description")
  expect(result.output).toContain("method type unknown")
})

test("check still requires loaders for providers, including providers with tools", () => {
  for (const tools of ["", `tool: ${tool},`]) {
    const result = check(`export const Plugin = async () => ({
      auth: ${auth}, ${tools}
      config: async (cfg) => { cfg.provider.fixture = {npm: "@ai-sdk/openai", models: {example: {}}} }
    })`)
    expect(result.code).toBe(1)
    expect(result.output).toContain("auth.loader")
  }
})

test("check accepts account-scoped models without signing in or fetching them", () => {
  const result = check(`export const Plugin = async () => ({
    auth: {...${auth}, loader: async () => ({})},
    config: async (cfg) => { cfg.provider.fixture = {npm: "@ai-sdk/openai", models: {}} },
    provider: {id: "fixture", models() { throw new Error("must not ask for credentials") }}
  })`, okRegistry,
  { main: "./index.mjs", exports: { ".": "./opencode2.mjs" }, files: ["index.mjs", "opencode.mjs", "opencode2.mjs"] },
  { "opencode.mjs": 'export { Plugin } from "./index.mjs"\n', "opencode2.mjs": adapter })
  expect(result.code).toBe(0)
  expect(result.output).toContain("✓ fixture")
})

test("check rejects missing, mismatched or non-callable account catalogs and still requires npm and a loader", () => {
  for (const provider of ["undefined", '{id: "wrong", models() {}}', '{id: "fixture", models: {}}']) {
    const result = check(`export const Plugin = async () => ({
      auth: {...${auth}, loader: async () => ({})},
      config: async (cfg) => { cfg.provider.fixture = {npm: "@ai-sdk/openai", models: {}} },
      provider: ${provider}
    })`)
    expect(result.code).toBe(1)
    expect(result.output).toContain("no npm or models")
  }
  for (const [npm, loader, problem] of [
    ['"@ai-sdk/openai"', "undefined", "auth.loader"],
    ["undefined", "async () => ({})", "no npm or models"],
  ]) {
    const result = check(`export const Plugin = async () => ({
      auth: {...${auth}, loader: ${loader}},
      config: async (cfg) => { cfg.provider.fixture = {npm: ${npm}, models: {}} },
      provider: {id: "fixture", models() {}}
    })`)
    expect(result.code).toBe(1)
    expect(result.output).toContain(problem)
  }
})


const fine = `export const Plugin = async () => ({ tool: ${tool} })`

test("check accepts quota-only providers with a loader and no model transport", () => {
  const result = check(`export const Plugin = async () => ({
    auth: {...${auth}, usage: async () => ({windows: []}), loader: async () => ({})},
    config: async (cfg) => { cfg.provider.fixture = {name: "Fixture", models: {}} }
  })`)
  expect(result.code).toBe(0)
  expect(result.output).toContain("✓ fixture")
})

test("quota hooks do not exempt incomplete model providers or missing loaders", () => {
  for (const config of [
    `{models: {}, api: "https://example.invalid/v1"}`,
    `{models: {}, npm: "@ai-sdk/openai"}`,
    `{models: {example: {}}}`,
  ]) {
    const result = check(`export const Plugin = async () => ({
      auth: {...${auth}, usage: async () => ({windows: []}), loader: async () => ({})},
      config: async (cfg) => { cfg.provider.fixture = ${config} }
    })`)
    expect(result.code).toBe(1)
    expect(result.output).toContain("no npm or models")
  }
  const result = check(`export const Plugin = async () => ({
    auth: {...${auth}, usage: async () => ({windows: []})},
    config: async (cfg) => { cfg.provider.fixture = {models: {}} }
  })`)
  expect(result.code).toBe(1)
  expect(result.output).toContain("auth.loader")
})

test("check passes this repository's own registry.json", () => {
  expect(registryProblems(readFileSync(new URL("../registry.json", import.meta.url), "utf8"))).toEqual([])
})

// a package that adds an agent is listed as one, with a Bun module
// (main) beside it or not (#737): kimi-desktop and reasonix-desktop have one
test("an agent package's entry is kind agent, main or not (#737)", () => {
  const reg = (kind) => JSON.stringify({ version: 1, plugins: [{ package: "@magpie-community/agent-deva", name: "Deva", kind, summary: { en: "D", zh: "D" } }] })
  const pkg = { name: "@magpie-community/agent-deva", main: "./index.mjs", magpie: { agent: "./deva.agent.js" } }
  expect(agentKindProblems(reg("agent"), [pkg])).toEqual([])
  expect(agentKindProblems(reg(undefined), [pkg])[0]).toContain('declares magpie.agent, but its entry\'s kind is null')
  expect(agentKindProblems(reg("tools"), [pkg])).toHaveLength(1)
  expect(agentKindProblems(reg(undefined), [{ ...pkg, magpie: {} }])).toEqual([])
  const own = new URL("../packages/", import.meta.url)
  const pkgs = ["kimi-desktop", "reasonix-desktop", "aider"].map((n) => JSON.parse(readFileSync(new URL(n + "/package.json", own), "utf8")))
  expect(pkgs.filter((p) => p.main).length).toBe(2)
  expect(agentKindProblems(readFileSync(new URL("../registry.json", import.meta.url), "utf8"), pkgs)).toEqual([])
})

test("check fails a registry.json that is not JSON (#612)", () => {
  const result = check(fine, okRegistry.slice(0, -2))
  expect(result.code).toBe(1)
  expect(result.output).toContain("✗ registry.json")
  expect(result.output).toContain("not JSON")
  expect(result.output).toContain("✓ fixture")
})

test("check fails an entry with a kind magpie doesn't know (#612)", () => {
  const r = JSON.parse(okRegistry)
  r.plugins[0].kind = "bogus"
  const result = check(fine, JSON.stringify(r))
  expect(result.code).toBe(1)
  expect(result.output).toContain('kind "bogus"')
})

test("check fails a missing registry.json", () => {
  const result = check(fine, null)
  expect(result.code).toBe(1)
  expect(result.output).toContain("registry.json is missing")
})

test("check passes a good registry.json and plugin", () => {
  const result = check(fine)
  expect(result.code).toBe(0)
  expect(result.output).toContain("✓ registry.json")
})

// each of these loses the entry, or every entry, in magpie's reader
test("registry entries are held to what magpie's market reads", () => {
  const base = { package: "@magpie-community/opencode-acme-auth", name: "Acme", community: true, providers: ["acme"], summary: { en: "Acme.", zh: "Acme。" } }
  const of = (...plugins) => registryProblems(JSON.stringify({ version: 1, plugins }))
  expect(of(base, { ...base, package: "tools-x", kind: "tools", providers: undefined })).toEqual([])
  for (const kind of ["middleware", "hooks", "agent", "tools", "page"]) expect(of({ ...base, kind })).toEqual([])
  const cases = [
    [{ ...base, package: "Acme" }, "not an npm package name"],
    [{ ...base, package: "@scope" }, "not an npm package name"],
    [{ ...base, package: "a b" }, "not an npm package name"],
    [{ ...base, package: undefined }, "not an npm package name"],
    [{ ...base, name: "" }, "no name"],
    [{ ...base, kind: "provider" }, 'kind "provider"'],
    [{ ...base, community: "true" }, "community is not true or false"],
    [{ ...base, providers: "acme" }, "providers is not a list"],
    [{ ...base, providers: [] }, "providers is not a list"],
    [{ ...base, icon: "http://acme.example/i.svg" }, "is not https or data:image"],
    [{ ...base, summary: { en: "Acme." } }, "no summary.zh"],
    [{ ...base, summary: undefined }, "no summary"],
    [{ ...base, kinds: "tools" }, 'unknown field "kinds"'],
    [{ ...base, replaces: 3 }, "replaces is not"],
  ]
  for (const [entry, want] of cases) {
    const got = of(JSON.parse(JSON.stringify(entry)))
    expect(got.join("\n")).toContain(want)
  }
  expect(of(base, { ...base, name: "Again" }).join("\n")).toContain("package listed again (first at plugins[0])")
  expect(registryProblems(JSON.stringify({ version: 1, plugins: [] }))).toEqual(["plugins is not a list of entries"])
  expect(registryProblems(JSON.stringify({ version: 2, plugins: [base] }))).toEqual(["version 2, not 1"])
  expect(registryProblems("[]")).toEqual(["registry.json is not an object"])
})

// a model provider as the packages were before plugins#657: named 1.x
// exports and nothing OpenCode 2.x can load
const provider = `export const Plugin = async () => ({
  auth: {...${auth}, loader: async () => ({})},
  config: async (cfg) => { cfg.provider.fixture = {npm: "@ai-sdk/openai-compatible", models: {m: {}}} }
})`
const adapter = readFileSync(new URL("./opencode2.mjs", import.meta.url), "utf8")

test("check fails a model provider OpenCode 2.x can't load (plugins#657)", () => {
  for (const pkg of [{ main: "index.mjs" }, { main: "index.mjs", exports: "./index.mjs" }]) {
    const result = check(provider, okRegistry, pkg)
    expect(result.code).toBe(1)
    expect(result.output).toContain("has no default {id, setup} (plugins#657)")
  }
})

test("check passes a model provider with the 2.x adapter and a 1.x main", () => {
  const files = { "opencode.mjs": 'export { Plugin } from "./index.mjs"\n', "opencode2.mjs": adapter }
  const pkg = { main: "./opencode.mjs", exports: { ".": "./opencode2.mjs" }, files: ["index.mjs", "opencode.mjs", "opencode2.mjs"] }
  const ok = check(provider, okRegistry, pkg, files)
  expect(ok.output).toContain("✓ fixture")
  expect(ok.code).toBe(0)
  // a copy that drifted from scripts/opencode2.mjs, and a file npm won't ship
  const drift = check(provider, okRegistry, { ...pkg, files: ["index.mjs", "opencode.mjs"] }, { ...files, "opencode2.mjs": adapter + "\n// edited\n" })
  expect(drift.code).toBe(1)
  expect(drift.output).toContain("differs from scripts/opencode2.mjs")
  expect(drift.output).toContain("opencode2.mjs is not in files")
})

test("check fails a main OpenCode 1.x refuses: an export that isn't a plugin", () => {
  const result = check(provider + "\nexport const _internal = {}\n", okRegistry, {}, {})
  expect(result.code).toBe(1)
  expect(result.output).toContain("main exports _internal")
})
