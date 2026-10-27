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
