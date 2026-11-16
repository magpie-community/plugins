import { afterAll, beforeEach, expect, test } from "bun:test"
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { condenseTurns, codexBin } from "./codex.mjs"
import { allowConversation, allowProject, getState, isAllowed, stateFile } from "./consent.mjs"
import { condense, firstLine, titleOf, userText } from "./claude.mjs"
import { CcxTools } from "./index.mjs"

const here = fileURLToPath(new URL(".", import.meta.url))
const fixtures = join(here, "fixtures")

// A fake home: the tools read the real ~/.claude and ~/.codex, so the test
// points them at a copy it makes and cleans up. The folder the session is
// filed under is the one it was started in, which is how the app files it.
const home = mkdtempSync(join(tmpdir(), "tools-ccx-"))
const claudeHome = join(home, ".claude")
const project = "-Users-aaron-Desktop-aaron-robindex"
const projectCwd = "/Users/aaron/Desktop/aaron/robindex"
mkdirSync(join(claudeHome, "projects", project), { recursive: true })
cpSync(join(fixtures, "claude-session.jsonl"), join(claudeHome, "projects", project, "bd299fd9-1cab-4636-98ac-9062ddece6f9.jsonl"))

const realHome = process.env.HOME
const realConfig = process.env.CLAUDE_CONFIG_DIR
const realBin = process.env.CCX_CODEX_BIN
process.env.HOME = home
process.env.CLAUDE_CONFIG_DIR = claudeHome

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  if (realConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = realConfig
  if (realBin === undefined) delete process.env.CCX_CODEX_BIN
  else process.env.CCX_CODEX_BIN = realBin
  rmSync(home, { recursive: true, force: true })
})

const { tool } = await CcxTools({})
const call = (name, args) => tool[name].execute(args, { agent: "test", abort: AbortSignal.timeout(5000) })

const allowAll = () => {
  allowProject(projectCwd)
  allowConversation("bd299fd9-1cab-4636-98ac-9062ddece6f9")
}

beforeEach(() => {
  writeFileSync(stateFile(), JSON.stringify({ projects: [], conversations: [] }))
})

test("gives four tools, each with a JSON Schema and an execute", () => {
  expect(Object.keys(tool).sort()).toEqual(["allow", "read", "sessions", "state"])
  for (const [name, t] of Object.entries(tool)) {
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,48}$/)
    expect(t.description.length).toBeGreaterThan(40)
    expect(t.args.type).toBe("object")
    expect(typeof t.execute).toBe("function")
  }
})

test("says the transcripts go to the model", () => {
  expect(tool.sessions.description).toContain("sent to the model")
  expect(tool.read.description).toContain("sent to the model")
  expect(tool.sessions.description).not.toContain("nothing leaves your Mac")
})

test("lists nothing until the user allows it, and then lists it", async () => {
  await expect(call("sessions", { app: "claude" })).rejects.toThrow(/Not allowed yet/)
  allowAll()
  const listed = await call("sessions", { app: "claude" })
  expect(listed).toContain("Fix the login bug")
  expect(listed).toContain("id=bd299fd9-1cab-4636-98ac-9062ddece6f9")
})

test("allows one project or one conversation, and keeps it in its own state file", async () => {
  expect(await call("allow", { scope: "project", target: "/tmp/app" })).toContain("Allowed the project")
  expect(getState().projects).toContain("/tmp/app")
  expect(await call("allow", { scope: "conversation", target: "abc-123" })).toContain("Allowed the conversation")
  expect(getState().conversations).toContain("abc-123")
  expect(stateFile()).toContain("tools-ccx.json")
  await expect(call("allow", { scope: "project", target: "" })).rejects.toThrow("target is a folder")
  await expect(call("allow", { scope: "wrong", target: "/tmp/app" })).rejects.toThrow('scope is "project" or "conversation"')
})

test("state says what may be read", async () => {
  allowAll()
  const s = await call("state", {})
  expect(s.projects).toContain(projectCwd)
  expect(s.conversations).toContain("bd299fd9-1cab-4636-98ac-9062ddece6f9")
})

test("reads a Claude conversation as condensed text, once allowed", async () => {
  allowAll()
  const page = await call("read", { app: "claude", session_id: " bd299fd9 " })
  expect(page.title).toBe("Fix the login bug")
  // The session later moved to another folder; the one it was filed under is
  // the project it belongs to.
  expect(page.cwd).toBe(projectCwd)
  expect(page.text).toContain("[user]")
  expect(page.text).toContain("[tool]")
  expect(page.text).toContain("[tool result]")
  expect(page.offset).toBe(0)
  expect(page.total_chars).toBeGreaterThan(0)
  expect(page.next_offset).toBe(page.text.length)
})

test("refuses to read a conversation that is not allowed", async () => {
  await expect(call("read", { app: "claude", session_id: "bd299fd9" })).rejects.toThrow(/Not allowed yet/)
})

test("read says what is wrong instead of guessing", async () => {
  allowAll()
  await expect(call("read", { app: "claude", session_id: "nope-1234" })).rejects.toThrow("not found")
  await expect(call("read", { app: "claude" })).rejects.toThrow("session_id is a string")
  await expect(call("read", { app: "claude", session_id: "bd299fd9", offset: -1 })).rejects.toThrow("offset is a whole number")
  await expect(call("sessions", { app: "cursor" })).rejects.toThrow('app is "claude" or "codex"')
})

test("reads a Codex thread as condensed text, from a recorded answer", () => {
  const recorded = JSON.parse(readFileSync(join(fixtures, "codex-thread.json"), "utf8"))
  const text = condenseTurns(recorded.thread.turns)
  expect(text).toContain("[user] the login form 500s")
  expect(text).toContain("[tool] rg 'login' src")
  expect(text).toContain("[tool] apply_patch")
  expect(text).toContain("[tool result] patched src/login.ts")
  expect(text).toContain("[assistant] The 500 came from a missing await. Fixed.")
  // The model's mid-turn commentary is not the answer, so it is left out.
  expect(text).not.toContain("Looking at the route.")
})

test("finds the Codex CLI the app bundles, and can be pointed at one", () => {
  expect(codexBin({ CCX_CODEX_BIN: "/opt/codex" })).toBe("/opt/codex")
  expect(codexBin({})).toMatch(/codex/)
})

test("keeps what the person wrote and drops what the app injected", () => {
  expect(userText("<system-reminder>noise</system-reminder>the real words")).toBe("the real words")
  expect(userText("<pasted_content id=\"1\">\nkept\n</pasted_content>")).toContain("kept")
  expect(userText("# AGENTS.md\nrules")).toBe("")
  expect(firstLine("first\nsecond", 5)).toBe("first")
})

test("titles a session from what the person first wrote", () => {
  expect(titleOf([{ type: "user", message: { content: "fix the login bug\nmore" } }])).toBe("fix the login bug")
  expect(titleOf([{ type: "custom-title", customTitle: "Named" }, { type: "user", message: { content: "x" } }])).toBe("Named")
})

test("condenses a recorded Claude session", () => {
  const records = readFileSync(join(fixtures, "claude-session.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
  const text = condense(records)
  expect(text).toContain("[user]")
  expect(text).toContain("[tool]")
  expect(text).toContain("[tool result]")
})

test("isAllowed matches a project folder or a conversation id", () => {
  allowAll()
  expect(isAllowed({ cwd: projectCwd })).toBe(true)
  expect(isAllowed({ id: "bd299fd9-1cab-4636-98ac-9062ddece6f9" })).toBe(true)
  expect(isAllowed({ cwd: "/tmp/other" })).toBe(false)
})
