import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { PROVIDER_ID, buildProvider, link_path, merge, sync, uebox_dir } from "./lib/sync.mjs"
import { library_staging_dir, syncLibrary } from "./lib/library.mjs"
import { agent, connect } from "./uebox.agent.js"

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

test("a file whose providers isn't a list is left alone", () => {
  writeLink(link)
  for (const body of [{ version: 3, roles: { chat: { providerId: "deepseek" } } }, { version: 3, providers: { deepseek: {} } }]) {
    writeSettings(body)
    const stamp = readFileSync(settingsPath(), "utf8")
    expect(sync({ env, log: () => {} })).toMatchObject({ changed: false, reason: "unreadable" })
    expect(readFileSync(settingsPath(), "utf8")).toBe(stamp)
  }
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

test("uebox.agent.js points Library at cross-platform magpie staging folder", () => {
  expect(agent.id).toBe("uebox")
  expect(agent.library).toEqual({
    instructions: "~/.config/magpie/uebox-library/instructions.md",
    mcp: "~/.config/magpie/uebox-library/mcp.json",
    mcpFormat: "claude",
    skills: "~/.config/magpie/uebox-library/skills",
  })
  // must not rely on Windows-only $APPDATA in agent.library
  for (const val of Object.values(agent.library)) {
    expect(val).not.toContain("$APPDATA")
  }
  const out = connect({
    gateway: { key: "k", url: "http://127.0.0.1:8425", v1: "http://127.0.0.1:8425/v1" },
    models: [{ id: "m1", name: "M1", context: 1000, output: 100, images: false, efforts: [] }],
  })
  expect(out.magpie_key).toBe("k")
  expect(out.magpie_models).toHaveLength(1)
})

test("uebox_dir resolves per-OS data folders", () => {
  expect(uebox_dir({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32")).toBe(join("C:\\Users\\a\\AppData\\Roaming", "unreal-box"))
  expect(uebox_dir({}, "darwin").endsWith(join("Library", "Application Support", "unreal-box"))).toBe(true)
  expect(uebox_dir({ XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe(join("/xdg", "unreal-box"))
  expect(uebox_dir({ UEBOX_USER_DATA: "/custom/uebox" }, "darwin")).toBe("/custom/uebox")
})

test("syncLibrary merges instructions while keeping user text and restores on clear", () => {
  const staging = join(dir, "uebox-library")
  mkdirSync(staging, { recursive: true })
  const libEnv = { ...env, MAGPIE_UEBOX_LIBRARY: staging }
  const dstInstructions = join(env.UEBOX_USER_DATA, "instructions.md")

  writeFileSync(dstInstructions, "I am a TA.\n", "utf8")
  writeFileSync(
    join(staging, "instructions.md"),
    "<!-- magpie:begin · written by magpie from its Library -->\nUse tabs.\n<!-- magpie:end -->\n",
    "utf8",
  )

  const first = syncLibrary({ env: libEnv, log: () => {} })
  expect(first.changed).toBe(true)
  expect(first.instructions.changed).toBe(true)
  const merged = readFileSync(dstInstructions, "utf8")
  expect(merged).toContain("I am a TA.")
  expect(merged).toContain("Use tabs.")
  expect(merged).toContain("<!-- magpie:begin")

  // idempotent when unchanged
  expect(syncLibrary({ env: libEnv, log: () => {} }).changed).toBe(false)

  // clearing staged instructions restores the user's original text
  rmSync(join(staging, "instructions.md"))
  const cleared = syncLibrary({ env: libEnv, log: () => {} })
  expect(cleared.changed).toBe(true)
  expect(readFileSync(dstInstructions, "utf8")).toBe("I am a TA.\n")
})

test("syncLibrary merges MCP servers, preserves user entries, logs invalid IDs, and removes only managed ones", () => {
  const staging = join(dir, "uebox-library")
  mkdirSync(staging, { recursive: true })
  const libEnv = { ...env, MAGPIE_UEBOX_LIBRARY: staging }
  const dstMcp = join(env.UEBOX_USER_DATA, "mcp.json")

  writeFileSync(
    dstMcp,
    JSON.stringify({
      version: 1,
      mcpServers: {
        mine: { type: "stdio", command: "mine-mcp", trusted: true, allowedTools: ["read_file"] },
      },
    }, null, 2) + "\n",
    "utf8",
  )
  writeFileSync(
    join(staging, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        fs: { type: "stdio", command: "npx", args: ["-y", "@mcp/fs"], env: {} },
        remote: { type: "http", url: "http://127.0.0.1:8425/mcp/test" },
        mine: { type: "stdio", command: "should-not-overwrite-user" },
        "bad.name": { type: "stdio", command: "bad-dot" },
        "name with space": { type: "stdio", command: "bad-space" },
        ["a".repeat(33)]: { type: "stdio", command: "too-long" },
      },
    }, null, 2) + "\n",
    "utf8",
  )

  const logs = []
  const res = syncLibrary({ env: libEnv, log: (m) => logs.push(m) })
  expect(res.changed).toBe(true)
  expect(res.mcp.skipped).toEqual(["bad.name", "name with space", "a".repeat(33)])
  expect(logs.some((l) => l.includes("bad.name"))).toBe(true)

  const written = JSON.parse(readFileSync(dstMcp, "utf8"))
  expect(written.version).toBe(1)
  expect(written.mcpServers.mine).toEqual({ type: "stdio", command: "mine-mcp", trusted: true, allowedTools: ["read_file"] })
  expect(written.mcpServers.fs).toMatchObject({ type: "stdio", command: "npx" })
  expect(written.mcpServers.remote).toMatchObject({ type: "http", url: "http://127.0.0.1:8425/mcp/test" })
  expect(written.mcpServers["bad.name"]).toBeUndefined()

  // removing fs & remote from staging removes only those two and keeps mine untouched
  writeFileSync(join(staging, "mcp.json"), JSON.stringify({ mcpServers: {} }, null, 2) + "\n", "utf8")
  const afterRemove = syncLibrary({ env: libEnv, log: () => {} })
  expect(afterRemove.changed).toBe(true)
  const finalMcp = JSON.parse(readFileSync(dstMcp, "utf8"))
  expect(Object.keys(finalMcp.mcpServers)).toEqual(["mine"])
  expect(finalMcp.mcpServers.mine).toEqual({ type: "stdio", command: "mine-mcp", trusted: true, allowedTools: ["read_file"] })
})

test("syncLibrary copies linked skills as real directories so UEBox Dirent.isDirectory() sees them", () => {
  const staging = join(dir, "uebox-library")
  const stagingSkills = join(staging, "skills")
  const libSourceSkill = join(dir, "library-store", "pdf")
  const userSkill = join(env.UEBOX_USER_DATA, "skills", "ue-custom")
  mkdirSync(stagingSkills, { recursive: true })
  mkdirSync(libSourceSkill, { recursive: true })
  mkdirSync(userSkill, { recursive: true })

  writeFileSync(join(libSourceSkill, "SKILL.md"), "---\nname: pdf\ndescription: Read PDFs\n---\nBody v1\n", "utf8")
  writeFileSync(join(userSkill, "SKILL.md"), "---\nname: ue-custom\ndescription: Mine\n---\nUser skill\n", "utf8")

  // simulate magpie's default link mode (junction on Windows, dir symlink on POSIX)
  symlinkSync(libSourceSkill, join(stagingSkills, "pdf"), process.platform === "win32" ? "junction" : "dir")

  const libEnv = { ...env, MAGPIE_UEBOX_LIBRARY: staging }
  const first = syncLibrary({ env: libEnv, log: () => {} })
  expect(first.changed).toBe(true)
  expect(first.skills.managed).toEqual(["pdf"])

  const targetSkillsDir = join(env.UEBOX_USER_DATA, "skills")
  const copiedSkill = join(targetSkillsDir, "pdf")
  // must be a real directory, not a symlink/junction
  const lst = lstatSync(copiedSkill)
  expect(lst.isDirectory()).toBe(true)
  expect(lst.isSymbolicLink()).toBe(false)
  // verify UEBox's exact SkillsService check: readdir(..., { withFileTypes: true }) + entry.isDirectory()
  const entries = readdirSync(targetSkillsDir, { withFileTypes: true })
  const pdfEntry = entries.find((e) => e.name === "pdf")
  expect(pdfEntry?.isDirectory()).toBe(true)
  expect(readFileSync(join(copiedSkill, "SKILL.md"), "utf8")).toContain("Body v1")

  // idempotent when unchanged
  expect(syncLibrary({ env: libEnv, log: () => {} }).changed).toBe(false)

  // updates when source skill changes
  writeFileSync(join(libSourceSkill, "SKILL.md"), "---\nname: pdf\ndescription: Read PDFs\n---\nBody v2\n", "utf8")
  expect(syncLibrary({ env: libEnv, log: () => {} }).changed).toBe(true)
  expect(readFileSync(join(copiedSkill, "SKILL.md"), "utf8")).toContain("Body v2")

  // unticking removes only managed skill and preserves user's own skill
  rmSync(join(stagingSkills, "pdf"), { recursive: true, force: true })
  expect(syncLibrary({ env: libEnv, log: () => {} }).changed).toBe(true)
  expect(existsSync(copiedSkill)).toBe(false)
  expect(existsSync(join(userSkill, "SKILL.md"))).toBe(true)
})

test("syncLibrary does nothing when UEBox data folder does not exist", () => {
  const missingEnv = {
    UEBOX_USER_DATA: join(dir, "does-not-exist"),
    MAGPIE_UEBOX_LIBRARY: join(dir, "uebox-library"),
  }
  expect(library_staging_dir(missingEnv)).toBe(missingEnv.MAGPIE_UEBOX_LIBRARY)
  expect(syncLibrary({ env: missingEnv, log: () => {} })).toEqual({ changed: false, reason: "no-uebox" })
  expect(existsSync(missingEnv.UEBOX_USER_DATA)).toBe(false)
})
