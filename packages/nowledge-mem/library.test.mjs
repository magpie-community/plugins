import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installLibrary, mcpName, skillName } from "./library.mjs"

const roots = []
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "nmem-library-"))
  roots.push(root)
  return root
}
const read = (root) => JSON.parse(readFileSync(join(root, "library.json"), "utf8"))
const seed = (root, data) => {
  writeFileSync(join(root, "library.json"), JSON.stringify(data, null, 2))
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const options = { serverUrl: "https://mem.example.com", apiKey: "nmem_library" }

test("the plugin installs its MCP server and skill for no agent, beside what is there", () => {
  const root = tempRoot()
  seed(root, {
    instructions: { agents: ["alma"] },
    mcp: [{ name: "Context7", transport: "http", url: "https://mcp.context7.com/mcp", agents: ["alma"] }],
    skills: [{ name: "user-skill", agents: ["codex"] }],
    applied: {},
  })
  const result = installLibrary({ directory: root, options })
  expect(result.mcp).toBe(mcpName)
  expect(result.skill).toBe(skillName)
  const data = read(root)
  const mcp = data.mcp.find((entry) => entry.name === mcpName)
  expect(mcp).toEqual({
    name: "Nowledge Mem",
    transport: "http",
    url: "https://mem.example.com/mcp",
    headers: { Authorization: "Bearer nmem_library" },
    agents: [],
  })
  const skill = data.skills.find((entry) => entry.name === skillName)
  expect(skill).toEqual({ name: "nowledge-mem", agents: [] })
  expect(data.mcp.find((entry) => entry.name === "Context7").agents).toEqual(["alma"])
  expect(data.skills.find((entry) => entry.name === "user-skill").agents).toEqual(["codex"])
  expect(data.instructions.agents).toEqual(["alma"])
  const file = join(root, "library", "skills", skillName, "SKILL.md")
  expect(existsSync(file)).toBe(true)
  expect(readFileSync(file, "utf8")).toContain("# Nowledge Mem")
})

test("reinstalling keeps the agents the user chose and updates the connection", () => {
  const root = tempRoot()
  installLibrary({ directory: root, options })
  const enabled = read(root)
  enabled.mcp.find((entry) => entry.name === mcpName).agents = ["codex"]
  enabled.skills.find((entry) => entry.name === skillName).agents = ["dsh"]
  seed(root, enabled)
  installLibrary({ directory: root, options: { ...options, serverUrl: "https://mem.example.com/v2" } })
  let data = read(root)
  expect(data.mcp.filter((entry) => entry.name === mcpName)).toHaveLength(1)
  expect(data.skills.filter((entry) => entry.name === skillName)).toHaveLength(1)
  expect(data.mcp.find((entry) => entry.name === mcpName).agents).toEqual(["codex"])
  expect(data.skills.find((entry) => entry.name === skillName).agents).toEqual(["dsh"])
  installLibrary({ directory: root, options: { ...options, apiKey: "nmem_second" } })
  data = read(root)
  expect(data.mcp.find((entry) => entry.name === mcpName).headers.Authorization).toBe("Bearer nmem_second")
})

test("installLibrary: false leaves the Library alone", () => {
  const root = tempRoot()
  const result = installLibrary({ directory: root, options: { ...options, installLibrary: false } })
  expect(result.skipped).toBe(true)
  expect(existsSync(join(root, "library.json"))).toBe(false)
})
