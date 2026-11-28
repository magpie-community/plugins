// Every agy session runs on agy's default agent (default-agent.mjs): a custom
// agent's session costs about four times the quota from agy 1.5.17
// (google-antigravity/antigravity-cli#1890). Its instructions are AGENTS.md,
// and tool-gate.mjs, run by agy as a PreToolUse hook, denies every tool but
// the ones named.
//
// bun test ./default-agent.mjs

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { TOOL_GATE_PATH, toolGateCommand, writeDefaultAgentFiles } from "../default-agent.mjs"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

// as agy runs it: the call on stdin, the decision on stdout
function gate(allowed, input) {
  const result = spawnSync(process.execPath, [TOOL_GATE_PATH, ...allowed], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
const call = (name) => ({ hookEventName: "PreToolUse", toolCall: { name, args: {} } })

test("the gate lets the named tools through and a prefix's, and denies every other", () => {
  const allowed = ["mcp_ide-tools_*", "read_file"]
  assert.deepEqual(gate(allowed, call("mcp_ide-tools_Bash")), { decision: "allow" })
  assert.deepEqual(gate(allowed, call("read_file")), { decision: "allow" })
  for (const name of ["run_command", "write_file", "search_web", "invoke_subagent", "read_file_2", "mcp_other_tool"]) {
    const said = gate(allowed, call(name))
    assert.equal(said.decision, "deny", name)
    assert.match(said.reason, new RegExp(`^${name} is turned off in this session`))
  }
})

test("the gate denies a call it can't read, and every call when it names no tool", () => {
  assert.equal(gate(["mcp_ide-tools_*"], "not json").decision, "deny")
  assert.equal(gate(["mcp_ide-tools_*"], { toolCall: {} }).decision, "deny")
  assert.equal(gate([], call("mcp_ide-tools_Bash")).decision, "deny")
})

test("the hook command runs the gate through sh as it is written", { skip: process.platform === "win32" }, () => {
  const command = toolGateCommand(["mcp_ide-tools_*", "it's"], { execPath: process.execPath })
  assert.equal(command, [process.execPath, TOOL_GATE_PATH, "mcp_ide-tools_*", "it's"].map((v) => `'${v.replace(/'/g, `'\\''`)}'`).join(" "))
  const result = spawnSync("sh", ["-c", command], { input: JSON.stringify(call("mcp_ide-tools_Read")), encoding: "utf8" })
  assert.deepEqual(JSON.parse(result.stdout), { decision: "allow" })
})

test("Windows hooks run one quoted batch path and the script quotes its own arguments", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy default agent "))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const options = { execPath: "C:\\Program Files\\n%^&!\\node.exe", gate: "C:\\p\\tool-gate.mjs", platform: "win32" }
  const files = { instructions: "Use the tool gate.", allowed: ["a%PATH%^&!()|<>", "mcp_ide-tools_*", "trailing\\"] }
  await writeDefaultAgentFiles(dir, files, options)
  const wrapper = path.join(dir, ".agents", "tool-gate.cmd")
  const hooks = JSON.parse(fs.readFileSync(path.join(dir, ".agents", "hooks.json"), "utf8"))
  assert.equal(hooks["magpie-tool-gate"].PreToolUse[0].hooks[0].command, `"${wrapper}"`)
  assert.equal(fs.readFileSync(wrapper, "utf8"), [
    "@echo off", "setlocal DisableDelayedExpansion",
    '"C:\\Program Files\\n%%^&!\\node.exe" "C:\\p\\tool-gate.mjs" "a%%PATH%%^&!()|<>" "mcp_ide-tools_*" "trailing\\\\"', "",
  ].join("\r\n"))
  for (const invalid of ['"', "\r", "\n", "\0", "中文"]) {
    await assert.rejects(writeDefaultAgentFiles(dir, { ...files, allowed: [invalid] }, options), /invalid Windows hook argument/)
  }
  for (const invalid of ['"', "%", "^", "&", "!", "\n"]) {
    assert.throws(() => toolGateCommand([], { ...options, wrapper: `C:\\unsafe${invalid} path\\tool-gate.cmd` }), /invalid Windows hook wrapper path/)
  }
  await writeDefaultAgentFiles(dir, { ...files, allowed: null }, options)
  assert.equal(fs.existsSync(wrapper), false)
})

test("workspace files replace changed content by rename and preserve unchanged files", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-default-agent-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const options = { platform: "win32", execPath: "C:\\node.exe", gate: "C:\\tool-gate.mjs" }
  const config = { instructions: "New instructions", allowed: ["search_web"] }
  const agents = path.join(dir, ".agents")
  const files = [path.join(dir, "AGENTS.md"), ...["hooks.json", "skills.json", "tool-gate.cmd"].map(name => path.join(agents, name))]
  fs.mkdirSync(agents)
  for (const file of files) fs.writeFileSync(file, "old bytes")
  const oldFiles = files.map(file => fs.openSync(file, "r"))
  try {
    await writeDefaultAgentFiles(dir, config, options)
    for (const [i, file] of files.entries()) {
      assert.equal(fs.readFileSync(oldFiles[i], "utf8"), "old bytes")
      assert.notEqual(fs.readFileSync(file, "utf8"), "old bytes")
      fs.utimesSync(file, 1000, 1000)
    }
  } finally {
    for (const fd of oldFiles) fs.closeSync(fd)
  }
  await writeDefaultAgentFiles(dir, config, options)
  for (const file of files) assert.equal(fs.statSync(file).mtimeMs, 1_000_000)
  assert.deepEqual(fs.readdirSync(dir).sort(), [".agents", "AGENTS.md"])
  assert.deepEqual(fs.readdirSync(agents).sort(), ["hooks.json", "skills.json", "tool-gate.cmd"])
})

test("builtin skill directories extend the fallback list without duplicates", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-default-agent-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const config = { instructions: "Use the tool gate.", allowed: null, geminiDir: path.join(dir, "gemini") }
  const exclusions = () => JSON.parse(fs.readFileSync(path.join(dir, ".agents", "skills.json"), "utf8")).exclude
  await writeDefaultAgentFiles(dir, config)
  const fallback = exclusions()
  const skills = path.join(config.geminiDir, "antigravity-cli", "builtin", "skills")
  fs.mkdirSync(path.join(skills, "run-workflow"), { recursive: true })
  fs.mkdirSync(path.join(skills, "new-in-1-5-19"))
  fs.writeFileSync(path.join(skills, "not-a-directory"), "skip")
  await writeDefaultAgentFiles(dir, config)
  assert.deepEqual(exclusions(), [...fallback, "new-in-1-5-19"])
})

test("ACP hook rejections are counted separately from permission rejections", async t => {
  const kit = await createBridgeKit()
  t.after(() => kit.dispose())
  kit.defaultPrompt = async agent => {
    const deny = { sessionUpdate: "tool_call_update", status: "failed", toolCallId: "hook", rawOutput: "tool call denied by pre-tool hook: turned off" }
    agent.update({ sessionUpdate: "tool_call", toolCallId: "hook", name: "run_command", status: "in_progress" })
    agent.update(deny)
    agent.update(deny)
    agent.update({ sessionUpdate: "tool_call", toolCallId: "other", name: "read_file", status: "in_progress" })
    agent.update({ ...deny, toolCallId: "other", rawOutput: "tool call failed" })
    await agent.requestPermission({ name: "write_file" })
    await agent.text("ok")
    return { stopReason: "end_turn" }
  }
  const reply = await readSse(await kit.request(baseBody()))
  assert.equal(reply.stopReason, "end_turn")
  assert.equal(kit.turns[0].proc.deniedHooks, 1)
  assert.equal(kit.turns[0].proc.deniedPermissions, 1)
})

test("allowing agy's tools keeps auto approval without a workspace hook", async t => {
  const kit = await createBridgeKit({ env: { AGY_BRIDGE_ALLOW_AGY_TOOLS: "1" } })
  t.after(() => kit.dispose())
  kit.defaultPrompt = async agent => {
    assert.equal(fs.existsSync(path.join(agent.cwd, ".agents", "hooks.json")), false)
    await agent.text("ok")
    return { stopReason: "end_turn" }
  }
  assert.equal((await readSse(await kit.request(baseBody()))).stopReason, "end_turn")
  const { args } = kit.acpSpawns.find(spawn => spawn.args.includes("--ide-mcp-port"))
  assert.ok(args.includes("--dangerously-skip-permissions"))
  assert.ok(!args.includes("--agent"))
})

test("a folder gets AGENTS.md and the hook, and loses an older plugin's agent definition", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-default-agent-"))
  try {
    fs.mkdirSync(path.join(dir, ".agents", "agents", "magpie-bridge"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".agents", "agents", "magpie-bridge", "agent.md"), "---\nname: magpie-bridge\n---\n")
    await writeDefaultAgentFiles(dir, { instructions: "Use only the provided tools.", allowed: ["mcp_ide-tools_*"] })
    assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), "Use only the provided tools.\n")
    assert.equal(fs.existsSync(path.join(dir, ".agents", "agents")), false)
    const skillsFile = path.join(dir, ".agents", "skills.json")
    const { exclude } = JSON.parse(fs.readFileSync(skillsFile, "utf8"))
    for (const name of ["agy-customizations", "antigravity-guide", "antigravity_guide", "run-workflow", "swarm", "native_swarm"]) {
      assert.ok(exclude.includes(name), name)
    }
    assert.ok(exclude.every((name) => /^[a-z0-9_-]+$/.test(name)), "exclude individual names so other skills still load")
    const hooks = JSON.parse(fs.readFileSync(path.join(dir, ".agents", "hooks.json"), "utf8"))
    const pre = hooks["magpie-tool-gate"].PreToolUse[0]
    assert.equal(pre.matcher, "*")
    assert.equal(pre.hooks[0].type, "command")
    const wrapper = path.join(dir, ".agents", "tool-gate.cmd")
    assert.equal(pre.hooks[0].command, toolGateCommand(["mcp_ide-tools_*"], { wrapper }))
    // agy's own tools allowed (AGY_BRIDGE_ALLOW_AGY_TOOLS=1): no hook left behind
    await writeDefaultAgentFiles(dir, { instructions: "Use only the provided tools.", allowed: null })
    assert.equal(fs.existsSync(path.join(dir, ".agents", "hooks.json")), false)
    assert.equal(fs.existsSync(path.join(dir, "AGENTS.md")), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
