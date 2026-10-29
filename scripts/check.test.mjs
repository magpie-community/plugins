import { expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Exercise the checker in a tiny independent repository, without loading any
// real plugin, credential file or network client.
function check(source) {
  const dir = mkdtempSync(join(tmpdir(), "magpie-check-test-"))
  try {
    mkdirSync(join(dir, "scripts"))
    mkdirSync(join(dir, "packages", "fixture"), { recursive: true })
    copyFileSync(new URL("./check.mjs", import.meta.url), join(dir, "scripts", "check.mjs"))
    writeFileSync(join(dir, "packages", "fixture", "package.json"), JSON.stringify({ main: "index.mjs" }))
    writeFileSync(join(dir, "packages", "fixture", "index.mjs"), source)
    const result = Bun.spawnSync([process.execPath, join(dir, "scripts", "check.mjs")])
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("check accepts an empty account-specific catalog only with matching dynamic models hook", () => {
  for (const provider of [
    'provider: {id: "fixture", models: async () => ({})},',
    'provider: {id: "wrong", models: async () => ({})},',
    '',
  ]) {
    const result = check(`export const Plugin = async () => ({
      auth: {...${auth}, loader: async () => ({})}, ${provider}
      config: (cfg) => { cfg.provider.fixture = {npm: "@ai-sdk/openai-compatible", models: {}} }
    })`)
    expect(result.code).toBe(provider.includes('id: "fixture"') ? 0 : 1)
  }
})

test("动态模型不能省略 SDK、models 对象或 loader", () => {
  for (const [config, loader] of [
    ['{models: {}}', 'loader: async () => ({}),'],
    ['{npm: "@ai-sdk/openai-compatible"}', 'loader: async () => ({}),'],
    ['{npm: "@ai-sdk/openai-compatible", models: {}}', ''],
  ]) {
    const result = check(`export const Plugin = async () => ({
      auth: {...${auth}, ${loader}},
      provider: {id: "fixture", models: async () => ({})},
      config: (cfg) => { cfg.provider.fixture = ${config} }
    })`)
    expect(result.code).toBe(1)
  }
})

for (const [label, models, valid] of [
  ["number", "models: 42,", false],
  ["boolean", "models: true,", false],
  ["array", "models: [],", false],
  ["nonempty array", "models: [{}],", false],
  ["null", "models: null,", false],
  ["missing", "", false],
  ["empty mapping", "models: {},", true],
  ["nonempty mapping", "models: {example: {}},", true],
]) {
  test(`动态模型目录必须是非 null 非数组映射对象: ${label}`, () => {
    for (const tools of ["", `tool: ${tool},`]) {
      const result = check(`export const Plugin = async () => ({
        auth: {...${auth}, loader: async () => ({})}, ${tools}
        provider: {id: "fixture", models: async () => ({})},
        config: (cfg) => { cfg.provider.fixture = {npm: "@ai-sdk/openai-compatible", ${models}} }
      })`)
      expect(result.code).toBe(valid ? 0 : 1)
    }
  })
}

for (const models of ["42", "true", "[]"]) {
  test(`工具的仅登录例外也不能接受无效 models: ${models}`, () => {
    const result = check(`export const Plugin = async () => ({
      auth: ${auth}, tool: ${tool},
      provider: {id: "fixture", models: async () => ({})},
      config: (cfg) => { cfg.provider.fixture = {models: ${models}} }
    })`)
    expect(result.code).toBe(1)
  })
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
